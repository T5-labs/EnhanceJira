/**
 * No-token banner for Review columns.
 *
 * When the user hasn't pasted an API token yet, the extension can't fetch any
 * PR state — every card silently stays at `data-ej-state="unknown"` and there
 * is no visual cue that the extension is even installed but starved. This
 * module surfaces that disconnected state at the column-header level: a
 * single small banner per Review column header with a one-click jump into
 * the options page.
 *
 * Lifecycle:
 *   - Read credentials at startup. If empty → install banners on every
 *     Review column header. If present → no-op.
 *   - Subscribe to storage changes via shared `onStorageChange`. Banners
 *     install / remove as credentials flip.
 *   - Subscribe to `onCardsChanged` (fires after every observer pass) so we
 *     re-attach to columns Jira has just rendered (board navigation,
 *     virtualization).
 *
 * Idempotency: a `WeakSet<HTMLElement>` of headers we've already banner'd
 * means re-running install over the same DOM never stacks a second banner.
 *
 * The banner OWNS the visible UI; the coloring orchestrator (separately)
 * owns gating message traffic. Two cheap subscribers to the same event is
 * fine — the alternative (one module with two responsibilities) muddies
 * both.
 */

import { loadCredentials, type Credentials } from '../../lib/settings';
import { onCardsChanged } from './observer';
import { onStorageChange } from './storageEvents';

const BANNER_CLASS = 'ej-banner';
const STYLE_ID = 'ej-banner-styles';
const COLUMN_HEADER_SELECTOR =
  '[data-testid="platform-board-kit.common.ui.column-header.header.column-header-container"]';
const COLUMN_NAME_SELECTOR =
  '[data-testid="platform-board-kit.common.ui.column-header.editable-title.column-title.column-name"]';

const BANNER_CSS = `
.${BANNER_CLASS} {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 4px 8px;
  margin-top: 4px;
  background: #fef3c7;
  border-bottom: 1px solid #f1d27a;
  border-radius: 3px;
  font: 12px system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #6b4f0a;
  box-sizing: border-box;
}
.${BANNER_CLASS} .ej-banner-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${BANNER_CLASS} .ej-banner-link {
  background: none;
  border: 0;
  padding: 0;
  margin: 0;
  font: inherit;
  color: #0052cc;
  cursor: pointer;
  white-space: nowrap;
}
.${BANNER_CLASS} .ej-banner-link:hover { text-decoration: underline; }
`;

const REVIEW_NAME_RE = /^review$/i;

let connected = false;
const banneredHeaders = new WeakSet<HTMLElement>();

/**
 * Public entrypoint. Idempotent. Wires the storage listener and the
 * tag-pass hook; the actual install/remove work happens reactively.
 */
export function startBanner(): void {
  installBannerStyles();

  void loadCredentials().then((c) => {
    connected = hasCredentials(c);
    syncBanners();
  });

  onStorageChange((event) => {
    if (event.type !== 'credentialsChanged') return;
    const next = hasCredentials(event.credentials);
    if (next === connected) return;
    connected = next;
    syncBanners();
  });

  // Re-attach after every observer pass — Jira virtualization may have just
  // rendered (or re-rendered) the column header DOM.
  onCardsChanged(() => {
    syncBanners();
  });
}

function hasCredentials(c: Credentials): boolean {
  return c.username.length > 0 && c.token.length > 0;
}

function installBannerStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = BANNER_CSS;
  document.head.appendChild(style);
}

function findReviewColumnHeaders(): HTMLElement[] {
  const headers = Array.from(
    document.querySelectorAll<HTMLElement>(COLUMN_HEADER_SELECTOR),
  );
  return headers.filter(isReviewHeader);
}

function isReviewHeader(header: HTMLElement): boolean {
  const nameEl = header.querySelector<HTMLElement>(COLUMN_NAME_SELECTOR);
  const text = nameEl?.textContent?.trim();
  return !!text && REVIEW_NAME_RE.test(text);
}

function syncBanners(): void {
  const headers = findReviewColumnHeaders();

  if (!connected) {
    for (const h of headers) {
      installBannerInto(h);
    }
    return;
  }

  // Connected: remove any banners we previously injected.
  removeAllBanners();
}

function installBannerInto(header: HTMLElement): void {
  if (banneredHeaders.has(header)) {
    // Make sure the DOM node is still there — virtualization could have
    // dropped it without notifying us.
    if (header.querySelector(`.${BANNER_CLASS}`)) return;
  }

  const banner = document.createElement('div');
  banner.className = BANNER_CLASS;

  const text = document.createElement('span');
  text.className = 'ej-banner-text';
  text.textContent = 'Connect Bitbucket — generate a token in 2 clicks';

  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'ej-banner-link';
  link.textContent = '→ Open Setup';
  link.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void browser.runtime.openOptionsPage();
  });

  banner.append(text, link);
  // Inject as the LAST child so column-name + meatball menu remain on top.
  header.appendChild(banner);
  banneredHeaders.add(header);
}

function removeAllBanners(): void {
  const banners = document.querySelectorAll<HTMLElement>(`.${BANNER_CLASS}`);
  for (const b of banners) {
    b.remove();
  }
  // Note: we can't iterate a WeakSet to clear it; unused entries are GC'd
  // automatically when their header DOM nodes are. Re-adding the banner via
  // installBannerInto checks for the actual `.${BANNER_CLASS}` node, so a
  // stale WeakSet entry is harmless.
}
