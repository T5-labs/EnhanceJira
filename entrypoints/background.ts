import {
  authHeader,
  parseMissingScopes,
  formatScopeError,
  testConnection,
  type TestConnectionResult,
} from '../lib/auth';
import { loadCredentials, saveIdentity, type Credentials } from '../lib/settings';
import type {
  Message,
  GetPRStateResponse,
  ValidateUsernameResponse,
  GetWorkspaceMembersResponse,
  WorkspaceMember,
  ProbeResult,
  DiagnosticsResponse,
} from '../lib/messages';
import { info, error as logError } from '../lib/log';
import {
  BitbucketAuthError,
  BitbucketScopeError,
  BitbucketRequestError,
  fetchWorkspaceMembers,
  getPRState,
  validateUsername,
} from './background/bitbucket';

/**
 * MV3 service worker — message router.
 *
 * Handles three message types from the rest of the extension:
 *   - TEST_CONNECTION: validate caller-supplied (potentially unsaved)
 *     credentials against api.bitbucket.org/2.0/user.
 *   - GET_CONNECTION_STATUS: validate the SAVED credentials. Short-circuits
 *     to "Not connected" without an API hit if no creds are stored.
 *   - GET_PR_STATE: given a Jira key + tenant, return linked Bitbucket PR(s)
 *     with reviewer state. Owned by ./background/bitbucket.ts.
 *
 * Identity capture (v0.2.0): on every successful TEST_CONNECTION /
 * GET_CONNECTION_STATUS response we persist `{ username, displayName }` to
 * `chrome.storage.local` under the `identity` key. The content script reads
 * this to apply the `Settings.scope === 'mine'` filter without per-card
 * identity lookups. Only the (non-secret) username + display name are
 * persisted — never the token.
 *
 * SECURITY: credentials and tokens never reach any console.* call here.
 * The catch block logs only the message TYPE — never the message body.
 */

type WorkerErrorResponse = { ok: false; status: 0; error: string };

const NOT_CONNECTED: TestConnectionResult = {
  ok: false,
  status: 0,
  error: 'Not connected — paste an API token in settings.',
};

/**
 * Cache TTL for the workspace member list. 24h matches the freshness budget
 * specified for v0.3.0 — workspace membership churns slowly enough that this
 * is fine, and the user can disconnect / reconnect to bust the cache if a new
 * teammate shows up urgently. Stored in `chrome.storage.session` so it never
 * survives a worker restart unnecessarily; the next options-page load after a
 * restart will refetch.
 */
const WORKSPACE_MEMBERS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_MEMBERS_CACHE_PREFIX = 'members:';

type WorkspaceMembersCacheEntry = {
  members: WorkspaceMember[];
  fetchedAt: number;
};

export default defineBackground(() => {
  info('worker up');

  // First-install onboarding: open the options page so the user lands on the
  // setup guide without having to right-click the icon. Only fires when
  // `details.reason === 'install'` — NOT on update, which would surprise
  // existing users every time they get a patch.
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      void browser.runtime.openOptionsPage();
    }
  });

  browser.runtime.onMessage.addListener(
    (
      raw,
      _sender,
    ): Promise<
      | TestConnectionResult
      | GetPRStateResponse
      | ValidateUsernameResponse
      | GetWorkspaceMembersResponse
      | DiagnosticsResponse
      | WorkerErrorResponse
    > => {
      // Returning a Promise from the listener is the supported async pattern
      // under webextension-polyfill (which WXT uses). The polyfill bridges the
      // promise to the chrome callback signature, so we don't need to manually
      // `return true` — but webextension-polyfill handles it internally.
      return handle(raw as Message);
    },
  );
});

/**
 * Persist the captured identity. Best-effort — a storage failure here must
 * not break the user-facing connection-status response, so we swallow.
 *
 * SECURITY: only `username` and `displayName` flow through this path. The
 * underlying `TestConnectionResult` shape (lib/auth.ts) does not include the
 * token, so it is structurally impossible to leak credentials here.
 */
async function persistIdentityFromResult(result: TestConnectionResult): Promise<void> {
  if (!result.ok) return;
  try {
    await saveIdentity({
      version: 1,
      username: result.username,
      displayName: result.displayName ?? '',
      fetchedAt: Date.now(),
    });
  } catch {
    // ignore — identity caching is best-effort
  }
}

