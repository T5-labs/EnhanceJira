/**
 * Shared content-side PR state cache.
 *
 * Both ./coloring.ts (paint cards) and ./tooltip.ts (hover popup) need the
 * same `PRState[]` data per Jira key. Without a shared cache they'd either:
 *   - duplicate GET_PR_STATE message traffic (one per consumer per pass), or
 *   - the tooltip would spinner-flash on every hover even when coloring just
 *     fetched the same data 50ms ago.
 *
 * This module owns the cache, the in-flight coalesce map, the per-key
 * cooldown, and a tiny pub/sub for "got fresh data for key X" events. The
 * worker still has its own 30s cache + coalesce; this layer is purely an
 * extra in-process dedupe to keep the message channel quiet on busy boards.
 *
 * No DOM, no settings, no rendering — purely a typed cache + fetch facade.
 */

import type { GetPRStateResponse } from '../../lib/messages';
import type { CardState } from '../../lib/coloring';
import { error as logError } from '../../lib/log';

const PER_KEY_FETCH_COOLDOWN_MS = 10_000;

type CacheEntry =
  | { ok: true; response: GetPRStateResponse; fetchedAt: number }
  | undefined;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<GetPRStateResponse>>();
const lastFetchAt = new Map<string, number>();

/**
 * Per-key last-known CardState cache. Keyed by Jira ticket key (string), so it
 * survives Jira's virtualization unmount/remount cycles within the same
 * session — a card scrolled out of view and back in is the same key, so the
 * cached state is still applicable.
 *
 * Lives here (not in coloring.ts) because the observer's synchronous fast-path
 * paint reads it during the MutationObserver callback, before the debounced
 * recolor pass runs. See `observer.ts` `runFastPathPaint` for the read site.
 */
const lastCardState = new Map<string, CardState>();

/** Read the last-known CardState for a Jira key, or undefined if uncached. */
export function getCachedCardState(key: string): CardState | undefined {
  return lastCardState.get(key);
}

/** Record the last-known CardState for a Jira key. */
export function setCachedCardState(key: string, state: CardState): void {
  lastCardState.set(key, state);
}

/** Drop the cached CardState for a Jira key (used when key leaves the board). */
export function deleteCachedCardState(key: string): void {
  lastCardState.delete(key);
}

/** Iterate the keys that currently have a cached CardState. */
export function cachedCardStateKeys(): IterableIterator<string> {
  return lastCardState.keys();
}

/**
 * Per-key last-known self-status (the connected user's review state for the
 * ticket's PR(s)). Same lifecycle / pruning rules as `lastCardState` — the
 * observer's synchronous fast-path paint reads it on virtualization remount,
 * so we deliberately keep entries across scroll-driven unmounts (see header
 * comment on `lastCardState` and on `pruneKeys`). Values are 'approved',
 * 'changes-requested', or 'none'; 'none' is meaningful (renders no badge but
 * means "we know the user has no action on this ticket"), so the cache stores
 * it explicitly rather than relying on absence.
 */
export type SelfState = 'approved' | 'changes-requested' | 'none';

const lastCardSelfState = new Map<string, SelfState>();

/** Read the last-known self-status for a Jira key, or undefined if uncached. */
export function getCachedSelfState(key: string): SelfState | undefined {
  return lastCardSelfState.get(key);
}

/** Record the last-known self-status for a Jira key. */
export function setCachedSelfState(key: string, state: SelfState): void {
  lastCardSelfState.set(key, state);
}

type Listener = (response: GetPRStateResponse) => void;
const listeners = new Map<string, Set<Listener>>();

/**
 * Synchronous read — returns the most recent cached response for the key, or
 * undefined if we've never fetched it.
 */
export function getCachedPRs(key: string): GetPRStateResponse | undefined {
  const entry = cache.get(key);
  return entry?.response;
}

/**
 * Subscribe to fresh-data events for a specific key. Listener fires every
 * time a fetch settles for that key (whether ok or err). Returns an
 * unsubscribe fn.
 */
export function subscribeToKey(key: string, listener: Listener): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const s = listeners.get(key);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) listeners.delete(key);
  };
}

function emit(key: string, response: GetPRStateResponse): void {
  const set = listeners.get(key);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(response);
    } catch (e) {
      logError('state listener error', e);
    }
  }
}

/**
 * Request PR state for a key.
 *
 *   - If a fetch is already in flight for this key, returns that promise.
 *   - If `force` is false and we fetched within the cooldown window, returns
 *     the cached response immediately (or a synthetic "no response" if we've
 *     somehow never fetched — defensive only; coloring's recolor pass always
 *     primes the cache before tooltip ever asks).
 *   - Otherwise, dispatches a GET_PR_STATE to the worker, caches the result,
 *     and notifies subscribers.
 *
 * `force = true` skips the cooldown — used by the periodic refresh tick and
 * settings-change recolors.
 */
export function requestPRs(
  key: string,
  tenant: string,
  force = false,
): Promise<GetPRStateResponse> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  if (!force) {
    const last = lastFetchAt.get(key) ?? 0;
    if (Date.now() - last < PER_KEY_FETCH_COOLDOWN_MS) {
      const cached = getCachedPRs(key);
      if (cached) return Promise.resolve(cached);
    }
  }

  lastFetchAt.set(key, Date.now());

  const p = (async (): Promise<GetPRStateResponse> => {
    let response: GetPRStateResponse;
    try {
      const r = (await browser.runtime.sendMessage({
        type: 'GET_PR_STATE',
        key,
        tenant,
      })) as GetPRStateResponse | undefined;
      response = r ?? { ok: false, error: 'No response from worker' };
    } catch (e) {
      response = {
        ok: false,
        error: e instanceof Error ? e.message : 'sendMessage failed',
      };
    }
    cache.set(key, { ok: true, response, fetchedAt: Date.now() });
    emit(key, response);
    return response;
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, p);
  return p;
}

/**
 * Drop bookkeeping for keys not currently visible on the board. Called by
 * coloring after each tag-pass with the live key set.
 *
 * IMPORTANT: `lastCardState` is intentionally NOT pruned here. Jira virtualizes
 * off-screen cards: a card scrolled out of view leaves the DOM (so its key
 * leaves `liveKeys`), then re-mounts when scrolled back. If we dropped its
 * cached CardState on every unmount, the observer's synchronous fast-path
 * paint would have nothing to apply on remount and the card would flash its
 * default color until the network fetch settled — exactly the user-visible
 * scroll-flicker bug. Letting `lastCardState` outlive scroll-driven unmounts
 * is the whole point of keying by string Jira-key rather than DOM element.
 *
 * The fetch cache, cooldown map, and per-key listener registry ARE pruned
 * (those resources have real cost — bytes per cached PRState[], in-flight
 * Promise chains, listener closures), and a card moved out of Review for real
 * (different column, deleted issue) won't re-enter the Review column again
 * during this session. If it ever does, a stale CardState in the cache is
 * fine — the next fetch result overwrites it via `setCachedCardState`.
 *
 * In the worst case, `lastCardState` grows to one entry per Jira key seen
 * in Review during the session — kilobytes at most for a busy board, freed
 * on the next page navigation or reload.
 */
export function pruneKeys(liveKeys: Set<string>): void {
  for (const k of cache.keys()) {
    if (!liveKeys.has(k)) cache.delete(k);
  }
  for (const k of lastFetchAt.keys()) {
    if (!liveKeys.has(k)) lastFetchAt.delete(k);
  }
  for (const k of listeners.keys()) {
    if (!liveKeys.has(k)) listeners.delete(k);
  }
  // lastCardState is deliberately NOT pruned here — see header comment.
}
