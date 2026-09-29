// NECROFALL — the INTERGALACTIC MAP (plan §44/§46/§47/§75). One canvas, three
// zoom levels (GALACTIC → GALAXY → SYSTEM → PLANET detail is the DOM panel's
// job), GPU-cheap sprites instead of per-frame gradient objects, and real
// animation: twinkling starfield, drifting nebulae, orbiting planets, pulsing
// selections and countdown shield arcs.
//
// INTERACTION MODEL (plan §19–§28/§72): TAP = SELECT (never zoom), a SECOND tap
// enters the object, DRAG = pan, PINCH/WHEEL = zoom. While the SOLAR SYSTEM is
// VISIBLE its planets own the view: the camera is clamped to that system, taps
// can never target a neighbour, and zooming grows around the soft-locked target.
// Zooming out to the dot level releases the lock, so dragging there re-aims it.
//
// The map is VIEW-ONLY: nothing here decides availability or ownership — rows
// come from the server subscription, everything else is regenerated from the
// season seed (plan §0). Discovery is EARNED IN MATCHES (AppShell records it when a ranked
// match ends); the map only READS it back off the scoped subscriptions (plan §6/§47).
// the server decides, and the DOM panels render what came back.
import { GalaxyDescriptor, PlanetDescriptor, SystemDescriptor } from './procedural/GalaxyTypes';
import { planetsInSystem, ringHome } from './procedural/UniverseGenerator';
import { galaxyAt } from './procedural/GalaxyGenerator';
import { systemAt, systemsInGalaxy } from './procedural/SolarSystemGenerator';
import { systemPlanetCount } from './procedural/SolarSystemGenerator';
import { ringConfig } from './procedural/RankRingConfig';
import { decodeGalaxyId, MAX_RING_RADIUS, ringCenterRadius, ringInnerRadius, ringOfGalaxy, ringOuterRadius } from './procedural/SeedHash';
import { getTerritoryVisual, planetOwnershipColor, NECROPHAGE_CONTROL_COLOR, type TerritoryVisual } from './Ownership';
import { calculateDominance } from './LocationControlSummary';
import {
  type DiscoveryEntry,
} from './DiscoveryTypes';

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

/**
 * The authoritative SELECTION (plan §21): ONE object drives the canvas
 * highlight AND the DOM panel. Selection is NOT navigation (plan §22) — it
 * changes when the player taps (or when a planet soft-locks at the crosshair),
 * never the camera.
 */
export interface LocationSelection {
  type: 'galaxy' | 'system' | 'planet';
  galaxy: GalaxyDescriptor;
  system?: SystemDescriptor;
  planet?: PlanetDescriptor;
}

export interface MapData {
  universeSeed: number;
  myRing: number;
  colonyNames: string[];
  colonyColors: string[];
  rowsForGalaxy(galaxyId: number): PlanetRowData[];
  /** Every planet row (ownership overlays sweep this — plan §33). Optional for tests. */
  allRows?(): PlanetRowData[];
  reservedKeys(): Set<string>;
  /**
   * SERVER time in micros (plan §14/§46) — the shield countdown reads this,
   * never `Date.now()` directly.
   */
  serverNowUs(): number;
  /** Discovery history of ONE galaxy / system / planet, scoped on demand (plan §7/§43). */
  discoveriesForGalaxy(galaxyId: number): DiscoveryEntry[];
  discoveriesForSystem(galaxyId: number, systemId: number): DiscoveryEntry[];
  discoveriesForPlanet(planetKey: string): DiscoveryEntry[];
  /* (Discovery is written server-side when a ranked match ends — the map never asks.) */
  /** The signed-in player (plan §7) — used to mark "you" and gate requests. */
  currentPlayerId: string;
  currentPlayerName: string;
  /** Ask the SERVER to record first contact (plan §6/§47). Optional for tests. */
}

export type MapLevel = 'galactic' | 'galaxy' | 'system';

