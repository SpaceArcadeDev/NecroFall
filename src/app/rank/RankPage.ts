// NECROFALL — RANK PAGE (plan §47–§50/§74/§81). The full ranked loop lives
// here: your ladder standing on top, the INTERGALACTIC MAP in the middle
// (GalacticMap canvas), the ring rail down one side and the context panel
// (galaxy → system → planet details → FIND MATCH) along the other.
//
// The page is a pure VIEW over the server subscriptions: availability, control
// and countdowns all come from `ranked_planet` rows; everything else is
// regenerated from the season seed. The only write it performs is
// `findRankedMatch` (§53) — first contact/discovery is earned by PLAYING and is
// recorded by AppShell when a ranked match ends (user ask 2026-09-28).
import { ClientCache } from '../spacetimedb/cache';
import { hexOf } from '../spacetimedb/rows';
import { colonyStats, ColonyStatsResult, findRankedMatch } from '../spacetimedb/reducers';
import {
  releaseLocationDiscovery,
  subscribeLocationDiscovery,
  subscribePlanetDetail,
  subscribeRank,
  subscribeRankGalaxy,
} from '../spacetimedb/subscriptions';
import { ShellContext } from '../ShellContext';
import { el } from '../ui/dom';
import { COLONIES } from '../../core/Config';
import { GalacticMap, type MapData, type MapSelection, type PlanetRowData, RANKED_PLANET_CONTROLLED } from '../../rankmap/GalacticMap';
import { DEFAULT_UNIVERSE_SEED, decodeGalaxyId, parsePlanetKey } from '../../rankmap/procedural/SeedHash';
import { nearestAvailablePlanet, ringHome } from '../../rankmap/procedural/UniverseGenerator';
import { planetAt } from '../../rankmap/procedural/PlanetGenerator';
import { systemAt } from '../../rankmap/procedural/SolarSystemGenerator';
import { systemPlanetCount as generatedPlanetCount } from '../../rankmap/procedural/SolarSystemGenerator';
import { galaxyAt } from '../../rankmap/procedural/GalaxyGenerator';
import { RING_CONFIGS, ringConfig } from '../../rankmap/procedural/RankRingConfig';
import { GalaxyDescriptor, PlanetDescriptor, SystemDescriptor } from '../../rankmap/procedural/GalaxyTypes';
import { getRankDisplayName, getRankFromStars, rankLabel, TIER_KOG, TIER_LIBERATOR } from '../../rank/RankService';
import {
  galaxyLocationKey,
  planetLocationKey,
  systemLocationKey,
  toDiscoveryEntry,
  type DiscoveryEntry,
} from '../../rankmap/DiscoveryTypes';
import {
  buildGalaxyPanel,
  buildPlanetPanel,
  buildRootPanel,
  buildSystemPanel,
  controlBlock,
  discoveryBlock,
  shieldCountdownText,
  type LocationPanelHost,
} from './LocationInfoPanel';
import { calculateDominance } from '../../rankmap/LocationControlSummary';
import {
  createCenterIcon,
  createFullscreenExitIcon,
  createFullscreenIcon,
} from '../../rankmap/RankMapIcons';

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
  private stripEl: HTMLElement;
  private discoverEl: HTMLElement;
  /** Fullscreen control + discoverers overlay (the expanded map hides the side column). */
  private mapInfoEl: HTMLElement;
  private mapInfoSig = '';
  private statsEl: HTMLElement;
  private boardEl: HTMLElement | null = null;
  private selection: MapSelection = { level: 'galactic', galaxy: null, system: null, planet: null, selected: null };
  private unsubscribe: () => void = () => undefined;
  private statsTimer = 0;
  private tickTimer = 0;
  private panelSig = '';
  private headSig = '';
  private railSig = '';
  private crumbSig = '';
  private discoveryShown = new Set<string>();
  private stats: ColonyStatsResult | null = null;
  private subscribedGalaxies = new Set<number>();
  /** The ONE discovery scope the panel currently reads (plan §43 — never the universe). */
  private discoveryKey = '';
  /** Last countdown text written to the DOM (plan §15 — one write per second). */
  private countdownSig = '';
  private recordEl: HTMLElement;
  private quickEl: HTMLElement;
  private quickJoin!: HTMLButtonElement;
  private quickCreate!: HTMLButtonElement;
  private quickFind!: HTMLButtonElement;
  private quickJoinRow!: HTMLElement;
  private quickInput!: HTMLInputElement;
  private quickSig = '';
  private colonySig = '';
  /** The map's data provider — the page implements discoveries + the server clock. */
  private mapData!: MapData;
  private mapExpandBtn!: HTMLButtonElement;
  private panelHost: LocationPanelHost;

  constructor(private ctx: ShellContext) {
    this.element = el('div', 'nf-page rank-page');

    // ---- header: the RANKED wordmark on the lobby's lit rule (the party-page dress)
    this.headEl = el('div', 'lobby-head rk-head');
    this.element.appendChild(this.headEl);

    // ---- standing strip: crest · rank · stars · progress + the two actions
    this.stripEl = el('div', 'rk-strip');
    this.element.appendChild(this.stripEl);

    // ---- expandable rank details (record / last match / to next) — the strip's
    // chevron toggles it; the drawer is why the strip itself can stay one line.
    this.recordEl = el('div', 'rk-record');
    this.element.appendChild(this.recordEl);

    // ---- body: map + ring rail + context panel
    const main = el('div', 'rk-main');
    this.mapWrap = el('div', 'rk-map-wrap');
    this.hoverTip = el('div', 'rk-hover-tip hidden');
    this.discoverEl = el('div', 'rk-discover hidden');
    // ---- FULLSCREEN INFO OVERLAY (user ask 2026-09-29): the expanded map covers the
    // side column, so who CONTROLS the place and who DISCOVERED it follows the
    // selection into fullscreen as a compact glass card.
    this.mapInfoEl = el('div', 'rk-mapinfo hidden');
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
    zoomCtl.appendChild(mkZoom('+', 'Zoom in', () => this.zoomBy(1.5)));
    zoomCtl.appendChild(mkZoom('−', 'Zoom out', () => this.zoomBy(1 / 1.5)));
    // BACK TO POSITION (plan §29/§52): a navigation-target crosshair — clears the
    // selection and flies home through the ONE existing camera pipeline.
    zoomCtl.appendChild(mkZoom(createCenterIcon(), 'Back to your position', () => this.map.centerOnHome()));
    // ---- FULLSCREEN map toggle (plan §53): expands the map container ONLY —
    // camera, zoom, selection and discovery state are all preserved.
    const mapExpand = el('button', 'rk-map-expand') as HTMLButtonElement;
    mapExpand.type = 'button';
    const setExpandIcon = (full: boolean): void => {
      mapExpand.innerHTML = full ? createFullscreenExitIcon() : createFullscreenIcon();
      mapExpand.title = full ? 'Exit fullscreen map' : 'Fullscreen map';
      mapExpand.setAttribute('aria-label', mapExpand.title);
    };
    setExpandIcon(false);
    this.mapExpandBtn = mapExpand;
    mapExpand.addEventListener('click', () => {
      const full = this.element.classList.toggle('map-full');
      setExpandIcon(full);
    });
    this.mapWrap.appendChild(this.breadcrumb);
    this.mapWrap.appendChild(zoomCtl);
    this.mapWrap.appendChild(this.hoverTip);
    this.mapWrap.appendChild(this.discoverEl);
    this.mapWrap.appendChild(this.mapInfoEl);
    this.mapWrap.appendChild(mapExpand);
    main.appendChild(this.mapWrap);

    this.railEl = el('div', 'rk-rail');
    main.appendChild(this.railEl);

    const sideCol = el('div', 'rk-side');
    this.side = el('div', 'rk-panel');
    sideCol.appendChild(this.side);
    this.statsEl = el('div', 'rk-colonies');
    sideCol.appendChild(this.statsEl);
    main.appendChild(sideCol);

    // ---- quick actions (user ask): JOIN · CREATE PARTY · FIND MATCH. In landscape
    // these own the right column; in portrait they are a compact row under the panel.
    this.quickEl = el('div', 'rk-quick');
    this.quickJoin = el('button', 'rk-btn', 'JOIN') as HTMLButtonElement;
    this.quickJoin.type = 'button';
    this.quickCreate = el('button', 'rk-btn', 'CREATE LOBBY') as HTMLButtonElement;
    this.quickCreate.type = 'button';
    this.quickFind = el('button', 'rk-btn primary', 'FIND MATCH') as HTMLButtonElement;
    this.quickFind.type = 'button';
    this.quickJoinRow = el('div', 'rk-join-row hidden');
    this.quickInput = el('input', 'rk-join-input') as HTMLInputElement;
    this.quickInput.maxLength = 8;
    this.quickInput.placeholder = 'LOBBY CODE';
    this.quickInput.autocapitalize = 'characters';
    this.quickInput.autocomplete = 'off';
    const quickGo = el('button', 'rk-btn primary', 'GO') as HTMLButtonElement;
    quickGo.type = 'button';
    this.quickJoin.addEventListener('click', () => {
      this.quickJoinRow.classList.toggle('hidden');
      if (!this.quickJoinRow.classList.contains('hidden')) this.quickInput.focus();
    });
    quickGo.addEventListener('click', () => {
      const code = this.quickInput.value.trim().toUpperCase();
      if (code.length < 4) {
        this.ctx.toast('Enter a valid lobby code.');
        return;
      }
      // same rule as the lobby setup: JOINing opens the room only once it lands
      this.ctx.setLobbyFormat('RANK');
      this.ctx.joinLobbyByCode(code);
    });
    this.quickInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') quickGo.click();
    });
    this.quickCreate.addEventListener('click', () => {
      const hex = this.ctx.myHex();
      const party = hex ? ClientCache.shared.myParty(hex) : null;
      // a lobby opened from the RANK menu is a RANK lobby (the room tags it so)
      this.ctx.setLobbyFormat('RANK');
      if (party) {
        this.ctx.goLobbyRoom();
        return;
      }
      this.ctx.official.createParty();
      this.ctx.goLobbyRoom(); // CREATE LOBBY opens the room
    });
    this.quickFind.addEventListener('click', () => this.quickRankedSearch());
    this.quickJoinRow.append(this.quickInput, quickGo);
    this.quickEl.append(this.quickJoin, this.quickCreate, this.quickFind, this.quickJoinRow);
    main.appendChild(this.quickEl);

    this.element.appendChild(main);

    // ---- map instance (canvas goes into mapWrap before the overlays)
    const data: MapData = {
      universeSeed: this.universeSeed(),
      myRing: this.myRing(),
      colonyNames: COLONIES.map((c) => c.name),
      colonyColors: COLONIES.map((c) => c.css),
      rowsForGalaxy: (galaxyId) => this.rowsForGalaxy(galaxyId),
      allRows: () => ClientCache.shared.rankedPlanetsAll().map((r) => ({
        planetKey: r.planetKey,
        ring: r.ring,
        galaxyId: r.galaxyId,
        systemId: r.systemId,
        planetId: r.planetId,
        state: r.state,
        colony: r.controllingColony,
        controlExpiresAt: Number(r.controlExpiresAt),
        discovered: r.discovered,
      })),
      reservedKeys: () => ClientCache.shared.reservedPlanetKeys(),
      serverNowUs: () => this.serverNowUs(),
      discoveriesForGalaxy: (galaxyId) => this.discoveriesForGalaxy(galaxyId),
      discoveriesForSystem: (galaxyId, systemId) => this.discoveriesForSystem(galaxyId, systemId),
      discoveriesForPlanet: (planetKey) => this.discoveriesForPlanet(planetKey),
      currentPlayerId: this.ctx.myHex(),
      currentPlayerName: this.me()?.playerName ?? 'SURVIVOR',
    };
    this.mapData = data;
    this.map = new GalacticMap(
      this.mapWrap,
      data,
      (sel) => this.onSelection(sel),
      (hover) => this.showHover(hover)
    );
    this.panelHost = this.buildPanelHost();

    // ---- subscriptions + render loops
    subscribeRank();
    subscribeRankGalaxy(this.myGalaxy().galaxyId || 0);
    this.unsubscribe = ClientCache.shared.onChange(() => this.onData());
    this.renderHead();
    this.renderRail();
    this.renderBreadcrumb();
    this.renderSide();
    this.renderQuick();
    void this.refreshStats();
    this.statsTimer = window.setInterval(() => {
      if (!this.element.isConnected) return;
      void this.refreshStats();
    }, 45_000);
    // ONE tick for every live countdown + breadcrumb (plan §15): `renderSide(true)`
    // only WRITES when the formatted second actually changed.
    this.tickTimer = window.setInterval(() => {
      if (!this.element.isConnected) return;
      this.renderSide(true);
      this.renderBreadcrumb();
      this.renderRail(); // the viewed band changes as the camera pans (sig-guarded)
      this.renderMapInfo(); // …and so does the fullscreen info card
    }, 500);
  }

  // ------------------------------------------------------------ lifecycle

  onHide(): void {
    this.unsubscribe();
    if (this.statsTimer) window.clearInterval(this.statsTimer);
    if (this.tickTimer) window.clearInterval(this.tickTimer);
    if (this.discoveryKey) {
      releaseLocationDiscovery(this.discoveryKey);
      this.discoveryKey = '';
    }
    this.map.dispose();
    this.boardEl?.remove();
  }

  update(): void {
    this.renderHead();
    this.renderRail();
    this.renderSide();
    this.renderQuick();
  }

  // ------------------------------------------------------------ data sources

  private universeSeed(): number {
    const season = ClientCache.shared.rankedSeason();
    if (season) return Number(season.universeSeed % 4294967296n) >>> 0;
    return DEFAULT_UNIVERSE_SEED;
  }

  /**
   * SERVER time (plan §14/§46): the 1 Hz `server_clock` row plus the client
   * millis elapsed since it landed. Every countdown — the canvas arc AND the
   * DOM text — reads THIS; `Date.now()` is never used for display.
   */
  private serverNowUs(): number {
    return ClientCache.shared.serverNowUs();
  }

  // ------------------------------------------------------------ discovery (plan §7/§43/§47)

  private discoveriesForGalaxy(galaxyId: number): DiscoveryEntry[] {
    const { gx, gy } = decodeGalaxyId(galaxyId);
    return ClientCache.shared.locationDiscoveries(galaxyLocationKey(gx, gy)).map(toDiscoveryEntry);
  }

  private discoveriesForSystem(galaxyId: number, systemId: number): DiscoveryEntry[] {
    const { gx, gy } = decodeGalaxyId(galaxyId);
    return ClientCache.shared.locationDiscoveries(systemLocationKey(gx, gy, systemId)).map(toDiscoveryEntry);
  }

  private discoveriesForPlanet(planetKey: string): DiscoveryEntry[] {
    const parsed = parsePlanetKey(planetKey);
    if (!parsed) return [];
    const { gx, gy } = decodeGalaxyId(parsed.galaxyId);
    return ClientCache.shared
      .locationDiscoveries(planetLocationKey(gx, gy, parsed.systemId, parsed.planetId))
      .map(toDiscoveryEntry);
  }

  /** The map's first-contact request (plan §6/§47) is GONE — discovery is earned by
   *  playing: AppShell records planet + system + galaxy when a ranked match ends. */

  /**
   * The ONE discovery scope on screen (plan §43): the SELECTED location, else the
   * camera focus. The previous scope is released so the client can never hold
   * more than the location it is showing.
   */
  private focusDiscoveryScope(sel: MapSelection): void {
    const loc = sel.selected;
    let key = '';
    if (loc?.type === 'planet' && loc.planet) {
      const { gx, gy } = decodeGalaxyId(loc.planet.galaxyId);
      key = planetLocationKey(gx, gy, loc.planet.systemId, loc.planet.planetId);
    } else if (loc?.type === 'system' && loc.system) {
      const { gx, gy } = decodeGalaxyId(loc.system.galaxyId);
      key = systemLocationKey(gx, gy, loc.system.systemId);
    } else if (loc?.type === 'galaxy') {
      key = galaxyLocationKey(loc.galaxy.gx, loc.galaxy.gy);
    } else if (sel.level === 'system' && sel.system) {
      const { gx, gy } = decodeGalaxyId(sel.system.galaxyId);
      key = systemLocationKey(gx, gy, sel.system.systemId);
    } else if (sel.level === 'galaxy' && sel.galaxy) {
      key = galaxyLocationKey(sel.galaxy.gx, sel.galaxy.gy);
    }
    if (key === this.discoveryKey) return;
    if (this.discoveryKey) releaseLocationDiscovery(this.discoveryKey);
    this.discoveryKey = key;
    if (key) subscribeLocationDiscovery(key);
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
      morphology: 'SPIRAL', rotation: 0, armCount: 2, armTightness: 3,
      bulgeStrength: 1, discThickness: 0.06, axisRatio: 1, brightness: 1,
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
    // The discovery FLASH celebrates a FRESH first-contact on the viewed planet:
    // the record arrives from the server (selection-driven requests + match-end),
    // and only a find inside the last ~90 s celebrates — reloads stay quiet.
    const selPlanet = this.selection.selected?.planet ?? this.selection.planet;
    if (selPlanet && !this.discoveryShown.has(selPlanet.key)) {
      const { gx, gy } = decodeGalaxyId(selPlanet.galaxyId);
      const rows = ClientCache.shared.locationDiscoveries(planetLocationKey(gx, gy, selPlanet.systemId, selPlanet.planetId));
      const mine = rows.find((d) => hexOf(d.playerIdentity) === this.ctx.myHex());
      const fresh = mine ? this.serverNowUs() - Number(mine.discoveredAt) < 90_000_000 : false;
      if (mine && fresh) {
        this.discoveryShown.add(selPlanet.key);
        this.flashDiscovery(selPlanet, mine.discoveryIndex);
      }
    }
    this.renderHead();
    this.renderRail();
    this.renderBreadcrumb();
    this.renderSide();
    this.renderQuick();
    this.renderColony();
    this.renderMapInfo();
  }

  // ------------------------------------------------------------ fullscreen info overlay

  /**
   * CONTROL + DISCOVERED BY for the expanded map (user 2026-09-29): the same data the
   * side panel reads — one compact card, sig-guarded so the 500 ms tick costs nothing.
   */
  private renderMapInfo(): void {
    const sel = this.selection;
    const loc = sel.selected;
    const planet = loc?.planet ?? sel.planet;
    const sys = loc?.system ?? sel.system;
    const galaxy = loc?.galaxy ?? sel.galaxy;
    // MINIMAL (user 2026-09-29): control headline + at most THREE discoverers.
    const MAX_ROWS = 3;
    let sig = 'none';
    if (planet) {
      const row = this.planetRow(planet.key);
      sig = `p:${planet.key}:${row?.state ?? -1}:${row?.controllingColony ?? -1}:${this.discoveriesForPlanet(planet.key).length}`;
    } else if (sys) {
      sig = `s:${sys.galaxyId}:${sys.systemId}:${this.rowsForGalaxy(sys.galaxyId).length}:${this.discoveriesForSystem(sys.galaxyId, sys.systemId).length}`;
    } else if (galaxy) {
      sig = `g:${galaxy.galaxyId}:${this.rowsForGalaxy(galaxy.galaxyId).length}:${this.discoveriesForGalaxy(galaxy.galaxyId).length}`;
    }
    if (sig === this.mapInfoSig) return;
    this.mapInfoSig = sig;
    this.mapInfoEl.innerHTML = '';
    if (!planet && !sys && !galaxy) {
      this.mapInfoEl.classList.add('hidden');
      return;
    }
    const colours = COLONIES.map((c) => c.css);
    const names = COLONIES.map((c) => c.name);
    const card = el('div', 'rk-mapinfo-card');
    if (planet) {
      const row = this.planetRow(planet.key);
      card.appendChild(el('div', 'rk-mapinfo-kicker', `PLANET · ${RING_CONFIGS[planet.ring]?.name ?? '?'} BAND`));
      card.appendChild(el('div', 'rk-mapinfo-title', planet.name.toUpperCase()));
      const summary = calculateDominance(
        row
          ? [
              {
                systemId: row.systemId,
                state: row.state,
                colony: row.controllingColony,
                discovered: row.discovered,
                controlExpiresAt: Number(row.controlExpiresAt),
              },
            ]
          : [],
        { colonyColors: colours, colonyNames: names }
      );
      card.appendChild(controlBlock(summary, { kicker: 'CONTROL', compact: true }));
      card.appendChild(
        discoveryBlock(this.discoveriesForPlanet(planet.key), {
          fallback: row?.discovered ? 'historical' : 'none',
          nowUs: this.serverNowUs(),
          max: MAX_ROWS,
        })
      );
    } else if (sys) {
      const g = this.map.currentGalaxy ?? this.panelHost.currentGalaxyFor(sys);
      card.appendChild(el('div', 'rk-mapinfo-kicker', `${g ? g.name.toUpperCase() : 'GALAXY'} · SOLAR SYSTEM`));
      card.appendChild(el('div', 'rk-mapinfo-title', sys.name.toUpperCase()));
      const summary = calculateDominance(this.rowsForGalaxy(sys.galaxyId), {
        colonyColors: colours,
        colonyNames: names,
        systemId: sys.systemId,
      });
      card.appendChild(controlBlock(summary, { kicker: 'CONTROL', compact: true }));
      card.appendChild(
        discoveryBlock(this.discoveriesForSystem(sys.galaxyId, sys.systemId), {
          fallback: 'none',
          nowUs: this.serverNowUs(),
          max: MAX_ROWS,
        })
      );
    } else if (galaxy) {
      const cfg = RING_CONFIGS[galaxy.ring] ?? RING_CONFIGS[0];
      card.appendChild(el('div', 'rk-mapinfo-kicker', `${galaxy.morphology.replace(/_/g, ' ')} · ${cfg.name} BAND`));
      card.appendChild(el('div', 'rk-mapinfo-title', galaxy.name.toUpperCase()));
      const summary = calculateDominance(this.rowsForGalaxy(galaxy.galaxyId), { colonyColors: colours, colonyNames: names });
      card.appendChild(controlBlock(summary, { kicker: 'TERRITORY', compact: true }));
      card.appendChild(
        discoveryBlock(this.discoveriesForGalaxy(galaxy.galaxyId), { fallback: 'none', nowUs: this.serverNowUs(), max: MAX_ROWS })
      );
    }
    this.mapInfoEl.appendChild(card);
    this.mapInfoEl.classList.remove('hidden');
  }

  // ------------------------------------------------------------ header

  private renderHead(): void {
    const stars = this.myStars();
    const info = getRankFromStars(stars);
    const cfg = ringConfig(info.tier);
    const name = getRankDisplayName(stars);
    const streak = this.streakLabel();
    const seasonId = ClientCache.shared.rankedSeason()?.seasonId ?? 1;
    // Rebuild ONLY when something actually changed. The page's data ticks fire
    // constantly (presence heartbeats, other matches…), and every rebuild restarted
    // the bar's fill + shimmer mid-sweep — "the progress bar animates halfway and
    // stops" (user report 2026-09-28).
    const history = ClientCache.shared.myRankHistory(this.ctx.myHex());
    let wins = 0;
    let draws = 0;
    let losses = 0;
    for (const row of history) {
      if (row.delta > 0) wins++;
      else if (row.delta < 0) losses++;
      else draws++;
    }
    const record = history.length ? `${wins}W · ${draws}D · ${losses}L` : 'NO BATTLES YET';
    const toNext = info.toNext > 0 ? `${info.toNext} ★` : 'MAX';
    const last = history[0];
    const lastTxt = last ? `${last.delta > 0 ? '+' : ''}${last.delta} ★` : '—';
    const lastCls = last ? (last.delta > 0 ? 'up' : last.delta < 0 ? 'down' : 'flat') : 'flat';
    const sig = `${stars}|${seasonId}|${streak}|${record}|${lastTxt}`;
    if (sig === this.headSig) return;
    this.headSig = sig;
    // The header (user ask): the gradient wordmark reads RANK — like the PLAY title —
    // with the live season as a tag pill right beside it.
    this.headEl.innerHTML =
      `<div class="rk-head-title-row">` +
      `<div class="menu-title lobby-title rk-title">RANK</div>` +
      `<span class="rk-season-pill"><b>SEASON</b><i>${seasonId}</i></span>` +
      `</div>`;
    // The standing strip (user ask): [ chevron ][ crest ][ name + STARS ] … [ colony pill ]
    // [ leaderboard icon ]. No progress bar (the stars ARE the progress) and no season
    // block (it lives in the header now).
    this.stripEl.style.setProperty('--rk-accent', cfg.accent);
    this.stripEl.innerHTML =
      `<div class="rk-strip-rank">` +
      `<button class="rk-expand" data-act="record" title="Rank details" aria-label="Rank details">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 9 6.5 6.5L18.5 9"/></svg>` +
      `</button>` +
      `<div class="rk-crest" data-tier="${info.tier}">` +
      `<svg viewBox="0 0 48 56" aria-hidden="true"><path class="rk-crest-shield" d="M24 2 44 10v18c0 12-8 20-20 26C12 48 4 40 4 28V10z"/><path class="rk-crest-inner" d="M24 8 38 14v14c0 8.5-5.5 14.5-14 19.4C15.5 42.5 10 36.5 10 28V14z"/></svg>` +
      `<span class="rk-crest-star">★</span></div>` +
      `<div class="rk-head-info">` +
      `<div class="rk-rank-line">` +
      `<span class="rk-rank-name">${name}</span>` +
      `<span class="rk-stars-row">${this.starsHtml(info.stars, info.tier)}</span>` +
      `</div>` +
      `<div class="rk-next">${streak}</div>` +
      `</div>` +
      `</div>` +
      `<div class="rk-strip-side">` +
      `<div class="rk-colony" data-colony>` +
      `<span class="rk-colony-ico" data-colony-ico>◆</span>` +
      `<b data-colony-name>—</b>` +
      `</div>` +
      `<button class="rk-btn rk-btn-ico" data-act="board" title="Colony leaderboard" aria-label="Colony leaderboard">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 20V11"/><path d="M12 20V4"/><path d="M19 20v-6"/></svg>` +
      `</button>` +
      `</div>`;
    // The expandable details: win/loss record, last match, stars to next rank.
    this.recordEl.innerHTML =
      `<div class="rk-record-grid">` +
      `<div class="rk-record-cell"><span>RECORD</span><b>${record}</b></div>` +
      `<div class="rk-record-cell"><span>LAST MATCH</span><b class="${lastCls}">${lastTxt}</b></div>` +
      `<div class="rk-record-cell"><span>TO NEXT RANK</span><b>${toNext}</b></div>` +
      `<div class="rk-record-cell"><span>BATTLES</span><b>${history.length}</b></div>` +
      `</div>`;
    this.stripEl.querySelector('[data-act="board"]')?.addEventListener('click', () => this.toggleBoard());
    this.stripEl.querySelector('[data-act="record"]')?.addEventListener('click', () => this.toggleRecord());
    this.colonySig = '';
    this.renderColony();
  }

  /** The colony pill at the far right of the strip (user ask): the colony ICON + the
   *  colony name — no dot (the icon already says it) and no stat line. */
  private renderColony(): void {
    const host = this.stripEl.querySelector<HTMLElement>('[data-colony]');
    if (!host) return;
    const me = this.me();
    const hasColony = Boolean(me && me.colony < 3);
    const col = hasColony ? COLONIES[me!.colony] : null;
    const name = col ? col.name : 'NO COLONY';
    const icon = col ? col.symbol : '◇';
    const sig = `${icon}|${name}`;
    if (sig === this.colonySig) return;
    this.colonySig = sig;
    const accent = col?.css ?? '#8fd7ff';
    host.style.setProperty('--rk-colony', accent);
    const ico = host.querySelector<HTMLElement>('[data-colony-ico]');
    if (ico) ico.textContent = icon;
    const nameEl = host.querySelector<HTMLElement>('[data-colony-name]');
    if (nameEl) nameEl.textContent = name;
  }

  private toggleRecord(): void {
    const open = this.recordEl.classList.toggle('open');
    this.stripEl.querySelector('[data-act="record"]')?.classList.toggle('open', open);
  }

  /** JOIN · CREATE PARTY · FIND MATCH — labels follow the party/queue state. */
  private renderQuick(): void {
    const hex = this.ctx.myHex();
    const party = hex ? ClientCache.shared.myParty(hex) : null;
    const queue = ClientCache.shared.myQueue();
    const sig = `${party ? 1 : 0}|${queue?.ranked ? 1 : queue ? 2 : 0}`;
    if (sig === this.quickSig) return;
    this.quickSig = sig;
    this.quickJoinRow.classList.add('hidden');
    this.quickJoin.classList.toggle('hidden', Boolean(party));
    this.quickCreate.textContent = party ? 'OPEN LOBBY' : 'CREATE LOBBY';
    this.quickFind.classList.toggle('searching', Boolean(queue?.ranked));
    this.quickFind.textContent = queue?.ranked ? 'SEARCHING…' : 'FIND MATCH';
  }

  /** FIND MATCH with no planet picked: lock onto the nearest open world in my ring. */
  private quickRankedSearch(): void {
    const queue = ClientCache.shared.myQueue();
    if (queue?.ranked) {
      this.ctx.goQueue();
      return;
    }
    if (queue) {
      this.ctx.toast('You are already in a matchmaking queue — cancel it first.');
      return;
    }
    const sel = this.selection.planet;
    if (sel && sel.ring === this.myRing() && this.planetAvailable(sel)) {
      this.startRanked(sel);
      return;
    }
    const target = this.autoTargetPlanet();
    if (!target) {
      this.ctx.toast('No open planet in your ring right now — try again in a moment.');
      return;
    }
    this.jumpTo(target);
    this.startRanked(target);
  }

  private autoTargetPlanet(): PlanetDescriptor | null {
    const ring = this.myRing();
    const home = ringHome(this.universeSeed(), ring);
    const g = galaxyAt(this.universeSeed(), home.gx, home.gy);
    if (!g) return null;
    return nearestAvailablePlanet(this.universeSeed(), ring, g.galaxyId, 0, 0, g.systemCount, (cand) => this.planetAvailable(cand));
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
    // the band the CAMERA is browsing — the rail highlight + the canvas band label
    const current = this.map.viewedRing;
    // Only rebuild when the highlighting would change — a rebuild restarted the
    // "your ring" pulse mid-beat on every data tick.
    const sig = `${myRing}|${current}`;
    if (sig === this.railSig) return;
    this.railSig = sig;
    this.railEl.innerHTML = '';
    RING_CONFIGS.forEach((cfg) => {
      const chip = el('button', `rk-ring${cfg.tier === myRing ? ' mine' : ''}${current === cfg.tier ? ' here' : ''}`);
      (chip as HTMLButtonElement).type = 'button';
      chip.style.setProperty('--rk-accent', cfg.accent);
      // the band you are LOOKING AT says its own name ("BRONZE BAND"); the rest keep
      // their ability hint — "YOUR RING" text is gone (user ask)
      const note = current === cfg.tier ? `${cfg.name} BAND` : cfg.abilityHint;
      chip.innerHTML = `<span class="rk-ring-name">${cfg.name}</span><span class="rk-ring-note">${note}</span>`;
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
    const sig = parts.join('›');
    if (sig === this.crumbSig) return;
    this.crumbSig = sig;
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
    // ONE discovery scope on screen (plan §43) — the selected location, else the
    // camera focus. Discovery is EARNED IN MATCHES (AppShell records it); the panel
    // only reads what the server sent back (plan §6).
    this.focusDiscoveryScope(sel);
    this.renderRail();
    this.renderBreadcrumb();
    this.renderSide();
    this.renderMapInfo();
    const loc = sel.selected;
    const planet = loc?.planet ?? sel.planet;
    if (planet) {
      subscribePlanetDetail(planet.key);
      // Ownership/history rows must be subscribed even when the planet was selected
      // before its galaxy was (deep links, programmatic jumps).
      if (!this.subscribedGalaxies.has(planet.galaxyId)) {
        this.subscribedGalaxies.add(planet.galaxyId);
        subscribeRankGalaxy(planet.galaxyId);
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
      this.countdownSig = ''; // a rebuilt panel always writes its countdown once
      return;
    }
    // Tick-only pass (plan §15): recompute the displayed second and only touch the
    // DOM when the TEXT changes — the page never re-renders its tree for a clock.
    const cd = this.side.querySelector<HTMLElement>('[data-countdown]');
    if (!cd) return;
    const target = this.panelPlanet();
    if (!target) return;
    const row = this.planetRow(target.key);
    if (!row || row.state !== RANKED_PLANET_CONTROLLED || Number(row.controlExpiresAt) <= 0) return;
    const text = shieldCountdownText(Number(row.controlExpiresAt), this.serverNowUs());
    if (text === this.countdownSig) return;
    this.countdownSig = text;
    cd.textContent = text;
    cd.classList.toggle('fallen', text === 'PLANETARY SHIELD FALLEN');
  }

  /** The planet the panel currently shows: explicit selection first, then focus. */
  private panelPlanet(): PlanetDescriptor | null {
    return this.selection.selected?.planet ?? this.selection.planet;
  }

  private panelSignature(): string {
    const sel = this.selection;
    const loc = sel.selected;
    const planet = loc?.planet ?? sel.planet;
    if (planet) {
      const row = this.planetRow(planet.key);
      const discoveries = this.discoveriesForPlanet(planet.key).length;
      const queue = ClientCache.shared.myQueue();
      const place = loc ? 'sel' : 'focus';
      return `p:${place}:${planet.key}:${row?.state ?? -1}:${row?.controllingColony ?? -1}:${row?.discovered ? 1 : 0}:${discoveries}:${queue?.ranked ? queue.planetKey : ''}:${this.availableSig(planet)}`;
    }
    const sys = loc?.system ?? sel.system;
    if (sys) {
      const place = loc ? 'sel' : 'focus';
      const discoveries = this.discoveriesForSystem(sys.galaxyId, sys.systemId).length;
      return `s:${place}:${sys.galaxyId}:${sys.systemId}:${this.rowsForGalaxy(sys.galaxyId).length}:${discoveries}`;
    }
    const galaxy = loc?.galaxy ?? sel.galaxy;
    if (galaxy) {
      const place = loc ? 'sel' : 'focus';
      const discoveries = this.discoveriesForGalaxy(galaxy.galaxyId).length;
      return `g:${place}:${galaxy.galaxyId}:${this.rowsForGalaxy(galaxy.galaxyId).length}:${discoveries}`;
    }
    return `root:${this.myStars()}`;
  }

  private availableSig(p: PlanetDescriptor): number {
    return this.planetAvailable(p) ? 1 : 0;
  }

  private buildPanel(): HTMLElement {
    const sel = this.selection;
    const loc = sel.selected;
    // The SELECTION owns the panel (plan §71); the camera focus is only the
    // fallback so a zoomed-in tier still explains itself while nothing is tapped.
    const planet = loc?.planet ?? sel.planet;
    if (planet) return buildPlanetPanel(planet, this.panelHost);
    const sys = loc?.system ?? sel.system;
    if (sys) return buildSystemPanel(sys, this.panelHost);
    const galaxy = loc?.galaxy ?? sel.galaxy;
    if (galaxy) return buildGalaxyPanel(galaxy, this.panelHost);
    return buildRootPanel(this.panelHost, { galaxy: sel.galaxy, system: sel.system });
  }

  /**
   * The panel's data + action surface (plan §71): the LocationInfoPanel module
   * owns the markup, this page owns the server data and the navigation actions.
   */
  private buildPanelHost(): LocationPanelHost {
    return {
      universeSeed: () => this.universeSeed(),
      myRing: () => this.myRing(),
      myStars: () => this.myStars(),
      serverNowUs: () => this.serverNowUs(),
      rowsForGalaxy: (galaxyId) => this.rowsForGalaxy(galaxyId),
      planetRow: (key) => this.planetRow(key),
      reservedKeys: () => ClientCache.shared.reservedPlanetKeys(),
      discoveriesForGalaxy: (galaxyId) => this.discoveriesForGalaxy(galaxyId),
      discoveriesForSystem: (galaxyId, systemId) => this.discoveriesForSystem(galaxyId, systemId),
      discoveriesForPlanet: (planetKey) => this.discoveriesForPlanet(planetKey),
      planetAvailable: (p) => this.planetAvailable(p),
      planetsOf: (sys) => this.planetsOf(sys),
      currentGalaxyFor: (loc) => {
        const { gx, gy } = decodeGalaxyId(loc.galaxyId);
        return galaxyAt(this.universeSeed(), gx, gy);
      },
      systemFor: (p) => {
        const { gx, gy } = decodeGalaxyId(p.galaxyId);
        const g = galaxyAt(this.universeSeed(), gx, gy);
        return g ? systemAt(this.universeSeed(), p.ring, p.galaxyId, p.systemId, g.systemCount) : null;
      },
      myQueue: () => ClientCache.shared.myQueue(),
      selectPlanet: (p) => this.map.selectPlanet(p),
      startRanked: (p) => this.startRanked(p),
      jumpTo: (p) => this.jumpTo(p),
      findAnother: (p) => this.findAnother(p),
      goQueue: () => this.ctx.goQueue(),
      flyToRing: (ring) => this.map.flyToRing(ring),
    };
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
    const sys = systemAt(this.universeSeed(), p.ring, p.galaxyId, p.systemId, g?.systemCount ?? 200);
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
      this.renderColony();
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
