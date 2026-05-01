/**
 * Worker-side Bitbucket + Jira-dev-status network code.
 *
 * Public surface:
 *   - getPRState(tenant, key) — top-level orchestrator, called by the
 *     background message handler for GET_PR_STATE.
 *
 * Everything else is internal but exported so unit tests (later phases) can
 * exercise the linkage / fetch / cache layers in isolation.
 *
 * SECURITY:
 *   - The Bitbucket API token is sent ONLY in the `Authorization: Basic ...`
 *     header. Never in URLs, never in console output, never in returned
 *     `error` strings. See lib/auth.ts for the canonical rule list.
 *   - Catch blocks deliberately discard the underlying Error message and
 *     surface a generic string — upstream errors can echo URLs or headers.
 *   - The Jira dev-status endpoint uses the user's session cookie
 *     (`credentials: 'include'`), not the Bitbucket token. So 401/403 there
 *     means "user isn't logged into Jira on this tenant" — we treat that as
 *     "not found" and fall back, NOT as a token failure.
 *
 * Caching strategy:
 *   - `pr:<tenant>:<key>` in browser.storage.session, TTL 30s,
 *     stale-while-revalidate (return cached + fire-and-forget refresh).
 *   - `jiraId:<tenant>:<key>` in browser.storage.session, no TTL — internal
 *     issue IDs are immutable per key.
 *
 * Coalescing: a module-scoped Map<string, Promise<PRState[]>> keyed by
 * `pr:<tenant>:<key>` deduplicates concurrent fetches. Cleared on settle.
 *
 * Throttling: a simple in-flight counter caps the worker at 10 concurrent
 * Bitbucket / Jira requests. Excess callers queue on a FIFO. Bitbucket's
 * documented limit is 1000/hr per OAuth client; 10 concurrent is well
 * inside that envelope but covers a board-mount fanout (~50 cards loading
 * at once on first paint).
 */

import { authHeader, parseMissingScopes, formatScopeError } from '../../lib/auth';
import { loadCredentials, loadSettings, type Credentials } from '../../lib/settings';
import type { PRState, Reviewer } from '../../lib/bitbucket';
import type {
  GetPRStateResponse,
  ValidateUsernameResponse,
  WorkspaceMember,
} from '../../lib/messages';
import { warn } from '../../lib/log';

// ─── Constants ──────────────────────────────────────────────────────────────

const PR_CACHE_TTL_MS = 30_000;
const PR_CACHE_PREFIX = 'pr:';
const JIRA_ID_CACHE_PREFIX = 'jiraId:';
const MAX_CONCURRENT_REQUESTS = 10;
const PR_URL_RE =
  /^https:\/\/bitbucket\.org\/(?<workspace>[^/]+)\/(?<repoSlug>[^/]+)\/pull-requests\/(?<prId>\d+)/;

// ─── Typed errors ───────────────────────────────────────────────────────────

export class BitbucketAuthError extends Error {
  constructor() {
    super('Token rejected');
    this.name = 'BitbucketAuthError';
  }
}
export class BitbucketScopeError extends Error {
  /**
   * Optional list of scope IDs Bitbucket reported as missing on the request
   * that triggered this error (parsed from `error.detail.required[]` on the
   * 403 response body — see `explain403`). May be empty if the response body
   * was missing / malformed; callers should fall back to a static message in
   * that case.
   */
  missingScopes: string[];
  constructor(missingScopes: string[] = []) {
    super(
      missingScopes.length > 0
        ? `Token missing scope: ${missingScopes.join(', ')}`
        : 'Token missing required scopes',
    );
    this.name = 'BitbucketScopeError';
    this.missingScopes = missingScopes;
  }
}
export class BitbucketRequestError extends Error {
  status: number;
  constructor(status: number, statusText: string) {
    super(statusText || 'Bitbucket API error');
    this.name = 'BitbucketRequestError';
    this.status = status;
  }
}

/**
 * Build a `BitbucketScopeError` from a 403 response, parsing the body once for
 * the verbatim missing-scope list. Each call site that maps `403 → throw` calls
 * this and `await`s the result, then throws.
 *
 * SECURITY: only the scope IDs Bitbucket itself surfaced via
 * `error.detail.required[]` flow into the error message — never URLs, headers,
 * or token material. Body parse failures degrade gracefully to the static
 * "Token missing required scopes" message.
 */
