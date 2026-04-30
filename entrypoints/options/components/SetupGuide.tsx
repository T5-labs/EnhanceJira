/**
 * First-run onboarding card.
 *
 * Walks a brand-new user through generating a Bitbucket API token in 8
 * steps. Renders prominently at the top of the options page when not
 * connected; tucked into a `<details>` disclosure once credentials are
 * saved (so users can re-reference the walkthrough if they need to
 * regenerate a token later).
 *
 * Also exposes:
 *  - A "Still getting 401?" troubleshooting panel below the steps for
 *    users who followed the walkthrough but still hit auth failures.
 *  - A collapsible "Alternative: use a Bitbucket app password" section
 *    for tenants where API token provisioning is blocked or delayed.
 *
 * Plain React, no new deps. Inline styles to match the rest of the
 * options page (which uses inline styles per Phase 2).
 */

import { useState } from 'react';

const TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
const APP_PASSWORD_URL = 'https://bitbucket.org/account/settings/app-passwords/';

const inlineCodeStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '1px 6px',
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontSize: 12,
  background: '#e0f2fe',
  color: '#0c4a6e',
  border: '1px solid #bae6fd',
  borderRadius: 3,
  lineHeight: 1.4,
};

const scopeLabelRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
  marginBottom: 6,
};

// Click-to-copy scope chip — looks like an inline `<code>` chip when idle,
// flips to a green "✓ Copied" state for 1.5s after a successful copy.
const copyableScopeStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 6px',
  margin: 0,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontSize: 12,
  lineHeight: 1.4,
  background: '#e0f2fe',
  color: '#0c4a6e',
  border: '1px solid #bae6fd',
  borderRadius: 4,
  cursor: 'pointer',
  transition: 'background-color 150ms, color 150ms, border-color 150ms',
  // Strip default button chrome
  appearance: 'none',
  WebkitAppearance: 'none',
};

const copyableScopeHoverStyle: React.CSSProperties = {
  background: '#bae6fd',
  borderColor: '#7dd3fc',
};

const copyableScopeCopiedStyle: React.CSSProperties = {
  background: '#dcfce7',
  color: '#14532d',
  borderColor: '#86efac',
};

type Step = {
  title: string;
  body: React.ReactNode;
  cta?: { label: string; href: string };
};

