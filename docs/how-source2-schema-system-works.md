# How Source 2's SchemaSystem Works Internally

Source 2 ships with a runtime reflection system called **SchemaSystem**. Every class that participates in serialization, networking, or editor tooling registers itself here at load time, making its fields, types, offsets, and inheritance available for introspection. If you have ever wondered how Valve's engine knows which bytes to send over the network for a player entity, or how Hammer resolves property types for a brush entity, SchemaSystem is the answer.

When I started exploring Deadlock's internals, SchemaSystem was the first thing I targeted. It is the single source of truth for class layouts, and if you can walk it at runtime, you can reconstruct complete SDK headers for every registered class -- without a single hardcoded offset in your game-specific code.

This post explains how it works, how to access it, and what the internal data structures look like.

## Why Valve Built SchemaSystem

Source 2 games need runtime type information for three core systems:

1. **Serialization** -- saving and loading entities from disk (maps, save files, replays) requires knowing every field's offset, type, and size. SchemaSystem provides this so the engine does not depend on compile-time reflection or manual registration macros.

2. **Networking** -- the Source 2 netcode sends delta-compressed entity state between server and client. It needs to know which fields exist, how large they are, and which are marked `MNetworkEnable`. SchemaSystem stores per-field metadata annotations that the networking layer queries directly.

3. **Tooling** -- Hammer, the particle editor, and the animation graph editor all need to enumerate class properties at runtime to build inspector UIs. SchemaSystem gives them the field names, types, and annotations without requiring generated reflection code.

The system acts as a module-scoped registry. Each DLL (`client.dll`, `server.dll`, `animationsystem.dll`, etc.) gets its own **TypeScope** that holds the classes and enums registered by that module.

## Finding SchemaSystem_001 at Runtime

Source 2 DLLs expose their subsystems through a factory pattern. Every module that publishes interfaces exports a C function called `CreateInterface`:

```cpp
// Every Source 2 DLL exports this
using CreateInterfaceFn = void*(*)(const char* name, int* return_code);
```

To get the SchemaSystem pointer, you load `schemasystem.dll` and call its `CreateInterface` with the version string `"SchemaSystem_001"`:

```cpp
void* find_schema_system() {
    HMODULE hmod = GetModuleHandleA("schemasystem.dll");
    if (!hmod) return nullptr;

    auto fn = reinterpret_cast<CreateInterfaceFn>(
        GetProcAddress(hmod, "CreateInterface"));
    if (!fn) return nullptr;

    int ret = 0;
    return fn("SchemaSystem_001", &ret);
}
```

The returned pointer is a `CSchemaSystem` object. Its vtable gives you methods to look up modules and classes. The key virtual function is at **vtable index 13**: `FindTypeScopeForModule`, which takes a module name (e.g. `"client.dll"`) and returns the `CSchemaSystemTypeScope` for that module.

```cpp
// SchemaSystem vtable[13]: FindTypeScopeForModule
auto vtable = *reinterpret_cast<uintptr_t**>(schema_system);
auto FindTypeScopeForModule = reinterpret_cast<void*(__fastcall*)(void*, const char*, void*)>(vtable[13]);
void* scope = FindTypeScopeForModule(schema_system, "client.dll", nullptr);
```

Each TypeScope has a 256-byte name buffer at `+0x08` and, more importantly, two hash tables that hold the actual registration data.

## CUtlTSHash: The Thread-Safe Hash Map

Inside each `CSchemaSystemTypeScope`, classes and enums are stored in **CUtlTSHash** instances -- Valve's thread-safe hash map built on top of a memory pool allocator.

The two hash tables live at fixed offsets within the TypeScope:

| Offset | Contents |
|--------|----------|
| `+0x0560` | `CUtlTSHash` for **class bindings** |
| `+0x0BE8` | `CUtlTSHash` for **enum bindings** |

The internal layout of CUtlTSHash (Win x64) is:

```
CUtlTSHash<T, KeyType, 256>
  +0x00  CUtlMemoryPoolBase (pool header, ~0x60 bytes)
    +0x0C  m_BlocksAllocated (int32) -- committed entry count
    +0x10  m_PeakAlloc (int32)       -- total ever allocated
  +0x60  HashBucket_t[256]           -- 256 buckets, 0x18 bytes each
    +0x00  m_AddLock (ptr)           -- per-bucket lock for thread safety
    +0x08  m_pFirst (HashFixedData_t*)
    +0x10  m_pFirstUncommitted (HashFixedData_t*)
```

Each bucket contains a singly-linked list of `HashFixedData_t` nodes:

```
HashFixedData_t
  +0x00  m_uiKey  (uint64)              -- hash key
  +0x08  m_pNext  (HashFixedData_t*)     -- next node in chain
  +0x10  m_Data   (CSchemaClassInfo*)    -- the actual class/enum binding
```

To enumerate all registered classes, you walk all 256 bucket chains. I follow the `m_pFirstUncommitted` pointer at `+0x10` within each bucket and traverse the linked list until null:

