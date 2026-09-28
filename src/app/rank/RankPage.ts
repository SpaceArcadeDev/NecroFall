// NECROFALL — RANK PAGE (plan §47–§50/§74/§81). The full ranked loop lives
// here: your ladder standing on top, the INTERGALACTIC MAP in the middle
// (GalacticMap canvas), the ring rail down one side and the context panel
// (galaxy → system → planet details → FIND MATCH) along the other.
//
// The page is a pure VIEW over the server subscriptions: availability, control
// and countdowns all come from `ranked_planet` rows; everything else is
// regenerated from the season seed. The only writes it performs are
// `discoverPlanet` (first contact — plan §34) and `findRankedMatch` (§53).
import { ClientCache } from '../spacetimedb/cache';
import { hexOf } from '../spacetimedb/rows';
import { colonyStats, ColonyStatsResult, discoverPlanet, findRankedMatch } from '../spacetimedb/reducers';
import { subscribePlanetDetail, subscribeRank, subscribeRankGalaxy } from '../spacetimedb/subscriptions';
import { ShellContext } from '../ShellContext';
import { el } from '../ui/dom';
import { COLONIES } from '../../core/Config';
import { GalacticMap, MapData, MapSelection, PlanetRowData, RANKED_PLANET_CONTROLLED } from '../../rankmap/GalacticMap';
import { DEFAULT_UNIVERSE_SEED, decodeGalaxyId } from '../../rankmap/procedural/SeedHash';
import { nearestAvailablePlanet, ringHome } from '../../rankmap/procedural/UniverseGenerator';
import { planetAt } from '../../rankmap/procedural/PlanetGenerator';
import { systemAt } from '../../rankmap/procedural/SolarSystemGenerator';
import { systemPlanetCount as generatedPlanetCount } from '../../rankmap/procedural/SolarSystemGenerator';
import { galaxyAt } from '../../rankmap/procedural/GalaxyGenerator';
import { RING_CONFIGS, ringConfig } from '../../rankmap/procedural/RankRingConfig';
import { GalaxyDescriptor, PlanetDescriptor, SystemDescriptor } from '../../rankmap/procedural/GalaxyTypes';
import { getRankDisplayName, getRankFromStars, rankLabel, TIER_KOG, TIER_LIBERATOR } from '../../rank/RankService';

/** Live countdown ticks (display only — the server owns expiry). */
const HOUR_US = 3_600_000_000;

export class RankPage {
  readonly element: HTMLElement;
  private map: GalacticMap;
  private mapWrap: HTMLElement;
  private hoverTip: HTMLElement;
  private breadcrumb: HTMLElement;
  private side: HTMLElement;
  private railEl: HTMLElement;
  private headEl: HTMLElement;
  private discoverEl: HTMLElement;
  private statsEl: HTMLElement;
  private boardEl: HTMLElement | null = null;
  private selection: MapSelection = { level: 'galactic', galaxy: null, system: null, planet: null };
  private unsubscribe: () => void = () => undefined;
  private statsTimer = 0;
  private tickTimer = 0;
  private panelSig = '';
  private knownKeys = new Set<string>();
  private pendingDiscovery: PlanetDescriptor | null = null;
  private discoveryShown = new Set<string>();
  private stats: ColonyStatsResult | null = null;
  private subscribedGalaxies = new Set<number>();

