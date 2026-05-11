/**
 * Branch-card hover popover enrichment.
 *
 * Jira's native dev-info popover renders only the first 2 reviewer avatars
 * and collapses the rest into a "+N more people" overflow chip — which is
 * useless when the team's whole question is "did the right people approve
 * yet?". This module watches for the popover, identifies which Jira ticket
 * (and thus which Bitbucket PR) it's describing, then injects extra `<li>`
 * avatars into the AtlasKit Avatar Group so the user sees up to a
 * configurable cap (default 5) of approvers — approved-first — without
 * losing Jira's existing chrome.
 *
 * Architecture notes:
 *   - We never instantiate React. We mirror the AtlasKit avatar markup with
 *     plain DOM + a self-injected `<style id="ej-branch-card-styles">`. The
 *     visual contract is "looks identical, just with more avatars" — same
 *     32×32 size (AtlasKit "medium"), same overlap stacking, same green
 *     check overlay for the approved state.
 *   - The popover is React-portaled into `<body>`, so we use a body-level
 *     MutationObserver and look for the testid prefix
 *     `development-board-pr-details-popup.ui.*` — the most reliable
 *     signature across Jira UI variations.
 *   - Once a popover is found and enriched we attach a scoped observer to
 *     re-inject if Jira's React drops our `<li data-ej-extra-approver>`
 *     during a re-render. The scoped observer is GC'd when the popover
 *     unmounts (no manual cleanup required).
 *   - Settings gate via `loadSettings` + the shared `onStorageChange`
 *     fan-out — when `expandBranchCardAvatars` flips off mid-session we
 *     stop enriching but leave any already-injected avatars in place
 *     (they'll vanish naturally when the popover closes).
 *   - Fail-soft: every observer callback and enrichment branch is wrapped
 *     in try/catch + a once-per-failure-mode warn so a Jira UI rotation
 *     can never throw out of an observer.
 */

import {
  canonicalizeIdentity,
  isReviewerAllowed,
  type PRState,
  type Reviewer,
} from '../../lib/bitbucket';
import { loadSettings, type Settings } from '../../lib/settings';
import { debug, warn } from '../../lib/log';
import { getCachedPRs, requestPRs, subscribeToKey } from './state';
import { onStorageChange } from './storageEvents';

const STYLE_ID = 'ej-branch-card-styles';
const EXTRA_LI_CLASS = 'ej-extra-approver-li';
const EXTRA_LI_ATTR = 'data-ej-extra-approver';
const ENRICHED_ATTR = 'data-ej-branch-card-enriched';

// Testid prefix shared by every popover-internal element in the live snippet.
// The most reliable signature for "this DOM subtree is the dev-info popover".
const POPOVER_TESTID_PREFIX = 'development-board-pr-details-popup.ui.';
const AVATAR_GROUP_TESTID =
  'development-board-pr-details-popup.ui.avatar-group--avatar-group';
const OVERFLOW_TRIGGER_TESTID =
  'development-board-pr-details-popup.ui.avatar-group--overflow-menu--trigger';
const AVATAR_LABEL_TESTID_RE =
  /^development-board-pr-details-popup\.ui\.avatar-group--avatar-\d+--label$/;

// Module-local once-set so a Jira UI rotation logs at most one warning per
// failure mode per content-script lifetime. Mirrors the warn-once pattern in
// observer.ts / tooltip.ts without pulling a shared helper into lib/log.
const warnedKeys = new Set<string>();
function warnOnce(key: string, ...args: unknown[]): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  warn(`branch-card: ${key}`, ...args);
}

// Avatar size is measured at runtime from Jira's own native avatars inside
// the popover (see `measureNativeAvatarSize`) and applied via the
// `--ej-avatar-size` CSS variable on each injected `<li>`. Hardcoding a
// value drifts across Atlassian tenant rotations (we've seen 24, 28, 32);
// reading the live DOM is the only reliable contract. The status badge
// (~0.4 * avatar) and initials font (~0.45 * avatar) derive from the same
// measurement via additional CSS variables set inline.
const FALLBACK_AVATAR_SIZE = 28;
const MIN_AVATAR_SIZE = 16;
const MAX_AVATAR_SIZE = 48;
const NATIVE_AVATAR_INNER_SELECTOR = '[data-testid$="--inner"]';

const BRANCH_CARD_CSS = `
.${EXTRA_LI_CLASS} {
  --ej-avatar-size: ${FALLBACK_AVATAR_SIZE}px;
  --ej-avatar-badge-size: ${Math.round(FALLBACK_AVATAR_SIZE * 0.4)}px;
  --ej-avatar-initial-size: ${Math.round(FALLBACK_AVATAR_SIZE * 0.45)}px;
  position: relative;
  display: inline-flex;
  align-items: center;
  align-self: center;
  margin-left: -4px;
  list-style: none;
  box-sizing: border-box;
}
.${EXTRA_LI_CLASS}:first-child { margin-left: 0; }
.ej-extra-approver {
  position: relative;
  width: var(--ej-avatar-size);
  height: var(--ej-avatar-size);
  border-radius: 50%;
  overflow: visible;
  box-shadow: 0 0 0 2px var(--ds-surface, #FFFFFF);
  background: var(--ds-background-neutral, #DCDFE4);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: 600 var(--ej-avatar-initial-size) / 1 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--ds-text-subtle, #44546F);
  flex: 0 0 var(--ej-avatar-size);
}
.ej-extra-approver-img {
  width: var(--ej-avatar-size);
  height: var(--ej-avatar-size);
  border-radius: 50%;
  object-fit: cover;
  display: block;
}
.ej-extra-approver-initial {
  width: var(--ej-avatar-size);
  height: var(--ej-avatar-size);
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  font-size: var(--ej-avatar-initial-size);
}
.ej-extra-approver-status {
  position: absolute;
  right: -1px;
  top: -1px;
  width: var(--ej-avatar-badge-size);
  height: var(--ej-avatar-badge-size);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.ej-extra-approver-status svg {
  width: var(--ej-avatar-badge-size);
  height: var(--ej-avatar-badge-size);
  display: block;
}
`;

let currentSettings: Settings | null = null;
let started = false;
let bodyObserver: MutationObserver | null = null;

// Active popover registry: keyed by popover root, value is the pair of
// (scopedObserver, ticketKey) needed to force a re-render when a setting flips
// mid-hover (e.g. `onlyShowApprovers` toggled while the popover is open). We
// can't re-derive these from the DOM alone, so we track them explicitly here.
// Entries are pruned on disconnect/popover-detach inside the storage handler.
const activePopovers = new Map<
  HTMLElement,
  { obs: MutationObserver; key: string }
>();

/**
 * Public entrypoint. Idempotent: safe to call once at content-script
 * startup; will not double-install styles or observers.
 */
export function startBranchHoverCard(): void {
  if (started) return;
  started = true;

  installStyles();

  // Settings load is async — kick it off and let the body observer install
  // immediately so we don't miss popovers that open before the first load
  // resolves. The observer callback no-ops while `currentSettings` is null
  // OR while the kill-switch is off; once settings arrive we reattempt
  // any popover that's currently in the DOM.
  void loadSettings()
    .then((s) => {
      currentSettings = s;
      // Settings just arrived — sweep any popovers that already opened.
      try {
        scanForPopovers(document.body);
      } catch (e) {
        warnOnce('initial-scan', e);
      }
    })
    .catch((e) => {
      warnOnce('settings-load-failed', e);
    });

  onStorageChange((event) => {
    if (event.type !== 'settingsChanged') return;
    currentSettings = event.settings;
    // Sweep on any setting flip that affects what we paint: the user may have
    // just enabled `expandBranchCardAvatars` (we need to inject extras), or
    // `onlyShowApprovers` while expansion is OFF (filter on natives), or just
    // populated their `approvers` allowlist (filter on natives independently
    // of either kill-switch). The body observer skips popover discovery while
    // all three are off / empty, so the registry may be empty here even with
    // a popover open — re-scan to pick it up.
    if (
      event.settings.expandBranchCardAvatars ||
      event.settings.onlyShowApprovers ||
      event.settings.approvers.length > 0
    ) {
      try {
        scanForPopovers(document.body);
      } catch (e) {
        warnOnce('settings-rescan', e);
      }
    }
    // Force a re-render of every currently-mounted popover so toggles like
    // `onlyShowApprovers` apply immediately mid-hover. Without this, the
    // user has to dismiss + re-open the popover to see the change. Detached
    // popovers are pruned from the registry as we walk it.
    for (const [popover, entry] of activePopovers) {
      if (!popover.isConnected) {
        activePopovers.delete(popover);
        continue;
      }
      try {
        runWithScopedObserver(entry.obs, popover, () =>
          tryEnrich(popover, entry.key),
        );
      } catch (e) {
        warnOnce('settings-live-rerender', e);
      }
    }
  });

  attachBodyObserver();
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = BRANCH_CARD_CSS;
  document.head.appendChild(style);
}

// ─── Body-level popover detection ────────────────────────────────────────────

function attachBodyObserver(): void {
  if (bodyObserver !== null) return;
  bodyObserver = new MutationObserver((mutations) => {
    if (!currentSettings) return;
    // Discover popovers whenever ANY of these three reasons fires: expansion
    // injects extras, `onlyShowApprovers` filters Jira's natives, and a
    // populated `approvers` allowlist filters Jira's natives independently of
    // either kill-switch. All three rely on `enrichPopover` installing a
    // scoped observer + dispatching `tryEnrich`.
    if (
      !currentSettings.expandBranchCardAvatars &&
      !currentSettings.onlyShowApprovers &&
      currentSettings.approvers.length === 0
    ) {
      return;
    }
    try {
      // Cheap pre-filter: on a busy Jira board this observer fires hundreds
      // of times per second (drag, hover, autocomplete). Bail before we run
      // any querySelector unless an addedNode is itself the popover or
      // contains it. Saves a sea of pointless DOM scans.
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (
            node.matches?.(`[data-testid^="${POPOVER_TESTID_PREFIX}"]`) ||
            node.querySelector?.(`[data-testid^="${POPOVER_TESTID_PREFIX}"]`)
          ) {
            scanForPopovers(node);
          }
        }
      }
    } catch (e) {
      warnOnce('body-observer-callback', e);
    }
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });
}

