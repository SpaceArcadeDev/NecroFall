// NECROFALL — the INTERGALACTIC MAP (plan §44/§46/§47/§75). One canvas, three
// zoom levels (GALACTIC → GALAXY → SYSTEM → PLANET detail is the DOM panel's
// job), GPU-cheap sprites instead of per-frame gradient objects, and real
// animation: twinkling starfield, drifting nebulae, orbiting planets, pulsing
// selections and countdown shield arcs.
//
// The map is VIEW-ONLY: nothing here decides availability or ownership — rows
// come from the server subscription, everything else is regenerated from the
// season seed (plan §0).
import { GalaxyDescriptor, PlanetDescriptor, SystemDescriptor } from './procedural/GalaxyTypes';
import { planetsInSystem, ringHome } from './procedural/UniverseGenerator';
import { galaxyAt } from './procedural/GalaxyGenerator';
import { systemAt, systemsInGalaxy } from './procedural/SolarSystemGenerator';
import { systemPlanetCount } from './procedural/SolarSystemGenerator';
import { ringConfig } from './procedural/RankRingConfig';
import { RING_WIDTH_CELLS } from './procedural/SeedHash';

export const RANKED_PLANET_INFESTED = 0;
export const RANKED_PLANET_CONTROLLED = 1;
export const COLONY_NONE = 255;

/** Server-mirrored planet row (only player-relevant planets have one). */
export interface PlanetRowData {
  planetKey: string;
  ring: number;
  galaxyId: number;
  systemId: number;
  planetId: number;
  state: number;
  colony: number;
  controlExpiresAt: number;
  discovered: boolean;
}

export interface MapData {
  universeSeed: number;
  myRing: number;
  colonyNames: string[];
  colonyColors: string[];
  rowsForGalaxy(galaxyId: number): PlanetRowData[];
  reservedKeys(): Set<string>;
  serverNowUs(): number;
}

export type MapLevel = 'galactic' | 'galaxy' | 'system';

export interface MapSelection {
  level: MapLevel;
  galaxy: GalaxyDescriptor | null;
  system: SystemDescriptor | null;
  planet: PlanetDescriptor | null;
}

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/** Scripted camera flight. `zoom` is OPTIONAL: seamless-zoom transitions recentre
 *  WITHOUT touching zoom, so an active pinch/wheel keeps owning the scale. */
interface CameraTarget {
  x: number;
  y: number;
  zoom?: number;
}

/** World zoom bands where each tier fades in — see `zoomRamps()`. */
interface ZoomRanges {
  gal: number;
  sysStart: number;
  sysEnd: number;
  plStart: number;
  plEnd: number;
}

/** The live soft-lock: what the crosshair is aiming at, tier by tier, plus how far
 *  each tier has faded in. Rendering AND the DOM panel read this — no hard cuts. */
interface LockState {
  galaxy: GalaxyDescriptor | null;
  system: SystemDescriptor | null;
  planet: PlanetDescriptor | null;
  sysAlpha: number;
  planetAlpha: number;
  ranges: ZoomRanges;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const ramp01 = (v: number, a: number, b: number): number => clamp01((v - a) / Math.max(1e-6, b - a));

const GAL_DISC_WORLD = 3.0; // galaxy disc diameter in world units
const SYSTEM_SCALE = 0.62; // system local (unit) space → world units
/** Below this body radius a galaxy is a plain mote — at intergalactic zoom there can
 *  be thousands on screen and a soft shaped sprite each would cost real fill-rate. */
const GALAXY_DOT_RADIUS = 4.2;

interface Hover {
  kind: 'galaxy' | 'system' | 'planet' | null;
  galaxy?: GalaxyDescriptor;
  system?: SystemDescriptor;
  planet?: PlanetDescriptor;
  sx: number;
  sy: number;
}

export class GalacticMap {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private cam: Camera = { x: 0, y: 0, zoom: 26 };
  private camTarget: CameraTarget | null = null;
  private level: MapLevel = 'galactic';
  private focusGalaxy: GalaxyDescriptor | null = null;
  private focusSystem: SystemDescriptor | null = null;
  private selectedPlanet: PlanetDescriptor | null = null;
  private selectedSystem: SystemDescriptor | null = null;
  private hover: Hover = { kind: null, sx: 0, sy: 0 };
  private stars: { x: number; y: number; r: number; seed: number; layer: number }[] = [];
  private shooting: { x: number; y: number; vx: number; vy: number; life: number } | null = null;
  private nextShooting = 0;
  private glowCache = new Map<string, HTMLCanvasElement>();
  /** Memoised galaxy lattice: one generator call per cell, EVER (far views sweep thousands). */
  private galaxyMemo = new Map<number, GalaxyDescriptor | null>();
  /** Per-galaxy seeded face sprites (spiral / elliptical / irregular), baked once. */
  private galaxySprites = new Map<number, HTMLCanvasElement>();
  private raf = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;
  private drag: { x: number; y: number; camx: number; camy: number; moved: boolean } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; zoom: number } | null = null;
  private t0 = performance.now();

