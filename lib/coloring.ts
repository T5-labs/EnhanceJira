/**
 * Pure card-state derivation. No DOM, no storage, no fetches — all inputs are
 * the typed values we already compute upstream. Re-used by the content-script
 * coloring orchestrator (P5) and the tooltip (P6).
 *
 * Rule precedence (worst-wins when aggregating multiple PRs):
 *   red    — any reviewer has changesRequested === true
 *   yellow — has reviewers but isn't green
 *   green  — minApprovals satisfied AND every required approver has approved
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
 *     → falls through to yellow (or red, if changes-requested fired).
 *   - no required entries → the "every required approver approved" check is
 *     vacuously true; only minApprovals matters.
 */

import type { PRState } from './bitbucket';
import type { Settings } from './settings';

export type CardState = 'green' | 'yellow' | 'red' | 'no-pr' | 'unknown' | 'error';

export function deriveCardStateForPR(
  pr: PRState,
  settings: Settings,
): 'green' | 'yellow' | 'red' {
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
  if (approvedCount < settings.minApprovals) return 'yellow';

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
    if (!match) return 'yellow';
  }

  return 'green';
}

/**
 * Aggregate state across N PRs linked to a single issue.
 *
 *   - prs.length === 0  → 'no-pr'
 *   - otherwise         → worst of red > yellow > green across all PRs
 *
 * One red sibling is enough to make the card red.
 */
export function aggregateCardState(
  prs: PRState[],
  settings: Settings,
): CardState {
  if (prs.length === 0) return 'no-pr';

  let worst: 'green' | 'yellow' | 'red' = 'green';
  for (const pr of prs) {
    const s = deriveCardStateForPR(pr, settings);
    if (s === 'red') return 'red'; // can't get worse
    if (s === 'yellow' && worst === 'green') worst = 'yellow';
  }
  return worst;
}
