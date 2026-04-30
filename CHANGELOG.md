# Changelog

All notable changes to EnhanceJira are recorded here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

(Anything in progress goes here.)

## [0.3.2] — 2026-04-29 — Fourth scope (`read:workspace:bitbucket`) + verbatim scope errors

### Added

- `read:workspace:bitbucket` scope added to the SetupGuide as the fourth required scope. Required by the workspace-members endpoint that powers the Required approvers autocomplete picker. Without it, the picker errors out (the rest of the extension still works on three scopes).
- Worker now surfaces Bitbucket's verbatim missing-scope name in 403 error messages — e.g. "Token missing scope: read:workspace:bitbucket" instead of the generic "Token missing required scopes." Helps future scope discoveries without round-tripping a token through chat.

### Notes

- Manifest version bumped to 0.3.2. No schema migration; no data shape changes. Pure docs + error-text improvement.

## [0.3.1] — 2026-04-29 — workspaceSlug now required

### Changed

- `Settings.workspaceSlug` is now a required field (was optional). The Required approvers search depends on it; making it required ensures the picker is always functional once the user is set up.
- Save flow validates workspaceSlug is non-empty; the input shows a red border + inline error if a user attempts to save with it blank.

### Notes

- Manifest version bumped to 0.3.1. No storage schema migration needed (still v3); existing records with missing workspaceSlug default-fill to empty string on load and the user must fill it in to save.

## [0.3.0] — 2026-04-29 — Refactor approvers UX, drop scope filter

### Removed

- `Settings.scope` field. The extension now always colors every card in the Review column regardless of PR author. Users wanting team-wide visibility no longer need to flip a setting; users who only want their own work should rely on Jira's native board-level filters (e.g. `?assignee=...`).

### Changed

- `Settings.requiredApprovers: string[]` replaced with `Settings.approvers: ApproverEntry[]`. Each entry has a per-user `isRequired` toggle, allowing users to track candidate approvers and toggle which are mandatory. Schema migrated v2 → v3 with v1/v2 records' `requiredApprovers` mapped to `approvers` with `isRequired: true`.
- The "Required approvers" component is now a searchable autocomplete + per-user table. Search hits Bitbucket workspace members (24h cache); clicking a result adds the user to the table; users toggle the Required switch per entry.

### Added

- `GET_WORKSPACE_MEMBERS` worker message, fetching paginated `/2.0/workspaces/{slug}/members` and caching results 24h in `chrome.storage.session`.

### Notes

- Manifest version bumped to 0.3.0.

## [0.2.0] — 2026-04-29 — Author-scope filter

### Added

- `Settings.scope` field with values `'mine'` (default) and `'all'`. When `'mine'`, the extension colors and tooltips only Review-column cards whose linked Bitbucket PR is authored by the connected Bitbucket user; when `'all'`, every Review-column card is processed (team-wide view).
- Bitbucket identity (`username`, `displayName`) is now captured to `chrome.storage.local` from successful `GET /2.0/user` responses, enabling the content script to apply the scope filter without per-card identity lookups.
- `PRState.authorUsername`, `authorDisplayName`, `authorAvatarUrl` populated from the existing PR detail response — no extra API calls.
- Tooltip header now includes the PR author's display name and username, useful for team-overview (`scope: 'all'`) mode.
- Settings schema migration v1 → v2: existing settings records have `scope` default-filled to `'mine'`.

### Changed

- Manifest version bumped to `0.2.0`. `package.json` version bumped to match.

## [0.1.0] — 2026-04-29 — First public preview

### Added

- WXT-based MV3 Chrome extension scaffold with TypeScript and React (P0).
- Content script identifies Review-column cards on Atlassian Cloud Jira boards (`https://*.atlassian.net/jira/software/*`) via DOM hooks (`platform-board-kit.ui.card.card`, `column-name`, etc.) and tags them with `data-ej-key` + `data-ej-state` attributes (P1).
- Settings page with persisted preferences in `chrome.storage.sync` (settings) and `chrome.storage.local` (credentials): Bitbucket username + API token, minimum approvals, required approvers list, card colors, optional workspace slug (P2).
- Bitbucket API token authentication via Basic auth header on `https://api.bitbucket.org` requests; "Test connection" workflow validates against `/2.0/user`. OAuth path documented as a future option but not implemented (P3).
- PR linkage and approval data: primary lookup via Jira's internal dev-status endpoint, fallback via Bitbucket workspace scan; PR detail fetched from Bitbucket Cloud REST API; per-key cache with 30s TTL, in-flight request coalescing, and 10-concurrent-request throttle (P4).
- Background coloring of Review cards: green = ready to merge, yellow = awaiting approvals, red = changes requested. Worst-status-wins aggregation when a ticket has multiple PRs. CSS variables on `:root` allow user-customizable color palette without per-card repaints (P5).
- Hover tooltip rendering full reviewer list, approval states, build status badge, and PR link. Single shared DOM node, 200ms hover delay, 100ms leave grace, ESC dismiss, viewport-clip flip, `prefers-reduced-motion` honored. Build status fetched in parallel with PR detail (P6).
- "Connect Bitbucket" banner in Review column header when credentials are absent (P7a).
- Live popup dashboard showing per-board green/yellow/red counts with manual refresh action (P7a).
- `EJ_DEBUG` flag (`localStorage.EJ_DEBUG = '1'`) for verbose logging (P7a).
- Required-approvers username validation: per-chip Bitbucket lookup with status icons, retry on error, and case canonicalization to API-stored form (P7b).
- Settings export/import as JSON (credentials and cache excluded by construction) (P7b).

### Security

- API tokens stored in `chrome.storage.local` only, never synced.
- Tokens transit only in the `Authorization` header — never in URL query strings, log lines, error messages, or serialized objects.
- Settings exports never include credentials.

### Notes

- Beta release. Ships as an unlisted Chrome Web Store entry first; broader publication after team-internal validation.

## Pre-0.1.0

- Project initialization, requirements gathering, and architecture work happened over the course of multiple planning sessions. The first published artifact is 0.1.0.

[Unreleased]: ...
[0.1.0]: ...
