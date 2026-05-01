import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react';
import {
  BRANCH_CARD_AVATAR_CAP_MAX,
  BRANCH_CARD_AVATAR_CAP_MIN,
  DEFAULT_CREDENTIALS,
  DEFAULT_SETTINGS,
  MIN_APPROVALS_MAX,
  MIN_APPROVALS_MIN,
  type Credentials,
  type Settings,
  clearCredentials,
  loadCredentials,
  loadSettings,
  saveCredentials,
  saveSettings,
} from '../../lib/settings';
import {
  parseAndValidateSettings,
  serializeSettings,
} from '../../lib/settingsIO';
import type { TestConnectionResult } from '../../lib/auth';
import type { DiagnosticsResponse, Message } from '../../lib/messages';
import { ColorPicker } from './components/ColorPicker';
import { RequiredApproversInput } from './components/RequiredApproversInput';
import { SetupGuide } from './components/SetupGuide';
import { ConnectedCard } from './components/ConnectedCard';
import { DiagnosticsTable } from './components/DiagnosticsTable';

const MAX_CONTENT_WIDTH = '880px';

type ToastKind = 'success' | 'error';
type Toast = { kind: ToastKind; message: string } | null;

// Status of the SAVED credentials (separate from the candidate-form Test button).
type ConnectionStatus =
  | { kind: 'loading' }
  | { kind: 'result'; result: TestConnectionResult };

// Result of the most recent Test-connection click against the candidate form values.
type TestResult =
  | { kind: 'idle' }
  | { kind: 'error'; message: string }
  | { kind: 'response'; result: TestConnectionResult };

// Per-field validation state — drives border color, text tint, and adjacent
// ✓/✗/⟳ icon on the username and token inputs. Derived (never written
// directly) from `testing` + `testResult` + `status` + the form credentials.
type FieldValidation = 'idle' | 'testing' | 'valid' | 'invalid';

async function sendMessage<M extends Message>(
  message: M,
): Promise<TestConnectionResult> {
  // NB: TEST_CONNECTION carries credentials. The worker's response shape never
  // contains the token (see lib/auth.ts), so it is safe to surface in UI.
  return (await browser.runtime.sendMessage(message)) as TestConnectionResult;
}

