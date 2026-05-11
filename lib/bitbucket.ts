/**
 * Bitbucket PR + reviewer types shared across the worker and the content
 * script. The worker computes these; the content script consumes them over
 * the message bus to drive card coloring and the branch-card hover popover
 * avatar row.
 *
 * Shape decisions:
 *   - `reviewers` is the filtered list of formal reviewers (Bitbucket
 *     `participants[]` entries with `role === 'REVIEWER'`). The worker
 *     filters at fetch time so consumers don't have to re-filter (and don't
 *     have to know that Bitbucket conflates the two arrays).
 *   - `username` (not display_name) is the stable identifier used to compare
 *     against `Settings.approvers`. On legacy workspaces where
 *     `participants[].user.username` is missing we fall back to `user.uuid`,
 *     which is also stable.
 */

export type Reviewer = {
  username: string;
  /**
   * Raw or braced Bitbucket UUID, captured independently of the username
   * priority chain (NOT a fallback for missing `username`). Some legacy
   * picker-stored allowlist entries arrive in braced UUID form
   * (`{7834d35b-…}`) because the workspace had already retired the
   * `username` field at picker time — `isReviewerAllowed` matches those
   * against this field after canonicalization.
   */
  uuid?: string;
  displayName: string;
  avatarUrl: string;
  approved: boolean;
  changesRequested: boolean;
};

export type PRState = {
  reviewers: Reviewer[];
};

/**
 * Canonicalize a Bitbucket identity token for comparison: lowercase + strip
 * surrounding `{...}` braces. Picker-stored UUIDs (which arrive braced from
 * the workspace API) and PR-participant UUIDs (also braced from the API)
 * collapse to the same key so allowlist membership compares byte-for-byte.
 */
export function canonicalizeIdentity(s: string): string {
  const t = s.trim().toLowerCase();
  return t.startsWith('{') && t.endsWith('}') ? t.slice(1, -1) : t;
}

/**
 * Test whether a PR reviewer matches any entry in the user's allowlist
 * (`Settings.approvers`). Tries each identity token the picker may have
 * stored — username, uuid, displayName — after canonicalization. An empty
 * allowlist short-circuits to `true` (no filter), mirroring the pre-allowlist
 * "show everyone" behavior.
 */
export function isReviewerAllowed(r: Reviewer, allowed: Set<string>): boolean {
  if (allowed.size === 0) return true;
  if (r.username && allowed.has(canonicalizeIdentity(r.username))) return true;
  if (r.uuid && allowed.has(canonicalizeIdentity(r.uuid))) return true;
  if (r.displayName && allowed.has(canonicalizeIdentity(r.displayName))) return true;
  return false;
}
