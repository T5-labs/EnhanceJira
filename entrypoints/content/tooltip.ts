/**
 * Hover tooltip for tagged Review-column cards.
 *
 * Single shared DOM node mounted under <body>. Content swaps on each card
 * hover; the same element is repositioned and re-rendered. No React, no
 * per-card mounts.
 *
 * Lifecycle:
 *   - 200ms hover delay before show (ignore drive-by mouseovers)
 *   - 80ms leave grace before hide (allow user to move from card → tooltip
 *     without dismissing — the tooltip is interactive: it has a clickable PR
 *     link the user may want to reach)
 *   - ESC dismisses immediately
 *   - prefers-reduced-motion: no fade-in transition
 *
 * Position: right of card by default; flips to the left of the card if it
 * would clip the right edge of the viewport. Vertical clamping if it would
 * overflow the bottom. Pinned to top-right corner as a last-resort fallback
 * for very small viewports.
 */

import type { PRState, Reviewer } from '../../lib/bitbucket';
import {
  aggregateCardState,
  deriveCardStateForPR,
  type CardState,
} from '../../lib/coloring';
import {
  loadSettings,
  type Settings,
} from '../../lib/settings';
import { debug } from '../../lib/log';
import { onCardsChanged, findTaggedCards } from './observer';
import { getCachedPRs, requestPRs, subscribeToKey } from './state';
import { onStorageChange } from './storageEvents';

const SHOW_DELAY_MS = 200;
// Tightened from 100ms to 80ms — the previous delay let the tooltip linger
// noticeably after mouseleave. 80ms is still long enough for a card→tooltip
// transit (handled separately by the tooltip's own mouseenter cancelHide
// path) but short enough that an off-board mouse exit feels responsive.
const HIDE_GRACE_MS = 80;
const TOOLTIP_ID = 'ej-tooltip';
const STYLE_ID = 'ej-tooltip-styles';

const TOOLTIP_CSS = `
#${TOOLTIP_ID} {
  position: fixed;
  z-index: 999999;
  display: none;
  max-width: 360px;
  padding: 12px;
  background: #ffffff;
  color: #172b4d;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  font: 13px system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.4;
  opacity: 0;
  transition: opacity 120ms ease-out;
  pointer-events: auto;
  box-sizing: border-box;
}
#${TOOLTIP_ID}.ej-visible { opacity: 1; }
#${TOOLTIP_ID} a { color: #0052cc; text-decoration: none; }
#${TOOLTIP_ID} a:hover { text-decoration: underline; }
#${TOOLTIP_ID} .ej-pr { margin: 0; }
#${TOOLTIP_ID} .ej-pr + .ej-pr { margin-top: 12px; padding-top: 12px; border-top: 1px solid #dfe1e6; }
#${TOOLTIP_ID} .ej-title { font-weight: 600; margin: 0 0 4px 0; display: flex; align-items: center; gap: 4px; }
#${TOOLTIP_ID} .ej-title-link { display: inline-flex; align-items: baseline; gap: 4px; }
#${TOOLTIP_ID} .ej-ext-icon { font-size: 11px; opacity: 0.7; }
#${TOOLTIP_ID} .ej-summary { font-size: 12px; color: #5e6c84; margin: 0 0 6px 0; }
#${TOOLTIP_ID} .ej-status-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px 0;
}
#${TOOLTIP_ID} .ej-status-row .ej-summary { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${TOOLTIP_ID} .ej-state {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  flex: 0 0 auto;
}
#${TOOLTIP_ID} .ej-state-success { background: #e3fcef; color: #006644; }
#${TOOLTIP_ID} .ej-state-warning { background: #fffae6; color: #974f0c; }
#${TOOLTIP_ID} .ej-state-failure { background: #ffebe6; color: #bf2600; }
#${TOOLTIP_ID} .ej-state-unknown { background: #ebecf0; color: #42526e; }
#${TOOLTIP_ID} .ej-divider { border: 0; border-top: 1px solid #dfe1e6; margin: 8px 0; }
#${TOOLTIP_ID} .ej-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 12px; }
#${TOOLTIP_ID} .ej-row-icon { width: 14px; text-align: center; flex: 0 0 14px; }
#${TOOLTIP_ID} .ej-row-icon-approved { color: #006644; }
#${TOOLTIP_ID} .ej-row-icon-changes  { color: #bf2600; }
#${TOOLTIP_ID} .ej-row-icon-pending  { color: #5e6c84; }
#${TOOLTIP_ID} .ej-row-icon-comment  { color: #5e6c84; }
#${TOOLTIP_ID} .ej-avatar { width: 20px; height: 20px; border-radius: 50%; flex: 0 0 20px; background: #dfe1e6; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; color: #42526e; font-weight: 600; overflow: hidden; }
#${TOOLTIP_ID} .ej-avatar img { width: 20px; height: 20px; display: block; }
#${TOOLTIP_ID} .ej-name { color: #172b4d; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${TOOLTIP_ID} .ej-handle { color: #5e6c84; font-size: 11px; white-space: nowrap; }
#${TOOLTIP_ID} .ej-section-label { font-size: 11px; color: #5e6c84; margin: 8px 0 4px 0; text-transform: uppercase; letter-spacing: 0.04em; }
#${TOOLTIP_ID} .ej-empty { font-size: 13px; color: #172b4d; }
#${TOOLTIP_ID} .ej-empty-hint { font-size: 12px; color: #5e6c84; margin-top: 6px; }
#${TOOLTIP_ID} .ej-error-msg { font-size: 12px; color: #5e6c84; margin: 6px 0; }
#${TOOLTIP_ID} .ej-loading { font-size: 13px; color: #5e6c84; }
@media (prefers-reduced-motion: reduce) {
  #${TOOLTIP_ID} { transition: none; }
}
`;

