/**
 * Cross-context message protocol for EnhanceJira.
 *
 * The options page, content scripts, and the background service worker all
 * exchange messages through `browser.runtime.sendMessage`. To keep the wire
 * shape consistent and statically typed, all message types and their
 * responses live here.
 *
 * SECURITY: messages can carry credentials (TEST_CONNECTION). Never log a
 * full message object — strip / redact credential fields first. See lib/auth.ts
 * for the full set of credential-handling rules.
 */

import type { Credentials } from './settings';
import type { TestConnectionResult } from './auth';
import type { PRState } from './bitbucket';

export type Message =
  | { type: 'TEST_CONNECTION'; credentials: Credentials }
  | { type: 'GET_CONNECTION_STATUS' }
  | { type: 'PING' }
  | { type: 'GET_PR_STATE'; key: string; tenant: string }
  | { type: 'VALIDATE_USERNAME'; username: string }
  | { type: 'GET_WORKSPACE_MEMBERS'; workspaceSlug: string }
  // Popup ↔ content-script messages. Sent via browser.tabs.sendMessage(tabId, ...);
  // do NOT route through the worker.
  | { type: 'GET_BOARD_COUNTS' }
  | { type: 'FORCE_REFRESH' };

export type PingResponse = { ok: true; time: number };

/**
 * Counts of currently-tagged Review-column cards bucketed by their
 * `data-ej-state`. Sum of (green + yellow + red + noPr + error + unknown)
 * equals `total`.
 */
export type GetBoardCountsResponse = {
  green: number;
  yellow: number;
  red: number;
  noPr: number;
  error: number;
  unknown: number;
  total: number;
};

/** Ack for FORCE_REFRESH — `refreshed` is the count of cards re-fetched. */
export type ForceRefreshResponse = { ok: true; refreshed: number };

/**
 * A single workspace member surfaced by the autocomplete in the options-page
 * approvers picker. The shape is a denormalized projection of the Bitbucket
 * `/2.0/workspaces/{slug}/members` response — the worker maps it once and
 * caches the result so the options page can do client-side substring filtering
 * cheaply on every keystroke without hitting the API.
 */
export type WorkspaceMember = {
  username: string;
  displayName: string;
  avatarUrl?: string;
};

/**
 * Response for GET_WORKSPACE_MEMBERS.
 *
 * `ok: true` carries the (possibly cached) member list. `ok: false` covers
 * 401/403/network/transport and unhappy 5xx — UI should show an inline
 * "couldn't load members" hint and let the user fall back to the manual-add
 * path. Token never appears in `error`.
 */
export type GetWorkspaceMembersResponse =
  | { ok: true; members: WorkspaceMember[] }
  | { ok: false; error: string; status?: number };

/**
 * Response for VALIDATE_USERNAME.
 *
 * `valid: true` carries the canonical username from Bitbucket — callers should
 * replace user-typed casing with this value. `valid: false` means a 404
 * (Bitbucket said no — typo or removed user). `ok: false` covers transient
 * errors (network, auth, scope) — UI should offer retry.
 *
 * Token never appears in `error`.
 */
export type ValidateUsernameResponse =
  | { ok: true; valid: true; username: string; displayName: string; avatarUrl?: string }
  | { ok: true; valid: false }
  | { ok: false; error: string; status?: number };

/**
 * Response for GET_PR_STATE.
 *
 * `prs: []` is NOT an error — it's the expected outcome when no PR is linked
 * to the issue yet (or no Bitbucket workspace is configured for the fallback
 * scan). Callers should render "no PR" UI for that case.
 *
 * Errors here are auth/scope/network/transport — surfaced for UI to nudge the
 * user toward the options page. Token never appears in `error`.
 */
export type GetPRStateResponse =
  | { ok: true; prs: PRState[] }
  | { ok: false; error: string; status?: number };

/**
 * Maps each Message variant to its response shape.
 *
 * Usage:
 *   const r: Response<{ type: 'PING' }> = await browser.runtime.sendMessage({ type: 'PING' });
 */
export type Response<T extends Message> = T extends { type: 'TEST_CONNECTION' }
  ? TestConnectionResult
  : T extends { type: 'GET_CONNECTION_STATUS' }
    ? TestConnectionResult
    : T extends { type: 'PING' }
      ? PingResponse
      : T extends { type: 'GET_PR_STATE' }
        ? GetPRStateResponse
        : T extends { type: 'VALIDATE_USERNAME' }
          ? ValidateUsernameResponse
          : T extends { type: 'GET_WORKSPACE_MEMBERS' }
            ? GetWorkspaceMembersResponse
            : T extends { type: 'GET_BOARD_COUNTS' }
              ? GetBoardCountsResponse
              : T extends { type: 'FORCE_REFRESH' }
                ? ForceRefreshResponse
                : never;
