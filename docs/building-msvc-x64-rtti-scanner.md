# Building an MSVC x64 RTTI Scanner from Scratch

Every C++ class with at least one virtual function carries a hidden payload: compiler-generated metadata that powers `dynamic_cast` and `typeid`. On MSVC x64, this metadata -- Run-Time Type Information (RTTI) -- forms a rich, navigable graph of class names and inheritance relationships baked directly into the binary. If you know how to read it, you can reconstruct the full class hierarchy of any unstripped executable without source code, symbols, or debug information.

I built a scanner that does exactly this. It processes a 60MB game module in under 60ms, recovering 23,000+ class names, their inheritance chains, vtable locations, and virtual function prologues. This article walks through the structures involved, the scanning strategy, and the engineering decisions that make it practical at scale.

## The RTTI Structure Chain

MSVC generates four interlocking structures for every polymorphic class. Understanding their layout is the foundation of any RTTI scanner.

```
                        .rdata section layout (x64)
  +-----------------------------------------------------------------+
  |                                                                 |
  |  TypeDescriptor (per class)                                     |
  |  +0x00  pVFTable     (8 bytes) -- ptr to type_info vtable       |
  |  +0x08  spare        (8 bytes) -- reserved, usually 0           |
  |  +0x10  name[]       (variable) -- mangled: ".?AVC_BaseEntity@@"|
  |                                                                 |
  +-----------------------------------------------------------------+
  |                                                                 |
  |  CompleteObjectLocator (per vtable)                             |
  |  +0x00  signature          (4 bytes) -- always 1 on x64        |
  |  +0x04  offset             (4 bytes) -- vtable offset in class  |
  |  +0x08  cd_offset          (4 bytes) -- constructor disp        |
  |  +0x0C  type_desc_rva      (4 bytes) -- RVA -> TypeDescriptor   |
  |  +0x10  class_hierarchy_rva(4 bytes) -- RVA -> CHD              |
  |  +0x14  self_rva           (4 bytes) -- RVA of this COL itself  |
  |                                                                 |
  +-----------------------------------------------------------------+
  |                                                                 |
  |  ClassHierarchyDescriptor                                       |
  |  +0x00  signature          (4 bytes) -- always 0                |
  |  +0x04  attributes         (4 bytes) -- MI/VI flags             |
  |  +0x08  num_base_classes   (4 bytes) -- length of BCA           |
  |  +0x0C  base_class_array_rva (4 bytes) -- RVA -> int32_t[]      |
  |                                                                 |
  +-----------------------------------------------------------------+
  |                                                                 |
  |  BaseClassDescriptor (one per class in hierarchy)               |
  |  +0x00  type_desc_rva      (4 bytes) -- RVA -> TypeDescriptor   |
  |  +0x04  num_contained_bases(4 bytes)                            |
  |  +0x08  mdisp              (4 bytes) -- member displacement     |
  |  +0x0C  pdisp              (4 bytes) -- vtable displacement     |
  |  +0x10  vdisp              (4 bytes) -- displacement within vbt |
  |  +0x14  attributes         (4 bytes)                            |
  |  +0x18  class_hierarchy_rva(4 bytes)                            |
  |                                                                 |
  +-----------------------------------------------------------------+
```

A critical difference between x86 and x64: on x64, all cross-references within these structures use **RVAs** (relative virtual addresses from the module base), not absolute pointers. The `self_rva` field in the CompleteObjectLocator is the key to reliable scanning -- it lets you validate any candidate COL by checking whether the field matches its own offset within the module.

## Pass 1: Finding TypeDescriptors

TypeDescriptors are the anchor point. Every one contains a mangled class name string starting with `.?AV` (for classes) or `.?AU` (for structs). The name field sits at offset `+0x10` from the start of the TypeDescriptor, which means you can find them with a simple byte scan:

```cpp
for (size_t i = 0; i + 20 < size; i++) {
    if (mem[i] != '.' || mem[i+1] != '?' || mem[i+2] != 'A'
        || (mem[i+3] != 'V' && mem[i+3] != 'U'))
        continue;

    // TypeDescriptor starts 0x10 bytes before the name
    if (i < 0x10) continue;

    const char* name = reinterpret_cast<const char*>(mem + i);
    const char* end = strstr(name, "@@");
    if (!end || (end - name) > 256) continue;

    int32_t td_rva = static_cast<int32_t>(i - 0x10);
    rva_to_name[td_rva] = demangle(name);
}
```

