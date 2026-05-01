/**
 * Single content-side fan-out for `browser.storage.onChanged` events.
 *
 * Two modules in the content script need to react to storage changes:
 *   - coloring.ts (settings → palette + recolor; credentials → gate fetches)
 *   - banner.ts   (credentials → install/remove the no-token banner)
 *
 * Without this helper each one would register its own
 * `browser.storage.onChanged` listener and run the same
 * area-filter + key-filter + load-and-merge work twice for every storage
 * write. Consolidating is cheap and keeps the surface area for "did I
 * remember to update both?" bugs to a single subscription routine.
 *
 * This module owns the live `Settings` / `Credentials` snapshots — fan-out
 * subscribers receive the freshly-loaded value, not just a "something
 * changed" signal, so they don't need to re-call the load helpers themselves.
 */

import {
  loadCredentials,
  loadSettings,
  type Credentials,
  type Settings,
} from '../../lib/settings';
import {
  error as logError,
  isExtensionContextValid,
  warnOnce,
} from '../../lib/log';

export type StorageEvent =
  | { type: 'settingsChanged'; settings: Settings }
  | { type: 'credentialsChanged'; credentials: Credentials };

type Listener = (event: StorageEvent) => void;

const listeners = new Set<Listener>();
let installed = false;

function emit(event: StorageEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (e) {
      // One listener throwing must not stall the others — log and continue.
      logError('storage listener error', e);
    }
  }
}

function install(): void {
  if (installed) return;
  installed = true;

  // Bail before touching `browser.storage.onChanged` if the extension context
  // is gone (e.g. an orphaned content script left over from a chrome://
  // extensions reload). Trying to attach a listener through the polyfill in
  // that state throws "Cannot read properties of undefined (reading
  // 'onChanged')". The new content script that runs after the host tab
  // reloads gets a fresh module load and a live context, so this only
  // affects the orphaned predecessor.
  if (!isExtensionContextValid()) {
    warnOnce('storage:onChanged-install-skipped');
    return;
  }

  try {
    browser.storage.onChanged.addListener((changes, area) => {
      // The listener body is the second-most-likely place for the orphaned-
      // context error to surface: the listener may have been attached
      // successfully by a previously-live context, then fired AFTER the
      // extension was reloaded, at which point `loadSettings()` (etc.)
      // tries to touch `browser.storage.sync` on an invalidated context.
      // Wrap the whole body so the polyfill's unhandled-rejection chain
      // can't reach the chrome://extensions Errors page.
      try {
        if (area === 'sync' && changes['settings']) {
          void loadSettings()
            .then((settings) => {
              emit({ type: 'settingsChanged', settings });
            })
            .catch((e) => {
              warnOnce('storage:onChanged-loadSettings', e);
            });
          return;
        }
        if (area === 'local' && changes['credentials']) {
          void loadCredentials()
            .then((credentials) => {
              emit({ type: 'credentialsChanged', credentials });
            })
            .catch((e) => {
              warnOnce('storage:onChanged-loadCredentials', e);
            });
          return;
        }
        // Other areas / keys: ignored.
      } catch (e) {
        warnOnce('storage:onChanged-listener-body', e);
      }
    });
  } catch (e) {
    warnOnce('storage:onChanged-addListener', e);
  }
}

/**
 * Subscribe to settings/credentials changes. Listener fires with the freshly
 * loaded value. Returns an unsubscribe function.
 */
export function onStorageChange(listener: Listener): () => void {
  install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
