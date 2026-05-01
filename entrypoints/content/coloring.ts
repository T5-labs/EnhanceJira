/**
 * Content-side orchestrator: paints tagged Review-column cards green or red
 * based on PR state from the worker, and keeps that paint in sync with
 * settings + periodic refreshes. Pending cards (PR exists but not enough
 * approvals or a required approver hasn't approved) get NO override — the
 * card displays Jira's default surface color, same as cards with no PR.
 *
 * Lifecycle:
 *   1. installStyles() — guarantees the <style> tag is present
 *   2. Load settings, applyColorOverrides() with the configured palette
 *   3. Subscribe via the shared `onStorageChange`:
 *        - settings: re-write the palette (CSS variables only — no per-card
 *          work) and force-recolor every tagged card (rule may have shifted
 *          because minApprovals or required approvers changed).
 *        - credentials: flip the "connected" gate so we stop spamming the
 *          worker with GET_PR_STATE messages while disconnected.
 *   4. Subscribe to observer's onCardsChanged hook — fetch + paint newly
 *      tagged cards, drop bookkeeping for untagged cards
 *   5. setInterval @ 60s — refresh state for every tagged card, but ONLY if
 *      document.visibilityState === 'visible'. Hidden tab → no API hits.
 *
 * v0.3.0 simplification: the author-scope filter (`Settings.scope`) was
 * removed — every Review-column card the board shows is colored. Lead/PM
 * "team-overview" mode is now the only mode; users who want a personal-only
 * view rely on Jira's native board-level filters instead of an in-extension
 * pivot.
 *
 * Fetch dedupe and per-key cooldown live in ./state.ts now (P6) so the
 * tooltip can share the same cached PRState[] without duplicate message
 * traffic. This module just decides paint based on whatever the cache returns.
 */

import {
  loadCredentials,
  loadSettings,
  type Credentials,
  type Settings,
} from '../../lib/settings';
import {
  aggregateCardState,
  type CardState,
} from '../../lib/coloring';
import type { GetPRStateResponse } from '../../lib/messages';
import { info } from '../../lib/log';
import { installStyles, applyColorOverrides } from './style';
import { findTaggedCards, onCardsChanged } from './observer';
import {
  requestPRs,
  pruneKeys,
  getCachedCardState,
  setCachedCardState,
} from './state';
import { onStorageChange } from './storageEvents';

const REFRESH_INTERVAL_MS = 60_000;

let currentSettings: Settings | null = null;
let connected = false;
// Per-key last-known CardState lives in ./state.ts so the observer's
// synchronous fast-path paint can read it before the debounced recolor pass.

/**
 * Public entrypoint — wire up styles, settings, change listeners, and the
 * periodic refresh loop. Idempotent: safe to call once per content-script
 * lifetime; will not double-subscribe.
 */
export function startColoring(): void {
  installStyles();

  // Kick off async setup — we don't await; the first tag-pass and first
  // refresh tick will catch up once settings + listener are in place.
  void initialize();
}

async function initialize(): Promise<void> {
  const [settings, creds] = await Promise.all([loadSettings(), loadCredentials()]);
  currentSettings = settings;
  connected = hasCredentials(creds);
  applyColorOverrides(settings.colors);

  info('coloring active');

  // Shared storage fan-out — single listener installed in storageEvents.ts.
  onStorageChange((event) => {
    if (event.type === 'settingsChanged') {
      currentSettings = event.settings;
      applyColorOverrides(event.settings.colors);
      info('colors updated');
      // The aggregation rule may have shifted (minApprovals / required
      // approvers). Force-recompute every card; the worker still has its 30s
      // cache so this is cheap.
      void recolorAll(/* force */ true);
      return;
    }
    if (event.type === 'credentialsChanged') {
      const next = hasCredentials(event.credentials);
      if (next === connected) return;
      connected = next;
      // Newly-connected: prime the paint pass immediately.
      // Newly-disconnected: nothing to do — the next tag-pass / refresh tick
      // will short-circuit on the closed gate, and any in-flight fetches will
      // settle harmlessly.
      if (connected) {
        void recolorAll(/* force */ true);
      }
      return;
    }
  });

  // Tag-pass hook: fires AFTER each observer pass so we always know the
  // current set of tagged cards.
  onCardsChanged(() => {
    void recolorAll();
  });

  // Periodic refresh — gated on visibility AND credentials inside the tick.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!connected) return;
    const cards = findTaggedCards();
    if (cards.length === 0) return;
    info(`refresh tick — ${cards.length} cards`);
    void recolorAll(/* force */ true);
  }, REFRESH_INTERVAL_MS);

  // First paint pass for whatever the observer has already tagged.
  void recolorAll();
}

function hasCredentials(c: Credentials): boolean {
  return c.username.length > 0 && c.token.length > 0;
}

/**
 * Recolor every currently-tagged card.
 *
 * `force` skips the per-key cooldown — used on settings change and on the
 * periodic refresh tick so user-visible config changes paint immediately.
 *
 * If credentials are absent the per-card loop short-circuits — no message
 * traffic, cards stay at their existing `data-ej-state` (typically "unknown").
 * Bookkeeping pruning still runs so we don't leak entries for cards that
 * left the board while we were disconnected.
 */
async function recolorAll(force = false): Promise<void> {
  const cards = findTaggedCards();
  // Drop bookkeeping for keys no longer on the board.
  const liveKeys = new Set<string>();
  for (const card of cards) {
    const key = card.dataset.ejKey;
    if (key) liveKeys.add(key);
  }
  // pruneKeys also drops cached CardState entries whose key has left the
  // board, so the per-key last-state cache is kept in lockstep with the
  // PR-fetch cache and listener registry — no separate sweep needed here.
  pruneKeys(liveKeys);

  if (!connected) return;

  await Promise.all(cards.map((card) => recolorCard(card, force)));
}

async function recolorCard(card: HTMLElement, force: boolean): Promise<void> {
  const key = card.dataset.ejKey;
  if (!key) return;
  if (!currentSettings) return;

  // Immediate re-paint from last-known state. When Jira's React replaces a
  // card element (virtualization remount, lazy-load re-render) the new
  // element comes back with no data-ej-state, so even though the network
  // fetch is fast, the user sees a brief gap of "no color". Reapplying the
  // remembered state here closes that gap — the subsequent fetch may
  // overwrite with a fresher value, but the card never visibly loses color.
  // The same cache is also consulted by observer.ts's synchronous fast-path
  // paint, which beats this code path to the punch on virtualized remounts.
  const lastKnown = getCachedCardState(key);
  if (lastKnown !== undefined && card.dataset.ejState !== lastKnown) {
    card.dataset.ejState = lastKnown;
  }

  const response: GetPRStateResponse = await requestPRs(
    key,
    window.location.host,
    force,
  );

  let state: CardState;
  if (!response.ok) {
    state = 'error';
  } else {
    state = aggregateCardState(response.prs, currentSettings);
  }

  // Make sure the card is still in the DOM — virtualization may have evicted
  // it during the fetch round-trip.
  if (!card.isConnected) return;

  if (card.dataset.ejState !== state) {
    card.dataset.ejState = state;
  }

  if (getCachedCardState(key) !== state) {
    info(`colored ${key} → ${state}`);
    setCachedCardState(key, state);
  }
}