async function buildScopeErrorFromResponse(r: Response): Promise<BitbucketScopeError> {
  const missing = await parseMissingScopes(r);
  return new BitbucketScopeError(missing);
}

// ─── Throttle (max-N concurrent gate) ───────────────────────────────────────

let inflight = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (inflight < MAX_CONCURRENT_REQUESTS) {
    inflight += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inflight += 1;
}

function releaseSlot(): void {
  inflight -= 1;
  const next = waiters.shift();
  if (next) next();
}

async function throttledFetch(input: string, init: RequestInit): Promise<Response> {
  await acquireSlot();
  try {
    return await fetch(input, init);
  } finally {
    releaseSlot();
  }
}

// ─── One-shot warning dedupe ────────────────────────────────────────────────

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  warn(message);
}

// ─── 3a. Linkage via Jira dev-status (primary) ──────────────────────────────

export async function lookupViaDevStatus(
  tenant: string,
  key: string,
): Promise<{ workspace: string; repoSlug: string; prId: number }[] | null> {
  let issueId: string | null = null;
  const idCacheKey = `${JIRA_ID_CACHE_PREFIX}${tenant}:${key}`;

  // Check session cache for the numeric id (keys → ids are stable).
  try {
    const cached = await browser.storage.session.get(idCacheKey);
    const v = cached[idCacheKey] as { id?: string } | undefined;
    if (v && typeof v.id === 'string' && v.id.length > 0) {
      issueId = v.id;
    }
  } catch {
    // session storage may be unavailable in some test environments — fall
    // through to live fetch.
  }

  if (!issueId) {
    let res: Response;
    try {
      res = await throttledFetch(
        `https://${tenant}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'include',
        },
      );
    } catch {
      return null;
    }

    if (!res.ok) {
      // 401/403/404 (user not logged into Jira on this tenant, or key not
      // visible) → fall back. Other non-2xx also falls back.
      return null;
    }

    let body: { id?: unknown };
    try {
      body = (await res.json()) as { id?: unknown };
    } catch {
      return null;
    }
    if (typeof body.id !== 'string' || body.id.length === 0) {
      return null;
    }
    issueId = body.id;
    try {
      await browser.storage.session.set({ [idCacheKey]: { id: issueId } });
    } catch {
      // ignore — caching is best-effort.
    }
  }

  // Step 2: dev-status.
  let res: Response;
  try {
    res = await throttledFetch(
      `https://${tenant}/rest/dev-status/1.0/issue/detail?issueId=${encodeURIComponent(issueId)}&applicationType=bitbucket&dataType=pullrequest`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'include',
      },
    );
  } catch {
    warnOnce(
      'dev-status-network',
      'Jira dev-status network error — falling back to Bitbucket scan',
    );
    return null;
  }

  if (!res.ok) {
    warnOnce(
      `dev-status-${res.status}`,
      `Jira dev-status returned ${res.status} — falling back to Bitbucket scan`,
    );
    return null;
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }

  // Shape: { detail: [{ pullRequests: [{ url, status, ... }, ...] }, ...] }
  const detail = (body as { detail?: unknown }).detail;
  if (!Array.isArray(detail)) return null;

  const links: { workspace: string; repoSlug: string; prId: number }[] = [];
  for (const d of detail) {
    const prs = (d as { pullRequests?: unknown }).pullRequests;
    if (!Array.isArray(prs)) continue;
    for (const pr of prs) {
      const status = (pr as { status?: unknown }).status;
      const url = (pr as { url?: unknown }).url;
      if (status !== 'OPEN') continue;
      if (typeof url !== 'string') continue;
      const m = PR_URL_RE.exec(url);
      if (!m || !m.groups) continue;
      const prId = parseInt(m.groups['prId']!, 10);
      if (!Number.isFinite(prId)) continue;
      links.push({
        workspace: m.groups['workspace']!,
        repoSlug: m.groups['repoSlug']!,
        prId,
      });
    }
  }

  return links;
}

// ─── 3b. Linkage via Bitbucket workspace scan (fallback) ────────────────────

