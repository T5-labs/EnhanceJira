/**
 * Observer wiring for Phase 1: detect the Jira board, find Review columns,
 * tag their cards with `data-ej-key` + `data-ej-state="unknown"`, and untag
 * cards that leave Review. Survives virtualization churn via a debounced
 * MutationObserver.
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
import { info, warn, error as logError } from '../../lib/log';

const DEBOUNCE_MS = 100;
const BOARD_POLL_MS = 500;

let lastReportedCount = -1;
let warnedNoReviewColumn = false;
let warnedMissingKey = false;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let boardObserver: MutationObserver | null = null;

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
    if (!warnedNoReviewColumn) {
      warn('No "Review" column found on this board');
      warnedNoReviewColumn = true;
    }
    // Untag anything previously tagged — Review may have been renamed/removed.
    for (const stale of findTaggedCards()) {
      untagCard(stale);
    }
    reportCount(0);
    emitCardsChanged();
    return;
  }

  // Reset the warning latch so a board reshuffle that re-introduces Review
  // doesn't permanently silence the warning if it later disappears again.
  warnedNoReviewColumn = false;

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

function schedulePass(board: HTMLElement): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
  }
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    // Board element may have been replaced by Jira; resolve afresh.
    const live = findBoard() ?? board;
    runPass(live);
  }, DEBOUNCE_MS);
}

function attachBoardObserver(board: HTMLElement): void {
  if (boardObserver !== null) {
    boardObserver.disconnect();
  }
  boardObserver = new MutationObserver(() => schedulePass(board));
  boardObserver.observe(board, {
    childList: true,
    subtree: true,
    attributes: false,
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
}