async function handle(
  message: Message,
): Promise<
  | TestConnectionResult
  | GetPRStateResponse
  | ValidateUsernameResponse
  | GetWorkspaceMembersResponse
  | DiagnosticsResponse
  | WorkerErrorResponse
> {
  try {
    switch (message?.type) {
      case 'TEST_CONNECTION': {
        const result = await testConnection(message.credentials);
        await persistIdentityFromResult(result);
        return result;
      }

      case 'GET_CONNECTION_STATUS': {
        const creds = await loadCredentials();
        if (!creds.username || !creds.token) {
          return NOT_CONNECTED;
        }
        const result = await testConnection(creds);
        await persistIdentityFromResult(result);
        return result;
      }

      case 'GET_PR_STATE':
        return await getPRState(message.tenant, message.key);

      case 'VALIDATE_USERNAME': {
        const creds = await loadCredentials();
        return await validateUsername(creds, message.username);
      }

      case 'GET_WORKSPACE_MEMBERS':
        return await getWorkspaceMembers(message.workspaceSlug);

      case 'RUN_DIAGNOSTICS':
        return await runDiagnostics(message.credentials, message.workspaceSlug);

      default:
        return {
          ok: false,
          status: 0,
          error: 'Unknown message type',
        };
    }
  } catch {
    // NB: log the message TYPE only. The message body may carry credentials
    // (TEST_CONNECTION) — we never serialize it into a log line.
    const t = (message && (message as { type?: string }).type) || 'unknown';
    logError(`handler error: ${t}`);
    return {
      ok: false,
      status: 0,
      error: 'Worker error — check service worker logs',
    };
  }
}

/**
 * GET_WORKSPACE_MEMBERS handler. Reads the cached list from
 * `chrome.storage.session` first; on miss / TTL expiry hits
 * `/2.0/workspaces/{slug}/members`, walks pagination via
 * `fetchWorkspaceMembers`, and writes the result back. Returns a structured
 * `{ ok: false, error, status }` on any non-2xx / network / no-creds path so
 * the options-page autocomplete can surface the failure inline.
 *
 * SECURITY: identical credential rules to the rest of this worker — token
 * lives in `chrome.storage.local`, transits in `Authorization` only, never
 * appears in any returned `error`.
 */
async function getWorkspaceMembers(
  workspaceSlug: string,
): Promise<GetWorkspaceMembersResponse> {
  const slug = (workspaceSlug || '').trim();
  if (!slug) {
    return { ok: false, error: 'Missing workspace slug', status: 0 };
  }

  const cacheKey = `${WORKSPACE_MEMBERS_CACHE_PREFIX}${slug}`;
  try {
    const raw = await browser.storage.session.get(cacheKey);
    const v = raw[cacheKey] as WorkspaceMembersCacheEntry | undefined;
    if (
      v &&
      Array.isArray(v.members) &&
      typeof v.fetchedAt === 'number' &&
      Date.now() - v.fetchedAt < WORKSPACE_MEMBERS_CACHE_TTL_MS
    ) {
      return { ok: true, members: v.members };
    }
  } catch {
    // session storage unavailable — fall through to live fetch.
  }

  const creds = await loadCredentials();
  if (!creds.username || !creds.token) {
    return {
      ok: false,
      error: 'Not connected — paste your token in settings.',
      status: 0,
    };
  }

  let members: WorkspaceMember[];
  try {
    members = await fetchWorkspaceMembers(creds, slug);
  } catch (err) {
    if (err instanceof BitbucketAuthError) {
      return {
        ok: false,
        error: 'Token rejected — re-paste in settings.',
        status: 401,
      };
    }
    if (err instanceof BitbucketScopeError) {
      return {
        ok: false,
        error: formatScopeError(err.missingScopes),
        status: 403,
      };
    }
    if (err instanceof BitbucketRequestError) {
      // 404 here usually means the workspace slug is wrong (or not visible
      // to the connected user). Surface a friendlier message; the autocomplete
      // can render this inline as a hint.
      if (err.status === 404) {
        return {
          ok: false,
          error: 'Workspace not found — check the slug in settings.',
          status: 404,
        };
      }
      return {
        ok: false,
        error: err.message || 'Bitbucket API error',
        status: err.status,
      };
    }
    // Any other error path — do NOT echo `err.message`; could in theory
    // contain a URL with sensitive context.
    return {
      ok: false,
      error: 'Unexpected error fetching workspace members',
      status: 0,
    };
  }

  try {
    await browser.storage.session.set({
      [cacheKey]: { members, fetchedAt: Date.now() } satisfies WorkspaceMembersCacheEntry,
    });
  } catch {
    // ignore — caching is best-effort.
  }

  return { ok: true, members };
}

