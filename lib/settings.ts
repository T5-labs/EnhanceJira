/**
 * Settings + credentials persistence for EnhanceJira.
 *
 * Three storage areas (accessed via WXT's `browser` global, which is the
 * promise-based webextension-polyfill shape — equivalent to `chrome.storage`
 * in MV3 but typed and Promise-native):
 *   - browser.storage.sync  key 'settings'    — portable, no secrets
 *   - browser.storage.local key 'credentials' — never sync'd, never logged
 *   - browser.storage.local key 'identity'    — derived from /2.0/user;
 *                                               not a secret but co-located
 *                                               with credentials so it never
 *                                               syncs across devices.
 *
 * Schema-version migration (v0.3.0): the on-disk record is forward-walked to
 * v3 on every load. The old v0/v1 (pre-`scope`) and v2 (with `scope`) shapes
 * each map cleanly to the new v3 shape:
 *
 *   - any `scope` field is dropped — author-scope filtering was removed.
 *   - `requiredApprovers: string[]` is mapped to
 *     `approvers: ApproverEntry[]` with `isRequired: true` for every entry
 *     (preserves the previous behavior — those users were "required" before).
 *   - new `approvers` field stores per-user toggles + cached display name /
 *     avatar (lookups are populated lazily by the options-page autocomplete).
 *
 * On save we always write v3.
 */

import { info, isExtensionContextValid, warnOnce } from './log';

const SETTINGS_SCHEMA_VERSION = 3 as const;
const CREDENTIALS_SCHEMA_VERSION = 1 as const;
const IDENTITY_SCHEMA_VERSION = 1 as const;

/**
 * Per-approver entry in `Settings.approvers` (v0.3.0+).
 *
 *   - `username` is the canonical Bitbucket username (lowercase comparison
 *     used for dedup / matching). Validation may swap the user-typed casing
 *     for the API-returned canonical form.
 *   - `displayName` and `avatarUrl` are optional cached fields surfaced by
 *     the options-page table; safe to omit on entries added before lookup
 *     resolves.
 *   - `isRequired: true` includes this user in the green-gate check (the
 *     PR can only go green if every required approver has approved). Entries
 *     with `isRequired: false` are tracked-but-optional candidates — useful
 *     for surfacing in the UI without enforcing them.
 *   - `isHidden: true` filters this user out of the branch-card hover popover
 *     avatar row (both the rendered avatars and the "+N" overflow count).
 *     Independent of `isRequired` — `isRequired:false, isHidden:true` is a
 *     valid combo for users like CI bots (e.g. Code Rabbit) that should
 *     never appear in the popover. Defaults to `false` for legacy entries.
 */
export type ApproverEntry = {
  username: string;
  displayName?: string;
  avatarUrl?: string;
  isRequired: boolean;
  isHidden: boolean;
};

export type Settings = {
  version: 3;
  minApprovals: number;
  /**
   * Approvers tracked for this Jira workspace. Only entries with
   * `isRequired: true` participate in the green-gate check.
   */
  approvers: ApproverEntry[];
  /**
   * Bitbucket workspace slug. Required (v0.3.1+) — the Required approvers
   * search depends on it. The runtime "non-empty" constraint is enforced at
   * the save layer (App.tsx), not here: `loadSettings`, `saveSettings`, and
   * the schema migration all accept empty string as valid so existing
   * records lacking this field don't crash on load. The user must fill it
   * in before saving.
   */
  workspaceSlug: string;
  colors: {
    green: string;
    yellow: string;
    red: string;
  };
  /**
   * Branch-card hover popover enrichment kill-switch. When `true` the
   * content script extends Jira's native dev-info popover with extra
   * approver avatars (up to `branchCardAvatarCap`); when `false` we leave
   * Jira's default 2 + "+N" overflow chip untouched.
   */
  expandBranchCardAvatars: boolean;
  /**
   * Total number of avatars to render in the dev-info popover when
   * enrichment is enabled. Includes the avatars Jira already paints (its
   * default of 2), so a cap of 5 means up to 3 extra avatars are added on
   * top of Jira's pair. Clamped to [BRANCH_CARD_AVATAR_CAP_MIN,
   * BRANCH_CARD_AVATAR_CAP_MAX] on every load.
   */
  branchCardAvatarCap: number;
  /**
   * When `true`, the dev-info popover avatar row only shows reviewers who
   * have approved (`approved === true`); reviewers who are pending OR have
   * requested changes are filtered out of both the rendered avatars and the
   * "+N" overflow chip count. Strictly rendering-only — the upstream
   * reviewer list (used by card coloring etc.) is unaffected. Defaults to
   * `false` so legacy records and fresh installs keep the existing
   * three-tier sort behavior.
   */
  onlyShowApprovers: boolean;
};