Demangling is straightforward for simple class names: strip the `.?AV` prefix and `@@` suffix. `.?AVC_BaseEntity@@` becomes `C_BaseEntity`. For the purposes of hierarchy building, this is sufficient -- we do not need to handle template specializations or nested namespaces in the initial pass, though a production scanner could extend the demangler to cover those cases.

This pass typically finds 15,000-25,000 TypeDescriptors in a large game module.

## Pass 2: Finding CompleteObjectLocators

With the TypeDescriptor RVA map in hand, the next pass scans for CompleteObjectLocators. A COL is 24 bytes, aligned to 4-byte boundaries. Validation uses three criteria:

1. `signature == 1` (the x64 magic number; x86 uses 0)
2. `self_rva` matches the candidate's actual offset within the module
3. `type_desc_rva` points to a known TypeDescriptor from Pass 1

```cpp
for (size_t i = 0; i + sizeof(RTTICompleteObjectLocator) <= size; i += 4) {
    auto* col = reinterpret_cast<const RTTICompleteObjectLocator*>(mem + i);

    if (col->signature != 1) continue;
    if (col->self_rva != static_cast<int32_t>(i)) continue;

    auto it = rva_to_name.find(col->type_desc_rva);
    if (it == rva_to_name.end()) continue;

    cols.push_back({it->second, col->class_hierarchy_rva});
}
```

The `self_rva` check is what makes this robust. Random data that happens to have `signature == 1` will almost never also have a valid self-referencing RVA. False positive rate in practice: effectively zero.

Note that a single class can have multiple COLs -- one per vtable in the case of multiple inheritance. The COL with `offset == 0` corresponds to the primary vtable.

## Pass 3: Walking the Inheritance Chain

Each COL points to a ClassHierarchyDescriptor, which contains a count and an RVA to an array of BaseClassDescriptor RVAs. The array order follows a depth-first traversal of the hierarchy:

```
Index [0] = Self
Index [1] = Direct parent
Index [2] = Direct parent's parent
...and so on up to the root
```

Walking this is a straightforward loop:

```cpp
for (uint32_t j = 0; j < hierarchy->num_base_classes; j++) {
    int32_t bcd_rva = base_class_array[j];
    auto* bcd = reinterpret_cast<const RTTIBaseClassDescriptor*>(mem + bcd_rva);

    auto name_it = rva_to_name.find(bcd->type_desc_rva);
    if (name_it == rva_to_name.end()) continue;

    info.chain.push_back(name_it->second);
    if (j == 1) info.parent = name_it->second;
}
```

The result is a complete inheritance chain for every class. For a class like `C_DOTA_BaseNPC_Hero`, the chain might be eight classes deep, bottoming out at `CEntityInstance`.

One subtlety: we skip classes that have already been processed. The first COL encountered for a given class name corresponds to its primary vtable, and that is the one we want. Subsequent COLs for the same class represent secondary vtables from multiple inheritance and would produce duplicate (or partial) hierarchy entries.

## Pass 4: Resolving Vtables and Capturing Function Prologues

This is where the scanner goes beyond simple hierarchy discovery. MSVC places a pointer to the CompleteObjectLocator at `vtable[-1]` -- that is, the 8 bytes immediately preceding the first virtual function pointer. By scanning `.rdata` for pointers that match known COL addresses, we can find every vtable in the module.

```
Memory layout of a vtable:
  [addr - 8]  pointer to COL   <-- we find this
  [addr + 0]  vfunc[0] ptr     <-- vtable[0] starts here
  [addr + 8]  vfunc[1] ptr
  [addr + 16] vfunc[2] ptr
  ...
```

The scan builds a set of all known COL absolute addresses, then does a single linear pass over `.rdata` checking each 8-byte aligned value:

```cpp
for (uintptr_t addr = rdata_start; addr + 8 <= rdata_end; addr += 8) {
    uintptr_t val = *reinterpret_cast<const uintptr_t*>(addr);

    auto it = col_abs_to_idx.find(val);
    if (it == col_abs_to_idx.end()) continue;

    // vtable[0] starts at addr + 8
    uintptr_t vtable_start = addr + 8;
    // Read consecutive entries that point into .text...
}
```

Once a vtable is located, we walk its entries sequentially. Each slot should contain a pointer into the `.text` section. We stop at the first entry that does not -- that marks the end of the vtable. For each valid function pointer, we capture the first 128 bytes of the function body. These prologues are later used for signature generation: converting raw bytes into masked IDA-style patterns that survive game updates.

