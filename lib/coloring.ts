/**
 * Pure card-state derivation. No DOM, no storage, no fetches — all inputs are
 * the typed values we already compute upstream. Re-used by the content-script
 * coloring orchestrator (P5) and the tooltip (P6).
 *
 * Rule precedence (when aggregating multiple PRs):
 *   red     — any reviewer has changesRequested === true
 *   green   — minApprovals satisfied AND every required approver has approved
 *   pending — has a PR but isn't red or green (not enough approvals OR a
 *             required approver hasn't approved yet). NO color override is
 *             applied for pending — the card keeps Jira's default surface.
 *
 * Username comparison is case-insensitive: Bitbucket treats usernames as
 * case-insensitive in practice, and we don't want a config typo capitalising
 * "Alex" vs "alex" to silently break the gate.
 *
 * "Required approver" set (v0.3.0): `settings.approvers` filtered to entries
 * with `isRequired: true`. Tracked-but-optional entries (`isRequired: false`)
 * are surfaced in the options-page table but ignored here.
 *
 * Required approvers are checked against `reviewers` only (formal reviewers),
 * NOT `participants` (which includes drive-by commenters). Drive-by approvals
 * don't count toward the threshold.
 *
 * Edge cases:
 *   - a required username is not present in reviewers → not approved by them
 *     → falls through to pending (or red, if changes-requested fired).
 *   - no required entries → the "every required approver approved" check is
 *     vacuously true; only minApprovals matters.
 */

import type { PRState } from './bitbucket';
import type { Settings } from './settings';

export type CardState =
  | 'green'
  | 'pending'
  | 'red'
  | 'no-pr'
  | 'unknown'
  | 'error';

export function deriveCardStateForPR(
  pr: PRState,
  settings: Settings,
): 'green' | 'pending' | 'red' {
  const reviewers = pr.reviewers;

  // Red short-circuit: any reviewer has explicitly requested changes.
  for (const r of reviewers) {
    if (r.changesRequested) return 'red';
  }

  // Approval count from formal reviewers only.
  const approvedCount = reviewers.reduce(
    (n, r) => (r.approved ? n + 1 : n),
    0,
  );
  if (approvedCount < settings.minApprovals) return 'pending';

  // Every required approver must be present in reviewers AND approved.
  // Computed from the new `approvers` shape (v0.3.0): only entries with
  // `isRequired: true` participate. Empty result → vacuously true.
  const requiredLowered = settings.approvers
    .filter((a) => a.isRequired)
    .map((a) => a.username.toLowerCase());
  for (const required of requiredLowered) {
    const match = reviewers.find(
      (r) => r.username.toLowerCase() === required && r.approved,
    );
    if (!match) return 'pending';
  }

  return 'green';
}

/**
 * Aggregate state across N PRs linked to a single issue.
 *
 *   - prs.length === 0  → 'no-pr'
 *   - any red           → 'red'
 *   - else any green    → 'green'
 *   - else              → 'pending'
 *
 * Note: 'pending' is the "absence of positive signal" state — the card keeps
 * Jira's default surface color. Red still beats green because a single
 * changes-requested PR should dominate, but green beats pending so a
 * sibling PR fully approved still gets the green badge even when another
 * sibling is still waiting on review.
 */
export function aggregateCardState(
  prs: PRState[],
  settings: Settings,
): CardState {
  if (prs.length === 0) return 'no-pr';

  let sawGreen = false;
  for (const pr of prs) {
    const s = deriveCardStateForPR(pr, settings);
    if (s === 'red') return 'red'; // can't get worse
    if (s === 'green') sawGreen = true;
  }
  return sawGreen ? 'green' : 'pending';
}