/**
 * Scan an added subtree for popover signatures. The popover root is the
 * closest ancestor that contains the WHOLE popover; we approximate that by
 * climbing from the avatar-group up to the nearest `[role="dialog"]` or,
 * failing that, to a parent that also contains the branch link. The exact
 * choice doesn't matter much — the scoped observer just needs an ancestor
 * that survives across React re-renders.
 */
function scanForPopovers(root: HTMLElement): void {
  const sample = root.querySelector<HTMLElement>(
    `[data-testid^="${POPOVER_TESTID_PREFIX}"]`,
  );
  if (!sample) return;
  const popover = findPopoverRoot(sample);
  if (!popover) return;
  if (popover.getAttribute(ENRICHED_ATTR) === '1') {
    // Already attached scoped observer + enriched once — nothing to do.
    return;
  }
  enrichPopover(popover);
}

function findPopoverRoot(inner: HTMLElement): HTMLElement | null {
  // Prefer the closest dialog wrapper Jira's portal layer puts around the
  // popover (Atlassian's popper.js layer). Fall back to the avatar group's
  // grandparent if the dialog ancestor isn't present (test fixtures, older
  // tenants).
  const dialog = inner.closest<HTMLElement>('[role="dialog"]');
  if (dialog) return dialog;
  const group = inner.closest<HTMLElement>(
    `[data-testid="${AVATAR_GROUP_TESTID}"]`,
  );
  if (group?.parentElement?.parentElement) {
    return group.parentElement.parentElement;
  }
  // Last-resort: the testid-bearing element's own grandparent.
  return inner.parentElement?.parentElement ?? inner.parentElement ?? null;
}

// ─── Per-popover enrichment ──────────────────────────────────────────────────

function enrichPopover(popover: HTMLElement): void {
  popover.setAttribute(ENRICHED_ATTR, '1');

  // Identify the ticket key from the branch link inside the popover.
  const key = extractKeyFromPopover(popover);
  if (!key) {
    // Can't enrich without a key — bail. Don't warn-once here: a popover for
    // a non-standard branch name (no JIRA key) is a legitimate user case,
    // not a bug.
    debug('branch-card: no key extractable from popover');
    return;
  }

  // Attach the scoped observer FIRST, then route every mutation pass
  // (including the initial render) through `runWithScopedObserver` so the
  // observer is disconnected while WE mutate. Without this, our own
  // `<li>` injection + overflow-chip text update would re-fire the observer
  // → tryEnrich → mutate → fire → infinite loop and a frozen tab.
  const obs = attachScopedObserver(popover, key);

  // Register so a settings flip (e.g. `onlyShowApprovers`) can force a
  // re-render on this live popover without waiting for the next DOM mutation.
  activePopovers.set(popover, { obs, key });

  // Try to render with whatever we have right now (cache may be primed).
  runWithScopedObserver(obs, popover, () => tryEnrich(popover, key));

  // Subscribe to fresh-data events for this key. If the cache was empty,
  // requestPRs will populate it and emit; we re-render then.
  const unsub = subscribeToKey(key, () => {
    if (!popover.isConnected) {
      activePopovers.delete(popover);
      unsub();
      return;
    }
    try {
      runWithScopedObserver(obs, popover, () => tryEnrich(popover, key));
    } catch (e) {
      warnOnce('subscribe-tryEnrich', e);
    }
  });

  // Kick a fetch (cooldown applies — cheap if already cached).
  void requestPRs(key, window.location.host).catch((e) => {
    warnOnce('requestPRs', e);
  });
}

/**
 * Per-popover MutationObserver. Watches for Jira's React dropping our
 * injected `<li>`s during a re-render. The body of the callback uses
 * `runWithScopedObserver` so the observer is disconnected for the
 * duration of our own mutations — without that, every injection re-fires
 * the observer (childList + subtree catches our writes), producing an
 * infinite feedback loop.
 */
function attachScopedObserver(
  popover: HTMLElement,
  key: string,
): MutationObserver {
  const obs = new MutationObserver(() => {
    // If the popover is currently detached from the document, skip THIS
    // pass but don't disconnect — Jira's React may briefly detach the
    // popover root during a commit phase and reattach it on the next tick.
    // Disconnecting permanently here was the secondary cause of the
    // "avatars never come back" lifecycle: a transient detach would kill
    // the observer for good even though the popover came back live.
    if (!popover.isConnected) return;
    try {
      runWithScopedObserver(obs, popover, () => tryEnrich(popover, key));
    } catch (e) {
      warnOnce('scoped-observer-callback', e);
    }
  });
  obs.observe(popover, { childList: true, subtree: true });
  return obs;
}

/**
 * Disconnect → mutate → drain pending records → reconnect. The drain step
 * (`obs.takeRecords()`) discards any mutations queued *before* we
 * disconnected so they don't replay on the next event-loop tick. This is
 * the canonical pattern for a self-mutating MutationObserver.
 */
function runWithScopedObserver(
  obs: MutationObserver,
  popover: HTMLElement,
  fn: () => void,
): void {
  obs.disconnect();
  try {
    fn();
  } finally {
    // Discard any records queued before disconnect so reconnecting doesn't
    // immediately re-fire on our own writes. Do this in `finally` so the
    // observer always reattempts reconnect even if `fn()` throws — without
    // try/finally a thrown exception would leave the observer permanently
    // disconnected for the lifetime of the popover.
    obs.takeRecords();
    if (popover.isConnected) {
      obs.observe(popover, { childList: true, subtree: true });
    } else {
      // Popover is transiently detached (likely a React commit phase).
      // Schedule a reconnect once the document settles. If the popover is
      // really gone for good, the next reattach will be picked up by the
      // body observer scanning for the popover testid signature.
      queueMicrotask(() => {
        if (popover.isConnected) {
          try {
            obs.observe(popover, { childList: true, subtree: true });
          } catch {
            // Last-ditch defense — if the popover became permanently
            // detached between the microtask schedule and execution,
            // observe() may throw. Swallow and let the body observer
            // re-discover the popover on its next mount.
          }
        }
      });
    }
  }
}

/**
 * Idempotent enrichment pass. Safe to call repeatedly — it inspects the
 * current state of the avatar group and only adds avatars when the live
 * count is below the target.
 */
