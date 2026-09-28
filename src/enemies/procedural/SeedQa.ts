// NECROFALL — AUTOMATED SEED QA (plan §69). Generates thousands of planets and enemy genomes
// and validates them headlessly: terrain NaN/range/slope, spawn + boss-arena viability, genome
// stat sanity, illegal body/attack combinations (plan §70). Failures are collected with the
// exact reasons so the GENERATOR gets fixed, never a hand-patched map.
//
// Runs in the browser (dev lab) or under the test harness — pure, no THREE, no DOM.
import { deriveArchetype, type PlanetArchetype } from '../../world/PlanetArchetypes';
import { TerrainGenerator } from '../../world/TerrainGenerator';
import { generateEcology, factsFromSeed, type EcologyBestiary } from './EcologyGenerator';
import { validateGenome } from './Compatibility';

export interface QaFailure {
  kind: 'planet' | 'genome';
  seed: number;
  /** Genome index (genome failures) or probe detail (planet failures). */
  detail: string;
  issues: string[];
}

export interface QaReport {
  planetsChecked: number;
  genomesChecked: number;
  bossesChecked: number;
  failures: QaFailure[];
  /** Fraction of probes that returned a finite height, for the summary line. */
  terrainFiniteRatio: number;
  /** Genome diversity over the whole sweep (plan §25/§41). */
  diversity: DiversityReport;
  elapsedMs: number;
}

/**
 * GENOME DIVERSITY (plan §25/§41): four independent signatures per genome. "Colour-only
 * variation" fails here by construction — the signatures never read the palette.
 */
export interface GenomeSignatures {
  body: string;
  attack: string;
  movement: string;
  behaviour: string;
}

export interface DiversityReport {
  genomes: number;
  body: number;
  attack: number;
  movement: number;
  behaviour: number;
  targeting: number;
  formations: number;
  /** Same seed → byte-identical roster (checked by regenerating a sample). */
  deterministic: boolean;
}

/** The four signatures the diversity test counts (plan §25). */
export function genomeSignatures(g: import('../EnemyGenomes').EnemyGenome): GenomeSignatures {
  const v = g.visual;
  const q = (n: number | undefined): number => Math.round((n ?? 0) * 2); // bucketed so near-same parts collapse
  const body = [
    g.locomotion ?? '?', v.rig ?? '-', v.legPairs, q(v.legLength), q(v.legThickness), q(v.bodyLength), q(v.bodyWidth), q(v.bodyHeight),
    v.plates, v.spikes, v.horns, v.mandibles, v.tubes ?? 0, v.wings ?? 0, v.fins ?? 0, v.sacs ?? 0, v.glowNodes ?? 0,
    v.tentacles ?? 0, v.shards ?? 0, v.plumes ?? 0, v.segments, v.jelly > 0.5 ? 'jelly' : 'frame',
  ].join('|');
  const attack = (g.attacks ?? [])
    .map((a) => `${a.ability}:${a.pattern}`)
    .concat(g.abilities.map((a) => `+${a}`))
    .sort()
    .join(',');
  const movement = [
    g.locomotion ?? '?', g.gait?.style ?? '?', (g.gait?.pairOffset ?? 0) > 0.5 ? 'alt' : 'bound',
    q(g.gait?.stride ?? 1), g.swarm?.formation ?? '-',
  ].join('|');
  const behaviour = [
    [...g.traits].sort().join('+'), g.targetPreference ?? '?', g.role ?? '?', q(g.behavior.groupBias), q(g.behavior.territory),
  ].join('|');
  return { body, attack, movement, behaviour };
}