export async function lookupViaBitbucketScan(
  creds: Credentials,
  workspaceSlug: string,
  key: string,
): Promise<{ workspace: string; repoSlug: string; prId: number }[]> {
  if (!workspaceSlug) {
    warnOnce(
      'scan-no-workspace',
      'Bitbucket scan skipped — no workspace configured',
    );
    return [];
  }

  let header: string;
  try {
    header = authHeader(creds);
  } catch {
    return [];
  }

  const matches: { workspace: string; repoSlug: string; prId: number }[] = [];
  let cursor: string | undefined =
    `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspaceSlug)}?pagelen=100&fields=values.slug,values.full_name,next`;

  // Iterate paginated repo list. Stop scanning further pages once we've
  // collected at least one PR match — first hit is sufficient for v1.
  pageLoop: while (cursor) {
    let res: Response;
    try {
      res = await throttledFetch(cursor, {
        method: 'GET',
        headers: { Authorization: header, Accept: 'application/json' },
      });
    } catch {
      return matches;
    }

    if (res.status === 401) throw new BitbucketAuthError();
    if (res.status === 403) throw await buildScopeErrorFromResponse(res);
    if (!res.ok) {
      throw new BitbucketRequestError(res.status, res.statusText);
    }

    let body: { values?: unknown; next?: unknown };
    try {
      body = (await res.json()) as { values?: unknown; next?: unknown };
    } catch {
      return matches;
    }

    const repos = Array.isArray(body.values) ? body.values : [];
    for (const r of repos) {
      const slug = (r as { slug?: unknown }).slug;
      if (typeof slug !== 'string' || !slug) continue;
      const found = await scanRepoForKey(header, workspaceSlug, slug, key);
      if (found.length > 0) {
        matches.push(...found);
        break pageLoop;
      }
    }

    cursor = typeof body.next === 'string' ? body.next : undefined;
  }

  return matches;
}

async function scanRepoForKey(
  authHeaderValue: string,
  workspace: string,
  repoSlug: string,
  key: string,
): Promise<{ workspace: string; repoSlug: string; prId: number }[]> {
  const q = encodeURIComponent(`source.branch.name~"${key}"`);
  const url = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests?q=${q}&state=OPEN&pagelen=10&fields=values.id,values.source.branch.name`;

  let res: Response;
  try {
    res = await throttledFetch(url, {
      method: 'GET',
      headers: { Authorization: authHeaderValue, Accept: 'application/json' },
    });
  } catch {
    return [];
  }

  if (res.status === 401) throw new BitbucketAuthError();
  if (res.status === 403) throw await buildScopeErrorFromResponse(res);
  if (!res.ok) {
    // 404 on a single repo's PR endpoint is not fatal for the whole scan.
    if (res.status === 404) return [];
    throw new BitbucketRequestError(res.status, res.statusText);
  }

  let body: { values?: unknown };
  try {
    body = (await res.json()) as { values?: unknown };
  } catch {
    return [];
  }

  const out: { workspace: string; repoSlug: string; prId: number }[] = [];
  if (Array.isArray(body.values)) {
    for (const pr of body.values) {
      const id = (pr as { id?: unknown }).id;
      if (typeof id !== 'number') continue;
      out.push({ workspace, repoSlug, prId: id });
    }
  }
  return out;
}

// ─── 3c. PR detail fetch ────────────────────────────────────────────────────

export async function fetchPRDetail(
  creds: Credentials,
  link: { workspace: string; repoSlug: string; prId: number },
): Promise<PRState | null> {
  const header = authHeader(creds);
  const url = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(link.workspace)}/${encodeURIComponent(link.repoSlug)}/pullrequests/${link.prId}`;

  let res: Response;
  try {
    res = await throttledFetch(url, {
      method: 'GET',
      headers: { Authorization: header, Accept: 'application/json' },
    });
  } catch {
    throw new BitbucketRequestError(0, 'Network error');
  }

  if (res.status === 401) throw new BitbucketAuthError();
  if (res.status === 403) throw await buildScopeErrorFromResponse(res);
  if (res.status === 404) return null;
  if (!res.ok) throw new BitbucketRequestError(res.status, res.statusText);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new BitbucketRequestError(res.status, 'Malformed PR response');
  }

  const b = body as {
    participants?: unknown;
  };

  // Map every participant entry, then keep only formal reviewers — drive-by
  // commenters (role !== 'REVIEWER') don't count toward the gate.
  const reviewers: Reviewer[] = [];
  if (Array.isArray(b.participants)) {
    for (const p of b.participants) {
      const part = mapReviewer(p);
      if (part) reviewers.push(part);
    }
  }

  return { reviewers };
}