```cpp
constexpr int BUCKET_COUNT = 256;
constexpr uintptr_t BUCKET_STRIDE = 0x18;

uintptr_t hash_base = type_scope + 0x0560;
uintptr_t buckets = hash_base + 0x60; // skip pool header

for (int i = 0; i < BUCKET_COUNT; ++i) {
    uintptr_t bucket = buckets + i * BUCKET_STRIDE;
    uintptr_t node = *(uintptr_t*)(bucket + 0x10); // m_pFirstUncommitted

    while (node) {
        uintptr_t class_info = *(uintptr_t*)(node + 0x10); // m_Data
        if (class_info) {
            // class_info is a CSchemaClassInfo* -- resolve it
        }
        node = *(uintptr_t*)(node + 0x08); // m_pNext
    }
}
```

There is also a **free list** in the pool header (at `+0x18` or `+0x20` depending on the build) that contains entries which have been allocated but are not yet committed to a bucket. Walking this chain picks up additional classes that the bucket walk misses.

The thread-safety comes from the per-bucket `m_AddLock` pointer. The engine acquires this lock when inserting new entries, which means our read-only enumeration is safe as long as we only read (and handle access violations gracefully).

## RuntimeClass: What a Registered Class Looks Like

Each `CSchemaClassInfo` (the `m_Data` from the hash node) has the following layout:

```
SchemaClassInfoData_t
  +0x00  m_pSelf       (ptr)         -- self-pointer (used for validation)
  +0x08  m_pszName     (const char*) -- "C_BaseEntity", "CPlayerPawn", etc.
  +0x10  m_pszModule   (const char*) -- "client.dll", "server.dll"
  +0x18  m_nSizeOf     (int32)       -- sizeof the class in bytes
  +0x1C  m_nFieldSize  (int16)       -- number of direct fields
  +0x22  m_unAlignOf   (uint8)       -- alignment requirement
  +0x23  m_nBaseClassSize (int8)     -- count of base classes
  +0x28  m_pFields     (ptr)         -- array of SchemaClassFieldData_t
  +0x38  m_pBaseClasses (ptr)        -- array of SchemaBaseClassInfoData_t
  +0x48  m_pStaticMetadata (ptr)     -- class-level annotation array
```

The base class array at `+0x38` contains entries of 0x10 bytes each, where `+0x00` is the offset of the base within the derived class and `+0x08` is a pointer to the base's `CSchemaClassInfo`. This gives you the full inheritance tree -- you can recursively walk parent pointers until you reach a class with zero base classes.

## RuntimeField: Per-Field Metadata

Each field entry (`SchemaClassFieldData_t`) is 0x20 bytes:

```
SchemaClassFieldData_t
  +0x00  m_pszName                (const char*)     -- "m_iHealth"
  +0x08  m_pSchemaType            (CSchemaType*)     -- type descriptor
  +0x10  m_nSingleInheritanceOffset (int32)          -- byte offset in class
  +0x14  m_nMetadataSize          (int16)            -- annotation count
  +0x18  m_pMetadata              (ptr)              -- annotation array
```

The `CSchemaType` pointer at `+0x08` gives you the type name string (at `CSchemaType+0x08`) and a vtable method (`vtable[3]: GetSizes`) that returns the field's byte size. Type names are what you would expect: `int32`, `float32`, `Vector`, `CHandle< CBaseEntity >`, `CUtlVector< CHandle< CBaseEntity > >`, etc.

The metadata array contains `SchemaMetadataEntryData_t` entries (0x10 bytes each) with a name string and a value pointer. The most important annotations are:

- **MNetworkEnable** -- field is networked between server and client
- **MNetworkChangeCallback** -- field triggers a callback on change
- **MNetworkSerializer** -- custom serialization function name

These annotations are how the engine decides which fields to include in network snapshots without hardcoding field lists.

## Flat Field Layouts: Resolving Inheritance

A class like `C_DOTA_BaseNPC_Hero` might inherit from `C_DOTA_BaseNPC`, which inherits from `C_BaseAnimatingActivity`, which inherits from `C_BaseModelEntity`, and so on. Each class in the chain declares its own fields with offsets **relative to itself**, not relative to the top-level class.

To get the complete layout with absolute offsets, you need to flatten the hierarchy. For each base class entry, the `m_unOffset` field tells you where that base sits within the derived class. You add this to each of the base's field offsets recursively:

```cpp
void flatten(const RuntimeClass* cls, int32_t base_offset, FlatLayout& out) {
    // Add this class's own fields with accumulated offset
    for (const auto& f : cls->fields) {
        out.fields.push_back({
            f.name, f.type_name,
            base_offset + f.offset,  // absolute offset
            f.size, cls->name
        });
    }

    // Recurse into base classes
    for (const auto& base : cls->base_classes) {
        const RuntimeClass* parent = find_class(cls->module, base.name);
        if (parent) {
            flatten(parent, base_offset + base.offset, out);
        }
    }
}
```

