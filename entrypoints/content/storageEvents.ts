/**
 * Single content-side fan-out for `browser.storage.onChanged` events.
 *
 * Three modules in the content script need to react to storage changes:
 *   - coloring.ts (settings → palette + recolor; credentials → gate fetches;
 *                  identity → re-evaluate scope filter)
 *   - tooltip.ts  (settings → re-render aggregation thresholds; identity →
 *                  re-evaluate scope filter)
 *   - banner.ts   (credentials → install/remove the no-token banner)
 *
 * Without this helper each one would register its own
 * `browser.storage.onChanged` listener and run the same
 * area-filter + key-filter + load-and-merge work three times for every
 * storage write. Consolidating is cheap and keeps the surface area for
 * "did I remember to update all three?" bugs to a single subscription
 * routine.
 *
 * This module owns the live `Settings` / `Credentials` / `Identity` snapshots
 * — fan-out subscribers receive the freshly-loaded value, not just a
 * "something changed" signal, so they don't need to re-call the load
 * helpers themselves.
 */

import {
  loadCredentials,
  loadIdentity,
  loadSettings,
  type Credentials,
  type Identity,
  type Settings,
} from '../../lib/settings';
import { error as logError } from '../../lib/log';

export type StorageEvent =
  | { type: 'settingsChanged'; settings: Settings }
  | { type: 'credentialsChanged'; credentials: Credentials }
  | { type: 'identityChanged'; identity: Identity | null };

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

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes['settings']) {
      void loadSettings().then((settings) => {
        emit({ type: 'settingsChanged', settings });
      });
      return;
    }
    if (area === 'local' && changes['credentials']) {
      void loadCredentials().then((credentials) => {
        emit({ type: 'credentialsChanged', credentials });
      });
      return;
    }
    if (area === 'local' && changes['identity']) {
      void loadIdentity().then((identity) => {
        emit({ type: 'identityChanged', identity });
      });
      return;
    }
    // Other areas / keys: ignored.
  });
}

/**
 * Subscribe to settings/credentials/identity changes. Listener fires with the
 * freshly loaded value. Returns an unsubscribe function.
 */
export function onStorageChange(listener: Listener): () => void {
  install();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