let tooltipEl: HTMLDivElement | null = null;
let activeCard: HTMLElement | null = null;
let activeKey: string | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let cardsHovered: WeakSet<HTMLElement> = new WeakSet();
let stateUnsub: (() => void) | null = null;
let currentSettings: Settings | null = null;
const loggedShown = new Set<string>();

/**
 * Public entrypoint. Idempotent: safe to call once per content-script
 * lifetime; will not double-mount.
 */
export function startTooltip(): void {
  if (document.getElementById(TOOLTIP_ID)) return;

  installTooltipStyles();
  tooltipEl = createTooltipEl();
  document.body.appendChild(tooltipEl);

  // Tooltip itself participates in the hover loop — entering it cancels the
  // pending hide, leaving it starts one.
  tooltipEl.addEventListener('mouseenter', cancelHide);
  tooltipEl.addEventListener('mouseleave', scheduleHide);

  // Document-level delegation: covers cards added/removed by Atlassian's
  // virtualization without us having to re-attach per-card listeners.
  document.addEventListener('mouseover', onMouseOver, { capture: true });
  document.addEventListener('mouseout', onMouseOut, { capture: true });

  // ESC dismisses.
  window.addEventListener('keydown', onKeyDown, { capture: true });

  // Settings drive aggregation in summary / loaded states.
  void loadSettings().then((s) => {
    currentSettings = s;
  });
  // Shared storage fan-out — single listener installed in storageEvents.ts.
  onStorageChange((event) => {
    if (event.type === 'settingsChanged') {
      currentSettings = event.settings;
      // Re-render in place so summary aggregation reflects the new
      // minApprovals / required-approver set.
      if (activeKey && tooltipEl?.classList.contains('ej-visible')) {
        renderForKey(activeKey);
      }
      return;
    }
    // identityChanged is no longer consumed here in v0.3.0 (the scope filter
    // was removed). The event still fires for ConnectedCard on the options
    // page; we just don't react to it from the tooltip surface.
  });

  // When the tag-pass set changes, drop our hovered-set bookkeeping for
  // cards that left the board.
  onCardsChanged(() => {
    cardsHovered = new WeakSet();
    const live = new Set<HTMLElement>(findTaggedCards());
    if (activeCard && !live.has(activeCard)) {
      hideNow();
    }
  });
}

function installTooltipStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = TOOLTIP_CSS;
  document.head.appendChild(style);
}

function createTooltipEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.id = TOOLTIP_ID;
  el.setAttribute('role', 'tooltip');
  return el;
}

// ─── Hover wiring ───────────────────────────────────────────────────────────

function onMouseOver(e: MouseEvent): void {
  const target = e.target as Element | null;
  if (!target) return;
  // If we entered the tooltip itself, the tooltip's own listener handles it.
  if (tooltipEl && (target === tooltipEl || tooltipEl.contains(target))) {
    return;
  }
  const card = (target as Element).closest('[data-ej-key]') as HTMLElement | null;
  if (!card) return;
  const key = card.dataset.ejKey;
  if (!key) return;

  // Already showing for this card — nothing to do.
  if (activeCard === card) {
    cancelHide();
    return;
  }

  cardsHovered.add(card);
  scheduleShow(card, key);
}

