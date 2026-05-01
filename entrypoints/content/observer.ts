/**
 * Observer wiring: detect the Jira board, find Review columns, tag their
 * cards with `data-ej-key` + `data-ej-state="unknown"`, and untag cards
 * that leave Review. Survives virtualization churn via a debounced
 * MutationObserver.
 *
 * Three-layer resilience to Jira's React render churn:
 *   1. Board observer (childList + subtree) catches normal card add/remove.
 *   2. Board observer also watches `data-ej-state` / `data-ej-key`
 *      attribute mutations so we re-fire a pass if Jira's commit phase
 *      drops our state attribute during a card re-render.
 *   3. Body-level resilience observer detects when the board element
 *      itself is replaced by Jira (route change, Suspense re-resolve) and
 *      triggers a re-attach of the primary observer.
 *
 * Pure side-effecting glue — DOM helpers live in ./board.
 */

import {
  SELECTORS,
  findBoard,
  findReviewColumns,
  findCardsInColumn,
  extractKey,
  tagCard,
  untagCard,
  findTaggedCards,
} from './board';
import { getCachedCardState } from './state';
import { info, warn, error as logError } from '../../lib/log';

const DEBOUNCE_MS = 100;
const BOARD_POLL_MS = 500;

let lastReportedCount = -1;
let warnedMissingKey = false;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let boardObserver: MutationObserver | null = null;
let bodyResilienceObserver: MutationObserver | null = null;

// Subscribers fired AFTER each tag/untag pass completes. P5's coloring
// orchestrator subscribes here; future surfaces (tooltip in P6) can too.
type CardsChangedListener = () => void;
const cardsChangedListeners: CardsChangedListener[] = [];

/**
 * Subscribe to tag-pass completion. Listener fires once after every pass
 * (initial pass at startup + every debounced re-pass on board mutation).
 * Returns an unsubscribe fn.
 */
export function onCardsChanged(listener: CardsChangedListener): () => void {
  cardsChangedListeners.push(listener);
  return () => {
    const idx = cardsChangedListeners.indexOf(listener);
    if (idx !== -1) cardsChangedListeners.splice(idx, 1);
  };
}

function emitCardsChanged(): void {
  for (const fn of cardsChangedListeners) {
    try {
      fn();
    } catch (e) {
      // One listener throwing must not stall the others or the observer.
      logError('cardsChanged listener error', e);
    }
  }
}

// Re-export for downstream modules that want the live tagged-card set.
export { findTaggedCards } from './board';

/**
 * Run a single tag/untag pass:
 *   - Tag every card under a Review column with its issue key.
 *   - Untag any previously-tagged card that's no longer under a Review column.
 */
function runPass(board: HTMLElement): void {
  const reviewColumns = findReviewColumns(board);

  if (reviewColumns.length === 0) {
    // Boards legitimately may not have a Review column — silently no-op
    // beyond untagging anything previously tagged (Review may have been
    // renamed/removed).
    for (const stale of findTaggedCards()) {
      untagCard(stale);
    }
    reportCount(0);
    emitCardsChanged();
    return;
  }

  // Collect the current set of cards in Review columns.
  const currentReviewCards = new Set<HTMLElement>();
  for (const col of reviewColumns) {
    for (const card of findCardsInColumn(col)) {
      currentReviewCards.add(card);
    }
  }

  // Tag in-Review cards.
  let tagged = 0;
  for (const card of currentReviewCards) {
    const key = extractKey(card);
    if (!key) {
      if (!warnedMissingKey) {
        warn('Card missing key — skipping');
        warnedMissingKey = true;
      }
      continue;
    }
    tagCard(card, key);
    tagged += 1;
  }

  // Untag cards previously tagged that are no longer in a Review column.
  for (const prev of findTaggedCards()) {
    if (!currentReviewCards.has(prev)) {
      untagCard(prev);
    }
  }

  reportCount(tagged);
  emitCardsChanged();
}

function reportCount(n: number): void {
  if (n !== lastReportedCount) {
    info(`Tagged ${n} Review-column cards`);
    lastReportedCount = n;
  }
}

/**
 * Synchronous fast-path paint. Runs INSIDE the MutationObserver callback,
 * before the debounced schedulePass(), so virtualized cards that just
 * remounted into the DOM get their cached color applied immediately rather
 * than after the ~100ms debounce window.
 *
 * Cheap and idempotent:
 *   - Walks Review-column cards (already filtered by column name).
 *   - Looks up each card's key via extractKey (no fetches, pure DOM read).
 *   - If a CardState is cached for that key, sets data-ej-key + data-ej-state
 *     synchronously. Skips the write when both attributes already match.
 *   - Does NOT untag, fetch, or otherwise touch the network — that stays on
 *     the debounced schedulePass path which still runs immediately after.
 *
 * Cards whose key has never been colored have no cached entry and remain
 * untouched here; they get their first paint from the debounced pass when
 * the network fetch returns. That's a one-time first-paint cost per key per
 * session, not the per-scroll flash the user reported.
 */