function tryEnrich(popover: HTMLElement, key: string): void {
  if (!currentSettings) return;

  const ul = popover.querySelector<HTMLUListElement>(
    `ul[data-testid="${AVATAR_GROUP_TESTID}"]`,
  );
  if (!ul) return;

  // Filter-first: the `onlyShowApprovers` row filter only depends on the
  // existing `<li>` children of `ul` (it parses Jira's hidden `--label`
  // spans for native rows + reads our `dataset.ejApproverState` for any
  // injected rows). The configured-users allowlist filter has the same
  // shape but also wants PR-cache data to bridge a native row's displayName
  // back to its username/uuid identity tokens — we pass whatever cache we
  // have (may be empty pre-fetch; bridge gracefully degrades). Neither
  // needs the expansion kill-switch or any injected extras, so both run
  // BEFORE the early-returns below — a popover with no overflow / no PR
  // cache / expansion-off still gets filtered. Both are idempotent and
  // safe to re-run after injection.
  const preCached = getCachedPRs(key);
  const prePrs = preCached && preCached.ok ? preCached.prs : [];
  try {
    applyConfiguredUsersFilter(ul, prePrs);
  } catch (e) {
    warnOnce('allowlist-filter-pre', e);
  }
  try {
    applyOnlyApproversFilter(ul, prePrs);
  } catch (e) {
    warnOnce('only-approvers-filter-pre', e);
  }
  try {
    decorateNativeAvatarsWithStatusBadges(ul, prePrs);
  } catch (e) {
    warnOnce('native-badge-decorate-pre', e);
  }

  // Skip the rest (extras injection) when the expansion feature is off.
  // The filters above are the only deliverables this pass needs to make.
  if (!currentSettings.expandBranchCardAvatars) return;

  const cached = getCachedPRs(key);
  if (!cached || !cached.ok) return;
  if (cached.prs.length === 0) return;

  // Measure Jira's own native avatar to size ours identically. Falls back
  // to FALLBACK_AVATAR_SIZE when the popover hasn't laid out yet (rect 0)
  // or the testid signature has rotated.
  const avatarSize = measureNativeAvatarSize(popover);

  const cap = clampCap(currentSettings.branchCardAvatarCap);

  // Aggregate approvers across all PRs for this key. Three-tier sort so the
  // "actioned" reviewers (changes-requested first, then approved) are kept
  // up-front and never buried under the cap into the "+N" overflow chip — the
  // amber-dash badge has to be VISIBLE for the user to act on it. Changes-
  // requested leads because it's the more actionable state (per the Fix 2
  // precedence in `aggregateReviewers`).
  const all = aggregateReviewers(cached.prs);
  // Filter out reviewers the user has marked `isHidden:true` in settings.
  // Applies to BOTH the rendered avatars and the "+N" overflow count below
  // (since `ordered.length` drives the chip). We deliberately do NOT mutate
  // the upstream `cached.prs` / `PRState.reviewers` — other features (card
  // coloring) still need to count hidden users.
  const hiddenSet = buildHiddenUsernameSet(currentSettings);
  const visible = hiddenSet.size === 0
    ? all
    : all.filter((r) => !hiddenSet.has(r.username.toLowerCase()));
  // Configured-users allowlist filter: when the user has populated their
  // approvers table, only reviewers whose username/uuid/displayName matches
  // an allowlist entry (after canonicalization) are eligible to render. An
  // empty allowlist short-circuits to no filter (legacy "show everyone"
  // behavior). Strictly rendering-only: `cached.prs.reviewers` is untouched
  // so card coloring etc. still see the full list.
  const allowedSet = buildAllowedIdentitySet(currentSettings);
  const allowed = allowedSet.size === 0
    ? visible
    : visible.filter((r) => isReviewerAllowed(r, allowedSet));
  // Optional "hide pending reviewers" filter: when the user has flipped this
  // setting ON, drop any reviewer who hasn't reacted yet — keep approved AND
  // changes-requested, drop pending only. Applied to BOTH the rendered avatar
  // row AND the "+N" overflow chip count (the chip count derives from
  // `ordered.length` below). Rendering-only: `cached.prs.reviewers` is
  // untouched, so card coloring and other features still see the full
  // reviewer list. (Setting field is still named `onlyShowApprovers` for
  // storage back-compat — see `Settings` type for the rename note.)
  const filtered = currentSettings.onlyShowApprovers
    ? allowed.filter((r) => r.approved || r.changesRequested)
    : allowed;
  const changesRequested = filtered.filter((r) => r.changesRequested);
  const approved = filtered.filter((r) => !r.changesRequested && r.approved);
  const pending = filtered.filter((r) => !r.changesRequested && !r.approved);
  const ordered = [...changesRequested, ...approved, ...pending];

  if (ordered.length === 0) return;

  // What does Jira already paint? Match by username via the hidden
  // `--label` spans; the label text looks like "Alex Arbuckle (approved)".
  const jiraVisibleNames = readJiraVisibleNames(ul);

  // Pick the first `cap` reviewers from `ordered`, then drop the ones Jira
  // already shows so we only inject the delta.
  const visibleReviewers = ordered.slice(0, cap);
  const extras = visibleReviewers.filter(
    (r) => !jiraVisibleNames.has(normalizeName(r.displayName, r.username)),
  );

  // Idempotency: if we already have the right number of injected <li>s and
  // they match (by username dataset attr) AND were sized at the current
  // measurement, skip the rebuild. The size check guards against a stale
  // earlier measurement (e.g. first hover before Jira finished CSS layout)
  // sticking around after a re-render.
  const existing = Array.from(
    ul.querySelectorAll<HTMLLIElement>(`li[${EXTRA_LI_ATTR}="true"]`),
  );
  const existingNames = existing.map(
    (li) => li.dataset.ejApproverKey ?? '',
  );
  const targetNames = extras.map((r) => identityKey(r));
  const allSized = existing.every(
    (li) => li.dataset.ejAvatarSize === String(avatarSize),
  );
  if (
    existingNames.length === targetNames.length &&
    existingNames.every((n, i) => n === targetNames[i]) &&
    allSized
  ) {
    // Already up to date; just refresh overflow chip in case approver totals
    // shifted under us without the avatar list changing.
    updateOverflowChip(ul, ordered.length, cap);
    // Still sweep z-index — Jira's React may have re-rendered native <li>s
    // with their default leftmost-on-top values since the last pass.
    applyUniformZIndex(ul);
    // Re-float any badges Jira's React may have re-mounted inside their
    // parent avatar div's stacking context during a re-render.
    floatBadgesAboveAvatars(ul);
    // Apply / restore the allowlist + `onlyShowApprovers` row filters —
    // covers both injected and native <li>s in this avatar group.
    applyConfiguredUsersFilter(ul, cached.prs);
    applyOnlyApproversFilter(ul, cached.prs);
    // Re-decorate native rows whose Jira-painted badge is missing for a
    // verdict we DO know — covers the "changes-requested on a native row"
    // gap that Jira's board UI never paints itself.
    decorateNativeAvatarsWithStatusBadges(ul, cached.prs);
    return;
  }

  // Wipe stale injected lis and re-render. Cheaper than diffing — we're
  // talking ≤8 elements.
  for (const li of existing) {
    li.remove();
  }

  const overflowLi = findOverflowLi(ul);
  // Find a native <li> we can clone as a template. Preferring one that
  // already has a status badge means the approved/changes-requested branches
  // have something to mutate; pending falls back to removing the badge.
  // The fallback (any non-overflow native <li>) is for the rare case where
  // every native reviewer is pending — in which case we BUILD the badge
  // from scratch when needed.
  const templateLi = pickTemplateLi(ul);

  // Build and insert each injected <li>. The per-<li> z-index is assigned
  // below by `applyUniformZIndex` once all natives + injecteds are in the
  // DOM in their final order, so we don't pre-set li.style.zIndex here.
  extras.forEach((r, idx) => {
    const li = templateLi
      ? buildExtraLiFromTemplate(templateLi, r, idx, avatarSize)
      : buildExtraLiFallback(r, avatarSize);
    if (overflowLi) {
      ul.insertBefore(li, overflowLi);
    } else {
      ul.appendChild(li);
    }
  });

  updateOverflowChip(ul, ordered.length, cap);

  // Uniform stacking sweep: every <li> child of the avatar group (Jira's
  // natives AND our injecteds, but NOT the overflow chip) gets a sequential
  // z-index increasing left→right, so the rightmost avatar always overlays
  // the one to its left, regardless of regime. This overrides Jira's native
  // leftmost-on-top default (avatar-0 = z=3, avatar-1 = z=2, …).
  applyUniformZIndex(ul);

  // Detach status badges from their parent avatar's stacking context so the
  // green check / red X stays visible even when the next avatar covers the
  // avatar circle itself. See `floatBadgesAboveAvatars` for details.
  floatBadgesAboveAvatars(ul);

  // Apply / restore the allowlist + `onlyShowApprovers` row filters — covers
  // both injected and native <li>s in this avatar group. Last step so all
  // <li>s are in the DOM in their final order before we hide / restore them.
  applyConfiguredUsersFilter(ul, cached.prs);
  applyOnlyApproversFilter(ul, cached.prs);
  // Decorate native rows whose Jira-painted badge is missing for a verdict
  // we DO know (notably changes-requested, which Jira's board popover never
  // paints). Runs after the filters so we don't waste cycles decorating a
  // row about to be hidden.
  decorateNativeAvatarsWithStatusBadges(ul, cached.prs);
}

/**
 * Walk the avatar group's `<li>` children in DOM order (visual left→right)
 * and assign each non-overflow `<li>`'s avatar div a sequential z-index
 * starting at 100. Idempotent: skips writes when the target value is already
 * set, to minimize churn through the scoped observer (which `tryEnrich`'s
 * caller has disconnected anyway, but `takeRecords()`-based redraining is
 * cheap when there's nothing to drain).
 *
 * Why on the avatar `<div role="img">` and not the `<li>` itself? Jira's
 * native rule places z-index on the inner avatar div (its own CSS uses
 * `position: relative` on the div, not the li). Writing to the same node
 * Jira targets keeps both regimes (native + injected) in one stacking
 * context with predictable layering. Caller MUST run inside the
 * `runWithScopedObserver` block so these writes don't trigger the scoped
 * observer to re-fire on itself.
 */
function applyUniformZIndex(ul: HTMLUListElement): void {
  const children = Array.from(ul.children).filter(
    (el): el is HTMLLIElement => el.tagName === 'LI',
  );
  let visualIndex = 0;
  for (const li of children) {
    // Skip the overflow chip — it shouldn't participate in the stacking
    // sweep (its DOM position is rightmost but it's a button, not an avatar).
    if (li.querySelector('[data-testid*="overflow"]')) continue;
    const target = String(100 + visualIndex);
    visualIndex++;
    const avatarDiv = li.querySelector<HTMLElement>('div[role="img"]');
    if (!avatarDiv) continue;
    if (avatarDiv.style.zIndex !== target) {
      avatarDiv.style.zIndex = target;
    }
  }
}

/**
 * Detach each avatar's status badge (green check / red X) from inside its
 * parent avatar `<div role="img">` and re-parent it to the `<li>` so the
 * badge no longer lives inside the avatar div's stacking context.
 *
 * The bug this fixes: each avatar div carries `position: relative` + a
 * sequential `z-index: 100+i` (set by `applyUniformZIndex`). That makes
 * each avatar div its own stacking context. When avatar (i+1) at z=101
 * overlaps avatar (i) at z=100, the entire z=100 stacking context — avatar
 * AND its badge — is buried, even though the badge is positioned at the
 * avatar's top-right corner where avatar (i+1) doesn't actually cover.
 *
 * Fix: lift each badge OUT of its avatar div and into the `<li>` (so the
 * `<li>` is the badge's offset parent) with a `z-index: 999` that sits
 * above every avatar in the row. The avatar div keeps its z-index (that
 * still drives left↔right avatar circle stacking); only the badge layer
 * floats above.
 *
 * The badge's existing inline + AtlasKit-class top/right offsets are
 * relative to the avatar div, but the avatar div fills the `<li>` (the
 * `<li>` has no padding around it — the avatar is the only child of the
 * presentation wrapper, which itself is sized to the avatar). So the same
 * `top:-1px; right:-1px` lands on the same pixel from the `<li>` reference
 * frame. We additionally set those offsets defensively in case the
 * AtlasKit class hashes don't carry over.
 *
 * Idempotent: marks each floated badge with `dataset.ejBadgeFloated='1'`
 * and short-circuits when re-encountered. Pending reviewers (no badge)
 * are silently skipped.
 *
 * Caller MUST run inside `runWithScopedObserver` so these moves don't
 * re-fire the scoped observer onto its own writes.
 */
