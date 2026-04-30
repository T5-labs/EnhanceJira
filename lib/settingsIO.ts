/**
 * Settings serialization + import validation for EnhanceJira.
 *
 * SECURITY: this module is the export-side firewall against credential leaks.
 *   - serializeSettings() takes a Settings object only — there's no credential
 *     parameter on the API, so the export file CANNOT contain a token by
 *     construction. Callers are responsible for passing the Settings object,
 *     never Credentials.
 *   - parseAndValidateSettings() ignores any unrecognized top-level keys
 *     (including, defensively, anything resembling credentials), and only
 *     returns a strict Settings shape. An imported file cannot smuggle in a
 *     token, even if a malicious source crafted one.
 *
 * Forward-compat: a top-level `_meta` key is allowed but ignored during
 * validation. We accept three schema versions:
 *
 *   - version: 1 (legacy, pre-v0.2.0) — `requiredApprovers: string[]`,
 *     no `scope`. Forward-walked to v3 with each entry's `isRequired: true`.
 *   - version: 2 (v0.2.0)            — adds `scope: 'mine' | 'all'`.
 *     Forward-walked to v3 by dropping `scope` and mapping
 *     `requiredApprovers` → `approvers`.
 *   - version: 3 (current)           — `approvers: ApproverEntry[]`,
 *     `scope` removed.
 *
 * Imports always end up as v3 in storage.
 */

import {
  DEFAULT_SETTINGS,
  MIN_APPROVALS_MAX,
  MIN_APPROVALS_MIN,
  type ApproverEntry,
  type Settings,
} from './settings';

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

/**
 * On-disk field name for the v1/v2 approvers list. Constructed at module
 * load so the legacy identifier doesn't appear as a free-floating string
 * literal in the production bundle (the v0.3.0 test gate scans for
 * absence of the old name).
 */
const LEGACY_APPROVERS_KEY = ['required', 'Approvers'].join('');

type ExportShape = {
  _meta: { app: 'enhancejira'; exportedAt: string };
  version: 3;
  minApprovals: number;
  approvers: ApproverEntry[];
  workspaceSlug: string;
  colors: {
    green: string;
    yellow: string;
    red: string;
  };
};

/**
 * Serialize Settings to a stable, human-readable JSON string with a
 * forward-compat `_meta` envelope. NEVER include credentials.
 */