  constructor(private ctx: ShellContext) {
    this.element = el('div', 'nf-page rank-page');

    // ---- header: ladder standing + season + boards
    this.headEl = el('div', 'rk-head');
    this.element.appendChild(this.headEl);

    // ---- body: map + ring rail + context panel
    const main = el('div', 'rk-main');
    this.mapWrap = el('div', 'rk-map-wrap');
    this.hoverTip = el('div', 'rk-hover-tip hidden');
    this.discoverEl = el('div', 'rk-discover hidden');
    this.breadcrumb = el('div', 'rk-breadcrumb');
    const zoomCtl = el('div', 'rk-zoom');
    const mkZoom = (label: string, fn: () => void): HTMLButtonElement => {
      const b = el('button', 'rk-zoom-btn', label) as HTMLButtonElement;
      b.type = 'button';
      b.addEventListener('click', fn);
      return b;
    };
    zoomCtl.appendChild(mkZoom('+', () => this.zoomBy(1.35)));
    zoomCtl.appendChild(mkZoom('−', () => this.zoomBy(1 / 1.35)));
    zoomCtl.appendChild(mkZoom('⌂', () => this.map.flyToRing(this.myRing())));
    this.mapWrap.appendChild(this.breadcrumb);
    this.mapWrap.appendChild(zoomCtl);
    this.mapWrap.appendChild(this.hoverTip);
    this.mapWrap.appendChild(this.discoverEl);
    main.appendChild(this.mapWrap);

    this.railEl = el('div', 'rk-rail');
    main.appendChild(this.railEl);

    const sideCol = el('div', 'rk-side');
    this.side = el('div', 'rk-panel');
    sideCol.appendChild(this.side);
    this.statsEl = el('div', 'rk-colonies');
    sideCol.appendChild(this.statsEl);
    main.appendChild(sideCol);

    this.element.appendChild(main);

    // ---- map instance (canvas goes into mapWrap before the overlays)
    const data: MapData = {
      universeSeed: this.universeSeed(),
      myRing: this.myRing(),
      colonyNames: COLONIES.map((c) => c.name),
      colonyColors: COLONIES.map((c) => c.css),
      rowsForGalaxy: (galaxyId) => this.rowsForGalaxy(galaxyId),
      reservedKeys: () => ClientCache.shared.reservedPlanetKeys(),
      serverNowUs: () => this.serverNowUs(),
    };
    this.map = new GalacticMap(
      this.mapWrap,
      data,
      (sel) => this.onSelection(sel),
      (hover) => this.showHover(hover)
    );

    // ---- subscriptions + render loops
    subscribeRank();
    subscribeRankGalaxy(this.myGalaxy().galaxyId || 0);
    this.unsubscribe = ClientCache.shared.onChange(() => this.onData());
    this.renderHead();
    this.renderRail();
    this.renderBreadcrumb();
    this.renderSide();
    void this.refreshStats();
    this.statsTimer = window.setInterval(() => {
      if (!this.element.isConnected) return;
      void this.refreshStats();
    }, 45_000);
    this.tickTimer = window.setInterval(() => {
      if (!this.element.isConnected) return;
      if (this.selection.planet) this.renderSide(true);
      this.renderBreadcrumb();
    }, 500);
  }

  // ------------------------------------------------------------ lifecycle

  onHide(): void {
    this.unsubscribe();
    if (this.statsTimer) window.clearInterval(this.statsTimer);
    if (this.tickTimer) window.clearInterval(this.tickTimer);
    this.map.dispose();
    this.boardEl?.remove();
  }

  update(): void {
    this.renderHead();
    this.renderRail();
    this.renderSide();
  }

  // ------------------------------------------------------------ data sources

  private universeSeed(): number {
    const season = ClientCache.shared.rankedSeason();
    if (season) return Number(season.universeSeed % 4294967296n) >>> 0;
    return DEFAULT_UNIVERSE_SEED;
  }

  private serverNowUs(): number {
    // Display-only approximation: the shield countdown is paced by the client
    // clock, the AUTHORITATIVE expiry is the server's control_expires_at.
    return Date.now() * 1000;
  }

  private me() {
    return ClientCache.shared.playerByHex(this.ctx.myHex());
  }

  private myStars(): number {
    return this.me()?.rankPoints ?? 0;
  }

  private myRing(): number {
    return getRankFromStars(this.myStars()).tier;
  }

  private myGalaxy(): GalaxyDescriptor {
    const home = ringHome(this.universeSeed(), this.myRing());
    return galaxyAt(this.universeSeed(), home.gx, home.gy) ?? {
      ring: this.myRing(), gx: home.gx, gy: home.gy, galaxyId: 0, seed: 0, name: 'FRONTIER',
      starType: 'YELLOW', starColor: '#ffe08a', systemCount: 6, nebula: 'NONE', nebulaColor: null,
      poi: 'NORMAL', poiLabel: 'OPEN CLUSTER', radius: 40,
    };
  }

  private rowsForGalaxy(galaxyId: number): PlanetRowData[] {
    return ClientCache.shared.rankedPlanetsForGalaxy(galaxyId).map((r) => ({
      planetKey: r.planetKey,
      ring: r.ring,
      galaxyId: r.galaxyId,
      systemId: r.systemId,
      planetId: r.planetId,
      state: r.state,
      colony: r.controllingColony,
      controlExpiresAt: Number(r.controlExpiresAt),
      discovered: r.discovered,
    }));
  }

  private planetRow(key: string) {
    return ClientCache.shared.rankedPlanet(key);
  }

  private planetAvailable(p: PlanetDescriptor): boolean {
    const row = this.planetRow(p.key);
    if (row && row.state === RANKED_PLANET_CONTROLLED) return false;
    if (ClientCache.shared.reservedPlanetKeys().has(p.key)) return false;
    return true;
  }