function onMouseOut(e: MouseEvent): void {
  const target = e.target as Element | null;
  if (!target) return;
  if (tooltipEl && (target === tooltipEl || tooltipEl.contains(target))) {
    return;
  }
  const card = (target as Element).closest('[data-ej-key]') as HTMLElement | null;
  if (!card) return;

  // Only act on transitions that LEAVE the card entirely (not internal moves).
  const related = e.relatedTarget as Element | null;
  if (related && card.contains(related)) return;
  // If we're leaving into the tooltip itself, that's a transit — not a leave.
  if (related && tooltipEl && (related === tooltipEl || tooltipEl.contains(related))) {
    return;
  }

  if (showTimer !== null && activeCard === null) {
    // Pending show that never fired — cancel it.
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (activeCard === card) {
    scheduleHide();
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (showTimer !== null) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (tooltipEl && tooltipEl.style.display !== 'none') {
    debug('tooltip dismissed via ESC');
    hideNow();
  }
}

function scheduleShow(card: HTMLElement, key: string): void {
  if (showTimer !== null) clearTimeout(showTimer);
  cancelHide();
  showTimer = setTimeout(() => {
    showTimer = null;
    showFor(card, key);
  }, SHOW_DELAY_MS);
}

function scheduleHide(): void {
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    hideNow();
  }, HIDE_GRACE_MS);
}