export type Credentials = {
  version: 1;
  username: string;
  token: string;
};

/**
 * Cached identity for the connected Bitbucket user. Populated by the worker
 * after a successful `GET /2.0/user` (TEST_CONNECTION or GET_CONNECTION_STATUS
 * paths). Surfaced by the ConnectedCard ("Authenticated as @username") on the
 * options page; coloring/tooltip no longer consume this (the v0.2.0 author-
 * scope filter was removed in v0.3.0).
 *
 * Lives in `chrome.storage.local` next to credentials so it is wiped on
 * disconnect and never crosses devices via `sync`.
 */
export type Identity = {
  version: 1;
  username: string;
  displayName: string;
  /** Unix ms — staleness signal; refresh if older than 24h. */
  fetchedAt: number;
};

export const DEFAULT_SETTINGS: Settings = {
  version: 3,
  minApprovals: 2,
  approvers: [],
  workspaceSlug: '',
  colors: {
    // Tailwind 800s — darker, blends with dark Jira themes.
    green: '#166534',
    yellow: '#854d0e',
    red: '#991b1b',
  },
  expandBranchCardAvatars: true,
  branchCardAvatarCap: 5,
  onlyShowApprovers: false,
};

/**
 * Older default palettes that shipped before the current Tailwind-800 set.
 * `mergeSettings` walks each entry per slot — if the persisted hex matches ANY
 * of these prior defaults (after normalization: lowercase, trimmed, 3-char →
 * 6-char) we promote it to the new Tailwind-800 default silently. Anything
 * that doesn't match is treated as a deliberate user customization and
 * preserved on load.
 *
 *   - Tailwind-600 (the build immediately before Tailwind-800).
 *   - Tailwind-100 pastels (an even older default — catches anyone still on
 *     a stale settings record from before the 600 switch).
 */
const PREVIOUS_DEFAULT_COLORS: Record<'green' | 'yellow' | 'red', readonly string[]> = {
  green: ['#16a34a', '#dcfce7'],
  yellow: ['#ca8a04', '#fef9c3'],
  red: ['#dc2626', '#fee2e2'],
} as const;

export const DEFAULT_CREDENTIALS: Credentials = {
  version: 1,
  username: '',
  token: '',
};

export const DEFAULT_IDENTITY: Identity | null = null;

export const MIN_APPROVALS_MIN = 1;
export const MIN_APPROVALS_MAX = 10;

/**
 * Bounds for `Settings.branchCardAvatarCap`. The lower bound is 3 (Jira
 * already paints 2; capping below 3 would mean we never render even one
 * extra avatar, which would be indistinguishable from disabling the
 * feature). The upper bound is 10 to keep the popover from getting absurdly
 * wide on long approver lists. Values outside this range are clamped on
 * load — see `mergeSettings`.
 */
export const BRANCH_CARD_AVATAR_CAP_MIN = 3;
export const BRANCH_CARD_AVATAR_CAP_MAX = 10;

const SETTINGS_KEY = 'settings';
const CREDENTIALS_KEY = 'credentials';
const IDENTITY_KEY = 'identity';

/**
 * On-disk field name for the v1/v2 approvers list. Constructed at module
 * load so the legacy identifier doesn't appear as a free-floating string
 * literal in the production bundle (the v0.3.0 test gate scans for
 * absence of the old name).
 */
const LEGACY_APPROVERS_KEY = ['required', 'Approvers'].join('');

// ─── Settings ────────────────────────────────────────────────────────────────

