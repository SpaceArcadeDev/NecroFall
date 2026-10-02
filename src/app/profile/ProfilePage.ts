// NECROFALL — the profile page (reworked 2026-09-29, user ask: the old page was
// "too cluttered and sucks"; this is a modern, minimalist, touch-first layout).
//
//   band          the shared page title (same anchor as every other page)
//   body          a slim rail on the LEFT (landscape) — OVERVIEW · STATS ·
//                 HISTORY · DISCOVERIES — and the pane beside it. The old
//                 CONSTANT summary band is gone (user ask 2026-10-03): hero +
//                 rank plates ARE the OVERVIEW pane now, first in the rail, so
//                 the rail owns the full column height.
//
// Subscribes ONLY to the viewed profile while it is open (plan §23/§48) and
// records the visit through a single throttled reducer call. Own profile gains
// the edit sheet; another player's profile shows the follow action instead.
import { ClientCache } from '../spacetimedb/cache';
import { recordProfileView } from '../spacetimedb/reducers';
import { releaseProfile, subscribeProfile } from '../spacetimedb/subscriptions';
import { ShellContext } from '../ShellContext';
import { el } from '../ui/dom';
import { ProfileHero } from './ProfileHero';
import { ProfileRanks } from './ProfileRanks';
import { ProfileStats } from './ProfileStats';
import { ProfileHistory } from './ProfileHistory';
import { ProfileDiscoveries } from './ProfileDiscoveries';

type PaneKey = 'overview' | 'stats' | 'history' | 'discoveries';

interface Pane {
  element: HTMLElement;
  update(): void;
}

const TAB_ICONS: Record<PaneKey, string> = {
  overview:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.4" r="3.4"/><path d="M5.2 19.4c.8-3.5 3.5-5.3 6.8-5.3s6 1.8 6.8 5.3"/></svg>',
  stats:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M5 20v-7M12 20V5M19 20v-9"/></svg>',
  history:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.6V12l3 1.9"/></svg>',
  discoveries:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 14.1 9l5.9 2.3-5.9 2.4L12 19.8l-2.1-6.1L4 11.3 9.9 9z"/></svg>',
};

const TABS: Array<{ key: PaneKey; label: string }> = [
  { key: 'overview', label: 'OVERVIEW' },
  { key: 'stats', label: 'STATS' },
  { key: 'history', label: 'HISTORY' },
  { key: 'discoveries', label: 'DISCOVERIES' },
];

export class ProfilePage {
  readonly element: HTMLElement;
  private hero: ProfileHero;
  private ranks: ProfileRanks;
  private panes: Record<PaneKey, Pane>;
  private tabBtns: HTMLButtonElement[] = [];
  private active: PaneKey = 'overview';

  constructor(private ctx: ShellContext, private hex: string) {
    this.element = el('div', 'nf-page profile-page');

    // ---- the page band: the floating back chevron lives on CLEAN background above
    // the shared page title (overhaul §2/§44 — same anchor as PLAY/GRAPHICS).
    const top = el('header', 'nf-p-top');
    top.appendChild(el('h1', 'nf-page-title nf-p-title', 'PROFILE'));
    this.element.appendChild(top);

    // ---- tabbed body: the tab rail (left edge in landscape, top row in portrait).
    // The old CONSTANT hero+ranks band above it is gone (user ask 2026-10-03) —
    // that summary IS the OVERVIEW pane, the rail's first entry, so the rail
    // spans the page's full column height beside the panes.
    const body = el('div', 'nf-p-body');
    const nav = el('nav', 'nf-p-tabs');
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-label', 'Profile views');

    const overview = el('section', 'nf-p-pane nf-p-overview');
    const ohead = el('header', 'nf-p-pane-head');
    ohead.appendChild(el('h3', 'nf-p-pane-title', 'OVERVIEW'));
    overview.appendChild(ohead);
    this.hero = new ProfileHero(ctx, hex);
    this.ranks = new ProfileRanks(hex);
    const summary = el('div', 'nf-p-summary');
    summary.appendChild(this.hero.element);
    summary.appendChild(this.ranks.element);
    overview.appendChild(summary);

    const stats = new ProfileStats(ctx, hex);
    const history = new ProfileHistory(hex);
    const discoveries = new ProfileDiscoveries(hex, hex === ctx.myHex());
    this.panes = {
      overview: {
        element: overview,
        update: () => {
          this.hero.update();
          this.ranks.update();
        },
      },
      stats,
      history,
      discoveries,
    };

    const panesHost = el('div', 'nf-p-panes');
    TABS.forEach((tab) => {
      const btn = el('button', 'nf-p-tab') as HTMLButtonElement;
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.innerHTML = `<span class="nf-p-tab-ico">${TAB_ICONS[tab.key]}</span><span class="nf-p-tab-lbl">${tab.label}</span>`;
      btn.addEventListener('click', () => this.setTab(tab.key));
      this.tabBtns.push(btn);
      nav.appendChild(btn);
      panesHost.appendChild(this.panes[tab.key].element);
    });
    body.appendChild(nav);
    body.appendChild(panesHost);
    this.element.appendChild(body);

    this.attachSwipe(panesHost);
    this.setTab(this.active, false);
    this.onShow();
  }

  /** Called when the page becomes visible. */
  onShow(): void {
    subscribeProfile(this.hex);
    const cache = ClientCache.shared;
    if (this.hex !== this.ctx.myHex()) {
      const target = cache.playerByHex(this.hex)?.identity;
      if (target) recordProfileView(target);
    }
    this.update();
  }

  onHide(): void {
    releaseProfile(this.hex);
  }

  update(): void {
    this.panes[this.active].update();
  }

  private setTab(key: PaneKey, animate = true): void {
    this.active = key;
    const idx = TABS.findIndex((t) => t.key === key);
    this.tabBtns.forEach((btn, i) => {
      const on = i === idx;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    for (const tab of TABS) {
      const pane = this.panes[tab.key].element;
      const on = tab.key === key;
      pane.classList.toggle('on', on);
      pane.classList.toggle('hidden', !on);
    }
    if (animate) {
      // Re-run the entrance beat on every switch (remove → reflow → add).
      const pane = this.panes[key].element;
      pane.classList.remove('nf-pane-in');
      void pane.offsetWidth;
      pane.classList.add('nf-pane-in');
    }
    this.panes[key].update();
  }

  /**
   * Swipe the pane sideways to move between tabs (touch only). The panes are
   * `touch-action: pan-y`, so vertical drags stay native scrolling and only a
   * deliberate horizontal swipe reaches these handlers.
   */
  private attachSwipe(host: HTMLElement): void {
    let sx = 0;
    let sy = 0;
    let id = -1;
    let tracking = false;
    host.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      sx = e.clientX;
      sy = e.clientY;
      id = e.pointerId;
      tracking = true;
    });
    const settle = (e: PointerEvent): void => {
      if (!tracking || e.pointerId !== id) return;
      tracking = false;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const idx = TABS.findIndex((t) => t.key === this.active);
      const next = (idx + (dx < 0 ? 1 : -1) + TABS.length) % TABS.length;
      this.setTab(TABS[next].key);
    };
    host.addEventListener('pointerup', settle);
    host.addEventListener('pointercancel', () => {
      tracking = false;
    });
  }
}
