/**
 * Bitbucket auth helpers.
 *
 * SECURITY RULES — DO NOT BACKSLIDE IN FUTURE PHASES:
 *   1. Never log the API token. Not via console.log, not via console.error,
 *      not in thrown error messages, not in returned error strings.
 *   2. Never put the token in a URL query param. The ONLY transport is the
 *      `Authorization: Basic ...` HTTP header on api.bitbucket.org requests.
 *   3. Never JSON.stringify the full Credentials object on a code path that
 *      reaches a logger or telemetry sink. If you must debug-log credentials
 *      state, log only the username and a redacted marker like
 *      `<token: present>` / `<token: missing>`.
 *   4. Never include the token in any TestConnectionResult or response shape
 *      that crosses the message boundary between background ↔ UI.
 *
 * Future: OAuth 2.0 path (deferred, post-v1).
 *   Requires a Bitbucket workspace admin to register an OAuth Consumer.
 *   Would use chrome.identity.launchWebAuthFlow against
 *   `https://bitbucket.org/site/oauth2/authorize` with PKCE.
 *   Would replace the user-supplied API token with a managed
 *   access_token + refresh_token pair stored the same way
 *   (chrome.storage.local).
 *   Current API-token path stays as a fallback for users in
 *   admin-restricted workspaces.
 *   Manifest would need the `identity` permission added at that point.
 *   (Not added in v1 — we are not implementing OAuth here.)
 */

import type { Credentials } from './settings';

const BITBUCKET_USER_ENDPOINT = 'https://api.bitbucket.org/2.0/user';

/**
 * Build the `Authorization: Basic ...` header value for the given credentials.
 * Throws if username or token is empty so callers can surface that mistake
 * loudly instead of firing off a malformed request.
 *
 * NB: the returned string contains the token (encoded). Treat it like the
 * token itself — never log it, never persist it outside of an in-flight
 * `fetch` invocation.
 */
export function authHeader(c: Credentials): string {
  if (!c.username || !c.token) {
    throw new Error('authHeader: username and token are required');
  }
  return 'Basic ' + btoa(`${c.username}:${c.token}`);
}

export type TestConnectionResult =
  | { ok: true; username: string; displayName?: string }
  | { ok: false; status: number; error: string };

/**
 * Probe `GET /2.0/user` with the supplied credentials.
 *
 * Accepts credentials as a parameter (not via storage lookup) so the options
 * page can validate UNSAVED form values before letting the user click Save.
 *
 * Token never appears in any returned error string or any console output.
 */
export async function testConnection(c: Credentials): Promise<TestConnectionResult> {
  let header: string;
  try {
    header = authHeader(c);
  } catch {
    return {
      ok: false,
      status: 0,
      error: 'Username and token are required.',
    };
  }

  let res: Response;
  try {
    res = await fetch(BITBUCKET_USER_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: header,
        Accept: 'application/json',
      },
    });
  } catch {
    // Intentionally do NOT include the underlying error — could in theory
    // contain URL fragments or upstream details. Generic message only.
    return {
      ok: false,
      status: 0,
      error: 'Network error reaching api.bitbucket.org',
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
      // Extraction priority mirrors mapParticipant in
      // entrypoints/background/bitbucket.ts: username → nickname → uuid.
      // Bitbucket Cloud has been phasing out `username` in favor of
      // `nickname`, so on some workspaces the legacy `username` field is
      // empty / missing. Falling back keeps `Identity.username` aligned with
      // `Reviewer.username` so the self-status badge matcher resolves.
      let username = '';
      if (typeof body.username === 'string' && body.username.length > 0) {
        username = body.username;
      } else if (typeof body.nickname === 'string' && body.nickname.length > 0) {
        username = body.nickname;
      } else if (typeof body.uuid === 'string' && body.uuid.length > 0) {
        username = body.uuid;
      }
      const displayName = typeof body.display_name === 'string' ? body.display_name : undefined;
      if (!username) {
        return {
          ok: false,
          status: res.status,
          error: 'Bitbucket returned an unexpected response shape.',
        };
      }
      return { ok: true, username, displayName };
    } catch {
      return {
        ok: false,
        status: res.status,
        error: 'Failed to parse Bitbucket response.',
      };
    }
  }

  if (res.status === 401) {
    return {
      ok: false,
      status: 401,
      error: 'Token rejected. Re-paste in settings or generate a new token.',
    };
  }
  if (res.status === 403) {
    return {
      ok: false,
      status: 403,
      error: await explain403(res),
    };
  }

  return {
    ok: false,
    status: res.status,
    error: humanizeStatus(res.status, res.statusText),
  };
}

/**
 * Parse a Bitbucket 403 response body to extract the verbatim list of
 * missing/required scope IDs.
 *
 * Bitbucket 403 shape (verbatim):
 *
 *     {
 *       "type": "error",
 *       "error": {
 *         "message": "Your credentials lack one or more required privilege scopes.",
 *         "detail": {
 *           "required": ["read:workspace:bitbucket"],
 *           "granted":  ["read:user:bitbucket", "read:pullrequest:bitbucket"]
 *         }
 *       }
 *     }
 *
 * Returns an empty array if the body is missing / malformed / shape-mismatched
 * — callers should fall back to a static "Token missing required scopes"
 * message in that case.
 *
 * SECURITY: only string values from `error.detail.required[]` are returned;
 * caller must NOT splice in the request URL, headers, or any other fetch
 * context — they could carry credentials.
 */
export async function parseMissingScopes(r: Response): Promise<string[]> {
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    return [];
  }
  return extractMissingScopes(body);
}

/**
 * Pure-data variant of `parseMissingScopes` for callers that have already
 * consumed the response body once (the `Response` body stream can't be read
 * twice).
 */
export function extractMissingScopes(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return [];
  const detail = (error as { detail?: unknown }).detail;
  if (!detail || typeof detail !== 'object') return [];
  const required = (detail as { required?: unknown }).required;
  if (!Array.isArray(required)) return [];
  return required.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/**
 * Humanize a 403 from Bitbucket into a user-facing error string. Tries to
 * parse the response body for the verbatim missing-scope list; falls back to
 * a static message if parsing fails. Never echoes URLs, headers, or token
 * material — only the scope IDs Bitbucket itself put in the response body.
 */
export async function explain403(r: Response): Promise<string> {
  const missing = await parseMissingScopes(r);
  return formatScopeError(missing);
}

/**
 * Compose the user-facing missing-scope string from a parsed list. Pure
 * helper so callers that already have the parsed scopes (e.g. from
 * `extractMissingScopes`) don't need to re-walk the response.
 */
export function formatScopeError(missingScopes: string[]): string {
  if (missingScopes.length === 0) {
    return 'Token missing required scopes. See the SetupGuide for the full scope list.';
  }
  const noun = missingScopes.length === 1 ? 'scope' : 'scopes';
  return `Token missing ${noun}: ${missingScopes.join(', ')}. Regenerate the token with ${missingScopes.length === 1 ? 'this scope' : 'these scopes'} added.`;
}

function humanizeStatus(status: number, statusText: string): string {
  const trimmed = (statusText || '').trim();
  if (status >= 500) {
    return `Bitbucket server error (HTTP ${status}${trimmed ? ` ${trimmed}` : ''}). Try again later.`;
  }
  if (status === 429) {
    return 'Rate limited by Bitbucket. Wait a moment and try again.';
  }
  if (status === 404) {
    return 'Endpoint not found (HTTP 404). Bitbucket API may have moved.';
  }
  return `Unexpected response (HTTP ${status}${trimmed ? ` ${trimmed}` : ''}).`;
}