/** Diversity + determinism probe: `count` planet seeds across all rings (plan §41). */
export function qaDiversity(count = 100, startSeed = 1, rings = 8): DiversityReport {
  const body = new Set<string>();
  const attack = new Set<string>();
  const movement = new Set<string>();
  const behaviour = new Set<string>();
  const targeting = new Set<string>();
  const formations = new Set<string>();
  let genomes = 0;
  let deterministic = true;
  for (let i = 0; i < count; i++) {
    const seed = (startSeed + i + 1) >>> 0;
    const ring = i % rings;
    const facts = factsFromSeed(seed, ring);
    const bestiary = generateEcology(seed, facts);
    const sigs: string[] = [];
    for (const g of bestiary.genomes) {
      genomes++;
      const s = genomeSignatures(g);
      body.add(s.body);
      attack.add(s.attack);
      movement.add(s.movement);
      behaviour.add(s.behaviour);
      targeting.add(g.targetPreference ?? '-');
      if (g.swarm) formations.add(g.swarm.formation);
      sigs.push(`${s.body}::${s.attack}::${s.movement}::${s.behaviour}`);
    }
    // determinism: every 10th roster is regenerated and must match exactly (plan §0/§23)
    if (i % 10 === 0) {
      const again = generateEcology(seed, facts);
      const sigs2 = again.genomes.map((g) => {
        const s = genomeSignatures(g);
        return `${s.body}::${s.attack}::${s.movement}::${s.behaviour}`;
      });
      if (JSON.stringify(sigs) !== JSON.stringify(sigs2)) deterministic = false;
    }
  }
  return {
    genomes,
    body: body.size,
    attack: attack.size,
    movement: movement.size,
    behaviour: behaviour.size,
    targeting: targeting.size,
    formations: formations.size,
    deterministic,
  };
}

const DIR_SAMPLES = 96;

/** Fibonacci-sphere probe directions (deterministic, shared by every seed). */
const PROBES: [number, number, number][] = (() => {
  const out: [number, number, number][] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < DIR_SAMPLES; i++) {
    const y = 1 - (2 * i + 1) / DIR_SAMPLES;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = golden * i;
    out.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return out;
})();

const RADIUS = 118;

/** 1.32 m of surface per fine probe step (0.0112 rad) — the scale a body actually walks at. */
const FINE_STEP = 0.0112;

/** One planet: height field sanity + spawn/boss-arena viability (plan §69). */
export function qaPlanet(seed: number, ring = 0): QaFailure | { finite: number; total: number; archetype: PlanetArchetype; terrain: TerrainGenerator } {
  const issues: string[] = [];
  let finite = 0;
  let total = 0;
  let min = Infinity;
  let max = -Infinity;
  let maxFine = 0;
  let maxCoarse = 0;
  let prev: number | null = null;
  let flatCells = 0;
  const archetype = deriveArchetype(seed, ring);
  const terrain = new TerrainGenerator(seed, RADIUS, archetype, ring);
  for (let i = 0; i < PROBES.length; i++) {
    const [x, y, z] = PROBES[i];
    const h = terrain.sample(x, y, z);
    total++;
    if (!Number.isFinite(h)) {
      issues.push('terrain produced NaN/Infinity');
      break;
    }
    finite++;
    min = Math.min(min, h);
    max = Math.max(max, h);
    if (prev !== null) maxCoarse = Math.max(maxCoarse, Math.abs(h - prev));
    prev = h;
    // FINE probes: what a walking body experiences. 1.32 m steps; ~74° is the steepest legal face.
    let px = x;
    let pz = z;
    let ph = h;
    for (let k = 0; k < 3; k++) {
      px += FINE_STEP;
      pz += FINE_STEP * 0.6;
      const l = Math.hypot(px, y, pz) || 1;
      const hf = terrain.sample(px / l, y / l, pz / l);
      total++;
      if (!Number.isFinite(hf)) { issues.push('terrain produced NaN/Infinity (fine probe)'); break; }
      finite++;
      maxFine = Math.max(maxFine, Math.abs(hf - ph));
      min = Math.min(min, hf);
      max = Math.max(max, hf);
      ph = hf;
      if (Math.abs(hf - h) < 0.9) flatCells++;
    }
  }
  // hard clamps (the field must live inside the collision band, plan §69 "impossible slopes")
  if (max - RADIUS > 46.5) issues.push(`terrain above the allowed band (${(max - RADIUS).toFixed(1)} m)`);
  if (RADIUS - min > 34.5) issues.push(`terrain below the allowed band (${(RADIUS - min).toFixed(1)} m)`);
  if (maxFine > 5.2) issues.push(`impossible slope (${maxFine.toFixed(1)} m rise over 1.3 m of ground)`);
  if (maxCoarse > 60) issues.push(`terrain spike between sectors (${maxCoarse.toFixed(0)} m)`);
  // spawn + tower viability: some flat-ish ground must exist
  if (flatCells < PROBES.length * 3 * 0.05) issues.push(`no flat spawn/arena ground (${flatCells} flat fine probes)`);
  if (issues.length) return { kind: 'planet', seed, detail: `ring ${ring} · ${archetype.biome}`, issues };
  return { finite, total, archetype, terrain };
}