function mapReviewer(p: unknown): Reviewer | null {
  const obj = p as {
    user?: {
      username?: unknown;
      nickname?: unknown;
      uuid?: unknown;
      display_name?: unknown;
      links?: { avatar?: { href?: unknown } };
    };
    role?: unknown;
    approved?: unknown;
    state?: unknown;
  };
  const user = obj.user;
  if (!user) return null;

  // Drop drive-by commenters at the source — only formal reviewers reach the
  // returned list, so downstream code never has to filter on role itself.
  if (obj.role !== 'REVIEWER') return null;

  // Username priority: username → nickname → uuid. Bitbucket Cloud has been
  // phasing out `username` in favor of `nickname`; some workspaces / API
  // versions return one, the other, or both. Mirror the same fallback chain
  // in identity extraction (probeConnection + lib/auth.ts testConnection) so
  // `Reviewer.username` and `Identity.username` align.
  let username = '';
  if (typeof user.username === 'string' && user.username.length > 0) {
    username = user.username;
  } else if (typeof user.nickname === 'string' && user.nickname.length > 0) {
    username = user.nickname;
  } else if (typeof user.uuid === 'string' && user.uuid.length > 0) {
    username = user.uuid;
  } else {
    return null;
  }

  const displayName = typeof user.display_name === 'string' ? user.display_name : '';
  const avatarUrl =
    user.links && user.links.avatar && typeof user.links.avatar.href === 'string'
      ? user.links.avatar.href
      : '';
  // Bitbucket participant `state` varies across API versions / Server vs. Cloud:
  // "approved", "changes_requested" (Cloud), "needs_work" (Server/legacy), or
  // null/missing (pending). Lowercase before comparing for safety.
  const stateStr =
    typeof obj.state === 'string' ? obj.state.toLowerCase() : '';
  const approved = obj.approved === true || stateStr === 'approved';
  const changesRequested =
    stateStr === 'changes_requested' || stateStr === 'needs_work';

  return { username, displayName, avatarUrl, approved, changesRequested };
}

// ─── 3d. Cache + coalesce ───────────────────────────────────────────────────

type CacheEntry = { prs: PRState[]; fetchedAt: number };

const inflightFetches = new Map<string, Promise<PRState[]>>();

async function readCache(cacheKey: string): Promise<CacheEntry | null> {
  try {
    const raw = await browser.storage.session.get(cacheKey);
    const v = raw[cacheKey] as CacheEntry | undefined;
    if (
      v &&
      Array.isArray(v.prs) &&
      typeof v.fetchedAt === 'number'
    ) {
      return v;
    }
  } catch {
    // ignore
  }
  return null;
}

async function writeCache(cacheKey: string, prs: PRState[]): Promise<void> {
  try {
    await browser.storage.session.set({
      [cacheKey]: { prs, fetchedAt: Date.now() } satisfies CacheEntry,
    });
  } catch {
    // ignore
  }
}

function fetchAndCache(
  tenant: string,
  key: string,
  cacheKey: string,
): Promise<PRState[]> {
  const existing = inflightFetches.get(cacheKey);
  if (existing) return existing;

  const p = (async (): Promise<PRState[]> => {
    const prs = await runLinkageAndDetail(tenant, key);
    await writeCache(cacheKey, prs);
    return prs;
  })().finally(() => {
    inflightFetches.delete(cacheKey);
  });

  inflightFetches.set(cacheKey, p);
  return p;
}

async function runLinkageAndDetail(tenant: string, key: string): Promise<PRState[]> {
  // 1. Try Jira dev-status first.
  let links = await lookupViaDevStatus(tenant, key);

  // 2. If null/empty, fall back to a workspace scan when configured.
  if (!links || links.length === 0) {
    const [creds, settings] = await Promise.all([loadCredentials(), loadSettings()]);
    if (
      settings.workspaceSlug &&
      creds.username &&
      creds.token
    ) {
      links = await lookupViaBitbucketScan(creds, settings.workspaceSlug, key);
    } else {
      links = [];
    }
  }

  if (links.length === 0) return [];

  // 3. Fetch PR detail for each link. Need creds for this leg even if
  // dev-status produced the linkage (PR detail itself is Bitbucket-API).
  const creds = await loadCredentials();
  if (!creds.username || !creds.token) {
    // No creds — we can't read PR detail. Return empty (UI treats as "no PR").
    return [];
  }

  const details = await Promise.all(
    links.map((link) => fetchPRDetail(creds, link)),
  );
  return details.filter((d): d is PRState => d !== null);
}