// ─── RUN_DIAGNOSTICS (v0.3.5) ───────────────────────────────────────────────

/**
 * Per-scope diagnostics suite. Execution order:
 *   1. Account access (sequential) — captures username + granted scopes from
 *      `x-oauth-scopes`.
 *   2. Repository access (sequential) — captures `firstRepoSlug` so the
 *      pullrequest probe has a real repo to test against.
 *   3. Pull request data + Workspace members (parallel).
 *
 * Bitbucket Cloud retired the user-scoped `/2.0/pullrequests/{username}`
 * endpoint (returns 404 unauthenticated and authenticated alike, regardless of
 * `{username}`/`{uuid}`/`/users/{username}/pullrequests`). The probe now hits
 * `/2.0/repositories/{ws}/{repo}/pullrequests` against the first repo
 * surfaced by the repository probe, which still requires (and therefore
 * exercises) `read:pullrequest:bitbucket`.
 *
 * The `results[]` array is sorted back to display order
 * `[connection, pullrequest, repository, workspace]` before returning, even
 * though execution order is `connection → repository → (pullrequest, workspace)`.
 *
 * SECURITY: identical credential rules to the rest of this worker — token
 * lives in `chrome.storage.local`, transits in `Authorization` only, never
 * appears in any returned `detail` or `error`. Catch blocks discard underlying
 * fetch errors to avoid echoing URL or header context.
 *
 * Identity capture side-effect: when the connection probe passes, persist
 * `{ username, displayName }` via `saveIdentity` so the saved-status row +
 * ConnectedCard reflect the now-validated credentials without an extra
 * round-trip.
 */
async function runDiagnostics(
  creds: Credentials,
  workspaceSlug: string,
): Promise<DiagnosticsResponse> {
  try {
    let header: string;
    try {
      header = authHeader(creds);
    } catch {
      const failOnAuth: ProbeResult = {
        id: 'connection',
        label: 'Account access',
        scope: 'read:user:bitbucket',
        endpoint: '/2.0/user',
        status: 'fail',
        detail: 'Username and token are required',
      };
      return {
        ok: true,
        results: [
          failOnAuth,
          buildSkipped('pullrequest', 'Skipped — authentication failed'),
          buildSkipped('repository', 'Skipped — authentication failed'),
          buildSkipped('workspace', 'Skipped — authentication failed'),
        ],
      };
    }

    // Phase 1 (sequential) — Account access. Feeds username + granted-scope
    // list into the rest of the run.
    const probe1 = await probeConnection(header);

    // Auth failure → short-circuit. Mark probes 2/3/4 as skipped.
    if (probe1.status === 'fail' && probe1.authFailed === true) {
      return {
        ok: true,
        results: [
          probe1.result,
          buildSkipped('pullrequest', 'Skipped — authentication failed'),
          buildSkipped('repository', 'Skipped — authentication failed'),
          buildSkipped('workspace', 'Skipped — authentication failed'),
        ],
      };
    }

    // Other probe-1 failures (403, 5xx, network) — still attempt the rest. We
    // only short-circuit on 401 because the remaining probes might surface a
    // different failure mode (e.g. 403 here is a missing read:user:bitbucket
    // scope, which doesn't preclude the other endpoints from succeeding).
    let probeUsername = '';
    let probeDisplayName: string | undefined;
    if (probe1.status === 'pass') {
      probeUsername = probe1.username ?? '';
      probeDisplayName = probe1.displayName;
      // Persist identity so the saved-status row + ConnectedCard reflect
      // the now-validated credentials. Best-effort.
      if (probeUsername) {
        try {
          await saveIdentity({
            version: 1,
            username: probeUsername,
            displayName: probeDisplayName ?? '',
            fetchedAt: Date.now(),
          });
        } catch {
          // ignore — identity caching is best-effort.
        }
      }
    }

    const slug = (workspaceSlug || '').trim();

    // Phase 2 (sequential) — Repository access. Captures `firstRepoSlug` so
    // the pullrequest probe has a real repo to verify the scope against.
    const probe3 = await probeRepositories(header, slug);

    // Phase 3 (parallel) — Pull request data + Workspace members.
    const [probe2, probe4] = await Promise.all([
      probePullRequests(header, slug, probe3.status, probe3.firstRepoSlug ?? null),
      probeWorkspaceMembers(header, slug),
    ]);

    // Sort back to display order [connection, pullrequest, repository, workspace].
    return {
      ok: true,
      results: [probe1.result, probe2, probe3.result, probe4],
      ...(probeUsername ? { username: probeUsername } : {}),
      ...(probeDisplayName !== undefined ? { displayName: probeDisplayName } : {}),
    };
  } catch {
    // Programming bug — don't echo the underlying error message (could in
    // theory carry URL or header context).
    return { ok: false, error: 'Unexpected diagnostics error' };
  }
}

