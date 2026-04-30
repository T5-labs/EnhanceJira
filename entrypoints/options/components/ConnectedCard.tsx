/**
 * Positive success card shown at the top of the options page when the saved
 * Bitbucket credentials authenticate cleanly (`isConnected === true`).
 *
 * This replaces the previous "the help just disappeared" UX where successful
 * connection only surfaced as a small inline status row inside the credentials
 * section. The green success card mirrors the position the blue `SetupGuide`
 * occupies when disconnected, so the user gets a clear "you're all set!"
 * indicator at the same focal point.
 *
 * The 6-step API token walkthrough still lives here, but tucked into a
 * `<details>` disclosure for users who need to reconnect or rotate their
 * token — it renders the same `<SetupGuide />` component used in the
 * disconnected flow, passed `embedded` so the inner blue card chrome is
 * stripped (avoids the awkward card-within-a-card look).
 *
 * Pure presentational — no state, no side effects beyond firing the optional
 * `onShowSetup` callback when the disclosure opens.
 *
 * SECURITY: never renders the API token. Username and display name come from
 * the validated `GET_CONNECTION_STATUS` response shape, which by contract
 * (see lib/auth.ts → TestConnectionResult) does not include the token.
 */

import { SetupGuide } from './SetupGuide';

type Props = {
  /** Canonical Bitbucket username from the API (e.g. "alex_arbuckle"). */
  username: string;
  /** Display name from the API, if available. Falls back to the username. */
  displayName?: string;
  /**
   * Fired when the user opens the "Need to reconnect?" disclosure. Pure
   * telemetry hook — pass a noop if not needed.
   */
  onShowSetup: () => void;
};

export function ConnectedCard({ username, displayName, onShowSetup }: Props) {
  return (
    <section
      aria-labelledby="ej-connected-card-heading"
      style={cardStyle}
    >
      <h2 id="ej-connected-card-heading" style={headingStyle}>
        <span aria-hidden="true" style={checkGlyphStyle}>
          ✓
        </span>
        Connected to Bitbucket
      </h2>
      <p style={bodyStyle}>
        Authenticated as{' '}
        {displayName ? (
          <>
            <strong>{displayName}</strong> (
            <code style={usernameChipStyle}>@{username}</code>)
          </>
        ) : (
          <code style={usernameChipStyle}>@{username}</code>
        )}
        . EnhanceJira will color cards in your Review column when you visit a
        Jira board.
      </p>

      <details
        style={detailsStyle}
        onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open) {
            onShowSetup();
          }
        }}
      >
        <summary style={summaryStyle}>
          Need to reconnect or use a different token?
        </summary>
        <div style={disclosureBodyStyle}>
          <SetupGuide embedded />
        </div>
      </details>
    </section>
  );
}

// ─── Inline styles ───────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  marginBottom: 28,
  padding: '24px 28px',
  border: '1px solid #86efac',
  borderRadius: 8,
  background: '#f0fdf4',
};

const headingStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 16,
  fontWeight: 600,
  margin: '0 0 8px',
  color: '#172B4D',
};

const checkGlyphStyle: React.CSSProperties = {
  color: '#16a34a',
  fontWeight: 700,
};

const bodyStyle: React.CSSProperties = {
  margin: '0 0 12px',
  fontSize: 13,
  color: '#42526e',
  lineHeight: 1.5,
};

const usernameChipStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 6px',
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontSize: 12,
  background: '#dcfce7',
  color: '#14532d',
  borderRadius: 3,
  lineHeight: 1.4,
};

const detailsStyle: React.CSSProperties = {
  marginTop: 8,
};

const summaryStyle: React.CSSProperties = {
  fontSize: 13,
  fontStyle: 'italic',
  color: '#475569',
  cursor: 'pointer',
  listStyle: 'revert',
};

const disclosureBodyStyle: React.CSSProperties = {
  marginTop: 12,
  paddingTop: 12,
  borderTop: '1px solid #bbf7d0',
};
