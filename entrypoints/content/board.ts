/**
 * Pure DOM helpers for locating the Jira software board, its Review columns,
 * and the cards inside them. No side effects beyond `tagCard` / `untagCard`,
 * which mutate `data-ej-*` attributes on a passed-in element.
 *
 * Selectors are centralized so future phases (e.g. P5 styling) can import
 * them from one place.
 */

export const SELECTORS = {
  board: '[data-testid="software-board.board"]',
  columnWrapper:
    '[data-testid="platform-board-kit.ui.column.draggable-column.styled-wrapper"]',
  columnName:
    '[data-testid="platform-board-kit.common.ui.column-header.editable-title.column-title.column-name"]',
  card: '[data-testid="platform-board-kit.ui.card.card"]',
  cardKey: '[data-testid="platform-card.common.ui.key.key"]',
} as const;

const REVIEW_NAME_RE = /^review$/i;

/** Find the board container, or null if it hasn't rendered yet. */
export function findBoard(): HTMLElement | null {
  return document.querySelector<HTMLElement>(SELECTORS.board);
}

/** All column wrappers descended from the given board. */
export function findColumns(board: HTMLElement): HTMLElement[] {
  return Array.from(
    board.querySelectorAll<HTMLElement>(SELECTORS.columnWrapper),
  );
}

/** Read the trimmed column name from a wrapper, or null if not found. */
export function readColumnName(column: HTMLElement): string | null {
  const el = column.querySelector<HTMLElement>(SELECTORS.columnName);
  const text = el?.textContent?.trim();
  return text ? text : null;
}

/** True if the wrapper's column name matches /^review$/i. */
export function isReviewColumn(column: HTMLElement): boolean {
  const name = readColumnName(column);
  return name !== null && REVIEW_NAME_RE.test(name);
}

/** All Review-named columns under the board. */
export function findReviewColumns(board: HTMLElement): HTMLElement[] {
  return findColumns(board).filter(isReviewColumn);
}

/** All cards descended from the given column wrapper. */
export function findCardsInColumn(column: HTMLElement): HTMLElement[] {
  return Array.from(column.querySelectorAll<HTMLElement>(SELECTORS.card));
}

/** Extract the issue key (e.g. "CMMS-1234") from a card, or null. */
export function extractKey(card: HTMLElement): string | null {
  const el = card.querySelector<HTMLElement>(SELECTORS.cardKey);
  const text = el?.textContent?.trim();
  return text ? text : null;
}

/** Mark a card as tracked: set ej-key + initial ej-state="unknown". */
export function tagCard(card: HTMLElement, key: string): void {
  card.dataset.ejKey = key;
  if (!card.dataset.ejState) {
    card.dataset.ejState = 'unknown';
  }
}

/** Remove ej-* tagging from a card. */
export function untagCard(card: HTMLElement): void {
  delete card.dataset.ejKey;
  delete card.dataset.ejState;
}

/** All currently-tagged cards anywhere in the document. */
export function findTaggedCards(root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-ej-key]'));
}
