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
import { error as logError } from '../../lib/log';

const PER_KEY_FETCH_COOLDOWN_MS = 10_000;

type CacheEntry =
  | { ok: true; response: GetPRStateResponse; fetchedAt: number }
  | undefined;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<GetPRStateResponse>>();
const lastFetchAt = new Map<string, number>();

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
 * Drop bookkeeping for keys no longer on the board. Called by coloring after
 * each tag-pass with the live key set.
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
}