// ─── 3e. Top-level orchestrator ─────────────────────────────────────────────

export async function getPRState(
  tenant: string,
  key: string,
): Promise<GetPRStateResponse> {
  if (!tenant || !key) {
    return { ok: false, error: 'Missing tenant or key', status: 0 };
  }
  const cacheKey = `${PR_CACHE_PREFIX}${tenant}:${key}`;

  try {
    const cached = await readCache(cacheKey);
    if (cached) {
      const age = Date.now() - cached.fetchedAt;
      if (age < PR_CACHE_TTL_MS) {
        return { ok: true, prs: cached.prs };
      }
      // Stale — return what we have AND fire a background refresh so the
      // next caller gets fresh data without paying the latency.
      void fetchAndCache(tenant, key, cacheKey).catch(() => {
        /* swallow — cache stays stale, next direct call will surface error */
      });
      return { ok: true, prs: cached.prs };
    }

    const prs = await fetchAndCache(tenant, key, cacheKey);
    return { ok: true, prs };
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
      error: 'Unexpected error fetching PR data',
      status: 0,
    };
  }
}

// ─── 3f. Username validation (Phase 7b) ─────────────────────────────────────

/**
 * Validate a single Bitbucket username against `GET /2.0/users/{username}`.
 *
 * Returns one of three shapes (see ValidateUsernameResponse):
 *   - { ok: true, valid: true, ...canonical fields }  on 200
 *   - { ok: true, valid: false }                       on 404
 *   - { ok: false, error, status }                     on auth/scope/network/other
 *
 * SECURITY: token is sent only via the Authorization header (via authHeader).
 * Token never appears in any returned `error` string. Catch blocks discard the
 * underlying error to avoid echoing URL or header context.
 *
 * Uses `throttledFetch` to share the 10-concurrent gate with the PR-state path.
 */
export async function validateUsername(
  creds: Credentials,
  username: string,
): Promise<ValidateUsernameResponse> {
  // Input validation — match the existing "not connected" wording so the UI
  // can route the user to settings consistently.
  const trimmed = (username || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Empty username', status: 0 };
  }
  if (!creds.username || !creds.token) {
    return {
      ok: false,
      error: 'Not connected — paste your token in settings.',
      status: 0,
    };
  }

  let header: string;
  try {
    header = authHeader(creds);
  } catch {
    return {
      ok: false,
      error: 'Username and token are required.',
      status: 0,
    };
  }

  const url = `https://api.bitbucket.org/2.0/users/${encodeURIComponent(trimmed)}`;

  let res: Response;
  try {
    res = await throttledFetch(url, {
      method: 'GET',
      headers: { Authorization: header, Accept: 'application/json' },
    });
  } catch {
    return {
      ok: false,
      error: 'Network error reaching api.bitbucket.org',
      status: 0,
    };
  }

  if (res.status === 404) {
    return { ok: true, valid: false };
  }
  if (res.status === 401) {
    return {
      ok: false,
      error: 'Token rejected. Re-paste in settings.',
      status: 401,
    };
  }
  if (res.status === 403) {
    const missing = await parseMissingScopes(res);
    return {
      ok: false,
      error: formatScopeError(missing),
      status: 403,
    };
  }
  if (!res.ok) {
    const trimmedText = (res.statusText || '').trim();
    let msg: string;
    if (res.status >= 500) {
      msg = `Bitbucket server error (HTTP ${res.status}${trimmedText ? ` ${trimmedText}` : ''}). Try again later.`;
    } else if (res.status === 429) {
      msg = 'Rate limited by Bitbucket. Wait a moment and try again.';
    } else {
      msg = `Unexpected response (HTTP ${res.status}${trimmedText ? ` ${trimmedText}` : ''}).`;
    }
    return { ok: false, error: msg, status: res.status };
  }

  let body: {
    username?: unknown;
    display_name?: unknown;
    links?: { avatar?: { href?: unknown } };
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return {
      ok: false,
      error: 'Failed to parse Bitbucket response.',
      status: res.status,
    };
  }

  const canonicalUsername =
    typeof body.username === 'string' && body.username.length > 0
      ? body.username
      : trimmed;
  const displayName =
    typeof body.display_name === 'string' ? body.display_name : '';
  const avatarUrl =
    body.links && body.links.avatar && typeof body.links.avatar.href === 'string'
      ? body.links.avatar.href
      : undefined;

  return {
    ok: true,
    valid: true,
    username: canonicalUsername,
    displayName,
    avatarUrl,
  };
}