function cancelHide(): void {
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function hideNow(): void {
  if (!tooltipEl) return;
  tooltipEl.classList.remove('ej-visible');
  tooltipEl.style.display = 'none';
  activeCard = null;
  if (stateUnsub) {
    stateUnsub();
    stateUnsub = null;
  }
  activeKey = null;
}

function showFor(card: HTMLElement, key: string): void {
  if (!tooltipEl) return;
  if (!card.isConnected) return;

  activeCard = card;
  activeKey = key;

  // Cleanup any prior subscription.
  if (stateUnsub) {
    stateUnsub();
    stateUnsub = null;
  }

  // Show and position with whatever we have right now (could be cached, could
  // be a loading placeholder).
  renderForKey(key);
  if (activeKey !== key) return;
  tooltipEl.style.display = 'block';
  positionTooltip(card, tooltipEl);
  // Force layout-pass before fade-in for the transition to apply.
  void tooltipEl.offsetHeight;
  tooltipEl.classList.add('ej-visible');

  if (!loggedShown.has(key)) {
    loggedShown.add(key);
    debug(`tooltip shown for ${key}`);
  }

  // Subscribe so async fetches re-render in place.
  stateUnsub = subscribeToKey(key, () => {
    if (activeKey === key && tooltipEl) {
      renderForKey(key);
      // Re-position in case content size changed.
      if (activeCard && activeCard.isConnected) {
        positionTooltip(activeCard, tooltipEl);
      }
    }
  });

  // Kick a fetch (no force — uses cooldown). If cached and fresh, no-op.
  void requestPRs(key, window.location.host).then(() => {
    if (activeKey === key && tooltipEl) {
      renderForKey(key);
      if (activeCard && activeCard.isConnected) {
        positionTooltip(activeCard, tooltipEl);
      }
    }
  });
}

// ─── Render ─────────────────────────────────────────────────────────────────

function renderForKey(key: string): void {
  if (!tooltipEl) return;
  const cached = getCachedPRs(key);

  if (!cached) {
    // First hover for this key — show loading until fetch settles.
    tooltipEl.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'ej-loading';
    div.textContent = 'Loading PR data...';
    tooltipEl.appendChild(div);
    return;
  }

  if (!cached.ok) {
    renderError(cached.error);
    return;
  }

  if (cached.prs.length === 0) {
    renderEmpty();
    return;
  }

  renderLoaded(cached.prs);
}

function renderEmpty(): void {
  if (!tooltipEl) return;
  tooltipEl.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'ej-empty';
  head.textContent = 'No linked PR found';
  const hint = document.createElement('div');
  hint.className = 'ej-empty-hint';
  hint.textContent =
    'Branch should contain the issue key (e.g. CMMS-1234-fix-thing).';
  tooltipEl.append(head, hint);
}

function renderError(message: string): void {
  if (!tooltipEl) return;
  tooltipEl.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'ej-empty';
  head.textContent = "Couldn't load PR data";
  const msg = document.createElement('div');
  msg.className = 'ej-error-msg';
  msg.textContent = message;
  const hint = document.createElement('div');
  hint.className = 'ej-empty-hint';
  hint.textContent = 'Open Settings to check your token.';
  tooltipEl.append(head, msg, hint);
}

function renderLoaded(prs: PRState[]): void {
  if (!tooltipEl) return;
  tooltipEl.innerHTML = '';

  // Multi-PR summary at the top.
  if (prs.length > 1 && currentSettings) {
    const worst: CardState = aggregateCardState(prs, currentSettings);
    const summary = document.createElement('div');
    summary.className = 'ej-summary';
    summary.textContent = `${prs.length} PRs · worst state: ${worst}`;
    tooltipEl.appendChild(summary);
  }

  prs.forEach((pr, idx) => {
    const block = document.createElement('div');
    block.className = 'ej-pr';

    // Title row (linked). Headline format:
    //   "<key> <title> — by <displayName> (@authorUsername) ↗"
    // Author suffix kept after the v0.3.0 scope-filter removal — the tooltip
    // is now always team-overview, and the author byline is exactly the
    // useful disambiguator for that mode.
    const title = document.createElement('div');
    title.className = 'ej-title';
    const headline = `${pr.key} ${pr.title}`.trim();
    // Match the reviewer/participant rule: never echo a `{uuid}` username
    // into the visible byline. If we only have the uuid fallback, drop the
    // `(@…)` parenthetical and lean on the display name (task b).
    const authorIsUuid = isUuidUsername(pr.authorUsername);
    let authorSuffix = '';
    if (pr.authorUsername) {
      const visibleName = pr.authorDisplayName || (authorIsUuid ? '' : pr.authorUsername);
      if (visibleName && !authorIsUuid) {
        authorSuffix = ` — by ${visibleName} (@${pr.authorUsername})`;
      } else if (visibleName) {
        authorSuffix = ` — by ${visibleName}`;
      }
    }
    const headlineWithAuthor = `${headline}${authorSuffix}`;
    if (pr.url) {
      const a = document.createElement('a');
      a.href = pr.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'ej-title-link';
      const text = document.createElement('span');
      text.textContent = headlineWithAuthor;
      const ext = document.createElement('span');
      ext.className = 'ej-ext-icon';
      ext.textContent = '↗';
      a.append(text, ext);
      title.appendChild(a);
    } else {
      title.textContent = headlineWithAuthor;
    }
    block.appendChild(title);

    // Per-PR summary line (approval counts).
    const approvedCount = pr.reviewers.reduce(
      (n, r) => (r.approved ? n + 1 : n),
      0,
    );
    const changesCount = pr.reviewers.reduce(
      (n, r) => (r.changesRequested ? n + 1 : n),
      0,
    );
    const reviewerCount = pr.reviewers.length;

    // Status row: approval-count summary on the LEFT, card-state badge on
    // the RIGHT. Single flex parent with justify-between so the two halves
    // hug the tooltip's edges (task g).
    const statusRow = document.createElement('div');
    statusRow.className = 'ej-status-row';

    const summaryLine = document.createElement('div');
    summaryLine.className = 'ej-summary';
    const parts: string[] = [`${approvedCount} / ${reviewerCount} approved`];
    if (changesCount > 0) {
      parts.push(
        `${changesCount} changes requested`,
      );
    }
    summaryLine.textContent = parts.join(' · ');
    statusRow.appendChild(summaryLine);

    // State badge — driven by the actual per-PR card state so the label
    // matches the card's color (task c). Falls back to "UNKNOWN" if we
    // somehow can't compute (e.g. settings still loading on first hover).
    statusRow.appendChild(stateBadgeEl(pr));
    block.appendChild(statusRow);

    // Reviewers.
    if (pr.reviewers.length > 0) {
      const hr = document.createElement('hr');
      hr.className = 'ej-divider';
      block.appendChild(hr);
      for (const r of pr.reviewers) {
        block.appendChild(reviewerRowEl(r));
      }
    }

    // Other participants (drive-by commenters).
    const others = pr.participants.filter((p) => p.role !== 'REVIEWER');
    if (others.length > 0) {
      const hr2 = document.createElement('hr');
      hr2.className = 'ej-divider';
      block.appendChild(hr2);
      const label = document.createElement('div');
      label.className = 'ej-section-label';
      label.textContent = 'Other participants';
      block.appendChild(label);
      for (const p of others) {
        block.appendChild(participantRowEl(p));
      }
    }

    tooltipEl!.appendChild(block);
    void idx; // satisfy noUnusedParameters under stricter tsconfig variants
  });
}

/**
 * Card-state-aware badge for the status row. Maps the per-PR card state
 * (green/yellow/red) to a human label and a matching color. Red was
 * renamed from "FAILURE" to "Changes Requested" to better reflect the
 * approval-state semantics (a red card means a reviewer requested changes,
 * not a CI failure). Falls back to UNKNOWN when settings haven't loaded
 * yet — this only happens on the very first hover before async settings
 * resolve, after which the subscription re-renders with the real label.
 */
function stateBadgeEl(pr: PRState): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ej-state';

  if (!currentSettings) {
    el.classList.add('ej-state-unknown');
    el.textContent = 'UNKNOWN';
    return el;
  }

  const state = deriveCardStateForPR(pr, currentSettings);
  switch (state) {
    case 'green':
      el.classList.add('ej-state-success');
      el.textContent = '✓ SUCCESS';
      break;
    case 'pending':
      el.classList.add('ej-state-warning');
      el.textContent = '⚠ WARNING';
      break;
    case 'red':
      el.classList.add('ej-state-failure');
      el.textContent = '✗ Changes Requested';
      break;
  }
  return el;
}

