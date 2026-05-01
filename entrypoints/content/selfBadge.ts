/**
 * Self-status badge: a small SVG glyph rendered in each Review card's FOOTER
 * ROW, inserted into the same inline-flex row as the estimate, dev-info
 * wrapper, time-in-column tooltip, and priority icon — sitting immediately
 * BEFORE the dev-info wrapper so it reads left of the dev-info button while
 * remaining visually inline with the rest of the row. Indicates the connected
 * user's review state for that ticket's PR(s):
 *
 *   - approved          → green-circle-with-white-check
 *   - changes-requested → amber-circle-with-white-dash
 *   - none / no PR / no
 *     identity loaded    → no badge
 *
 * "The connected user" is the identity stashed by the worker after a successful
 * `/2.0/user` test-connection call (see `lib/settings.ts loadIdentity()`).
 * Matching against `Reviewer.username` is case-insensitive — Bitbucket's casing
 * for usernames is not always stable across endpoints.
 *
 * Aggregation across PRs uses the same prefer-approved priority the card
 * coloring engine applies: any PR approved → approved; else any PR with
 * changes-requested → changes-requested; else none. This keeps the title
 * badge in lock-step with the card-color decision the user already trusts.
 *
 * Wiring:
 *   - `onCardsChanged` (observer pub/sub) → re-sweep every tagged card.
 *   - `subscribeToKey` is NOT used here; the coloring orchestrator already
 *     primes `getCachedPRs` for every tagged key, and `onCardsChanged` fires
 *     after the network result settles, so a single re-sweep on that signal
 *     covers the freshness story without a per-key listener proliferation.
 *   - `onStorageChange` for `identityChanged` and `credentialsChanged` →
 *     reload identity and re-sweep, so a switched account / disconnect repaints
 *     badges live without a page reload.
 *
 * Fast-path remount: `observer.ts runFastPathPaint` calls `ensureSelfBadge`
 * synchronously alongside the existing `data-ej-state` write so the badge
 * survives Jira's virtualization unmount/remount churn without flashing.
 */

import type { GetPRStateResponse } from '../../lib/messages';
import type { Reviewer } from '../../lib/bitbucket';
import { loadIdentity, type Identity } from '../../lib/settings';
import { info, error as logError } from '../../lib/log';
import { findTaggedCards } from './board';
import { onCardsChanged } from './observer';
import {
  getCachedPRs,
  getCachedSelfState,
  setCachedSelfState,
} from './state';
import { onStorageChange } from './storageEvents';

export type SelfState = 'approved' | 'changes-requested' | 'none';

const STYLE_ID = 'ej-self-badge-styles';
const BADGE_ATTR = 'data-ej-self-badge';
const DEV_INFO_SELECTOR =
  '[data-testid="development-board-dev-info-icon.container"]';

/**
 * Inline style string applied directly to the wrapper `<span>`. Inline styles
 * beat virtually any cascade rule from Atlassian's compiled CSS, so this is
 * the most reliable layer in the defensive stack against the SVG getting
 * clipped at the bottom by the row's tight line-box. The matching CSS rules
 * in `STYLES` remain as a secondary safety net.
 */
const WRAPPER_INLINE_STYLE =
  'display:inline-flex;' +
  'align-items:center;' +
  'justify-content:center;' +
  'align-self:center;' +
  'width:14px;' +
  'height:14px;' +
  'vertical-align:middle;' +
  'margin:0 4px 0 0;' +
  'flex:0 0 auto;' +
  'flex-shrink:0;' +
  'line-height:0;';

/**
 * Inline styles for the badge wrapper. Inline-svg sizing is dictated by the
 * `width`/`height` attributes set in `buildBadgeSvg`; the wrapper sits inside
 * the footer's inline-flex row, so we mirror its `inline-flex` + `align-items:
 * center` layout and add a small right margin so the badge doesn't crowd the
 * dev-info wrapper that follows it.
 */
const STYLES = `
span[${BADGE_ATTR}] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: center;
  width: 14px;
  height: 14px;
  vertical-align: middle;
  margin: 0 4px 0 0;
  flex: 0 0 auto;
  flex-shrink: 0;
  line-height: 0;
}
span[${BADGE_ATTR}] svg {
  display: block;
  width: 14px;
  height: 14px;
  vertical-align: middle;
}
`;

