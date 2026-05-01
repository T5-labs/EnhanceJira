import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApproverEntry } from '../../../lib/settings';
import type {
  GetWorkspaceMembersResponse,
  ValidateUsernameResponse,
  WorkspaceMember,
} from '../../../lib/messages';

/**
 * Searchable autocomplete + per-user table for the v0.3.0 approver picker.
 *
 * Top row:
 *   - Search input. Disabled when not connected, or connected without a
 *     workspace slug. Otherwise typing ≥ 2 characters fires
 *     `GET_WORKSPACE_MEMBERS` (worker caches 24h) and surfaces a dropdown of
 *     up to 10 substring-matched members. Search-by-workspace-member is the
 *     single path for adding approvers (v0.3.4+).
 *
 * Table:
 *   - One row per `ApproverEntry`. Avatar (with initials fallback), display
 *     name, @username with a small inline ✓/✗/⏳ validation badge, the
 *     Required toggle, and a remove button.
 *   - Validation runs on mount + on add via `VALIDATE_USERNAME`. Results are
 *     cached at module level (lowercase username key) so repeat mounts /
 *     edits don't refetch.
 *   - Canonicalization: when the worker returns a different casing for a
 *     username, the row's username (and the parent's `value` array) is
 *     swapped to the canonical form, deduping if necessary.
 *
 * Props:
 *   - `value` is the parent-owned approver list.
 *   - `onChange` produces a new array (immutability — the parent re-renders
 *     to drive the table).
 *   - `workspaceSlug` is the currently-saved slug from settings; if blank,
 *     the search input is disabled with an inline hint.
 *   - `isConnected` reflects the saved-credentials connection status; if
 *     false, the search input is disabled even with a slug present.
 */

type Props = {
  value: ApproverEntry[];
  onChange: (next: ApproverEntry[]) => void;
  workspaceSlug?: string;
  isConnected: boolean;
};

type ValidationBadge =
  | { state: 'pending' }
  | { state: 'valid'; displayName?: string; avatarUrl?: string }
  | { state: 'invalid' }
  | { state: 'error'; error?: string };

const validationCache = new Map<string, ValidateUsernameResponse>();
const memberFetchCache = new Map<string, GetWorkspaceMembersResponse>();

function lcKey(u: string): string {
  return u.toLowerCase();
}