  private onData(): void {
    // Track discoveries we triggered (plan §74 — the reveal moment). ONLY a genuinely fresh
    // find celebrates: the first discoverer must be me AND the server must have stamped the
    // discovery moments ago (a reloaded page re-sends `discover_planet` for old worlds —
    // those must stay quiet).
    if (this.pendingDiscovery) {
      const key = this.pendingDiscovery.key;
      const discoveries = ClientCache.shared.planetDiscoveries(key);
      const mine = discoveries.find((d) => hexOf(d.identity) === this.ctx.myHex());
      const row = this.planetRow(key);
      const fresh = row ? Date.now() * 1000 - Number(row.firstDiscoveredAt) < 120_000_000 : false;
      if (mine && mine.discoveryOrder === 1 && fresh && !this.discoveryShown.has(key)) {
        this.discoveryShown.add(key);
        this.flashDiscovery(this.pendingDiscovery, mine.discoveryOrder);
        this.pendingDiscovery = null;
      } else if (row?.discovered || (mine && !fresh)) {
        // Already known (or an old find) — no celebration, just clear the pending state.
        this.pendingDiscovery = null;
      }
    }
    this.renderHead();
    this.renderRail();
    this.renderBreadcrumb();
    this.renderSide();
  }

  // ------------------------------------------------------------ header

  private renderHead(): void {
    const stars = this.myStars();
    const info = getRankFromStars(stars);
    const cfg = ringConfig(info.tier);
    const name = getRankDisplayName(stars);
    const nextName = info.toNext > 0 ? getRankDisplayName(stars + info.toNext) : '';
    const streak = this.streakLabel();
    this.headEl.style.setProperty('--rk-accent', cfg.accent);
    this.headEl.innerHTML =
      `<div class="rk-crest" data-tier="${info.tier}">` +
      `<svg viewBox="0 0 48 56" aria-hidden="true"><path class="rk-crest-shield" d="M24 2 44 10v18c0 12-8 20-20 26C12 48 4 40 4 28V10z"/><path class="rk-crest-inner" d="M24 8 38 14v14c0 8.5-5.5 14.5-14 19.4C15.5 42.5 10 36.5 10 28V14z"/></svg>` +
      `<span class="rk-crest-star">★</span></div>` +
      `<div class="rk-head-info">` +
      `<div class="rk-rank-name">${name}</div>` +
      `<div class="rk-stars-row">${this.starsHtml(info.stars, info.tier)}</div>` +
      `<div class="rk-progress"><div class="rk-progress-fill" style="width:${Math.round(info.progress * 100)}%"></div></div>` +
      `<div class="rk-next">${streak}</div>` +
      `</div>` +
      `<div class="rk-head-side">` +
      `<div class="rk-season">SEASON ${ClientCache.shared.rankedSeason()?.seasonId ?? 1}<span>RING ${info.tier} · ${RING_CONFIGS[info.tier].name}</span></div>` +
      `<div class="rk-head-btns">` +
      `<button class="rk-btn" data-act="board">LEADERBOARD</button>` +
      `<button class="rk-btn primary" data-act="myring">YOUR RING</button>` +
      `</div></div>`;
    this.headEl.querySelector('[data-act="myring"]')?.addEventListener('click', () => this.map.flyToRing(this.myRing()));
    this.headEl.querySelector('[data-act="board"]')?.addEventListener('click', () => this.toggleBoard());
  }

  private streakLabel(): string {
    const hex = this.ctx.myHex();
    const history = ClientCache.shared.myRankHistory(hex);
    if (!history.length) return 'Play ranked matches to earn stars — WIN +1 ★ · DRAW 0 · LOSS −1';
    const last = history[0];
    const icon = last.delta > 0 ? '▲' : last.delta < 0 ? '▼' : '■';
    const cls = last.delta > 0 ? 'up' : last.delta < 0 ? 'down' : 'flat';
    const next = getRankFromStars(this.myStars());
    const toNext = next.toNext > 0 ? ` · ${next.toNext} ★ TO ${getRankDisplayName(this.myStars() + next.toNext)}` : ' · LEADERBOARD TIER';
    return `<span class="rk-delta ${cls}">${icon} ${last.delta > 0 ? '+' : ''}${last.delta} LAST MATCH</span>${toNext}`;
  }

  private starsHtml(stars: number, tier: number): string {
    const cap = tier >= TIER_LIBERATOR ? 25 : tier === 0 ? 3 : tier === 1 ? 4 : 5;
    const lit = Math.min(cap - 1, stars);
    let out = '';
    const max = tier === TIER_KOG ? 8 : cap;
    for (let i = 0; i < max; i++) {
      out += `<span class="rk-star ${i < lit ? 'on' : ''}${i === lit ? ' next' : ''}" style="animation-delay:${i * 70}ms">★</span>`;
    }
    if (tier === TIER_KOG) out += `<span class="rk-star-count">${stars} ★</span>`;
    return out;
  }

  // ------------------------------------------------------------ rail