type ConnectionProbeOutcome =
  | { status: 'pass'; result: ProbeResult; username: string; displayName?: string }
  | { status: 'fail'; result: ProbeResult; authFailed: boolean };

/**
 * Probe `GET /2.0/user`. On 200, capture `username` + `display_name` so the
 * caller can both seed identity persistence and short-circuit decisions, and
 * stash the granted-scope list from the `x-oauth-scopes` response header into
 * the result's `detail` (informational only — not used to gate other probes).
 * On 401, signal `authFailed: true` so the caller short-circuits 2/3/4 to
 * `skipped`.
 */
async function probeConnection(header: string): Promise<ConnectionProbeOutcome> {
  const base: Pick<ProbeResult, 'id' | 'label' | 'scope' | 'endpoint'> = {
    id: 'connection',
    label: 'Account access',
    scope: 'read:user:bitbucket',
    endpoint: '/2.0/user',
  };

  let res: Response;
  try {
    res = await fetch('https://api.bitbucket.org/2.0/user', {
      method: 'GET',
      headers: { Authorization: header, Accept: 'application/json' },
    });
  } catch {
    return {
      status: 'fail',
      authFailed: false,
      result: { ...base, status: 'fail', detail: 'Network error' },
    };
  }

  if (res.ok) {
    try {
      const body = (await res.json()) as {
        username?: string;
        nickname?: string;
        uuid?: string;
        display_name?: string;
      };
      // Extraction priority mirrors mapParticipant in ./background/bitbucket.ts:
      // username → nickname → uuid. Bitbucket Cloud has been phasing out the
      // legacy `username` field in favor of `nickname`, so falling back keeps
      // `Identity.username` aligned with `Reviewer.username` for the self-
      // status badge matcher.
      let username = '';
      if (typeof body.username === 'string' && body.username.length > 0) {
        username = body.username;
      } else if (typeof body.nickname === 'string' && body.nickname.length > 0) {
        username = body.nickname;
      } else if (typeof body.uuid === 'string' && body.uuid.length > 0) {
        username = body.uuid;
      }
      const displayName =
        typeof body.display_name === 'string' ? body.display_name : undefined;
      if (!username) {
        return {
          status: 'fail',
          authFailed: false,
          result: { ...base, status: 'fail', detail: 'Unexpected response shape' },
        };
      }
      const grantedDetail = formatGrantedScopes(res.headers.get('x-oauth-scopes'));
      return {
        status: 'pass',
        username,
        displayName,
        result: {
          ...base,
          status: 'pass',
          ...(grantedDetail ? { detail: grantedDetail } : {}),
        },
      };
    } catch {
      return {
        status: 'fail',
        authFailed: false,
        result: { ...base, status: 'fail', detail: 'Failed to parse response' },
      };
    }
  }

  if (res.status === 401) {
    return {
      status: 'fail',
      authFailed: true,
      result: { ...base, status: 'fail', detail: 'Token rejected' },
    };
  }
  if (res.status === 403) {
    const missing = await parseMissingScopes(res);
    return {
      status: 'fail',
      authFailed: false,
      result: { ...base, status: 'fail', detail: formatScopeError(missing) },
    };
  }
  return {
    status: 'fail',
    authFailed: false,
    result: { ...base, status: 'fail', detail: humanizeProbeStatus(res.status, res.statusText) },
  };
}

/**
 * Format the granted-scope list from the `x-oauth-scopes` response header
 * into a single-line `detail` string. Returns `undefined` when the header is
 * missing or empty so the caller can omit `detail` entirely.
 *
 * Example: `"read:user:bitbucket, read:pullrequest:bitbucket"` →
 * `"Granted: read:user:bitbucket, read:pullrequest:bitbucket"`.
 */