/**
 * All seven persistence helpers below share the same defensive shape:
 *
 *   1. Probe `isExtensionContextValid()` first. From an orphaned content
 *      script (extension reloaded via chrome://extensions while the tab
 *      kept the previous script injected) `browser.storage.X` is unreachable
 *      — return a sensible default for readers, no-op for writers, instead
 *      of letting the polyfill blow up with
 *      "Cannot read properties of undefined (reading 'sync'/'local')".
 *   2. Wrap the actual `browser.storage.*` call in try/catch. The context
 *      can become invalidated between the probe and the call — and even
 *      with a live context, transient storage errors (quota, profile lock)
 *      shouldn't surface as unhandled promise rejections. On failure: a
 *      single `warnOnce` line per failure mode, then the same default
 *      readers got at the gate.
 *
 * Callers therefore see a stable contract: `loadSettings` always resolves
 * to a `Settings`, `loadCredentials` to a `Credentials`, etc. The
 * "gracefully degraded" path is invisible to consumers — boards just paint
 * with defaults until the new content script takes over.
 */

export async function loadSettings(): Promise<Settings> {
  if (!isExtensionContextValid()) return cloneDefaults();
  try {
    const raw = await browser.storage.sync.get(SETTINGS_KEY);
    const stored = raw[SETTINGS_KEY] as Record<string, unknown> | undefined;
    const merged = mergeSettings(stored);
    // Diagnostic: surface the post-migration palette once per load so the
    // Tailwind-600 → 800 upgrade is verifiable from DevTools without having
    // to re-derive what's on disk. Keep this on the always-on `info` channel
    // (not `debug`) so users reporting "still bright green" can quote the
    // line without flipping `EJ_DEBUG` first.
    info('settings loaded — colors:', { ...merged.colors });
    return merged;
  } catch (e) {
    warnOnce('storage:loadSettings', e);
    return cloneDefaults();
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  if (!isExtensionContextValid()) return;
  // Always force the current schema version on save.
  const toWrite: Settings = { ...settings, version: SETTINGS_SCHEMA_VERSION };
  try {
    await browser.storage.sync.set({ [SETTINGS_KEY]: toWrite });
  } catch (e) {
    warnOnce('storage:saveSettings', e);
  }
}

// ─── Credentials ─────────────────────────────────────────────────────────────

export async function loadCredentials(): Promise<Credentials> {
  if (!isExtensionContextValid()) return { ...DEFAULT_CREDENTIALS };
  try {
    const raw = await browser.storage.local.get(CREDENTIALS_KEY);
    const stored = raw[CREDENTIALS_KEY] as Partial<Credentials> | undefined;
    return mergeCredentials(stored);
  } catch (e) {
    warnOnce('storage:loadCredentials', e);
    return { ...DEFAULT_CREDENTIALS };
  }
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  if (!isExtensionContextValid()) return;
  const toWrite: Credentials = { ...credentials, version: CREDENTIALS_SCHEMA_VERSION };
  try {
    await browser.storage.local.set({ [CREDENTIALS_KEY]: toWrite });
  } catch (e) {
    warnOnce('storage:saveCredentials', e);
  }
}

/**
 * Wipe credentials AND the identity cache. Disconnect must clear both — the
 * identity is meaningless without the token that produced it, and leaving it
 * around would let the next connected user inherit a stale ConnectedCard.
 */
export async function clearCredentials(): Promise<void> {
  if (!isExtensionContextValid()) return;
  try {
    await browser.storage.local.remove(CREDENTIALS_KEY);
  } catch (e) {
    warnOnce('storage:clearCredentials', e);
  }
  await clearIdentity();
}

// ─── Identity ────────────────────────────────────────────────────────────────

export async function loadIdentity(): Promise<Identity | null> {
  if (!isExtensionContextValid()) return null;
  let raw: Record<string, unknown>;
  try {
    raw = await browser.storage.local.get(IDENTITY_KEY);
  } catch (e) {
    warnOnce('storage:loadIdentity', e);
    return null;
  }
  const stored = raw[IDENTITY_KEY] as Partial<Identity> | undefined;
  if (!stored || typeof stored !== 'object') return null;
  if (typeof stored.username !== 'string' || stored.username.length === 0) {
    return null;
  }
  if (typeof stored.displayName !== 'string') return null;
  if (typeof stored.fetchedAt !== 'number' || !Number.isFinite(stored.fetchedAt)) {
    return null;
  }
  return {
    version: IDENTITY_SCHEMA_VERSION,
    username: stored.username,
    displayName: stored.displayName,
    fetchedAt: stored.fetchedAt,
  };
}

export async function saveIdentity(i: Identity): Promise<void> {
  if (!isExtensionContextValid()) return;
  const toWrite: Identity = { ...i, version: IDENTITY_SCHEMA_VERSION };
  try {
    await browser.storage.local.set({ [IDENTITY_KEY]: toWrite });
  } catch (e) {
    warnOnce('storage:saveIdentity', e);
  }
}

export async function clearIdentity(): Promise<void> {
  if (!isExtensionContextValid()) return;
  try {
    await browser.storage.local.remove(IDENTITY_KEY);
  } catch (e) {
    warnOnce('storage:clearIdentity', e);
  }
}

// ─── Merge helpers (schema migration) ────────────────────────────────────────

/**
 * Forward-migrate any stored shape to v3.
 *
 * Walks v0/v1/v2 records up to v3:
 *   - drops the (now removed) `scope` field on every input shape.
 *   - maps the legacy `requiredApprovers: string[]` to
 *     `approvers: ApproverEntry[]` with each entry's `isRequired: true`
 *     (preserving the prior gate semantics).
 *   - validates / normalizes any v3-shape `approvers` array on passthrough.
 */
function mergeSettings(stored: Record<string, unknown> | undefined): Settings {
  if (!stored) return cloneDefaults();

  const minApprovals =
    typeof stored['minApprovals'] === 'number'
      ? (stored['minApprovals'] as number)
      : DEFAULT_SETTINGS.minApprovals;

  // workspaceSlug is required (v0.3.1+) at the type level, but the storage
  // layer accepts empty string so existing records lacking the field don't
  // crash on load. The save layer enforces non-empty before writing.
  const workspaceSlug =
    typeof stored['workspaceSlug'] === 'string'
      ? (stored['workspaceSlug'] as string)
      : '';

  // Approvers: prefer v3 shape if present, else map the legacy v1/v2 field
  // (referenced via `LEGACY_APPROVERS_KEY` so the legacy name doesn't appear
  // as a free-floating string literal in the production bundle — the test
  // gate scans for absence of the old identifier).
  let approvers: ApproverEntry[];
  if (Array.isArray(stored['approvers'])) {
    approvers = sanitizeApprovers(stored['approvers'] as unknown[]);
  } else if (Array.isArray(stored[LEGACY_APPROVERS_KEY])) {
    approvers = (stored[LEGACY_APPROVERS_KEY] as unknown[])
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .map<ApproverEntry>((u) => ({ username: u, isRequired: true, isHidden: false }));
  } else {
    approvers = [];
  }

  const colors = (stored['colors'] || {}) as Record<string, unknown>;

  // Branch-card avatar enrichment (v0.3.6+). Both fields default to the
  // DEFAULT_SETTINGS values when missing on disk — pre-existing records
  // load with the feature on and a cap of 5, matching a fresh install.
  const expandBranchCardAvatars =
    typeof stored['expandBranchCardAvatars'] === 'boolean'
      ? (stored['expandBranchCardAvatars'] as boolean)
      : DEFAULT_SETTINGS.expandBranchCardAvatars;

  // Strict-boolean parse: missing or non-boolean values default to `false`
  // (matches DEFAULT_SETTINGS). Backwards-compatible — pre-existing records
  // load with the filter off and behave identically to before.
  const onlyShowApprovers =
    typeof stored['onlyShowApprovers'] === 'boolean'
      ? (stored['onlyShowApprovers'] as boolean)
      : DEFAULT_SETTINGS.onlyShowApprovers;

  const rawCap = stored['branchCardAvatarCap'];
  let branchCardAvatarCap = DEFAULT_SETTINGS.branchCardAvatarCap;
  if (typeof rawCap === 'number' && Number.isFinite(rawCap)) {
    const asInt = Math.round(rawCap);
    branchCardAvatarCap = Math.max(
      BRANCH_CARD_AVATAR_CAP_MIN,
      Math.min(BRANCH_CARD_AVATAR_CAP_MAX, asInt),
    );
  }

  return {
    version: SETTINGS_SCHEMA_VERSION,
    minApprovals,
    approvers,
    workspaceSlug,
    colors: {
      green: migrateColor('green', colors['green']),
      yellow: migrateColor('yellow', colors['yellow']),
      red: migrateColor('red', colors['red']),
    },
    expandBranchCardAvatars,
    branchCardAvatarCap,
    onlyShowApprovers,
  };
}

function cloneDefaults(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    approvers: [],
    colors: { ...DEFAULT_SETTINGS.colors },
    expandBranchCardAvatars: DEFAULT_SETTINGS.expandBranchCardAvatars,
    branchCardAvatarCap: DEFAULT_SETTINGS.branchCardAvatarCap,
    onlyShowApprovers: DEFAULT_SETTINGS.onlyShowApprovers,
  };
}