  private renderRail(): void {
    const myRing = this.myRing();
    const current = this.map.currentLevel === 'galactic' ? null : this.map.currentGalaxy?.ring ?? null;
    this.railEl.innerHTML = '';
    RING_CONFIGS.forEach((cfg) => {
      const chip = el('button', `rk-ring${cfg.tier === myRing ? ' mine' : ''}${current === cfg.tier ? ' here' : ''}`);
      (chip as HTMLButtonElement).type = 'button';
      chip.style.setProperty('--rk-accent', cfg.accent);
      chip.innerHTML = `<span class="rk-ring-name">${cfg.name}</span><span class="rk-ring-note">${cfg.tier === myRing ? 'YOUR RING' : cfg.abilityHint}</span>`;
      chip.addEventListener('click', () => this.map.flyToRing(cfg.tier));
      chip.title = cfg.tagline;
      this.railEl.appendChild(chip);
    });
  }

  // ------------------------------------------------------------ breadcrumb

  private renderBreadcrumb(): void {
    const parts: string[] = ['GALACTIC CORE'];
    const g = this.map.currentGalaxy;
    const sys = this.map.currentSystem;
    if (g) parts.push(g.name.toUpperCase());
    if (sys) parts.push(sys.name.toUpperCase());
    this.breadcrumb.innerHTML = '';
    parts.forEach((p, i) => {
      if (i > 0) this.breadcrumb.appendChild(el('span', 'rk-crumb-sep', '›'));
      const last = i === parts.length - 1;
      const b = el('button', `rk-crumb${last ? ' at' : ''}`, p) as HTMLButtonElement;
      b.type = 'button';
      if (!last) {
        b.addEventListener('click', () => {
          if (i === 0) {
            this.map.flyToRing(this.myRing());
          } else if (i === 1 && g && this.map.currentLevel === 'system') {
            this.map.back();
          }
        });
      }
      this.breadcrumb.appendChild(b);
    });
  }

  // ------------------------------------------------------------ selection

  private onSelection(sel: MapSelection): void {
    if (!this.map) return; // the map announces its initial fly-home during construction
    this.selection = sel;
    this.renderRail();
    this.renderBreadcrumb();
    this.renderSide();
    if (sel.planet) {
      // Contact = discovery (plan §34): only in YOUR ring, once per key.
      subscribePlanetDetail(sel.planet.key);
      // A planet can be selected before its galaxy is (deep links, programmatic jumps) —
      // its ownership rows must be subscribed or the panel would read UNDISCOVERED.
      if (!this.subscribedGalaxies.has(sel.planet.galaxyId)) {
        this.subscribedGalaxies.add(sel.planet.galaxyId);
        subscribeRankGalaxy(sel.planet.galaxyId);
      }
      if (sel.planet.ring === this.myRing() && !this.knownKeys.has(sel.planet.key)) {
        this.knownKeys.add(sel.planet.key);
        const row = this.planetRow(sel.planet.key);
        if (!row?.discovered) {
          this.pendingDiscovery = sel.planet;
          discoverPlanet(sel.planet.ring, sel.planet.galaxyId, sel.planet.systemId, sel.planet.planetId);
        }
      }
    }
    // Subscribe the galaxy rows the moment one is focused (plan §61).
    if (sel.galaxy && !this.subscribedGalaxies.has(sel.galaxy.galaxyId)) {
      this.subscribedGalaxies.add(sel.galaxy.galaxyId);
      subscribeRankGalaxy(sel.galaxy.galaxyId);
    }
  }

  private showHover(hover: { kind: string; label: string; sub: string; x: number; y: number } | null): void {
    if (!hover) {
      this.hoverTip.classList.add('hidden');
      return;
    }
    this.hoverTip.classList.remove('hidden');
    this.hoverTip.style.left = `${Math.min(this.mapWrap.clientWidth - 150, hover.x + 14)}px`;
    this.hoverTip.style.top = `${Math.max(8, hover.y - 12)}px`;
    this.hoverTip.innerHTML = `<div class="rk-tip-name">${hover.label}</div><div class="rk-tip-sub">${hover.sub}</div>`;
  }

  // ------------------------------------------------------------ side panel

  private renderSide(tickOnly = false): void {
    if (!tickOnly) {
      const sig = this.panelSignature();
      if (sig === this.panelSig) return;
      this.panelSig = sig;
      this.side.innerHTML = '';
      this.side.appendChild(this.buildPanel());
      return;
    }
    // tick-only pass: refresh the countdown text in place
    const cd = this.side.querySelector('[data-countdown]');
    if (cd && this.selection.planet) {
      const row = this.planetRow(this.selection.planet.key);
      if (row && row.state === RANKED_PLANET_CONTROLLED && Number(row.controlExpiresAt) > 0) {
        cd.textContent = this.countdownText(Number(row.controlExpiresAt));
      }
    }
  }

