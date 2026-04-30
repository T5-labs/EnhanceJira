/**
 * Bitbucket PR + reviewer types shared across the worker and (eventually) the
 * content script. The worker computes these; the content script consumes them
 * over the message bus to drive coloring (P5) and tooltip rendering (P6).
 *
 * Shape decisions:
 *   - `participants` is the FULL list (any role); `reviewers` is the filtered
 *     subset where role === 'REVIEWER'. We compute both at fetch time so the
 *     consumer doesn't have to re-filter (and doesn't have to know that
 *     Bitbucket conflates the two arrays).
 *   - `username` (not display_name) is the stable identifier used to compare
 *     against `Settings.requiredApprovers`. On legacy workspaces where
 *     `participants[].user.username` is missing we fall back to `user.uuid`,
 *     which is also stable.
 *   - `buildState` is left undefined here; P6 populates it via
 *     `/commit/{sha}/statuses`.
 */

export type Reviewer = {
  username: string;
  displayName: string;
  avatarUrl: string;
  role: 'REVIEWER' | 'PARTICIPANT';
  approved: boolean;
  changesRequested: boolean;
};

export type PRState = {
  key: string;
  url: string;
  title: string;
  sourceBranch: string;
  buildState?: 'SUCCESS' | 'FAILED' | 'INPROGRESS' | 'STOPPED';
  reviewers: Reviewer[];
  participants: Reviewer[];
  workspace: string;
  repoSlug: string;
  prId: number;
  /**
   * Bitbucket username of the PR author. Stable identifier (falls back to
   * `user.uuid` if `username` is missing, matching the participant mapping
   * convention). Compared case-insensitively against the connected user's
   * identity to drive the `Settings.scope === 'mine'` filter (v0.2.0).
   */
  authorUsername: string;
  /** Display name of the PR author — used in the tooltip header. */
  authorDisplayName: string;
  /** Avatar URL of the PR author — best-effort, may be empty. */
  authorAvatarUrl?: string;
};