// ─── 3g. Workspace member listing (v0.3.0) ──────────────────────────────────

/**
 * Hard cap on pages we'll walk per `GET /2.0/workspaces/{slug}/members` call.
 * 5 pages * 100 members/page = 500 members; that's well above any realistic
 * dev-team size. Anything beyond it is most likely an enterprise workspace
 * the user doesn't actually intend to scroll through anyway, and we'd rather
 * cap latency than return a "complete" answer.
 */
const WORKSPACE_MEMBERS_MAX_PAGES = 5;

/**
 * Fetch (and paginate) the member list for `workspaceSlug` from the Bitbucket
 * Cloud REST API. Used by the options-page approver picker — the worker
 * caches the mapped result in `chrome.storage.session` for 24h so the
 * autocomplete can fire on every keystroke without burning rate limit.
 *
 * SECURITY: token is sent only via the `Authorization` header (via
 * `authHeader`). Token never appears in returned `error` strings or warn
 * lines. Catch blocks discard the underlying error to avoid echoing URLs or
 * header context — this mirrors the rule observed throughout this module.
 */
export async function fetchWorkspaceMembers(
  creds: Credentials,
  workspaceSlug: string,
): Promise<WorkspaceMember[]> {
  const header = authHeader(creds);

  const out: WorkspaceMember[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined =
    `https://api.bitbucket.org/2.0/workspaces/${encodeURIComponent(workspaceSlug)}/members?pagelen=100&fields=values.user.username,values.user.uuid,values.user.display_name,values.user.links.avatar.href,next`;
  let pages = 0;

  while (cursor && pages < WORKSPACE_MEMBERS_MAX_PAGES) {
    pages += 1;
    let res: Response;
    try {
      res = await throttledFetch(cursor, {
        method: 'GET',
        headers: { Authorization: header, Accept: 'application/json' },
      });
    } catch {
      throw new BitbucketRequestError(0, 'Network error');
    }

    if (res.status === 401) throw new BitbucketAuthError();
    if (res.status === 403) throw await buildScopeErrorFromResponse(res);
    if (!res.ok) {
      throw new BitbucketRequestError(res.status, res.statusText);
    }

    let body: { values?: unknown; next?: unknown };
    try {
      body = (await res.json()) as { values?: unknown; next?: unknown };
    } catch {
      // Malformed response — keep what we have, stop walking.
      break;
    }

    const values = Array.isArray(body.values) ? body.values : [];
    for (const v of values) {
      const member = mapWorkspaceMember(v);
      if (!member) continue;
      const key = member.username.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(member);
    }

    cursor = typeof body.next === 'string' ? body.next : undefined;
  }

  if (cursor && pages >= WORKSPACE_MEMBERS_MAX_PAGES) {
    warnOnce(
      'workspace-members-truncated',
      `Workspace member listing truncated at ${out.length} members (>${WORKSPACE_MEMBERS_MAX_PAGES} pages)`,
    );
  }

  return out;
}

function mapWorkspaceMember(raw: unknown): WorkspaceMember | null {
  const obj = raw as {
    user?: {
      username?: unknown;
      uuid?: unknown;
      display_name?: unknown;
      links?: { avatar?: { href?: unknown } };
    };
  };
  const user = obj.user;
  if (!user) return null;

  let username = '';
  if (typeof user.username === 'string' && user.username.length > 0) {
    username = user.username;
  } else if (typeof user.uuid === 'string' && user.uuid.length > 0) {
    username = user.uuid;
  } else {
    return null;
  }

  const displayName =
    typeof user.display_name === 'string' ? user.display_name : '';
  const avatarUrl =
    user.links && user.links.avatar && typeof user.links.avatar.href === 'string'
      ? (user.links.avatar.href as string)
      : undefined;

  return { username, displayName, avatarUrl };
}
