/**
 * Content-side orchestrator: paints tagged Review-column cards green / yellow
 * / red based on PR state from the worker, and keeps that paint in sync with
 * settings + periodic refreshes.
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
 *        - identity: kept for ConnectedCard on the options page; not consumed
 *          here (v0.2.0 author-scope filter was removed in v0.3.0).
 *   4. Subscribe to observer's onCardsChanged hook — fetch + paint newly
 *      tagged cards, drop bookkeeping for untagged cards
 *   5. setInterval @ 60s — refresh state for every tagged card, but ONLY if
 *      document.visibilityState === 'visible'. Hidden tab → no API hits.
 *   6. browser.runtime.onMessage handler for the popup-side messages
 *      GET_BOARD_COUNTS and FORCE_REFRESH (sent via tabs.sendMessage; the
 *      worker has its own, separate listener for runtime.sendMessage
 *      messages — the two coexist).
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
import type {
  GetPRStateResponse,
  GetBoardCountsResponse,
  ForceRefreshResponse,
  Message,
} from '../../lib/messages';
import { info } from '../../lib/log';
import { installStyles, applyColorOverrides } from './style';
import { findTaggedCards, onCardsChanged } from './observer';
import { requestPRs, pruneKeys } from './state';
import { onStorageChange } from './storageEvents';

const REFRESH_INTERVAL_MS = 60_000;

let currentSettings: Settings | null = null;
let connected = false;
const lastLoggedState = new Map<string, CardState>();

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
    // identityChanged: kept by storageEvents for the ConnectedCard on the
    // options page; not consumed here in v0.3.0.
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

  // Popup → content-script bridge.
  installPopupBridge();

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
  pruneKeys(liveKeys);
  for (const tracked of [...lastLoggedState.keys()]) {
    if (!liveKeys.has(tracked)) {
      lastLoggedState.delete(tracked);
    }
  }

  if (!connected) return;

  await Promise.all(cards.map((card) => recolorCard(card, force)));
}

async function recolorCard(card: HTMLElement, force: boolean): Promise<void> {
  const key = card.dataset.ejKey;
  if (!key) return;
  if (!currentSettings) return;

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

  if (lastLoggedState.get(key) !== state) {
    info(`colored ${key} → ${state}`);
    lastLoggedState.set(key, state);
  }
}

// ─── Popup bridge ───────────────────────────────────────────────────────────

/**
 * Listen for the popup-only message types (GET_BOARD_COUNTS, FORCE_REFRESH).
 * These are dispatched via `browser.tabs.sendMessage(tabId, ...)`, which
 * routes to the content script's `runtime.onMessage` listener — distinct
 * from the worker's listener, which only sees `runtime.sendMessage` traffic.
 */
function installPopupBridge(): void {
  browser.runtime.onMessage.addListener(
    (raw, _sender): undefined | Promise<GetBoardCountsResponse | ForceRefreshResponse> => {
      const msg = raw as Message;
      if (msg.type === 'GET_BOARD_COUNTS') {
        return Promise.resolve(computeBoardCounts());
      }
      if (msg.type === 'FORCE_REFRESH') {
        return forceRefreshAll();
      }
      // Not for us — let other listeners (or the worker) handle it.
      return undefined;
    },
  );
}

function computeBoardCounts(): GetBoardCountsResponse {
  const counts: GetBoardCountsResponse = {
    green: 0,
    yellow: 0,
    red: 0,
    noPr: 0,
    error: 0,
    unknown: 0,
    total: 0,
  };
  for (const card of findTaggedCards()) {
    counts.total += 1;
    const state = card.dataset.ejState;
    switch (state) {
      case 'green':
        counts.green += 1;
        break;
      case 'yellow':
        counts.yellow += 1;
        break;
      case 'red':
        counts.red += 1;
        break;
      case 'no-pr':
        counts.noPr += 1;
        break;
      case 'error':
        counts.error += 1;
        break;
      default:
        counts.unknown += 1;
        break;
    }
  }
  return counts;
}

async function forceRefreshAll(): Promise<ForceRefreshResponse> {
  const cards = findTaggedCards();
  // Wipe content-side cooldowns so requestPRs hits the worker.
  // pruneKeys with an empty set drops everything.
  pruneKeys(new Set());
  // Reset per-key state-change logging so a force refresh reports current
  // state freshly.
  lastLoggedState.clear();
  await recolorAll(/* force */ true);
  return { ok: true, refreshed: cards.length };
}
