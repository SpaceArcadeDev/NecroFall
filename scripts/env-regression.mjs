// NECROFALL — ENVIRONMENT REGRESSION TEST (rework plan §79/§80).
//
// Executes the REAL environment sources (transpiled with the repo's own TypeScript, like
// `ring-parity.mjs`) and asserts the guarantees the rework must never break:
//
//   1. DETERMINISM (plan §59/§80): the same seed produces bit-identical terrain samples —
//      twice in the same process, and across separate provider instances.
//   2. DETAIL LAYERS (plan §5): the new medium/micro layers measurably enrich the field while
//      staying inside their documented amplitude budget (walkability must hold).
//   3. CELL GRID (plan §19/§59): every direction maps to a cell whose centre maps back to the
//      same cell (index ⇄ centre round-trip), and the grid is stable across instances.
//   4. ENVIRONMENT STREAMS (plan §59): cell-seeded random streams are pure functions of
//      (seed, version, cell, salt) — re-generating a cell always reproduces the same content.
//
// Run: node scripts/env-regression.mjs   (or `npm run test:env`)
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const nodeRequire = createRequire(import.meta.url);

// Headless stubs: the module graph (via core/Config) touches browser globals at load time.
globalThis.window ??= globalThis;
globalThis.document ??= { documentElement: {}, createElement: () => ({ getContext: () => null }) };

// ---------------------------------------------------------------- mini TS module loader

const cache = new Map();

function loadTs(path) {
  const abs = resolve(path);
  if (cache.has(abs)) return cache.get(abs);
  const src = readFileSync(abs, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  cache.set(abs, module.exports); // pre-seed (no cycles expected, but harmless)
  const requireShim = (spec) => {
    if (spec === 'three') return nodeRequire('three');
    if (spec.startsWith('.')) {
      const base = resolve(dirname(abs), spec);
      for (const candidate of [base + '.ts', join(base, 'index.ts'), base]) {
        if (existsSync(candidate) && candidate.endsWith('.ts')) return loadTs(candidate);
      }
      throw new Error(`cannot resolve ${spec} from ${abs}`);
    }
    return nodeRequire(spec);
  };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', js)(module.exports, requireShim, module);
  return module.exports;
}

const { Rand } = loadTs(join(root, 'src/utils/Utils.ts'));
const { deriveArchetype } = loadTs(join(root, 'src/world/PlanetArchetypes.ts'));
const { TerrainGenerator } = loadTs(join(root, 'src/world/TerrainGenerator.ts'));
const { BiomeGenerator } = loadTs(join(root, 'src/world/BiomeGenerator.ts'));
const { LegacyTerrainProvider, createTerrainSample } = loadTs(join(root, 'src/world/terrain/PlanetTerrainProvider.ts'));
const { EnvironmentCells } = loadTs(join(root, 'src/world/cells/EnvironmentCells.ts'));
const { cellRand, hash32, ENVIRONMENT_VERSION } = loadTs(join(root, 'src/world/EnvironmentSeed.ts'));

const RADIUS = 118;
const SEEDS = [1, 42, 82371, 0xdeadbeef, 2654435761 >>> 0];

/** Minimal Vector3 stand-in (the real three vectors work too, but this keeps the script light). */
class V3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  normalize() {
    const l = Math.hypot(this.x, this.y, this.z) || 1;
    this.x /= l;
    this.y /= l;
    this.z /= l;
    return this;
  }
  clone() {
    return new V3(this.x, this.y, this.z);
  }
  copy(v) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }
  addScaledVector(v, s) {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }
  crossVectors(a, b) {
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }
}

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`  x ${msg}`);
};
const ok = (msg) => console.log(`  + ${msg}`);

/** Builds a provider for a seed; `detail` 0 gives the pure macro field (regression baseline). */
function makeProvider(seed, detail = 1) {
  const arch = deriveArchetype(seed, 0);
  const gen = new TerrainGenerator(seed, RADIUS, arch, 0);
  const biome = new BiomeGenerator(arch, gen);
  return new LegacyTerrainProvider(gen, biome, { planetSeed: seed, terrainDetail: detail, waterLevel: 0 });
}

/** Deterministic test directions (same stream for every seed set). */
function directions(count) {
  const rng = new Rand(0xc0ffee);
  const out = [];
  for (let i = 0; i < count; i++) {
    const z = rng.range(-1, 1);
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.push(new V3(Math.cos(a) * r, z, Math.sin(a) * r).normalize());
  }
  return out;
}

const DIRS = directions(512);

// ---------------------------------------------------------------- 1. determinism

