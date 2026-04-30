# Privacy Policy

EnhanceJira is a browser extension that augments Jira board cards with Bitbucket pull-request approval data. This policy describes the data the extension reads, where it goes, and what we do (and do not do) with it.

## What the extension stores on your machine

EnhanceJira stores the following locally in your browser, using the browser's built-in extension storage APIs:

| What | Where | Purpose |
|------|-------|---------|
| Your Bitbucket username and API token | `chrome.storage.local` (this device only — never synced) | Authenticate Bitbucket API requests |
| Your settings (minimum approvals, required approvers list, card colors, optional workspace slug) | `chrome.storage.sync` (synced across your Chrome profile via Google) | Persist your preferences across devices |
| Cached pull-request data | `chrome.storage.session` (cleared when you close the browser) | Reduce repeat API calls; never persists across sessions |

The extension's **API token** is stored in `chrome.storage.local`, which is not synced and not transmitted anywhere except in the `Authorization` header on requests to `https://api.bitbucket.org`. The token is never logged, never written to URL query parameters, never included in error messages, and never shared with any third party.

## Data the extension reads

EnhanceJira reads two kinds of data while running:

1. **Jira board DOM** on `https://*.atlassian.net/jira/software/*` pages — to identify cards in the "Review" column and extract issue keys (e.g. `CMMS-1234`). The extension reads the page; it does not modify Jira's data or send it anywhere.
2. **Bitbucket pull-request data** via the Bitbucket REST API (`https://api.bitbucket.org`) — to retrieve pull-request reviewers, approval states, and build statuses associated with the issue keys it found. The API requests use your own API token.

## Data the extension does NOT collect

EnhanceJira does **not**:

- Send any data to a server operated by the extension's authors or any third party.
- Use analytics, telemetry, crash reporting, A/B testing, or any other observation tooling.
- Track your usage, browsing history, or activity outside of the Jira boards you visit.
- Share your token, settings, or pull-request data with anyone.

All network traffic the extension generates goes directly between your browser and (a) Atlassian's servers (`*.atlassian.net`, your existing Jira session), and (b) Bitbucket's API (`api.bitbucket.org`, with your own token). No other endpoints are contacted.

## Permissions

The extension requests the following Chrome permissions:

- **`storage`** — to persist your token, settings, and PR cache locally as described above.
- **Host permissions for `https://*.atlassian.net/*`** — to inject the content script that enhances Jira boards.
- **Host permissions for `https://api.bitbucket.org/*`** — to fetch pull-request data with your token.

The extension does **not** request `activeTab`, `tabs`, `<all_urls>`, `identity`, or any other broader permissions.

## Disconnecting and removing data

You can disconnect at any time:

- **Disconnect button** in the extension's options page (or popup) — removes your stored token immediately.
- **Reset settings** in the options page — restores defaults.
- **Uninstall** the extension via `chrome://extensions` — removes all stored data, including settings, token, and cache.

## Open source

EnhanceJira's source code is available for inspection and contribution at the project repository. You are welcome to verify the behaviors described above against the source.

## Contact

For questions about this privacy policy, please open an issue on the project repository.

---

_Last updated: 2026-04-29_