function runFastPathPaint(board: HTMLElement): void {
  const reviewColumns = findReviewColumns(board);
  if (reviewColumns.length === 0) return;
  for (const col of reviewColumns) {
    for (const card of findCardsInColumn(col)) {
      const key = extractKey(card);
      if (!key) continue;
      const cached = getCachedCardState(key);
      // Skip cards we've never seen state for; the debounced pass will pick
      // them up on first mount.
      if (cached === undefined) continue;
      // Set the key first so downstream consumers (and the debounced pass's
      // findTaggedCards reconciliation) treat it as already tagged.
      if (card.dataset.ejKey !== key) {
        card.dataset.ejKey = key;
      }
      if (card.dataset.ejState !== cached) {
        card.dataset.ejState = cached;
      }
    }
  }
}

function schedulePass(): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
  }
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    // Board element may have been replaced by Jira; resolve afresh and
    // re-attach the observer to the new node if so. Without re-attach the
    // observer would be silently dead and we'd never see further mutations.
    const live = findBoard();
    if (!live) return;
    if (observedBoard !== live) {
      attachBoardObserver(live);
    }
    runPass(live);
  }, DEBOUNCE_MS);
}

let observedBoard: HTMLElement | null = null;

function attachBoardObserver(board: HTMLElement): void {
  if (boardObserver !== null) {
    boardObserver.disconnect();
  }
  observedBoard = board;
  // attributes: true with a filter on our own data-ej-* attributes is the
  // key fix for the "colors flash then disappear" bug. Jira's React commit
  // phase can drop our data-ej-state during card re-renders (virtualized
  // remounts, lazy avatar/parent-issue arrival), so we must re-fire a pass
  // whenever the attribute changes — not just when childList changes.
  //
  // The synchronous fast-path paint runs BEFORE the debounced schedulePass()
  // so virtualized cards that just remounted get their cached color applied
  // immediately, eliminating the ~100ms uncolored flash users see when
  // scrolling cards back into view. The debounced pass still runs to handle
  // tagging fresh keys, untagging stale ones, and fetching network state.
  boardObserver = new MutationObserver(() => {
    runFastPathPaint(board);
    schedulePass();
  });
  boardObserver.observe(board, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-ej-state', 'data-ej-key'],
  });
}

/**
 * Wait until the board is in the DOM. Uses a body-level MutationObserver
 * primarily, with a periodic poll as a belt-and-suspenders fallback in
 * case the board's insertion happens before our observer attaches.
 */
function waitForBoard(): Promise<HTMLElement> {
  return new Promise((resolve) => {
    const existing = findBoard();
    if (existing) {
      resolve(existing);
      return;
    }

    let resolved = false;
    const finish = (board: HTMLElement) => {
      if (resolved) return;
      resolved = true;
      bodyObserver.disconnect();
      clearInterval(pollHandle);
      resolve(board);
    };

    const bodyObserver = new MutationObserver(() => {
      const found = findBoard();
      if (found) finish(found);
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });

    const pollHandle = setInterval(() => {
      const found = findBoard();
      if (found) finish(found);
    }, BOARD_POLL_MS);
  });
}

/**
 * Lightweight body-level observer that survives the board element being
 * replaced wholesale (route changes, React Suspense re-resolution). The
 * primary `boardObserver` only sees mutations inside the board it was
 * attached to — if Jira detaches that board and re-mounts a new one higher
 * in the tree, the primary observer is silently dead. This watcher catches
 * that case by polling for board re-appearance whenever something changes
 * outside our current observed root, and triggers a re-attach via
 * schedulePass (which already handles board element replacement).
 */
function attachBodyResilience(): void {
  if (bodyResilienceObserver !== null) return;
  bodyResilienceObserver = new MutationObserver(() => {
    // Cheap fast-path: if our observed board is still connected, do nothing.
    // Body mutations fire constantly on a busy Jira page (avatar loads, input
    // events, etc.) so we must not run findBoard() on every mutation batch.
    if (observedBoard !== null && observedBoard.isConnected) return;
    // Observed board got detached — search for a replacement and trigger a
    // re-attach via schedulePass (which handles board swap + reseating the
    // primary observer).
    if (findBoard() !== null) {
      schedulePass();
    }
  });
  // childList + subtree, NO attributes. The fast-path above turns this into
  // one boolean check per mutation batch when the board is healthy, so the
  // wide subtree scope is fine. Attributes are excluded to avoid waking up
  // on every Jira input/hover state change.
  bodyResilienceObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

/**
 * Public entrypoint: wait for the board, do an initial pass, and keep
 * passing on every (debounced) board mutation.
 */
export async function startBoardWatcher(): Promise<void> {
  info('Waiting for Jira board...');
  const board = await waitForBoard();
  info('Board found, starting Review-column watcher');
  // SELECTORS reference keeps the import alive even if tree-shaking gets
  // aggressive about pure-helper modules; also useful for dev-console probing.
  void SELECTORS;
  runPass(board);
  attachBoardObserver(board);
  attachBodyResilience();
}