console.log('1. determinism');
for (const seed of SEEDS) {
  const a = makeProvider(seed);
  const b = makeProvider(seed);
  let mismatch = 0;
  for (const d of DIRS) {
    if (a.getHeight(d.x, d.y, d.z) !== b.getHeight(d.x, d.y, d.z)) mismatch++;
  }
  if (mismatch > 0) fail(`seed ${seed}: ${mismatch} height samples differ between instances`);
  // same instance called twice
  let mismatch2 = 0;
  for (const d of DIRS) {
    const h1 = a.getHeight(d.x, d.y, d.z);
    const h2 = a.getHeight(d.x, d.y, d.z);
    if (h1 !== h2) mismatch2++;
  }
  if (mismatch2 > 0) fail(`seed ${seed}: non-deterministic repeat sampling (${mismatch2})`);
}
if (failures === 0) ok(`${SEEDS.length} seeds x ${DIRS.length} samples bit-identical`);

// ---------------------------------------------------------------- 2. detail layers

console.log('2. detail layers (plan §5)');
{
  // Amplitudes from EnvironmentConfig.TERRAIN_DETAIL (kept in sync by hand on purpose: this
  // script must not import core/Config, which touches browser globals).
  const MAX_DETAIL = 0.85 + 0.22 + 1e-6;
  for (const seed of SEEDS.slice(0, 3)) {
    const macro = makeProvider(seed, 0);
    const full = makeProvider(seed, 1);
    let changed = 0;
    let maxAbs = 0;
    for (const d of DIRS) {
      const diff = Math.abs(full.getHeight(d.x, d.y, d.z) - macro.getHeight(d.x, d.y, d.z));
      maxAbs = Math.max(maxAbs, diff);
      if (diff > 0.02) changed++;
    }
    if (maxAbs > MAX_DETAIL) fail(`seed ${seed}: detail amplitude ${maxAbs.toFixed(3)} exceeds budget ${MAX_DETAIL}`);
    if (changed < DIRS.length * 0.5) fail(`seed ${seed}: detail layers active on only ${changed}/${DIRS.length} samples`);
  }
  ok('detail layers active, inside amplitude budget');
}

// ---------------------------------------------------------------- 3. cell grid round-trip

console.log('3. cell grid (plan §19)');
{
  const cellsA = new EnvironmentCells(RADIUS, 5);
  const cellsB = new EnvironmentCells(RADIUS, 5);
  let bad = 0;
  for (const d of DIRS) {
    const idx = cellsA.indexOf(d);
    const c = cellsA.centerOf(idx, new V3());
    const idx2 = cellsA.indexOf(c);
    if (idx2 !== idx) bad++;
    // cross-instance stability
    const idxB = cellsB.indexOf(d);
    if (idxB !== idx) bad++;
  }
  if (bad > 0) fail(`${bad} cell round-trip / stability mismatches`);
  else ok(`index <=> centre round-trip stable over ${DIRS.length} directions (${cellsA.count} cells)`);
  // adjacency sanity: every cell has neighbours
  let lonely = 0;
  for (let i = 0; i < cellsA.count; i++) if (cellsA.neighborsOf(i).length === 0) lonely++;
  if (lonely > 0) fail(`${lonely} cells without neighbours`);
  else ok('every cell has neighbours');
}

// ---------------------------------------------------------------- 4. environment streams

console.log('4. environment streams (plan §59)');
{
  const seed = 82371;
  const cells = new EnvironmentCells(RADIUS, 5);
  let bad = 0;
  for (let cell = 0; cell < cells.count; cell += 17) {
    const a = cellRand(seed, cell, 0x7e01, ENVIRONMENT_VERSION);
    const b = cellRand(seed, cell, 0x7e01, ENVIRONMENT_VERSION);
    for (let i = 0; i < 24; i++) {
      if (a.next() !== b.next()) {
        bad++;
        break;
      }
    }
  }
  if (bad > 0) fail(`${bad} cells regenerate different random streams`);
  // different salts / cells must decorrelate
  const s1 = cellRand(seed, 100, 1, ENVIRONMENT_VERSION).next();
  const s2 = cellRand(seed, 100, 2, ENVIRONMENT_VERSION).next();
  const s3 = cellRand(seed, 101, 1, ENVIRONMENT_VERSION).next();
  if (s1 === s2 || s1 === s3) fail('streams collide across salts/cells');
  // hash spread sanity on 16k samples
  const buckets = new Array(16).fill(0);
  for (let i = 0; i < 16384; i++) buckets[hash32(seed, i) % 16]++;
  const min = Math.min(...buckets);
  const max = Math.max(...buckets);
  if (min < 850 || max > 1200) fail(`hash distribution skewed: min ${min} max ${max} of 16384/16`);
  else ok(`streams pure, decorrelated, spread sane (min ${min} max ${max})`);
}

// ---------------------------------------------------------------- summary

if (failures > 0) {
  console.error(`\nENVIRONMENT REGRESSION: ${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('\nENVIRONMENT REGRESSION: all checks passed');
}
