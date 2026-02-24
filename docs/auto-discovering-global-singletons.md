# Auto-Discovering 10,000+ Global Singletons Without Hardcoded Offsets

Modern game engines are sprawling systems. A single Source 2 title can load 58+ DLLs, each containing hundreds of manager objects, system registries, and subsystem singletons. These globals are the control surface of the engine: `CGameEntitySystem`, `CSchemaSystem`, `CInputService`, `CNetworkSystem` -- the objects that actually run the game.

The problem is that none of them are exported. There is no public API, no symbol table, no enum you can iterate. Traditional reverse engineering finds them one at a time, producing hardcoded offsets that break the moment the game updates. I wanted something better: a scanner that discovers *all* of them automatically, every time, with zero manual maintenance.

This post describes how I built it.

## The Problem With Hardcoded Offsets

The typical approach to finding a global singleton looks like this:

1. Open the binary in IDA or Ghidra.
2. Follow cross-references from a known function to a global address.
3. Record the offset. Ship it in your tool.
4. Game updates. Offset changes. Repeat from step 1.

This workflow scales terribly. A single game update can shift thousands of globals. If your tool depends on 50 hardcoded offsets, you're doing 50 manual lookups after every patch. For a project that aims to dump the *entire* engine schema -- every class, every field, every inheritance chain -- this is not viable.

I needed a way to discover globals generically, using structural properties of the objects themselves rather than their addresses.

## The Key Insight: Vtables Live in .rdata, Objects Live in .data

Every C++ object with virtual functions begins with a pointer to its vtable. The vtable lives in a read-only section (`.rdata`), and the object itself either lives in a writable section (`.data` for static globals) or on the heap (with a pointer in `.data`).

This means that if you already have a catalog of every vtable address in the module -- which I did, from the RTTI scanner -- you can cross-reference it against every pointer-sized value in the `.data` section. A match means you have found a global object.

The approach breaks into two passes:

- **Direct match**: The 8-byte value in `.data` *is* a vtable address. The object is embedded directly in the `.data` section, starting at that address.
- **Indirect match**: The 8-byte value in `.data` is a pointer to somewhere else in memory. Dereference it once, and *that* value is a vtable address. This is the heap-allocated singleton pattern -- `.data` holds a pointer, the actual object lives on the heap.

## Building the Vtable Catalog

The scanner depends on having a complete vtable-to-class-name mapping. This comes from the RTTI hierarchy scanner, which walks MSVC x64 RTTI structures across every loaded module. The `InheritanceInfo` struct carries everything we need:

```cpp
struct InheritanceInfo {
    std::string parent;
    std::vector<std::string> chain;
    std::string source_module;        // e.g. "client.dll"
    uint32_t vtable_rva = 0;         // RVA of vtable[0] in module
    // ...
};
```

The global scanner consumes this map and builds an absolute-address lookup table:

```cpp
std::unordered_map<uint64_t, std::string> vtable_to_class;

for (const auto& [key, info] : rtti_map) {
    if (info.vtable_rva == 0 || info.source_module.empty()) continue;

    std::string bare_name = schema::rtti_class_name(key);
    uint64_t vtable_abs = module_base + info.vtable_rva;
    vtable_to_class[vtable_abs] = bare_name;
}
```

This gives us a single hash map where any vtable address can be resolved to a class name in O(1). Across 58+ modules, this catalog typically contains thousands of entries.

## Scanning .data Sections

With the vtable catalog ready, the scanner walks every writable section of every loaded module at 8-byte alignment. The choice of 8-byte alignment is deliberate: on x64, pointers are 8 bytes and vtable pointers are always the first member of an object, so they will be naturally aligned.

```cpp
for (const auto& sec : mod.writable) {
    for (size_t off = 0; off <= sec.size - 8; off += 8) {
        uintptr_t addr = sec.start + off;
        uint64_t val = *reinterpret_cast<const uint64_t*>(addr);

        if (val == 0) continue;

        // Pass 1: Direct vtable match
        auto it = vtable_to_class.find(val);
        if (it != vtable_to_class.end()) {
            // Object lives right here in .data
            record_global(it->second, addr, /*is_pointer=*/false);
            continue;
        }

        // Pass 2: Indirect -- dereference and check
        if (!is_plausible_pointer(val)) continue;

        uint64_t vtable_ptr = 0;
        if (!safe_read_u64(val, vtable_ptr)) continue;

        auto it2 = vtable_to_class.find(vtable_ptr);
        if (it2 != vtable_to_class.end()) {
            // .data holds a pointer to a heap-allocated singleton
            record_global(it2->second, addr, /*is_pointer=*/true);
        }
    }
}
```

The `is_plausible_pointer` check filters out values that cannot possibly be x64 user-mode addresses (below `0x10000` or above `0x7FFFFFFFFFFF`), eliminating most false positives before the expensive dereference.

The dereference itself is wrapped in SEH (Structured Exception Handling) because we are reading arbitrary memory inside a game process. Not every pointer-shaped value in `.data` is actually a valid pointer:

```cpp
static bool safe_read_u64(uintptr_t addr, uint64_t& out) {
    __try {
        out = *reinterpret_cast<const uint64_t*>(addr);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}
```

Without SEH protection, a single bad dereference would crash the game. With it, we silently skip invalid addresses and keep scanning.

## Filtering and Deduplication