  constructor(
    private host: HTMLElement,
    private data: MapData,
    private onSelect: (sel: MapSelection) => void,
    private onHoverChange?: (hover: { kind: string; label: string; sub: string; x: number; y: number } | null) => void
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'rk-map-canvas';
    this.host.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    this.ctx = ctx;
    this.buildStarfield();
    this.bindEvents();
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    // Fly home AFTER the constructing page has assigned its own reference to us —
    // `flyToRing` announces through `onSelect`, and a callback burst mid-constructor
    // would reach a page whose `this.map` is still undefined.
    queueMicrotask(() => {
      if (!this.disposed) this.centerOnHome();
    });
    const loop = (now: number): void => {
      if (this.disposed) return;
      this.step(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.canvas.remove();
  }

  // ------------------------------------------------------------ public API

  setData(_data?: MapData): void {
    /* data is read live through the provider each frame */
  }

  /** Fly the camera to a ring's anchor galaxy ("YOUR RING" / ring rail). */
  flyToRing(ring: number): void {
    const home = ringHome(this.data.universeSeed, ring);
    this.level = 'galactic';
    this.focusGalaxy = null;
    this.focusSystem = null;
    this.selectedSystem = null;
    this.selectedPlanet = null;
    this.camTarget = { x: home.gx, y: home.gy, zoom: this.ringViewZoom(ring) };
    this.onSelect({ level: 'galactic', galaxy: null, system: null, planet: null });
  }

  centerOnHome(): void {
    this.flyToRing(this.data.myRing);
  }

  /** Open a galaxy by coordinates (breadcrumb / external links). */
  openGalaxy(g: GalaxyDescriptor): void {
    this.flyToGalaxy(g);
  }

  get currentLevel(): MapLevel {
    return this.level;
  }

  get currentGalaxy(): GalaxyDescriptor | null {
    return this.focusGalaxy;
  }

  get currentSystem(): SystemDescriptor | null {
    return this.focusSystem;
  }

  back(): void {
    const ranges = this.zoomRamps();
    if (this.level === 'system') {
      // Ease back out toward the galaxy tier — the soft-focus pass unwinds the
      // levels on its own as the ramps collapse (no hard reset, no jump).
      this.camTarget = { x: this.cam.x, y: this.cam.y, zoom: Math.max(6, ranges.plStart * 0.62) };
      this.selectedPlanet = null;
    } else if (this.level === 'galaxy') {
      const left = this.focusGalaxy;
      this.camTarget = left
        ? { x: left.gx, y: left.gy, zoom: Math.max(4, Math.min(ranges.sysStart * 0.62, this.ringViewZoom(left.ring))) }
        : { x: this.cam.x, y: this.cam.y, zoom: Math.max(4, ranges.sysStart * 0.62) };
    }
  }

  selectPlanet(p: PlanetDescriptor | null): void {
    this.selectedPlanet = p;
    this.onSelect({ level: this.level, galaxy: this.focusGalaxy, system: this.focusSystem, planet: p });
  }

  /** Does an availability predicate say this planet could host a ranked match? */
  planetAvailable(p: PlanetDescriptor): boolean {
    const rows = this.data.rowsForGalaxy(p.galaxyId);
    const row = rows.find((r) => r.planetKey === p.key);
    if (row && row.state === RANKED_PLANET_CONTROLLED) return false;
    if (this.data.reservedKeys().has(p.key)) return false;
    return true;
  }

  // ------------------------------------------------------------ galaxy field

  /** Memoised lattice lookup — the far zoom-out sweeps tens of thousands of cells. */
  private galaxyAtCached(gx: number, gy: number): GalaxyDescriptor | null {
    const key = ((gx + 8192) << 14) | (gy + 8192);
    let hit = this.galaxyMemo.get(key);
    if (hit !== undefined) return hit;
    hit = galaxyAt(this.data.universeSeed, gx, gy);
    this.galaxyMemo.set(key, hit);
    return hit;
  }

  /** Screen radius of a galaxy's body — ONE formula for drawing AND hit-testing. */
  private galaxyScreenRadius(g: GalaxyDescriptor): number {
    return Math.max(3, g.radius * 0.012 * this.cam.zoom);
  }

  /**
   * A galaxy's OWN face, generated once from its seed (user ask 2026-09-28): four
   * body plans — spiral, barred spiral, elliptical, irregular — so no two are the
   * same smudge. Baked into a cached sprite (rotation included), so drawing stays
   * a plain `drawImage`.
   */
  private galaxySprite(g: GalaxyDescriptor): HTMLCanvasElement {
    const hit = this.galaxySprites.get(g.galaxyId);
    if (hit) return hit;
    const size = 160;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    if (ctx) {
      const cx = size / 2;
      const cy = size / 2;
      let a = (g.seed ^ 0x9e3779b9) >>> 0;
      const rnd = (): number => {
        a = (a * 1664525 + 1013904223) >>> 0;
        return a / 4294967296;
      };
      const haze = g.nebulaColor ?? g.starColor;
      const kind = (g.seed >>> 3) % 6;
      const rot = rnd() * Math.PI * 2;
      const squash = 0.72 + rnd() * 0.24;
      // halo — stacked soft discs (no rgba strings needed)
      for (let i = 10; i >= 1; i--) {
        ctx.globalAlpha = 0.026;
        ctx.fillStyle = haze;
        ctx.beginPath();
        ctx.arc(cx, cy, (size / 2) * (i / 10) * 0.92, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (kind === 0 || kind === 1) {
        // spiral / barred spiral — tapered motes along 2-4 arms
        const arms = kind === 1 ? 2 : 2 + Math.floor(rnd() * 3);
        const spin = 2.1 + rnd() * 1.1;
        const barLen = kind === 1 ? 8 + rnd() * 9 : 0;
        if (barLen) {
          ctx.globalAlpha = 0.4;
          ctx.fillStyle = haze;
          ctx.beginPath();
          ctx.ellipse(cx, cy, barLen, barLen * 0.3, rot, 0, Math.PI * 2);
          ctx.fill();
        }
        for (let arm = 0; arm < arms; arm++) {
          const base = rot + (arm / arms) * Math.PI * 2;
          for (let step = 1; step <= 26; step++) {
            const tt = step / 26;
            if (barLen && tt < 0.22) continue;
            const ang = base + tt * spin;
            const r = 6 + tt * size * 0.38;
            const x = Math.cos(ang) * r;
            const y = Math.sin(ang) * r * squash;
            ctx.globalAlpha = 0.14 + 0.34 * (1 - tt);
            ctx.fillStyle = tt < 0.6 ? '#ffffff' : haze;
            ctx.beginPath();
            ctx.arc(cx + x, cy + y, 9.5 * (1 - tt * 0.62) + 1.4, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      } else if (kind === 2) {
        // elliptical — a tilted, dustless disc
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rot);
        ctx.scale(1, squash);
        for (let i = 6; i >= 1; i--) {
          ctx.globalAlpha = 0.1 + (6 - i) * 0.075;
          ctx.fillStyle = haze;
          ctx.beginPath();
          ctx.arc(0, 0, 12 + i * 7.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (kind === 4) {
        // ring galaxy — a bright annulus around a small core, the odd spoke
        const rr = size * (0.28 + rnd() * 0.08);
        const n = 22 + Math.floor(rnd() * 10);
        for (let i = 0; i < n; i++) {
          const ang = (i / n) * Math.PI * 2 + rnd() * 0.08;
          const jitter = (rnd() - 0.5) * 6;
          ctx.globalAlpha = 0.16 + rnd() * 0.22;
          ctx.fillStyle = haze;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(ang) * (rr + jitter), cy + Math.sin(ang) * (rr + jitter) * squash, 2.6 + rnd() * 5, 0, Math.PI * 2);
          ctx.fill();
        }
        for (let i = 0; i < 2; i++) {
          const ang = rnd() * Math.PI * 2;
          ctx.globalAlpha = 0.12;
          ctx.strokeStyle = haze;
          ctx.lineWidth = 2.4;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr * squash);
          ctx.stroke();
        }
      } else if (kind === 5) {
        // flocculent — patchy knots rather than clean arms
        const patchN = 14 + Math.floor(rnd() * 8);
        for (let i = 0; i < patchN; i++) {
          const ang = rnd() * Math.PI * 2;
          const r = Math.pow(rnd(), 0.6) * size * 0.36;
          const x = Math.cos(ang) * r;
          const y = Math.sin(ang) * r * squash;
          const knots = 2 + Math.floor(rnd() * 4);
          for (let k = 0; k < knots; k++) {
            ctx.globalAlpha = 0.1 + rnd() * 0.22;
            ctx.fillStyle = rnd() < 0.3 ? '#ffffff' : haze;
            ctx.beginPath();
            ctx.arc(cx + x + (rnd() - 0.5) * 9, cy + y + (rnd() - 0.5) * 9, 1.6 + rnd() * 3.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      } else {
        // irregular — a scatter of motes with the odd bright knot
        const n = 9 + Math.floor(rnd() * 7);
        for (let i = 0; i < n; i++) {
          const ang = rnd() * Math.PI * 2;
          const r = Math.pow(rnd(), 0.7) * size * 0.36;
          ctx.globalAlpha = 0.14 + rnd() * 0.3;
          ctx.fillStyle = haze;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r * squash, 3.2 + rnd() * 7.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // core — every galaxy keeps its star's own colour
      for (let i = 5; i >= 1; i--) {
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = g.starColor;
        ctx.beginPath();
        ctx.arc(cx, cy, 3 + i * 3.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy, 3.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (this.galaxySprites.size > 320) this.galaxySprites.clear();
    this.galaxySprites.set(g.galaxyId, c);
    return c;
  }

  // ------------------------------------------------------------ soft focus (continuous zoom)

  /** The live soft-lock (rendered every frame; also drives the DOM tier). */
  private lock: LockState = {
    galaxy: null,
    system: null,
    planet: null,
    sysAlpha: 0,
    planetAlpha: 0,
    ranges: { gal: 40, sysStart: 41, sysEnd: 110, plStart: 200, plEnd: 450 },
  };

  /**
   * Tier ramps (user: "no sudden transitions — just like No Man's Sky"): each tier
   * fades in over a zoom RANGE instead of switching at a line. Everything is derived
   * from the canvas' own framing zooms, so a tiny squircle map and a fullscreen map
   * reveal the same way, just sooner or later in absolute zoom terms.
   */
  private zoomRamps(): ZoomRanges {
    const gal = this.fitZoom(GAL_DISC_WORLD * 2.4);
    const sysStart = gal * 1.02;
    const sysEnd = Math.max(sysStart + 18, Math.min(gal * 2.6, 280));
    const zSys = this.fitZoom(SYSTEM_SCALE * 2.5);
    const plStart = Math.min(Math.max(zSys * 1.1, sysEnd + 12), 320);
    // the planet reveal lands sooner (1.6× headroom, capped) so full bodies with
    // names are reached with room left in the zoom — "zoom in and VIEW the planets"
    const plEnd = Math.min(Math.max(zSys * 1.6, plStart + 30), 520);
    return { gal, sysStart, sysEnd, plStart, plEnd };
  }

  private nearestGalaxyToViewCentre(): GalaxyDescriptor | null {
    const c = this.screen2world(this.width / 2, this.height / 2);
    const gx = Math.round(c.x);
    const gy = Math.round(c.y);
    let best: GalaxyDescriptor | null = null;
    let bestD = Infinity;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const g = this.galaxyAtCached(gx + dx, gy + dy);
        if (!g) continue;
        const d = (g.gx - c.x) ** 2 + (g.gy - c.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = g;
        }
      }
    }
    return best;
  }

  private nearestSystemToViewCentre(g: GalaxyDescriptor): SystemDescriptor | null {
    const c = this.screen2world(this.width / 2, this.height / 2);
    let best: SystemDescriptor | null = null;
    let bestD = Infinity;
    for (const sys of this.systemsFor(g)) {
      const w = this.systemWorldPos(g, sys);
      const d = (w.x - c.x) ** 2 + (w.y - c.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = sys;
      }
    }
    return best;
  }

  private nearestPlanetToViewCentre(g: GalaxyDescriptor, sys: SystemDescriptor): PlanetDescriptor | null {
    const t = (performance.now() - this.t0) / 1000;
    let best: PlanetDescriptor | null = null;
    let bestD = Infinity;
    for (const p of this.planetsFor(sys)) {
      const c = this.planetScreenCircle(g, sys, p, t);
      const d = (c.x - this.width / 2) ** 2 + (c.y - this.height / 2) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /** Where a planet sits on screen right now (orbit animation included). */
  private planetScreenCircle(g: GalaxyDescriptor, sys: SystemDescriptor, p: PlanetDescriptor, t: number): { x: number; y: number; r: number } {
    const sw = this.systemWorldPos(g, sys);
    const centre = this.world2screen(sw.x, sw.y);
    const speed = 0.05 / (0.4 + p.orbitRadius);
    const angle = p.orbit + t * speed;
    const orbitR = p.orbitRadius * SYSTEM_SCALE * this.cam.zoom;
    return {
      x: centre.x + Math.cos(angle) * orbitR,
      y: centre.y + Math.sin(angle) * orbitR * 0.86,
      // bodies grow to the old system-view scale (radius·16) well before max zoom
      r: Math.max(2.6, p.radius * Math.min(16, this.cam.zoom * 0.05)),
    };
  }

  /**
   * Continuous soft focus — runs EVERY frame, flights included (the progressive
   * reveal is the point). Computes the lock, then moves the DOM-facing tier only
   * once a ramp has genuinely crossed (enter/exit marks differ so the PANEL can
   * never flicker on a boundary). Deep zoom softly selects the planet at the
   * crosshair — that is what makes "zoom in to play it" feel seamless.
   */
  private updateSoftFocus(): void {
    const zoom = this.cam.zoom;
    const ranges = this.zoomRamps();
    const galaxy = this.nearestGalaxyToViewCentre();
    const sysAlpha = ramp01(zoom, ranges.sysStart, ranges.sysEnd);
    const system = galaxy && sysAlpha > 0.04 ? this.nearestSystemToViewCentre(galaxy) : null;
    const planetAlpha = ramp01(zoom, ranges.plStart, ranges.plEnd);
    const planet = galaxy && system && planetAlpha > 0.08 ? this.nearestPlanetToViewCentre(galaxy, system) : null;
    this.lock = { galaxy, system, planet, sysAlpha, planetAlpha, ranges };

    const enterGalaxyAt = this.level === 'galactic' ? 0.5 : 0.34;
    const enterSystemAt = this.level === 'system' ? 0.4 : 0.52;
    let next: MapLevel = 'galactic';
    if (sysAlpha >= enterGalaxyAt) next = 'galaxy';
    if (next === 'galaxy' && planetAlpha >= enterSystemAt) next = 'system';
    const galaxyChanged = (galaxy?.galaxyId ?? -1) !== (this.focusGalaxy?.galaxyId ?? -1);
    const systemChanged = (system?.systemId ?? -1) !== (this.focusSystem?.systemId ?? -1);
    if (next !== this.level || (next === 'galaxy' && galaxyChanged) || (next === 'system' && (galaxyChanged || systemChanged))) {
      this.level = next;
      this.focusGalaxy = next === 'galactic' ? null : galaxy;
      this.focusSystem = next === 'system' ? system : null;
      if (next === 'galactic') {
        this.selectedSystem = null;
        this.selectedPlanet = null;
      }
      // a selected planet only survives while its OWN system is the focus
      if (this.selectedPlanet && this.focusSystem && this.selectedPlanet.systemId !== this.focusSystem.systemId) {
        this.selectedPlanet = null;
      }
      // RECENTRE on the tier we just entered (user: "I'm not able to zoom into the
      // solar system"): the locked galaxy/system glides under the crosshair as the
      // ramps deepen, so its systems/planets come INTO VIEW instead of drifting off.
      // Never while the user is actively panning — that gesture owns the centre.
      if (next !== 'galactic' && galaxy && !this.drag) {
        const w = next === 'system' && system ? this.systemWorldPos(galaxy, system) : { x: galaxy.gx, y: galaxy.gy };
        const onScreen = this.world2screen(w.x, w.y);
        if (Math.abs(onScreen.x - this.width / 2) > 12 || Math.abs(onScreen.y - this.height / 2) > 12) {
          this.camTarget = { x: w.x, y: w.y };
        }
      }
      this.onSelect({ level: next, galaxy: this.focusGalaxy, system: this.focusSystem, planet: this.selectedPlanet });
    }
    if (planet && planetAlpha > 0.72 && this.selectedPlanet?.key !== planet.key) this.selectPlanet(planet);
  }

  // ------------------------------------------------------------ sizing & camera

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(200, rect.width);
    this.height = Math.max(200, rect.height);
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  private fitZoom(worldSpan: number): number {
    return Math.min(this.width, this.height) / (worldSpan * 1.05);
  }

  /**
   * Zoom that frames the WHOLE ring band (plan §47). The band is a disc whose outer
   * radius is (ring+1)·RING_WIDTH_CELLS world cells, so the old fixed `fitZoom(2.6)`
   * filled the entire map with a single galaxy's glow — on a phone canvas it read as
   * one giant blob (user report 2026-09-28). The clamp keeps ring 0 readable and stops
   * the widest bands from hitting the 4× floor with the home anchor outside the frame.
   */
  private ringViewZoom(ring: number): number {
    const span = Math.max(14, (ring + 1) * RING_WIDTH_CELLS * 2.5);
    return Math.max(4, Math.min(42, this.fitZoom(span)));
  }

  private world2screen(x: number, y: number): { x: number; y: number } {
    return {
      x: (x - this.cam.x) * this.cam.zoom + this.width / 2,
      y: (y - this.cam.y) * this.cam.zoom + this.height / 2,
    };
  }

  private screen2world(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.width / 2) / this.cam.zoom + this.cam.x,
      y: (sy - this.height / 2) / this.cam.zoom + this.cam.y,
    };
  }

  private flyToGalaxy(g: GalaxyDescriptor, keepZoom = false): void {
    const ranges = this.zoomRamps();
    // land INSIDE the galaxy tier (ramp 80%), so a click really opens the systems
    const into = ranges.sysStart + (ranges.sysEnd - ranges.sysStart) * 0.8;
    this.camTarget = keepZoom ? { x: g.gx, y: g.gy } : { x: g.gx, y: g.gy, zoom: Math.max(this.cam.zoom, into) };
  }

  private flyToSystem(g: GalaxyDescriptor, sys: SystemDescriptor): void {
    const ranges = this.zoomRamps();
    const wx = g.gx + (sys.ux - 0.5) * GAL_DISC_WORLD;
    const wy = g.gy + (sys.uy - 0.5) * GAL_DISC_WORLD;
    // land where the planets are fully open (ramp 85% of the planet band)
    const into = ranges.plStart + (ranges.plEnd - ranges.plStart) * 0.85;
    this.camTarget = { x: wx, y: wy, zoom: Math.max(this.cam.zoom, into) };
  }

  // ------------------------------------------------------------ animation

  private step(now: number): void {
    const t = (now - this.t0) / 1000;
    if (this.camTarget) {
      const k = 1 - Math.pow(0.0016, 1 / 60);
      const target = this.camTarget;
      this.cam.x += (target.x - this.cam.x) * k;
      this.cam.y += (target.y - this.cam.y) * k;
      if (target.zoom !== undefined) this.cam.zoom += (target.zoom - this.cam.zoom) * k;
      const settledXY = Math.abs(target.x - this.cam.x) < 0.002 && Math.abs(target.y - this.cam.y) < 0.002;
      const settledZ = target.zoom === undefined || Math.abs(target.zoom - this.cam.zoom) < 0.01;
      if (settledXY && settledZ) {
        this.cam.x = target.x;
        this.cam.y = target.y;
        if (target.zoom !== undefined) this.cam.zoom = target.zoom;
        this.camTarget = null;
      }
    }
    // Seamless soft zoom: tier ramps decide what is visible, and the DOM tier
    // follows them — pinch, wheel and the ± buttons all flow through here.
    this.updateSoftFocus();
    this.draw(t);
  }

  private draw(t: number): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // deep-space backdrop
    const bg = ctx.createLinearGradient(0, 0, 0, this.height);
    bg.addColorStop(0, '#05030c');
    bg.addColorStop(0.55, '#0a0617');
    bg.addColorStop(1, '#120a24');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.width, this.height);

    this.drawStarfield(t);
    // ---- ONE continuous scene, No Man's Sky-style: every tier is always drawn, its
    // own alpha ramp decides how visibly. No level ever hard-switches the frame.
    const lock = this.lock;
    const deep = Math.max(lock.sysAlpha, lock.planetAlpha);
    this.drawRings(deep);
    this.drawGalaxyField(t, deep);
    this.drawSystemsLayer(t);
    this.drawPlanetsLayer(t);
    this.drawHomeMarker(t);
    this.drawLockReticle(t);
    this.drawShootingStar(t);
  }

  private buildStarfield(): void {
    const rnd = (() => {
      let a = 1234567;
      return () => {
        a = (a * 1103515245 + 12345) & 0x7fffffff;
        return a / 0x7fffffff;
      };
    })();
    for (let i = 0; i < 260; i++) {
      this.stars.push({ x: rnd(), y: rnd(), r: 0.4 + rnd() * 1.3, seed: rnd() * Math.PI * 2, layer: rnd() });
    }
  }

  private drawStarfield(t: number): void {
    const ctx = this.ctx;
    const px = -this.cam.x * 2.2;
    const py = -this.cam.y * 2.2;
    for (const s of this.stars) {
      const twinkle = 0.55 + 0.45 * Math.sin(t * (0.6 + s.layer) + s.seed);
      const x = ((s.x * this.width + px * (0.3 + s.layer)) % (this.width + 40) + this.width + 40) % (this.width + 40) - 20;
      const y = ((s.y * this.height + py * (0.3 + s.layer)) % (this.height + 40) + this.height + 40) % (this.height + 40) - 20;
      ctx.globalAlpha = 0.25 + s.layer * 0.5 * twinkle;
      ctx.fillStyle = s.layer > 0.8 ? '#cfe3ff' : s.layer > 0.5 ? '#9fb6ff' : '#7f8fd8';
      ctx.beginPath();
      ctx.arc(x, y, s.r * (0.7 + twinkle * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawShootingStar(t: number): void {
    const ctx = this.ctx;
    if (!this.shooting && t > this.nextShooting) {
      this.nextShooting = t + 6 + Math.random() * 10;
      const fromLeft = Math.random() < 0.5;
      this.shooting = {
        x: fromLeft ? -20 : this.width + 20,
        y: Math.random() * this.height * 0.5,
        vx: (fromLeft ? 1 : -1) * (280 + Math.random() * 220),
        vy: 90 + Math.random() * 80,
        life: 1.4,
      };
    }
    const s = this.shooting;
    if (!s) return;
    s.x += s.vx / 60;
    s.y += s.vy / 60;
    s.life -= 1 / 60;
    if (s.life <= 0) {
      this.shooting = null;
      return;
    }
    const grad = ctx.createLinearGradient(s.x - s.vx * 0.12, s.y - s.vy * 0.12, s.x, s.y);
    grad.addColorStop(0, 'rgba(160,180,255,0)');
    grad.addColorStop(1, 'rgba(220,232,255,0.9)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(s.x - s.vx * 0.12, s.y - s.vy * 0.12);
    ctx.lineTo(s.x, s.y);
    ctx.stroke();
  }

  /** Cached radial-glow sprite (per color) — one gradient per color, ever. */
  private glow(color: string, size = 64): HTMLCanvasElement {
    const key = `${color}:${size}`;
    const hit = this.glowCache.get(key);
    if (hit) return hit;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    if (g) {
      const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, color);
      grad.addColorStop(0.35, `${color}88`);
      grad.addColorStop(1, `${color}00`);
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
    }
    this.glowCache.set(key, c);
    return c;
  }

  /** Ring bands — the map's permanent background structure. `deep` fades them as the
   *  camera enters a galaxy so the close-up isn't fighting a wall of circles. */
  private drawRings(deep: number): void {
    const ctx = this.ctx;
    const cfg = ringConfig(this.data.myRing);
    const fade = 1 - deep * 0.85;
    for (let ring = 7; ring >= 0; ring--) {
      const rc = ringConfig(ring);
      const inner = ring * RING_WIDTH_CELLS;
      const outer = (ring + 1) * RING_WIDTH_CELLS;
      const p0 = this.world2screen(0, 0);
      const rIn = inner * this.cam.zoom;
      const rOut = outer * this.cam.zoom;
      if (rOut < 30 || p0.x < -this.width || p0.x > this.width * 2) continue;
      ctx.save();
      ctx.beginPath();
      ctx.arc(p0.x, p0.y, rOut, 0, Math.PI * 2);
      ctx.arc(p0.x, p0.y, rIn, 0, Math.PI * 2, true);
      ctx.globalAlpha = (ring === this.data.myRing ? 0.16 : 0.05 + ring * 0.004) * fade;
      ctx.fillStyle = rc.accent;
      ctx.fill('evenodd');
      ctx.restore();
      ctx.globalAlpha = (ring === this.data.myRing ? 0.35 : 0.12) * fade;
      ctx.strokeStyle = rc.accent;
      ctx.lineWidth = ring === this.data.myRing ? 1.6 : 1;
      ctx.beginPath();
      ctx.arc(p0.x, p0.y, rOut, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // label for the player's ring at the top of its band
    const p0 = this.world2screen(0, 0);
    const rMid = (this.data.myRing * RING_WIDTH_CELLS + RING_WIDTH_CELLS / 2) * this.cam.zoom;
    ctx.font = '700 11px Rajdhani, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = cfg.accent;
    ctx.globalAlpha = 0.85 * fade;
    const ly = Math.max(24, p0.y - rMid);
    ctx.fillText(`${cfg.name} BAND — YOUR RING`, p0.x, ly);
    ctx.globalAlpha = 1;
  }

  /**
   * The galaxy field: swept from the MEMOISED lattice (one generator call per cell,
   * ever). Far galaxies are plain motes, near ones wear their seeded faces, and names
   * only emerge — sized WITH the body — once it is genuinely big on screen (user:
   * "no need to show names, should be smaller until I zoom in").
   */
  private drawGalaxyField(t: number, deep: number): void {
    const ctx = this.ctx;
    const zoom = this.cam.zoom;
    const field = 1 - deep * 0.45;
    const pad = 60 / this.cam.zoom;
    const minW = this.screen2world(-pad, -pad);
    const maxW = this.screen2world(this.width + pad, this.height + pad);
    // at the widest frames every galaxy is a mote: sweep one row in two
    const stride = zoom < 9 ? 2 : 1;
    const gy0 = Math.floor(minW.y / stride) * stride;
    const gy1 = Math.ceil(maxW.y);
    const gx0 = Math.floor(minW.x);
    const gx1 = Math.ceil(maxW.x);
    for (let gy = gy0; gy <= gy1; gy += stride) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const g = this.galaxyAtCached(gx, gy);
        if (!g) continue;
        const p = this.world2screen(g.gx, g.gy);
        if (p.x < -70 || p.x > this.width + 70 || p.y < -70 || p.y > this.height + 70) continue;
        const isFocus = this.lock.galaxy?.galaxyId === g.galaxyId;
        const isHover = this.hover.kind === 'galaxy' && this.hover.galaxy?.galaxyId === g.galaxyId;
        const radius = this.galaxyScreenRadius(g);
        const pulse = 1 + 0.06 * Math.sin(t * 2 + (g.seed % 100));
        // far LOD: a plain mote (there can be thousands on screen)
        if (radius <= GALAXY_DOT_RADIUS && !isFocus && !isHover) {
          ctx.globalAlpha = 0.5 * field;
          ctx.fillStyle = g.starColor;
          ctx.fillRect(p.x - 1.1, p.y - 1.1, 2.2, 2.2);
          ctx.globalAlpha = 1;
          continue;
        }
        // near: the galaxy wears its OWN seeded face (halo, arms, star core baked in).
        // Alpha scales with size so the field reads in DEPTH instead of confetti.
        const s = radius * 3.1 * pulse;
        ctx.globalAlpha = (0.22 + Math.min(0.68, radius / 16) * pulse) * field;
        ctx.drawImage(this.galaxySprite(g), p.x - s / 2, p.y - s / 2, s, s);
        ctx.globalAlpha = 1;
        // POI marker (plan §55)
        if (g.poi !== 'NORMAL' && zoom > 16 && radius > 3.4) {
          ctx.globalAlpha = 0.8 * field;
          ctx.fillStyle = g.poi === 'SWARM' || g.poi === 'DEAD' ? '#ff5d73' : g.poi === 'STRONGHOLD' ? '#ffd166' : '#7be0c8';
          ctx.font = '9px Rajdhani, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(g.poi === 'SWARM' ? '☣' : g.poi === 'DEAD' ? '✝' : g.poi === 'STRONGHOLD' ? '⚑' : '✦', p.x, p.y - radius - 3);
          ctx.globalAlpha = 1;
        }
        if (isHover) {
          ctx.strokeStyle = 'rgba(255,255,255,0.55)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, radius * 2.1 + Math.sin(t * 3) * 1.5, 0, Math.PI * 2);
          ctx.stroke();
        }
        // name — sized WITH the body, and only once it is genuinely big on screen
        // (user: "no need to show names, should be smaller until I zoom in")
        const nameA = ramp01(radius, 14, 24) * field;
        if (nameA > 0.02) {
          ctx.globalAlpha = nameA * 0.95;
          ctx.font = `600 ${Math.min(12, Math.max(8.5, radius * 0.55))}px Rajdhani, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillStyle = 'rgba(233,226,255,0.92)';
          ctx.fillText(g.name.toUpperCase(), p.x, p.y + radius + 13);
          ctx.globalAlpha = 1;
        }
      }
    }
    // ---- band edges ride ON TOP of the field so the rings stay readable in a dense frame
    const edgeFade = 1 - deep * 0.85;
    for (let ring = 7; ring >= 0; ring--) {
      const rc = ringConfig(ring);
      const p0 = this.world2screen(0, 0);
      const rOut = (ring + 1) * RING_WIDTH_CELLS * this.cam.zoom;
      if (rOut < 30) continue;
      ctx.globalAlpha = (ring === this.data.myRing ? 0.3 : 0.1) * edgeFade;
      ctx.strokeStyle = rc.accent;
      ctx.lineWidth = ring === this.data.myRing ? 1.4 : 1;
      ctx.beginPath();
      ctx.arc(p0.x, p0.y, rOut, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** The "YOU" ring marker — always visible, whatever tier is in front. */
  private drawHomeMarker(t: number): void {
    const ctx = this.ctx;
    const cfg = ringConfig(this.data.myRing);
    const home = ringHome(this.data.universeSeed, this.data.myRing);
    const hp = this.world2screen(home.gx, home.gy);
    const hpulse = 1 + 0.25 * Math.sin(t * 3);
    ctx.strokeStyle = cfg.accent;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(hp.x, hp.y, 7 * hpulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = cfg.accent;
    ctx.beginPath();
    ctx.arc(hp.x, hp.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '700 10px Rajdhani, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = cfg.accent;
    ctx.fillText('YOU', hp.x, hp.y - 12);
  }

  /** The soft lock-on reticle: a slow ring + ticks around whatever the crosshair is
   *  expanding (galaxy → system → planet as the ramps deepen). */
  private drawLockReticle(t: number): void {
    const { galaxy, system, planet, sysAlpha, planetAlpha } = this.lock;
    const ctx = this.ctx;
    const zoom = this.cam.zoom;
    let x = 0;
    let y = 0;
    let r = 0;
    let alpha = 0;
    if (planet && system && galaxy && planetAlpha > 0.45) {
      const c = this.planetScreenCircle(galaxy, system, planet, (performance.now() - this.t0) / 1000);
      x = c.x;
      y = c.y;
      r = c.r + 9 + Math.sin(t * 3.4) * 1.4;
      alpha = ramp01(planetAlpha, 0.45, 0.75);
    } else if (system && galaxy && sysAlpha > 0.5) {
      const w = this.systemWorldPos(galaxy, system);
      const p = this.world2screen(w.x, w.y);
      x = p.x;
      y = p.y;
      r = Math.max(8, 0.06 * SYSTEM_SCALE * zoom * 2.6) + 5 + Math.sin(t * 3.4) * 1.2;
      alpha = ramp01(sysAlpha, 0.5, 0.85);
    } else if (galaxy) {
      const gr = this.galaxyScreenRadius(galaxy);
      if (gr >= 6.5) {
        const p = this.world2screen(galaxy.gx, galaxy.gy);
        x = p.x;
        y = p.y;
        r = gr * 2.6 + Math.sin(t * 3.4) * 1.5;
        alpha = ramp01(gr, 6.5, 11);
      }
    }
    if (alpha <= 0.02) return;
    ctx.globalAlpha = alpha * 0.9;
    ctx.strokeStyle = 'rgba(190,240,255,0.85)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2 + t * 0.25;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * (r + 2), y + Math.sin(a) * (r + 2));
      ctx.lineTo(x + Math.cos(a) * (r + 6), y + Math.sin(a) * (r + 6));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------ galaxy level

  private systemsCache = new Map<number, SystemDescriptor[]>();
  private systemsFor(g: GalaxyDescriptor): SystemDescriptor[] {
    let hit = this.systemsCache.get(g.galaxyId);
    if (!hit) {
      hit = systemsInGalaxy(this.data.universeSeed, g.ring, g.galaxyId, g.systemCount);
      this.systemsCache.set(g.galaxyId, hit);
    }
    return hit;
  }

  private systemWorldPos(g: GalaxyDescriptor, sys: SystemDescriptor): { x: number; y: number } {
    return { x: g.gx + (sys.ux - 0.5) * GAL_DISC_WORLD, y: g.gy + (sys.uy - 0.5) * GAL_DISC_WORLD };
  }

  /**
   * The systems of the LOCKED galaxy: born as motes, growing into named stars as the
   * galaxy ramp deepens. The front system (the one the planet tier is opening)
   * crossfades out of this layer as its own big star takes over in `drawPlanetsLayer`.
   */
  private drawSystemsLayer(t: number): void {
    const { galaxy, system, sysAlpha, planetAlpha } = this.lock;
    if (!galaxy || sysAlpha <= 0.01) return;
    const ctx = this.ctx;
    const zoom = this.cam.zoom;
    const rows = this.data.rowsForGalaxy(galaxy.galaxyId);
    const baseR = Math.max(1.4, 0.06 * SYSTEM_SCALE * zoom);
    // the front system crossfades on the same sqrt curve as the planets layer
    const pa = Math.sqrt(planetAlpha);
    // the galaxy's own seeded face fades in behind the systems as the disc fills the view
    const faceAlpha = sysAlpha * 0.35 * (1 - pa * 0.6);
    if (faceAlpha > 0.02) {
      const centre = this.world2screen(galaxy.gx, galaxy.gy);
      const discR = (GAL_DISC_WORLD / 2) * zoom * (1.6 + sysAlpha * 1.4);
      ctx.globalAlpha = faceAlpha;
      ctx.drawImage(this.galaxySprite(galaxy), centre.x - discR * 1.1, centre.y - discR * 1.1, discR * 2.2, discR * 2.2);
      ctx.globalAlpha = 1;
    }
    for (const sys of this.systemsFor(galaxy)) {
      const w = this.systemWorldPos(galaxy, sys);
      const p = this.world2screen(w.x, w.y);
      if (p.x < -60 || p.x > this.width + 60 || p.y < -60 || p.y > this.height + 60) continue;
      const isHover = this.hover.kind === 'system' && this.hover.system?.systemId === sys.systemId;
      const isSel = this.selectedSystem?.systemId === sys.systemId;
      const front = Boolean(system && sys.systemId === system.systemId);
      const twinkle = 0.85 + 0.15 * Math.sin(t * 2.2 + (sys.seed % 50));
      const r = baseR * twinkle;
      const a = sysAlpha * (front ? 1 - pa : 1);
      if (a <= 0.02) continue;
      // star glow + core (the dot GROWS with zoom instead of a fixed 30px blob)
      const ss = r * 6;
      ctx.globalAlpha = 0.6 * a;
      ctx.drawImage(this.glow(galaxy.starColor, 32), p.x - ss / 2, p.y - ss / 2, ss, ss);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.9, r), 0, Math.PI * 2);
      ctx.fill();

      // colony control ring segments in this system (plan §41) — scale with the star
      const systemRows = rows.filter((rr) => rr.systemId === sys.systemId && rr.state === RANKED_PLANET_CONTROLLED && rr.colony < 3);
      if (systemRows.length && r >= 2.4) {
        const per = [0, 0, 0];
        for (const rr of systemRows) per[rr.colony]++;
        const total = systemRows.length;
        let a0 = -Math.PI / 2;
        ctx.globalAlpha = a;
        for (let c = 0; c < 3; c++) {
          if (!per[c]) continue;
          const a1 = a0 + (per[c] / total) * Math.PI * 2;
          ctx.strokeStyle = this.data.colonyColors[c];
          ctx.lineWidth = Math.max(1.4, r * 0.35);
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(3.4, r * 2.4), a0 + 0.06, a1 - 0.06);
          ctx.stroke();
          a0 = a1;
        }
        ctx.globalAlpha = 1;
      }

      if (isHover || isSel) {
        ctx.globalAlpha = a;
        ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(7, r * 3) + Math.sin(t * 3) * 1.2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // name — only once the star dot has grown, sized WITH it
      const nameA = a * ramp01(r, 4.5, 8);
      if (nameA > 0.02) {
        ctx.globalAlpha = nameA * 0.95;
        ctx.font = `600 ${Math.min(12, Math.max(8.5, r * 0.9))}px Rajdhani, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(233,226,255,0.92)';
        ctx.fillText(sys.name.toUpperCase(), p.x, p.y - Math.max(7, r * 1.9));
        ctx.globalAlpha = 1;
      }
    }
  }

  // ------------------------------------------------------------ system level

  private planetsFor(sys: SystemDescriptor): PlanetDescriptor[] {
    const key = sys.ring * 1000000 + sys.galaxyId * 1000 + sys.systemId;
    const cacheHit = this.planetsCache.get(key);
    if (cacheHit) return cacheHit;
    const list = planetsInSystem(this.data.universeSeed, sys.ring, sys.galaxyId, sys.systemId);
    this.planetsCache.set(key, list);
    return list;
  }
  private planetsCache = new Map<number, PlanetDescriptor[]>();

  /**
   * The planets of the FRONT system (the lock's system once the planet ramp opens):
   * the star grows in first, orbits fade up, whole bodies follow, names last — one
   * continuous approach, exactly like flying into a No Man's Sky system.
   */
  private drawPlanetsLayer(t: number): void {
    const { galaxy, system, planetAlpha } = this.lock;
    if (!galaxy || !system || planetAlpha <= 0.01) return;
    // sqrt ramp: bodies firm up early in the band instead of reading as dim marbles
    const pa = Math.sqrt(planetAlpha);
    const ctx = this.ctx;
    const zoom = this.cam.zoom;
    const sw = this.systemWorldPos(galaxy, system);
    const center = this.world2screen(sw.x, sw.y);

    // system star — crossfades in as the systems layer's dot for this system fades out
    const starR = Math.max(2.5, 0.12 * SYSTEM_SCALE * zoom);
    ctx.globalAlpha = 0.9 * pa;
    ctx.drawImage(this.glow(galaxy.starColor, 128), center.x - starR * 4, center.y - starR * 4, starR * 8, starR * 8);
    ctx.globalAlpha = pa;
    ctx.fillStyle = galaxy.starColor;
    ctx.beginPath();
    ctx.arc(center.x, center.y, starR, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    const rows = this.data.rowsForGalaxy(galaxy.galaxyId);
    const reserved = this.data.reservedKeys();
    const nowUs = this.data.serverNowUs();
    const planets = this.planetsFor(system);

    for (const p of planets) {
      const row = rows.find((r) => r.planetKey === p.key);
      const controlled = row?.state === RANKED_PLANET_CONTROLLED && row.colony < 3;
      const isReserved = reserved.has(p.key);
      const isSel = this.selectedPlanet?.key === p.key;
      const isHover = this.hover.kind === 'planet' && this.hover.planet?.key === p.key;
      // orbit position (animated) + body radius — both grow continuously with zoom
      const c = this.planetScreenCircle(galaxy, system, p, t);
      const px = c.x;
      const py = c.y;
      const pr = c.r;
      const orbitR = p.orbitRadius * SYSTEM_SCALE * zoom;

      // orbit path (fades up with the tier)
      ctx.globalAlpha = 0.16 * pa;
      ctx.strokeStyle = 'rgba(180,170,220,1)';
      ctx.lineWidth = 1;
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.scale(1, 0.86);
      ctx.beginPath();
      ctx.arc(0, 0, orbitR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;

      const bob = 1 + 0.04 * Math.sin(t * 1.6 + p.orbit);
      // atmosphere glow
      const glowColor = controlled ? this.data.colonyColors[row.colony] : p.biomeColor;
      ctx.globalAlpha = 0.6 * pa;
      ctx.drawImage(this.glow(glowColor, 48), px - pr * 3, py - pr * 3, pr * 6, pr * 6);
      // body
      ctx.globalAlpha = pa;
      const grad = ctx.createRadialGradient(px - pr * 0.35, py - pr * 0.35, pr * 0.1, px, py, pr);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.25, p.biomeColor);
      grad.addColorStop(1, '#0b0812');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, pr * bob, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (row?.discovered && !controlled) {
        ctx.globalAlpha = pa;
        ctx.strokeStyle = 'rgba(123,232,255,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, pr + 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // shield arc (plan §39): colony ring drains with the 72 h countdown
      if (controlled && row.controlExpiresAt > 0) {
        const remain = Math.max(0, row.controlExpiresAt - nowUs);
        const total = 72 * 3600 * 1e6;
        const frac = Math.min(1, remain / total);
        const low = remain < 10 * 60 * 1e6;
        const alpha = low ? 0.55 + 0.45 * Math.sin(t * 6) : 1;
        ctx.globalAlpha = alpha * pa;
        ctx.strokeStyle = this.data.colonyColors[row.colony];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, pr + 4.5, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (isReserved && !controlled) {
        ctx.globalAlpha = pa;
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(px, py, pr + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      if (isSel || isHover) {
        const pulse = pr + 7 + Math.sin(t * 4) * 1.6;
        ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(255,255,255,0.5)';
        ctx.lineWidth = isSel ? 1.8 : 1.2;
        ctx.beginPath();
        ctx.arc(px, py, pulse, 0, Math.PI * 2);
        ctx.stroke();
      }
      // name — only once the body has grown, and sized WITH it (user: names too big;
      // a selected/hovered planet always names itself so the lock is readable)
      const nameA = isSel || isHover ? 1 : pa * ramp01(pr, 7, 13);
      if (nameA > 0.02) {
        ctx.globalAlpha = nameA * 0.95;
        ctx.font = `600 ${Math.min(12, Math.max(8.5, pr * 0.7))}px Rajdhani, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = controlled ? this.data.colonyColors[row.colony] : 'rgba(233,226,255,0.92)';
        ctx.fillText(p.name.toUpperCase(), px, py + pr + 14);
        ctx.globalAlpha = 1;
      }
    }

    // system name — fades in as the system opens, scaled by its own star
    const sysNameA = pa * ramp01(starR, 6, 16);
    if (sysNameA > 0.02) {
      ctx.globalAlpha = sysNameA * 0.9;
      ctx.font = `700 ${Math.min(15, Math.max(10, starR * 0.75))}px Rajdhani, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(233,226,255,0.88)';
      ctx.fillText(system.name.toUpperCase(), center.x, center.y - starR - 12);
      ctx.globalAlpha = 1;
    }
  }

  // ------------------------------------------------------------ interaction

  private bindEvents(): void {
    const el = this.canvas;
    el.addEventListener('pointerdown', (e) => {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer (tests) — capture is a nicety, not a requirement */
      }
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.cam.zoom };
        this.drag = null;
        this.camTarget = null; // a pinch owns the camera from here
        return;
      }
      this.drag = { x: e.offsetX, y: e.offsetY, camx: this.cam.x, camy: this.cam.y, moved: false };
      this.camTarget = null;
    });
    el.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.cam.zoom = Math.max(4, Math.min(600, (this.pinch.zoom * d) / Math.max(1, this.pinch.dist)));
        return;
      }
      if (this.drag) {
        const dx = e.offsetX - this.drag.x;
        const dy = e.offsetY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
        this.cam.x = this.drag.camx - dx / this.cam.zoom;
        this.cam.y = this.drag.camy - dy / this.cam.zoom;
        return;
      }
      this.updateHover(e.offsetX, e.offsetY);
    });
    const endPointer = (e: PointerEvent): void => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.drag && !this.drag.moved) this.clickAt(e.offsetX, e.offsetY);
      this.drag = null;
    };
    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', (e) => {
      this.pointers.delete(e.pointerId);
      this.drag = null;
      this.pinch = null;
    });
    el.addEventListener('pointerleave', () => {
      this.hover = { kind: null, sx: 0, sy: 0 };
      this.onHoverChange?.(null);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.0016);
        const before = this.screen2world(e.offsetX, e.offsetY);
        this.cam.zoom = Math.max(4, Math.min(600, this.cam.zoom * factor));
        const after = this.screen2world(e.offsetX, e.offsetY);
        this.cam.x += before.x - after.x;
        this.cam.y += before.y - after.y;
        this.camTarget = null;
      },
      { passive: false }
    );
  }

  private hitTest(sx: number, sy: number): Hover {
    const lock = this.lock;
    // planets first — the front-most tier once its ramp has opened
    if (lock.planetAlpha > 0.25 && lock.galaxy && lock.system) {
      const t = (performance.now() - this.t0) / 1000;
      for (const p of this.planetsFor(lock.system)) {
        const c = this.planetScreenCircle(lock.galaxy, lock.system, p, t);
        if ((sx - c.x) ** 2 + (sy - c.y) ** 2 <= (c.r + 9) ** 2) return { kind: 'planet', planet: p, sx, sy };
      }
    }
    // systems of the locked galaxy
    if (lock.sysAlpha > 0.25 && lock.galaxy) {
      const baseR = Math.max(1.4, 0.06 * SYSTEM_SCALE * this.cam.zoom);
      for (const sys of this.systemsFor(lock.galaxy)) {
        const w = this.systemWorldPos(lock.galaxy, sys);
        const p = this.world2screen(w.x, w.y);
        const r = Math.max(10, baseR * 3);
        if ((sx - p.x) ** 2 + (sy - p.y) ** 2 <= r * r) return { kind: 'system', system: sys, sx, sy };
      }
    }
    // galaxies are always hittable
    const w = this.screen2world(sx, sy);
    const gx = Math.round(w.x);
    const gy = Math.round(w.y);
    const tapRadius = lock.sysAlpha > 0.2 ? 14 : 11;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const g = this.galaxyAtCached(gx + dx, gy + dy);
        if (!g) continue;
        const p = this.world2screen(g.gx, g.gy);
        const r = Math.max(tapRadius, this.galaxyScreenRadius(g) * 1.6);
        if ((sx - p.x) ** 2 + (sy - p.y) ** 2 <= r * r) return { kind: 'galaxy', galaxy: g, sx, sy };
      }
    }
    return { kind: null, sx, sy };
  }

  private updateHover(sx: number, sy: number): void {
    const hit = this.hitTest(sx, sy);
    this.hover = hit;
    const el = this.canvas;
    el.style.cursor = hit.kind ? 'pointer' : 'grab';
    if (!this.onHoverChange) return;
    if (hit.kind === 'galaxy' && hit.galaxy) {
      this.onHoverChange({ kind: 'galaxy', label: hit.galaxy.name.toUpperCase(), sub: hit.galaxy.poiLabel, x: sx, y: sy });
    } else if (hit.kind === 'system' && hit.system) {
      const g = this.lock.galaxy ?? this.focusGalaxy;
      const count = g ? systemPlanetCount(this.data.universeSeed, g.ring, g.galaxyId, hit.system.systemId) : 0;
      this.onHoverChange({ kind: 'system', label: hit.system.name.toUpperCase(), sub: `${count} PLANETS`, x: sx, y: sy });
    } else if (hit.kind === 'planet' && hit.planet) {
      this.onHoverChange({ kind: 'planet', label: hit.planet.name.toUpperCase(), sub: hit.planet.biomeLabel, x: sx, y: sy });
    } else {
      this.onHoverChange(null);
    }
  }

  private clickAt(sx: number, sy: number): void {
    const hit = this.hitTest(sx, sy);
    if (hit.kind === 'galaxy' && hit.galaxy) {
      // a click is a shortcut for the gesture: fly in and let the ramps take over
      this.flyToGalaxy(hit.galaxy);
    } else if (hit.kind === 'system' && hit.system) {
      const g = this.lock.galaxy ?? this.focusGalaxy;
      if (g) this.flyToSystem(g, hit.system);
    } else if (hit.kind === 'planet' && hit.planet) {
      this.selectPlanet(hit.planet);
    }
  }

  /** Zoom around the viewport centre (the ± buttons). */
  zoomStep(factor: number): void {
    this.cam.zoom = Math.max(4, Math.min(600, this.cam.zoom * factor));
    this.camTarget = null;
  }

  /** Ring a system as selected without entering (panel-driven). */
  markSystem(sys: SystemDescriptor | null): void {
    this.selectedSystem = sys;
  }
}