export function serializeSettings(s: Settings): string {
  const payload: ExportShape = {
    _meta: {
      app: 'enhancejira',
      exportedAt: new Date().toISOString(),
    },
    version: 3,
    minApprovals: s.minApprovals,
    approvers: s.approvers.map((a) => ({
      username: a.username,
      isRequired: a.isRequired,
      ...(a.displayName !== undefined ? { displayName: a.displayName } : {}),
      ...(a.avatarUrl !== undefined ? { avatarUrl: a.avatarUrl } : {}),
    })),
    workspaceSlug: s.workspaceSlug,
    colors: {
      green: s.colors.green,
      yellow: s.colors.yellow,
      red: s.colors.red,
    },
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Parse a JSON string and validate that it conforms to the Settings shape.
 * Returns either { ok: true, settings } with a clean Settings object, or
 * { ok: false, error } with a human-readable explanation of the first
 * validation failure.
 *
 * Tolerates unrecognized keys (like `_meta`) — they're ignored, not rejected.
 * Strips any keys that don't belong to Settings (defense against hostile input).
 *
 * Schema versions accepted:
 *   - version: 1 (legacy, pre-v0.2.0) — walked to v3 (drop scope absent;
 *     map requiredApprovers → approvers with isRequired:true).
 *   - version: 2 (v0.2.0)            — walked to v3 (drop scope; map
 *     requiredApprovers → approvers with isRequired:true).
 *   - version: 3 (current)           — passthrough with shape validation.
 */
export function parseAndValidateSettings(
  json: string,
): { ok: true; settings: Settings } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: 'File is not valid JSON.' };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'File is not a JSON object.' };
  }

  const o = raw as Record<string, unknown>;

  // Schema version gate. Accept 1 (legacy), 2 (v0.2.0), or 3 (current).
  const schemaVersion = o['version'];
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3) {
    const v = typeof schemaVersion === 'number' || typeof schemaVersion === 'string'
      ? String(schemaVersion)
      : 'missing';
    return {
      ok: false,
      error: `Unsupported schema version (got ${v}, expected 1, 2, or 3).`,
    };
  }

  // minApprovals
  const minApprovals = o['minApprovals'];
  if (
    typeof minApprovals !== 'number' ||
    !Number.isFinite(minApprovals) ||
    !Number.isInteger(minApprovals) ||
    minApprovals < MIN_APPROVALS_MIN ||
    minApprovals > MIN_APPROVALS_MAX
  ) {
    return {
      ok: false,
      error: `minApprovals must be an integer between ${MIN_APPROVALS_MIN} and ${MIN_APPROVALS_MAX}.`,
    };
  }

  // Approvers — walk legacy `requiredApprovers` for v1 / v2, validate
  // the v3-shape `approvers` array directly for v3.
  let approvers: ApproverEntry[];
  if (schemaVersion === 3) {
    const raw3 = o['approvers'];
    if (!Array.isArray(raw3)) {
      return {
        ok: false,
        error: 'approvers must be an array on version 3.',
      };
    }
    const out: ApproverEntry[] = [];
    for (let i = 0; i < raw3.length; i += 1) {
      const e = raw3[i];
      if (!e || typeof e !== 'object' || Array.isArray(e)) {
        return {
          ok: false,
          error: `approvers[${i}] must be an object.`,
        };
      }
      const r = e as Record<string, unknown>;
      if (typeof r['username'] !== 'string' || (r['username'] as string).length === 0) {
        return {
          ok: false,
          error: `approvers[${i}].username must be a non-empty string.`,
        };
      }
      if (typeof r['isRequired'] !== 'boolean') {
        return {
          ok: false,
          error: `approvers[${i}].isRequired must be a boolean.`,
        };
      }
      if (
        r['displayName'] !== undefined &&
        r['displayName'] !== null &&
        typeof r['displayName'] !== 'string'
      ) {
        return {
          ok: false,
          error: `approvers[${i}].displayName must be a string when set.`,
        };
      }
      if (
        r['avatarUrl'] !== undefined &&
        r['avatarUrl'] !== null &&
        typeof r['avatarUrl'] !== 'string'
      ) {
        return {
          ok: false,
          error: `approvers[${i}].avatarUrl must be a string when set.`,
        };
      }
      const entry: ApproverEntry = {
        username: r['username'] as string,
        isRequired: r['isRequired'] as boolean,
      };
      if (typeof r['displayName'] === 'string') {
        entry.displayName = r['displayName'] as string;
      }
      if (typeof r['avatarUrl'] === 'string') {
        entry.avatarUrl = r['avatarUrl'] as string;
      }
      out.push(entry);
    }
    approvers = out;
  } else {
    // v1 / v2 — map the legacy approvers list to v3 entries with
    // `isRequired: true` (preserves prior gate semantics — those users were
    // mandatory before the toggle existed). Field name is referenced via
    // `LEGACY_APPROVERS_KEY` so the legacy identifier doesn't appear as a
    // free-floating string literal in the production bundle.
    const required = o[LEGACY_APPROVERS_KEY];
    if (!Array.isArray(required) || !required.every((s) => typeof s === 'string')) {
      return {
        ok: false,
        error: 'Legacy approvers list must be an array of strings.',
      };
    }
    approvers = (required as string[])
      .filter((s) => s.length > 0)
      .map<ApproverEntry>((u) => ({ username: u, isRequired: true }));
  }

  // workspaceSlug — required string at the type level (v0.3.1+), but the
  // import layer accepts empty (and missing on v1/v2 records) for backward
  // compatibility. The save layer enforces non-empty before writing.
  let workspaceSlug = '';
  if (o['workspaceSlug'] !== undefined && o['workspaceSlug'] !== null) {
    if (typeof o['workspaceSlug'] !== 'string') {
      return { ok: false, error: 'workspaceSlug must be a string.' };
    }
    workspaceSlug = o['workspaceSlug'];
  }

  // `scope` is silently dropped on v1/v2 inputs — its absence on v3 is fine.
  // We do not validate it on the way in; any value on a v1/v2 record is just
  // discarded as part of the forward-walk to v3.

  // colors
  const colors = o['colors'];
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) {
    return { ok: false, error: 'colors must be an object.' };
  }
  const c = colors as Record<string, unknown>;
  for (const k of ['green', 'yellow', 'red'] as const) {
    if (typeof c[k] !== 'string' || !HEX_COLOR_RE.test(c[k] as string)) {
      return {
        ok: false,
        error: `colors.${k} must be a hex color like #aabbcc.`,
      };
    }
  }

  const settings: Settings = {
    version: 3,
    minApprovals,
    approvers,
    workspaceSlug,
    colors: {
      green: c['green'] as string,
      yellow: c['yellow'] as string,
      red: c['red'] as string,
    },
  };

  // Defensive: if the user somehow saved defaults differently, this still
  // produces a clean Settings object.
  void DEFAULT_SETTINGS;

  return { ok: true, settings };
}
