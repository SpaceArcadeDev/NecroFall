// NECROFALL — the development-only UI integrity checker (overhaul §42).
//
// Every action button in the shell carries `data-action`. Each screen has a
// contract (see `data/MenuActionRegistry.ts`); after a screen renders, the
// audit asserts every contracted action is present in the DOM. This is the
// direct catcher for "the game-mode screen has no button X" — it fails loud
// in the console during development instead of shipping a missing button.
import { ACTIONS, SCREEN_CONTRACTS, type ContractScreen, type MenuAction } from '../data/MenuActionRegistry';

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

/**
 * §38 — BUTTON REGISTRY VALIDATION: every `[data-action]` control in the MENU
 * layer must reference a known action id. Unknown ids mean a button that can
 * never be wired correctly — caught in dev, before it reaches a phone.
 */
export function validateMenuActions(root: ParentNode = document): string[] {
  const unknown: string[] = [];
  const nodes = root.querySelectorAll<HTMLElement>('.nf-shell [data-action], .nf-sheet [data-action], .nf-friends-sheet [data-action]');
  for (const node of Array.from(nodes)) {
    const action = node.dataset.action ?? '';
    if (!(action in ACTIONS)) {
      unknown.push(action || '(empty)');
      // eslint-disable-next-line no-console
      console.error(`[NF UI] unknown action id "${action}" on`, node);
    }
  }
  return unknown;
}

/**
 * §39 — VIEWPORT VALIDATION: the document must never scroll sideways. Run
 * after every route change in dev; a hard error in the console is the signal.
 */
export function assertNoHorizontalOverflow(): void {
  if (typeof document === 'undefined') return;
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) {
    // eslint-disable-next-line no-console
    console.error(`[NF UI] horizontal overflow detected: ${doc.scrollWidth} > ${doc.clientWidth}`);
  }
}

/** The contract that matches a `documentElement.dataset.uiScreen` value. */
export function contractForUiScreen(screen: string | undefined): ContractScreen | null {
  switch (screen) {
    case 'main':
      return 'main';
    case 'play':
      return 'play';
    case 'solo':
      return 'solo';
    case 'custom':
      return 'custom';
    case 'rank':
      return 'rank';
    case 'profile':
      return 'profile';
    default:
      return null;
  }
}

/**
 * §39 — the DEV HUD snapshot: viewport, safe areas, document overflow, clipped
 * elements and any contracted action missing on the current screen.
 */
export interface HudSnapshot {
  w: number;
  h: number;
  orientation: 'landscape' | 'portrait';
  safeTop: number;
  safeBottom: number;
  overflowX: number;
  overflowY: number;
  clipped: number;
  missing: number;
  unknown: number;
}

export function hudSnapshot(): HudSnapshot {
  const doc = document.documentElement;
  const cs = getComputedStyle(doc);
  const safeTop = Number.parseFloat(cs.getPropertyValue('--nf-safe-top')) || 0;
  const safeBottom = Number.parseFloat(cs.getPropertyValue('--nf-safe-bottom')) || 0;

  // clipped: shell elements whose own box hides taller content (a card cut
  // off inside a fixed frame — the class of bug the overhaul exists to stop).
  // CANVAS panes are excluded: a map surface larger than its viewport is a
  // viewport, not clipped UI (§34 — the map renderer sizes itself).
  let clipped = 0;
  for (const node of Array.from(document.querySelectorAll<HTMLElement>('.nf-page *'))) {
    if (clipped >= 20) break;
    if (node.tagName === 'CANVAS' || node.querySelector('canvas')) continue;
    const rects = node.getClientRects();
    if (rects.length === 0) continue;
    const style = getComputedStyle(node);
    if (style.overflowY === 'hidden' && node.clientHeight > 8 && node.scrollHeight > node.clientHeight + 2) clipped += 1;
  }

  const contract = contractForUiScreen(doc.dataset.uiScreen);
  const missing = contract && document.querySelector('.nf-shell') ? checkScreen(document.body, SCREEN_CONTRACTS[contract]).length : 0;
  const unknown = validateMenuActionsQuiet();

  return {
    w: window.innerWidth,
    h: window.innerHeight,
    orientation: window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait',
    safeTop,
    safeBottom,
    overflowX: Math.max(0, doc.scrollWidth - doc.clientWidth),
    overflowY: Math.max(0, doc.scrollHeight - doc.clientHeight),
    clipped,
    missing,
    unknown,
  };
}

function validateMenuActionsQuiet(): number {
  let unknown = 0;
  const nodes = document.querySelectorAll<HTMLElement>('.nf-shell [data-action], .nf-sheet [data-action]');
  for (const node of Array.from(nodes)) {
    const action = node.dataset.action ?? '';
    if (!(action in ACTIONS)) unknown += 1;
  }
  return unknown;
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
    const expected = SCREEN_CONTRACTS[contract];
    if (!root || !expected) return undefined;
    return auditScreen(root, expected, contract);
  };
  assertNoForbiddenColors();
}