const STEPS: Step[] = [
  {
    title: 'Open the Atlassian API tokens page',
    body: (
      <>
        You&rsquo;ll generate the token here. No admin access required.
      </>
    ),
    cta: { label: 'Open Atlassian API tokens ↗', href: TOKEN_URL },
  },
  {
    title: 'Click "Create API token with scopes"',
    body: (
      <>
        Important: pick the <strong>&ldquo;with scopes&rdquo;</strong>{' '}
        variant. Plain API tokens (the older simpler kind) won&rsquo;t
        work &mdash; they lack the granular permissions Bitbucket
        requires. The button you want says &ldquo;Create API token with
        scopes&rdquo;.
      </>
    ),
  },
  {
    title: "Pick 'Bitbucket' as the app",
    body: (
      <>
        A dropdown appears asking which app the token is for.{' '}
        <strong>Pick &ldquo;Bitbucket&rdquo;</strong> &mdash; not Jira,
        not Confluence. This is the most-missed step. Tokens issued for
        the wrong app will fail with a 401 &ldquo;Token rejected&rdquo;
        error in the next step.
      </>
    ),
  },
  {
    title: 'Set the longest expiration available',
    body: (
      <>
        After picking Bitbucket, the form asks for an expiration date.{' '}
        <strong>Pick the longest option</strong> Atlassian offers
        (typically 1 year). When the token expires you&rsquo;ll have to
        redo this flow &mdash; picking the maximum keeps you connected
        as long as possible.
      </>
    ),
  },
  {
    title: 'Grant these scopes',
    body: (
      <>
        Select exactly these four scopes (Atlassian shows them as
        checkbox labels):
        <div style={scopeLabelRowStyle}>
          <span aria-hidden style={{ fontSize: 14 }}>☑</span>
          <strong style={{ fontSize: 14 }}>
            View Bitbucket account information
          </strong>
          <CopyableScope value="read:user:bitbucket" />
        </div>
        <div style={scopeLabelRowStyle}>
          <span aria-hidden style={{ fontSize: 14 }}>☑</span>
          <strong style={{ fontSize: 14 }}>View pull requests</strong>
          <CopyableScope value="read:pullrequest:bitbucket" />
        </div>
        <div style={scopeLabelRowStyle}>
          <span aria-hidden style={{ fontSize: 14 }}>☑</span>
          <strong style={{ fontSize: 14 }}>View repositories</strong>
          <CopyableScope value="read:repository:bitbucket" />
        </div>
        <div style={scopeLabelRowStyle}>
          <span aria-hidden style={{ fontSize: 14 }}>☑</span>
          <strong style={{ fontSize: 14 }}>View workspaces</strong>
          <CopyableScope value="read:workspace:bitbucket" />
        </div>
        If you only see scope IDs and not human labels, you&rsquo;re on
        the right page &mdash; check the boxes whose IDs match those
        above.
        <br />
        No write scopes needed &mdash; the extension only reads.
      </>
    ),
  },
  {
    title: 'Copy the token',
    body: (
      <>
        Atlassian shows the token only once. Copy it before navigating
        away from the page. If you accidentally close the page first,
        you&rsquo;ll need to start over with a new token.
      </>
    ),
  },
  {
    title: 'Paste it below ↓',
    body: (
      <>
        <strong>Username field</strong>: your Atlassian email address
        (the email you log into Jira with &mdash; e.g.{' '}
        <code style={inlineCodeStyle}>you@company.com</code>).
        <br />
        <strong>Token field</strong>: the token you just copied.
        <br />
        Click <strong>Test connection</strong> to verify. A green
        checkmark means you&rsquo;re connected; a red &times; with{' '}
        <code style={inlineCodeStyle}>(401)</code> means the username or
        token is wrong, or the token was created without the right
        app/scopes.
      </>
    ),
  },
  {
    title: 'Set your workspace slug',
    body: (
      <>
        Now that you&rsquo;re connected, set your{' '}
        <strong>Bitbucket workspace slug</strong> in the field above
        (Approval rules &rarr; Workspace slug). It&rsquo;s required for
        the Required approvers search and for the workspace-scan PR
        fallback. Find your workspace slug on{' '}
        <code style={inlineCodeStyle}>bitbucket.org</code> after login:
        it&rsquo;s the segment between{' '}
        <code style={inlineCodeStyle}>bitbucket.org/</code> and the next
        slash in any Bitbucket URL (e.g.{' '}
        <code style={inlineCodeStyle}>
          bitbucket.org/your-workspace/your-repo
        </code>{' '}
        &rarr;{' '}
        <code style={inlineCodeStyle}>your-workspace</code>). Then click{' '}
        <strong>Save</strong>.
      </>
    ),
  },
];

type AltStep = {
  title: string;
  body: React.ReactNode;
  cta?: { label: string; href: string };
};

const ALT_STEPS: AltStep[] = [
  {
    title: 'Open the Bitbucket app passwords page',
    body: (
      <>
        Bitbucket&rsquo;s legacy app password flow lives here.
      </>
    ),
    cta: {
      label: 'Open Bitbucket app passwords ↗',
      href: APP_PASSWORD_URL,
    },
  },
  {
    title: 'Click "Create app password"',
    body: (
      <>
        Label it <strong>&ldquo;EnhanceJira&rdquo;</strong> so you can
        identify it later.
      </>
    ),
  },
  {
    title: 'Grant these permissions',
    body: (
      <>
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          <li>
            <strong>Account</strong>: Read
          </li>
          <li>
            <strong>Pull requests</strong>: Read
          </li>
          <li>
            <strong>Repositories</strong>: Read
          </li>
        </ul>
      </>
    ),
  },
  {
    title: 'Copy the app password',
    body: (
      <>
        Like API tokens, the password is shown only once.
      </>
    ),
  },
  {
    title: 'Paste below',
    body: (
      <>
        <strong>Username field</strong>: your Bitbucket{' '}
        <strong>USERNAME</strong> (NOT email &mdash; app passwords use
        the Bitbucket username; you can find yours at the top of
        bitbucket.org after logging in, or in{' '}
        <code style={inlineCodeStyle}>
          bitbucket.org/account/settings/
        </code>
        ).
        <br />
        <strong>Token field</strong>: the app password you just copied.
        <br />
        Click <strong>Test connection</strong>. A green checkmark
        confirms the alternative path works.
      </>
    ),
  },
];

type Props = {
  /**
   * When true, strip the outer card chrome (background, border, padding) and
   * the leading heading so this component renders inline as plain content.
   * Used when embedded inside `ConnectedCard`'s collapsible disclosure where
   * the parent already provides the card framing and a summary label.
   */
  embedded?: boolean;
};