export interface MapSelection {
  level: MapLevel;
  galaxy: GalaxyDescriptor | null;
  system: SystemDescriptor | null;
  planet: PlanetDescriptor | null;
  /** The authoritative user selection (plan §21) — null when nothing is selected. */
  selected: LocationSelection | null;
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

/** World zoom bands where each tier fades in — see `zoomRamps()`. The planet band
 *  is split: `plStart..plEnd` opens the SOLAR SYSTEM (small solid planets), and
 *  `closeStart..closeEnd` drives the planet close-up (bodies grow, names appear). */
interface ZoomRanges {
  gal: number;
  sysStart: number;
  sysEnd: number;
  plStart: number;
  plEnd: number;
  closeStart: number;
  closeEnd: number;
}

/** The live soft-lock: what the crosshair is aiming at, tier by tier, plus how far
 *  each tier has faded in. Rendering AND the DOM panel read this — no hard cuts. */
interface LockState {
  galaxy: GalaxyDescriptor | null;
  system: SystemDescriptor | null;
  planet: PlanetDescriptor | null;
  sysAlpha: number;
  planetAlpha: number;
  closeAlpha: number;
  ranges: ZoomRanges;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const ramp01 = (v: number, a: number, b: number): number => clamp01((v - a) / Math.max(1e-6, b - a));

/**
 * Rubber-band bound for the system drag lock (plan §24/§25). Inside the bound
 * the value is untouched; outside it is eased back with a CAPPED overshoot, so
 * the camera stops softly but can never escape the solar system.
 */
function softBound(v: number, centre: number, radius: number, half: number): number {
  const min = centre - radius + half;
  const max = centre + radius - half;
  if (min > max) return centre; // the viewport is larger than the system — centre it
  if (v < min) return min - Math.min(min - v, 2) * 0.18;
  if (v > max) return max + Math.min(v - max, 2) * 0.18;
  return v;
}

/** '#rrggbb' (or the 3-digit form) → an rgba() string with the given alpha. */
function withAlpha(color: string, a: number): string {
  let hex = color.replace('#', '').trim();
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  const n = parseInt(hex, 16);
  if (!Number.isFinite(n)) return `rgba(255,255,255,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const GAL_DISC_WORLD = 3.0; // galaxy disc diameter in world units
const SYSTEM_SCALE = 0.62; // system local (unit) space → world units
/** Face-sprite caches (user 2026-09-29: the dot transition stuttered): the FULL face
 *  bakes at 160², the transition-band mip at 96² (≤128px draws). At the cap the caches
 *  drop their oldest quarter instead of clearing — a clear re-bakes hundreds of sprites
 *  in one frame, which is the hitch players felt while zooming through the transition. */
const SPRITE_CACHE = 600;
const SPRITE_MIP = 96;
/** Below this body radius a galaxy is a plain LIGHT DOT — the intergalactic view is a
 *  starfield of motes (user: "show all galaxies as light dots until I zoom in a certain
 *  amount… make it look like No Man's Sky"), and it is also the reason a wide frame
 *  with thousands of galaxies stays cheap: no shaped faces until they are genuinely
 *  grown on screen. */
const GALAXY_DOT_RADIUS = 18;
/** Shared angular speed of every SPIRAL / BARRED_SPIRAL face (rad/s) — one rhythm for
 *  the whole field. History: 0.06 read as static, 0.24 read as too fast (user 2026-09-29:
 *  "galaxy animations should be slower") — this is the calm middle. */
const GALAXY_SPIN = 0.12;

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
  /**
   * SYSTEM DRAG LOCK (plan §23–§26, v3): the focused system is PINNED for as long as the solar
   * system is VISIBLE (its planets drawn) — camera movement can never swap the lock onto a
   * neighbour and the camera itself is clamped to the system's own bounds. Zooming back out to
   * the dot level releases it (a drag there re-aims the soft lock).
   */
  private pinnedSystem: SystemDescriptor | null = null;
  /** Per-system camera-clamp radius (world units), computed once per system. */
  private systemBoundsCache = new Map<number, number>();
  /** THE authoritative selection (plan §21). */
  private selected: LocationSelection | null = null;
  /** Planets the player explicitly deselected — auto soft-select skips them (plan §50/§51). */
  private suppressAutoSelect = new Set<string>();

  private hover: Hover = { kind: null, sx: 0, sy: 0 };
  private stars: { x: number; y: number; r: number; seed: number; layer: number }[] = [];
  private shooting: { x: number; y: number; vx: number; vy: number; life: number } | null = null;
  private nextShooting = 0;
  private glowCache = new Map<string, HTMLCanvasElement>();
  /** Memoised galaxy lattice: one generator call per cell, EVER (far views sweep thousands). */
  private galaxyMemo = new Map<number, GalaxyDescriptor | null>();
  /** Per-galaxy seeded face sprites (spiral / elliptical / irregular), baked once. */
  private galaxySprites = new Map<number, HTMLCanvasElement>();
  /** 96px MIPS of the face sprites (user 2026-09-29: the dot transition stuttered).
   *  Through the transition band HUNDREDS of small faces draw per frame; sampling a
   *  96² mip instead of the 160² source is visually identical at ≤128px and much
   *  cheaper. Built lazily with ONE downscaling drawImage per galaxy. */
  private galaxyMips = new Map<number, HTMLCanvasElement>();
  /** Ownership overlays (plan §33/§35): which galaxies have rows at all, refreshed lazily. */
  private ownedIds = new Set<number>();
  private ownedRefreshAt = -1e9;
  private territoryCache = new Map<number, { at: number; vis: TerritoryVisual }>();
  /** DEBUG (plan §39): ?rankDebug=1 draws bounds / points / arms / ownership / LOD. */
  private debug = typeof location !== 'undefined' && /[?&]rankDebug=1/.test(location.search);
  private raf = 0;
  private disposed = false;
  private resizeObserver: ResizeObserver | null = null;
  /** Drag/tap state: `moved` flips once the pointer travels past `slop` px (plan §20). */
  private drag: { x: number; y: number; camx: number; camy: number; moved: boolean; slop: number } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; zoom: number } | null = null;
  private t0 = performance.now();
  private lastStepAt = performance.now();
  private bgGrad: CanvasGradient | null = null;
  private bgGradH = 0;

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
    if (import.meta.env.DEV) (globalThis as unknown as { __nfMap?: GalacticMap }).__nfMap = this;
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

  /** Fly the camera to a ring's anchor galaxy (the ring rail / BACK TO POSITION).
   *  Selecting a pill always ZOOMS OUT to the galactic view of that band (user
   *  2026-09-29): the target zoom is never deeper than the camera already is, so a tap
   *  can only ever widen the view — never push the player back into a galaxy. Also
   *  clears the selection and releases the focus (plan §52). */
  flyToRing(ring: number): void {
    const home = ringHome(this.data.universeSeed, ring);
    this.flyToAnchor(home, this.ringViewZoom(ring));
  }

  /**
   * BACK TO POSITION (the map's crosshair). Used to land on the whole-BAND view, where
   * the home galaxy shrank to a faint ~10px dot — "the center position button zooms out
   * too much" (user 2026-09-29). It now frames the galaxy tier's own opening scale: the
   * home galaxy reads as a face with its solar systems and its neighbours around it.
   * Still `min(current, target)` — the button may widen the view but never push deeper.
   */
  centerOnHome(): void {
    const home = ringHome(this.data.universeSeed, this.data.myRing);
    this.flyToAnchor(home, this.homeViewZoom());
  }

  /** The neighbourhood scale BACK TO POSITION lands on (zoomRamps().gal = the zoom the
   *  galaxy tier opens at — the single source for "where a galaxy becomes a place"). */
  private homeViewZoom(): number {
    const ranges = this.zoomRamps();
    return Math.max(4, Math.min(1700, ranges.gal * 1.15));
  }

  /** Shared flight start: release focus/selection, glide to an anchor coordinate. */
  private flyToAnchor(home: { gx: number; gy: number }, zoom: number): void {
    this.level = 'galactic';
    this.focusGalaxy = null;
    this.focusSystem = null;
    this.pinnedSystem = null;
    this.selected = null;
    this.suppressAutoSelect.clear();
    this.camTarget = { x: home.gx, y: home.gy, zoom: Math.min(this.cam.zoom, zoom) };
    this.emitSelection();
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

  /** THE authoritative selection (plan §21). */
  get selection(): LocationSelection | null {
    return this.selected;
  }

  back(): void {
    const ranges = this.zoomRamps();
    if (this.level === 'system') {
      // Ease back out toward the galaxy tier — the soft-focus pass unwinds the
      // levels on its own as the ramps collapse (no hard reset, no jump).
      this.camTarget = { x: this.cam.x, y: this.cam.y, zoom: Math.max(6, ranges.plStart * 0.62) };
      if (this.selected?.type === 'planet') this.selected = null;
      this.emitSelection();
    } else if (this.level === 'galaxy') {
      const left = this.focusGalaxy;
      this.camTarget = left
        ? { x: left.gx, y: left.gy, zoom: Math.max(4, Math.min(ranges.sysStart * 0.62, this.ringViewZoom(left.ring))) }
        : { x: this.cam.x, y: this.cam.y, zoom: Math.max(4, ranges.sysStart * 0.62) };
    }
  }

  /**
   * SELECT a planet (plan §21/§47) — panel-driven jumps and deep-zoom soft lock.
   * Selection NEVER moves the camera (plan §22); it only drives highlight + panel.
   */
  selectPlanet(p: PlanetDescriptor | null, galaxy?: GalaxyDescriptor, system?: SystemDescriptor): void {
    if (!p) {
      this.clearSelection();
      return;
    }
    const g = galaxy ?? this.focusGalaxy ?? this.resolveGalaxy(p);
    const sys =
      system ??
      (this.focusSystem?.systemId === p.systemId ? this.focusSystem : undefined) ??
      (g ? this.resolveSystem(p, g) ?? undefined : undefined);
    if (!g || !sys) return; // descriptors can only be resolved for real locations
    this.suppressAutoSelect.delete(p.key);
    this.selected = { type: 'planet', galaxy: g, system: sys, planet: p };
    // TARGET LOCK (user 2026-09-29): zooming in keeps this planet's system as focus.
    this.pinnedSystem = sys;
    this.emitSelection();
  }

  /** Clear the selection WITHOUT touching the camera (plan §51 — empty-space tap). */
  clearSelection(): void {
    if (!this.selected) return;
    if (this.selected.type === 'planet' && this.selected.planet) {
      // Do not immediately re-select the same planet by the close-up soft lock.
      this.suppressAutoSelect.add(this.selected.planet.key);
    }
    this.selected = null;
    // Deselecting releases the system target lock too (empty-space tap).
    this.pinnedSystem = null;
    this.emitSelection();
  }

  private emitSelection(): void {
    this.onSelect({
      level: this.level,
      galaxy: this.focusGalaxy,
      system: this.focusSystem,
      planet: this.selected?.planet ?? null,
      selected: this.selected,
    });
  }

  private resolveGalaxy(p: PlanetDescriptor): GalaxyDescriptor | null {
    const { gx, gy } = decodeGalaxyId(p.galaxyId);
    return galaxyAt(this.data.universeSeed, gx, gy);
  }

  private resolveSystem(p: PlanetDescriptor, g: GalaxyDescriptor): SystemDescriptor | null {
    return systemAt(this.data.universeSeed, p.ring, p.galaxyId, p.systemId, g.systemCount);
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

  /** Memoised lattice lookup — the far zoom-out sweeps tens of thousands of cells.
   *  BOUNDED (plan §43): exploration is infinite, memory is not. */
  private galaxyAtCached(gx: number, gy: number): GalaxyDescriptor | null {
    const key = ((gx + 8192) << 14) | (gy + 8192);
    let hit = this.galaxyMemo.get(key);
    if (hit !== undefined) return hit;
    hit = galaxyAt(this.data.universeSeed, gx, gy);
    if (this.galaxyMemo.size >= 4096) {
      // evict the oldest half (Map preserves insertion order)
      const drop = this.galaxyMemo.keys();
      for (let i = 0; i < 2048; i++) {
        const k = drop.next().value;
        if (k === undefined) break;
        this.galaxyMemo.delete(k);
      }
    }
    this.galaxyMemo.set(key, hit);
    return hit;
  }

  /** Screen radius of a galaxy's body — ONE formula for drawing AND hit-testing. */
  private galaxyScreenRadius(g: GalaxyDescriptor): number {
    return Math.max(3, g.radius * 0.012 * this.cam.zoom);
  }

  /**
   * OWNERSHIP (plan §35): the territory visual of one galaxy, rebuilt at most once every
   * 2 s (rows change on match ends, not per frame). `ownedIds` is the cheap pre-filter so
   * a frame with thousands of galaxies never scans rows for galaxies nobody touched.
   */
  private refreshOwnedIds(now: number): void {
    if (now - this.ownedRefreshAt < 3000 || !this.data.allRows) return;
    this.ownedRefreshAt = now;
    this.ownedIds.clear();
    for (const r of this.data.allRows()) this.ownedIds.add(r.galaxyId);
  }

  private territoryForGalaxy(galaxyId: number): TerritoryVisual {
    const now = performance.now();
    const hit = this.territoryCache.get(galaxyId);
    if (hit && now - hit.at < 2000) return hit.vis;
    const vis = getTerritoryVisual(this.data.rowsForGalaxy(galaxyId), this.data.colonyColors);
    if (this.territoryCache.size > 256) this.territoryCache.clear();
    this.territoryCache.set(galaxyId, { at: now, vis });
    return vis;
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
      const morph = g.morphology;
      const rot = g.rotation;
      const squash = morph === 'ELLIPTICAL'
        ? 1 / g.axisRatio
        : morph === 'IRREGULAR'
          ? 1 - g.discThickness * 0.6
          : 0.72 + 0.24 * Math.max(0, 1 - g.discThickness * 3);
      const bulge = 0.72 + g.bulgeStrength * 0.5;
      // halo — stacked soft discs (no rgba strings needed)
      for (let i = 10; i >= 1; i--) {
        ctx.globalAlpha = 0.026;
        ctx.fillStyle = haze;
        ctx.beginPath();
        ctx.arc(cx, cy, (size / 2) * (i / 10) * 0.92, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (morph === 'SPIRAL' || morph === 'BARRED_SPIRAL') {
        // spiral / barred spiral — tapered motes along the descriptor's OWN arms
        const arms = Math.max(2, g.armCount);
        const spin = g.armTightness;
        const barLen = morph === 'BARRED_SPIRAL' ? 8 + rnd() * 9 : 0;
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
      } else if (morph === 'ELLIPTICAL') {
        // elliptical — a tilted, dustless disc (core size follows bulge strength)
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
      } else if (morph === 'RING') {
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
      } else if (morph === 'FLOCCULENT') {
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
      // core — every galaxy keeps its star's own colour; size reads `bulgeStrength`
      for (let i = 5; i >= 1; i--) {
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = g.starColor;
        ctx.beginPath();
        ctx.arc(cx, cy, (3 + i * 3.6) * bulge, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy, 3.1 * bulge, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (this.galaxySprites.size >= SPRITE_CACHE) this.evictOldest(this.galaxySprites);
    this.galaxySprites.set(g.galaxyId, c);
    return c;
  }

  /** Lazy small mip of a face (one downscaling drawImage), used for s <= 128px. */
  private galaxySpriteSmall(g: GalaxyDescriptor): HTMLCanvasElement {
    const hit = this.galaxyMips.get(g.galaxyId);
    if (hit) return hit;
    const c = document.createElement('canvas');
    c.width = SPRITE_MIP;
    c.height = SPRITE_MIP;
    const ctx = c.getContext('2d');
    if (ctx) ctx.drawImage(this.galaxySprite(g), 0, 0, SPRITE_MIP, SPRITE_MIP);
    if (this.galaxyMips.size >= SPRITE_CACHE) this.evictOldest(this.galaxyMips);
    this.galaxyMips.set(g.galaxyId, c);
    return c;
  }

  /**
   * AMORTISED EVICTION (user 2026-09-29: "the entire game lags n stutters" while
   * zooming through the dot transition). The old cache CLEARED itself past 320
   * entries, so the next frame re-baked hundreds of sprites in ONE frame — a visible
   * hitch. Maps keep insertion order, so dropping the oldest slice spreads the cost.
   */
  private evictOldest(map: Map<number, HTMLCanvasElement>): void {
    let n = 0;
    const want = Math.max(16, SPRITE_CACHE >> 2);
    for (const key of map.keys()) {
      map.delete(key);
      if (++n >= want) break;
    }
  }

  // ------------------------------------------------------------ soft focus (continuous zoom)

  /** The live soft-lock (rendered every frame; also drives the DOM tier). */
  private lock: LockState = {
    galaxy: null,
    system: null,
    planet: null,
    sysAlpha: 0,
    planetAlpha: 0,
    closeAlpha: 0,
    ranges: { gal: 40, sysStart: 41, sysEnd: 110, plStart: 200, plEnd: 450, closeStart: 400, closeEnd: 800 },
  };

  /**
   * Tier ramps (user: "no sudden transitions — just like No Man's Sky"; v3: the
   * solar system is its OWN stage between the galaxy and the planets):
   *   galaxy view → hundreds of system motes → ONE solar system opens (star, orbits,
   *   small solid planets) → planet close-up (bodies grow, names appear).
   * Everything is derived from the canvas' own framing zooms, so a tiny mini-map and
   * a fullscreen map reveal the same way, just sooner or later in absolute zoom.
   */
  private zoomRamps(): ZoomRanges {
    const gal = this.fitZoom(GAL_DISC_WORLD * 2.4);
    const sysStart = gal * 1.02;
    const sysEnd = Math.max(sysStart + 18, Math.min(gal * 2.6, 280));
    const zSys = this.fitZoom(SYSTEM_SCALE * 2.5);
    // the solar system opens WELL past the galaxy stage (2.2×), so the galaxy view
    // stays a galaxy view instead of jumping straight to planets
    const plStart = Math.min(Math.max(zSys * 1.4, sysEnd * 2.2), 460);
    const plEnd = Math.min(Math.max(zSys * 2.0, plStart * 1.6), 900);
    const closeStart = plEnd * 0.9;
    const closeEnd = Math.min(plEnd * 2.1, 1600);
    return { gal, sysStart, sysEnd, plStart, plEnd, closeStart, closeEnd };
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

  /** Per-system orbital plane (user: systems vary in plane): inclination + spin,
   *  derived from the system seed so every system hangs its planets differently. */
  private systemPlane(sys: SystemDescriptor): { inc: number; rot: number } {
    const s = (sys.seed ^ (sys.systemId * 2654435761)) >>> 0;
    return {
      inc: 0.28 + (((s >>> 4) % 1000) / 1000) * 0.55,
      rot: ((s >>> 14) % 628) / 100,
    };
  }

  /** Where a planet sits on screen right now (orbit animation + its system's plane).
   *  The elliptical orbit is FLATTENED FIRST and then rotated — the same order the
   *  orbit path is drawn in (`rotate(rot); scale(1, inc); arc(...)`), so a planet
   *  never drifts off its ring (the old formula skipped `inc` on one rotated term). */
  private planetScreenCircle(g: GalaxyDescriptor, sys: SystemDescriptor, p: PlanetDescriptor, t: number): { x: number; y: number; r: number } {
    const sw = this.systemWorldPos(g, sys);
    const centre = this.world2screen(sw.x, sw.y);
    // A full orbit takes ~45–90 s depending on the ring (user could not tell the
    // planets moved at all — the old 0.05 factor was near-still at map zoom).
    const speed = 0.085 / (0.4 + p.orbitRadius);
    const angle = p.orbit + t * speed;
    const orbitR = p.orbitRadius * SYSTEM_SCALE * this.cam.zoom;
    const plane = this.systemPlane(sys);
    const cR = Math.cos(plane.rot);
    const sR = Math.sin(plane.rot);
    const ca = Math.cos(angle);
    const sa = Math.sin(angle) * plane.inc;
    // STAGED SIZE (plan §11): tiny dots as the system opens (radius·6·sqrt(plAlpha)),
    // solid bodies through the solar-system stage, the classic full view (radius·17) at
    // the close-up. One continuous growth, no cut.
    const grow = 6 * Math.sqrt(this.lock.planetAlpha) + 11 * this.lock.closeAlpha;
    return {
      x: centre.x + (ca * cR - sa * sR) * orbitR,
      y: centre.y + (ca * sR + sa * cR) * orbitR,
      r: Math.max(2.2, p.radius * grow),
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
    // TARGET STABILITY (user 2026-09-29: "while zooming in, don't change targets — I
    // have a solar system targeted but zooming switches to a different one"): an
    // explicit SELECTION outranks the nearest-to-centre scan. The selected galaxy is
    // kept as the focus while it sits inside ~80% of the half-view; a pinned system
    // (tap, panel jump, flight target or tier entry) then owns the system lock at ANY
    // zoom level, so zooming can never slide the target onto a neighbour.
    const nearestGalaxy = this.nearestGalaxyToViewCentre();
    const picked = this.selected?.galaxy ?? null;
    let galaxy = nearestGalaxy;
    if (picked && picked.galaxyId !== nearestGalaxy?.galaxyId) {
      const halfW = Math.max(1, this.width / (2 * this.cam.zoom));
      const halfH = Math.max(1, this.height / (2 * this.cam.zoom));
      if (Math.abs(picked.gx - this.cam.x) < halfW * 0.8 && Math.abs(picked.gy - this.cam.y) < halfH * 0.8) {
        galaxy = picked;
      }
    }
    const sysAlpha = ramp01(zoom, ranges.sysStart, ranges.sysEnd);
    const planetAlpha = ramp01(zoom, ranges.plStart, ranges.plEnd);
    const closeAlpha = ramp01(zoom, ranges.closeStart, ranges.closeEnd);
    // WHILE THE SYSTEM IS VISIBLE ITS GALAXY IS LOCKED TOO (user ask 2026-09-29 — caught live: a
    // drag inside the clamp can still push the view centre across the galaxy lattice, and the
    // soft-focus then adopted the neighbour's nearest system = the lock "jumped" solar systems).
    // The pinned system's galaxy is derived directly, and only while `planetAlpha` is open.
    const flying = this.camTarget !== null;
    if (this.pinnedSystem && planetAlpha > 0.02) {
      const { gx, gy } = decodeGalaxyId(this.pinnedSystem.galaxyId);
      const pg = galaxyAt(this.data.universeSeed, gx, gy);
      if (pg) galaxy = pg;
    }
    // SYSTEM DRAG LOCK v3 (user ask 2026-09-29). The lock's life is tied to the SOLAR SYSTEM
    // BEING VISIBLE (its planets drawn, `planetAlpha > 0`):
    //   • the moment the visible band opens, the soft-locked system is PINNED, and for as long as
    //     the band lasts the pin survives ANY pan — the camera is clamped to the system and taps
    //     can never target a neighbour ("once the solar system is visible, don't allow drag/tap to
    //     go to a different solar system");
    //   • zooming back out to the dot level RELEASES it, so dragging there re-aims the soft lock
    //     at the nearest system to the crosshair. The old "panned 1.25 half-views away" release
    //     never fired on a small viewport — the lock felt stuck to the last system (user report).
    // SCRIPTED FLIGHTS ARE EXEMPT from both new rules (caught live): mid-flight the view centre
    // sweeps across the galaxy lattice, and re-aiming there re-pinned the first neighbour it met —
    // the flight landed with the WRONG system focused. A flight's own pin/selection is the intent.
    const nearest = galaxy && sysAlpha > 0.04 ? this.nearestSystemToViewCentre(galaxy) : null;
    if (this.pinnedSystem && !flying && (!galaxy || this.pinnedSystem.galaxyId !== galaxy.galaxyId)) {
      this.pinnedSystem = null; // the focus moved to another galaxy entirely (dot level only)
    }
    const pinnedHere = this.pinnedSystem && galaxy && this.pinnedSystem.galaxyId === galaxy.galaxyId;
    const system = pinnedHere ? this.pinnedSystem : nearest;
    if (!this.pinnedSystem && !flying && system && planetAlpha > 0.02) this.pinnedSystem = system; // the band opened — lock it
    const planet = galaxy && system && planetAlpha > 0.08 ? this.nearestPlanetToViewCentre(galaxy, system) : null;
    this.lock = { galaxy, system, planet, sysAlpha, planetAlpha, closeAlpha, ranges };

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
        this.pinnedSystem = null; // zoom-out releases the system drag lock (plan §26)
        this.suppressAutoSelect.clear();
        this.selected = null;
      }
      if (next === 'system' && system && !this.pinnedSystem) this.pinnedSystem = system;
      // a selected planet only survives while its OWN system is the focus
      if (this.selected?.planet && this.focusSystem && this.selected.planet.systemId !== this.focusSystem.systemId) {
        this.selected = null;
      }
      // RECENTRE on the tier we just entered (user: "I'm not able to zoom into the
      // solar system"): the locked galaxy/system glides under the crosshair as the
      // ramps deepen, so its systems/planets come INTO VIEW instead of drifting off.
      // Never while the user is actively panning — that gesture owns the centre — and
      // never while a SCRIPTED FLIGHT is running: this assignment carries no zoom, so
      // it used to cancel the zoom-out a ring-pill tap had just started (user 2026-09-29:
      // "selecting rank pills should zoom out to the galactic view" — the camera panned
      // to the band but stayed deep, leaving the player inside a galaxy).
      if (next !== 'galactic' && galaxy && !this.drag && !this.camTarget) {
        const w = next === 'system' && system ? this.systemWorldPos(galaxy, system) : { x: galaxy.gx, y: galaxy.gy };
        const onScreen = this.world2screen(w.x, w.y);
        if (Math.abs(onScreen.x - this.width / 2) > 12 || Math.abs(onScreen.y - this.height / 2) > 12) {
          this.camTarget = { x: w.x, y: w.y };
        }
      }
      this.emitSelection();
    }
    // deep close-up: the planet at the crosshair becomes the selection (this is the
    // end of the journey — galaxy → solar system → planet). A planet the player
    // explicitly deselected stays deselected until the close-up range is left
    // (plan §50/§51) — an empty-space tap must never bounce back on its own.
    if (closeAlpha < 0.3 && this.suppressAutoSelect.size) this.suppressAutoSelect.clear();
    if (planet && closeAlpha > 0.35 && this.selected?.planet?.key !== planet.key && !this.suppressAutoSelect.has(planet.key)) {
      this.selectPlanet(planet);
    }
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
    // Fullscreen / resize keeps cam + selection; only re-apply the system bound
    // for the new viewport extents (plan §25/§53).
    this.clampCameraToSystem();
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
    const span = Math.max(14, ringOuterRadius(ring) * 2.5);
    return Math.max(4, Math.min(42, this.fitZoom(span)));
  }

  /**
   * HOW MUCH OF A RANK BAND IS VISIBLE (plan §2). The playable map physically expands
   * with rank: your own band and its neighbours read fully, the next tier is faint, and
   * anything further is hidden behind the cosmic starfield. The VIEWED band (where the
   * camera is parked) always reads too, so browsing another rank's territory in the rail
   * still lights that region up instead of showing an empty void.
   */
  private bandVisibility(ring: number): number {
    const from = (base: number): number => {
      const d = Math.abs(ring - base);
      return d === 0 ? 1 : d === 1 ? 0.55 : d === 2 ? 0.16 : 0;
    };
    return Math.max(from(this.data.myRing), from(this.focusedRing()));
  }

  /** The band the camera is currently parked on (stable during flights: camTarget wins). */
  private focusedRing(): number {
    const f = this.camTarget ?? this.cam;
    return ringOfGalaxy(Math.round(f.x), Math.round(f.y));
  }

  /** The band the player is BROWSING right now (rail highlight + canvas band label). */
  get viewedRing(): number {
    return this.focusedRing();
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
    // Navigation implies focus: the galaxy you are entering IS the selection.
    if (this.selected?.type !== 'galaxy' || this.selected.galaxy.galaxyId !== g.galaxyId) {
      this.selected = { type: 'galaxy', galaxy: g };
    }
    const ranges = this.zoomRamps();
    // land INSIDE the galaxy tier (ramp 80%), so a click really opens the systems
    const into = ranges.sysStart + (ranges.sysEnd - ranges.sysStart) * 0.8;
    this.camTarget = keepZoom ? { x: g.gx, y: g.gy } : { x: g.gx, y: g.gy, zoom: Math.max(this.cam.zoom, into) };
  }

  private flyToSystem(g: GalaxyDescriptor, sys: SystemDescriptor): void {
    // SYSTEM DRAG LOCK (plan §23): pin the system the moment the player enters it.
    this.pinnedSystem = sys;
    if (this.selected?.type !== 'system' || this.selected.system?.systemId !== sys.systemId) {
      this.selected = { type: 'system', galaxy: g, system: sys };
    }
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
    // frame-rate-independent damping (plan §8: camera and scale interpolate smoothly
    // on exponential curves, so a 30fps phone glides identically to a 120Hz desktop)
    const dt = Math.min(0.1, Math.max(1 / 240, (now - this.lastStepAt) / 1000));
    this.lastStepAt = now;
    if (this.camTarget) {
      const k = 1 - Math.pow(0.0016, dt);
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
    // ownership overlays refresh lazily (rows change on match ends, not per frame)
    this.refreshOwnedIds(now);
    // SYSTEM DRAG LOCK (plan §26): while the system tier is active the camera stays
    // inside the current solar system; zooming out past the tier releases it.
    this.clampCameraToSystem();
    // Seamless soft zoom: tier ramps decide what is visible, and the DOM tier
    // follows them — pinch, wheel and the ± buttons all flow through here.
    this.updateSoftFocus();
    this.draw(t);
  }

  private draw(t: number): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // deep-space backdrop (cached — plan §42: no per-frame gradient objects)
    if (!this.bgGrad || this.bgGradH !== this.height) {
      const bg = ctx.createLinearGradient(0, 0, 0, this.height);
      bg.addColorStop(0, '#05030c');
      bg.addColorStop(0.55, '#0a0617');
      bg.addColorStop(1, '#120a24');
      this.bgGrad = bg;
      this.bgGradH = this.height;
    }
    ctx.fillStyle = this.bgGrad;
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
    if (this.debug) this.drawDebug(t);
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

  /**
   * Cached planet body sprite (plan §42): one baked radial body per colour instead of a
   * per-planet, per-frame `createRadialGradient`. The lit-from-upper-left look is baked in.
   */
  private bodySprite(color: string): HTMLCanvasElement {
    const key = `body:${color}`;
    const hit = this.glowCache.get(key);
    if (hit) return hit;
    const size = 64;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    if (g) {
      const grad = g.createRadialGradient(size * 0.32, size * 0.32, size * 0.06, size / 2, size / 2, size / 2);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.25, color);
      grad.addColorStop(1, '#0b0812');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      g.fill();
    }
    this.glowCache.set(key, c);
    return c;
  }

  /** Cached radial-glow sprite (per color) — one gradient per color, ever. */
  private glow(color: string, size = 64): HTMLCanvasElement {
    const key = `${color}:${size}`;
    const hit = this.glowCache.get(key);
    if (hit) return hit;
    if (this.glowCache.size >= 512) this.glowCache.clear(); // bounded (plan §43)
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
   *  camera enters a galaxy so the close-up isn't fighting a wall of circles.
   *  VISIBILITY TEST (user 2026-09-29: "in the mini map it sometimes doesn't
   *  highlight the band as I move"): the old cull dropped a band as soon as the map
   *  ORIGIN left the canvas — in a small minimap that happens after a short pan even
   *  though the band's arc still crosses the frame, so the highlight vanished. The
   *  test is the proper annulus-vs-viewport one: does [rIn..rOut] around the origin
   *  overlap the visible disc? */
  private drawRings(deep: number): void {
    const ctx = this.ctx;
    // the band the player is BROWSING (chosen rank pill) is the one that reads
    // loud; the player's own band keeps a secondary lift so both are always legible
    const viewed = this.focusedRing();
    const fade = 1 - deep * 0.85;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const viewR = Math.hypot(cx, cy);
    for (let ring = 7; ring >= 0; ring--) {
      const vis = this.bandVisibility(ring);
      if (vis <= 0) continue;
      const hot = ring === viewed;
      const mine = ring === this.data.myRing;
      const rIn = ringInnerRadius(ring) * this.cam.zoom;
      const rOut = ringOuterRadius(ring) * this.cam.zoom;
      // sub-pixel bands are skipped — except the viewed one (and your own), which
      // keeps its highlight at any map size.
      if (rOut < (hot || mine ? 2 : 30)) continue;
      const p0 = this.world2screen(0, 0);
      const d = Math.hypot(p0.x - cx, p0.y - cy);
      if (d - viewR > rOut || d + viewR < rIn) continue; // annulus misses the viewport
      const rc = ringConfig(ring);
      ctx.save();
      ctx.beginPath();
      ctx.arc(p0.x, p0.y, rOut, 0, Math.PI * 2);
      ctx.arc(p0.x, p0.y, rIn, 0, Math.PI * 2, true);
      ctx.globalAlpha = (hot ? 0.16 : mine ? 0.1 : 0.05 + ring * 0.004) * fade * vis;
      ctx.fillStyle = rc.accent;
      ctx.fill('evenodd');
      ctx.restore();
      ctx.globalAlpha = (hot ? 0.35 : mine ? 0.2 : 0.12) * fade * vis;
      ctx.strokeStyle = rc.accent;
      ctx.lineWidth = hot ? 1.6 : 1;
      ctx.beginPath();
      ctx.arc(p0.x, p0.y, rOut, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // one label, for the BAND THE PLAYER IS BROWSING — pinned ON that band along the
    // direction from the core toward the viewport centre, so it stays visible however
    // the map is panned (a small minimap pans the origin off-screen quickly)
    // (user: "just say like 'BRONZE BAND' no need to say 'YOUR RING'")
    const cfg = ringConfig(viewed);
    const p0 = this.world2screen(0, 0);
    const rMid = ringCenterRadius(viewed) * this.cam.zoom;
    ctx.font = '700 11px Rajdhani, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = cfg.accent;
    ctx.globalAlpha = 0.85 * fade;
    const dx = cx - p0.x;
    const dy = cy - p0.y;
    const dl = Math.hypot(dx, dy);
    const ux = dl < 1 ? 0 : dx / dl;
    const uy = dl < 1 ? -1 : dy / dl;
    const text = `${cfg.name} BAND`;
    const half = Math.min(ctx.measureText(text).width / 2 + 8, this.width / 2);
    const lx = Math.min(this.width - half, Math.max(half, p0.x + ux * rMid));
    const ly = Math.min(this.height - 8, Math.max(20, p0.y + uy * rMid));
    ctx.fillText(text, lx, ly);
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
        // bands far outside the player's reach are not rendered at all (plan §2)
        const bandVis = this.bandVisibility(g.ring);
        if (bandVis <= 0) continue;
        const p = this.world2screen(g.gx, g.gy);
        if (p.x < -70 || p.x > this.width + 70 || p.y < -70 || p.y > this.height + 70) continue;
        const isFocus = this.lock.galaxy?.galaxyId === g.galaxyId;
        const isHover = this.hover.kind === 'galaxy' && this.hover.galaxy?.galaxyId === g.galaxyId;
        const radius = this.galaxyScreenRadius(g);
        // BREATHING (restored 2026-09-29 — the user missed the old life in the field):
        // every face and mote breathes in brightness (and a touch of size) at its own
        // phase, while spirals ALSO spin. The beat is SLOW (1.2 rad/s cycle).
        const pulse = 1 + 0.06 * Math.sin(t * 1.2 + (g.seed % 100));
        // THE GALAXY YOU ARE ENTERING (user 2026-09-29): it GROWS with the zoom like
        // its neighbours and thins to TRANSLUCENT as its solar systems open — the
        // ACTIVE galaxy keeps the same ghost as the rest (user 2026-09-29 v2: "the
        // active galaxy disappears when it should stay transparent").
        const inside = this.lock.sysAlpha;
        const withdraw = ramp01(inside, 0.2, 1.0);
        const field2 = field * bandVis * g.brightness;
        // ownership pre-filter (plan §33): far galaxies still show a coloured dot
        const owned = this.ownedIds.has(g.galaxyId);
        const terr = owned ? this.territoryForGalaxy(g.galaxyId) : null;
        // SEAMLESS DOT TRANSITION (user 2026-09-29: "as I zoom out the galaxies should
        // scale down and fade into dots instead of suddenly disappearing"): the face
        // and its mote CROSS-FADE over a screen-radius band — below it the mote stands
        // alone, above it the full face; in between the sprite shrinks toward the dot
        // while the mote rises out of nothing. Focused / hovered galaxies keep their
        // full face (they are what the player is looking at).
        const transit = isFocus || isHover ? 1 : ramp01(radius, GALAXY_DOT_RADIUS * 0.45, GALAXY_DOT_RADIUS * 1.25);
        if (transit < 1) {
          // past ~0.97 the mote contributes <3% of its glow — skipping the path is
          // invisible and saves hundreds of arcs per frame in the far field
          if (transit < 0.97) {
            ctx.globalAlpha = 0.78 * field2 * (0.75 + 0.25 * pulse) * (1 - inside * 0.5) * (1 - transit);
            ctx.fillStyle = terr?.color ?? g.starColor;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 1.15, 0, Math.PI * 2); // round dot (user 2026-09-29: no cubes)
            ctx.fill();
            ctx.globalAlpha = 1;
          }
          if (transit <= 0.03) continue; // a ≤3% face adds nothing — start/end cleanly
        }
        // near: the galaxy wears its OWN seeded face (halo, arms, star core baked in).
        // EVERY face now keeps growing with the zoom (user 2026-09-29: neighbours must grow
        // too, not just fade) — the fade ramp above is what retires them, and `haze` keeps
        // the very largest sprites from milking the frame. A 3000 px ceiling stops a
        // pathological sprite size at the deepest zooms.
        const faceMix = transit;
        // …and through the transition band the body extra-shortens (×0.22 at the dot
        // end) so the sprite visibly SHRINKS into the mote instead of a size pop
        const faceR = Math.min(radius * (0.22 + 0.78 * faceMix), 3000 / 3.1);
        const haze = radius <= 90 ? 1 : Math.max(0.15, 1 - (radius - 90) / 280);
        const s = faceR * 3.1 * pulse;
        ctx.globalAlpha =
          (0.2 + Math.min(0.58, radius / 34)) * pulse * field2 * haze * (1 - withdraw * 0.88) * faceMix;
        // the transition band never exceeds ~74px, so the 96px mip is always drawn at
        // ≤1:1 — no upscaling, no visible change (user: keep the seamless effect)
        const sprite = s <= SPRITE_MIP ? this.galaxySpriteSmall(g) : this.galaxySprite(g);
        if (g.morphology === 'SPIRAL' || g.morphology === 'BARRED_SPIRAL') {
          // SPIN (user): the spiral faces rotate at ONE shared angular speed — OPPOSITE
          // direction to the first pass — so the whole field turns as a single system.
          // Elliptical / irregular / ring faces stay put; everything else breathes.
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(-t * GALAXY_SPIN);
          ctx.drawImage(sprite, -s / 2, -s / 2, s, s);
          ctx.restore();
        } else {
          ctx.drawImage(sprite, p.x - s / 2, p.y - s / 2, s, s);
        }
        ctx.globalAlpha = 1;
        // ownership EMISSION tint (plan §13/§14/§33): the shape stays procedural, the
        // glow speaks politics. One owner → one halo; contested → offset multi-colour
        // clouds at each party's weight (never one forced owner).
        if (terr && terr.kind !== 'NONE' && faceR > 5) {
          const tintR = faceR * 1.7;
          if (terr.kind === 'CONTESTED') {
            const n = Math.min(3, terr.colors.length);
            for (let ci = 0; ci < n; ci++) {
              const ang = (ci / n) * Math.PI * 2 + g.rotation + t * 0.04;
              const ox = Math.cos(ang) * tintR * 0.45;
              const oy = Math.sin(ang) * tintR * 0.45;
              ctx.globalAlpha = 0.11 * field2 * (0.5 + terr.share[ci] * 0.5) * (1 - withdraw) * faceMix;
              ctx.drawImage(this.glow(terr.colors[ci], 64), p.x + ox - tintR, p.y + oy - tintR, tintR * 2, tintR * 2);
            }
          } else if (terr.color) {
            ctx.globalAlpha = 0.16 * field2 * (1 - withdraw) * faceMix;
            ctx.drawImage(this.glow(terr.color, 64), p.x - tintR, p.y - tintR, tintR * 2, tintR * 2);
            // GALAXY CORE GLOW (plan §17): the dominant owner's colour pools at the
            // core — brighter for the Necrophages (their red reads as an infection,
            // not a paint job). The morphology stays visible; only the light changes.
            const coreR = faceR * 0.85;
            ctx.globalAlpha = (terr.kind === 'NECROPHAGE' ? 0.5 : 0.3) * field2 * (1 - withdraw) * faceMix;
            ctx.drawImage(this.glow(terr.color, 64), p.x - coreR, p.y - coreR, coreR * 2, coreR * 2);
          }
          ctx.globalAlpha = 1;
        }
        // POI marker (plan §55) — attached to the FACE, so it retires with it in the
        // dot transition instead of floating over a mote
        if (g.poi !== 'NORMAL' && zoom > 16 && radius > 3.4 && faceMix > 0.35) {
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
        const nameA = ramp01(radius, 16, 28) * field;
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
      const vis = this.bandVisibility(ring);
      if (vis <= 0) continue;
      const rc = ringConfig(ring);
      const p0 = this.world2screen(0, 0);
      const rOut = ringOuterRadius(ring) * this.cam.zoom;
      if (rOut < 30) continue;
      ctx.globalAlpha = (ring === this.data.myRing ? 0.3 : 0.1) * edgeFade * vis;
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
      if (this.systemsCache.size >= 64) this.systemsCache.clear(); // bounded (plan §43)
      this.systemsCache.set(g.galaxyId, hit);
    }
    return hit;
  }

  private systemWorldPos(g: GalaxyDescriptor, sys: SystemDescriptor): { x: number; y: number } {
    return { x: g.gx + (sys.ux - 0.5) * GAL_DISC_WORLD, y: g.gy + (sys.uy - 0.5) * GAL_DISC_WORLD };
  }

  /** Per-galaxy system territory map, rebuilt lazily — NEVER per frame (plan §58). */
  private systemTerrCache = new Map<number, { at: number; map: Map<number, TerritoryVisual> }>();
  private systemTerrFor(g: GalaxyDescriptor): Map<number, TerritoryVisual> {
    const now = performance.now();
    const hit = this.systemTerrCache.get(g.galaxyId);
    if (hit && now - hit.at < 2500) return hit.map;
    const map = new Map<number, TerritoryVisual>();
    const rows = this.data.rowsForGalaxy(g.galaxyId);
    if (rows.length) {
      for (const sys of this.systemsFor(g)) {
        const vis = getTerritoryVisual(rows, this.data.colonyColors, sys.systemId);
        if (vis.kind !== 'NONE') map.set(sys.systemId, vis);
      }
    }
    if (this.systemTerrCache.size >= 16) this.systemTerrCache.clear(); // bounded (plan §43)
    this.systemTerrCache.set(g.galaxyId, { at: now, map });
    return map;
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
    // per-system ownership comes from the LAZY cache (plan §58): rows change on
    // match ends, never per frame, so this is at most one rebuild every ~2.5 s.
    const systemTerr = this.systemTerrFor(galaxy);
    // brighter / rounder motes: at galaxy-tier zoom the systems must read as a real
    // cluster of stars, not faint dust (user 2026-09-29: "some galaxies have no solar
    // systems" — the data was always there, the motes were simply too small to see)
    const baseR = Math.max(1.6, 0.075 * SYSTEM_SCALE * zoom);
    // the front system crossfades on the same sqrt curve as the planets layer
    const pa = Math.sqrt(planetAlpha);
    // (the inflated second copy of the galaxy face that used to live here is GONE:
    // the field layer already draws ONE galaxy sprite that grows and fades — the
    // double image was exactly the ghost the user reported, 2026-09-29.)
    for (const sys of this.systemsFor(galaxy)) {
      const w = this.systemWorldPos(galaxy, sys);
      const p = this.world2screen(w.x, w.y);
      if (p.x < -60 || p.x > this.width + 60 || p.y < -60 || p.y > this.height + 60) continue;
      const isHover = this.hover.kind === 'system' && this.hover.system?.systemId === sys.systemId;
      const isSel = this.selected?.type === 'system' && this.selected.system?.systemId === sys.systemId;
      const front = Boolean(system && sys.systemId === system.systemId);
      const twinkle = 0.85 + 0.15 * Math.sin(t * 2.2 + (sys.seed % 50));
      const r = baseR * twinkle;
      // when the solar system stage opens the OTHER systems recede — but only to distant
      // STARS, never to nothing (plan §6): the surrounding cluster stays readable while
      // one system grows underneath the crosshair.
      const a = sysAlpha * (front ? 1 - pa : 1 - pa * 0.55);
      if (a <= 0.02) continue;
      // LOD (user: "show all solar systems as light dots until I zoom in"): only the
      // system under the crosshair (or hovered/selected) carries detail — every other
      // system stays a light mote, which is also what keeps hundreds of them cheap.
      // OWNED systems keep their owner's colour even as motes (plan §33).
      const terr = systemTerr.get(sys.systemId);
      if (!front && !isHover && !isSel) {
        ctx.globalAlpha = 0.9 * a * twinkle;
        ctx.fillStyle = terr?.color ?? '#dfe9ff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.3, 0, Math.PI * 2); // round dot (user 2026-09-29: no cubes)
        ctx.fill();
        ctx.globalAlpha = 1;
        continue;
      }
      // star glow + core (the dot GROWS with zoom instead of a fixed 30px blob);
      // the GLOW carries ownership, the core stays the star (plan §33)
      const ss = r * 6;
      ctx.globalAlpha = 0.6 * a;
      if (terr?.kind === 'CONTESTED') {
        const n = Math.min(3, terr.colors.length);
        for (let ci = 0; ci < n; ci++) {
          const ang = (ci / n) * Math.PI * 2 + t * 0.3;
          ctx.globalAlpha = 0.3 * a * (0.5 + terr.share[ci] * 0.5);
          ctx.drawImage(this.glow(terr.colors[ci], 32), p.x + Math.cos(ang) * r * 1.4 - ss / 2, p.y + Math.sin(ang) * r * 1.4 - ss / 2, ss, ss);
        }
      } else {
        ctx.drawImage(this.glow(terr?.color ?? galaxy.starColor, 32), p.x - ss / 2, p.y - ss / 2, ss, ss);
      }
      ctx.globalAlpha = a;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.9, r), 0, Math.PI * 2);
      ctx.fill();

      // SYSTEM CONTROL RING (plan §18): ownership colour lives in the glow and this
      // ring — a single owner paints one ring in their colour, a contested system
      // gets a SEGMENTED ring in party colours (Necrophage red included), and the
      // star core stays white so the star keeps its identity.
      if (terr && r >= 2.4) {
        const ringR = Math.max(3.4, r * 2.4);
        const lw = Math.max(1.4, r * 0.35);
        if (terr.kind === 'CONTESTED') {
          const n = Math.min(3, terr.colors.length);
          let a0 = -Math.PI / 2;
          let remaining = 1;
          ctx.globalAlpha = a;
          for (let ci = 0; ci < n; ci++) {
            const take = ci === n - 1 ? remaining : terr.share[ci];
            remaining -= take;
            const a1 = a0 + take * Math.PI * 2;
            ctx.strokeStyle = terr.colors[ci];
            ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.arc(p.x, p.y, ringR, a0 + 0.06, a1 - 0.06);
            ctx.stroke();
            a0 = a1;
          }
          ctx.globalAlpha = 1;
        } else if (terr.color) {
          ctx.globalAlpha = 0.85 * a;
          ctx.strokeStyle = terr.color;
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
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
    if (this.planetsCache.size >= 128) this.planetsCache.clear(); // bounded (plan §43)
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
    const { galaxy, system, planetAlpha, closeAlpha } = this.lock;
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
      const isSel = this.selected?.planet?.key === p.key;
      const isHover = this.hover.kind === 'planet' && this.hover.planet?.key === p.key;
      // orbit position (animated) + body radius — both grow continuously with zoom
      const c = this.planetScreenCircle(galaxy, system, p, t);
      const px = c.x;
      const py = c.y;
      const pr = c.r;
      const orbitR = p.orbitRadius * SYSTEM_SCALE * zoom;

      // orbit path — the system's OWN plane (rotate, then flatten)
      ctx.globalAlpha = 0.16 * pa;
      ctx.strokeStyle = 'rgba(180,170,220,1)';
      ctx.lineWidth = 1;
      const plane = this.systemPlane(system);
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate(plane.rot);
      ctx.scale(1, plane.inc);
      ctx.beginPath();
      ctx.arc(0, 0, orbitR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;

      const bob = 1 + 0.04 * Math.sin(t * 1.6 + p.orbit);
      // atmosphere glow + body — both drawn from CACHED sprites (plan §42: no
      // per-frame gradient objects, the same lesson the glow cache already learned).
      // Ownership: controllers carve their colour into the glow; discovered-but-infested
      // planets glow NECROPHAGE RED (plan §13/§34).
      const ownerColor = planetOwnershipColor(row, this.data.colonyColors);
      const glowColor = ownerColor ?? p.biomeColor;
      ctx.globalAlpha = 0.6 * pa;
      ctx.drawImage(this.glow(glowColor, 48), px - pr * 3, py - pr * 3, pr * 6, pr * 6);
      // body
      ctx.globalAlpha = pa;
      const body = pr * 1.9 * bob;
      ctx.drawImage(this.bodySprite(p.biomeColor), px - body, py - body, body * 2, body * 2);
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
      // OWNERSHIP RING (plan §16): controlled planets wear their colony's ring and
      // infested-and-mapped worlds wear the Necrophage red ring; the BIOME body
      // colour underneath is never replaced. Contested does not exist at planet
      // level — a planet has exactly one owner (plan §12).
      if (ownerColor) {
        ctx.globalAlpha = 0.55 * pa;
        ctx.strokeStyle = ownerColor;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(px, py, pr + 3.4, 0, Math.PI * 2);
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
      // PLANETARY SHIELD (user ask 2026-09-29): a colony that HOLDS a planet keeps its 72 h ward
      // up — draw it as an energy bubble over the body in the COLONY'S colour. The countdown arc
      // above is the clock; this is the state.
      if (controlled && row.controlExpiresAt > nowUs && pr >= 4.5) {
        this.drawPlanetShield(px, py, pr, this.data.colonyColors[row.colony], t, pa);
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
      // name — only once the body has grown AND the close-up has opened (plan §11:
      // names are the last reveal), sized WITH it; sel/hover always names itself
      const nameA = isSel || isHover ? 1 : closeAlpha * ramp01(pr, 7, 13);
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

  /**
   * PLANETARY SHIELD (user ask 2026-09-29): a colony that HOLDS a planet keeps a 72-hour ward
   * around it — drawn as an energy bubble in the COLONY'S colour, wearing the same pattern as the
   * in-game Nexus shield: a bright fresnel rim, a scrolling lat/long energy lattice and
   * containment bands rising through it. Additive and purely visual — the countdown arc beside it
   * is the clock. Gated to bodies big enough to read (deep zoom only).
   */
  private drawPlanetShield(px: number, py: number, pr: number, color: string, t: number, alpha: number): void {
    const ctx = this.ctx;
    const R = pr * 1.55 + 3;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // fresnel rim: clear at the centre, the colony's colour gathering at the edge
    const grad = ctx.createRadialGradient(px, py, R * 0.12, px, py, R);
    grad.addColorStop(0, withAlpha(color, 0));
    grad.addColorStop(0.55, withAlpha(color, 0.05));
    grad.addColorStop(0.85, withAlpha(color, 0.14));
    grad.addColorStop(1, withAlpha(color, 0.3));
    ctx.globalAlpha = alpha;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, R, 0, Math.PI * 2);
    ctx.fill();
    // the energy lattice — the shader's own sin(a·14 + t·0.9)·sin(b·16 − t·0.6) grid, sampled into
    // a scrolling veil of bright cells (front hemisphere solid, the back a faint ghost)
    const LON = pr > 9 ? 26 : 16;
    const LAT = pr > 9 ? 13 : 9;
    const dot = Math.max(1, Math.min(2, pr * 0.1));
    ctx.fillStyle = withAlpha(color, 0.9);
    for (let i = 0; i < LON; i++) {
      const a = ((i + 0.5) / LON) * Math.PI * 2;
      const front = Math.sin(a) > 0;
      for (let j = 0; j < LAT; j++) {
        const b = -Math.PI / 2 + ((j + 0.5) / LAT) * Math.PI;
        const v = Math.sin(a * 14 + t * 0.9) * Math.sin(b * 16 - t * 0.6);
        if (v < 0.35) continue;
        const sx = px + Math.cos(a) * Math.cos(b) * R;
        const sy = py - Math.sin(b) * R;
        ctx.globalAlpha = alpha * (front ? 0.5 : 0.12) * ((v - 0.35) / 0.65);
        ctx.beginPath();
        ctx.arc(sx, sy, dot / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // containment bands rising through the bubble (the shader's fract(l.y·5 − t·0.12) rings)
    for (let k = 0; k < 3; k++) {
      const ph = (t * 0.115 + k / 3) % 1;
      const yb = -1 + 2 * ph;
      const bb = Math.asin(Math.max(-0.97, Math.min(0.97, yb)));
      const rr = Math.cos(bb) * R;
      if (rr < 2) continue;
      ctx.globalAlpha = alpha * 0.3 * Math.sin(Math.PI * ph);
      ctx.strokeStyle = withAlpha(color, 0.9);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(px, py - Math.sin(bb) * R, rr, rr * 0.34, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // the rim itself, brighter than the fill
    ctx.globalAlpha = alpha * 0.7;
    ctx.strokeStyle = withAlpha(color, 0.85);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(px, py, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * DEBUG OVERLAY (plan §39, opened with `?rankDebug=1`): ring bounds, galaxy bounds and
   * rotation, morphology parameters, arm spines, raw system points, ownership, LOD state
   * and seeds — everything needed to see a distribution problem at a glance. A healthy
   * galaxy reads A (bright bulge + arms); a broken one reads B (uniform dust).
   */
  private drawDebug(t: number): void {
    const ctx = this.ctx;
    const zoom = this.cam.zoom;
    const lock = this.lock;
    ctx.save();
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    // ---- ring bounds (dashed mid-band circles, labelled)
    for (let ring = 0; ring < 8; ring++) {
      const p0 = this.world2screen(0, 0);
      const rMid = ringCenterRadius(ring) * zoom;
      if (rMid < 24 || rMid > this.width * 4) continue;
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = ringConfig(ring).accent;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(p0.x, p0.y, rMid, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ringConfig(ring).accent;
      ctx.fillText(`R${ring} [${ringInnerRadius(ring)}..${ringOuterRadius(ring)}]`, p0.x, p0.y - rMid - 3);
    }
    ctx.globalAlpha = 1;
    // ---- galaxies: true disc bounds, rotation tick, morphology, seeds, system points, arm spines
    const pad = 90 / zoom;
    const minW = this.screen2world(-pad, -pad);
    const maxW = this.screen2world(this.width + pad, this.height + pad);
    let systemBudget = 6;
    const gx0 = Math.floor(minW.x);
    const gx1 = Math.ceil(maxW.x);
    const gy0 = Math.floor(minW.y);
    const gy1 = Math.ceil(maxW.y);
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const g = this.galaxyAtCached(gx, gy);
        if (!g || this.bandVisibility(g.ring) <= 0) continue;
        const p = this.world2screen(g.gx, g.gy);
        const discR = (GAL_DISC_WORLD / 2) * zoom;
        if (p.x < -discR || p.x > this.width + discR || p.y < -discR || p.y > this.height + discR) continue;
        // true disc bounds + rotation tick
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = '#55ddff';
        ctx.beginPath();
        ctx.arc(p.x, p.y, discR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + Math.cos(g.rotation) * discR, p.y + Math.sin(g.rotation) * discR);
        ctx.stroke();
        // morphology parameters + identity
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#9fe8ff';
        ctx.fillText(`${g.morphology} arms:${g.armCount} tight:${g.armTightness.toFixed(1)} bulge:${g.bulgeStrength.toFixed(2)} ar:${g.axisRatio.toFixed(1)} br:${g.brightness.toFixed(2)}`, p.x, p.y - discR - 16);
        ctx.fillStyle = '#ffbb77';
        ctx.fillText(`${g.name} id:${g.galaxyId} seed:${g.seed.toString(16)} sys:${g.systemCount} R${g.ring}`, p.x, p.y - discR - 5);
        if (this.ownedIds.has(g.galaxyId)) {
          const terr = this.territoryForGalaxy(g.galaxyId);
          ctx.fillStyle = terr.color ?? '#ffffff';
          ctx.fillText(`own:${terr.kind}${terr.color ? ` ${terr.color}` : ''}`, p.x, p.y + discR + 12);
        }
        // raw system points + arm spines for the galaxies big enough to inspect
        if (this.galaxyScreenRadius(g) > 26 && systemBudget > 0) {
          systemBudget--;
          const sys = this.systemsFor(g);
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = '#ffffff';
          for (const s of sys) {
            const wp = this.systemWorldPos(g, s);
            const sp = this.world2screen(wp.x, wp.y);
            if (sp.x < 0 || sp.x > this.width || sp.y < 0 || sp.y > this.height) continue;
            ctx.fillRect(sp.x - 0.8, sp.y - 0.8, 1.6, 1.6);
          }
          // arm spines (plan §39 "show galaxy arms"): the actual spiral the generator used
          if (g.armCount > 0) {
            ctx.globalAlpha = 0.55;
            ctx.strokeStyle = '#ff9de0';
            ctx.beginPath();
            for (let arm = 0; arm < g.armCount; arm++) {
              for (let k = 0; k <= 24; k++) {
                const rr = (k / 24) * 0.46;
                const ang = g.rotation + (arm / g.armCount) * Math.PI * 2 + rr * g.armTightness * Math.PI;
                const wx = g.gx + Math.cos(ang) * rr * GAL_DISC_WORLD;
                const wy = g.gy + Math.sin(ang) * rr * GAL_DISC_WORLD;
                const sx = this.world2screen(wx, wy);
                if (k === 0) ctx.moveTo(sx.x, sx.y);
                else ctx.lineTo(sx.x, sx.y);
              }
            }
            ctx.stroke();
          }
        }
      }
    }
    ctx.globalAlpha = 1;
    // ---- LOD / state HUD
    const r = lock.ranges;
    const focus = lock.galaxy;
    const lines = [
      `zoom ${zoom.toFixed(1)}  level ${this.level}  viewed R${this.focusedRing()}  my R${this.data.myRing}`, 
      `alphas sys ${lock.sysAlpha.toFixed(2)} planet ${lock.planetAlpha.toFixed(2)} close ${lock.closeAlpha.toFixed(2)}`, 
      `ramps gal ${r.gal.toFixed(0)} sys ${r.sysStart.toFixed(0)}..${r.sysEnd.toFixed(0)} pl ${r.plStart.toFixed(0)}..${r.plEnd.toFixed(0)} close ${r.closeStart.toFixed(0)}..${r.closeEnd.toFixed(0)}`, 
      `LOD galaxy<${GALAXY_DOT_RADIUS}px  owned ${this.ownedIds.size}  sprites ${this.galaxySprites.size}  memo ${this.galaxyMemo.size}  systems ${this.systemsCache.size}`, 
      focus ? `focus ${focus.name} ${focus.morphology} seed:${focus.seed.toString(16)} systems:${focus.systemCount}` : 'focus —', 
    ];
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(6,4,14,0.78)';
    ctx.fillRect(6, 6, 470, 12 * lines.length + 10);
    ctx.fillStyle = '#bfffd0';
    lines.forEach((line, i) => ctx.fillText(line, 12, 20 + i * 12));
    ctx.restore();
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
        // PINCH (plan §49): a two-pointer gesture NEVER selects — it owns the
        // camera zoom from here, and both fingers' lifts are swallowed below.
        const [a, b] = [...this.pointers.values()];
        this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.cam.zoom };
        this.drag = null;
        this.camTarget = null; // a pinch owns the camera from here
        return;
      }
      // TOUCH SLOP (plan §20): a finger wobbles — 10px there, 5px with a mouse.
      // `moved` is measured with hypot(), not |dx|+|dy|, so a diagonal micro-drag
      // does not cancel a tap.
      this.drag = {
        x: e.offsetX,
        y: e.offsetY,
        camx: this.cam.x,
        camy: this.cam.y,
        moved: false,
        slop: e.pointerType === 'mouse' ? 5 : 10,
      };
      this.camTarget = null;
    });
    el.addEventListener('pointermove', (e) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        // zoom TOWARD the pinch midpoint (plan §8) — or toward the SOFT-LOCKED TARGET when one is
        // locked (user ask 2026-09-29: "while zooming, zoom into the soft locked target without
        // changing targets"): the anchor keeps the target under the same screen point as the
        // scale changes, and the lock is frozen for the gesture so it can never slide to a
        // neighbour mid-pinch.
        this.holdSoftLock();
        const anchor = this.zoomAnchor((a.x + b.x) / 2, (a.y + b.y) / 2);
        const before = this.screen2world(anchor.x, anchor.y);
        this.cam.zoom = Math.max(4, Math.min(1700, (this.pinch.zoom * d) / Math.max(1, this.pinch.dist)));
        const after = this.screen2world(anchor.x, anchor.y);
        this.cam.x += before.x - after.x;
        this.cam.y += before.y - after.y;
        // SYSTEM LOCK (plan §27): a pinch may not escape the system either.
        this.clampCameraToSystem();
        return;
      }
      if (this.drag) {
        const dx = e.offsetX - this.drag.x;
        const dy = e.offsetY - this.drag.y;
        if (!this.drag.moved) {
          // Below the slop the gesture is still a TAP candidate — the camera
          // must not jitter (plan §20/§48: small finger movement ≠ pan).
          if (Math.hypot(dx, dy) <= this.drag.slop) return;
          this.drag.moved = true;
          // RE-AIM (user ask 2026-09-29): a real pan at the DOT level releases the system pin,
          // so the soft lock follows the crosshair and dragging CAN change solar systems again.
          // Inside the visible band the pin stays: the drag is clamped to the system instead.
          if (this.lock.planetAlpha <= 0.02) this.pinnedSystem = null;
        }
        this.cam.x = this.drag.camx - dx / this.cam.zoom;
        this.cam.y = this.drag.camy - dy / this.cam.zoom;
        // SYSTEM LOCK (plan §24): the drag is clamped inside the current system.
        this.clampCameraToSystem();
        return;
      }
      this.updateHover(e.offsetX, e.offsetY);
    });
    const endPointer = (e: PointerEvent): void => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      // TAP (plan §48): only a press that did not travel past the slop selects.
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
        this.holdSoftLock();
        const anchor = this.zoomAnchor(e.offsetX, e.offsetY);
        const before = this.screen2world(anchor.x, anchor.y);
        this.cam.zoom = Math.max(4, Math.min(1700, this.cam.zoom * factor));
        const after = this.screen2world(anchor.x, anchor.y);
        this.cam.x += before.x - after.x;
        this.cam.y += before.y - after.y;
        this.camTarget = null;
        // SYSTEM LOCK (plan §28): clamp the camera, NEVER the zoom — zooming out
        // is how the player escapes the lock.
        this.clampCameraToSystem();
      },
      { passive: false }
    );
  }

  private hitTest(sx: number, sy: number): Hover {
    const lock = this.lock;
    // planets first — the front-most tier once its ramp has opened. The NEAREST
    // candidate wins: orbit rings can overlap, and "first match" picked the wrong
    // planet when two sat close together.
    if (lock.planetAlpha > 0.25 && lock.galaxy && lock.system) {
      const t = (performance.now() - this.t0) / 1000;
      let bestP: PlanetDescriptor | null = null;
      let bestD = Infinity;
      for (const p of this.planetsFor(lock.system)) {
        const c = this.planetScreenCircle(lock.galaxy, lock.system, p, t);
        const d = (sx - c.x) ** 2 + (sy - c.y) ** 2;
        if (d <= (c.r + 9) ** 2 && d < bestD) {
          bestD = d;
          bestP = p;
        }
      }
      if (bestP) return { kind: 'planet', planet: bestP, sx, sy };
    }
    // systems of the locked galaxy — nearest candidate again, so a dense cluster
    // never makes a tap select the "first in generation order" neighbour.
    if (lock.sysAlpha > 0.25 && lock.galaxy) {
      const baseR = Math.max(1.4, 0.06 * SYSTEM_SCALE * this.cam.zoom);
      const r = Math.max(10, baseR * 3);
      let bestS: SystemDescriptor | null = null;
      let bestD = Infinity;
      for (const sys of this.systemsFor(lock.galaxy)) {
        const w = this.systemWorldPos(lock.galaxy, sys);
        const p = this.world2screen(w.x, w.y);
        const d = (sx - p.x) ** 2 + (sy - p.y) ** 2;
        if (d <= r * r && d < bestD) {
          bestD = d;
          bestS = sys;
        }
      }
      if (bestS) return { kind: 'system', system: bestS, sx, sy };
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

  /**
   * TAP (plan §19/§22/§47): SELECT the tapped location — the camera does NOT
   * move. A SECOND tap on the already-selected galaxy/system enters it (the
   * dedicated "fly" affordance); an empty-space tap clears the selection
   * without recentring (plan §51).
   */
  private clickAt(sx: number, sy: number): void {
    const hit = this.hitTest(sx, sy);
    if (hit.kind === 'galaxy' && hit.galaxy) {
      if (this.selected?.type === 'galaxy' && this.selected.galaxy.galaxyId === hit.galaxy.galaxyId) {
        this.flyToGalaxy(hit.galaxy); // 2nd tap: enter
        return;
      }
      this.selectGalaxy(hit.galaxy);
    } else if (hit.kind === 'system' && hit.system) {
      const g = this.lock.galaxy ?? this.focusGalaxy;
      if (!g) return;
      // NO CROSS-SYSTEM TAP while the current solar system is VISIBLE (user ask 2026-09-29): the
      // open system owns the lock, so a tap can never jump the target onto a neighbour. At the
      // dot level every system stays tappable (that is how you re-aim before entering one).
      if (this.lock.planetAlpha > 0.02 && hit.system.systemId !== (this.lock.system?.systemId ?? -1)) return;
      if (this.selected?.type === 'system' && this.selected.system?.systemId === hit.system.systemId) {
        this.flyToSystem(g, hit.system); // 2nd tap: enter
        return;
      }
      this.selectSystem(g, hit.system);
    } else if (hit.kind === 'planet' && hit.planet) {
      this.selectPlanet(hit.planet);
    } else {
      this.clearSelection();
    }
  }

  private selectGalaxy(g: GalaxyDescriptor): void {
    this.selected = { type: 'galaxy', galaxy: g };
    this.emitSelection();
  }

  private selectSystem(g: GalaxyDescriptor, sys: SystemDescriptor): void {
    this.selected = { type: 'system', galaxy: g, system: sys };
    // TARGET LOCK (user 2026-09-29): the tapped system stays the focus while zooming.
    this.pinnedSystem = sys;
    this.emitSelection();
  }

  /** Zoom around the soft-locked target when one is locked, else the viewport centre (the ± buttons). */
  zoomStep(factor: number): void {
    this.holdSoftLock();
    const anchor = this.zoomAnchor(this.width / 2, this.height / 2);
    const before = this.screen2world(anchor.x, anchor.y);
    this.cam.zoom = Math.max(4, Math.min(1700, this.cam.zoom * factor));
    const after = this.screen2world(anchor.x, anchor.y);
    // With no lock the anchor IS the centre → the shift is zero (the classic centre zoom).
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.camTarget = null;
    this.clampCameraToSystem();
  }

  /** Mark a system as selected without entering (panel-driven jumps / planet list). */
  markSystem(sys: SystemDescriptor | null): void {
    if (!sys) {
      if (this.selected?.type !== 'planet') this.clearSelection();
      return;
    }
    const { gx, gy } = decodeGalaxyId(sys.galaxyId);
    const g = this.focusGalaxy ?? galaxyAt(this.data.universeSeed, gx, gy);
    if (!g) return;
    // The caller is jumping INTO this system (panel action) — pin it so the
    // system drag lock is armed the moment the approach opens the tier.
    this.pinnedSystem = sys;
    this.selectSystem(g, sys);
  }

  /**
   * The world point a zoom step should grow around. While a system is soft-locked (and its tier
   * is on screen) the anchor IS that system (user ask 2026-09-29: "while zooming, zoom into the
   * soft locked target without changing targets") — the target stays under the same screen point
   * as the scale changes, which also keeps the nearest-to-centre scan on it (the anchored system
   * is provably never overtaken: for every other system P, |k·(P−C)−(k−1)·(A−C)| ≥ |A−C|). With
   * no lock the pointer / pinch midpoint owns the anchor, exactly as before.
   */
  private zoomAnchor(px: number, py: number): { x: number; y: number } {
    const { system, galaxy, sysAlpha } = this.lock;
    if (system && galaxy && sysAlpha > 0.04) {
      const w = this.systemWorldPos(galaxy, system);
      return this.world2screen(w.x, w.y);
    }
    return { x: px, y: py };
  }

  /**
   * Freeze the current soft lock through a zoom gesture: with the target pinned, no amount of
   * scaling can slide the lock onto a neighbour (the release rules live in `updateSoftFocus` and
   * the pointer-drag re-aim — dragging at the dot level is how the player re-targets).
   */
  private holdSoftLock(): void {
    const { system, galaxy, sysAlpha } = this.lock;
    if (!system || !galaxy || sysAlpha <= 0.04) return;
    if (!this.pinnedSystem || this.pinnedSystem.galaxyId !== galaxy.galaxyId) this.pinnedSystem = system;
  }

  // ------------------------------------------------------------ system drag lock (plan §23–§28)

  /**
   * The camera may not leave the CURRENT solar system while it is VISIBLE (user ask 2026-09-29:
   * "once the solar system is visible, don't allow drag to go to a different solar system"). The
   * clamp used to run only at `level === 'system'`, which left the first slice of the planet ramp
   * (planetAlpha 0…0.52 — planets already drawn, tier flag still 'galaxy') free to pan away. The
   * bound is the viewport itself: the star may sit near an edge — always still on screen — so any
   * planet can be brought anywhere you like. Scripted flights are exempt.
   */
  private clampCameraToSystem(): void {
    if (this.camTarget) return;
    if (this.lock.planetAlpha <= 0.02) return;
    const sys = this.focusSystem ?? this.pinnedSystem;
    const gal = this.focusGalaxy ?? this.lock.galaxy;
    if (!sys || !gal) return;
    const sw = this.systemWorldPos(gal, sys);
    const radius = this.systemClampRadius(gal, sys);
    const halfW = this.width / (2 * this.cam.zoom);
    const halfH = this.height / (2 * this.cam.zoom);
    // 82% of a half-viewport: the star stays visible with a margin, the drag is free.
    const limitX = Math.max(radius * 0.55, halfW * 0.82);
    const limitY = Math.max(radius * 0.55, halfH * 0.82);
    this.cam.x = softBound(this.cam.x, sw.x, limitX, 0);
    this.cam.y = softBound(this.cam.y, sw.y, limitY, 0);
  }

  /**
   * World-space radius the camera roams (plan §25): the outermost planet orbit
   * plus a little space. The clamp subtracts the viewport half extents, so the
   * system can never slide off screen and a small map still allows a real drag.
   */
  private systemClampRadius(g: GalaxyDescriptor, sys: SystemDescriptor): number {
    const key = sys.systemId * 4096 + (g.galaxyId % 4096);
    const hit = this.systemBoundsCache.get(key);
    if (hit !== undefined) return hit;
    let outer = 0;
    for (const p of this.planetsFor(sys)) outer = Math.max(outer, p.orbitRadius);
    const radius = outer * SYSTEM_SCALE * 1.35 + 0.22;
    if (this.systemBoundsCache.size >= 64) this.systemBoundsCache.clear(); // bounded (plan §43)
    this.systemBoundsCache.set(key, radius);
    return radius;
  }
}
