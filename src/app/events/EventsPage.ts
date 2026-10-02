// NECROFALL — EVENTS (#/events; user ask 2026-10-03): the live-ops board on the
// bottom nav's EVENTS tab. Real data only — the current ranked SEASON with its
// countdown, and the worlds that are actually in play right now: colonies holding
// planets (control timers) and ranked matches locking a world (reservations).
// Nothing is invented; when the front is quiet the page says so.
import { ClientCache } from '../spacetimedb/cache';
import { ShellContext } from '../ShellContext';
import { el } from '../ui/dom';
import { createPageHeader } from '../../ui/shell/PageHeader';
import { COLONIES } from '../../core/Config';
import { getRankFromStars, RANK_TIER_NAMES } from '../../rank/RankService';
import { planetNameFromKey } from '../profile/PlaceNames';
import { DEFAULT_UNIVERSE_SEED } from '../../rankmap/procedural/SeedHash';

/** One live clock on the board: a span + the server-time (µs) it counts down to. */
interface ClockRef {
  el: HTMLElement;
  atUs: number;
}

export class EventsPage {
  readonly element: HTMLElement;
  private seasonHost: HTMLElement;
  private listHost: HTMLElement;
  private listFoot: HTMLElement;
  private clocks: ClockRef[] = [];
  private sig = '';
  private timer = 0;

  constructor(private ctx: ShellContext) {
    this.element = el('div', 'nf-page events-page');
    this.element.appendChild(
      createPageHeader({
        title: 'EVENTS',
        subtitle: 'Live season and the worlds in play',
        onBack: () => this.ctx.goBack(),
      })
    );

    const col = el('div', 'menu-col events-col');
    this.seasonHost = el('section', 'ev-season');
    col.appendChild(this.seasonHost);

    const front = el('section', 'ev-front');
    const head = el('div', 'ev-front-head');
    head.appendChild(el('span', 'ev-live-dot', ''));
    head.appendChild(el('span', '', 'LIVE FRONTS'));
    front.appendChild(head);
    this.listHost = el('div', 'ev-list');
    front.appendChild(this.listHost);
    this.listFoot = el('div', 'ev-foot muted', '');
    front.appendChild(this.listFoot);
    col.appendChild(front);
    this.element.appendChild(col);

    // Countdowns run on the SERVER clock (one write per changed second).
    this.timer = window.setInterval(() => this.paintClocks(), 1000);
    this.render();
  }