  private panelSignature(): string {
    const sel = this.selection;
    if (sel.planet) {
      const row = this.planetRow(sel.planet.key);
      const discoveries = ClientCache.shared.planetDiscoveries(sel.planet.key).length;
      const queue = ClientCache.shared.myQueue();
      return `p:${sel.planet.key}:${row?.state ?? -1}:${row?.controllingColony ?? -1}:${row?.discovered ? 1 : 0}:${discoveries}:${queue?.ranked ? queue.planetKey : ''}:${this.availableSig(sel.planet)}`;
    }
    if (sel.system) return `s:${sel.system.galaxyId}:${sel.system.systemId}:${this.rowsForGalaxy(sel.system.galaxyId).length}`;
    if (sel.galaxy) return `g:${sel.galaxy.galaxyId}:${this.rowsForGalaxy(sel.galaxy.galaxyId).length}`;
    return `root:${this.myStars()}`;
  }

  private availableSig(p: PlanetDescriptor): number {
    return this.planetAvailable(p) ? 1 : 0;
  }

  private buildPanel(): HTMLElement {
    const sel = this.selection;
    if (sel.planet) return this.buildPlanetPanel(sel.planet);
    if (sel.system) return this.buildSystemPanel(sel.system);
    if (sel.galaxy) return this.buildGalaxyPanel(sel.galaxy);
    return this.buildRootPanel();
  }

  private buildRootPanel(): HTMLElement {
    const box = el('div', 'rk-card');
    box.appendChild(el('div', 'rk-card-title', 'INTERGALACTIC MAP'));
    box.appendChild(
      el('p', 'rk-card-note', 'Ranks are RINGS: your ladder standing opens the band you can fight in. Select a galaxy, then a system, then a planet to start a ranked match.')
    );
    const myRing = this.myRing();
    const cfg = ringConfig(myRing);
    const home = ringHome(this.universeSeed(), myRing);
    const g = galaxyAt(this.universeSeed(), home.gx, home.gy);
    const headline = el('div', 'rk-highlight');
    headline.innerHTML =
      `<div class="rk-highlight-band" style="--rk-accent:${cfg.accent}">${cfg.name} BAND</div>` +
      `<div class="rk-highlight-body">${cfg.tagline}<span class="rk-highlight-sub">${cfg.worldHint}</span></div>`;
    box.appendChild(headline);
    const go = el('button', 'rk-btn primary wide', `FLY TO ${g?.name.toUpperCase() ?? 'YOUR SECTOR'}`) as HTMLButtonElement;
    go.type = 'button';
    go.addEventListener('click', () => this.map.flyToRing(myRing));
    box.appendChild(go);
    return box;
  }

  private buildGalaxyPanel(g: GalaxyDescriptor): HTMLElement {
    const box = el('div', 'rk-card');
    box.appendChild(el('div', 'rk-card-kicker', g.poiLabel));
    box.appendChild(el('div', 'rk-card-title', g.name.toUpperCase()));
    const stats = el('div', 'rk-stat-grid');
    stats.innerHTML =
      `<div class="rk-stat"><span>STAR</span><b style="color:${g.starColor}">${g.starType.replace('_', ' ')}</b></div>` +
      `<div class="rk-stat"><span>SYSTEMS</span><b>${g.systemCount}</b></div>` +
      `<div class="rk-stat"><span>NEBULA</span><b style="color:${g.nebulaColor ?? '#8a8f9c'}">${g.nebula}</b></div>` +
      `<div class="rk-stat"><span>RING</span><b>${RING_CONFIGS[g.ring].name}</b></div>`;
    box.appendChild(stats);
    box.appendChild(this.influenceBlock(g.galaxyId));
    box.appendChild(el('p', 'rk-card-note', 'Click a system in the cluster to see its planets.'));
    return box;
  }

  private buildSystemPanel(sys: SystemDescriptor): HTMLElement {
    const g = this.map.currentGalaxy;
    const box = el('div', 'rk-card');
    box.appendChild(el('div', 'rk-card-kicker', g ? g.name.toUpperCase() : ''));
    box.appendChild(el('div', 'rk-card-title', sys.name.toUpperCase()));
    const planets = this.planetsOf(sys);
    box.appendChild(this.influenceBlock(sys.galaxyId, sys.systemId));
    const list = el('div', 'rk-planetlist');
    for (const p of planets) {
      const row = this.planetRow(p.key);
      const controlled = row?.state === RANKED_PLANET_CONTROLLED && row.controllingColony < 3;
      const reserved = ClientCache.shared.reservedPlanetKeys().has(p.key);
      const line = el('button', `rk-planetrow${controlled ? ' controlled' : ''}${reserved ? ' reserved' : ''}`) as HTMLButtonElement;
      line.type = 'button';
      if (controlled) line.style.setProperty('--rk-colony', COLONIES[row.controllingColony]?.css ?? '#999');
      line.innerHTML =
        `<span class="rk-planetrow-orb" style="background:${p.biomeColor}"></span>` +
        `<span class="rk-planetrow-name">${p.name.toUpperCase()}</span>` +
        `<span class="rk-planetrow-tag">${controlled ? `${COLONIES[row!.controllingColony]?.name ?? 'HELD'}` : reserved ? 'CONTESTED' : row?.discovered ? 'MAPPED' : 'UNDISCOVERED'}</span>`;
      line.addEventListener('click', () => this.map.selectPlanet(p));
      list.appendChild(line);
    }
    box.appendChild(list);
    return box;
  }