function formatGrantedScopes(headerValue: string | null): string | undefined {
  if (!headerValue) return undefined;
  const scopes = headerValue
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (scopes.length === 0) return undefined;
  return `Granted: ${scopes.join(', ')}`;
}

/**
 * Probe `GET /2.0/repositories/{ws}/{repo}/pullrequests?pagelen=1&state=OPEN`.
 *
 * Bitbucket Cloud retired the user-scoped `/2.0/pullrequests/{username}`
 * endpoint, so this probe now exercises `read:pullrequest:bitbucket` against
 * a real repository surfaced by the repository probe. Skip conditions:
 *   - workspace slug blank → `Skipped — set workspace slug above`
 *   - repository probe failed → `Skipped — needs repository access — fix that first`
 *   - repository probe passed but `firstRepoSlug` is null (empty workspace)
 *     → `Skipped — workspace has no repositories`
 *
 * The displayed `endpoint` field uses placeholders
 * (`/2.0/repositories/<ws>/<repo>/pullrequests`) — the actual fetch substitutes
 * the real workspace + repo slugs but we never expose them in the table.
 */
async function probePullRequests(
  header: string,
  workspaceSlug: string,
  repoProbeStatus: ProbeResult['status'],
  firstRepoSlug: string | null,
): Promise<ProbeResult> {
  const base: Pick<ProbeResult, 'id' | 'label' | 'scope' | 'endpoint'> = {
    id: 'pullrequest',
    label: 'Pull request data',
    scope: 'read:pullrequest:bitbucket',
    endpoint: '/2.0/repositories/<ws>/<repo>/pullrequests',
  };

  if (!workspaceSlug) {
    return { ...base, status: 'skipped', detail: 'Skipped — set workspace slug above' };
  }
  if (repoProbeStatus === 'fail') {
    return {
      ...base,
      status: 'skipped',
      detail: 'Skipped — needs repository access — fix that first',
    };
  }
  if (repoProbeStatus === 'skipped') {
    return { ...base, status: 'skipped', detail: 'Skipped — set workspace slug above' };
  }
  if (!firstRepoSlug) {
    return {
      ...base,
      status: 'skipped',
      detail: 'Skipped — workspace has no repositories',
    };
  }

  const url =
    `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspaceSlug)}` +
    `/${encodeURIComponent(firstRepoSlug)}/pullrequests` +
    `?pagelen=1&state=OPEN&fields=values.id`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: header, Accept: 'application/json' },
    });
  } catch {
    return { ...base, status: 'fail', detail: 'Network error' };
  }

  if (res.ok) return { ...base, status: 'pass' };
  if (res.status === 401) return { ...base, status: 'fail', detail: 'Token rejected' };
  if (res.status === 403) {
    const missing = await parseMissingScopes(res);
    return { ...base, status: 'fail', detail: formatScopeError(missing) };
  }
  return { ...base, status: 'fail', detail: humanizeProbeStatus(res.status, res.statusText) };
}

type RepositoryProbeOutcome = {
  result: ProbeResult;
  status: ProbeResult['status'];
  firstRepoSlug: string | null;
};

/**
 * Probe `GET /2.0/repositories/{workspaceSlug}?pagelen=1&fields=values.slug,values.full_name`.
 * On pass, captures `firstRepoSlug` from `body.values[0]?.slug` so the
 * pullrequest probe has a real repo to test against. Empty workspace (no
 * repos returned) still passes — workspace exists, just has nothing in it —
 * but `firstRepoSlug` is null, which the pullrequest probe interprets as
 * "skip with workspace has no repositories."
 */