Reading function bytes from inside a game process means touching potentially unmapped memory at page boundaries. Every read goes through an SEH-protected `safe_memcpy`:

```cpp
static size_t safe_memcpy(void* dst, const void* src, size_t len) {
    __try {
        memcpy(dst, src, len);
        return len;
    } __except(EXCEPTION_EXECUTE_HANDLER) {
        return 0;
    }
}
```

This is not optional. Without SEH guards, a single bad page boundary will crash the host process.

## Data Structure Design

The output of the scanner is an `unordered_map<string, InheritanceInfo>`:

```cpp
struct InheritanceInfo {
    std::string parent;                     // direct parent (empty if root)
    std::vector<std::string> chain;         // [self, parent, grandparent, ...]
    std::string source_module;              // "client.dll", "engine2.dll", etc.
    uint32_t vtable_rva = 0;               // RVA of vtable[0]
    std::vector<uint32_t> vtable_func_rvas; // function RVAs per vtable slot
    std::vector<std::vector<uint8_t>> vtable_func_bytes; // first 128 bytes each
};
```

For 23,000+ classes, this map is the primary lookup structure. A flat `unordered_map` was chosen over a tree structure because the dominant access pattern is lookup-by-name, not traversal. When you need to answer "what are all children of X?", a reverse index is built lazily on the caller side by iterating the map once.

Storing the full chain as a vector rather than just the direct parent avoids repeated traversals when you need the complete ancestry. The trade-off is memory -- roughly 10-15 bytes per chain entry, totaling under 5MB for the entire hierarchy. That is negligible compared to the function bytes, which at 128 bytes per function across hundreds of thousands of vtable entries can reach 50-100MB.

## Cross-Module Considerations

Real game engines load dozens of DLLs, and the same class name can appear in multiple modules. `CEntityInstance` might have RTTI entries in both `client.dll` and `server.dll`. The `source_module` field tracks provenance, and the caller uses composite keys (module + class name) when building the global hierarchy.

Name demangling also requires care. The simple `.?AV...@@` pattern covers the vast majority of game engine classes, but templated types produce names like `.?AV?$CUtlVector@VCEntityHandle@@@@`. The scanner handles these by extracting the full string between `.?AV`/`.?AU` and the terminal `@@`, which preserves template parameters in the output without attempting full demangling. For hierarchy purposes, the mangled-but-readable name is sufficient.

## Why This Matters

Many game engine classes exist only in compiled code -- they have no schema registration, no reflection metadata, no protobuf descriptors. Classes like `CInputSystem`, `CPanoramaUIEngine`, and `CCitadelInput` are invisible to the engine's own schema system. RTTI is the only reliable way to discover them and map their relationships.

This has practical applications beyond reverse engineering. Security researchers use RTTI maps to identify attack surface in C++ applications. Engine developers use them to validate that their class hierarchies match design intent. Tool developers use vtable discovery to build function hook tables without manual address hunting.

The scanner described here runs as an injected DLL inside the target process, giving it direct access to mapped memory. But the same technique works on static PE files -- you just need to manually apply relocations before resolving RVAs. The structures and the scanning logic are identical.

## Key Takeaways

- **MSVC x64 RTTI uses RVAs, not absolute pointers.** The `self_rva` field in the CompleteObjectLocator is your best validation tool -- it creates a self-referencing checksum that eliminates false positives.

- **Four passes, one linear scan each.** TypeDescriptors (string scan), COLs (structure scan), hierarchy chains (pointer chasing), and vtables (pointer matching). Each pass is O(n) over the module size. Total wall time under 60ms for large modules.

- **SEH is mandatory when reading process memory.** Any read from a function pointer could cross a page boundary into unmapped memory. Wrap every read in `__try/__except` or accept random crashes.

- **The vtable sits at COL pointer + 8.** This is the critical insight for vtable discovery. MSVC places the COL pointer at `vtable[-1]`, so the first virtual function pointer is 8 bytes after the COL reference in `.rdata`.

- **Function prologues enable update-resilient signatures.** Capturing the first 128 bytes of each virtual function gives you enough material to generate masked byte patterns that survive recompilation across game patches.

- **RTTI fills the gaps that reflection systems miss.** Schema systems and protobuf descriptors only cover classes the engine explicitly registers. RTTI covers everything with a virtual function -- which in a modern C++ engine is nearly every class that matters.

---

*Part of the [dezlock-dump](https://github.com/dougwithseismic/dezlock-dump) technical series.*