  private planetsOf(sys: SystemDescriptor): PlanetDescriptor[] {
    const out: PlanetDescriptor[] = [];
    const n = this.systemPlanetCount(sys);
    for (let i = 0; i < n; i++) out.push(planetAt(this.universeSeed(), sys.ring, sys.galaxyId, sys.systemId, i));
    return out;
  }

  private systemPlanetCount(sys: SystemDescriptor): number {
    return generatedPlanetCount(this.universeSeed(), sys.ring, sys.galaxyId, sys.systemId);
  }

  private influenceBlock(galaxyId: number, systemId?: number): HTMLElement {
    const rows = this.rowsForGalaxy(galaxyId).filter((r) => (systemId === undefined ? true : r.systemId === systemId));
    const per = [0, 0, 0];
    let controlled = 0;
    for (const r of rows) {
      if (r.state === RANKED_PLANET_CONTROLLED && r.colony < 3) {
        per[r.colony]++;
        controlled++;
      }
    }
    const box = el('div', 'rk-influence');
    if (!controlled) {
      box.appendChild(el('div', 'rk-influence-note', systemId === undefined ? 'No colony holds ground in this galaxy yet.' : 'Contested space — no colony holds 50% of this system.'));
      return box;
    }
    let best = 0;
    for (let c = 1; c < 3; c++) if (per[c] > per[best]) best = c;
    const dominant = per[best] * 2 >= controlled;
    box.appendChild(el('div', 'rk-influence-head', dominant ? `${COLONIES[best].name} DOMINATES` : 'CONTESTED GROUND'));
    const bars = el('div', 'rk-influence-bars');
    for (let c = 0; c < 3; c++) {
      if (!per[c]) continue;
      const pct = Math.round((per[c] / controlled) * 100);
      const rowEl = el('div', 'rk-ibar');
      rowEl.innerHTML = `<span class="rk-ibar-name">${COLONIES[c].name}</span><span class="rk-ibar-track"><span class="rk-ibar-fill" style="width:${pct}%;background:${COLONIES[c].css}"></span></span><span class="rk-ibar-pct">${pct}%</span>`;
      bars.appendChild(rowEl);
    }
    box.appendChild(bars);
    return box;
  }

