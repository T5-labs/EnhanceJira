import { startBoardWatcher } from './content/observer';
import { startColoring } from './content/coloring';
import { startBanner } from './content/banner';
import { startBranchHoverCard } from './content/branchHoverCard';
import { info, warnOnce } from '../lib/log';

/**
 * Detects the orphaned-content-script TypeError that fires when the user
 * reloads the extension via chrome://extensions while a Jira tab keeps the
 * previous content script injected. The old bundle's storage calls then
 * throw `Cannot read properties of undefined (reading 'onChanged' | 'local'
 * | 'sync' | 'storage')` because `browser.storage` / `browser.runtime` have
 * been ripped out from underneath it. Match narrowly so genuine TypeErrors
 * still surface.
 */
function isOrphanError(reason: unknown): boolean {
  if (!(reason instanceof TypeError)) return false;
  const m = reason.message ?? '';
  return /Cannot read properties of undefined.*\(reading '(onChanged|local|sync|storage)'\)/.test(m);
}

export default defineContentScript({
  matches: ['https://*.atlassian.net/jira/software/*'],
  main() {
    // Install the orphan-context safety net BEFORE any start* calls so
    // unhandled rejections from those subsystems are caught from the first
    // tick. Without this, every storage access from an orphaned bundle
    // surfaces on the chrome://extensions Errors page even though it's
    // expected and unactionable.
    try {
      window.addEventListener('unhandledrejection', (event) => {
        if (isOrphanError(event.reason)) {
          event.preventDefault();
          warnOnce('orphan-context', event.reason);
        }
      });
    } catch {
      // Listener install itself shouldn't ever throw, but if some embed
      // sandbox forbids it we'd rather lose the noise-suppression than
      // crash the content script before it boots.
    }

    info('content script alive on', location.href);
    void startBoardWatcher();
    startColoring();
    startBanner();
    startBranchHoverCard();
  },
});
