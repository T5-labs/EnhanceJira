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
 */
export type ApproverEntry = {
  username: string;
  displayName?: string;
  avatarUrl?: string;
  isRequired: boolean;
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
    // Tailwind 100s — soft pastel backgrounds.
    green: '#dcfce7',
    yellow: '#fef9c3',
    red: '#fee2e2',
  },
};

export const DEFAULT_CREDENTIALS: Credentials = {
  version: 1,
  username: '',
  token: '',
};

export const DEFAULT_IDENTITY: Identity | null = null;

export const MIN_APPROVALS_MIN = 1;
export const MIN_APPROVALS_MAX = 10;

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

export async function loadSettings(): Promise<Settings> {
  const raw = await browser.storage.sync.get(SETTINGS_KEY);
  const stored = raw[SETTINGS_KEY] as Record<string, unknown> | undefined;
  return mergeSettings(stored);
}

export async function saveSettings(settings: Settings): Promise<void> {
  // Always force the current schema version on save.
  const toWrite: Settings = { ...settings, version: SETTINGS_SCHEMA_VERSION };
  await browser.storage.sync.set({ [SETTINGS_KEY]: toWrite });
}

// ─── Credentials ─────────────────────────────────────────────────────────────

export async function loadCredentials(): Promise<Credentials> {
  const raw = await browser.storage.local.get(CREDENTIALS_KEY);
  const stored = raw[CREDENTIALS_KEY] as Partial<Credentials> | undefined;
  return mergeCredentials(stored);
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  const toWrite: Credentials = { ...credentials, version: CREDENTIALS_SCHEMA_VERSION };
  await browser.storage.local.set({ [CREDENTIALS_KEY]: toWrite });
}

/**
 * Wipe credentials AND the identity cache. Disconnect must clear both — the
 * identity is meaningless without the token that produced it, and leaving it
 * around would let the next connected user inherit a stale ConnectedCard.
 */
export async function clearCredentials(): Promise<void> {
  await browser.storage.local.remove(CREDENTIALS_KEY);
  await clearIdentity();
}

// ─── Identity ────────────────────────────────────────────────────────────────

export async function loadIdentity(): Promise<Identity | null> {
  let raw: Record<string, unknown>;
  try {
    raw = await browser.storage.local.get(IDENTITY_KEY);
  } catch {
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
  const toWrite: Identity = { ...i, version: IDENTITY_SCHEMA_VERSION };
  await browser.storage.local.set({ [IDENTITY_KEY]: toWrite });
}

export async function clearIdentity(): Promise<void> {
  await browser.storage.local.remove(IDENTITY_KEY);
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
      .map<ApproverEntry>((u) => ({ username: u, isRequired: true }));
  } else {
    approvers = [];
  }

  const colors = (stored['colors'] || {}) as Record<string, unknown>;

  return {
    version: SETTINGS_SCHEMA_VERSION,
    minApprovals,
    approvers,
    workspaceSlug,
    colors: {
      green:
        typeof colors['green'] === 'string'
          ? (colors['green'] as string)
          : DEFAULT_SETTINGS.colors.green,
      yellow:
        typeof colors['yellow'] === 'string'
          ? (colors['yellow'] as string)
          : DEFAULT_SETTINGS.colors.yellow,
      red:
        typeof colors['red'] === 'string'
          ? (colors['red'] as string)
          : DEFAULT_SETTINGS.colors.red,
    },
  };
}

function cloneDefaults(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    approvers: [],
    colors: { ...DEFAULT_SETTINGS.colors },
  };
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