  private buildPlanetPanel(p: PlanetDescriptor): HTMLElement {
    const row = this.planetRow(p.key);
    const controlled = row?.state === RANKED_PLANET_CONTROLLED && row.controllingColony < 3;
    const reserved = ClientCache.shared.reservedPlanetKeys().has(p.key);
    const discovered = Boolean(row?.discovered);
    const mine = p.ring === this.myRing();
    const box = el('div', 'rk-card rk-planet-card');
    box.style.setProperty('--rk-biome', p.biomeColor);
    box.appendChild(el('div', 'rk-card-kicker', `${p.biomeLabel} ${p.ring === 0 ? 'WORLD' : 'PLANET'}`));
    const title = el('div', 'rk-card-title big', p.name.toUpperCase());
    box.appendChild(title);
    const orb = el('div', 'rk-orb');
    orb.style.setProperty('--rk-orb', p.biomeColor);
    orb.style.setProperty('--rk-corruption', `${Math.round(p.corruption * 100)}%`);
    box.appendChild(orb);

    const stats = el('div', 'rk-stat-grid');
    stats.innerHTML =
      `<div class="rk-stat"><span>RANK RING</span><b>${RING_CONFIGS[p.ring].name}</b></div>` +
      `<div class="rk-stat"><span>GRAVITY</span><b>${p.gravity.toFixed(2)} g</b></div>` +
      `<div class="rk-stat"><span>CORRUPTION</span><b>${Math.round(p.corruption * 100)}%</b></div>` +
      `<div class="rk-stat"><span>THREAT</span><b>${Math.round(p.difficulty * 100)}%</b></div>`;
    box.appendChild(stats);

    const status = el('div', 'rk-status');
    if (controlled) {
      status.innerHTML =
        `<div class="rk-status-line" style="color:${COLONIES[row.controllingColony]?.css ?? '#fff'}">⬢ CONTROLLED BY ${COLONIES[row.controllingColony]?.name ?? 'A COLONY'}</div>` +
        `<div class="rk-shield"><span class="rk-shield-label">PLANETARY SHIELD FALLS IN</span><span class="rk-shield-clock" data-countdown>${this.countdownText(Number(row.controlExpiresAt))}</span></div>`;
    } else if (reserved) {
      status.innerHTML = `<div class="rk-status-line amber">▲ CONTESTED — A MATCH IS FILLING FOR THIS WORLD</div>`;
    } else if (discovered) {
      status.innerHTML = `<div class="rk-status-line">◉ MAPPED — INFESTED, OPEN FOR LIBERATION</div>`;
    } else {
      status.innerHTML = `<div class="rk-status-line dim">? UNDISCOVERED — FIRST CONTACT WILL BE RECORDED</div>`;
    }
    box.appendChild(status);

    const eco = el('div', 'rk-eco');
    eco.innerHTML =
      `<div class="rk-eco-row"><span>ECOLOGY</span><b>${p.ecologyLabel}</b></div>` +
      `<div class="rk-eco-row"><span>APEX</span><b>${p.boss}</b></div>` +
      `<div class="rk-eco-row"><span>SEED</span><b>${(p.seed >>> 0).toString(16).toUpperCase().padStart(8, '0')}</b></div>`;
    box.appendChild(eco);

    // ---- first discoverers (plan §35)
    const discovers = ClientCache.shared.planetDiscoveries(p.key);
    if (discovers.length) {
      const d = el('div', 'rk-discoverers');
      d.appendChild(el('div', 'rk-discoverers-head', 'FIRST DISCOVERED BY'));
      for (const disc of discovers) {
        const line = el('div', 'rk-discoverer');
        line.innerHTML = `<b>${disc.discoveryOrder}</b><span>${disc.playerName}</span>`;
        d.appendChild(line);
      }
      box.appendChild(d);
    }

    // ---- match action (plan §49/§50)
    const queue = ClientCache.shared.myQueue();
    if (queue?.ranked) {
      const searching = el('button', 'rk-btn primary wide searching', `SEARCHING — ${p.name.toUpperCase()}…`) as HTMLButtonElement;
      searching.type = 'button';
      searching.addEventListener('click', () => this.ctx.goQueue());
      box.appendChild(searching);
    } else if (queue) {
      box.appendChild(el('p', 'rk-card-note', 'You are already in a matchmaking queue — cancel it first.'));
    } else if (!mine) {
      box.appendChild(el('p', 'rk-card-note', `This world fights at ${RING_CONFIGS[p.ring].name} — reach that ring to battle here.`));
    } else if (controlled || reserved) {
      const other = this.findAnother(p);
      const b = el('button', 'rk-btn primary wide', other ? `FIND ANOTHER PLANET — ${other.name.toUpperCase()}` : 'SEARCH THE NEXT GALAXY') as HTMLButtonElement;
      b.type = 'button';
      b.addEventListener('click', () => {
        const target = this.findAnother(p);
        if (target) {
          this.jumpTo(target);
          this.ctx.toast(`${p.name.toUpperCase()} is shielded — target acquired: ${target.name.toUpperCase()}.`);
        } else {
          const ring = this.myRing();
          const home = ringHome(this.universeSeed(), ring);
          this.ctx.toast(`All of ${galaxyAt(this.universeSeed(), home.gx, home.gy)?.name.toUpperCase() ?? 'this galaxy'} is held — searching outward is a future update.`);
        }
      });
      box.appendChild(b);
    } else {
      const b = el('button', 'rk-btn primary wide', `FIND MATCH — LIBERATE ${p.name.toUpperCase()}`) as HTMLButtonElement;
      b.type = 'button';
      b.addEventListener('click', () => this.startRanked(p));
      box.appendChild(b);
      box.appendChild(el('p', 'rk-card-note', 'Win the match to raise your colony\'s 72-hour shield over this planet.'));
    }
    return box;
  }

  private findAnother(p: PlanetDescriptor): PlanetDescriptor | null {
    const g = this.map.currentGalaxy ?? galaxyAt(this.universeSeed(), 0, 0);
    const systemCount = g?.systemCount ?? 8;
    return nearestAvailablePlanet(
      this.universeSeed(),
      p.ring,
      p.galaxyId,
      p.systemId,
      p.planetId,
      systemCount,
      (cand) => this.planetAvailable(cand)
    );
  }

  private jumpTo(p: PlanetDescriptor): void {
    const { gx, gy } = decodeGalaxyId(p.galaxyId);
    const g = galaxyAt(this.universeSeed(), gx, gy) ?? this.map.currentGalaxy;
    if (g && g.galaxyId !== this.map.currentGalaxy?.galaxyId) this.map.openGalaxy(g);
    const sys = systemAt(this.universeSeed(), p.ring, p.galaxyId, p.systemId);
    this.map.markSystem(sys);
    this.map.selectPlanet(p);
  }

  private startRanked(p: PlanetDescriptor): void {
    if (p.ring !== this.myRing()) {
      this.ctx.toast('That system belongs to another rank ring — climb to unlock it.');
      return;
    }
    if (!this.planetAvailable(p)) {
      this.ctx.toast('That planet is shielded or contested — pick another.');
      return;
    }
    findRankedMatch(p.ring, p.galaxyId, p.systemId, p.planetId);
    this.ctx.toast(`Searching for a ranked match on ${p.name.toUpperCase()}…`);
  }