async function probeRepositories(
  header: string,
  workspaceSlug: string,
): Promise<RepositoryProbeOutcome> {
  const base: Pick<ProbeResult, 'id' | 'label' | 'scope' | 'endpoint'> = {
    id: 'repository',
    label: 'Repository access',
    scope: 'read:repository:bitbucket',
    endpoint: '/2.0/repositories/<ws>',
  };

  if (!workspaceSlug) {
    return {
      result: { ...base, status: 'skipped', detail: 'Skipped — set workspace slug above' },
      status: 'skipped',
      firstRepoSlug: null,
    };
  }

  const url =
    `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspaceSlug)}` +
    `?pagelen=1&fields=values.slug,values.full_name`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: header, Accept: 'application/json' },
    });
  } catch {
    return {
      result: { ...base, status: 'fail', detail: 'Network error' },
      status: 'fail',
      firstRepoSlug: null,
    };
  }

  if (res.ok) {
    let firstRepoSlug: string | null = null;
    try {
      const body = (await res.json()) as { values?: Array<{ slug?: unknown }> };
      const first = Array.isArray(body.values) ? body.values[0] : undefined;
      if (first && typeof first.slug === 'string' && first.slug.length > 0) {
        firstRepoSlug = first.slug;
      }
    } catch {
      // Body parse failure — still treat as pass (workspace responded 200);
      // pullrequest probe will skip with "workspace has no repositories."
    }
    return {
      result: { ...base, status: 'pass' },
      status: 'pass',
      firstRepoSlug,
    };
  }
  if (res.status === 401) {
    return {
      result: { ...base, status: 'fail', detail: 'Token rejected' },
      status: 'fail',
      firstRepoSlug: null,
    };
  }
  if (res.status === 403) {
    const missing = await parseMissingScopes(res);
    return {
      result: { ...base, status: 'fail', detail: formatScopeError(missing) },
      status: 'fail',
      firstRepoSlug: null,
    };
  }
  if (res.status === 404) {
    return {
      result: { ...base, status: 'fail', detail: 'Workspace not found — check the slug' },
      status: 'fail',
      firstRepoSlug: null,
    };
  }
  return {
    result: { ...base, status: 'fail', detail: humanizeProbeStatus(res.status, res.statusText) },
    status: 'fail',
    firstRepoSlug: null,
  };
}

/**
 * Probe `GET /2.0/workspaces/{workspaceSlug}/members?pagelen=1`. Same skip
 * behavior as probe 3.
 */
async function probeWorkspaceMembers(header: string, workspaceSlug: string): Promise<ProbeResult> {
  const base: Pick<ProbeResult, 'id' | 'label' | 'scope' | 'endpoint'> = {
    id: 'workspace',
    label: 'Workspace members',
    scope: 'read:workspace:bitbucket',
    endpoint: '/2.0/workspaces/<ws>/members',
  };

  if (!workspaceSlug) {
    return { ...base, status: 'skipped', detail: 'Skipped — set workspace slug above' };
  }

  const url = `https://api.bitbucket.org/2.0/workspaces/${encodeURIComponent(workspaceSlug)}/members?pagelen=1`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: header, Accept: 'application/json' },
    });
  } catch {
    return { ...base, status: 'fail', detail: 'Network error' };
  }

  if (res.ok) return { ...base, status: 'pass' };
  if (res.status === 401) return { ...base, status: 'fail', detail: 'Token rejected' };
  if (res.status === 403) {
    const missing = await parseMissingScopes(res);
    return { ...base, status: 'fail', detail: formatScopeError(missing) };
  }
  if (res.status === 404) {
    return { ...base, status: 'fail', detail: 'Workspace not found — check the slug' };
  }
  return { ...base, status: 'fail', detail: humanizeProbeStatus(res.status, res.statusText) };
}

function buildSkipped(
  id: ProbeResult['id'],
  detail: string,
): ProbeResult {
  switch (id) {
    case 'pullrequest':
      return {
        id,
        label: 'Pull request data',
        scope: 'read:pullrequest:bitbucket',
        endpoint: '/2.0/repositories/<ws>/<repo>/pullrequests',
        status: 'skipped',
        detail,
      };
    case 'repository':
      return {
        id,
        label: 'Repository access',
        scope: 'read:repository:bitbucket',
        endpoint: '/2.0/repositories/<ws>',
        status: 'skipped',
        detail,
      };
    case 'workspace':
      return {
        id,
        label: 'Workspace members',
        scope: 'read:workspace:bitbucket',
        endpoint: '/2.0/workspaces/<ws>/members',
        status: 'skipped',
        detail,
      };
    case 'connection':
    default:
      return {
        id: 'connection',
        label: 'Account access',
        scope: 'read:user:bitbucket',
        endpoint: '/2.0/user',
        status: 'skipped',
        detail,
      };
  }
}

function humanizeProbeStatus(status: number, statusText: string): string {
  const trimmed = (statusText || '').trim();
  if (status >= 500) {
    return `Server error (HTTP ${status}${trimmed ? ` ${trimmed}` : ''})`;
  }
  if (status === 429) {
    return 'Rate limited — try again shortly';
  }
  return `Unexpected response (HTTP ${status}${trimmed ? ` ${trimmed}` : ''})`;
}
