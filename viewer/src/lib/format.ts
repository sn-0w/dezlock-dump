/** Format number as hex with padding */
export function h(v: number | null | undefined, d = 3): string {
  if (v == null) return '\u2014'
  const s = v.toString(16).toUpperCase()
  return '0x' + s.padStart(d, '0')
}

/** Ensure string has 0x prefix */
export function hs(s: string | null | undefined): string {
  if (!s) return '\u2014'
  return s.startsWith('0x') ? s : '0x' + s
}

/** Format number with locale separators */
export function fnum(n: number | null | undefined): string {
  return n != null ? n.toLocaleString('en-US') : '0'
}

/** Extract inner class/type name from a field type string */
export function extractType(t: string | null | undefined): string | null {
  if (!t) return null
  let n = t.replace(/[*&\s]+$/g, '').trim()
  const m = n.match(/^[A-Za-z_]\w*<\s*([A-Za-z_]\w*)\s*>$/)
  if (m) n = m[1]
  n = n.replace(/\[\d*\]$/, '').trim()
  return /^[A-Z]/.test(n) && n.length > 1 ? n : null
}

/** Known container/wrapper type names that should not be treated as expandable classes */
const CONTAINER_NAMES = new Set([
  'CUtlVector', 'CNetworkUtlVectorBase', 'CUtlVectorEmbeddedNetworkVar',
  'C_NetworkUtlVectorBase', 'C_UtlVectorEmbeddedNetworkVar',
  'CHandle', 'CStrongHandle', 'CWeakHandle',
  'CUtlStringToken', 'CUtlString', 'CUtlSymbolLarge',
  'CResourceNameTyped', 'CResourceArray',
])

/**
 * Extract ALL candidate class-like identifiers from a type string.
 * Filters out known container/wrapper names, returning innermost types first.
 */
export function extractTypeNames(t: string): string[] {
  if (!t) return []
  // Match identifiers starting with uppercase or C_/S_ prefix patterns
  const matches = t.match(/[A-Z][A-Za-z0-9_]*/g)
  if (!matches) return []
  // Reverse so innermost (most specific) come first
  return [...matches].reverse().filter((n) => n.length > 1 && !CONTAINER_NAMES.has(n))
}

/**
 * Resolve the best expandable class type from a field type string.
 * Tries each candidate from extractTypeNames against resolveClassMod.
 */
export function resolveFieldType(
  type: string | null | undefined,
  resolveClassMod: (name: string, preferMod?: string) => string | null,
  preferModule?: string,
): { typeName: string; typeMod: string } | null {
  if (!type) return null
  const candidates = extractTypeNames(type)
  for (const name of candidates) {
    const mod = resolveClassMod(name, preferModule)
    if (mod) return { typeName: name, typeMod: mod }
  }
  return null
}

/** Determine live editor type from field type string */
export function liveEditorType(
  fieldType: string | null | undefined,
  enumMap?: Map<string, unknown>,
  classMap?: Map<string, unknown>,
): string {
  if (!fieldType) return 'text'
  const t = fieldType.replace(/\s/g, '')
  if (t === 'bool') return 'bool'
  if (t === 'Color') return 'color'
  if (/^(Vector[24]?D?|QAngle|Vector4D|Quaternion)$/i.test(t)) return 'vector'
  if (/^CHandle</.test(t)) return 'handle'
  if (/^(CUtlString|CUtlSymbolLarge)$/.test(t)) return 'pointer'
  if (/^float(32|64)?$/.test(t)) return 'float'
  if (/^(u?int(8|16|32|64)|char|short|long|bool)$/.test(t)) return 'int'
  if (enumMap && enumMap.has(t)) return 'enum'
  if (classMap && classMap.has(t)) return 'struct'
  return 'text'
}
