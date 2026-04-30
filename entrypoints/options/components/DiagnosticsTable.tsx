import type { ReactElement } from 'react';
import type { DiagnosticsResponse, ProbeResult, ProbeStatus } from '../../../lib/messages';

/**
 * Per-scope diagnostics table for the options-page Test connection button
 * (v0.3.3+). Renders one row per probe in a fixed CSS-grid layout (3 columns:
 * status badge | label + endpoint | scope id + detail). Pure presentational —
 * no side-effects, no fetches; reads the response shape returned by the
 * worker's RUN_DIAGNOSTICS handler.
 *
 * Visibility: when `diagnostics === null` the component renders nothing —
 * this lets the options page mount the table unconditionally and have it
 * pop into view only after the user clicks Test connection.
 *
 * SECURITY: detail strings come from the worker, which strips token / URL
 * material before returning. This component never echoes anything from the
 * candidate credentials directly.
 */

type Props = {
  diagnostics: DiagnosticsResponse | null;
};

/**
 * Static probe-id → human-readable label map. Keeps the four user-visible
 * strings in the options bundle (where this component ships) instead of
 * leaning on the worker-provided `probe.label`. Labels here win over the
 * worker-supplied label so a future worker change can't silently retitle
 * the rows. Keys here are the canonical row labels:
 *
 *   - 'connection'  → 'Account access'         (read:user:bitbucket)
 *   - 'pullrequest' → 'Pull request data'      (read:pullrequest:bitbucket)
 *   - 'repository'  → 'Repository access'      (read:repository:bitbucket)
 *   - 'workspace'   → 'Workspace members'      (read:workspace:bitbucket)
 */
const PROBE_LABELS: Record<ProbeResult['id'], string> = {
  connection: 'Account access',
  pullrequest: 'Pull request data',
  repository: 'Repository access',
  workspace: 'Workspace members',
};

const PASS_BG = '#f0fdf4';
const FAIL_BG = '#fef2f2';
const SKIP_BG = '#f9fafb';
const PASS_FG = '#16a34a';
const FAIL_FG = '#dc2626';
const SKIP_FG = '#6b7280';

const TOKEN_HELP_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

export function DiagnosticsTable({ diagnostics }: Props): ReactElement | null {
  if (diagnostics === null) return null;

  if (diagnostics.ok === false) {
    return (
      <div
        role="status"
        style={{
          marginTop: 12,
          padding: '8px 12px',
          background: FAIL_BG,
          border: '1px solid #fecaca',
          borderRadius: 4,
          color: '#7f1d1d',
          fontSize: 13,
        }}
      >
        ✗ Diagnostics error: {diagnostics.error}
      </div>
    );
  }

  const results = diagnostics.results;
  const passCount = results.filter((r) => r.status === 'pass').length;
  const failCount = results.filter((r) => r.status === 'fail').length;
  const skipCount = results.filter((r) => r.status === 'skipped').length;
  const allPassed = passCount === results.length;
  const anyScopeFailed = results.some(
    (r) => r.status === 'fail' && r.detail !== undefined && r.detail.includes('scope'),
  );

  return (
    <details open style={detailsStyle}>
      <summary style={summaryStyle}>
        Diagnostics results ({results.length} probes)
      </summary>
      <div role="table" aria-label="Diagnostics results" style={tableStyle}>
        {results.map((r) => (
          <DiagnosticsRow key={r.id} probe={r} />
        ))}
      </div>
      <div style={{ marginTop: 12, fontSize: 13, color: '#172B4D' }}>
        {allPassed ? (
          <span style={{ color: PASS_FG, fontWeight: 600 }}>
            ✓ All checks passed — every required scope is granted.
          </span>
        ) : (
          <>
            <span>
              {passCount} of {results.length} passed
              {failCount > 0 ? ` · ${failCount} failed` : ''}
              {skipCount > 0 ? ` · ${skipCount} skipped` : ''}
            </span>
            {anyScopeFailed && (
              <p style={{ margin: '6px 0 0', fontSize: 12, color: '#5e6c84' }}>
                Regenerate the token at{' '}
                <a href={TOKEN_HELP_URL} target="_blank" rel="noopener noreferrer">
                  id.atlassian.com/manage-profile/security/api-tokens
                </a>{' '}
                with all four scopes.
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}

function DiagnosticsRow({ probe }: { probe: ProbeResult }): ReactElement {
  const colors = paletteFor(probe.status);
  return (
    <div
      role="row"
      style={{
        display: 'grid',
        gridTemplateColumns: '36px 1fr 1.4fr',
        alignItems: 'start',
        gap: 12,
        padding: '10px 12px',
        background: colors.bg,
        borderTop: '1px solid #e5e7eb',
      }}
    >
      <span
        role="cell"
        aria-label={probe.status}
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: colors.fg,
          lineHeight: 1.2,
        }}
      >
        {iconFor(probe.status)}
      </span>
      <div role="cell" style={{ fontSize: 13, color: '#172B4D' }}>
        <div style={{ fontWeight: 600 }}>{PROBE_LABELS[probe.id] ?? probe.label}</div>
        <code style={{ fontSize: 12, color: '#5e6c84' }}>{probe.endpoint}</code>
      </div>
      <div role="cell" style={{ fontSize: 13, color: '#172B4D' }}>
        {probe.scope ? (
          <code style={{ fontSize: 12, color: '#172B4D' }}>{probe.scope}</code>
        ) : null}
        {probe.detail ? (
          <div style={{ marginTop: 4, fontSize: 12, color: colors.fg }}>
            {probe.detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function paletteFor(status: ProbeStatus): { bg: string; fg: string } {
  switch (status) {
    case 'pass':
      return { bg: PASS_BG, fg: PASS_FG };
    case 'fail':
      return { bg: FAIL_BG, fg: FAIL_FG };
    case 'skipped':
    default:
      return { bg: SKIP_BG, fg: SKIP_FG };
  }
}

function iconFor(status: ProbeStatus): string {
  switch (status) {
    case 'pass':
      return '✓';
    case 'fail':
      return '✗';
    case 'skipped':
    default:
      return '⊘';
  }
}

const detailsStyle: React.CSSProperties = {
  marginTop: 12,
  border: '1px solid #e5e7eb',
  borderRadius: 4,
  background: '#ffffff',
  overflow: 'hidden',
};

const summaryStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: 13,
  fontWeight: 600,
  color: '#172B4D',
  cursor: 'pointer',
  background: '#f4f5f7',
};

const tableStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
};
