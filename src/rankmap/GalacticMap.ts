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
import { galaxiesInView, planetsInSystem, ringHome } from './procedural/UniverseGenerator';
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

const GAL_DISC_WORLD = 3.0; // galaxy disc diameter in world units
const SYSTEM_SCALE = 0.62; // system local (unit) space → world units
const MAX_VIEW_GALAXIES = 380;

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
  private camTarget: Camera | null = null;
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
    this.enterGalaxy(g, true);
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
    if (this.level === 'system') {
      this.level = 'galaxy';
      this.focusSystem = null;
      this.selectedPlanet = null;
      const g = this.focusGalaxy;
      if (g) this.enterGalaxy(g, false);
      this.onSelect({ level: 'galaxy', galaxy: g, system: null, planet: null });
    } else if (this.level === 'galaxy') {
      const left = this.focusGalaxy;
      this.level = 'galactic';
      this.focusGalaxy = null;
      this.focusSystem = null;
      this.selectedPlanet = null;
      // Zoom back OUT to the ring band around the galaxy we just left — staying at
      // galaxy zoom made the map read as one giant disc (user report 2026-09-28).
      if (left) this.camTarget = { x: left.gx, y: left.gy, zoom: this.ringViewZoom(left.ring) };
      this.onSelect({ level: 'galactic', galaxy: null, system: null, planet: null });
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

  private enterGalaxy(g: GalaxyDescriptor, announce: boolean): void {
    this.level = 'galaxy';
    this.focusGalaxy = g;
    this.focusSystem = null;
    this.selectedPlanet = null;
    this.camTarget = { x: g.gx, y: g.gy, zoom: this.fitZoom(GAL_DISC_WORLD * 2.4) };
    if (announce) this.onSelect({ level: 'galaxy', galaxy: g, system: null, planet: null });
  }

  private enterSystem(sys: SystemDescriptor): void {
    this.level = 'system';
    this.focusSystem = sys;
    this.selectedPlanet = null;
    const g = this.focusGalaxy;
    if (g) {
      const wx = g.gx + (sys.ux - 0.5) * GAL_DISC_WORLD;
      const wy = g.gy + (sys.uy - 0.5) * GAL_DISC_WORLD;
      this.camTarget = { x: wx, y: wy, zoom: this.fitZoom(SYSTEM_SCALE * 2.5) };
    }
    this.onSelect({ level: 'system', galaxy: g, system: sys, planet: null });
  }

  // ------------------------------------------------------------ animation

  private step(now: number): void {
    const t = (now - this.t0) / 1000;
    if (this.camTarget) {
      const k = 1 - Math.pow(0.0016, 1 / 60);
      this.cam.x += (this.camTarget.x - this.cam.x) * k;
      this.cam.y += (this.camTarget.y - this.cam.y) * k;
      this.cam.zoom += (this.camTarget.zoom - this.cam.zoom) * k;
      if (Math.abs(this.camTarget.x - this.cam.x) < 0.002 && Math.abs(this.camTarget.zoom - this.cam.zoom) < 0.01) {
        this.cam.x = this.camTarget.x;
        this.cam.y = this.camTarget.y;
        this.cam.zoom = this.camTarget.zoom;
        this.camTarget = null;
      }
    }
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
    if (this.level === 'galactic') this.drawGalactic(t);
    else if (this.level === 'galaxy') this.drawGalaxyLevel(t);
    else this.drawSystemLevel(t);
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
    const px = -this.cam.x * 8;
    const py = -this.cam.y * 8;
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

  // ------------------------------------------------------------ galactic level

  private drawGalactic(t: number): void {
    const ctx = this.ctx;
    const cfg = ringConfig(this.data.myRing);

    // ---- ring bands (plan §1): soft concentric bands around the CENTER.
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
      ctx.globalAlpha = ring === this.data.myRing ? 0.16 : 0.05 + ring * 0.004;
      ctx.fillStyle = rc.accent;
      ctx.fill('evenodd');
      ctx.restore();
      // band edges
      ctx.globalAlpha = ring === this.data.myRing ? 0.35 : 0.12;
      ctx.strokeStyle = rc.accent;
      ctx.lineWidth = ring === this.data.myRing ? 1.6 : 1;
      ctx.beginPath();
      ctx.arc(p0.x, p0.y, rOut, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ---- label for the player's ring at the top of its band
    {
      const p0 = this.world2screen(0, 0);
      const rMid = (this.data.myRing * RING_WIDTH_CELLS + RING_WIDTH_CELLS / 2) * this.cam.zoom;
      ctx.font = '700 11px Rajdhani, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = cfg.accent;
      ctx.globalAlpha = 0.85;
      const ly = Math.max(24, p0.y - rMid);
      ctx.fillText(`${cfg.name} BAND — YOUR RING`, p0.x, ly);
      ctx.globalAlpha = 1;
    }

    // ---- galaxies in view
    const pad = 80 / this.cam.zoom;
    const minW = this.screen2world(-pad, -pad);
    const maxW = this.screen2world(this.width + pad, this.height + pad);
    const galaxies = galaxiesInView(this.data.universeSeed, minW.x, maxW.x, minW.y, maxW.y, MAX_VIEW_GALAXIES);
    const zoom = this.cam.zoom;
    const spriteScale = Math.max(14, zoom * 0.5);

    for (const g of galaxies) {
      const p = this.world2screen(g.gx, g.gy);
      const isFocus = this.focusGalaxy?.galaxyId === g.galaxyId;
      const isHover = this.hover.kind === 'galaxy' && this.hover.galaxy?.galaxyId === g.galaxyId;
      // A galaxy is a STAR here (≈0.5 world cells): the old 0.055 factor drew every galaxy
      // at full disc scale, so an overview frame became overlapping bokeh (user report).
      const radius = Math.max(3, g.radius * 0.012 * zoom);
      const pulse = 1 + 0.06 * Math.sin(t * 2 + g.seed % 100);
      // nebula underlay (kept subtle: at ring-overview zoom the sprites overlap, and the
      // old 7×/0.16 values washed the whole canvas into one pastel blur — user report)
      if (g.nebulaColor) {
        ctx.globalAlpha = 0.1;
        const n = this.glow(g.nebulaColor, 128);
        const ns = radius * 4.5 * pulse;
        ctx.drawImage(n, p.x - ns / 2, p.y - ns / 2, ns, ns);
        ctx.globalAlpha = 1;
      }
      // star glow
      const sprite = this.glow(g.starColor, 64);
      const ss = Math.max(radius * 3.2, spriteScale);
      ctx.globalAlpha = 0.72;
      ctx.drawImage(sprite, p.x - ss / 2, p.y - ss / 2, ss, ss);
      ctx.globalAlpha = 1;
      // core
      ctx.fillStyle = g.starColor;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1.4, radius * 0.42 * pulse), 0, Math.PI * 2);
      ctx.fill();
      // POI marker (plan §55)
      if (g.poi !== 'NORMAL' && zoom > 16) {
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = g.poi === 'SWARM' || g.poi === 'DEAD' ? '#ff5d73' : g.poi === 'STRONGHOLD' ? '#ffd166' : '#7be0c8';
        ctx.font = '9px Rajdhani, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(g.poi === 'SWARM' ? '☣' : g.poi === 'DEAD' ? '✝' : g.poi === 'STRONGHOLD' ? '⚑' : '✦', p.x, p.y - radius - 3);
        ctx.globalAlpha = 1;
      }
      // selection / hover ring
      if (isFocus || isHover) {
        const rr = radius * 2.1 + Math.sin(t * 3) * 1.5;
        ctx.strokeStyle = isFocus ? '#ffffff' : 'rgba(255,255,255,0.55)';
        ctx.lineWidth = isFocus ? 1.8 : 1.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      // name for big zoom or focus
      if (zoom > 26 || isFocus) {
        ctx.font = '600 10px Rajdhani, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(233,226,255,0.9)';
        ctx.fillText(g.name.toUpperCase(), p.x, p.y + radius + 12);
      }
    }

    // ---- player home marker
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

  private drawGalaxyLevel(t: number): void {
    const g = this.focusGalaxy;
    if (!g) return;
    const ctx = this.ctx;
    const center = this.world2screen(g.gx, g.gy);
    const discR = (GAL_DISC_WORLD / 2) * this.cam.zoom;

    // disc glow + nebula
    ctx.globalAlpha = 0.85;
    const sprite = this.glow(g.starColor, 128);
    ctx.drawImage(sprite, center.x - discR * 1.6, center.y - discR * 1.6, discR * 3.2, discR * 3.2);
    if (g.nebulaColor) {
      const n = this.glow(g.nebulaColor, 128);
      ctx.globalAlpha = 0.22;
      const drift = Math.sin(t * 0.4) * discR * 0.05;
      ctx.drawImage(n, center.x - discR * 1.2 + drift, center.y - discR * 1.2 - drift, discR * 2.4, discR * 2.4);
    }
    ctx.globalAlpha = 1;
    // spiral arms
    ctx.save();
    ctx.strokeStyle = g.starColor;
    ctx.globalAlpha = 0.14;
    for (let arm = 0; arm < 2; arm++) {
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const a = (i / 40) * 2.4 + arm * Math.PI + t * 0.02;
        const r = (i / 40) * discR * 0.9;
        const x = center.x + Math.cos(a) * r;
        const y = center.y + Math.sin(a) * r * 0.72;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // systems
    const rows = this.data.rowsForGalaxy(g.galaxyId);
    for (const sys of this.systemsFor(g)) {
      const w = this.systemWorldPos(g, sys);
      const p = this.world2screen(w.x, w.y);
      const isHover = this.hover.kind === 'system' && this.hover.system?.systemId === sys.systemId;
      const isSel = this.selectedSystem?.systemId === sys.systemId;
      const twinkle = 0.8 + 0.2 * Math.sin(t * 2.2 + sys.seed % 50);
      const ss = Math.max(8, 30 * twinkle);
      ctx.globalAlpha = 0.75;
      ctx.drawImage(this.glow(g.starColor, 32), p.x - ss / 2, p.y - ss / 2, ss, ss);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
      ctx.fill();

      // colony control ring segments in this system (plan §41)
      const systemRows = rows.filter((r) => r.systemId === sys.systemId && r.state === RANKED_PLANET_CONTROLLED && r.colony < 3);
      if (systemRows.length) {
        const per = [0, 0, 0];
        for (const r of systemRows) per[r.colony]++;
        const total = systemRows.length;
        let a0 = -Math.PI / 2;
        for (let c = 0; c < 3; c++) {
          if (!per[c]) continue;
          const a1 = a0 + (per[c] / total) * Math.PI * 2;
          ctx.strokeStyle = this.data.colonyColors[c];
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 9, a0 + 0.06, a1 - 0.06);
          ctx.stroke();
          a0 = a1;
        }
      }

      if (isHover || isSel) {
        ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 13 + Math.sin(t * 3) * 1.2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.font = '600 10px Rajdhani, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(233,226,255,0.95)';
        ctx.fillText(sys.name.toUpperCase(), p.x, p.y - 18);
      }
    }

    // outer label
    ctx.font = '700 12px Rajdhani, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(233,226,255,0.85)';
    ctx.fillText(`${g.name.toUpperCase()} · ${g.starType.replace('_', ' ')} · ${g.systemCount} SYSTEMS`, center.x, center.y + discR * 1.45);
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

  private drawSystemLevel(t: number): void {
    const g = this.focusGalaxy;
    const sys = this.focusSystem;
    if (!g || !sys) return;
    const ctx = this.ctx;
    const w = this.systemWorldPos(g, sys);
    const center = this.world2screen(w.x, w.y);
    const zoom = this.cam.zoom;

    // system star
    const starR = Math.max(6, 0.12 * SYSTEM_SCALE * zoom);
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.glow(g.starColor, 128), center.x - starR * 4, center.y - starR * 4, starR * 8, starR * 8);
    ctx.globalAlpha = 1;
    ctx.fillStyle = g.starColor;
    ctx.beginPath();
    ctx.arc(center.x, center.y, starR, 0, Math.PI * 2);
    ctx.fill();

    const rows = this.data.rowsForGalaxy(g.galaxyId);
    const reserved = this.data.reservedKeys();
    const nowUs = this.data.serverNowUs();
    const planets = this.planetsFor(sys);

    for (const p of planets) {
      const row = rows.find((r) => r.planetKey === p.key);
      const controlled = row?.state === RANKED_PLANET_CONTROLLED && row.colony < 3;
      const isReserved = reserved.has(p.key);
      const isSel = this.selectedPlanet?.key === p.key;
      const isHover = this.hover.kind === 'planet' && this.hover.planet?.key === p.key;
      // orbit position (animated)
      const speed = 0.05 / (0.4 + p.orbitRadius);
      const angle = p.orbit + t * speed;
      const orbitR = p.orbitRadius * SYSTEM_SCALE * zoom;
      const px = center.x + Math.cos(angle) * orbitR;
      const py = center.y + Math.sin(angle) * orbitR * 0.86;

      // orbit path
      ctx.strokeStyle = 'rgba(180,170,220,0.14)';
      ctx.lineWidth = 1;
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.scale(1, 0.86);
      ctx.beginPath();
      ctx.arc(0, 0, orbitR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      const pr = Math.max(3.5, p.radius * 5 * Math.min(3, zoom / 60));
      const bob = 1 + 0.04 * Math.sin(t * 1.6 + p.orbit);
      // atmosphere glow
      const glowColor = controlled ? this.data.colonyColors[row.colony] : p.biomeColor;
      ctx.globalAlpha = 0.55;
      ctx.drawImage(this.glow(glowColor, 48), px - pr * 3, py - pr * 3, pr * 6, pr * 6);
      ctx.globalAlpha = 1;
      // body
      const grad = ctx.createRadialGradient(px - pr * 0.35, py - pr * 0.35, pr * 0.1, px, py, pr);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.25, p.biomeColor);
      grad.addColorStop(1, '#0b0812');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, pr * bob, 0, Math.PI * 2);
      ctx.fill();
      if (row?.discovered && !controlled) {
        ctx.strokeStyle = 'rgba(123,232,255,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, pr + 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      // shield arc (plan §39): colony ring drains with the 72 h countdown
      if (controlled && row.controlExpiresAt > 0) {
        const remain = Math.max(0, row.controlExpiresAt - nowUs);
        const total = 72 * 3600 * 1e6;
        const frac = Math.min(1, remain / total);
        const low = remain < 10 * 60 * 1e6;
        const alpha = low ? 0.55 + 0.45 * Math.sin(t * 6) : 1;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = this.data.colonyColors[row.colony];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, pr + 4.5, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (isReserved && !controlled) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(px, py, pr + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (isSel || isHover) {
        const pulse = pr + 7 + Math.sin(t * 4) * 1.6;
        ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(255,255,255,0.5)';
        ctx.lineWidth = isSel ? 1.8 : 1.2;
        ctx.beginPath();
        ctx.arc(px, py, pulse, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (isSel || isHover || zoom > 140) {
        ctx.font = isSel ? '700 11px Rajdhani, sans-serif' : '600 10px Rajdhani, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = controlled ? this.data.colonyColors[row.colony] : 'rgba(233,226,255,0.9)';
        ctx.fillText(p.name.toUpperCase(), px, py + pr + 14);
      }
    }

    // system label
    ctx.font = '700 12px Rajdhani, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(233,226,255,0.85)';
    ctx.fillText(sys.name.toUpperCase(), center.x, center.y - SYSTEM_SCALE * zoom * 1.05);
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
    if (this.level === 'galactic') {
      const w = this.screen2world(sx, sy);
      const { gx, gy } = { gx: Math.round(w.x), gy: Math.round(w.y) };
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const g = galaxyAt(this.data.universeSeed, gx + dx, gy + dy);
          if (!g) continue;
          const p = this.world2screen(g.gx, g.gy);
          const r = Math.max(10, g.radius * 0.055 * this.cam.zoom);
          if ((sx - p.x) ** 2 + (sy - p.y) ** 2 <= r * r * 2.2) return { kind: 'galaxy', galaxy: g, sx, sy };
        }
      }
      return { kind: null, sx, sy };
    }
    if (this.level === 'galaxy' && this.focusGalaxy) {
      for (const sys of this.systemsFor(this.focusGalaxy)) {
        const w = this.systemWorldPos(this.focusGalaxy, sys);
        const p = this.world2screen(w.x, w.y);
        if ((sx - p.x) ** 2 + (sy - p.y) ** 2 <= 15 * 15) return { kind: 'system', system: sys, sx, sy };
      }
      return { kind: null, sx, sy };
    }
    if (this.level === 'system' && this.focusGalaxy && this.focusSystem) {
      const w = this.systemWorldPos(this.focusGalaxy, this.focusSystem);
      const center = this.world2screen(w.x, w.y);
      const t = (performance.now() - this.t0) / 1000;
      for (const p of this.planetsFor(this.focusSystem)) {
        const speed = 0.05 / (0.4 + p.orbitRadius);
        const angle = p.orbit + t * speed;
        const orbitR = p.orbitRadius * SYSTEM_SCALE * this.cam.zoom;
        const px = center.x + Math.cos(angle) * orbitR;
        const py = center.y + Math.sin(angle) * orbitR * 0.86;
        const pr = Math.max(3.5, p.radius * 5 * Math.min(3, this.cam.zoom / 60));
        if ((sx - px) ** 2 + (sy - py) ** 2 <= (pr + 8) ** 2) return { kind: 'planet', planet: p, sx, sy };
      }
      return { kind: null, sx, sy };
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
      const count = systemPlanetCount(this.data.universeSeed, this.focusGalaxy!.ring, this.focusGalaxy!.galaxyId, hit.system.systemId);
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
      this.enterGalaxy(hit.galaxy, true);
    } else if (hit.kind === 'system' && hit.system) {
      this.selectedSystem = hit.system;
      this.enterSystem(hit.system);
    } else if (hit.kind === 'planet' && hit.planet) {
      this.selectPlanet(hit.planet);
    } else if (this.level === 'system') {
      // click empty space at system level: keep selection
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
