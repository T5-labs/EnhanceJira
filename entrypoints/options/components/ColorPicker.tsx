type Props = {
  id: string;
  label: string;
  emoji: string;
  value: string;
  defaultValue: string;
  onChange: (hex: string) => void;
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function ColorPicker({ id, label, emoji, value, defaultValue, onChange }: Props) {
  const isValid = HEX_RE.test(value);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '120px 50px 110px auto 1fr',
        gap: 12,
        alignItems: 'center',
        marginBottom: 14,
      }}
    >
      <label htmlFor={id} style={{ fontSize: 14 }}>
        <span style={{ marginRight: 6 }}>{emoji}</span>
        {label}
      </label>

      <input
        id={id}
        type="color"
        value={isValid ? value : defaultValue}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 44, height: 32, padding: 0, border: '1px solid #c1c7d0', borderRadius: 3, background: '#fff' }}
      />

      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 13,
          padding: '6px 8px',
          border: `1px solid ${isValid ? '#c1c7d0' : '#de350b'}`,
          borderRadius: 3,
          width: 100,
        }}
      />

      <button
        type="button"
        onClick={() => onChange(defaultValue)}
        title="Reset to default"
        style={{
          fontSize: 12,
          padding: '4px 10px',
          border: '1px solid #c1c7d0',
          background: '#f4f5f7',
          borderRadius: 3,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        Reset
      </button>

      <div
        aria-label={`${label} preview`}
        style={{
          width: 200,
          height: 56,
          padding: '8px 12px',
          background: isValid ? value : defaultValue,
          color: '#172B4D',
          borderRadius: 3,
          border: '1px solid rgba(9,30,66,0.08)',
          boxShadow: '0 1px 1px rgba(9,30,66,0.1)',
          fontSize: 13,
          fontWeight: 500,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        CMMS-1234 — Sample card
      </div>
    </div>
  );
}