export function RequiredApproversInput({
  value,
  onChange,
  workspaceSlug,
  isConnected,
}: Props) {
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [memberLoading, setMemberLoading] = useState(false);

  const [validations, setValidations] = useState<Map<string, ValidationBadge>>(
    () => new Map(),
  );

  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const validationStartedRef = useRef<Set<string>>(new Set());

  const searchEnabled = isConnected && !!workspaceSlug;
  const searchPlaceholder = !isConnected
    ? 'Connect Bitbucket to search workspace members'
    : !workspaceSlug
      ? 'Workspace slug not set — fill it in above to enable search.'
      : 'Search by username or display name...';

  // ── Workspace member fetch ─────────────────────────────────────────────
  // Keystroke-driven; the worker caches the result for 24h so this is cheap
  // even if the user mashes the keyboard.
  useEffect(() => {
    if (!searchEnabled) {
      setMembers([]);
      setMemberError(null);
      setMemberLoading(false);
      return;
    }
    if (query.trim().length < 2) {
      setMemberError(null);
      setMemberLoading(false);
      return;
    }

    let alive = true;
    const slug = workspaceSlug as string;

    const cached = memberFetchCache.get(slug);
    if (cached) {
      if (cached.ok) {
        setMembers(cached.members);
        setMemberError(null);
      } else {
        setMembers([]);
        setMemberError(cached.error);
      }
      setMemberLoading(false);
      return () => {
        alive = false;
      };
    }

    setMemberLoading(true);
    void (async () => {
      try {
        const r = (await browser.runtime.sendMessage({
          type: 'GET_WORKSPACE_MEMBERS',
          workspaceSlug: slug,
        })) as GetWorkspaceMembersResponse;
        if (!alive) return;
        memberFetchCache.set(slug, r);
        if (r.ok) {
          setMembers(r.members);
          setMemberError(null);
        } else {
          setMembers([]);
          setMemberError(r.error);
        }
      } catch {
        if (!alive) return;
        setMembers([]);
        setMemberError('Could not reach the background worker.');
      } finally {
        if (alive) setMemberLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [searchEnabled, workspaceSlug, query]);

  // ── Validation: re-fire on every value change for entries lacking results ──
  useEffect(() => {
    let alive = true;

    setValidations((prev) => {
      const next = new Map(prev);
      const live = new Set(value.map((a) => lcKey(a.username)));
      let mutated = false;
      for (const k of next.keys()) {
        if (!live.has(lcKey(k))) {
          next.delete(k);
          mutated = true;
        }
      }
      return mutated ? next : prev;
    });

    for (const entry of value) {
      const key = lcKey(entry.username);
      if (validationStartedRef.current.has(key)) continue;
      validationStartedRef.current.add(key);

      const cached = validationCache.get(key);
      if (cached) {
        applyValidation(entry.username, cached);
        continue;
      }

      setValidations((prev) => {
        const next = new Map(prev);
        next.set(entry.username, { state: 'pending' });
        return next;
      });

      void (async () => {
        try {
          const r = (await browser.runtime.sendMessage({
            type: 'VALIDATE_USERNAME',
            username: entry.username,
          })) as ValidateUsernameResponse;
          if (!alive) return;
          validationCache.set(key, r);
          applyValidation(entry.username, r);
        } catch {
          if (!alive) return;
          applyValidation(entry.username, {
            ok: false,
            error: 'Could not reach the background worker.',
            status: 0,
          });
        }
      })();
    }

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.map((a) => a.username).join('').toLowerCase()]);

  function applyValidation(typed: string, r: ValidateUsernameResponse) {
    setValidations((prev) => {
      const next = new Map(prev);
      let chipKey = typed;

      // Canonicalize: if the API returned a different casing, swap it into
      // the parent's array (and dedup if the canonical form already exists).
      if (
        r.ok &&
        r.valid === true &&
        r.username &&
        r.username !== typed
      ) {
        const cur = valueRef.current;
        const idx = cur.findIndex(
          (a) => a.username.toLowerCase() === typed.toLowerCase(),
        );
        if (idx >= 0) {
          const dup = cur.findIndex(
            (a, i) => i !== idx && a.username.toLowerCase() === r.username.toLowerCase(),
          );
          let updated: ApproverEntry[];
          if (dup >= 0) {
            updated = cur.filter((_, i) => i !== idx);
          } else {
            updated = cur.slice();
            updated[idx] = {
              ...updated[idx]!,
              username: r.username,
              displayName: r.displayName ?? updated[idx]!.displayName,
              avatarUrl: r.avatarUrl ?? updated[idx]!.avatarUrl,
            };
          }
          onChangeRef.current(updated);
          next.delete(typed);
          chipKey = r.username;
        }
      }

      if (r.ok && r.valid === true) {
        // Backfill displayName/avatarUrl on the parent entry if absent — this
        // keeps the table cells populated without an extra round trip when the
        // user added the row manually.
        const cur = valueRef.current;
        const idx = cur.findIndex(
          (a) => a.username.toLowerCase() === chipKey.toLowerCase(),
        );
        if (idx >= 0) {
          const existing = cur[idx]!;
          const wantDisplay = r.displayName && existing.displayName !== r.displayName;
          const wantAvatar = r.avatarUrl && existing.avatarUrl !== r.avatarUrl;
          if (wantDisplay || wantAvatar) {
            const merged: ApproverEntry = {
              ...existing,
              ...(r.displayName ? { displayName: r.displayName } : {}),
              ...(r.avatarUrl ? { avatarUrl: r.avatarUrl } : {}),
            };
            const updated = cur.slice();
            updated[idx] = merged;
            onChangeRef.current(updated);
          }
        }
        next.set(chipKey, {
          state: 'valid',
          displayName: r.displayName,
          avatarUrl: r.avatarUrl,
        });
      } else if (r.ok && r.valid === false) {
        next.set(chipKey, { state: 'invalid' });
      } else {
        next.set(chipKey, {
          state: 'error',
          error: 'error' in r ? r.error : 'Validation failed',
        });
      }
      return next;
    });
  }

  // ── Add / remove / toggle ──────────────────────────────────────────────

  function addEntry(entry: ApproverEntry) {
    const cur = valueRef.current;
    if (cur.some((a) => a.username.toLowerCase() === entry.username.toLowerCase())) {
      return; // dedup
    }
    onChange([...cur, entry]);
  }

  function addFromMember(m: WorkspaceMember) {
    addEntry({
      username: m.username,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      isRequired: false,
    });
    setQuery('');
    setSearchOpen(false);
  }

  function removeAt(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }

  function setRequiredAt(idx: number, isRequired: boolean) {
    const next = value.slice();
    next[idx] = { ...next[idx]!, isRequired };
    onChange(next);
  }

  // ── Filtered dropdown contents ─────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return members
      .filter((m) => {
        return (
          m.username.toLowerCase().includes(q) ||
          (m.displayName || '').toLowerCase().includes(q)
        );
      })
      .slice(0, 10);
  }, [members, query]);

  const showDropdown =
    searchEnabled &&
    searchOpen &&
    query.trim().length >= 2 &&
    (memberLoading || filtered.length > 0 || memberError !== null);

  return (
    <div>
      {/* ── Search row ──────────────────────────────────────────────── */}
      <div style={{ position: 'relative', display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // Re-open the dropdown on any keystroke. After picking a member,
            // `addFromMember` closes the dropdown but the input keeps focus
            // (via the row's onMouseDown preventDefault), so subsequent typing
            // would otherwise leave `searchOpen = false` and hide all results
            // until the user manually re-focused the input.
            setSearchOpen(true);
          }}
          onFocus={() => setSearchOpen(true)}
          onBlur={() => {
            // Defer so click on a dropdown row registers before we hide it.
            window.setTimeout(() => setSearchOpen(false), 120);
          }}
          placeholder={searchPlaceholder}
          disabled={!searchEnabled}
          style={{
            flex: 1,
            padding: '8px 10px',
            fontSize: 14,
            border: '1px solid #c1c7d0',
            borderRadius: 3,
            background: searchEnabled ? '#fff' : '#f4f5f7',
            color: searchEnabled ? '#172B4D' : '#7a869a',
            cursor: searchEnabled ? 'text' : 'not-allowed',
          }}
        />

        {showDropdown && (
          <div
            role="listbox"
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              maxHeight: 200,
              overflowY: 'auto',
              marginTop: 4,
              background: '#fff',
              border: '1px solid #c1c7d0',
              borderRadius: 3,
              boxShadow: '0 4px 12px rgba(9,30,66,0.12)',
              zIndex: 20,
            }}
          >
            {memberLoading && (
              <div style={{ padding: 8, fontSize: 13, color: '#5e6c84' }}>
                Loading members...
              </div>
            )}
            {memberError && (
              <div style={{ padding: 8, fontSize: 13, color: '#bf2600' }}>
                {memberError}
              </div>
            )}
            {!memberLoading && !memberError && filtered.length === 0 && (
              <div style={{ padding: 8, fontSize: 13, color: '#5e6c84' }}>
                No matches.
              </div>
            )}
            {filtered.map((m) => {
              const alreadyAdded = value.some(
                (a) => a.username.toLowerCase() === m.username.toLowerCase(),
              );
              return (
                <button
                  key={m.username}
                  type="button"
                  role="option"
                  aria-selected={false}
                  disabled={alreadyAdded}
                  onMouseDown={(e) => {
                    // Prevent the input's blur from firing before the click.
                    e.preventDefault();
                  }}
                  onClick={() => {
                    if (!alreadyAdded) addFromMember(m);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '6px 8px',
                    border: 'none',
                    background: 'transparent',
                    textAlign: 'left',
                    cursor: alreadyAdded ? 'not-allowed' : 'pointer',
                    opacity: alreadyAdded ? 0.6 : 1,
                  }}
                >
                  <Avatar
                    name={m.displayName || m.username}
                    avatarUrl={m.avatarUrl}
                    size={20}
                  />
                  <span style={{ fontSize: 13, color: '#172B4D' }}>
                    {m.displayName || m.username}
                  </span>
                  <span style={{ fontSize: 12, color: '#5e6c84' }}>
                    @{m.username}
                  </span>
                  {alreadyAdded && (
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: '#5e6c84' }}>
                      added
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Table ───────────────────────────────────────────────────── */}
      <div style={{ marginTop: 12 }}>
        {value.length === 0 ? (
          <div
            style={{
              padding: '12px 8px',
              fontSize: 13,
              color: '#5e6c84',
              fontStyle: 'italic',
            }}
          >
            No approvers added yet. Search above to find workspace members.
          </div>
        ) : (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 13,
              color: '#172B4D',
            }}
          >
            <thead>
              <tr style={{ borderBottom: '1px solid #dfe1e6', textAlign: 'left' }}>
                <th style={{ padding: '6px 4px', width: 32 }} aria-label="Avatar" />
                <th style={{ padding: '6px 4px' }}>Name</th>
                <th style={{ padding: '6px 4px', width: 100, textAlign: 'center' }}>
                  Required
                </th>
                <th style={{ padding: '6px 4px', width: 32 }} aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {value.map((entry, i) => {
                const v = validations.get(entry.username) ?? { state: 'pending' as const };
                const display =
                  entry.displayName ||
                  (v.state === 'valid' && v.displayName) ||
                  entry.username;
                const avatar =
                  entry.avatarUrl ||
                  (v.state === 'valid' ? v.avatarUrl : undefined);
                return (
                  <tr
                    key={`${entry.username}-${i}`}
                    style={{ borderBottom: '1px solid #f4f5f7' }}
                  >
                    <td style={{ padding: '6px 4px' }}>
                      <Avatar name={display} avatarUrl={avatar} size={24} />
                    </td>
                    <td style={{ padding: '6px 4px' }}>
                      <div style={{ fontWeight: 600 }}>{display}</div>
                      <div
                        style={{
                          fontSize: 11,
                          color: '#5e6c84',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        @{entry.username}
                        <ValidationBadgeIcon
                          badge={v}
                          excludedReason={
                            v.state === 'invalid'
                              ? 'Bitbucket says no — typo or removed user. Excluded from the green-gate check.'
                              : v.state === 'error' && 'error' in v && v.error
                                ? v.error
                                : null
                          }
                        />
                      </div>
                    </td>
                    <td style={{ padding: '6px 4px', textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={entry.isRequired}
                        onChange={(e) => setRequiredAt(i, e.target.checked)}
                        aria-label={`Toggle required for @${entry.username}`}
                        title={
                          v.state === 'invalid'
                            ? 'User not found on Bitbucket — toggle has no effect on the green-gate check.'
                            : undefined
                        }
                      />
                    </td>
                    <td style={{ padding: '6px 4px', textAlign: 'right' }}>
                      <button
                        type="button"
                        onClick={() => removeAt(i)}
                        aria-label={`Remove @${entry.username}`}
                        style={{
                          appearance: 'none',
                          border: 'none',
                          background: 'transparent',
                          color: '#5e6c84',
                          cursor: 'pointer',
                          fontSize: 16,
                          lineHeight: 1,
                          padding: 4,
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Tiny helpers ─────────────────────────────────────────────────────────

function ValidationBadgeIcon({
  badge,
  excludedReason,
}: {
  badge: ValidationBadge;
  excludedReason: string | null;
}) {
  const baseStyle: React.CSSProperties = {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 700,
    marginLeft: 2,
  };
  if (badge.state === 'pending') {
    return (
      <span title="Validating..." style={{ ...baseStyle, color: '#5e6c84' }}>
        ⏳
      </span>
    );
  }
  if (badge.state === 'valid') {
    return (
      <span title="Valid" style={{ ...baseStyle, color: '#006644' }}>
        ✓
      </span>
    );
  }
  if (badge.state === 'invalid') {
    return (
      <span
        title={excludedReason ?? 'Username not found on Bitbucket.'}
        style={{ ...baseStyle, color: '#bf2600' }}
      >
        ✗
      </span>
    );
  }
  return (
    <span
      title={excludedReason ?? 'Validation failed.'}
      style={{ ...baseStyle, color: '#974f0c' }}
    >
      ⚠
    </span>
  );
}

function Avatar({
  name,
  avatarUrl,
  size,
}: {
  name: string;
  avatarUrl?: string;
  size: number;
}) {
  const wrapStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: size,
    height: size,
    borderRadius: '50%',
    background: '#dfe1e6',
    color: '#172B4D',
    fontSize: Math.max(9, Math.floor(size * 0.42)),
    fontWeight: 700,
    overflow: 'hidden',
    flex: `0 0 ${size}px`,
  };
  if (avatarUrl) {
    return (
      <span style={wrapStyle}>
        <img
          src={avatarUrl}
          alt=""
          width={size}
          height={size}
          style={{ width: size, height: size, objectFit: 'cover' }}
        />
      </span>
    );
  }
  const initials =
    (name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() ?? '')
      .join('') || '?';
  return <span style={wrapStyle}>{initials}</span>;
}