export function SetupGuide({ embedded = false }: Props = {}) {
  return (
    <section
      aria-labelledby="ej-setup-guide-heading"
      style={embedded ? embeddedSectionStyle : cardStyle}
    >
      {!embedded && (
        <h2 id="ej-setup-guide-heading" style={headingStyle}>
          Get started &mdash; Connect Bitbucket in 8 steps
        </h2>
      )}
      <ol style={listStyle}>
        {STEPS.map((step, index) => (
          <li key={index} style={itemStyle}>
            <NumberBadge n={index + 1} />
            <div style={itemBodyStyle}>
              <div style={stepTitleStyle}>{step.title}</div>
              <div style={stepBodyStyle}>{step.body}</div>
              {step.cta && (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    onClick={() =>
                      window.open(
                        step.cta!.href,
                        '_blank',
                        'noopener,noreferrer',
                      )
                    }
                    aria-label={step.cta.label}
                    style={ctaButtonStyle}
                  >
                    {step.cta.label}
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>

      {/* Troubleshooting panel */}
      <div style={troubleshootBoxStyle} role="note">
        <div style={troubleshootHeaderStyle}>
          <span aria-hidden="true" style={{ marginRight: 6 }}>
            &#9432;
          </span>
          Still getting 401 (&ldquo;Token rejected&rdquo;) after
          following these steps?
        </div>
        <div style={{ marginTop: 6 }}>Common causes:</div>
        <ul style={troubleshootListStyle}>
          <li>
            Token created without picking &ldquo;Bitbucket&rdquo; in the
            app dropdown (step 3)
          </li>
          <li>
            Wrong scopes granted &mdash; you need ALL FOUR:{' '}
            <strong>&ldquo;View Bitbucket account information&rdquo;</strong>{' '}
            (<CopyableScope value="read:user:bitbucket" />),{' '}
            <strong>&ldquo;View pull requests&rdquo;</strong> (
            <CopyableScope value="read:pullrequest:bitbucket" />),{' '}
            <strong>&ldquo;View repositories&rdquo;</strong> (
            <CopyableScope value="read:repository:bitbucket" />), AND{' '}
            <strong>&ldquo;View workspaces&rdquo;</strong> (
            <CopyableScope value="read:workspace:bitbucket" />). Missing
            any one will cause partial failures: missing account scope
            &rarr; 403 on Test connection; missing repository scope
            &rarr; no build-status badges in tooltips and any fallback
            PR-finding paths will fail; missing pullrequest scope
            &rarr; no PR data at all; missing workspace scope &rarr;
            Required approvers search can&rsquo;t fetch workspace
            members.
          </li>
          <li>
            Username field contains your Bitbucket username instead of
            your Atlassian email
          </li>
          <li>
            Trailing whitespace from copy/paste &mdash; clear the field
            with Cmd+A then Backspace, paste again
          </li>
        </ul>
        <div style={{ marginTop: 6 }}>
          If the token still won&rsquo;t authenticate, your tenant may
          have API token provisioning delays or org policies blocking
          new tokens. Use the alternative path below.
        </div>
      </div>

      {/* Alternative: app password */}
      <details style={altDetailsStyle}>
        <summary style={altSummaryStyle}>
          Alternative: use a Bitbucket app password (works without
          admin, no Atlassian token needed)
        </summary>
        <div style={altBodyStyle}>
          <p style={altIntroStyle}>
            Bitbucket Cloud&rsquo;s legacy &ldquo;app password&rdquo;
            flow still works on most enterprise tenants and uses a
            different identity than the API token path:
          </p>
          <ol style={altListStyle}>
            {ALT_STEPS.map((step, index) => (
              <li key={index} style={itemStyle}>
                <SmallNumberBadge n={index + 1} />
                <div style={itemBodyStyle}>
                  <div style={altStepTitleStyle}>{step.title}</div>
                  <div style={stepBodyStyle}>{step.body}</div>
                  {step.cta && (
                    <div style={{ marginTop: 6 }}>
                      <button
                        type="button"
                        onClick={() =>
                          window.open(
                            step.cta!.href,
                            '_blank',
                            'noopener,noreferrer',
                          )
                        }
                        aria-label={step.cta.label}
                        style={altCtaButtonStyle}
                      >
                        {step.cta.label}
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <p style={altNoteStyle}>
            <strong>Bonus:</strong> app passwords don&rsquo;t expire
            &mdash; they last until you manually revoke them in
            Bitbucket settings. (Atlassian has announced eventual
            deprecation of app passwords in favor of API tokens, but
            for now both paths work and app passwords don&rsquo;t need
            yearly renewal.)
          </p>
        </div>
      </details>
    </section>
  );
}

function NumberBadge({ n }: { n: number }) {
  return (
    <span aria-hidden="true" style={badgeStyle}>
      {n}
    </span>
  );
}

function SmallNumberBadge({ n }: { n: number }) {
  return (
    <span aria-hidden="true" style={smallBadgeStyle}>
      {n}
    </span>
  );
}

function CopyableScope({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState(false);
  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API failed; no-op for now (user can still select-and-copy)
    }
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      title="Click to copy"
      aria-label={
        copied ? `Copied ${value} to clipboard` : `Copy ${value} to clipboard`
      }
      style={{
        ...copyableScopeStyle,
        ...(hover && !copied ? copyableScopeHoverStyle : {}),
        ...(copied ? copyableScopeCopiedStyle : {}),
      }}
    >
      {copied ? '✓ Copied' : value}
    </button>
  );
}

// ─── Inline styles ───────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  marginBottom: 28,
  padding: 20,
  border: '1px solid #bae6fd',
  borderRadius: 4,
  background: '#f0f9ff',
};

// When `embedded`, parent component (e.g. ConnectedCard) already provides the
// card framing — render as plain content with no background/border/padding.
const embeddedSectionStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  border: 'none',
  background: 'transparent',
};

const headingStyle: React.CSSProperties = {
  fontSize: 16,
  margin: '0 0 16px',
  color: '#172B4D',
};

const listStyle: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const itemStyle: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  alignItems: 'flex-start',
};

const itemBodyStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const badgeStyle: React.CSSProperties = {
  flex: '0 0 auto',
  width: 24,
  height: 24,
  borderRadius: '50%',
  background: '#0ea5e9',
  color: '#fff',
  fontSize: 13,
  fontWeight: 600,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 1,
};

const smallBadgeStyle: React.CSSProperties = {
  flex: '0 0 auto',
  width: 20,
  height: 20,
  borderRadius: '50%',
  background: '#64748b',
  color: '#fff',
  fontSize: 11,
  fontWeight: 600,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 1,
};

const stepTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: '#172B4D',
  marginBottom: 2,
};

const altStepTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#172B4D',
  marginBottom: 2,
};

const stepBodyStyle: React.CSSProperties = {
  fontSize: 13,
  color: '#42526e',
  lineHeight: 1.5,
};

const ctaButtonStyle: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 13,
  fontWeight: 600,
  background: '#0052cc',
  color: '#fff',
  border: '1px solid #0052cc',
  borderRadius: 3,
  cursor: 'pointer',
};

const altCtaButtonStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  fontWeight: 600,
  background: '#fff',
  color: '#0052cc',
  border: '1px solid #0052cc',
  borderRadius: 3,
  cursor: 'pointer',
};

const troubleshootBoxStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 12,
  border: '1px solid #e5e7eb',
  borderRadius: 4,
  background: '#f9fafb',
  fontSize: 12,
  color: '#42526e',
  lineHeight: 1.5,
};

const troubleshootHeaderStyle: React.CSSProperties = {
  fontWeight: 600,
  color: '#172B4D',
};

const troubleshootListStyle: React.CSSProperties = {
  margin: '4px 0 0',
  paddingLeft: 18,
};

const altDetailsStyle: React.CSSProperties = {
  marginTop: 12,
  padding: '8px 12px',
  border: '1px solid #e5e7eb',
  borderRadius: 4,
  background: '#fff',
};

const altSummaryStyle: React.CSSProperties = {
  fontSize: 13,
  fontStyle: 'italic',
  color: '#475569',
  cursor: 'pointer',
  listStyle: 'revert',
};

const altBodyStyle: React.CSSProperties = {
  marginTop: 10,
  paddingTop: 10,
  borderTop: '1px solid #e5e7eb',
};

const altIntroStyle: React.CSSProperties = {
  margin: '0 0 10px',
  fontSize: 12,
  color: '#42526e',
  lineHeight: 1.5,
};

const altListStyle: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const altNoteStyle: React.CSSProperties = {
  margin: '12px 0 0',
  padding: 8,
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: 3,
  fontSize: 11,
  color: '#64748b',
  lineHeight: 1.5,
  fontStyle: 'italic',
};