function floatBadgesAboveAvatars(ul: HTMLUListElement): void {
  const children = Array.from(ul.children).filter(
    (el): el is HTMLLIElement => el.tagName === 'LI',
  );
  for (const li of children) {
    // Skip the overflow chip — it's a button, not an avatar with a badge.
    if (li.querySelector('[data-testid*="overflow"]')) continue;

    const avatarDiv = li.querySelector<HTMLElement>('div[role="img"]');
    if (!avatarDiv) continue;

    // Locate the badge anywhere inside this <li> — once floated, the badge
    // is no longer inside avatarDiv, so search at the <li> level. Pending
    // reviewers genuinely have no badge — skip silently.
    const badge = li.querySelector<HTMLElement>('[data-testid$="--status"]');
    if (!badge) continue;

    // Idempotency: if this badge has already been floated up to the <li>,
    // don't re-mutate.
    if (
      badge.parentElement === li &&
      badge.dataset.ejBadgeFloated === '1'
    ) {
      continue;
    }

    // The <li> must be the badge's offset parent. AtlasKit nearly always
    // gives the <li> `position: relative` already, but set defensively
    // since a missing position would let the badge escape to the next
    // positioned ancestor (which could be the popover root).
    if (getComputedStyle(li).position === 'static') {
      li.style.position = 'relative';
    }

    // Defensive: clear any inline z-index on the <li> itself. If the <li>
    // is its own stacking context, the badge's z=999 is capped to that
    // <li>'s value relative to siblings — which would defeat the
    // elevation. The avatar div keeps its z-index (that drives avatar
    // circle ordering); only the <li> level must NOT be a stacking
    // context. We never set li.style.zIndex anywhere in this module, but
    // an older instance OR an AtlasKit rotation could have left one
    // behind on a cloned template node.
    if (li.style.zIndex !== '') {
      li.style.zIndex = '';
    }

    // Move the badge to be a direct child of the <li>. This takes it out
    // of the avatar div's stacking context entirely. The badge's inner
    // `<svg>` keeps its compiled AtlasKit classes so the icon renders
    // identically; only the offset parent changes.
    li.appendChild(badge);
    badge.dataset.ejBadgeFloated = '1';

    // Reposition the badge in the <li>'s reference frame. The avatar
    // div fills the <li> (no padding/margin between), so the same
    // top:-1px; right:-1px offsets land on the avatar's top-right
    // corner — visually identical to the pre-float placement.
    badge.style.position = 'absolute';
    badge.style.top = '-1px';
    badge.style.right = '-1px';
    badge.style.pointerEvents = 'none';
    badge.style.zIndex = '999';
  }
}

/**
 * Hide / restore avatar `<li>`s based on `onlyShowApprovers`. Applies to
 * BOTH our injected `<li>`s and Jira's natives — the original gate dropped
 * unapproved injections from `extras` but Jira's natives (the first ~2 the
 * popover renders) were untouched. With this pass, "hide pending reviewers"
 * really means "show only reviewers who've reacted" (approved OR changes-
 * requested) across the whole row.
 *
 * Reaction detection per `<li>`: PRIMARY path is the displayName→Reviewer
 * bridge built from `prs[].reviewers` (same source of truth and same
 * canonicalization as `decorateNativeAvatarsWithStatusBadges` and
 * `applyConfiguredUsersFilter`). A row counts as "reacted" iff its bridged
 * Reviewer has `approved === true || changesRequested === true`. The bridge
 * is necessary because Jira's native popover label only emits an
 * `(approved)` suffix — it is silent on changes-requested — so a pure
 * label-scrape would never recognize a changes-requesting native row and
 * would incorrectly hide it under the "only approvers" toggle.
 *
 * FALLBACK path (when the bridge can't resolve the row, e.g. cache miss /
 * pre-fetch / displayName drift): fall back to the suffix scrape via
 * `isLiApproved(li) || isLiChangesRequested(li)`. The approved suffix path
 * still works for Jira-painted approvers in the no-cache state; the
 * changes-requested suffix path is best-effort (Jira doesn't emit it on
 * natives but our own injected `<li>`s carry `dataset.ejApproverState`,
 * which `isLiChangesRequested` reads first). Locale concern (English-only
 * suffix match) is tracked on each helper.
 *
 * Idempotency: writes are guarded by an equality check so re-running does
 * not produce mutation-observer wakeups. Restore deletes the marker dataset
 * key so a subsequent pass with the toggle off correctly returns the row to
 * its native state.
 *
 * Overflow chip: hidden entirely while the toggle is on. The "+N more
 * people" semantic is meaningless under the filter (those are the very
 * people we're filtering out), and showing it would drift visually as we
 * hide more avatars. Restored when the toggle is off via the standard
 * `updateOverflowChip` path that fed into this function.
 *
 * Caller MUST run inside `runWithScopedObserver` so style writes don't
 * trigger the scoped observer to re-fire on its own writes.
 */
function applyOnlyApproversFilter(
  ul: HTMLUListElement,
  prs: PRState[],
): void {
  const onlyApprovers = currentSettings?.onlyShowApprovers === true;
  const children = Array.from(ul.children).filter(
    (el): el is HTMLLIElement => el.tagName === 'LI',
  );

  // Build the displayName→Reviewer bridge with the same canonicalization
  // `decorateNativeAvatarsWithStatusBadges` uses. Empty `prs` (cache miss /
  // pre-fetch) → empty map → every native row falls through to the suffix
  // scrape, which preserves the legacy approver-detection behavior in the
  // no-cache state. Same precedence as `aggregateReviewers`:
  // changesRequested > approved > pending when multiple PRs supply the same
  // canonical displayName with different verdicts.
  const reviewerByDisplayName = new Map<string, Reviewer>();
  for (const pr of prs) {
    for (const r of pr.reviewers) {
      if (!r.displayName) continue;
      const dnKey = canonicalizeIdentity(r.displayName);
      const prev = reviewerByDisplayName.get(dnKey);
      if (!prev) {
        reviewerByDisplayName.set(dnKey, r);
        continue;
      }
      if (r.changesRequested && !prev.changesRequested) {
        reviewerByDisplayName.set(dnKey, r);
      } else if (
        r.approved &&
        !prev.approved &&
        !prev.changesRequested
      ) {
        reviewerByDisplayName.set(dnKey, r);
      }
    }
  }

  for (const li of children) {
    // Treat the overflow chip specially below — never participate in the
    // hide/restore sweep here.
    if (isOverflowLi(li)) continue;

    // PRIMARY: resolve the row's displayName to a cached Reviewer and read
    // the verdict directly. Skip the bridge for our injected `<li>`s —
    // those carry `dataset.ejApproverState` and the suffix helpers fast-
    // path through it without re-scraping label text.
    let reacted = false;
    let resolved = false;
    if (li.getAttribute(EXTRA_LI_ATTR) !== 'true') {
      const dn = readNativeLiDisplayName(li);
      if (dn) {
        const reviewer = reviewerByDisplayName.get(canonicalizeIdentity(dn));
        if (reviewer) {
          reacted = reviewer.approved === true || reviewer.changesRequested === true;
          resolved = true;
        }
      }
    }
    // FALLBACK: bridge couldn't resolve (cache miss, displayName drift,
    // injected row) — fall back to the suffix scrape, which handles both
    // Jira-painted approvers via label text AND our injected rows via
    // `dataset.ejApproverState`.
    if (!resolved) {
      reacted = isLiApproved(li) || isLiChangesRequested(li);
    }
    const shouldHide = onlyApprovers && !reacted;

    if (shouldHide) {
      if (li.style.display !== 'none') {
        li.style.display = 'none';
      }
      if (li.dataset.ejHiddenByOnlyApprovers !== '1') {
        li.dataset.ejHiddenByOnlyApprovers = '1';
      }
    } else if (li.dataset.ejHiddenByOnlyApprovers === '1') {
      // Restore: only touch <li>s WE hid — leaves any other display:none
      // (Jira-native or future-feature) alone. Compose with the allowlist
      // filter: if the row is ALSO hidden by `applyConfiguredUsersFilter`,
      // leave the `display:none` in place so un-toggling only-approvers
      // doesn't un-hide rows the allowlist still wants hidden.
      if (
        li.style.display === 'none' &&
        li.dataset.ejHiddenByAllowlist !== '1'
      ) {
        li.style.display = '';
      }
      delete li.dataset.ejHiddenByOnlyApprovers;
    }
  }

  // Overflow chip: hidden while filtering, since "+N more" no longer maps
  // to a meaningful count. Restored by `updateOverflowChip` on the next
  // tryEnrich pass when the toggle flips off.
  const overflowLi = findOverflowLi(ul);
  if (overflowLi) {
    if (onlyApprovers) {
      if (overflowLi.style.display !== 'none') {
        overflowLi.style.display = 'none';
      }
      if (overflowLi.dataset.ejHiddenByOnlyApprovers !== '1') {
        overflowLi.dataset.ejHiddenByOnlyApprovers = '1';
      }
    } else if (overflowLi.dataset.ejHiddenByOnlyApprovers === '1') {
      // Only restore if WE hid it — `updateOverflowChip` may have its own
      // reason to keep `display:none` (no remaining approvers beyond cap).
      delete overflowLi.dataset.ejHiddenByOnlyApprovers;
      // Defer the visible/hidden decision to `updateOverflowChip`, which
      // ran earlier in this pass. If it set `display:none` for a legit
      // reason (remaining <= 0) we leave it. If it set `display:''` we
      // also leave it. Either way nothing to write here.
    }
  }
}