  onHide(): void {
    if (!this.timer) return;
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  update(): void {
    this.render();
  }

  // ------------------------------------------------------------ data

  private render(): void {
    const cache = ClientCache.shared;
    const season = cache.rankedSeason();
    const seasonId = season?.seasonId ?? 0;
    const me = cache.me(this.ctx.myHex());
    const info = getRankFromStars(Number(me?.rankPoints ?? 0));

    // ---- live fronts: worlds a colony is HOLDING + worlds a ranked match has LOCKED
    const now = cache.serverNowUs();
    const reserved = cache.reservedPlanetKeys();
    const held = cache
      .rankedPlanetsAll()
      .filter((r) => r.controllingColony < 3 && Number(r.controlExpiresAt) > now)
      .sort((a, b) => Number(a.controlExpiresAt) - Number(b.controlExpiresAt));

    const sig =
      `${seasonId}|${season?.universeSeed ?? 0n}|${info.tier}|${info.stars}|` +
      `r:${[...reserved].sort().join(',')}|` +
      `h:${held.map((r) => `${r.planetKey}:${r.controllingColony}:${r.controlExpiresAt}`).join(';')}`;
    if (sig === this.sig) return;
    this.sig = sig;
    this.clocks = [];

    // ---- the season card
    const endsAtUs = season?.endsAt ? Number(season.endsAt) : 0;
    const band = RANK_TIER_NAMES[info.tier] ?? 'BRONZE';
    this.seasonHost.innerHTML = '';
    const num = el('div', 'ev-season-num');
    num.appendChild(el('span', 'ev-season-kicker', 'RANKED SEASON'));
    num.appendChild(el('b', 'ev-season-id', seasonId ? String(seasonId) : '—'));
    this.seasonHost.appendChild(num);
    const meta = el('div', 'ev-season-meta');
    const clock = el('div', 'ev-season-clock', '');
    if (endsAtUs > now) {
      this.seasonHost.appendChild(meta);
      meta.appendChild(el('span', `ev-band ev-band-${info.tier}`, `YOUR RING ${info.tier + 1} · ${band}`));
      clock.appendChild(el('span', 'ev-clock-kicker', 'ENDS IN'));
      const value = el('b', 'ev-clock-value', '—');
      clock.appendChild(value);
      this.seasonHost.appendChild(clock);
      this.clocks.push({ el: value, atUs: endsAtUs });
    } else {
      meta.appendChild(el('span', 'ev-band', `YOUR RING ${info.tier + 1} · ${band}`));
      meta.appendChild(el('span', 'ev-band', 'SEASON RUNNING'));
      this.seasonHost.appendChild(meta);
    }

    // ---- the list
    this.listHost.innerHTML = '';
    const seed = season ? Number(season.universeSeed % 4294967296n) >>> 0 : DEFAULT_UNIVERSE_SEED;
    let shown = 0;
    const CAP = 9;
    for (const key of reserved) {
      if (shown >= CAP) break;
      shown++;
      this.listHost.appendChild(this.row(seed, key, -1, 0));
    }
    for (const r of held) {
      if (shown >= CAP) break;
      shown++;
      this.listHost.appendChild(this.row(seed, r.planetKey, r.controllingColony, Number(r.controlExpiresAt)));
    }
    if (shown === 0) {
      this.listHost.appendChild(
        el('p', 'ev-empty muted', 'The front is quiet right now — no worlds are held and no ranked battles are locking a planet.')
      );
    }
    const more = reserved.size + held.length - shown;
    this.listFoot.textContent = more > 0 ? `+${more} MORE WORLD${more === 1 ? '' : 'S'} IN PLAY` : '';

    this.paintClocks();
  }

  /** One world row: colony ink, name, state, and its clock (held) or badge (locked). */
  private row(seed: number, planetKey: string, colony: number, expiresUs: number): HTMLElement {
    const row = el('div', 'ev-row');
    const dot = el('i', 'ev-dot');
    const col = colony >= 0 && colony < COLONIES.length ? COLONIES[colony] : null;
    dot.style.setProperty('--ev-ink', col?.css ?? '#ffd166');
    row.appendChild(dot);
    const name = el('span', 'ev-name', (planetNameFromKey(seed, planetKey) ?? planetKey).toUpperCase());
    row.appendChild(name);
    row.appendChild(el('span', 'ev-state', col ? `${col.name} HOLD` : 'BATTLE LIVE'));
    if (col) {
      const clock = el('b', 'ev-clock', '—');
      row.appendChild(clock);
      this.clocks.push({ el: clock, atUs: expiresUs });
    } else {
      row.appendChild(el('b', 'ev-clock is-live', 'IN MATCH'));
    }
    return row;
  }

  /** Re-write every clock from the SERVER clock (cheap; one pass per second). */
  private paintClocks(): void {
    const now = ClientCache.shared.serverNowUs();
    for (const c of this.clocks) {
      const left = Math.max(0, c.atUs - now);
      c.el.textContent = formatLeft(left);
    }
  }
}

/** µs → "2D 4H" · "3H 12M" · "14:32" · "38S" — compact, readable at a glance. */
function formatLeft(us: number): string {
  const s = Math.floor(us / 1_000_000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}D ${h}H`;
  if (h > 0) return `${h}H ${String(m).padStart(2, '0')}M`;
  if (m > 0) return `${m}:${String(sec).padStart(2, '0')}`;
  return `${sec}S`;
}
