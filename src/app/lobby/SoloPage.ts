// NECROFALL — SOLO PICKER (user ask 2026-09-30): SPEEDRUN / SURVIVAL.
//
// One planet, one survivor. The player picks ANY planet from their rank band on
// the intergalactic map (the map itself is the picker — same canvas, same band
// highlight the RANK page uses), reads the planet's standing records and starts
// a single-player run on it: speedrun races the classic objectives, survival
// holds out against an endless swarm. Records live per planet + mode and are
// written to the server by the match flow.
//
// The page wears the RANK page's dress on purpose: same head/strip rhythm, same
// map + side-panel grid, same landscape rules (`rank-page` classes) — it is the
// same place in the UI hierarchy.
import { ClientCache } from '../spacetimedb/cache';
import { RECORD_MODE_SPEEDRUN, RECORD_MODE_SURVIVAL } from '../spacetimedb/rows';
import { releasePlanetRecords, subscribePlanetRecords } from '../spacetimedb/subscriptions';
import { ShellContext } from '../ShellContext';
import { el } from '../ui/dom';
import { COLONIES } from '../../core/Config';
import { GalacticMap, type MapData, type MapSelection } from '../../rankmap/GalacticMap';
import { DEFAULT_UNIVERSE_SEED } from '../../rankmap/procedural/SeedHash';
import { PlanetDescriptor } from '../../rankmap/procedural/GalaxyTypes';
import { getRankFromStars, RANK_TIER_NAMES } from '../../rank/RankService';
import { formatRunTime } from '../../utils/Utils';
import { createCenterIcon, createFullscreenExitIcon, createFullscreenIcon } from '../../rankmap/RankMapIcons';
import { createPageHeader } from '../../ui/shell/PageHeader';
import type { SoloMode } from '../../core/Game';

/** The modes THIS picker serves — the map-based runs. FREEROAM (user ask) has no picker: the PLAY
 *  menu starts it directly (the world is procedural and the class defaults to RIFT). */
type PickedSoloMode = Exclude<SoloMode, 'freeroam'>;

/** Mode facts the page paints (title, tagline, record labels). */
const MODES: Record<PickedSoloMode, { title: string; tag: string; line: string; recordLabel: string; accent: string }> = {
  speedrun: {
    title: 'SPEEDRUN',
    tag: 'SOLO · RACE',
    line: 'Control the beacons, break the Nexus and take it — as FAST as you can.',
    recordLabel: 'FASTEST RUN',
    accent: '#7ef0b0',
  },
  survival: {
    title: 'SURVIVAL',
    tag: 'SOLO · ENDLESS',
    line: 'No beacons, no Nexus — just the swarm, growing forever. How long can you last?',
    recordLabel: 'LONGEST RUN',
    accent: '#ffd166',
  },
};

export class SoloPage {
  readonly element: HTMLElement;
  private map: GalacticMap;
  private mapWrap: HTMLElement;
  private hoverTip: HTMLElement;
  private breadcrumb: HTMLElement;
  private panel: HTMLElement;
  private current: MapSelection = { level: 'galactic', galaxy: null, system: null, planet: null, selected: null };
  private subscribedKey = '';
  private panelSig = '';
  private unsubscribe: () => void = () => undefined;

