/**
 * Popup dashboard — small live view over the active Jira tab.
 *
 * Three states:
 *   1. Not on a Jira board tab   → "Open a Jira board to see status"
 *   2. On a Jira board, no token → "Not connected"
 *   3. On a Jira board, connected → green / yellow / red counts + Refresh
 *
 * The counts are sourced directly from the content script's tagged-card
 * DOM via `tabs.sendMessage(GET_BOARD_COUNTS)`. The popup itself is
 * stateless — it queries on open, queries again after every Refresh, and
 * unloads when closed. No background polling, no cached state.
 *
 * Vanilla TS DOM. No React. ~280px wide. System font.
 */

import { clearCredentials, loadCredentials } from '../../lib/settings';
import type {
  GetBoardCountsResponse,
  ForceRefreshResponse,
} from '../../lib/messages';

const JIRA_BOARD_URL_RE = /^https:\/\/[^/]+\.atlassian\.net\/jira\/software\//;

type Tab = { id?: number; url?: string };

document.body.innerHTML = `
  <div class="ej-popup">
    <header class="ej-popup-header">
      <strong>EnhanceJira</strong>
    </header>
    <hr class="ej-popup-divider" />
    <section class="ej-popup-body" id="ej-popup-body">
      <div class="ej-popup-loading">Loading…</div>
    </section>
    <footer class="ej-popup-footer">
      <button type="button" class="ej-link" id="ej-settings">Settings</button>
      <span class="ej-sep">·</span>
      <button type="button" class="ej-link" id="ej-disconnect">Disconnect</button>
    </footer>
  </div>
`;

injectStyles();
wireFooter();
void render();

function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    html, body { margin: 0; padding: 0; }
    .ej-popup {
      width: 280px;
      padding: 12px;
      box-sizing: border-box;
      font: 13px system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #172b4d;
    }
    .ej-popup-header { font-size: 14px; font-weight: 600; }
    .ej-popup-divider { border: 0; border-top: 1px solid #dfe1e6; margin: 8px 0; }
    .ej-popup-body { min-height: 60px; }
    .ej-popup-loading { color: #5e6c84; font-size: 12px; }
    .ej-counts {
      display: flex;
      gap: 16px;
      align-items: center;
      font-size: 14px;
      margin-bottom: 12px;
    }
    .ej-count { display: inline-flex; align-items: center; gap: 4px; }
    .ej-dot {
      width: 10px; height: 10px; border-radius: 50%;
      display: inline-block;
    }
    .ej-dot-green  { background: #36b37e; }
    .ej-dot-yellow { background: #f5b500; }
    .ej-dot-red    { background: #de350b; }
    .ej-msg { color: #5e6c84; font-size: 12px; margin-bottom: 12px; }
    .ej-button {
      width: 100%;
      padding: 6px 10px;
      font: inherit;
      background: #f4f5f7;
      border: 1px solid #dfe1e6;
      border-radius: 3px;
      color: #172b4d;
      cursor: pointer;
    }
    .ej-button:hover:not([disabled]) { background: #ebecf0; }
    .ej-button[disabled] { opacity: 0.5; cursor: not-allowed; }
    .ej-popup-footer {
      margin-top: 12px;
      padding-top: 8px;
      border-top: 1px solid #dfe1e6;
      font-size: 12px;
      color: #5e6c84;
    }
    .ej-link {
      background: none;
      border: 0;
      padding: 0;
      margin: 0;
      font: inherit;
      color: #0052cc;
      cursor: pointer;
    }
    .ej-link:hover { text-decoration: underline; }
    .ej-sep { margin: 0 6px; color: #c1c7d0; }
  `;
  document.head.appendChild(style);
}

function wireFooter(): void {
  const settingsBtn = document.getElementById('ej-settings');
  const disconnectBtn = document.getElementById('ej-disconnect');
  settingsBtn?.addEventListener('click', () => {
    void browser.runtime.openOptionsPage();
  });
  disconnectBtn?.addEventListener('click', async () => {
    await clearCredentials();
    void browser.runtime.openOptionsPage();
  });
}

async function getActiveTab(): Promise<Tab | null> {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0] ?? null;
  } catch {
    return null;
  }
}

async function render(): Promise<void> {
  const body = document.getElementById('ej-popup-body');
  if (!body) return;

  const tab = await getActiveTab();
  const isJira = !!tab?.url && JIRA_BOARD_URL_RE.test(tab.url);

  if (!isJira) {
    body.innerHTML = `
      <div class="ej-msg">Open a Jira board to see status</div>
      <button type="button" class="ej-button" id="ej-refresh" disabled>Refresh now</button>
    `;
    return;
  }

  const creds = await loadCredentials();
  const connected = creds.username.length > 0 && creds.token.length > 0;

  if (!connected) {
    body.innerHTML = `
      <div class="ej-msg">Not connected</div>
      <button type="button" class="ej-button" id="ej-refresh" disabled>Refresh now</button>
    `;
    return;
  }

  // Connected and on a Jira board — fetch counts.
  const counts = await fetchCounts(tab!);
  renderCounts(body, counts, tab!);
}

async function fetchCounts(tab: Tab): Promise<GetBoardCountsResponse | null> {
  if (typeof tab.id !== 'number') return null;
  try {
    const r = (await browser.tabs.sendMessage(tab.id, {
      type: 'GET_BOARD_COUNTS',
    })) as GetBoardCountsResponse | undefined;
    return r ?? null;
  } catch {
    // Content script not loaded yet (board page just opened, or different
    // tenant). Surface as zero counts — the user sees "0 0 0" which honestly
    // reflects what the extension knows.
    return null;
  }
}

function renderCounts(
  body: HTMLElement,
  counts: GetBoardCountsResponse | null,
  tab: Tab,
): void {
  const c = counts ?? { green: 0, yellow: 0, red: 0, noPr: 0, error: 0, unknown: 0, total: 0 };
  body.innerHTML = `
    <div class="ej-counts">
      <span class="ej-count"><span class="ej-dot ej-dot-green"></span>${c.green}</span>
      <span class="ej-count"><span class="ej-dot ej-dot-yellow"></span>${c.yellow}</span>
      <span class="ej-count"><span class="ej-dot ej-dot-red"></span>${c.red}</span>
    </div>
    <button type="button" class="ej-button" id="ej-refresh">Refresh now</button>
  `;
  const btn = document.getElementById('ej-refresh') as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Refreshing…';
    try {
      if (typeof tab.id === 'number') {
        await browser.tabs.sendMessage(tab.id, {
          type: 'FORCE_REFRESH',
        }) as ForceRefreshResponse | undefined;
      }
    } catch {
      // ignore — we just re-render with whatever counts the content script reports
    }
    await render();
  });
}