After flattening, you sort by offset and you have a complete memory map of the class. This is exactly what the engine does when it needs to serialize an entity or build a network delta.

## Enum Registration

Enums live in the second CUtlTSHash at TypeScope `+0x0BE8`. Each `SchemaEnumInfoData_t` entry has:

```
SchemaEnumInfoData_t
  +0x08  m_pszName           (const char*)   -- "DamageTypes_t"
  +0x10  m_pszModule         (const char*)   -- "server.dll"
  +0x18  m_nSize             (int8)          -- byte width (1, 2, or 4)
  +0x1C  m_nEnumeratorCount  (int16)         -- number of values
  +0x20  m_pEnumerators      (ptr)           -- array of name/value pairs
```

Each enumerator is 0x20 bytes with a name string at `+0x00` and an `int64` value at `+0x08`. The enumeration walk is identical to the class walk -- same CUtlTSHash structure, same bucket traversal, just with a different validator and resolver.

## The Hardcoded Offsets Problem

Every offset mentioned in this post -- `+0x0560` for the class hash, `+0x0BE8` for enums, `+0x28` for the fields pointer, `+0x38` for base classes -- comes from reverse engineering. These values are correct for current Source 2 builds, cross-referenced against community projects like source2gen and cs2-dumper, but they are **not stable across major engine versions**.

When Valve adds a field to `CSchemaSystemTypeScope` or reorders members in `SchemaClassInfoData_t`, every one of these offsets could shift. There is no public API or header file that guarantees them. In practice, they have been stable across minor patches, but a major engine revision (like the jump from Source 1 to Source 2, or a significant refactor of the schema system itself) would require re-deriving them.

I mitigate this in my tooling by probing multiple candidate offsets when the expected one fails. For example, the memory pool header size before the hash buckets has varied between 0x60 and 0x80 across different Source 2 titles, so the code scans a range of pool sizes and validates entries at each candidate offset until it finds one that produces valid class names. It is not elegant, but it is robust.

## Practical Considerations

### SEH Protection

When you are running inside a game process reading arbitrary memory addresses, any pointer could be invalid. A stale class info pointer, a pool entry that was freed between your read and your dereference, a module that unloaded -- all of these produce access violations.

Every memory read in my schema walker is wrapped in a Structured Exception Handler:

```cpp
static bool seh_read_ptr(uintptr_t addr, uintptr_t* out) {
    __try {
        *out = *reinterpret_cast<uintptr_t*>(addr);
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}
```

This is not optional. Without SEH, a single bad pointer crashes the game. With SEH, you get a `false` return and skip to the next entry. I have separate SEH wrappers for every primitive type (`int8`, `int16`, `int32`, `int64`, `uint32`, `const char*`) and for vtable calls, because each has different failure modes and you want the exception boundary as tight as possible.

### String Validation

Engine-owned strings should be printable ASCII. When reading a `const char*` from a class info struct, I validate that every byte is in the `0x20`-`0x7E` range for up to 128 characters. This catches dangling pointers that happen to land on non-null memory -- a common failure mode when walking stale hash entries.

### Thread Safety

The schema system is designed for concurrent reads. The CUtlTSHash uses per-bucket locks for writes, and reads are lock-free. Since we only read, we do not need to acquire any locks. However, if the engine is actively registering new classes while we enumerate (e.g. during module load), we might see partially-initialized entries. Running the dump after all modules have loaded -- which I do by waiting for the game to reach a stable state -- avoids this.

### Auto-Detection of Module Scopes

Rather than hardcoding which modules to scan, you can enumerate loaded DLLs via `EnumProcessModules` and try `FindTypeScopeForModule` for each one. Modules without schema data simply return null. This future-proofs against new modules being added.

## Key Takeaways

- **SchemaSystem is Valve's runtime reflection backbone** -- it powers serialization, networking, and tooling. Everything registered here is introspectable at runtime.

- **CUtlTSHash is a 256-bucket hash map with a pool allocator** -- walking it requires understanding the pool header, the bucket stride, and the linked-list node layout. Both bucket chains and the free list must be traversed for a complete enumeration.

- **Field offsets are relative to the declaring class** -- to get absolute offsets, you must accumulate base class offsets through the inheritance chain. The `m_unOffset` in `SchemaBaseClassInfoData_t` is the key value.

- **All offsets into engine structures are reverse-engineered and fragile** -- they work today but are not guaranteed across engine updates. Build your tooling to probe and validate rather than assert.

- **SEH protection is mandatory when reading game memory** -- wrap every dereference. A single unhandled access violation kills the host process.

- **Metadata annotations drive the networking layer** -- `MNetworkEnable` and friends determine which fields are replicated. This is where the engine's networking efficiency comes from: it does not send what it does not need to.

---

*Part of the [dezlock-dump](https://github.com/dougwithseismic/dezlock-dump) technical series.*
