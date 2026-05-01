/**
 * Owns the single <style id="ej-styles"> tag we inject into the host page.
 *
 * Design:
 *   - One stylesheet, three CSS custom properties on :root, three rules that
 *     reference them. Settings changes mutate ONLY the :root declaration —
 *     the per-state rules never need to be rewritten.
 *   - Selector is intentionally specific: it targets the Atlassian card
 *     testid AND a non-empty data-ej-state we control. It cannot bleed into
 *     unrelated DOM, and it cannot fire on a card we haven't tagged.
 *   - `!important` is mandatory — Atlassian sets background-color inline on
 *     hover/selection/drag, and our rule must beat that.
 *   - Each rule paints the OUTER card wrapper AND two known descendant
 *     background-bearing elements (`platform-card.ui.card.focus-container`
 *     and `platform-board-kit.ui.card.ripple.div`). Targeting the outer
 *     wrapper alone leaves Atlassian's own descendant paint visible by
 *     default and only loses to our rule on hover (when state-specific
 *     selectors raise their specificity); painting the descendants too
 *     ensures the chosen color is visible in the default state.
 *   - Only green/red are styled. 'pending', 'no-pr', 'unknown', and 'error'
 *     get no background change so the card stays neutral — pending PRs
 *     intentionally fall back to Jira's default surface color (the absence of
 *     positive signal isn't itself a signal worth coloring); the tooltip (P6)
 *     is where users learn about errors. The yellow color value is still
 *     persisted in settings (and exposed in the options page as "Partial") to
 *     preserve user customizations across versions and to keep the door open
 *     for re-introducing a pending color override later if requested.
 */

const STYLE_ID = 'ej-styles';

const ROOT_RULE_MARKER = '/* ej-root */';

function buildRootBlock(colors: {
  green: string;
  yellow: string;
  red: string;
}): string {
  return `${ROOT_RULE_MARKER}
:root {
  --ej-green:  ${colors.green};
  --ej-yellow: ${colors.yellow};
  --ej-red:    ${colors.red};
}`;
}

const STATIC_RULES = `
[data-testid="platform-board-kit.ui.card.card"][data-ej-state="green"],
[data-testid="platform-board-kit.ui.card.card"][data-ej-state="green"] [data-testid="platform-card.ui.card.focus-container"],
[data-testid="platform-board-kit.ui.card.card"][data-ej-state="green"] [data-testid="platform-board-kit.ui.card.ripple.div"] {
  background-color: var(--ej-green) !important;
}
[data-testid="platform-board-kit.ui.card.card"][data-ej-state="red"],
[data-testid="platform-board-kit.ui.card.card"][data-ej-state="red"] [data-testid="platform-card.ui.card.focus-container"],
[data-testid="platform-board-kit.ui.card.card"][data-ej-state="red"] [data-testid="platform-board-kit.ui.card.ripple.div"] {
  background-color: var(--ej-red) !important;
}
`;

const DEFAULT_COLORS = {
  // Tailwind-800 defaults — kept in sync with lib/settings.ts DEFAULT_SETTINGS.
  green: '#166534',
  yellow: '#854d0e',
  red: '#991b1b',
};

/**
 * Idempotent: creates the style tag exactly once per document. Safe to call
 * before settings are loaded — the tag boots with the default palette and
 * `applyColorOverrides` rewrites it later when settings arrive.
 */
export function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = buildRootBlock(DEFAULT_COLORS) + '\n' + STATIC_RULES;
  document.head.appendChild(style);
}

/**
 * Re-write only the :root custom-property values — the per-state rules below
 * are static and never touched. The stylesheet stays exactly one :root block
 * + three rules, regardless of how many times this function is called.
 */
export function applyColorOverrides(colors: {
  green: string;
  yellow: string;
  red: string;
}): void {
  // Make sure the tag exists — defensive against call-order edge cases.
  installStyles();

  const style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) return;

  const current = style.textContent ?? '';
  const markerIdx = current.indexOf(ROOT_RULE_MARKER);

  if (markerIdx === -1) {
    // First run after install — just rebuild the whole thing.
    style.textContent = buildRootBlock(colors) + '\n' + STATIC_RULES;
    return;
  }

  // Everything after the :root block is static. Find the closing brace of the
  // :root rule and splice in a fresh root block in front of the rest.
  const closingBraceIdx = current.indexOf('}', markerIdx);
  if (closingBraceIdx === -1) {
    style.textContent = buildRootBlock(colors) + '\n' + STATIC_RULES;
    return;
  }
  const tail = current.slice(closingBraceIdx + 1);
  style.textContent = buildRootBlock(colors) + tail;
}