let currentIdentity: Identity | null = null;
let started = false;
// One-time diagnostic flags — log identity + a sample reviewer the FIRST time
// each is observed during the session so the user can paste console output
// when the badge isn't showing up. We avoid spamming logs on every sweep.
let loggedIdentityOnce = false;
let loggedSampleReviewerOnce = false;

/**
 * Public entrypoint — install styles, load identity, subscribe to relevant
 * pub/sub channels, and run an initial sweep. Idempotent.
 */
export function startSelfBadge(): void {
  if (started) return;
  started = true;

  installStyles();

  void initialize();
}

async function initialize(): Promise<void> {
  currentIdentity = await loadIdentity();
  info('selfBadge active', currentIdentity ? `as @${currentIdentity.username}` : '(no identity)');

  // Storage events — identity may be set after the user tests connection, or
  // cleared on disconnect. credentialsChanged is also handled because clearing
  // credentials wipes identity (see clearCredentials in lib/settings.ts).
  onStorageChange((event) => {
    if (event.type === 'identityChanged') {
      currentIdentity = event.identity;
      sweep();
      return;
    }
    if (event.type === 'credentialsChanged') {
      // Credentials cleared also wipes identity, but the identity event may
      // not have fired yet (or may have fired before us). Reload to be safe.
      void loadIdentity().then((identity) => {
        currentIdentity = identity;
        sweep();
      }).catch((e) => {
        logError('selfBadge identity reload failed', e);
      });
    }
  });

  // Tag-pass + post-fetch hook (coloring's recolorAll resolves before this
  // listener fires for the same pass, but onCardsChanged is also re-emitted
  // by the observer on every mutation pass — so we stay in sync as PR data
  // arrives).
  onCardsChanged(() => {
    sweep();
  });

  // First pass for whatever's already on the board.
  sweep();
}

/**
 * Walk every tagged card, compute its self-state from the cached PR response
 * (if any), and ensure the badge matches. Cheap — pure DOM read + per-card
 * O(reviewers) scan, no network.
 */
function sweep(): void {
  const cards = findTaggedCards();
  // Per-sweep diagnostic: surface card count + identity-loaded flag so the
  // user can confirm the sweep is firing AND that identity has resolved.
  // Logged on every sweep (cheap) — toggle off via EJ_DEBUG if noisy.
  info('selfBadge: sweep over', cards.length, 'cards, identity loaded:', !!currentIdentity);
  // First-sweep one-shot diagnostics: pasting these into a bug report tells
  // us whether identity persisted at all and what the reviewer payload looks
  // like, so we can compare username fields without poking at storage.
  if (!loggedIdentityOnce) {
    loggedIdentityOnce = true;
    info('selfBadge: identity =', currentIdentity);
  }
  for (const card of cards) {
    const key = card.dataset.ejKey;
    if (!key) continue;
    if (!loggedSampleReviewerOnce) {
      const cached = getCachedPRs(key);
      if (cached && cached.ok && cached.prs.length > 0) {
        const firstPr = cached.prs[0];
        if (firstPr && firstPr.reviewers.length > 0) {
          loggedSampleReviewerOnce = true;
          info('selfBadge: sample reviewer for first card =', firstPr.reviewers[0]);
        }
      }
    }
    const state = computeSelfState(key);
    if (getCachedSelfState(key) !== state) {
      setCachedSelfState(key, state);
    }
    if (card.dataset.ejSelfState !== state) {
      card.dataset.ejSelfState = state;
    }
    ensureSelfBadge(card, state);
  }
}

/**
 * Aggregate the connected user's review state across every PR linked to
 * `key` using the same prefer-approved priority the coloring engine uses:
 *   - any PR has the user as approved → 'approved'
 *   - else any PR has the user as changes-requested → 'changes-requested'
 *   - else 'none'
 *
 * Returns 'none' when:
 *   - no identity is loaded (user hasn't tested connection yet);
 *   - no cached PRs (`getCachedPRs` undefined or fetch errored);
 *   - the user isn't listed as a reviewer on any PR.
 */
