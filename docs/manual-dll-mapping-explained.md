# Manual DLL Mapping: How and Why We Skip LoadLibrary

When you need to load code into another process, the Windows API hands you `LoadLibrary`. It works. It is also the first thing every anti-cheat system on the planet monitors. This article walks through the manual mapping technique we use in [dezlock-dump](https://github.com/dougwithseismic/dezlock-dump) to inject a read-only worker DLL into a running game process, explaining each phase of the PE loader we had to reimplement and the trade-offs involved.

## Why LoadLibrary Is Not Enough

`LoadLibrary` (and its cousin `LoadLibraryEx`) are the standard mechanism for loading DLLs at runtime. Under the hood, the Windows loader does a lot of work: it maps the PE file, processes relocations, resolves imports, invokes TLS callbacks, registers exception handlers, and finally calls `DllMain`. Convenient. The problem is that this entire sequence is observable.

When you call `LoadLibrary` in a remote process (typically via `CreateRemoteThread` targeting `LoadLibraryA`), several things happen that make your DLL trivially detectable:

- **DLL load notifications fire.** The kernel calls registered `LdrDllNotification` callbacks. Anti-cheat drivers hook these.
- **The module appears in the PEB module list.** Tools like `NtQueryVirtualMemory` or a simple `EnumProcessModules` call will enumerate it.
- **File-backed mapping.** The DLL exists on disk and the mapping is visible in the process's section objects.
- **ETW events.** Windows emits Event Tracing events for every image load. Kernel-level telemetry picks these up before user-mode code even runs.

For a read-only diagnostic tool like ours, getting flagged by anti-cheat is not a correctness problem but a practical one. The game may terminate the process, or the anti-cheat may quarantine the DLL. Manual mapping sidesteps all of these detection surfaces by never involving the Windows loader at all.

## What Manual Mapping Actually Means

Manual mapping is exactly what it sounds like: you become the PE loader. Instead of asking Windows to load your DLL, you parse the PE file yourself, allocate memory in the target process, copy the sections over, fix up relocations and imports, register exception handlers, and call the entry point. The OS never knows a DLL was loaded. There is no module list entry, no load notification, and no file-backed section.

The trade-off is complexity. You are reimplementing a subset of `ntdll!LdrLoadDll`, and any bug means a crash inside another process with minimal debugging context.

## Step-by-Step: The Implementation

The full implementation lives in `main.cpp`. Here is how each phase works.

### Phase 0: Parsing the PE

Before anything crosses a process boundary, we parse the DLL locally. The PE format starts with the DOS header, whose `e_lfanew` field points to the NT headers, which contain everything we need:

```cpp
struct PeInfo {
    std::vector<uint8_t>   raw;
    IMAGE_DOS_HEADER*      dos;
    IMAGE_NT_HEADERS64*    nt;
    IMAGE_SECTION_HEADER*  sections;
    WORD                   num_sections;
    uint64_t               preferred_base;
    uint32_t               size_of_image;
    uint32_t               entry_point_rva;
    IMAGE_DATA_DIRECTORY   reloc_dir;
    IMAGE_DATA_DIRECTORY   import_dir;
    IMAGE_DATA_DIRECTORY   exc_dir;
    IMAGE_DATA_DIRECTORY   tls_dir;
};
```

We read the entire DLL into a local buffer, validate the DOS and NT signatures, confirm it is a 64-bit DLL, and then extract the data directory entries we will need: relocations, imports, exceptions, and TLS. The key fields from `OptionalHeader` are `ImageBase` (the preferred load address), `SizeOfImage` (how much virtual memory to allocate), and `AddressOfEntryPoint` (the RVA of `DllMain`).

### Phase 1: Allocating Memory in the Target

We allocate a region in the target process large enough for the entire image:

```cpp
void* image_base = VirtualAllocEx(hProc, nullptr, pe.size_of_image,
                                   MEM_COMMIT | MEM_RESERVE,
                                   PAGE_EXECUTE_READWRITE);
```

We request `PAGE_EXECUTE_READWRITE` because the mapped image contains both code and data sections, and we need write access during setup. A production-hardened implementation would re-protect sections after mapping (`.text` as `PAGE_EXECUTE_READ`, `.rdata` as `PAGE_READONLY`, and so on), but for a short-lived diagnostic tool the simplicity trade-off is reasonable.

Note that we pass `nullptr` for the base address, letting the OS choose where to place us. This almost guarantees the allocation will not land at the DLL's preferred `ImageBase`, which is why relocations are critical.

### Phase 2: Copying Sections

We first write the PE headers, then iterate each section and write it at its virtual address offset:

```cpp
// Write PE headers
WriteProcessMemory(hProc, image_base, pe.raw.data(),
                   pe.nt->OptionalHeader.SizeOfHeaders, &written);

// Write each section
for (WORD i = 0; i < pe.num_sections; ++i) {
    auto& sec = pe.sections[i];
    if (sec.SizeOfRawData == 0) continue;

    void* dest = static_cast<BYTE*>(image_base) + sec.VirtualAddress;
    WriteProcessMemory(hProc, dest,
                       pe.raw.data() + sec.PointerToRawData,
                       sec.SizeOfRawData, &written);
}
```

Each section header gives us `PointerToRawData` (where the data lives in the file) and `VirtualAddress` (where it should land in memory). The gap between a section's raw size and virtual size is zero-filled by the `MEM_COMMIT` allocation.

### Phase 3: Processing Relocations

Because the image almost certainly loaded at a different base address than it was compiled for, every absolute address embedded in the code is wrong. The relocation table tells us where those addresses are so we can fix them.

The relocation directory is a sequence of `IMAGE_BASE_RELOCATION` blocks. Each block covers a 4KB page and contains an array of 16-bit entries. The top 4 bits encode the relocation type; the bottom 12 bits are the page offset. For x64, we only care about `IMAGE_REL_BASED_DIR64` (type 10), which means "patch the full 64-bit value at this address."

```cpp
BYTE* delta = pBase - pOpt->ImageBase;

while (reinterpret_cast<BYTE*>(pReloc) < pRelocEnd && pReloc->SizeOfBlock) {
    UINT count = (pReloc->SizeOfBlock - sizeof(IMAGE_BASE_RELOCATION)) / sizeof(WORD);
    WORD* entries = reinterpret_cast<WORD*>(pReloc + 1);

    for (UINT i = 0; i < count; ++i) {
        if (RELOC_FLAG64(entries[i])) {
            UINT_PTR* pPatch = reinterpret_cast<UINT_PTR*>(
                pBase + pReloc->VirtualAddress + (entries[i] & 0xFFF));
            *pPatch += reinterpret_cast<UINT_PTR>(delta);
        }
    }

    pReloc = reinterpret_cast<IMAGE_BASE_RELOCATION*>(
        reinterpret_cast<BYTE*>(pReloc) + pReloc->SizeOfBlock);
}
```

The delta is simply `actual_base - preferred_base`. Every patched address gets this delta added. If the DLL happened to load at its preferred base (delta is zero), this entire phase is skipped.

### Phase 4: Resolving Imports

The Import Directory Table is an array of `IMAGE_IMPORT_DESCRIPTOR` structures, one per imported DLL. Each descriptor names the DLL and provides two parallel arrays: the Import Lookup Table (original thunks, containing hints and names) and the Import Address Table (where resolved function pointers go).

```cpp
while (pImport->Name) {
    HMODULE hMod = _LoadLibraryA(reinterpret_cast<char*>(pBase + pImport->Name));

    ULONG_PTR* pThunk = reinterpret_cast<ULONG_PTR*>(pBase + pImport->OriginalFirstThunk);
    ULONG_PTR* pFunc  = reinterpret_cast<ULONG_PTR*>(pBase + pImport->FirstThunk);
    if (!pThunk) pThunk = pFunc;

    for (; *pThunk; ++pThunk, ++pFunc) {
        if (IMAGE_SNAP_BY_ORDINAL(*pThunk)) {
            *pFunc = reinterpret_cast<ULONG_PTR>(
                _GetProcAddress(hMod, reinterpret_cast<char*>(*pThunk & 0xFFFF)));
        } else {
            auto* pName = reinterpret_cast<IMAGE_IMPORT_BY_NAME*>(pBase + *pThunk);
            *pFunc = reinterpret_cast<ULONG_PTR>(_GetProcAddress(hMod, pName->Name));
        }
    }
    ++pImport;
}
```

A subtle point: we call `LoadLibraryA` and `GetProcAddress` from inside the target process, not from our injector. These function pointers are passed in through the `MAPPING_CTX` structure. Since `kernel32.dll` is loaded at the same base address in every process (ASLR randomizes per-boot, not per-process), the function pointers from our process are valid in the target.

Imports can be resolved by name (the common case) or by ordinal (the high bit of the thunk entry is set). We handle both.

### Phase 5: SEH Registration

This is the step most manual mapping tutorials skip, and it is the one that causes the most mysterious crashes. On x64 Windows, structured exception handling is table-driven. The `.pdata` section contains an array of `RUNTIME_FUNCTION` entries that map instruction ranges to unwind handlers. Without registering this table, any exception (including `__try/__except` blocks) will cause an unhandled exception termination.

```cpp
if (pData->seh_enabled) {
    auto& excDir = pOpt->DataDirectory[IMAGE_DIRECTORY_ENTRY_EXCEPTION];
    if (excDir.Size) {
        pData->fn_RtlAddFunctionTable(
            reinterpret_cast<IMAGE_RUNTIME_FUNCTION_ENTRY*>(pBase + excDir.VirtualAddress),
            excDir.Size / sizeof(IMAGE_RUNTIME_FUNCTION_ENTRY),
            reinterpret_cast<DWORD64>(pBase));
    }
}
```

`RtlAddFunctionTable` tells the OS about our exception directory. Without it, the first time any code in the mapped DLL triggers a structured exception, the unwinder will not find a handler and the process will terminate. For our worker DLL, this is critical: we use `__try/__except` blocks extensively when reading arbitrary game memory, because any pointer could be invalid.

### Phase 6: Calling DllMain

With everything in place, we invoke the entry point:

```cpp
_DllMain(pBase, pData->reason, pData->reserved);
```

The `reason` is `DLL_PROCESS_ATTACH`. At this point, the worker DLL's initialization code runs and kicks off its own worker thread.

### The Shellcode Wrapper

All of phases 3 through 6 run inside the target process. We cannot call `WriteProcessMemory` to fix up relocations and imports because we need the target's address space to resolve them. The solution is a shellcode function: a self-contained C function compiled with all optimizations and runtime checks disabled (`#pragma runtime_checks("", off)`), copied byte-for-byte into the target process, and executed via `CreateRemoteThread`.

The `MAPPING_CTX` structure is our communication channel. We write it into the target process alongside the shellcode, pass its address as the thread parameter, and read it back after execution to check for errors. The context carries function pointers (`LoadLibraryA`, `GetProcAddress`, `RtlAddFunctionTable`), the image base address, and a result field that the shellcode sets to indicate success or failure.

## The Auto-Unload Pattern

Our worker DLL is designed for single-shot operation. Once it finishes collecting data, it writes the results to `%TEMP%/dezlock-export.json`, writes a zero-byte marker file at `%TEMP%/dezlock-done` to signal the orchestrator, and then unloads itself:

```cpp
FreeLibraryAndExitThread(hModule, 0);
```

`FreeLibraryAndExitThread` is an atomic operation that decrements the DLL's reference count and terminates the calling thread in a single syscall. If you tried to call `FreeLibrary` followed by `ExitThread` as separate calls, the `ExitThread` instruction would execute from memory that was just freed, causing an access violation. This API exists precisely for this use case.

The orchestrator process polls for the marker file, reads the JSON, and cleans up. The worker leaves no persistent footprint in the game process.

## Why Read-Only Matters

The worker DLL never writes to game memory. It does not hook functions, patch vtables, or modify any data structures. Every memory access in the worker is a read, wrapped in SEH to gracefully handle invalid pointers. This is a deliberate design constraint. A read-only tool cannot corrupt game state, cannot cause desyncs in multiplayer, and presents a fundamentally different risk profile than a cheat.

## Common Pitfalls

**Missing relocations.** If you skip relocation processing, the DLL will appear to load fine and then crash on the first absolute address reference. The crash will be an access violation at an address that looks suspiciously close to the preferred `ImageBase`, which is your diagnostic clue.

**Forgotten TLS callbacks.** Some DLLs (especially those linked with certain CRT configurations) have TLS callbacks that must fire before `DllMain`. Skipping them can cause silent initialization failures. Our implementation handles these by walking the TLS directory's callback array.

**SEH registration failures.** The most insidious bug. Without `RtlAddFunctionTable`, everything works until the first exception. If your DLL uses `__try/__except`, C++ exceptions, or any code path that triggers SEH, the process will terminate with an unhandled exception. We treat SEH registration failure as non-fatal (the DLL can still function if no exceptions occur) but log a warning because it means operating without a safety net.

**Shellcode compilation artifacts.** The shellcode function must be fully self-contained. If the compiler inserts security cookies (`__security_check_cookie`), stack probes (`__chkstk`), or other runtime calls, the shellcode will crash because those functions do not exist at the shellcode's location in the target process. We disable all runtime checks and GS checks with pragma directives.

**Kernel32 base address assumptions.** We pass `LoadLibraryA` and `GetProcAddress` pointers from our process into the target. This works because `kernel32.dll` loads at the same address in all processes within a boot session. If this assumption ever broke (it has not on any shipping version of Windows), the entire approach would need reworking.

## Key Takeaways

- **Manual mapping replaces the OS loader.** You parse the PE, allocate memory, copy sections, fix relocations, resolve imports, and register exception handlers yourself. The OS never sees a DLL load event.
- **Relocations are non-optional.** Unless you can guarantee your preferred base address (you cannot), relocation processing is mandatory on x64.
- **SEH registration is critical on x64.** Unlike x86 where SEH is stack-based, x64 uses table-driven exception handling. Call `RtlAddFunctionTable` or accept that any exception will be fatal.
- **The shellcode must be self-contained.** Disable all compiler-inserted runtime calls. Any implicit dependency on the CRT will crash inside the target process.
- **Read-only injection is a valid tool category.** Not all process injection is adversarial. Diagnostic, profiling, and reverse engineering tools benefit from the same techniques without modifying target state.
- **FreeLibraryAndExitThread is the correct cleanup pattern.** Never separate the free and exit calls when a DLL is unloading itself from its own thread.

---

*Part of the [dezlock-dump](https://github.com/dougwithseismic/dezlock-dump) technical series.*