/**
 * On legacy Bitbucket workspaces `participants[].user.username` may be
 * absent and the worker falls back to `user.uuid` — a string of the form
 * `{19420924-b4b4-4baa-9099-ed07361d1e6d}`. The UUID is preserved in the
 * `Reviewer.username` field for matching/identity (required-approver
 * comparisons, etc.), but it should never appear in the visible tooltip
 * handle. This helper detects the UUID shape so we can suppress the
 * `@{...}` handle without touching the underlying data.
 */
function isUuidUsername(username: string): boolean {
  return /^\{[0-9a-fA-F-]+\}$/.test(username);
}

function reviewerRowEl(r: Reviewer): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ej-row';

  const icon = document.createElement('span');
  icon.className = 'ej-row-icon';
  if (r.changesRequested) {
    icon.classList.add('ej-row-icon-changes');
    icon.textContent = '✗';
  } else if (r.approved) {
    icon.classList.add('ej-row-icon-approved');
    icon.textContent = '✓';
  } else {
    icon.classList.add('ej-row-icon-pending');
    icon.textContent = '⏳';
  }
  row.appendChild(icon);

  row.appendChild(avatarEl(r));

  const name = document.createElement('span');
  name.className = 'ej-name';
  name.textContent = r.displayName || r.username;
  row.appendChild(name);

  // Suppress `@{uuid}` handles — only show real usernames (task b).
  if (!isUuidUsername(r.username)) {
    const handle = document.createElement('span');
    handle.className = 'ej-handle';
    handle.textContent = `@${r.username}`;
    row.appendChild(handle);
  }

  return row;
}

function participantRowEl(r: Reviewer): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ej-row';

  const icon = document.createElement('span');
  icon.className = 'ej-row-icon ej-row-icon-comment';
  icon.textContent = '💬';
  row.appendChild(icon);

  row.appendChild(avatarEl(r));

  const name = document.createElement('span');
  name.className = 'ej-name';
  name.textContent = r.displayName || r.username;
  row.appendChild(name);

  // Suppress `@{uuid}` handles — only show real usernames (task b).
  if (!isUuidUsername(r.username)) {
    const handle = document.createElement('span');
    handle.className = 'ej-handle';
    handle.textContent = `@${r.username}`;
    row.appendChild(handle);
  }

  return row;
}

function avatarEl(r: Reviewer): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'ej-avatar';
  if (r.avatarUrl) {
    const img = document.createElement('img');
    img.src = r.avatarUrl;
    img.alt = '';
    img.width = 20;
    img.height = 20;
    wrap.appendChild(img);
  } else {
    const initial = (r.displayName || r.username || '?')
      .trim()
      .charAt(0)
      .toUpperCase();
    wrap.textContent = initial;
  }
  return wrap;
}

// ─── Position ───────────────────────────────────────────────────────────────

function positionTooltip(card: HTMLElement, tooltip: HTMLElement): void {
  const margin = 8;
  const cardRect = card.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Tooltip's natural box (display:block, before we mutate left/top).
  const tw = tooltip.offsetWidth;
  const th = tooltip.offsetHeight;

  // Default: right of card, top-aligned.
  let left = cardRect.right + margin;
  let top = cardRect.top;

  // Flip to the left if it would clip the right edge.
  if (left + tw > vw - margin) {
    left = cardRect.left - tw - margin;
  }

  // If still clipping (e.g. card too far left to flip), pin to top-right
  // safe spot.
  if (left < margin || left + tw > vw - margin) {
    left = Math.max(margin, vw - tw - margin);
  }

  // Vertical: shift up if it would overflow the bottom.
  if (top + th > vh - margin) {
    top = vh - th - margin;
  }
  if (top < margin) {
    top = margin;
  }

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}