/**
 * Hide / restore Jira-native (and injected) avatar `<li>`s based on the user's
 * configured-users allowlist (`Settings.approvers`). The injected-row path
 * already screens via `isReviewerAllowed` in `tryEnrich` (so an injected `<li>`
 * with `dataset.ejHiddenByAllowlist` is the rare "filter was empty at inject
 * time, now isn't" race), but Jira's native `<li>`s are rendered by Jira's own
 * React and have to be hidden post-hoc here.
 *
 * Matching logic (mirrors `isReviewerAllowed`'s identity-token chain):
 *   - Build `allowedSet` once via `buildAllowedIdentitySet`.
 *   - For each native `<li>`, read the hidden `--label` span text and strip
 *     the trailing " (approved)" / " (changes requested)" suffix.
 *   - Build a `Map<displayNameCanonical, Set<token>>` from this popover's
 *     cached `PRState.reviewers` — for every reviewer, attach
 *     `canonicalizeIdentity(username)` + `canonicalizeIdentity(uuid)` (if
 *     present) + `canonicalizeIdentity(displayName)` to the set keyed by the
 *     reviewer's canonical displayName. This bridges back from "what Jira
 *     painted" (a localized display name) to "the picker's stored tokens"
 *     (username / uuid / displayName) so a UUID-form picker entry can match a
 *     native `<li>` it has no way of reading directly.
 *   - A native `<li>` is allowed if any of `{the row's own canonical
 *     displayName} ∪ {tokens from the map}` is in `allowedSet`. Otherwise
 *     hide it.
 *
 * Composition with `applyOnlyApproversFilter`:
 *   - HIDE arm: stamp `dataset.ejHiddenByAllowlist = '1'` so the only-approvers
 *     restore arm knows we still want the row hidden.
 *   - RESTORE arm: ALWAYS clear `dataset.ejHiddenByAllowlist`; ONLY set
 *     `display=''` when `dataset.ejHiddenByOnlyApprovers` is ALSO absent.
 *   - Empty-allowlist short-circuit takes the same composition guard: restore
 *     every `ejHiddenByAllowlist`-marked row but defer the `display` reset to
 *     only-approvers if it's still hiding the same row.
 *
 * Idempotency: writes are equality-guarded so re-running does not produce
 * mutation-observer wakeups. Caller MUST run inside `runWithScopedObserver`.
 */
function applyConfiguredUsersFilter(
  ul: HTMLUListElement,
  prs: PRState[],
): void {
  const allowedSet = buildAllowedIdentitySet(currentSettings);
  const children = Array.from(ul.children).filter(
    (el): el is HTMLLIElement => el.tagName === 'LI',
  );

  if (allowedSet.size === 0) {
    // Allowlist disabled (no entries configured) — restore any rows we
    // previously hid. Compose with only-approvers: leave `display:none` in
    // place when that filter still wants the row hidden.
    for (const li of children) {
      if (isOverflowLi(li)) continue;
      if (li.dataset.ejHiddenByAllowlist !== '1') continue;
      if (
        li.style.display === 'none' &&
        li.dataset.ejHiddenByOnlyApprovers !== '1'
      ) {
        li.style.display = '';
      }
      delete li.dataset.ejHiddenByAllowlist;
    }
    return;
  }

  // Build the displayName→tokens map from this popover's PR reviewers. The
  // map is keyed by canonical displayName since that's the only signal we can
  // read off Jira's native `<li>` (Jira doesn't expose usernames or UUIDs in
  // the popover markup). Empty `prs` (cache miss / pre-fetch) → empty map →
  // we fall back to displayName-only matching, which still catches every
  // allowlist entry the picker stored in displayName form.
  const tokensByDisplayName = new Map<string, Set<string>>();
  for (const pr of prs) {
    for (const r of pr.reviewers) {
      if (!r.displayName) continue;
      const dnKey = canonicalizeIdentity(r.displayName);
      let bucket = tokensByDisplayName.get(dnKey);
      if (!bucket) {
        bucket = new Set<string>();
        tokensByDisplayName.set(dnKey, bucket);
      }
      if (r.username) bucket.add(canonicalizeIdentity(r.username));
      if (r.uuid) bucket.add(canonicalizeIdentity(r.uuid));
      bucket.add(dnKey);
    }
  }

  for (const li of children) {
    if (isOverflowLi(li)) continue;

    // Skip our own injected `<li>`s — `tryEnrich` already filtered them
    // through `isReviewerAllowed` before injection. Hiding them again here
    // via the displayName bridge would be redundant and could double-mark
    // them. (If they're in the DOM, they passed the filter at inject time.)
    if (li.getAttribute(EXTRA_LI_ATTR) === 'true') continue;

    const dn = readNativeLiDisplayName(li);
    const ownToken = dn ? canonicalizeIdentity(dn) : '';
    let allowed = false;
    if (ownToken && allowedSet.has(ownToken)) {
      allowed = true;
    } else if (ownToken) {
      const bridge = tokensByDisplayName.get(ownToken);
      if (bridge) {
        for (const tok of bridge) {
          if (allowedSet.has(tok)) {
            allowed = true;
            break;
          }
        }
      }
    }

    if (!allowed) {
      if (li.style.display !== 'none') {
        li.style.display = 'none';
      }
      if (li.dataset.ejHiddenByAllowlist !== '1') {
        li.dataset.ejHiddenByAllowlist = '1';
      }
    } else if (li.dataset.ejHiddenByAllowlist === '1') {
      // Row now allowed — restore. Compose with only-approvers: leave
      // `display:none` in place when that filter still wants it hidden.
      if (
        li.style.display === 'none' &&
        li.dataset.ejHiddenByOnlyApprovers !== '1'
      ) {
        li.style.display = '';
      }
      delete li.dataset.ejHiddenByAllowlist;
    }
  }
}

// Marker dataset attribute on a `--status` badge we injected onto a Jira-
// native `<li>`. Lets `decorateNativeAvatarsWithStatusBadges` distinguish a
// badge it owns (safe to remove and replace) from one Jira painted itself
// (must not double-paint or remove). Matches the dataset-naming convention
// used elsewhere in this file (`ejBadgeFloated`, `ejHiddenByAllowlist`, …).
const INJECTED_NATIVE_BADGE_ATTR = 'ejInjectedStatus';
const INJECTED_NATIVE_BADGE_SELECTOR =
  '[data-ej-injected-status="true"]';

/**
 * Decorate Jira-native avatar `<li>`s with a status badge when Jira hasn't
 * painted one but we know the reviewer's verdict.
 *
 * The motivating gap: Jira's board-card hover popover renders the first 2
 * reviewers as native `<li>`s and paints a green check on approved ones, but
 * does NOT paint a changes-requested (amber dash) badge — board UI ignores
 * that state visually. So a reviewer who requested changes and is in the
 * first two slots gets a bare avatar with no indicator.
 *
 * Matching strategy mirrors `applyConfiguredUsersFilter`: build a
 * `Map<canonicalDisplayName, Reviewer>` from this popover's cached PR
 * reviewers, then resolve each native row's `--label` displayName through
 * the map to recover the full Reviewer (with `approved` + `changesRequested`
 * flags). Same precedence as `aggregateReviewers`: when multiple PRs supply
 * the same canonical displayName with different verdicts, changesRequested
 * supersedes approved supersedes neither.
 *
 * Detection heuristic for "is Jira already painting a badge here?": look
 * for any `[data-testid$="--status"]` inside the native `<li>` that ISN'T
 * marked with `data-ej-injected-status="true"`. The `--status` testid is
 * Jira's own badge-span signature (the same one `pickTemplateLi`,
 * `floatBadgesAboveAvatars`, and `buildExtraLiFromTemplate` already key off
 * for the cloned-template branch). Conservative because if the testid suffix
 * ever rotates, we'd undercount Jira's badges and risk a double-paint — a
 * second pass would catch it though, since our injected marker would be
 * present and we'd no-op.
 *
 * Re-decoration semantics: every pass FIRST removes any `<li>`-scoped
 * `[data-ej-injected-status="true"]` element so a stale changesRequested
 * badge can't survive after the reviewer flipped to approved between
 * renders. Then re-decides per the current reviewer state.
 *
 * Idempotency: writes are equality-guarded where applicable. Caller MUST
 * run inside `runWithScopedObserver` so DOM mutations don't re-fire the
 * scoped observer onto our own writes.
 */
