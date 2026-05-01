/**
 * Popup card — minimal launcher for the extension.
 *
 * Renders a single horizontal row: title "EnhanceJira", version number
 * (read from `chrome.runtime.getManifest().version` at runtime), and a
 * settings (gear) icon on the far right that opens the options page.
 *
 * No counts, no state branching, no auto-fetch — disconnect lives on the
 * options page now. Vanilla TS DOM. No React. ~240px wide. System font.
 */

const version = browser.runtime.getManifest().version;
const iconUrl = browser.runtime.getURL('/icon/32.png');

document.body.innerHTML = `
  <div class="ej-popup">
    <header class="ej-popup-header">
      <div class="ej-brand">
        <img class="ej-brand-icon" src="${escapeHtml(iconUrl)}" alt="" />
        <span class="ej-title">EnhanceJira</span>
        <span class="ej-version">v${escapeHtml(version)}</span>
      </div>
      <span class="ej-divider" aria-hidden="true"></span>
      <button type="button" class="ej-icon-btn" id="ej-settings" aria-label="Open settings" title="Settings">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </button>
    </header>
  </div>
`;

injectStyles();
wireSettings();

function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    html, body {
      margin: 0;
      padding: 0;
      background: #282828;
      width: fit-content;
    }
    .ej-popup {
      width: fit-content;
      min-width: 170px;
      padding: 11px 13px;
      box-sizing: border-box;
      font: 13px system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #f4f5f7;
      background: #282828;
    }
    .ej-popup-header {
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }
    .ej-brand {
      display: inline-flex;
      align-items: center;
      gap: 7px;
    }
    .ej-brand-icon {
      display: block;
      width: 18px;
      height: 18px;
      flex-shrink: 0;
    }
    .ej-title {
      font-size: 16px;
      font-weight: 400;
      color: #f4f5f7;
      line-height: 1;
    }
    .ej-version {
      font-size: 0.8em;
      color: #9ca3af;
      line-height: 1;
    }
    .ej-divider {
      display: inline-block;
      width: 1px;
      height: 18px;
      background: rgba(255, 255, 255, 0.18);
    }
    .ej-icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      margin: 0;
      background: transparent;
      border: 0;
      border-radius: 4px;
      color: #c8cdd3;
      cursor: pointer;
      transition: background-color 120ms ease, color 120ms ease;
    }
    .ej-icon-btn:hover {
      background: rgba(255, 255, 255, 0.10);
      color: #ffffff;
    }
    .ej-icon-btn:focus-visible {
      outline: 2px solid #5e9eff;
      outline-offset: 1px;
    }
  `;
  document.head.appendChild(style);
}

function wireSettings(): void {
  const settingsBtn = document.getElementById('ej-settings');
  settingsBtn?.addEventListener('click', () => {
    void browser.runtime.openOptionsPage();
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