  constructor(private ctx: ShellContext, readonly mode: PickedSoloMode) {
    const meta = MODES[mode];
    this.element = el('div', 'nf-page rank-page solo-page');
    this.element.classList.add(mode === 'speedrun' ? 'solo-speedrun' : 'solo-survival');
    this.element.style.setProperty('--solo-accent', meta.accent);

    // ---- head: the shared page header (§2/§15) — same anchor as PLAY/PROFILE —
    // with the rank-band chip in its right slot
    const me = ClientCache.shared.me(ctx.myHex());
    const stars = Number(me?.rankPoints ?? 0);
    const ring = getRankFromStars(stars).tier;
    const bandName = RANK_TIER_NAMES[ring] ?? 'BRONZE';
    const bandChip = el('div', 'lobby-mode rk-season-chip', `RING ${ring + 1} · ${bandName.toUpperCase()}`);
    this.element.appendChild(
      createPageHeader({ title: meta.title, right: bandChip, onBack: () => ctx.goBack() })
    );

    // ---- strip: the mode switch + the one-line promise
    const strip = el('div', 'rk-strip solo-strip');
    const toggle = el('div', 'solo-toggle');
    for (const m of ['speedrun', 'survival'] as PickedSoloMode[]) {
      const b = el('button', `solo-toggle-btn${m === mode ? ' on' : ''}`, MODES[m].title) as HTMLButtonElement;
      b.type = 'button';
      b.dataset.action = 'solo';
      b.addEventListener('click', () => {
        if (m !== this.mode) {
          this.ctx.setLastMode(m);
          this.ctx.goSolo(m);
        }
      });
      toggle.appendChild(b);
    }
    strip.appendChild(toggle);
    strip.appendChild(el('div', 'solo-strip-note', meta.line));
    this.element.appendChild(strip);

    // ---- body: the map + the planet panel (same grid as RANK, no rail)
    const main = el('div', 'rk-main solo-main');
    this.mapWrap = el('div', 'rk-map-wrap solo-map-wrap');
    this.hoverTip = el('div', 'rk-hover-tip hidden');
    this.breadcrumb = el('div', 'rk-breadcrumb');
    const zoomCtl = el('div', 'rk-zoom');
    const mkZoom = (html: string, label: string, fn: () => void): HTMLButtonElement => {
      const b = el('button', 'rk-zoom-btn') as HTMLButtonElement;
      b.type = 'button';
      b.innerHTML = html;
      b.title = label;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', fn);
      return b;
    };
    zoomCtl.appendChild(mkZoom('+', 'Zoom in', () => this.map.zoomStep(1.5)));
    zoomCtl.appendChild(mkZoom('−', 'Zoom out', () => this.map.zoomStep(1 / 1.5)));
    zoomCtl.appendChild(
      mkZoom(createCenterIcon(), 'Back to your band', () => this.map.flyToRing(this.myRing()))
    );
    const expand = el('button', 'rk-map-expand') as HTMLButtonElement;
    expand.type = 'button';
    const setExpandIcon = (full: boolean): void => {
      expand.innerHTML = full ? createFullscreenExitIcon() : createFullscreenIcon();
      expand.title = full ? 'Exit fullscreen map' : 'Fullscreen map';
      expand.setAttribute('aria-label', expand.title);
    };
    setExpandIcon(false);
    expand.addEventListener('click', () => {
      const full = this.element.classList.toggle('map-full');
      setExpandIcon(full);
    });
    this.mapWrap.appendChild(this.breadcrumb);
    this.mapWrap.appendChild(zoomCtl);
    this.mapWrap.appendChild(this.hoverTip);
    this.mapWrap.appendChild(expand);
    this.mapWrap.appendChild(el('div', 'rk-maptitle', `${meta.title} — PICK A PLANET`));
    main.appendChild(this.mapWrap);

    const sideCol = el('div', 'rk-side');
    this.panel = el('div', 'rk-panel solo-panel');
    sideCol.appendChild(this.panel);
    main.appendChild(sideCol);
    this.element.appendChild(main);

    // ---- the map (same instance type as RANK; no ownership overlays here)
    const cache = ClientCache.shared;
    const data: MapData = {
      universeSeed: this.universeSeed(),
      myRing: ring,
      colonyNames: COLONIES.map((c) => c.name),
      colonyColors: COLONIES.map((c) => c.css),
      rowsForGalaxy: () => [],
      allRows: () => [],
      reservedKeys: () => new Set<string>(),
      serverNowUs: () => cache.serverNowUs(),
      discoveriesForGalaxy: () => [],
      discoveriesForSystem: () => [],
      discoveriesForPlanet: () => [],
      currentPlayerId: ctx.myHex(),
      currentPlayerName: me?.playerName ?? 'SURVIVOR',
      myColony: me && me.colony < 3 ? me.colony : 255,
    };
    this.map = new GalacticMap(
      this.mapWrap,
      data,
      (sel) => this.onSelection(sel),
      (hover) => this.showHover(hover)
    );
    this.unsubscribe = cache.onChange(() => this.renderPanel());
    // Open on the player's own band — that is where the runs live.
    requestAnimationFrame(() => this.map.flyToRing(ring));
    this.renderPanel();
    // Dev hook (same convention as `window.__nfMap`): probe the picker from the console.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__nfSolo = this;
    }
  }

  // ------------------------------------------------------------ lifecycle

  onHide(): void {
    this.unsubscribe();
    if (this.subscribedKey) {
      releasePlanetRecords(this.subscribedKey);
      this.subscribedKey = '';
    }
    this.map.dispose();
  }

  update(): void {
    this.renderPanel();
  }

  // ------------------------------------------------------------ data

  private universeSeed(): number {
    const season = ClientCache.shared.rankedSeason();
    if (season) return Number(season.universeSeed % 4294967296n) >>> 0;
    return DEFAULT_UNIVERSE_SEED;
  }

  private myRing(): number {
    const me = ClientCache.shared.me(this.ctx.myHex());
    return getRankFromStars(Number(me?.rankPoints ?? 0)).tier;
  }

  private onSelection(sel: MapSelection): void {
    this.current = sel;
    // Subscribe the selected planet's record board (one scope at a time).
    const key = sel.planet?.key ?? '';
    if (key !== this.subscribedKey) {
      if (this.subscribedKey) releasePlanetRecords(this.subscribedKey);
      this.subscribedKey = key;
      if (key) subscribePlanetRecords(key);
    }
    this.renderBreadcrumb();
    this.renderPanel();
  }

  private showHover(hover: { kind: string; label: string; sub?: string; x: number; y: number } | null): void {
    if (!hover) {
      this.hoverTip.classList.add('hidden');
      return;
    }
    this.hoverTip.classList.remove('hidden');
    this.hoverTip.style.left = `${hover.x}px`;
    this.hoverTip.style.top = `${hover.y}px`;
    this.hoverTip.innerHTML = `<b>${hover.label}</b>${hover.sub ? `<span>${hover.sub}</span>` : ''}`;
  }

  private renderBreadcrumb(): void {
    const sel = this.current;
    const parts: string[] = [];
    if (sel.level !== 'galactic' && sel.galaxy) parts.push(sel.galaxy.name.toUpperCase());
    if (sel.system && (sel.level === 'system' || sel.planet)) parts.push(sel.system.name.toUpperCase());
    if (sel.planet) parts.push(sel.planet.name.toUpperCase());
    const text = parts.join(' › ');
    this.breadcrumb.textContent = text;
    this.breadcrumb.classList.toggle('on', text.length > 0);
  }

  // ------------------------------------------------------------ panel

  private renderPanel(): void {
    const p = this.current.planet ?? this.current.selected?.planet ?? null;
    const sig = p ? `${this.mode}:${this.myRing()}:${p.key}:${this.recordsSig(p.key)}` : 'none';
    if (sig === this.panelSig) return;
    this.panelSig = sig;
    this.panel.innerHTML = '';
    if (!p) {
      this.panel.appendChild(el('div', 'solo-kicker', 'PICK A PLANET'));
      this.panel.appendChild(
        el('div', 'solo-hint', 'Tap a planet on the map — your rank band is highlighted. Every run plays the exact world you see here.')
      );
      // §32: the run action is GATED by the pick, never removed — the button
      // stays on the panel, disabled, with the reason in its hint.
      const armed = el('button', 'solo-start', `START ${MODES[this.mode].title}`) as HTMLButtonElement;
      armed.type = 'button';
      armed.disabled = true;
      armed.dataset.action = 'play';
      armed.title = 'Pick a planet on the map first';
      this.panel.appendChild(armed);
      this.panel.appendChild(el('div', 'solo-note', 'Tap a highlighted planet in your band to arm the run.'));
      return;
    }
    const mine = p.ring === this.myRing();
    this.panel.appendChild(el('div', 'solo-kicker', `RING ${p.ring + 1} · ${(RANK_TIER_NAMES[p.ring] ?? '').toUpperCase()}${mine ? ' · YOUR BAND' : ' · LOCKED'}`));
    this.panel.appendChild(el('div', 'solo-title', p.name.toUpperCase()));
    this.panel.appendChild(el('div', 'solo-line', `${p.biomeLabel} · ${p.ecologyLabel} · threat ${Math.round(p.difficulty * 100)}%`));

    // ---- records (server board, subscribed for this planet)
    const cache = ClientCache.shared;
    const rec = cache.planetRecord(p.key, this.mode === 'speedrun' ? RECORD_MODE_SPEEDRUN : RECORD_MODE_SURVIVAL);
    const other = cache.planetRecord(p.key, this.mode === 'speedrun' ? RECORD_MODE_SURVIVAL : RECORD_MODE_SPEEDRUN);
    const recBlock = el('div', 'solo-rec');
    const row = (label: string, name: string, time: string, hot: boolean): void => {
      const r = el('div', `solo-rec-row${hot ? ' hot' : ''}`);
      r.appendChild(el('span', 'solo-rec-label', label));
      r.appendChild(el('span', 'solo-rec-time', time));
      r.appendChild(el('span', 'solo-rec-name', name));
      recBlock.appendChild(r);
    };
    row(
      MODES[this.mode].recordLabel,
      rec ? `— ${rec.playerName}` : '— no record yet',
      rec ? formatRunTime(Number(rec.timeMs)) : '--:--',
      Boolean(rec)
    );
    row(
      this.mode === 'speedrun' ? 'LONGEST RUN' : 'FASTEST RUN',
      other ? `— ${other.playerName}` : '— none yet',
      other ? formatRunTime(Number(other.timeMs)) : '--:--',
      Boolean(other)
    );
    this.panel.appendChild(recBlock);

    // ---- first players (any mode — the shared discovery log)
    const plays = cache.planetPlays(p.key);
    const disc = el('div', 'solo-disc');
    disc.appendChild(el('div', 'solo-disc-title', plays.length > 0 ? `DISCOVERED BY · ${plays.length}` : 'UNDISCOVERED'));
    if (plays.length > 0) {
      disc.appendChild(
        el(
          'div',
          'solo-disc-list',
          plays
            .slice(0, 5)
            .map((r) => r.playerName.toUpperCase())
            .join(' · ')
        )
      );
    } else {
      disc.appendChild(el('div', 'solo-disc-list muted', 'Be the first survivor recorded here.'));
    }
    this.panel.appendChild(disc);

    // ---- the run button
    const start = el('button', 'solo-start', mine ? `START ${MODES[this.mode].title}` : 'OUTSIDE YOUR BAND') as HTMLButtonElement;
    start.type = 'button';
    start.disabled = !mine;
    start.dataset.action = 'play';
    start.addEventListener('click', () => this.ctx.startSoloRun(this.mode, p));
    this.panel.appendChild(start);
    this.panel.appendChild(
      el('div', 'solo-note', mine ? 'Single player · record goes to the planet board.' : 'Climb the ladder to unlock this ring.')
    );
  }

  /** Part of the panel signature: the row data of this planet's board. */
  private recordsSig(key: string): string {
    const cache = ClientCache.shared;
    const a = cache.planetRecord(key, RECORD_MODE_SPEEDRUN);
    const b = cache.planetRecord(key, RECORD_MODE_SURVIVAL);
    const plays = cache.planetPlays(key).length;
    return `${a ? `${a.playerName}:${a.timeMs}` : '-'}|${b ? `${b.playerName}:${b.timeMs}` : '-'}|${plays}`;
  }
}