function decorateNativeAvatarsWithStatusBadges(
  ul: HTMLUListElement,
  prs: PRState[],
): void {
  // Build the displayName→Reviewer bridge with the same canonicalization the
  // allowlist filter uses. Empty `prs` (cache miss / pre-fetch) → empty map →
  // every native row resolves to no reviewer and gets skipped, which is the
  // correct degraded behavior (we don't have data, so we don't paint).
  const reviewerByDisplayName = new Map<string, Reviewer>();
  for (const pr of prs) {
    for (const r of pr.reviewers) {
      if (!r.displayName) continue;
      const dnKey = canonicalizeIdentity(r.displayName);
      const prev = reviewerByDisplayName.get(dnKey);
      if (!prev) {
        reviewerByDisplayName.set(dnKey, r);
        continue;
      }
      // Same precedence as `aggregateReviewers`: changesRequested >
      // approved > pending. A reviewer flagged on multiple PRs with the
      // same canonical displayName collapses to the most actionable verdict.
      if (r.changesRequested && !prev.changesRequested) {
        reviewerByDisplayName.set(dnKey, r);
      } else if (
        r.approved &&
        !prev.approved &&
        !prev.changesRequested
      ) {
        reviewerByDisplayName.set(dnKey, r);
      }
    }
  }

  const children = Array.from(ul.children).filter(
    (el): el is HTMLLIElement => el.tagName === 'LI',
  );

  for (const li of children) {
    if (isOverflowLi(li)) continue;
    // Skip our own injected `<li>`s — they already carry their badge from
    // `buildExtraLiFromTemplate` / `buildExtraLiFallback` and route their
    // state through `dataset.ejApproverState`.
    if (li.getAttribute(EXTRA_LI_ATTR) === 'true') continue;

    // Wipe any badge WE injected on a previous pass so reviewer-state flips
    // (changesRequested → approved, approved → pending) replace cleanly
    // instead of stacking. Jira-painted badges are left untouched.
    const stale = li.querySelectorAll<HTMLElement>(
      INJECTED_NATIVE_BADGE_SELECTOR,
    );
    for (const el of Array.from(stale)) {
      el.remove();
    }

    const dn = readNativeLiDisplayName(li);
    if (!dn) continue;
    const reviewer = reviewerByDisplayName.get(canonicalizeIdentity(dn));
    if (!reviewer) continue;

    const state: ReviewState = reviewer.changesRequested
      ? 'changes-requested'
      : reviewer.approved
        ? 'approved'
        : 'none';
    if (state === 'none') continue;

    // Conservative double-paint guard: if a non-injected `--status` badge is
    // already present anywhere in this `<li>`, Jira (or some other layer)
    // owns it — leave it alone, regardless of whether it depicts approved or
    // anything else. The stale-removal pass above already cleared any badge
    // WE owned, so anything still here belongs to Jira.
    const jiraBadge = li.querySelector<HTMLElement>(
      `[data-testid$="--status"]:not(${INJECTED_NATIVE_BADGE_SELECTOR})`,
    );
    if (jiraBadge) continue;

    const built = buildStatusBadge(state);
    if (!built) continue;

    // Tag so the next pass recognizes ours. Dataset writes hyphenate the
    // attribute (`ejInjectedStatus` → `data-ej-injected-status`).
    built.dataset[INJECTED_NATIVE_BADGE_ATTR] = 'true';

    // Position in the same reference frame as Jira's own badges:
    // `position: absolute; top: -1px; right: -1px;` relative to the `<li>`,
    // matching the offsets `floatBadgesAboveAvatars` lands floated badges at.
    // Ensure the `<li>` is the badge's offset parent — AtlasKit usually sets
    // `position: relative` already; defend against a future tenant that
    // doesn't, but only when the computed position is actually `static`.
    if (getComputedStyle(li).position === 'static') {
      if (li.style.position !== 'relative') {
        li.style.position = 'relative';
      }
    }
    built.style.position = 'absolute';
    built.style.top = '-1px';
    built.style.right = '-1px';
    built.style.pointerEvents = 'none';
    // Sit above the avatar div's stacking context (avatar divs use z-index
    // 100..N via `applyUniformZIndex`). 999 mirrors `floatBadgesAboveAvatars`.
    built.style.zIndex = '999';
    // Pin the badge box to a fraction of the avatar size — same 0.4 ratio
    // as `--ej-avatar-badge-size` for our injected lis. Read the avatar
    // size off the live DOM so a tenant rotation (24/28/32) lands at the
    // correct ratio without us having to thread the measurement through.
    const inner = li.querySelector<HTMLElement>(NATIVE_AVATAR_INNER_SELECTOR);
    const innerWidth = inner ? Math.round(inner.getBoundingClientRect().width) : 0;
    const badgePx =
      Number.isFinite(innerWidth) && innerWidth >= MIN_AVATAR_SIZE
        ? Math.round(innerWidth * 0.4)
        : Math.round(FALLBACK_AVATAR_SIZE * 0.4);
    built.style.width = `${badgePx}px`;
    built.style.height = `${badgePx}px`;
    // The inner svg in `buildStatusBadge` carries `height/width="100%"`, so
    // sizing the wrapper is sufficient for the icon to fill it.

    li.appendChild(built);
  }
}

/**
 * Read the canonical (suffix-stripped) display name from a native Jira avatar
 * `<li>`. The hidden `--label` span carries text like "Alex Arbuckle
 * (approved)"; the same suffix-strip pattern that `readJiraVisibleNames` uses
 * applies here. Returns the empty string when no label can be found OR after
 * stripping yields nothing — caller treats empty as "no matchable identity",
 * which falls through to hide.
 */