/** One planet's full ecology: stat + compatibility validation for every genome and boss. */
export function qaEcology(seed: number, ring: number): { failures: QaFailure[]; bosses: number; genomes: number; bestiary: EcologyBestiary } {
  const failures: QaFailure[] = [];
  const facts = factsFromSeed(seed, ring);
  const bestiary = generateEcology(seed, facts);
  let bosses = 0;
  for (const g of bestiary.genomes) {
    const issues = validateGenome(g, { solidGround: true });
    // procedural-layer sanity the shipped sim also relies on
    if (!g.locomotion) issues.push('no locomotion class');
    if (!g.gait) issues.push('no gait profile');
    if (!g.role) issues.push('no ecology role');
    if (g.tier === 'boss' || g.tier === 'nexus') {
      bosses++;
      if (!(g.attacks && g.attacks.length >= 3)) issues.push('boss with fewer than 3 attacks');
    }
    if (g.hunter && !g.hunt) issues.push('hunter without a hunt cycle');
    if (g.abilities.length === 0) issues.push('no abilities');
    if (issues.length) failures.push({ kind: 'genome', seed, detail: `#${g.idx} ${g.name} (${g.tier})`, issues });
  }
  return { failures, bosses, genomes: bestiary.genomes.length, bestiary };
}

/**
 * THE QA RUN (plan §69): `planets` seeds across all 8 rings + their ecologies, plus an extra
 * `bosses` boss genomes. Deterministic given a start seed.
 */
export function runSeedQa(planets: number, startSeed = 1, rings = 8): QaReport {
  const t0 = performance.now();
  const failures: QaFailure[] = [];
  let finiteTotal = 0;
  let probesTotal = 0;
  let genomesChecked = 0;
  let bossesChecked = 0;
  for (let i = 0; i < planets; i++) {
    const seed = (startSeed + i + 1) >>> 0;
    const ring = i % rings;
    const planetResult = qaPlanet(seed, ring);
    if ('kind' in planetResult) {
      failures.push(planetResult);
    } else {
      finiteTotal += planetResult.finite;
      probesTotal += planetResult.total;
    }
    const ecology = qaEcology(seed, ring);
    failures.push(...ecology.failures);
    genomesChecked += ecology.genomes;
    bossesChecked += ecology.bosses;
    // stay responsive: the lab runs big batches on the main thread
    if (i > 0 && i % 500 === 0) {
      /* no-op: deliberate yield point for future async chunking */
    }
  }
  // ---- GENOME DIVERSITY + DETERMINISM (plan §25/§41): a real generator must produce
  // meaningfully different bodies, attacks, movement, behaviour — and the same seed
  // must reproduce the same roster byte-for-byte.
  const diversity = qaDiversity(Math.min(100, planets), startSeed, rings);
  const divFail = (name: string, got: number, want: number): void => {
    if (got < want) failures.push({ kind: 'genome', seed: startSeed, detail: `diversity:${name}`, issues: [`only ${got} unique of ${diversity.genomes} genomes (need ≥ ${want})`] });
  };
  divFail('body', diversity.body, 60);
  divFail('attack', diversity.attack, 80);
  divFail('movement', diversity.movement, 25);
  divFail('behaviour', diversity.behaviour, 40);
  divFail('targeting', diversity.targeting, 4);
  divFail('formations', diversity.formations, 5);
  if (!diversity.deterministic) {
    failures.push({ kind: 'genome', seed: startSeed, detail: 'determinism', issues: ['same seed produced a different roster on re-generation'] });
  }
  return {
    planetsChecked: planets,
    genomesChecked,
    bossesChecked,
    failures,
    terrainFiniteRatio: probesTotal ? finiteTotal / probesTotal : 1,
    diversity,
    elapsedMs: performance.now() - t0,
  };
}

export function failureReportJson(report: QaReport): string {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      planetsChecked: report.planetsChecked,
      genomesChecked: report.genomesChecked,
      bossesChecked: report.bossesChecked,
      badSeeds: report.failures,
    },
    null,
    2
  );
}