  private countdownText(expiresUs: number): string {
    const remain = Math.max(0, expiresUs - this.serverNowUs());
    if (remain <= 0) return '00:00:00';
    const s = Math.floor(remain / 1e6);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  // ------------------------------------------------------------ discovery flash

  private flashDiscovery(p: PlanetDescriptor, order: number): void {
    this.discoverEl.innerHTML =
      `<div class="rk-disc-inner">` +
      `<div class="rk-disc-title">NEW PLANET DISCOVERED</div>` +
      `<div class="rk-disc-name">${p.name.toUpperCase()}</div>` +
      `<div class="rk-disc-line">${p.biomeLabel} · ${p.ecologyLabel} · ${order === 1 ? 'FIRST FOOTFALL' : `DISCOVERER #${order}`}</div>` +
      `</div>`;
    this.discoverEl.classList.remove('hidden');
    this.discoverEl.classList.remove('playing');
    void this.discoverEl.offsetWidth;
    this.discoverEl.classList.add('playing');
    window.setTimeout(() => this.discoverEl.classList.add('hidden'), 3600);
  }

  // ------------------------------------------------------------ colony stats (plan §76)

  private async refreshStats(): Promise<void> {
    const stats = await colonyStats();
    if (stats) {
      this.stats = stats;
      this.renderStats();
    }
  }

  private renderStats(): void {
    if (!this.stats) return;
    this.statsEl.innerHTML = '';
    const head = el('div', 'rk-colonies-head');
    head.innerHTML = `<span>COLONY DOMINANCE</span><b>${this.stats.totalPlanets} PLANETS · ${this.stats.totalSystems} SYSTEMS</b>`;
    this.statsEl.appendChild(head);
    for (const c of this.stats.colonies) {
      const rowEl = el('div', 'rk-colony-row');
      rowEl.style.setProperty('--rk-colony', COLONIES[c.colony]?.css ?? '#999');
      rowEl.innerHTML =
        `<span class="rk-colony-name">${COLONIES[c.colony]?.name ?? '—'}</span>` +
        `<span class="rk-colony-num">${c.planets}<i>planets</i></span>` +
        `<span class="rk-colony-num">${c.systems}<i>systems</i></span>` +
        `<span class="rk-colony-num warn">${c.expiring}<i>falling</i></span>`;
      this.statsEl.appendChild(rowEl);
    }
    const mine = this.me();
    if (mine && mine.colony < 3) {
      const c = this.stats.colonies[mine.colony];
      this.statsEl.appendChild(el('div', 'rk-colony-you', `YOUR COLONY · ${COLONIES[mine.colony].name} — ${c?.planets ?? 0} PLANETS HELD`));
    }
  }

  // ------------------------------------------------------------ leaderboard (plan §78)

  private toggleBoard(): void {
    if (this.boardEl) {
      this.boardEl.remove();
      this.boardEl = null;
      return;
    }
    const overlay = el('div', 'rk-board-overlay');
    const panel = el('div', 'rk-board');
    const head = el('div', 'rk-board-head');
    head.innerHTML = '<span class="rk-board-title">KING OF GODS</span><span class="rk-board-sub">TOP RANKED SURVIVORS</span>';
    const close = el('button', 'rk-board-close', '✕') as HTMLButtonElement;
    close.type = 'button';
    close.addEventListener('click', () => this.toggleBoard());
    head.appendChild(close);
    panel.appendChild(head);
    const rows = ClientCache.shared.rankedTop();
    if (!rows.length) {
      panel.appendChild(el('p', 'rk-card-note', 'No ranked matches have been played yet — be the first name on the board.'));
    } else {
      rows.slice(0, 20).forEach((r, i) => {
        const info = getRankFromStars(r.rankPoints);
        const line = el('button', 'rk-board-row') as HTMLButtonElement;
        line.type = 'button';
        if (i < 3) line.classList.add(`top${i + 1}`);
        if (hexOf(r.identity) === this.ctx.myHex()) line.classList.add('me');
        line.innerHTML =
          `<span class="rk-board-rank">#${i + 1}</span>` +
          `<span class="rk-board-name">${r.playerName || 'SURVIVOR'}</span>` +
          `<span class="rk-board-colony" style="color:${COLONIES[r.colony]?.css ?? '#999'}">${COLONIES[r.colony]?.name ?? '—'}</span>` +
          `<span class="rk-board-stars">${info.stars} ★</span>` +
          `<span class="rk-board-tier">${rankLabel(info.tier, info.division)}</span>`;
        line.addEventListener('click', () => this.ctx.openProfile(hexOf(r.identity)));
        panel.appendChild(line);
      });
    }
    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.toggleBoard();
    });
    this.element.appendChild(overlay);
    this.boardEl = overlay;
  }

  private zoomBy(f: number): void {
    this.map.zoomStep(f);
  }
}