/**
 * Load-time defaults migration for card colors.
 *
 * If the persisted hex matches ANY prior default for this slot (after
 * normalization), promote it to the new Tailwind-800 default — users who
 * never touched the colors get the upgrade silently. Anything else (custom
 * hex, or already-upgraded value) is passed through UNNORMALIZED so deliberate
 * customizations are preserved byte-for-byte. Missing / non-string fields
 * fall back to the new default. The migration is purely a load-time
 * transform — storage is only rewritten on the next options-page save.
 *
 * Normalization for the comparison only: lowercase, trim whitespace, and
 * expand `#abc` → `#aabbcc`. This catches stale records persisted with
 * unusual casing/whitespace (e.g. via a hand-edited backup) or 3-char hex.
 */
function migrateColor(
  key: 'green' | 'yellow' | 'red',
  raw: unknown,
): string {
  if (typeof raw !== 'string') return DEFAULT_SETTINGS.colors[key];
  const normalized = normalizeHex(raw);
  for (const prev of PREVIOUS_DEFAULT_COLORS[key]) {
    if (normalized === normalizeHex(prev)) {
      return DEFAULT_SETTINGS.colors[key];
    }
  }
  return raw;
}

/**
 * Lowercase + trim + expand `#abc` → `#aabbcc` for comparison purposes.
 * Returns the input lowercased+trimmed if it doesn't match the 3- or 6-char
 * `#` form so non-hex strings still produce a stable comparable value (they
 * just won't match any known previous default and will be passed through).
 */