function computeSelfState(key: string): SelfState {
  if (!currentIdentity) return 'none';
  const usernameLower = currentIdentity.username.toLowerCase();
  const displayNameLower = currentIdentity.displayName.toLowerCase();
  if (usernameLower.length === 0 && displayNameLower.length === 0) return 'none';
  // UUIDs come from Bitbucket as `{...}`-wrapped braces on /2.0/user but as
  // bare UUIDs on participant payloads (and vice-versa across endpoints).
  // Pre-strip braces from the identity side once so the matcher's per-reviewer
  // strip is the only normalization needed inside the hot loop.
  const usernameStripped = stripBraces(usernameLower);

  const cached: GetPRStateResponse | undefined = getCachedPRs(key);
  if (!cached || !cached.ok) return 'none';

  let sawChangesRequested = false;
  for (const pr of cached.prs) {
    const me = findSelf(pr.reviewers, usernameLower, usernameStripped, displayNameLower);
    if (!me) continue;
    if (me.approved) return 'approved';
    if (me.changesRequested) sawChangesRequested = true;
  }
  return sawChangesRequested ? 'changes-requested' : 'none';
}

/**
 * Defensive widened match: try username equality, brace-stripped UUID
 * equality (Bitbucket sometimes wraps and sometimes doesn't), and finally
 * displayName equality. Each branch is a cheap lowercase compare; the array
 * is per-PR small so the linear sweep is fine.
 */
function findSelf(
  reviewers: Reviewer[],
  usernameLower: string,
  usernameStripped: string,
  displayNameLower: string,
): Reviewer | undefined {
  for (const r of reviewers) {
    const rUserLower = r.username.toLowerCase();
    if (usernameLower.length > 0 && rUserLower === usernameLower) return r;
    if (
      usernameStripped.length > 0 &&
      stripBraces(rUserLower) === usernameStripped
    ) {
      return r;
    }
    if (
      displayNameLower.length > 0 &&
      r.displayName.toLowerCase() === displayNameLower
    ) {
      return r;
    }
  }
  return undefined;
}

/**
 * Strip leading `{` and trailing `}` from a Bitbucket-style UUID string.
 * `/2.0/user` returns the wrapped form on some endpoints and the bare form
 * on others; participant payloads do the same independently. Strip on both
 * sides of the comparison so either shape matches the other.
 */
function stripBraces(s: string): string {
  if (s.length >= 2 && s.charCodeAt(0) === 123 && s.charCodeAt(s.length - 1) === 125) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Insert / update / remove the badge inside the card's footer ROW (the
 * inline-flex row that holds estimate, dev-info wrapper, time-in-column
 * tooltip, and priority icon), positioned immediately BEFORE the dev-info
 * wrapper so it sits inline with the row's other items.
 *
 * DOM walk: dev-info container (testid `development-board-dev-info-icon.container`)
 * → its immediate parent `<div>` (the dev-info WRAPPER, which contains only
 * the dev-info container) → THAT wrapper's parent (the FOOTER ROW, our
 * insertion target).
 *
 * Idempotent: if a badge is already present in the footer row and matches
 * `state` we no-op. Position-correcting: if the badge exists but is in the
 * wrong place (e.g. left over from the legacy mount inside the dev-info
 * wrapper), we move it to the correct slot via `insertBefore` on the footer
 * row. Removing on `state === 'none'` queries `card` (not the footer row) so
 * stale badges from any legacy position get cleaned up. If the dev-info
 * container or the wrapper/footer chain is missing (card has no linked PR or
 * Jira changed the layout) we cannot anchor anywhere, so we remove any prior
 * stray badge under the card and skip rendering.
 *
 * Exported for `observer.ts runFastPathPaint` so virtualized cards remounting
 * into the DOM get their badge applied synchronously alongside the cached
 * `data-ej-state` write — no flash on scroll-back.
 */
