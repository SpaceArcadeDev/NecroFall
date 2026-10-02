// NECROFALL — the development-only UI integrity checker (overhaul §42).
//
// Every action button in the shell carries `data-action`. Each screen has a
// contract (see `data/MenuActionRegistry.ts`); after a screen renders, the
// audit asserts every contracted action is present in the DOM. This is the
// direct catcher for "the game-mode screen has no button X" — it fails loud
// in the console during development instead of shipping a missing button.
import { SCREEN_CONTRACTS, type ContractScreen, type MenuAction } from '../data/MenuActionRegistry';

export interface AuditResult {
  screen: string;
  missing: MenuAction[];
  rendered: number;
}

export function auditScreen(root: HTMLElement, expected: readonly MenuAction[], label = 'screen'): AuditResult {
  const rendered = new Set<string>();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-action]'))) {
    const action = el.dataset.action;
    // VISIBLE only: a button that is `display:none` (a hidden chrome on a bare
    // screen, a `.hidden` layer) is not a rendered action.
    if (action && el.getClientRects().length > 0) rendered.add(action);
  }
  const missing = expected.filter((a) => !rendered.has(a));
  for (const action of missing) {
    // eslint-disable-next-line no-console
    console.error(`[NF UI] ${label}: missing action "${action}"`, root);
  }
  return { screen: label, missing, rendered: rendered.size };
}

/** Run the same audit as `auditScreen`, but without logging (for tests). */
export function checkScreen(root: HTMLElement, expected: readonly MenuAction[]): MenuAction[] {
  const rendered = new Set<string>();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-action]'))) {
    const action = el.dataset.action;
    if (action && el.getClientRects().length > 0) rendered.add(action);
  }
  return expected.filter((a) => !rendered.has(a));
}

/**
 * Audit a shell screen by its contract name. Cheap enough to run on every
 * navigation in dev — it reads the DOM, never mutates it.
 */
export function auditShellScreen(contract: ContractScreen, root: HTMLElement): AuditResult {
  return auditScreen(root, SCREEN_CONTRACTS[contract], contract);
}

declare global {
  interface Window {
    /** Dev handle: `__nfAudit('main')` audits the current screen on demand. */
    __nfAudit?: (contract: ContractScreen) => AuditResult | undefined;
  }
}

/**
 * §50 — the anti-regression guard: the MENU layer must never drift back into
 * the old violet identity. Scans only the menu-layer stylesheets (shell + the
 * `src/ui/styles/*` layer), so the game's own combat HUD is out of scope.
 */
const FORBIDDEN_VIOLET = ['#8b5cf6', '#a855f7', '#c084fc', '#9a6bff', '#b48cff', 'rgba(154, 107, 255', 'rgba(180, 120, 255', 'rgba(150, 90, 255', 'rgba(160, 90, 255'];

export function assertNoForbiddenColors(): void {
  if (typeof document === 'undefined') return;
  const hits: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    const href = sheet.href ?? '';
    if (!/styles\.shell\.css|ui\/styles\//.test(href)) continue;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      const text = (rule.cssText ?? '').toLowerCase();
      for (const bad of FORBIDDEN_VIOLET) {
        if (text.includes(bad)) hits.push(`${href.split('/').pop()} → ${bad}`);
      }
    }
  }
  if (hits.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[NF UI] forbidden violet values in the menu layer (§50):', hits.slice(0, 12));
  }
}

/** Install the console handle (dev only — called by the shell when import.meta.env.DEV). */
export function installAuditHandle(getShellRoot: () => HTMLElement | null): void {
  if (typeof window === 'undefined') return;
  window.__nfAudit = (contract: ContractScreen) => {
    const root = getShellRoot();
    if (!root) return undefined;
    return auditShellScreen(contract, root);
  };
  assertNoForbiddenColors();
}