async function sendDiagnosticsMessage(
  credentials: Credentials,
  workspaceSlug: string,
): Promise<DiagnosticsResponse> {
  // NB: RUN_DIAGNOSTICS carries credentials. The worker's response shape never
  // contains the token (see entrypoints/background.ts → runDiagnostics), so
  // the result is safe to surface in UI.
  return (await browser.runtime.sendMessage({
    type: 'RUN_DIAGNOSTICS',
    credentials,
    workspaceSlug,
  })) as DiagnosticsResponse;
}

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [credentials, setCredentials] = useState<Credentials>(DEFAULT_CREDENTIALS);
  const [loaded, setLoaded] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const [status, setStatus] = useState<ConnectionStatus>({ kind: 'loading' });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult>({ kind: 'idle' });
  // Per-scope diagnostics result from the most recent Test connection click.
  // null = not yet run. Populated after the worker returns; the table component
  // renders nothing while this is null so the page doesn't reserve empty space.
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
  // Snapshot of credentials (a) the last time Test connection was clicked, and
  // (b) the most recently persisted save. Used to determine whether the
  // current form values still match the values that produced the last
  // test/save result — if Alex edits the field after a green ✓, the green
  // should clear back to idle since he's now editing something untested.
  const [lastTestedCredentials, setLastTestedCredentials] =
    useState<Credentials | null>(null);
  const [savedCredentials, setSavedCredentials] =
    useState<Credentials | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [disconnectHover, setDisconnectHover] = useState(false);
  const [disconnectFocus, setDisconnectFocus] = useState(false);
  // Hover state for the inline test-connection icon button (trailing
  // adornment on the API token input). Drives a slight darken on hover.
  const [testIconHover, setTestIconHover] = useState(false);
  // Sticky "tried-to-save with empty workspaceSlug" flag — once the user
  // hits Save with the field blank, the red border + inline error appear
  // until the field becomes non-empty (then the flag clears on its own via
  // the derived `workspaceSlugMissing` below).
  const [triedSaveWithoutWorkspace, setTriedSaveWithoutWorkspace] =
    useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceSlugInputRef = useRef<HTMLInputElement | null>(null);
  // Pending auto-test debounce timer. Cleared on unmount, on every keystroke,
  // and on manual icon click so we never double-fire.
  const autoTestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest credentials in a ref so the debounced timeout body always sees the
  // current values without re-creating the timer on every keystroke.
  const credentialsRef = useRef<Credentials>(credentials);
  credentialsRef.current = credentials;

  // Read the manifest version once at mount so the header bar can show
  // the title with a muted "v<version>" pill next to it (matching the
  // popup card). Falls back gracefully if the API is unavailable.
  const manifestVersion = useMemo(() => {
    try {
      return browser.runtime.getManifest().version;
    } catch {
      return '';
    }
  }, []);

  // Hover state for the GitHub icon link in the header — drives a subtle
  // background highlight so it visually matches the test-icon button hover.
  const [githubIconHover, setGithubIconHover] = useState(false);

  const refreshStatus = useCallback(async () => {
    setStatus({ kind: 'loading' });
    try {
      const result = await sendMessage({ type: 'GET_CONNECTION_STATUS' });
      setStatus({ kind: 'result', result });
    } catch {
      setStatus({
        kind: 'result',
        result: {
          ok: false,
          status: 0,
          error: 'Could not reach the background worker.',
        },
      });
    }
  }, []);

  // Initial load — settings + credentials in parallel, then status.
  useEffect(() => {
    let alive = true;
    Promise.all([loadSettings(), loadCredentials()])
      .then(([s, c]) => {
        if (!alive) return;
        setSettings(s);
        setCredentials(c);
        // Track what's actually persisted so per-field validation can drop
        // back to idle the moment the user edits away from the saved values.
        setSavedCredentials(c);
        setLoaded(true);
        // Fire-and-forget; refreshStatus owns its own state updates.
        void refreshStatus();
      })
      .catch(() => {
        if (!alive) return;
        setLoaded(true);
        setToast({ kind: 'error', message: 'Failed to load saved settings.' });
      });
    return () => {
      alive = false;
    };
  }, [refreshStatus]);

  // Auto-dismiss toast after a few seconds.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const minApprovalsInvalid =
    !Number.isFinite(settings.minApprovals) ||
    settings.minApprovals < MIN_APPROVALS_MIN ||
    settings.minApprovals > MIN_APPROVALS_MAX;

  // Required (v0.3.1+). Drives the field's red border (sticky after a
  // tried-save) + inline error, and the search-disabled hint inside
  // RequiredApproversInput.
  const workspaceSlugMissing = settings.workspaceSlug.trim() === '';

  // Single source of truth for whether to show the SetupGuide prominently
  // (not connected) or tucked into a `<details>` disclosure (connected).
  // We rely on the status from GET_CONNECTION_STATUS, which is the same
  // signal the ConnectionStatusRow renders — keeps the two views in lock-step.
  const isConnected =
    status.kind === 'result' && status.result.ok === true;

  // ── Per-field validation state ────────────────────────────────────────
  // Drives the username + token inputs' border + text color + adjacent icon.
  // Single derived value (both fields share the same state — the credentials
  // are only meaningful as a pair) computed via the priority order spelled
  // out in the spec:
  //   1. Test connection in flight                       → 'testing'
  //   2. Recent test result, form still matches tested   → 'valid' / 'invalid'
  //   3. Saved-credentials connection status resolved
  //        + form still matches saved                    → 'valid' / 'invalid'
  //   4. Otherwise                                       → 'idle'
  // Empty fields force 'idle' — never leave a green tint on a blank input.
  const validationState: FieldValidation = useMemo(() => {
    const u = credentials.username.trim();
    const t = credentials.token;
    if (!u || !t) {
      // Special case: testing in flight wins regardless (the user just
      // clicked Test) — but otherwise an empty pair is always idle.
      if (testing) return 'testing';
      return 'idle';
    }
    if (testing) return 'testing';

    const formMatches = (other: Credentials | null): boolean =>
      other !== null &&
      other.username === credentials.username &&
      other.token === credentials.token;

    if (testResult.kind === 'response' && formMatches(lastTestedCredentials)) {
      return testResult.result.ok ? 'valid' : 'invalid';
    }
    if (testResult.kind === 'error' && formMatches(lastTestedCredentials)) {
      return 'invalid';
    }

    if (status.kind === 'result') {
      if (status.result.ok && formMatches(savedCredentials)) {
        return 'valid';
      }
      if (!status.result.ok) {
        // Don't paint red on an empty/never-saved form. The "Not connected"
        // soft-error path (status 0 + "Not connected" message) is treated
        // as idle so a fresh-install user doesn't see a red strike-through.
        const r = status.result;
        const isUnconfigured =
          r.status === 0 && typeof r.error === 'string' && r.error.startsWith('Not connected');
        if (!isUnconfigured && formMatches(savedCredentials)) {
          return 'invalid';
        }
      }
    }

    return 'idle';
  }, [
    credentials,
    testing,
    testResult,
    lastTestedCredentials,
    status,
    savedCredentials,
  ]);

  // ─── Save handler shared by the form's onSubmit and the footer Save button ─
  // The footer Save button lives outside <form> so we expose the handler at the
  // App level and bind both surfaces to it.
  const onSave = useCallback(async () => {
    if (saving) return;
    if (minApprovalsInvalid) {
      setToast({ kind: 'error', message: 'Fix the highlighted fields before saving.' });
      return;
    }
    // workspaceSlug is required (v0.3.1+) — empty value blocks the save,
    // surfaces an inline error + red border (sticky until the user fills
    // it in), and steals focus to the field.
    if (settings.workspaceSlug.trim() === '') {
      setTriedSaveWithoutWorkspace(true);
      setToast({
        kind: 'error',
        message: 'Set your Bitbucket workspace slug before saving.',
      });
      workspaceSlugInputRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      await Promise.all([saveSettings(settings), saveCredentials(credentials)]);
      // Snapshot what we just persisted so per-field validation can compare
      // against it (priority-3 in the FieldValidation derivation).
      setSavedCredentials({ ...credentials });
      setToast({ kind: 'success', message: 'Settings saved' });
      // Refresh the status row so the user gets immediate confirmation against
      // the now-saved creds.
      void refreshStatus();
    } catch {
      setToast({ kind: 'error', message: 'Failed to save' });
    } finally {
      setSaving(false);
    }
  }, [
    saving,
    minApprovalsInvalid,
    settings,
    credentials,
    refreshStatus,
  ]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void onSave();
  }

  // ─── Backup / Restore ────────────────────────────────────────────────────

  function onExportSettings() {
    // SECURITY: only the Settings object is serialized — credentials never
    // pass through this path. serializeSettings has no creds parameter.
    const json = serializeSettings(settings);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `enhancejira-settings-${todayIsoDate()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setToast({ kind: 'success', message: 'Settings exported' });
  }

  function onImportClick() {
    setImportError(null);
    const el = importInputRef.current;
    if (el) {
      el.value = '';
      el.click();
    }
  }

  async function onImportFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      setImportError('Could not read the selected file.');
      return;
    }
    const result = parseAndValidateSettings(text);
    if (!result.ok) {
      setImportError(result.error);
      return;
    }
    const ok = window.confirm('Replace current settings with imported file?');
    if (!ok) return;
    try {
      await saveSettings(result.settings);
      setSettings(result.settings);
      setImportError(null);
      setToast({ kind: 'success', message: 'Settings imported' });
    } catch {
      setImportError('Failed to write imported settings to storage.');
    }
  }

  // Auto-test debounce: 600ms after the last keystroke/paste, fire a Test
  // connection — provided the token is "long enough to plausibly auth"
  // (>= 8 chars). Below that we'd just be burning Bitbucket /2.0/user calls
  // on partial input. The icon stays clickable for an explicit re-test.
  const AUTO_TEST_DEBOUNCE_MS = 600;
  const AUTO_TEST_MIN_TOKEN_LENGTH = 8;

  function onTokenChange(nextToken: string) {
    setCredentials({ ...credentials, token: nextToken });
    // Cancel any prior pending auto-test — we always restart the clock.
    if (autoTestTimerRef.current !== null) {
      clearTimeout(autoTestTimerRef.current);
      autoTestTimerRef.current = null;
    }
    // Below the min-length threshold we don't even arm the timer.
    if (nextToken.length < AUTO_TEST_MIN_TOKEN_LENGTH) return;
    if (!credentialsRef.current.username.trim()) return;
    autoTestTimerRef.current = setTimeout(() => {
      autoTestTimerRef.current = null;
      void onTestConnection();
    }, AUTO_TEST_DEBOUNCE_MS);
  }

  // Cancel any pending auto-test on unmount so a stray timeout doesn't try to
  // setState into an unmounted component.
  useEffect(() => {
    return () => {
      if (autoTestTimerRef.current !== null) {
        clearTimeout(autoTestTimerRef.current);
        autoTestTimerRef.current = null;
      }
    };
  }, []);

  async function onTestConnection() {
    if (testing) return;
    // Always clear any pending auto-test so we don't double-fire when the
    // user clicks the icon during the debounce window.
    if (autoTestTimerRef.current !== null) {
      clearTimeout(autoTestTimerRef.current);
      autoTestTimerRef.current = null;
    }
    // Read the freshest credentials via the ref so callers from the debounced
    // path don't get a stale closure value.
    const current = credentialsRef.current;
    if (!current.username.trim() || !current.token) {
      setTestResult({
        kind: 'error',
        message: 'Enter your username and token first.',
      });
      setDiagnostics({
        ok: false,
        error: 'Enter your username and token first.',
      });
      return;
    }
    setTesting(true);
    setTestResult({ kind: 'idle' });
    setDiagnostics(null);
    // Snapshot the credentials we're testing so per-field validation can
    // compare strict equality against the live form values — the green ✓
    // must clear the moment Alex edits either field after a successful test.
    const tested: Credentials = {
      version: current.version,
      username: current.username,
      token: current.token,
    };
    setLastTestedCredentials(tested);
    try {
      const response = await sendDiagnosticsMessage(
        {
          version: 1,
          username: tested.username,
          token: tested.token,
        },
        settings.workspaceSlug,
      );
      setDiagnostics(response);
      // Map the connection probe outcome onto the legacy testResult state so
      // the per-field validation logic (priority-2 in `validationState`) keeps
      // working without forking on the diagnostics shape.
      if (response.ok) {
        const connectionProbe = response.results.find((r) => r.id === 'connection');
        if (connectionProbe && connectionProbe.status === 'pass' && response.username) {
          const synthetic: TestConnectionResult = {
            ok: true,
            username: response.username,
            displayName: response.displayName,
          };
          setTestResult({ kind: 'response', result: synthetic });
        } else if (connectionProbe && connectionProbe.status === 'fail') {
          const isAuthFailure =
            (connectionProbe.detail || '').toLowerCase().includes('token rejected');
          const synthetic: TestConnectionResult = {
            ok: false,
            status: isAuthFailure ? 401 : 0,
            error: connectionProbe.detail || 'Connection probe failed',
          };
          setTestResult({ kind: 'response', result: synthetic });
        } else {
          setTestResult({ kind: 'idle' });
        }
        // Refresh the saved-credentials status row so a successful auth shows
        // the green "Connected as @user" without waiting on a Save click.
        void refreshStatus();
      } else {
        setTestResult({
          kind: 'error',
          message: response.error,
        });
      }
    } catch {
      setTestResult({
        kind: 'error',
        message: 'Could not reach the background worker.',
      });
      setDiagnostics({
        ok: false,
        error: 'Could not reach the background worker.',
      });
    } finally {
      setTesting(false);
    }
  }

  function onResetAll() {
    const ok = window.confirm(
      'Reset all settings to defaults? This wipes saved settings AND your Bitbucket credentials.',
    );
    if (!ok) return;
    setSettings({ ...DEFAULT_SETTINGS });
    setCredentials({ ...DEFAULT_CREDENTIALS });
    // Reset per-field validation memory too — otherwise stale green/red
    // would linger on emptied inputs until the next test/save.
    setLastTestedCredentials(null);
    setTestResult({ kind: 'idle' });
    setDiagnostics(null);
    // Drop the sticky "tried to save without workspace slug" flag too so
    // a fresh-defaults form starts in the neutral state.
    setTriedSaveWithoutWorkspace(false);
  }

  async function onDisconnect() {
    const ok = window.confirm('Disconnect Bitbucket? This wipes your saved username and API token.');
    if (!ok) return;
    try {
      await clearCredentials();
      setCredentials({ ...DEFAULT_CREDENTIALS });
      // Wipe the per-field validation memory so neither input lingers in
      // green/red after a disconnect — both should drop straight to idle.
      setLastTestedCredentials(null);
      setSavedCredentials(null);
      setTestResult({ kind: 'idle' });
      setDiagnostics(null);
      setToast({ kind: 'success', message: 'Bitbucket credentials cleared' });
      // After wipe, the status row should immediately reflect "Not connected".
      void refreshStatus();
    } catch {
      setToast({ kind: 'error', message: 'Failed to clear credentials' });
    }
  }

  if (!loaded) {
    return (
      <div style={pageWrapperStyle}>
        <main style={{ ...mainContentStyle, textAlign: 'center' }}>
          <p>Loading…</p>
        </main>
      </div>
    );
  }

  return (
    <div style={pageWrapperStyle}>
      {/* ── Header bar (sticky top) ─────────────────────────────────────── */}
      <header style={headerBarStyle}>
        <div style={headerInnerStyle}>
          {/* Title + version pair — mirrors the popup card so both surfaces
              read the same: "EnhanceJira" with a muted "v<version>" right
              next to it. Baseline alignment keeps the version sitting on
              the same line as the title regardless of font metrics. */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 8,
            }}
          >
            <span style={{ fontSize: 20, fontWeight: 500, color: '#172B4D' }}>
              EnhanceJira
            </span>
            {manifestVersion && (
              <span style={{ fontSize: '0.75em', color: '#888' }}>
                v{manifestVersion}
              </span>
            )}
          </div>
          {/* GitHub icon link — opens the project repo in a new tab. Inline
              SVG GitHub mark, sized to match the popup's gear icon. Hover
              tracks state to mirror the muted-button visual style used
              elsewhere on the page. */}
          <a
            href="https://github.com/T5-labs/EnhanceJira"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View on GitHub"
            title="View on GitHub"
            onMouseEnter={() => setGithubIconHover(true)}
            onMouseLeave={() => setGithubIconHover(false)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: 4,
              color: githubIconHover ? '#172B4D' : '#5e6c84',
              background: githubIconHover ? '#e5e7eb' : 'transparent',
              textDecoration: 'none',
              transition: 'background-color 120ms ease, color 120ms ease',
            }}
          >
            <svg
              width={22}
              height={22}
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 .5C5.73.5.67 5.56.67 11.83c0 5.02 3.24 9.27 7.74 10.78.57.1.78-.25.78-.55v-1.93c-3.15.69-3.81-1.52-3.81-1.52-.51-1.31-1.26-1.66-1.26-1.66-1.03-.7.08-.69.08-.69 1.14.08 1.74 1.17 1.74 1.17 1.01 1.74 2.66 1.24 3.31.95.1-.74.4-1.24.72-1.53-2.51-.29-5.16-1.26-5.16-5.6 0-1.24.44-2.25 1.16-3.04-.12-.29-.5-1.44.11-3 0 0 .95-.3 3.11 1.16.9-.25 1.87-.38 2.83-.38.96 0 1.93.13 2.83.38 2.16-1.46 3.11-1.16 3.11-1.16.61 1.56.23 2.71.11 3 .72.79 1.16 1.8 1.16 3.04 0 4.35-2.66 5.31-5.18 5.59.41.36.77 1.06.77 2.13v3.16c0 .31.2.66.79.55 4.49-1.51 7.73-5.76 7.73-10.78C23.33 5.56 18.27.5 12 .5z" />
            </svg>
          </a>
        </div>
      </header>

      {/* ── Main content card ───────────────────────────────────────────── */}
      <main style={mainContentStyle}>
        <p style={{ color: '#5e6c84', marginTop: 0, marginBottom: 24, fontSize: 14 }}>
          Configure how Bitbucket PR approval state colors your Jira board cards.
        </p>

        <form id="ej-options-form" onSubmit={onSubmit} noValidate>
          {/* ── Top-of-page connect-state card ────────────────────────────
              Disconnected: blue SetupGuide walkthrough.
              Connected:    green ConnectedCard with the same walkthrough
                            tucked into a <details> disclosure inside it.
              While the initial GET_CONNECTION_STATUS is in flight
              (status.kind === 'loading') we render neither — the inline
              ConnectionStatusRow below shows "Checking connection…" so the
              user still sees activity, and the prominent slot stays empty
              for that brief moment to avoid flashing the disconnected card
              for a connected user. */}
          {status.kind === 'result' &&
            (isConnected && status.result.ok ? (
              <ConnectedCard
                username={status.result.username}
                displayName={status.result.displayName}
                onShowSetup={() => {}}
              />
            ) : (
              <SetupGuide />
            ))}

          {/* ── Bitbucket credentials ─────────────────────────────────── */}
          <Section title="Bitbucket credentials">
            <ConnectionStatusRow status={status} />

            <Field label="Bitbucket username or email" htmlFor="bb-username">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  id="bb-username"
                  type="text"
                  value={credentials.username}
                  onChange={(e) => setCredentials({ ...credentials, username: e.target.value })}
                  autoComplete="off"
                  style={{ ...fieldStyle(validationState), flex: 1 }}
                  aria-invalid={validationState === 'invalid' ? true : undefined}
                />
                {validationIcon(validationState)}
              </div>
            </Field>

            <Field
              label={
                <>
                  Workspace slug{' '}
                  <span aria-hidden="true" style={{ color: '#dc2626' }}>
                    *
                  </span>
                  <span className="sr-only"> (required)</span>
                </>
              }
              htmlFor="workspace-slug"
            >
              <input
                id="workspace-slug"
                ref={workspaceSlugInputRef}
                type="text"
                value={settings.workspaceSlug}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    workspaceSlug: e.target.value,
                  })
                }
                placeholder="your-workspace-slug"
                spellCheck={false}
                aria-required="true"
                aria-label="Workspace slug *"
                aria-invalid={
                  workspaceSlugMissing && triedSaveWithoutWorkspace ? true : undefined
                }
                aria-describedby="workspace-slug-help"
                style={{
                  ...textInputStyle,
                  ...(workspaceSlugMissing && triedSaveWithoutWorkspace
                    ? { borderColor: '#fca5a5' }
                    : {}),
                }}
              />
              {workspaceSlugMissing && triedSaveWithoutWorkspace && (
                <p
                  role="alert"
                  style={{ ...helpStyle, color: '#bf2600' }}
                >
                  Workspace slug is required.
                </p>
              )}
              <p id="workspace-slug-help" style={helpStyle}>
                <strong>Required.</strong> Find your workspace slug at the top of{' '}
                <code>bitbucket.org</code> after login, or in any Bitbucket URL between{' '}
                <code>bitbucket.org/</code> and the next slash (e.g.{' '}
                <code>bitbucket.org/your-workspace/your-repo</code> →{' '}
                <code>your-workspace</code>). The Required approvers search needs this to
                find members.
                {workspaceSlugMissing && !triedSaveWithoutWorkspace && (
                  <>
                    {' '}
                    <span style={{ color: '#5e6c84', fontStyle: 'italic' }}>
                      (required)
                    </span>
                  </>
                )}
              </p>
            </Field>

            <Field label="API token" htmlFor="bb-token">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ ...tokenInputWrapperStyle, flex: 1 }}>
                  <input
                    id="bb-token"
                    type={showToken ? 'text' : 'password'}
                    value={credentials.token}
                    onChange={(e) => onTokenChange(e.target.value)}
                    placeholder="Paste your API token here"
                    autoComplete="off"
                    spellCheck={false}
                    style={{ ...tokenInputFieldStyle(validationState) }}
                    aria-invalid={validationState === 'invalid' ? true : undefined}
                  />
                  <button
                    type="button"
                    onClick={onTestConnection}
                    onMouseEnter={() => setTestIconHover(true)}
                    onMouseLeave={() => setTestIconHover(false)}
                    disabled={testing}
                    title={
                      testing
                        ? 'Testing connection…'
                        : 'Test Bitbucket connection'
                    }
                    aria-label={
                      testing
                        ? 'Testing Bitbucket connection'
                        : 'Test Bitbucket connection'
                    }
                    style={{
                      ...testIconButtonStyle,
                      ...(testIconHover && !testing
                        ? testIconButtonHoverStyle
                        : {}),
                      ...(testing ? { cursor: 'wait' } : {}),
                    }}
                  >
                    {testConnectionIcon(
                      tokenIconState(validationState, credentials.token),
                    )}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  aria-pressed={showToken}
                  style={secondaryButtonStyle}
                >
                  {showToken ? 'Hide' : 'Show'}
                </button>
              </div>
              {testResult.kind === 'error' && (
                <p role="status" style={{ ...helpStyle, color: '#bf2600' }}>
                  {testResult.message}
                </p>
              )}
            </Field>
            <DiagnosticsTable diagnostics={diagnostics} />
          </Section>

          {/* ── Approval Rules ────────────────────────────────────────── */}
          <Section title="Approval Rules">
            {/* Header row: Min approvals (left), Required approvers heading
                (center), Avatar cap (right). The three sit on a single flex
                row above the users table so the section reads as a wide,
                full-width control surface. Wraps to a stacked column on
                narrow viewports. */}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 16,
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <div style={{ flexShrink: 0 }}>
                <label
                  htmlFor="min-approvals"
                  style={{
                    display: 'block',
                    fontSize: 13,
                    fontWeight: 600,
                    marginBottom: 6,
                    color: '#172B4D',
                  }}
                >
                  Minimum Approvals
                </label>
                <input
                  id="min-approvals"
                  type="number"
                  min={MIN_APPROVALS_MIN}
                  max={MIN_APPROVALS_MAX}
                  value={Number.isFinite(settings.minApprovals) ? settings.minApprovals : ''}
                  onChange={(e) => {
                    const next = e.target.value === '' ? NaN : Number(e.target.value);
                    setSettings({ ...settings, minApprovals: next });
                  }}
                  style={{
                    ...textInputStyle,
                    width: 100,
                    borderColor: minApprovalsInvalid ? '#de350b' : '#c1c7d0',
                  }}
                />
                {minApprovalsInvalid && (
                  <p style={{ ...helpStyle, color: '#de350b' }}>
                    must be between {MIN_APPROVALS_MIN} and {MIN_APPROVALS_MAX}
                  </p>
                )}
              </div>

              <div style={{ flexShrink: 0 }}>
                <label
                  htmlFor="branch-card-avatar-cap"
                  style={{
                    display: 'block',
                    fontSize: 13,
                    fontWeight: 600,
                    marginBottom: 6,
                    color: '#172B4D',
                    textAlign: 'right',
                  }}
                >
                  Avatar Cap
                </label>
                <input
                  id="branch-card-avatar-cap"
                  type="number"
                  min={BRANCH_CARD_AVATAR_CAP_MIN}
                  max={BRANCH_CARD_AVATAR_CAP_MAX}
                  step={1}
                  disabled={!settings.expandBranchCardAvatars}
                  value={
                    Number.isFinite(settings.branchCardAvatarCap)
                      ? settings.branchCardAvatarCap
                      : ''
                  }
                  onChange={(e) => {
                    const next =
                      e.target.value === '' ? NaN : Number(e.target.value);
                    setSettings({ ...settings, branchCardAvatarCap: next });
                  }}
                  style={{
                    ...textInputStyle,
                    width: 100,
                    ...(settings.expandBranchCardAvatars
                      ? {}
                      : { opacity: 0.6, cursor: 'not-allowed' }),
                  }}
                />
              </div>
            </div>

            {/* Horizontal divider separating the Min Approvals / Avatar Cap
                header row from the workspace-member search input below. */}
            <hr
              style={{
                border: 'none',
                borderTop: '1px solid #dfe1e6',
                margin: '16px 0',
              }}
            />

            {/* Users table renders full-width below the header row. */}
            <div style={{ marginBottom: 12 }}>
              <RequiredApproversInput
                value={settings.approvers}
                onChange={(next) => setSettings({ ...settings, approvers: next })}
                workspaceSlug={settings.workspaceSlug}
                isConnected={isConnected}
              />
              <p style={helpStyle}>
                Track candidate approvers and toggle which are mandatory. Search
                workspace members above (requires a workspace slug). Each row is
                checked against Bitbucket — ✓ valid, ✗ typo or removed (the toggle
                still works but the user is excluded from the green-gate check).
                Avatar cap controls how many approvers show in the branch-card
                hover popover ({BRANCH_CARD_AVATAR_CAP_MIN}–
                {BRANCH_CARD_AVATAR_CAP_MAX}, includes the 2 Jira already shows).
              </p>
            </div>

            {/* ── Expand branch popover avatars toggle ───────────────────
                Left in the Approval Rules section adjacent to the Avatar cap
                input it gates. The toggle replaces Jira's "+N" overflow chip
                with up to `branchCardAvatarCap` approver avatars. */}
            <div style={{ marginTop: 8 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#172B4D',
                  cursor: 'pointer',
                }}
              >
                <input
                  id="expand-branch-card-avatars"
                  type="checkbox"
                  checked={settings.expandBranchCardAvatars}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      expandBranchCardAvatars: e.target.checked,
                    })
                  }
                />
                Expand branch popover avatars
              </label>
              <p style={helpStyle}>
                When you hover a card's branch indicator, replace Jira's
                "+N" overflow chip with up to {settings.branchCardAvatarCap}{' '}
                approver avatars (approved-first). Disable to leave Jira's
                default popover untouched.
              </p>
            </div>

            {/* ── Only show approvers toggle ────────────────────────────
                Grouped with the Expand toggle above — both are popover-
                rendering settings. When ON, the popover avatar row only
                shows reviewers who have already approved; pending and
                changes-requested reviewers are filtered out. */}
            <div style={{ marginTop: 8 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#172B4D',
                  cursor: 'pointer',
                }}
              >
                <input
                  id="only-show-approvers"
                  type="checkbox"
                  checked={settings.onlyShowApprovers}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      onlyShowApprovers: e.target.checked,
                    })
                  }
                />
                Only show approvers
              </label>
              <p style={helpStyle}>
                Filter the branch popover avatar row to only reviewers who
                have approved. Pending and changes-requested reviewers are
                hidden (and excluded from the "+N" overflow count).
              </p>
            </div>
          </Section>

          {/* ── Card Colors ───────────────────────────────────────────── */}
          <Section title="Card Colors">
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13,
                color: '#172B4D',
              }}
            >
              <thead>
                <tr style={{ borderBottom: '1px solid #dfe1e6', textAlign: 'left' }}>
                  <th style={{ padding: '8px 4px', width: 140, fontWeight: 600 }}>
                    Status
                  </th>
                  <th style={{ padding: '8px 4px', fontWeight: 600 }}>Color</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: '1px solid #f4f5f7' }}>
                  <td style={{ padding: '8px 4px' }}>
                    <label htmlFor="color-green">Approved</label>
                  </td>
                  <td style={{ padding: '8px 4px' }}>
                    <ColorPicker
                      id="color-green"
                      label="Approved"
                      value={settings.colors.green}
                      defaultValue={DEFAULT_SETTINGS.colors.green}
                      onChange={(hex) =>
                        setSettings({ ...settings, colors: { ...settings.colors, green: hex } })
                      }
                      hideLabel
                    />
                  </td>
                </tr>
                <tr style={{ borderBottom: '1px solid #f4f5f7' }}>
                  <td style={{ padding: '8px 4px' }}>
                    <label htmlFor="color-yellow">Partial</label>
                  </td>
                  <td style={{ padding: '8px 4px' }}>
                    <ColorPicker
                      id="color-yellow"
                      label="Partial"
                      value={settings.colors.yellow}
                      defaultValue={DEFAULT_SETTINGS.colors.yellow}
                      onChange={(hex) =>
                        setSettings({ ...settings, colors: { ...settings.colors, yellow: hex } })
                      }
                      hideLabel
                    />
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: '8px 4px' }}>
                    <label htmlFor="color-red">Blocked</label>
                  </td>
                  <td style={{ padding: '8px 4px' }}>
                    <ColorPicker
                      id="color-red"
                      label="Blocked"
                      value={settings.colors.red}
                      defaultValue={DEFAULT_SETTINGS.colors.red}
                      onChange={(hex) =>
                        setSettings({ ...settings, colors: { ...settings.colors, red: hex } })
                      }
                      hideLabel
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </Section>

          {/* ── Backup / Restore ──────────────────────────────────────── */}
          <Section title="Backup / Restore">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button
                type="button"
                onClick={onExportSettings}
                style={{ ...secondaryButtonStyle, display: 'inline-flex', alignItems: 'center', gap: 8 }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                Export
              </button>
              <button
                type="button"
                onClick={onImportClick}
                style={{ ...secondaryButtonStyle, display: 'inline-flex', alignItems: 'center', gap: 8 }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Import
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                onChange={onImportFileChosen}
                style={{ display: 'none' }}
                aria-hidden="true"
              />
            </div>
            <p style={helpStyle}>
              Exports your settings as a JSON file. Credentials and cached PR
              data are never included.
            </p>
            {importError && (
              <p
                role="alert"
                style={{
                  marginTop: 8,
                  padding: '8px 12px',
                  background: '#ffebe6',
                  border: '1px solid #ffbdad',
                  borderRadius: 3,
                  fontSize: 13,
                  color: '#bf2600',
                }}
              >
                ✗ Import failed: {importError}
              </p>
            )}
          </Section>
        </form>
      </main>

      {/* ── Footer bar (sticky bottom) ──────────────────────────────────── */}
      <footer style={footerBarStyle}>
        <div style={footerInnerStyle}>
          <button
            type="button"
            onClick={onResetAll}
            style={secondaryButtonStyle}
          >
            Reset all to defaults
          </button>
          <button
            type="button"
            onClick={onDisconnect}
            onMouseEnter={() => setDisconnectHover(true)}
            onMouseLeave={() => setDisconnectHover(false)}
            onFocus={() => setDisconnectFocus(true)}
            onBlur={() => setDisconnectFocus(false)}
            style={{
              ...dangerButtonStyle,
              ...(disconnectHover
                ? { background: '#fef2f2', borderColor: '#f87171' }
                : {}),
              ...(disconnectFocus
                ? { outline: '2px solid #fca5a5', outlineOffset: 2 }
                : {}),
            }}
          >
            Disconnect Bitbucket
          </button>
          <span style={{ flex: 1 }} />
          {/* Submit by associating with the form via the `form` attribute so the
              footer button still triggers form-level validation/submit semantics. */}
          <button
            type="submit"
            form="ej-options-form"
            disabled={saving}
            style={primaryButtonStyle}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </footer>

      {/* ── Toast (fixed bottom-right) ──────────────────────────────────── */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            padding: '10px 14px',
            borderRadius: 4,
            fontSize: 14,
            background: toast.kind === 'success' ? '#e3fcef' : '#ffebe6',
            color: toast.kind === 'success' ? '#006644' : '#bf2600',
            border:
              toast.kind === 'success'
                ? '1px solid #abf5d1'
                : '1px solid #ffbdad',
            boxShadow: '0 4px 12px rgba(9,30,66,0.15)',
            zIndex: 100,
            transition: 'opacity 200ms ease, transform 200ms ease',
          }}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

// ─── Connection status helpers ───────────────────────────────────────────────

function ConnectionStatusRow({ status }: { status: ConnectionStatus }) {
  if (status.kind === 'loading') {
    return (
      <div role="status" style={{ ...statusRowBaseStyle, color: '#7a869a' }}>
        Checking connection…
      </div>
    );
  }
  const r = status.result;
  if (r.ok) {
    return (
      <div role="status" style={{ ...statusRowBaseStyle, color: '#006644', background: '#e3fcef', border: '1px solid #abf5d1' }}>
        ✓ Connected as @{r.username}
        {r.displayName ? ` (${r.displayName})` : ''}
      </div>
    );
  }
  if (r.status === 0 && r.error.startsWith('Not connected')) {
    return (
      <div role="status" style={{ ...statusRowBaseStyle, color: '#5e6c84', background: '#f4f5f7', border: '1px solid #dfe1e6' }}>
        Not connected — paste an API token below
      </div>
    );
  }
  return (
    <div role="status" style={{ ...statusRowBaseStyle, color: '#bf2600', background: '#ffebe6', border: '1px solid #ffbdad' }}>
      ✗ {r.error} (HTTP {r.status})
    </div>
  );
}

const statusRowBaseStyle: React.CSSProperties = {
  marginBottom: 16,
  padding: '8px 12px',
  borderRadius: 3,
  fontSize: 13,
  lineHeight: 1.4,
};

// ─── Layout helpers ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2
        style={{
          fontSize: 16,
          fontWeight: 600,
          margin: '0 0 16px',
          paddingBottom: 8,
          borderBottom: '1px solid #e5e7eb',
          color: '#172B4D',
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: React.ReactNode;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label
        htmlFor={htmlFor}
        style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6, color: '#172B4D' }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

// ─── Inline styles ───────────────────────────────────────────────────────────

const pageWrapperStyle: React.CSSProperties = {
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
  minHeight: '100vh',
  background: '#f3f4f6',
  color: '#172B4D',
  display: 'flex',
  flexDirection: 'column',
};

const headerBarStyle: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 10,
  background: '#ffffff',
  borderBottom: '1px solid #e5e7eb',
};

const headerInnerStyle: React.CSSProperties = {
  maxWidth: MAX_CONTENT_WIDTH,
  margin: '0 auto',
  padding: '14px 24px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
};

const mainContentStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: MAX_CONTENT_WIDTH,
  margin: '24px auto',
  padding: '32px 40px',
  background: '#ffffff',
  borderRadius: 8,
  boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  boxSizing: 'border-box',
  flex: 1,
};

const footerBarStyle: React.CSSProperties = {
  position: 'sticky',
  bottom: 0,
  zIndex: 10,
  background: '#ffffff',
  borderTop: '1px solid #e5e7eb',
  padding: '12px 24px',
};

const footerInnerStyle: React.CSSProperties = {
  maxWidth: MAX_CONTENT_WIDTH,
  margin: '0 auto',
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
};

const textInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  fontSize: 14,
  border: '1px solid #c1c7d0',
  borderRadius: 3,
  background: '#fff',
  color: '#172B4D',
  boxSizing: 'border-box',
};

// ─── Per-field validation styling ────────────────────────────────────────────
// Inputs share the same palette as the existing Disconnect button (#fca5a5)
// and ConnectedCard (#86efac/#16a34a) so the visual language stays coherent.
function fieldStyle(validation: FieldValidation): React.CSSProperties {
  switch (validation) {
    case 'valid':
      return { ...textInputStyle, borderColor: '#86efac', color: '#14532d' };
    case 'invalid':
      return { ...textInputStyle, borderColor: '#fca5a5', color: '#7f1d1d' };
    case 'testing':
      return { ...textInputStyle, borderColor: '#bfdbfe' };
    case 'idle':
    default:
      return textInputStyle;
  }
}

// Fixed-width slot so swapping ✓/✗/⟳ never reflows the surrounding row.
// Idle still renders the slot (empty) so the input keeps the same effective
// width across all four states.
const validationIconSlotStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  minWidth: 24,
  fontSize: 16,
  lineHeight: 1,
  fontWeight: 700,
  userSelect: 'none',
};

function validationIcon(validation: FieldValidation): ReactElement {
  switch (validation) {
    case 'valid':
      return (
        <span
          aria-hidden="true"
          style={{ ...validationIconSlotStyle, color: '#16a34a' }}
        >
          ✓
        </span>
      );
    case 'invalid':
      return (
        <span
          aria-hidden="true"
          style={{ ...validationIconSlotStyle, color: '#dc2626' }}
        >
          ✗
        </span>
      );
    case 'testing':
      return (
        <span
          aria-hidden="true"
          style={{ ...validationIconSlotStyle, color: '#2563eb' }}
        >
          ⟳
        </span>
      );
    case 'idle':
    default:
      return <span aria-hidden="true" style={validationIconSlotStyle} />;
  }
}

// ─── Inline test-connection icon (trailing adornment on API token) ──────────
// Replaces the legacy "Test connection" text button. Sits absolutely
// positioned at the right edge of the API token input. Click to re-test;
// auto-fires on debounced token entry. Visual state mirrors the per-field
// validation state so a green check / red ✗ / spinning ⟳ / muted icon
// matches the rest of the credentials-section feedback.

const tokenInputWrapperStyle: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
};

// The token input mirrors fieldStyle() but reserves padding-right for the
// trailing icon so typed characters never slide under it.
function tokenInputFieldStyle(
  validation: FieldValidation,
): React.CSSProperties {
  return {
    ...fieldStyle(validation),
    width: '100%',
    paddingRight: 36,
  };
}

const testIconButtonStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  right: 4,
  transform: 'translateY(-50%)',
  width: 28,
  height: 28,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  margin: 0,
  background: 'transparent',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  color: '#5e6c84',
  transition: 'background-color 120ms, color 120ms',
};

const testIconButtonHoverStyle: React.CSSProperties = {
  background: '#e5e7eb',
  color: '#172B4D',
};

// Distinct state machine for the trailing icon. Same four states as
// FieldValidation, but we route through a tiny helper so the icon also
// reflects "no token yet" with a muted idle glyph (the field validation
// state already returns 'idle' in that case — they coincide).
type TokenIconState = 'idle' | 'testing' | 'valid' | 'invalid';

function tokenIconState(
  validation: FieldValidation,
  token: string,
): TokenIconState {
  if (validation === 'testing') return 'testing';
  if (!token) return 'idle';
  if (validation === 'valid') return 'valid';
  if (validation === 'invalid') return 'invalid';
  return 'idle';
}

function testConnectionIcon(state: TokenIconState): ReactElement {
  // Feather-style 18px stroke icons. No external lib.
  switch (state) {
    case 'valid':
      return (
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#16a34a"
          strokeWidth={2.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="8 12.5 11 15.5 16 9.5" />
        </svg>
      );
    case 'invalid':
      return (
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#dc2626"
          strokeWidth={2.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="9" y1="9" x2="15" y2="15" />
          <line x1="15" y1="9" x2="9" y2="15" />
        </svg>
      );
    case 'testing':
      return (
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#2563eb"
          strokeWidth={2.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ animation: 'ej-spin 900ms linear infinite' }}
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      );
    case 'idle':
    default:
      return (
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="8 12.5 11 15.5 16 9.5" />
        </svg>
      );
  }
}

const primaryButtonStyle: React.CSSProperties = {
  padding: '8px 16px',
  fontSize: 14,
  fontWeight: 600,
  background: '#0052cc',
  color: '#fff',
  border: '1px solid #0052cc',
  borderRadius: 3,
  cursor: 'pointer',
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: '8px 14px',
  fontSize: 14,
  background: '#f4f5f7',
  color: '#172B4D',
  border: '1px solid #c1c7d0',
  borderRadius: 3,
  cursor: 'pointer',
};

const dangerButtonStyle: React.CSSProperties = {
  padding: '8px 16px',
  fontSize: 14,
  fontWeight: 600,
  background: '#ffffff',
  color: '#dc2626',
  border: '1px solid #fca5a5',
  borderRadius: 6,
  cursor: 'pointer',
};

const helpStyle: React.CSSProperties = {
  margin: '6px 0 0',
  fontSize: 12,
  color: '#5e6c84',
};

// Local date in YYYY-MM-DD form for the export filename.
function todayIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