function readNativeLiDisplayName(li: HTMLLIElement): string {
  const label = li.querySelector<HTMLElement>('[data-testid$="--label"]');
  if (!label) return '';
  const raw = (label.textContent ?? '').trim();
  if (!raw) return '';
  return raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function isOverflowLi(li: HTMLLIElement): boolean {
  return li.querySelector('[data-testid*="overflow"]') !== null;
}

/**
 * Determine whether the avatar `<li>` represents an approved reviewer.
 *
 * Injected `<li>`s carry `dataset.ejApproverState` ("approved" |
 * "changes-requested" | "none") set at build time — cheaper and more
 * accurate than re-parsing label text. Native `<li>`s require text
 * parsing on the hidden `--label` span; the canonical Jira format is
 * `"Display Name (approved)"` for approved reviewers.
 *
 * Concern: the label text is localized. A non-English Jira would render
 * `"(genehmigt)"` etc. and our suffix match would silently treat every
 * approved native as pending. A more robust signal is the green-check
 * `--status` SVG (`<circle fill="var(--ds-icon-success, #6A9A23)">`)
 * which is locale-independent — flagged in the task return.
 */
function isLiApproved(li: HTMLLIElement): boolean {
  // Fast path for our injected <li>s — verdict is recorded at build time.
  if (li.getAttribute(EXTRA_LI_ATTR) === 'true') {
    const state = li.dataset.ejApproverState;
    if (state === 'approved') return true;
    if (state === 'changes-requested' || state === 'none') return false;
    // Fall through to label-text parsing if dataset wasn't set (older
    // injection, or the markup was reconstructed by Jira's React).
  }
  const label = li.querySelector<HTMLElement>('[data-testid$="--label"]');
  if (!label) return false;
  const raw = (label.textContent ?? '').trim().toLowerCase();
  return raw.endsWith('(approved)');
}

/**
 * Sibling of `isLiApproved`: detect whether the avatar `<li>` represents a
 * reviewer who has requested changes. Used by `applyOnlyApproversFilter` to
 * broaden the "hide pending reviewers" filter — both approved AND changes-
 * requested rows are kept.
 *
 * Same caveats as `isLiApproved`: label text is localized. A non-English
 * Jira would render a translated suffix and our match would silently treat
 * every changes-requested native as pending. Parallel to the approved path,
 * so left as-is to keep one locale-fix lever for both helpers.
 */
function isLiChangesRequested(li: HTMLLIElement): boolean {
  // Fast path for our injected <li>s — verdict is recorded at build time.
  if (li.getAttribute(EXTRA_LI_ATTR) === 'true') {
    const state = li.dataset.ejApproverState;
    if (state === 'changes-requested') return true;
    if (state === 'approved' || state === 'none') return false;
    // Fall through to label-text parsing if dataset wasn't set (older
    // injection, or the markup was reconstructed by Jira's React).
  }
  const label = li.querySelector<HTMLElement>('[data-testid$="--label"]');
  if (!label) return false;
  const raw = (label.textContent ?? '').trim().toLowerCase();
  return raw.endsWith('(changes requested)');
}

/**
 * Find the best Jira-native `<li>` to clone as a template. Prefers a non-
 * overflow, non-injected `<li>` that already has a `--status` badge so the
 * approved / changes-requested branches have a badge to mutate in place.
 * Falls back to any non-overflow native `<li>` (we'll build the badge from
 * scratch in that path).
 */
function pickTemplateLi(ul: HTMLUListElement): HTMLLIElement | null {
  const candidates = Array.from(ul.querySelectorAll<HTMLLIElement>('li')).filter(
    (li) =>
      !li.hasAttribute(EXTRA_LI_ATTR) &&
      !li.classList.contains(EXTRA_LI_CLASS) &&
      !li.querySelector('[data-testid*="overflow"]'),
  );
  const withBadge = candidates.find((li) =>
    li.querySelector('[data-testid$="--status"]'),
  );
  return withBadge ?? candidates[0] ?? null;
}

/**
 * Read the live size of Jira's first native avatar inside the popover and
 * return a square pixel value to size our injected avatars to. Falls back
 * to FALLBACK_AVATAR_SIZE (28px — between the 24/32 we've previously
 * hardcoded) when the popover hasn't laid out yet (rect width 0), the
 * testid signature has rotated, or the result is out of a sane range.
 *
 * Defensive against:
 *   - selector miss (Jira UI rotation): returns fallback.
 *   - rect.width 0 / NaN: returns fallback (CSS not yet applied).
 *   - out-of-range (<16 or >48): returns fallback (catches a measurement
 *     against an unexpected element if the testid suffix happens to match
 *     something else in a future Jira layout).
 */
function measureNativeAvatarSize(popover: HTMLElement): number {
  try {
    const inner = popover.querySelector<HTMLElement>(
      NATIVE_AVATAR_INNER_SELECTOR,
    );
    if (!inner) return FALLBACK_AVATAR_SIZE;
    const rect = inner.getBoundingClientRect();
    const width = Math.round(rect.width);
    if (
      !Number.isFinite(width) ||
      width < MIN_AVATAR_SIZE ||
      width > MAX_AVATAR_SIZE
    ) {
      return FALLBACK_AVATAR_SIZE;
    }
    return width;
  } catch (e) {
    warnOnce('measure-native-avatar', e);
    return FALLBACK_AVATAR_SIZE;
  }
}

function clampCap(n: number): number {
  // Defensive — settings layer already clamps on load, but a stale instance
  // mid-flight could carry an out-of-range value.
  if (!Number.isFinite(n)) return 5;
  return Math.max(3, Math.min(10, Math.round(n)));
}

function aggregateReviewers(prs: PRState[]): Reviewer[] {
  const seen = new Map<string, Reviewer>();
  for (const pr of prs) {
    for (const r of pr.reviewers) {
      const k = identityKey(r);
      const prev = seen.get(k);
      if (!prev) {
        seen.set(k, r);
        continue;
      }
      // Conflict resolution priority: changesRequested > approved > pending.
      // Changes-requested supersedes approval — actionable state wins so
      // reviewers see fresh feedback (a red X across any PR wins, even if the
      // same reviewer approved a sibling PR). Approved beats pure-pending so
      // the green check is never silently dropped just because the same user
      // is "pending" on a sibling PR.
      if (r.changesRequested && !prev.changesRequested) {
        seen.set(k, r);
      } else if (
        r.approved &&
        !prev.approved &&
        !prev.changesRequested
      ) {
        seen.set(k, r);
      }
    }
  }
  return Array.from(seen.values());
}

function identityKey(r: Reviewer): string {
  return r.username.toLowerCase();
}

/**
 * Lowercased username set of approvers marked `isHidden:true` in the user's
 * settings. Used to filter the popover avatar row so hidden users (e.g. CI
 * bots like Code Rabbit) never appear and never count toward the "+N"
 * overflow chip. Returns an empty set when no settings are loaded yet OR
 * when no entries are flagged hidden, letting the caller short-circuit the
 * filter pass entirely on the common case.
 */
function buildHiddenUsernameSet(settings: Settings | null): Set<string> {
  const out = new Set<string>();
  if (!settings) return out;
  for (const a of settings.approvers) {
    if (a.isHidden) out.add(a.username.toLowerCase());
  }
  return out;
}

/**
 * Build the canonicalized identity-token set from every entry in
 * `settings.approvers`. Both `username` and (when present) `displayName` are
 * folded in — the picker may have stored either, and the native-row bridge
 * (`applyConfiguredUsersFilter`) reads displayNames directly off Jira's
 * `<li>`s. Returns an empty set when no settings are loaded yet OR when no
 * entries exist, letting the caller short-circuit the filter pass entirely
 * on the common (no allowlist configured) case.
 */
function buildAllowedIdentitySet(settings: Settings | null): Set<string> {
  const out = new Set<string>();
  if (!settings) return out;
  for (const a of settings.approvers) {
    if (a.username) out.add(canonicalizeIdentity(a.username));
    if (a.displayName) out.add(canonicalizeIdentity(a.displayName));
  }
  return out;
}

// ─── Popover → ticket key extraction ─────────────────────────────────────────

const KEY_RE = /[A-Z][A-Z0-9_]+-\d+/;

/**
 * Pull the Jira ticket key from the popover's branch link. Tries the link's
 * `title` attribute first (most reliable — that's where Jira renders the
 * verbose branch name like "Feature/CMMS-2589"), then falls back to the
 * link's text content. Returns null when no key can be found — the caller
 * silently bails (it's a legitimate user case, not a bug).
 */
function extractKeyFromPopover(popover: HTMLElement): string | null {
  const a = popover.querySelector<HTMLAnchorElement>(
    'a[href*="bitbucket.org"][href*="pull-request"]',
  );
  if (!a) return null;

  const fromTitle = (a.getAttribute('title') ?? '').match(KEY_RE);
  if (fromTitle) return fromTitle[0];

  const fromText = (a.textContent ?? '').match(KEY_RE);
  if (fromText) return fromText[0];

  return null;
}

// ─── Jira-visible avatar reading ─────────────────────────────────────────────

/**
 * Read the set of avatar identities Jira already painted (the first 2 in
 * the default popover). The hidden `--label` span carries the canonical
 * name in the form "Alex Arbuckle (approved)" — strip the suffix and
 * lowercase for comparison.
 *
 * IMPORTANT: skip any `--label` span inside one of OUR injected `<li>`s.
 * Our injected `<li>`s renumber their `--label` testids into the
 * `avatar-100+` range, but `AVATAR_LABEL_TESTID_RE` matches `\d+` so it
 * still matches our renumbered testids. Without the EXTRA_LI_ATTR exclusion,
 * a second pass of `tryEnrich` would treat our previously-injected
 * reviewers as Jira-native, filter them out of `extras`, and rebuild with
 * a strictly smaller set — looping until our `<li>`s disappear entirely.
 * This was the "avatars vanish after long hover" bug.
 */
function readJiraVisibleNames(ul: HTMLElement): Set<string> {
  const out = new Set<string>();
  const labels = ul.querySelectorAll<HTMLElement>('[data-testid]');
  for (const el of Array.from(labels)) {
    const tid = el.getAttribute('data-testid') ?? '';
    if (!AVATAR_LABEL_TESTID_RE.test(tid)) continue;
    // Skip labels inside our own injected <li>s — they are NOT Jira-native.
    if (el.closest(`li[${EXTRA_LI_ATTR}="true"]`)) continue;
    const raw = (el.textContent ?? '').trim();
    if (!raw) continue;
    const stripped = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (!stripped) continue;
    out.add(stripped.toLowerCase());
  }
  return out;
}

function normalizeName(displayName: string, username: string): string {
  return (displayName || username).trim().toLowerCase();
}

// ─── Overflow chip update ────────────────────────────────────────────────────

/**
 * Resize the "+N more people" overflow chip to reflect the count of
 * approvers we couldn't fit under the cap. Hides the chip if every approver
 * is now visible. Doesn't remove the chip from the DOM — Jira's React may
 * try to re-mount it; hiding is reversible.
 */
function updateOverflowChip(
  ul: HTMLElement,
  totalApprovers: number,
  cap: number,
): void {
  const overflowLi = findOverflowLi(ul);
  if (!overflowLi) return;
  const button = overflowLi.querySelector<HTMLButtonElement>(
    `button[data-testid="${OVERFLOW_TRIGGER_TESTID}"]`,
  );
  if (!button) return;

  const remaining = totalApprovers - cap;
  if (remaining <= 0) {
    // Only assign when the value actually differs — every assignment is a
    // potential MutationObserver wakeup, and this function is on the hot
    // path of the per-popover scoped observer.
    if (overflowLi.style.display !== 'none') {
      overflowLi.style.display = 'none';
    }
    return;
  }
  if (overflowLi.style.display !== '') {
    overflowLi.style.display = '';
  }
  const nextText = `+${remaining}`;
  if (button.textContent !== nextText) {
    button.textContent = nextText;
  }
  const nextAria = `${remaining} more ${remaining === 1 ? 'person' : 'people'}`;
  if (button.getAttribute('aria-label') !== nextAria) {
    button.setAttribute('aria-label', nextAria);
  }
}

function findOverflowLi(ul: HTMLElement): HTMLLIElement | null {
  const trigger = ul.querySelector<HTMLButtonElement>(
    `button[data-testid="${OVERFLOW_TRIGGER_TESTID}"]`,
  );
  return trigger?.closest('li') ?? null;
}

// ─── Avatar `<li>` factory ───────────────────────────────────────────────────

type ReviewState = 'approved' | 'changes-requested' | 'none';

// High base index for our injected avatars' data-testid suffixes so they
// can't collide with Jira's native indices (which start at 0). Bumping by
// `injectedIndex` per call keeps each injected `<li>`'s testids distinct.
const INJECTED_TESTID_BASE = 100;

/**
 * Clone-and-mutate path: clone an existing native Jira `<li>` and rewrite
 * the dynamic bits (image, label text, status badge, testids, aria links,
 * z-index). This guarantees pixel-perfect vertical alignment with Jira's
 * own avatars because the cloned node carries the same compiled AtlasKit
 * classes and wrapper-div structure.
 */
function buildExtraLiFromTemplate(
  template: HTMLLIElement,
  r: Reviewer,
  injectedIndex: number,
  avatarSize: number,
): HTMLLIElement {
  const li = template.cloneNode(true) as HTMLLIElement;

  // Marker + dataset so the idempotency check + cleanup find this <li>.
  li.setAttribute(EXTRA_LI_ATTR, 'true');
  li.dataset.ejApproverKey = identityKey(r);
  li.dataset.ejAvatarSize = String(avatarSize);
  li.dataset.ejApproverState = r.changesRequested
    ? 'changes-requested'
    : r.approved
      ? 'approved'
      : 'none';

  // Renumber every `data-testid` containing `avatar-N` to a unique high
  // index so we don't collide with Jira's native -0, -1, … values nor
  // with any sibling injected <li>'s testids. Walk the cloned subtree
  // (and the <li> itself, just in case).
  const newIndex = INJECTED_TESTID_BASE + injectedIndex;
  const testidNodes = [
    li,
    ...Array.from(li.querySelectorAll<HTMLElement>('[data-testid]')),
  ];
  for (const el of testidNodes) {
    const tid = el.getAttribute('data-testid');
    if (!tid) continue;
    if (/avatar-\d+/.test(tid)) {
      el.setAttribute('data-testid', tid.replace(/avatar-\d+/, `avatar-${newIndex}`));
    }
  }

  const suffix = r.changesRequested
    ? ' (changes requested)'
    : r.approved
      ? ' (approved)'
      : '';
  const labelText = `${r.displayName || r.username}${suffix}`;

  // Update the hidden label span (`<span ...--label>`). The aria-labelledby
  // on the parent avatar div points at this span's id; both must move to a
  // fresh unique id to avoid duplicate-id DOM warnings.
  const labelSpan = li.querySelector<HTMLElement>('[data-testid$="--label"]');
  const newLabelId = `_ej_extra_${injectedIndex}_`;
  if (labelSpan) {
    labelSpan.textContent = labelText;
    labelSpan.id = newLabelId;
  }

  // The avatar div carries role="img", aria-labelledby, and z-index. We
  // pick it up via role rather than testid so the lookup survives the
  // testid renumber above.
  const avatarDiv = li.querySelector<HTMLElement>('div[role="img"]');
  if (avatarDiv) {
    if (labelSpan) {
      avatarDiv.setAttribute('aria-labelledby', newLabelId);
    } else {
      // No label span in template (unexpected): fall back to aria-label so
      // the avatar still has an accessible name.
      avatarDiv.removeAttribute('aria-labelledby');
      avatarDiv.setAttribute('aria-label', labelText);
    }
    // Overwrite the inline z-index inherited from Jira's cloned template.
    // Jira's natives use leftmost-on-top (avatar-0 = z-index 3); we want
    // rightmost-on-top within our injected range. Starting at 100 leaves
    // headroom above any value Jira sets (max ~3) so our first injected
    // avatar always covers Jira's last native, with each subsequent
    // avatar overlaying the one to its left.
    avatarDiv.style.zIndex = String(100 + injectedIndex);
  }

  // Swap the <img src> to our reviewer's avatar URL. If the image fails to
  // load, swap to an initials fallback in place — same positioning, same
  // size, since we're nested inside Jira's compiled-class wrappers.
  const img = li.querySelector<HTMLImageElement>('img');
  if (img) {
    if (r.avatarUrl) {
      img.src = r.avatarUrl;
      img.setAttribute('alt', '');
    } else {
      img.replaceWith(buildInitialsNode(r, avatarSize));
    }
    img.addEventListener('error', () => {
      img.replaceWith(buildInitialsNode(r, avatarSize));
    });
  }

  // Compute review state and reconcile the status badge (`--status` span).
  // Mirrors the changesRequested > approved > pending precedence used by
  // `aggregateReviewers` so a reviewer with both flags renders the actionable
  // amber-dash badge, not the green check.
  const state: ReviewState = r.changesRequested
    ? 'changes-requested'
    : r.approved
      ? 'approved'
      : 'none';
  const statusSpan = li.querySelector<HTMLElement>('[data-testid$="--status"]');
  if (state === 'none') {
    // Pending reviewer: drop the badge if the template carried one.
    if (statusSpan) statusSpan.remove();
  } else if (statusSpan) {
    // Mutate the existing badge's SVG shapes in place — keeps AtlasKit's
    // compiled positioning classes intact.
    rewriteStatusBadgeSvg(statusSpan, state);
  } else {
    // Template didn't have a badge (template reviewer was pending). Build
    // one from scratch and append to the inner span so it's positioned
    // correctly relative to the avatar.
    const innerSpan = li.querySelector<HTMLElement>('[data-testid$="--inner"]');
    const built = buildStatusBadge(state);
    if (innerSpan && built) {
      // Renumber the built badge's testid into our injected range too.
      const tid = built.getAttribute('data-testid');
      if (tid && /avatar-\d+/.test(tid)) {
        built.setAttribute('data-testid', tid.replace(/avatar-\d+/, `avatar-${newIndex}`));
      }
      innerSpan.appendChild(built);
    }
  }

  return li;
}

/**
 * Build a status badge span from scratch in the AtlasKit shape captured
 * from the live Jira popover. Used only when the cloned template `<li>`
 * had no badge of its own (its reviewer was pending) and our reviewer
 * needs one.
 */
function buildStatusBadge(state: ReviewState): HTMLElement | null {
  if (state === 'none') return null;
  const wrap = document.createElement('span');
  wrap.setAttribute('aria-hidden', 'true');
  // Use a placeholder testid suffix; caller renumbers it into our range.
  wrap.setAttribute('data-testid', 'avatar-0--status');
  const inner = document.createElement('span');
  inner.setAttribute('role', 'presentation');
  if (state === 'approved') {
    inner.innerHTML =
      '<svg height="100%" version="1.1" viewBox="0 0 8 8" width="100%" xmlns="http://www.w3.org/2000/svg">' +
      '<circle fill="var(--ds-icon-success, #6A9A23)" cx="4" cy="4" r="4"></circle>' +
      '<path fill="var(--ds-surface-overlay, #FFFFFF)" ' +
      'd="M3.46 5.49 2.2 4.23a.4.4 0 0 1 .57-.57l.97.97 1.5-1.5a.4.4 0 1 1 .56.57L3.46 5.49Z"/>' +
      '</svg>';
  } else {
    inner.innerHTML =
      '<svg height="100%" version="1.1" viewBox="0 0 8 8" width="100%" xmlns="http://www.w3.org/2000/svg">' +
      '<circle fill="var(--ds-icon-warning, #B38600)" cx="4" cy="4" r="4"></circle>' +
      '<rect fill="var(--ds-surface-overlay, #FFFFFF)" x="1.8" y="3.5" width="4.4" height="1" rx="0.5"></rect>' +
      '</svg>';
  }
  wrap.appendChild(inner);
  return wrap;
}

/**
 * Mutate the SVG inside an existing `--status` span in place to match
 * `state`. Keeps the wrapper span (with its compiled AtlasKit classes)
 * untouched — only the circle/path shapes change.
 */
function rewriteStatusBadgeSvg(statusSpan: HTMLElement, state: ReviewState): void {
  const svg = statusSpan.querySelector('svg');
  if (!svg) return;
  if (state === 'approved') {
    svg.innerHTML =
      '<circle fill="var(--ds-icon-success, #6A9A23)" cx="4" cy="4" r="4"></circle>' +
      '<path fill="var(--ds-surface-overlay, #FFFFFF)" ' +
      'd="M3.46 5.49 2.2 4.23a.4.4 0 0 1 .57-.57l.97.97 1.5-1.5a.4.4 0 1 1 .56.57L3.46 5.49Z"/>';
  } else {
    svg.innerHTML =
      '<circle fill="var(--ds-icon-warning, #B38600)" cx="4" cy="4" r="4"></circle>' +
      '<rect fill="var(--ds-surface-overlay, #FFFFFF)" x="1.8" y="3.5" width="4.4" height="1" rx="0.5"></rect>';
  }
}

/**
 * Fallback path: build a custom `<li>` from scratch when no template node
 * is available (PR popover with zero native avatars somehow). Pixel-perfect
 * alignment with Jira's compiled markup isn't achievable here, but we still
 * render visually close to the native medium-avatar size.
 */
function buildExtraLiFallback(r: Reviewer, avatarSize: number): HTMLLIElement {
  const li = document.createElement('li');
  li.className = EXTRA_LI_CLASS;
  li.setAttribute(EXTRA_LI_ATTR, 'true');
  li.dataset.ejApproverKey = identityKey(r);
  li.dataset.ejAvatarSize = String(avatarSize);
  li.dataset.ejApproverState = r.changesRequested
    ? 'changes-requested'
    : r.approved
      ? 'approved'
      : 'none';

  const badgeSize = Math.round(avatarSize * 0.4);
  const initialSize = Math.round(avatarSize * 0.45);
  li.style.setProperty('--ej-avatar-size', `${avatarSize}px`);
  li.style.setProperty('--ej-avatar-badge-size', `${badgeSize}px`);
  li.style.setProperty('--ej-avatar-initial-size', `${initialSize}px`);

  const avatar = document.createElement('div');
  avatar.className = 'ej-extra-approver';
  avatar.setAttribute('role', 'img');
  const suffix = r.changesRequested
    ? ' (changes requested)'
    : r.approved
      ? ' (approved)'
      : '';
  const labelText = `${r.displayName || r.username}${suffix}`;
  avatar.setAttribute('aria-label', labelText);
  avatar.title = labelText;

  if (r.avatarUrl) {
    const img = document.createElement('img');
    img.className = 'ej-extra-approver-img';
    img.src = r.avatarUrl;
    img.alt = '';
    img.width = avatarSize;
    img.height = avatarSize;
    img.addEventListener('error', () => {
      img.replaceWith(buildInitialsNode(r, avatarSize));
    });
    avatar.appendChild(img);
  } else {
    avatar.appendChild(buildInitialsNode(r, avatarSize));
  }

  const state: ReviewState = r.changesRequested
    ? 'changes-requested'
    : r.approved
      ? 'approved'
      : 'none';
  const badge = buildFallbackStatusBadge(state);
  if (badge) {
    avatar.appendChild(badge);
  }

  li.appendChild(avatar);
  return li;
}

function buildInitialsNode(r: Reviewer, avatarSize?: number): HTMLElement {
  const span = document.createElement('span');
  span.className = 'ej-extra-approver-initial';
  const initial = (r.displayName || r.username || '?')
    .trim()
    .charAt(0)
    .toUpperCase();
  span.textContent = initial;
  // Cloned-template path doesn't load the EXTRA_LI_CLASS stylesheet rules,
  // so the initials node's CSS variables are unset. Pin the box size inline
  // when called from the cloned path so the swap-in fills the avatar.
  if (typeof avatarSize === 'number' && avatarSize > 0) {
    const initialSize = Math.round(avatarSize * 0.45);
    span.style.width = `${avatarSize}px`;
    span.style.height = `${avatarSize}px`;
    span.style.borderRadius = '50%';
    span.style.display = 'inline-flex';
    span.style.alignItems = 'center';
    span.style.justifyContent = 'center';
    span.style.userSelect = 'none';
    span.style.fontSize = `${initialSize}px`;
    span.style.background = 'var(--ds-background-neutral, #DCDFE4)';
    span.style.color = 'var(--ds-text-subtle, #44546F)';
    span.style.fontWeight = '600';
    span.style.fontFamily =
      'system-ui, -apple-system, "Segoe UI", sans-serif';
  }
  return span;
}

/**
 * The fallback-path corner status badge. Used by `buildExtraLiFallback`
 * (the no-template-available code path). SVG markup mirrors the live
 * popover snippet (green ds-icon-success circle + white check path for
 * approved; amber ds-icon-warning circle + white horizontal dash for
 * changes-requested). Returns null for the `'none'` state (pending
 * reviewers get no badge, same as Jira's native rendering).
 */
function buildFallbackStatusBadge(state: ReviewState): HTMLElement | null {
  if (state === 'none') return null;
  const wrap = document.createElement('span');
  wrap.className = 'ej-extra-approver-status';
  wrap.setAttribute('aria-hidden', 'true');
  if (state === 'approved') {
    wrap.innerHTML =
      '<svg viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg">' +
      '<circle fill="var(--ds-icon-success, #6A9A23)" cx="4" cy="4" r="4"></circle>' +
      '<path fill="var(--ds-surface-overlay, #FFFFFF)" ' +
      'd="M3.46 5.49 2.2 4.23a.4.4 0 0 1 .57-.57l.97.97 1.5-1.5a.4.4 0 1 1 .56.57L3.46 5.49Z"/>' +
      '</svg>';
  } else {
    wrap.innerHTML =
      '<svg viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg">' +
      '<circle fill="var(--ds-icon-warning, #B38600)" cx="4" cy="4" r="4"></circle>' +
      '<rect fill="var(--ds-surface-overlay, #FFFFFF)" x="1.8" y="3.5" width="4.4" height="1" rx="0.5"></rect>' +
      '</svg>';
  }
  return wrap;
}
