type Props = {
  id: string;
  label: string;
  value: string;
  defaultValue: string;
  onChange: (hex: string) => void;
  /**
   * When true, the component renders only the color controls (color input,
   * hex input, reset button) without its own label. Used inside the Card
   * Colors table where the surrounding `<td>` carries the status label.
   */
  hideLabel?: boolean;
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function ColorPicker({ id, label, value, defaultValue, onChange, hideLabel }: Props) {
  const isValid = HEX_RE.test(value);

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
      }}
    >
      {!hideLabel && (
        <label htmlFor={id} style={{ fontSize: 14, width: 120 }}>
          {label}
        </label>
      )}

      <input
        id={id}
        type="color"
        value={isValid ? value : defaultValue}
        onChange={(e) => onChange(e.target.value)}
        aria-label={hideLabel ? label : undefined}
        style={{ width: 44, height: 32, padding: 0, border: '1px solid #c1c7d0', borderRadius: 3, background: '#fff' }}
      />

      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        aria-label={hideLabel ? `${label} hex value` : undefined}
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
    </div>
  );
}
