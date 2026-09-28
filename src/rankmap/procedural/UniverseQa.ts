// NECROFALL — UNIVERSE DETERMINISM QA (plan §0/§41/§49). Runs in the browser dev
// surface (or any harness with the module graph): asserts that the same coordinate
// ALWAYS resolves to the same galaxy/system/planet, that the cumulative rank bands
// behave exactly as designed, that systems cluster toward the galactic centre, and
// that morphologies / planet counts genuinely vary. Pure — no THREE, no DOM.
import { GalaxyDescriptor, PlanetDescriptor, SystemDescriptor } from './GalaxyTypes';
import { galaxyAt } from './GalaxyGenerator';
import { systemAt, systemsInGalaxy, systemPlanetCount } from './SolarSystemGenerator';
import { planetAt } from './PlanetGenerator';
import { ringHome } from './UniverseGenerator';
import { RING_BOUNDS, RING_WIDTHS, ringInnerRadius, ringOfGalaxy, ringOuterRadius, UNIVERSE_GENERATION_VERSION } from './SeedHash';
import { ringConfig } from './RankRingConfig';

export interface UniverseQaIssue {
  check: string;
  detail: string;
}

export interface UniverseQaReport {
  pass: boolean;
  issues: UniverseQaIssue[];
  stats: Record<string, number | string>;
  elapsedMs: number;
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function runUniverseQa(seed = 918273645): UniverseQaReport {
  const t0 = performance.now();
  const issues: UniverseQaIssue[] = [];
  const bad = (check: string, detail: string): void => {
    if (issues.length < 40) issues.push({ check, detail });
  };
  const stats: Record<string, number | string> = {};

  // ---- 1. ring geometry: cumulative, monotone, exact boundaries (plan §1/§49)
  stats.generationVersion = UNIVERSE_GENERATION_VERSION;
  const expectBounds = [5, 12, 21, 32, 46, 63, 84, 109];
  if (!eq(RING_BOUNDS, expectBounds)) bad('ring bounds', `expected ${expectBounds}, got ${RING_BOUNDS}`);
  for (let i = 1; i < RING_WIDTHS.length; i++) {
    if (RING_WIDTHS[i] <= RING_WIDTHS[i - 1]) bad('band growth', `band ${i} not wider than ${i - 1}`);
  }
  const ringCases: [number, number, number][] = [
    [0, 0, 0], [4.99, 0, 0], [5, 0, 1], [11.99, 0, 1], [12, 0, 2],
    [21, 0, 3], [32, 0, 4], [46, 0, 5], [63, 0, 6], [84, 0, 7], [108.9, 0, 7], [400, 300, 7],
  ];
  for (const [gx, gy, want] of ringCases) {
    const got = ringOfGalaxy(gx, gy);
    if (got !== want) bad('ringOfGalaxy', `(${gx},${gy}) → ${got}, want ${want}`);
  }
  for (let k = 0; k < 7; k++) {
    if (ringInnerRadius(k + 1) !== ringOuterRadius(k)) bad('band seams', `gap at band ${k}`);
  }

  // ---- 2. determinism: repeated calls resolve identical descriptors (plan §0)
  let galaxies = 0;
  const morphs = new Set<string>();
  const systemCounts = new Set<number>();
  for (let gx = -30; gx <= 30; gx += 3) {
    for (let gy = -30; gy <= 30; gy += 3) {
      const a = galaxyAt(seed, gx, gy);
      const b = galaxyAt(seed, gx, gy);
      if (!eq(a, b)) bad('galaxyAt determinism', `(${gx},${gy}) differs between calls`);
      if (!a) continue;
      galaxies++;
      morphs.add(a.morphology ?? 'MISSING');
      systemCounts.add(a.systemCount);
      // systems + planets of one representative galaxy per band
      if (galaxies > 12) continue;
      const sys0 = systemAt(seed, a.ring, a.galaxyId, 3, a.systemCount);
      const sys1 = systemAt(seed, a.ring, a.galaxyId, 3, a.systemCount);
      if (!eq(sys0, sys1)) bad('systemAt determinism', `${a.name} #3 differs`);
      const p0 = planetAt(seed, a.ring, a.galaxyId, 3, 1);
      const p1 = planetAt(seed, a.ring, a.galaxyId, 3, 1);
      if (!eq(p0 as PlanetDescriptor, p1 as PlanetDescriptor)) bad('planetAt determinism', `${a.name} 3:1 differs`);
      if (p0.key !== `${a.ring}:${a.galaxyId}:3:1`) bad('planet key', `unexpected key ${p0.key}`);
    }
  }
  stats.galaxiesSampled = galaxies;
  stats.morphologies = morphs.size;
  stats.systemCountValues = systemCounts.size;
  if (morphs.size < 3) bad('morphology variety', `only ${morphs.size} morphologies in ${galaxies} galaxies`);
  if (systemCounts.size < 4) bad('system-count variety', `only ${systemCounts.size} distinct counts`);

  // ---- 3. central density: the bulge must outweigh the outer disc (plan §5/§49)
  const home = ringHome(seed, 1);
  const homeGalaxy = galaxyAt(seed, home.gx, home.gy);
  if (!homeGalaxy) {
    bad('home galaxy', 'ring home resolved to empty space');
  } else {
    let inner = 0;
    let mid = 0;
    let outer = 0;
    const all = systemsInGalaxy(seed, homeGalaxy.ring, homeGalaxy.galaxyId, homeGalaxy.systemCount);
    for (const s of all) {
      const r = Math.hypot(s.ux - 0.5, s.uy - 0.5);
      if (r < 0.3) inner++;
      else if (r < 0.6) mid++;
      else outer++;
    }
    stats.densityInner = inner;
    stats.densityMid = mid;
    stats.densityOuter = outer;
    if (!(inner > mid && inner > outer)) bad('central density', `bulge ${inner} not dominant (mid ${mid}, outer ${outer})`);
  }

  // ---- 4. planet counts use the RING CONFIG and genuinely vary (plan §12/§49)
  if (homeGalaxy) {
    const cfg = ringConfig(homeGalaxy.ring);
    const counts = new Set<number>();
    for (let s = 0; s < Math.min(48, homeGalaxy.systemCount); s++) {
      const c = systemPlanetCount(seed, homeGalaxy.ring, homeGalaxy.galaxyId, s);
      counts.add(c);
      if (c < cfg.planetsMin || c > cfg.planetsMax) {
        bad('planet count config', `system ${s} → ${c} planets, outside ${cfg.planetsMin}..${cfg.planetsMax}`);
      }
    }
    stats.planetCounts = [...counts].sort((a, b) => a - b).join(',');
    if (counts.size < 3) bad('planet count variety', `only ${counts.size} distinct counts across 48 systems`);
  }

  // ---- 5. system count ranges per band are the tuned 180-750 table (plan §5)
  stats.bandSystems = RING_BOUNDS.map((_, i) => `${ringConfig(i).systemsMin}-${ringConfig(i).systemsMax}`).join(' ');

  return {
    pass: issues.length === 0,
    issues,
    stats,
    elapsedMs: performance.now() - t0,
  };
}

/** Compact one-line summary for the console / QA surfaces. */
export function universeQaSummary(report: UniverseQaReport): string {
  if (report.pass) return `UNIVERSE QA PASS — ${report.stats.galaxiesSampled} galaxies, ${report.stats.morphologies} morphologies, bulge ${report.stats.densityInner}/${report.stats.densityMid}/${report.stats.densityOuter} (${report.elapsedMs.toFixed(0)}ms)`;
  return `UNIVERSE QA FAIL — ${report.issues.length} issues:\n${report.issues.map((i) => `  ${i.check}: ${i.detail}`).join('\n')}`;
}

/** Determinism probe used by tests + the debug overlay: is a coordinate stable? */
export function universeStableAt(seed: number, gx: number, gy: number): boolean {
  const a: GalaxyDescriptor | null = galaxyAt(seed, gx, gy);
  const b: GalaxyDescriptor | null = galaxyAt(seed, gx, gy);
  if (!eq(a, b)) return false;
  if (!a) return true;
  const s0: SystemDescriptor = systemAt(seed, a.ring, a.galaxyId, 0, a.systemCount);
  const s1: SystemDescriptor = systemAt(seed, a.ring, a.galaxyId, 0, a.systemCount);
  return eq(s0, s1);
}