Raw vtable cross-referencing produces some noise. A class's vtable address might appear multiple times in `.data` -- in vtable arrays, RTTI internal structures, or multiple instances of the same type. The scanner deduplicates by class name per module, keeping only the first occurrence of each:

```cpp
std::unordered_set<std::string> found_classes;

// ...inside the scan loop:
std::string dedup_key = cls + ":direct";   // or ":pointer" for pass 2
if (!found_classes.count(dedup_key)) {
    found_classes.insert(dedup_key);
    // record this global
}
```

This allows a class to appear as both a direct `.data` object and a heap-allocated pointer (these are genuinely different globals) while filtering out duplicate references to the same class within the same category.

Each discovered global is also tagged with whether its class exists in the engine's SchemaSystem. This distinguishes schema-registered classes (with known field layouts) from internal C++ classes that only appear in RTTI.

## Supplementary: Pattern-Based Scanning

Not all globals have vtables. Data structures like the view matrix, entity list pointer, or local player index are plain values stored in `.data` with no virtual dispatch. For these, I use a secondary scanner driven by `patterns.json` -- a config file of IDA-style byte patterns:

```json
{
  "name": "dwViewMatrix",
  "module": "client.dll",
  "mode": "rip_relative",
  "pattern": "48 8D 0D ?? ?? ?? ?? 48 C1 E0 06",
  "rip_offset": 3
}
```

The scanner parses the pattern into a byte/mask pair and sweeps the module's code sections for a match. When found, it resolves the RIP-relative displacement to compute the global's RVA:

```cpp
uint32_t scan_rip_relative(const uint8_t* mem, size_t size,
                           uintptr_t base, const char* sig, int rip_offset) {
    ParsedPattern pat = parse_ida_pattern(sig);
    int64_t match = find_pattern(mem, size, pat);
    if (match < 0) return 0;

    int32_t disp = *(const int32_t*)(mem + match + rip_offset);
    uintptr_t abs_addr = (base + match + rip_offset + 4) + disp;
    return (uint32_t)(abs_addr - base);
}
```

The pattern scanner also supports a `Derived` mode for globals whose address is computed as a field offset from another global. This handles cases like `dwEntityList` being at `dwGameEntitySystem + 0x10`, where the offset itself is extracted from a code pattern.

The two-pass resolution ensures that base globals (`RipRelative`) are resolved first, then derived globals can reference them:

```cpp
// Pass 1: resolve all RipRelative entries
for (const auto& e : cfg.entries) {
    if (e.mode != ResolveMode::RipRelative) continue;
    uint32_t rva = scan_rip_relative(/*...*/);
    resolved_rvas[e.name] = rva;
}

// Pass 2: resolve Derived entries using pass 1 results
for (const auto& e : cfg.entries) {
    if (e.mode != ResolveMode::Derived) continue;
    uint32_t base_rva = resolved_rvas[e.derived_from];
    uint32_t field_offset = scan_extract_u32(/*...*/);
    uint32_t rva = base_rva + field_offset;
}
```

Patterns do require updating when the compiler emits different instruction sequences, but they are far more resilient than raw offsets. A byte pattern for a `LEA rcx, [rip+disp32]` instruction will survive most patches that don't change the surrounding code structure.

## Results

Running against a live game process, the vtable cross-reference scanner discovers **10,000+ globals** across 58+ loaded modules, each tagged with:

- The RTTI class name (e.g., `CGameEntitySystem`, `CSchemaSystem`)
- The module it lives in
- The RVA of the global variable
- Whether it is a direct `.data` object or a pointer to a heap allocation
- Whether the class has SchemaSystem field definitions

The pattern scanner adds a handful of supplementary globals that lack vtables. Combined, this gives a complete picture of the engine's global state -- automatically, on every run, with no version-specific maintenance.

## Why This Matters

The traditional reverse engineering workflow treats each global as a manual discovery task. It produces brittle tools that break on every update and require constant human attention.

The vtable cross-reference approach inverts this: instead of asking "where is this specific global?", it asks "what globals exist?". The answer falls out of structural properties that are invariant across patches -- objects have vtables, vtables are in `.rdata`, objects are in `.data`, and RTTI links them to names.

This makes the tool essentially update-proof for the vast majority of globals. The game binary changes on every patch, but the structural relationships between vtables, objects, and RTTI data do not.

## Key Takeaways

- **Vtable pointers are structural fingerprints.** Every virtual C++ object starts with one, and they are unique per class per module. This makes them ideal cross-reference targets.
- **Two-pass scanning catches both patterns.** Static globals have their vtable pointer directly in `.data`. Heap-allocated singletons have a pointer in `.data` that must be dereferenced once.
- **SEH is mandatory.** When you are dereferencing arbitrary values from a game's memory, some of them will be invalid. Structured Exception Handling keeps the scanner from crashing the target process.
- **8-byte alignment eliminates noise.** On x64, pointer-sized values at natural alignment cuts the search space by 8x and eliminates most false positives from mid-field matches.
- **Pattern scanning fills the gaps.** Not everything has a vtable. IDA-style byte patterns with RIP-relative resolution handle plain data globals, and derived mode chains them together.
- **Structural invariants beat hardcoded offsets.** Offsets change every patch. The fact that objects have vtables does not.

---

*Part of the [dezlock-dump](https://github.com/dougwithseismic/dezlock-dump) technical series.*