export function ensureSelfBadge(card: HTMLElement, state: SelfState): void {
  const devInfoContainer = card.querySelector<HTMLElement>(DEV_INFO_SELECTOR);

  if (!devInfoContainer) {
    // No anchor — drop any badge we may have left from a previous render
    // (search the whole card so legacy positions are covered too).
    const stale = card.querySelector<HTMLElement>(`[${BADGE_ATTR}]`);
    if (stale) stale.remove();
    return;
  }

  // Walk up: dev-info container → dev-info wrapper → footer row.
  const devInfoWrapper = devInfoContainer.parentElement;
  if (!devInfoWrapper) return;
  const footerRow = devInfoWrapper.parentElement;
  if (!footerRow) return;

  // For removal we look anywhere under the card so a stale badge from the
  // OLD mount point (inside the dev-info wrapper) also gets cleaned.
  if (state === 'none') {
    const anyExisting = card.querySelector<HTMLElement>(`[${BADGE_ATTR}]`);
    if (anyExisting) anyExisting.remove();
    return;
  }

  // Idempotency check — only consider direct children of the footer row so
  // we don't pick up legacy badges nested inside the dev-info wrapper (those
  // need re-homing, not a no-op).
  const existingInRow = footerRow.querySelector<HTMLElement>(
    `:scope > [${BADGE_ATTR}]`,
  );
  // Position correction — if a badge exists elsewhere under the card (e.g.
  // inside the dev-info wrapper from a previous mount), reuse it but move it
  // into the footer row at the correct slot.
  const existingAnywhere =
    existingInRow ?? card.querySelector<HTMLElement>(`[${BADGE_ATTR}]`);

  if (existingInRow && existingInRow.getAttribute(BADGE_ATTR) === state) {
    // Same state, already in row — verify it sits immediately before the
    // dev-info wrapper; if not, slide it into place.
    if (existingInRow.nextSibling !== devInfoWrapper) {
      footerRow.insertBefore(existingInRow, devInfoWrapper);
    }
    return;
  }

  if (existingAnywhere) {
    // State changed OR badge is in a stale position — rewrite the SVG in
    // place to keep DOM churn minimal, then ensure it lives in the footer
    // row immediately before the dev-info wrapper. Re-apply the inline style
    // string in case this badge was rendered by a prior build that didn't
    // set it (defensive against the bottom-clip bug on cached/remounted DOM).
    existingAnywhere.setAttribute(BADGE_ATTR, state);
    existingAnywhere.setAttribute('style', WRAPPER_INLINE_STYLE);
    existingAnywhere.innerHTML = buildBadgeSvg(state);
    if (
      existingAnywhere.parentElement !== footerRow ||
      existingAnywhere.nextSibling !== devInfoWrapper
    ) {
      footerRow.insertBefore(existingAnywhere, devInfoWrapper);
    }
    return;
  }

  const span = document.createElement('span');
  span.setAttribute(BADGE_ATTR, state);
  span.setAttribute('aria-hidden', 'true');
  // Inline styles beat Atlassian's compiled CSS cascade — this is the
  // most reliable layer of the defensive stack against bottom-clipping.
  span.setAttribute('style', WRAPPER_INLINE_STYLE);
  span.innerHTML = buildBadgeSvg(state);
  // Insert into the footer row, immediately before the dev-info wrapper —
  // this puts the badge inline with estimate / dev-info / tooltip / priority.
  footerRow.insertBefore(span, devInfoWrapper);
}

/**
 * The two badge SVGs share viewBox / size with the avatar status badges in
 * branchHoverCard.ts but render at 14×14 to sit in parity with the ~16×16
 * dev-info icon in the card footer.
 */
function buildBadgeSvg(state: 'approved' | 'changes-requested'): string {
  // Inline `display:block` is the load-bearing fix for the bottom-clipping
  // bug: SVGs default to `display:inline` with `vertical-align:baseline`,
  // which leaves descender space below the icon and gets the bottom 2-3px
  // clipped inside the footer row's tight line-box. `vertical-align:middle`
  // is a secondary defense in case any path keeps it inline.
  const svgStyle = 'display:block;vertical-align:middle;width:14px;height:14px;';
  if (state === 'approved') {
    return (
      `<svg viewBox="0 0 8 8" width="14" height="14" style="${svgStyle}" xmlns="http://www.w3.org/2000/svg">` +
      '<circle fill="var(--ds-icon-success, #6A9A23)" cx="4" cy="4" r="4"></circle>' +
      '<path fill="var(--ds-surface-overlay, #FFFFFF)" ' +
      'd="M3.46 5.49 2.2 4.23a.4.4 0 0 1 .57-.57l.97.97 1.5-1.5a.4.4 0 1 1 .56.57L3.46 5.49Z"/>' +
      '</svg>'
    );
  }
  return (
    `<svg viewBox="0 0 8 8" width="14" height="14" style="${svgStyle}" xmlns="http://www.w3.org/2000/svg">` +
    '<circle fill="var(--ds-icon-warning, #B38600)" cx="4" cy="4" r="4"></circle>' +
    '<rect fill="var(--ds-surface-overlay, #FFFFFF)" x="1.8" y="3.5" width="4.4" height="1" rx="0.5"></rect>' +
    '</svg>'
  );
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
}