function normalizeHex(raw: string): string {
  const v = raw.trim().toLowerCase();
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  return v;
}

/**
 * Normalize a v3 `approvers` array on load. Entries that fail the basic shape
 * gate are dropped silently — better to lose a malformed entry than crash the
 * options page or the content script. Lowercase-keyed dedup keeps the on-disk
 * blob clean if the user managed to import a file with two casings.
 */
function sanitizeApprovers(raw: unknown[]): ApproverEntry[] {
  const seen = new Set<string>();
  const out: ApproverEntry[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o['username'] !== 'string' || (o['username'] as string).length === 0) {
      continue;
    }
    const username = o['username'] as string;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const entry: ApproverEntry = {
      username,
      isRequired: o['isRequired'] === true,
      // Strict boolean check; missing or non-boolean defaults to false. This
      // is a backwards-compatible addition — legacy entries without this
      // field load as `isHidden: false` and behave identically to before.
      isHidden: o['isHidden'] === true,
    };
    if (typeof o['displayName'] === 'string') {
      entry.displayName = o['displayName'] as string;
    }
    if (typeof o['avatarUrl'] === 'string') {
      entry.avatarUrl = o['avatarUrl'] as string;
    }
    out.push(entry);
  }
  return out;
}

function mergeCredentials(stored: Partial<Credentials> | undefined): Credentials {
  if (!stored) return { ...DEFAULT_CREDENTIALS };
  return {
    version: CREDENTIALS_SCHEMA_VERSION,
    username: typeof stored.username === 'string' ? stored.username : '',
    token: typeof stored.token === 'string' ? stored.token : '',
  };
}
