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
  displayName: string;
  avatarUrl: string;
  approved: boolean;
  changesRequested: boolean;
};

export type PRState = {
  reviewers: Reviewer[];
};
