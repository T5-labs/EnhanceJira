import { testConnection, formatScopeError, type TestConnectionResult } from '../lib/auth';
import { loadCredentials, saveIdentity } from '../lib/settings';
import type {
  Message,
  PingResponse,
  GetPRStateResponse,
  ValidateUsernameResponse,
  GetWorkspaceMembersResponse,
  WorkspaceMember,
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
 * Handles four message types from the rest of the extension:
 *   - TEST_CONNECTION: validate caller-supplied (potentially unsaved)
 *     credentials against api.bitbucket.org/2.0/user.
 *   - GET_CONNECTION_STATUS: validate the SAVED credentials. Short-circuits
 *     to "Not connected" without an API hit if no creds are stored.
 *   - PING: cheap smoke test, returns the current epoch ms.
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
      | PingResponse
      | GetPRStateResponse
      | ValidateUsernameResponse
      | GetWorkspaceMembersResponse
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
  | PingResponse
  | GetPRStateResponse
  | ValidateUsernameResponse
  | GetWorkspaceMembersResponse
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

      case 'PING':
        return { ok: true, time: Date.now() };

      case 'GET_PR_STATE':
        return await getPRState(message.tenant, message.key);

      case 'VALIDATE_USERNAME': {
        const creds = await loadCredentials();
        return await validateUsername(creds, message.username);
      }

      case 'GET_WORKSPACE_MEMBERS':
        return await getWorkspaceMembers(message.workspaceSlug);

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
