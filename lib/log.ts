/**
 * Tiny logging facade. Three always-on levels (info / warn / error) plus a
 * verbose `debug` channel gated by an opt-in flag.
 *
 * Why this exists:
 *   - The codebase had grown a forest of ad-hoc `console.log('[EJ] ...')`
 *     calls. Some are meaningful events (worker up, content script alive,
 *     N cards tagged); others are useful only when actively diagnosing
 *     (every tooltip show, every ESC dismiss). Mixing the two means
 *     console-spammy boards by default. Routing the second set through
 *     `debug` cleans the default console while preserving full visibility
 *     when needed.
 *
 * Activation:
 *   - In contexts with `localStorage` (content script, options page, popup):
 *     set `localStorage.EJ_DEBUG = '1'` once to enable. We read it at
 *     module-load time and cache the boolean — re-checking on every call
 *     would burn microseconds for no gain.
 *   - In service worker contexts there is no `localStorage`. Set
 *     `globalThis.EJ_DEBUG = true` from devtools instead. We re-check
 *     `globalThis.EJ_DEBUG` on every `debug` call so you can flip it
 *     without reloading the worker.
 *
 * SECURITY:
 *   - This module is a SINK, not a sanitizer. It does not redact
 *     credentials or auth headers — that discipline lives at every call
 *     site. Never pass a `Credentials` object, an `Authorization` header
 *     string, or a `TestConnection` request body through ANY of these
 *     functions.
 */

const PREFIX = '[EJ]';

let cachedLocalStorageDebug = false;
try {
  if (typeof localStorage !== 'undefined') {
    cachedLocalStorageDebug = localStorage.getItem('EJ_DEBUG') === '1';
  }
} catch {
  // Some sandboxed contexts throw on localStorage access — treat as off.
  cachedLocalStorageDebug = false;
}

function debugEnabled(): boolean {
  if (cachedLocalStorageDebug) return true;
  // Service-worker fallback: re-check the global on each call so devtools
  // toggling is live.
  try {
    return (globalThis as { EJ_DEBUG?: unknown }).EJ_DEBUG === true;
  } catch {
    return false;
  }
}

export function debug(...args: unknown[]): void {
  if (!debugEnabled()) return;
  // eslint-disable-next-line no-console
  console.log(PREFIX, ...args);
}

export function info(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(PREFIX, ...args);
}

export function warn(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.warn(PREFIX, ...args);
}

export function error(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error(PREFIX, ...args);
}

/**
 * Module-local once-set so a given failure mode logs at most one warning per
 * key per module-load lifetime. Used by storage-access guards to avoid
 * spamming the console when an orphaned content script fires its observer
 * over and over after extension reload.
 */
const warnOnceSeen = new Set<string>();

/**
 * Log a `warn` at most once per `key` per page lifetime. The intent is the
 * same as the local `warnOnce` helpers in observer.ts / branchHoverCard.ts,
 * but exposed centrally so storage-access call sites can share a single
 * dedup namespace. Pass a stable, narrow `key` ("storage:loadSettings",
 * "storage:onChanged-listener") so distinct failure modes still get one
 * line each.
 */
export function warnOnce(key: string, ...args: unknown[]): void {
  if (warnOnceSeen.has(key)) return;
  warnOnceSeen.add(key);
  // eslint-disable-next-line no-console
  console.warn(PREFIX, key, ...args);
}

/**
 * Defensive probe for whether this script's extension context is still
 * alive. Returns `false` from an orphaned content script (the user reloaded
 * the extension via chrome://extensions while a tab kept the previous
 * content script injected) — `chrome.runtime.id` becomes `undefined` in
 * that state, which trips the `browser?.runtime?.id` chain inside the
 * bundled webextension-polyfill shim. Storage calls from such a context
 * either throw or return `undefined`, producing the unhandled-promise
 * "Cannot read properties of undefined (reading 'local'/'sync'/'onChanged')"
 * errors visible on the chrome://extensions Errors page.
 *
 * Wrapped in try/catch because evaluating `browser.runtime.id` from an
 * invalidated context can itself throw (the polyfill rebinds the global).
 *
 * NB: this is a `false` answer, not a `false-now-but-might-recover`
 * answer — there's no path back from an invalidated context for THIS
 * script. The new content script (after the host tab reloads) gets a
 * fresh context and a fresh module load.
 */
export function isExtensionContextValid(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Boolean((browser as any)?.runtime?.id);
  } catch {
    return false;
  }
}
