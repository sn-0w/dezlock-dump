interface LivePointerProps {
  value: unknown
}

export function LivePointer({ value }: LivePointerProps) {
  // Rich typed object from server with _t='ptr'
  if (value && typeof value === 'object' && '_t' in value) {
    const v = value as { _t: string; addr?: string; type?: string; valid?: boolean; class?: string; declared_type?: string }

    // Show RTTI-resolved class name if available, otherwise declared type
    const displayType = v.class || v.type
    const showDeclared = v.declared_type && v.declared_type !== displayType

    return (
      <>
        <span
          className={'live-ptr' + (v.valid && displayType ? ' insp-drilldown-toggle' : '')}
          title="Click to drill down"
          data-drill-addr={v.valid && displayType ? v.addr : undefined}
          data-drill-type={v.valid && displayType ? displayType : undefined}
        >
          {v.addr || '0x0'}
        </span>
        {displayType && (
          <span className="badge" style={{ marginLeft: 4 }}>
            {displayType}*
          </span>
        )}
        {showDeclared && (
          <span
            className="badge"
            style={{
              marginLeft: 4,
              opacity: 0.5,
              fontSize: '0.85em',
            }}
            title={`Declared as ${v.declared_type}*`}
          >
            {v.declared_type}*
          </span>
        )}
        {!v.valid && (
          <span
            className="badge"
            style={{
              marginLeft: 4,
              background: 'var(--err-bg,#3d1f1f)',
              color: 'var(--err,#f85149)',
            }}
          >
            null
          </span>
        )}
      </>
    )
  }

  // Bare string pointer value
  const strVal = String(value)
  return (
    <span
      className="live-ptr insp-drilldown-toggle"
      title="Click to drill down (string pointer)"
      data-drill-addr={strVal}
      data-drill-type=""
    >
      {'\u25B6'} {strVal}
    </span>
  )
}
