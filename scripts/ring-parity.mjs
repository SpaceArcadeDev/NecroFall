// NECROFALL — CLIENT/SERVER RING PARITY TEST (plan §0/§1/§46).
//
// The server module and the client each own a copy of the universe ring maths.
// This script EXECUTES the real source of both files (transpiled with the repo's
// own TypeScript) and asserts they resolve identical bands over a dense grid —
// so the two implementations can never silently diverge.
//
// Run: node scripts/ring-parity.mjs   (or `npm run test:universe`)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, '..', 'src', 'rankmap', 'procedural', 'SeedHash.ts');
const SERVER = join(here, '..', 'spacetimedb', 'src', 'ranked', 'seed.ts');

/** Transpiles + evaluates the ring block of a seed file, returning its functions. */
function loadRingModule(path) {
  const src = readFileSync(path, 'utf8');
  const start = src.indexOf('export const RING_WIDTHS');
  const end = src.indexOf('export const UNIVERSE_GENERATION_VERSION');
  if (start < 0 || end < 0 || end <= start) throw new Error(`ring block not found in ${path}`);
  const block = src.slice(start, end);
  const js = ts.transpileModule(block, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  // eslint-disable-next-line no-new-func
  const exports = new Function('exports', `${js}; return exports;`)({});
  if (typeof exports.ringOfGalaxy !== 'function') throw new Error(`ringOfGalaxy missing in ${path}`);
  return exports;
}

const client = loadRingModule(CLIENT);
const server = loadRingModule(SERVER);

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`  ✗ ${msg}`);
};

// ---- 1. identical band widths + cumulative boundaries
const widths = JSON.stringify([...client.RING_WIDTHS]);
if (widths !== JSON.stringify([...server.RING_WIDTHS])) fail(`RING_WIDTHS differ: ${widths} vs ${JSON.stringify([...server.RING_WIDTHS])}`);
const boundsExpected = [5, 12, 21, 32, 46, 63, 84, 109];
if (JSON.stringify([...client.RING_BOUNDS]) !== JSON.stringify(boundsExpected)) fail(`client RING_BOUNDS not cumulative: ${client.RING_BOUNDS}`);
if (JSON.stringify([...server.RING_BOUNDS]) !== JSON.stringify(boundsExpected)) fail(`server RING_BOUNDS not cumulative: ${server.RING_BOUNDS}`);

// ---- 2. widths are strictly increasing (higher rank = larger band — plan §49)
for (let i = 1; i < client.RING_WIDTHS.length; i++) {
  if (client.RING_WIDTHS[i] <= client.RING_WIDTHS[i - 1]) fail(`band ${i} not wider than band ${i - 1}`);
}
// inner(k+1) === outer(k) — no gaps, no overlaps
for (let k = 0; k < 7; k++) {
  if (client.ringInnerRadius(k + 1) !== client.ringOuterRadius(k)) fail(`band seam mismatch at ${k}`);
  if (server.ringInnerRadius(k + 1) !== server.ringOuterRadius(k)) fail(`server band seam mismatch at ${k}`);
}

// ---- 3. boundary behaviour (cumulative lookup, not floor(dist/width))
const cases = [
  [0, 0, 0], [4.99, 0, 0], [5, 0, 1], [11.99, 0, 1], [12, 0, 2], [15, 8, 2],
  [21, 0, 3], [32, 0, 4], [46, 0, 5], [63, 0, 6], [84, 0, 7], [109, 0, 7], [400, 300, 7],
  [-11.5, 0, 1], [0, -33, 4], [30, 30, 5], // sqrt(1800) ≈ 42.4 → band 4
];
for (const [gx, gy, want] of cases) {
  const c = client.ringOfGalaxy(gx, gy);
  const s = server.ringOfGalaxy(gx, gy);
  const expected = (gx === 30 && gy === 30) ? 4 : want;
  if (c !== expected || s !== expected) fail(`ringOfGalaxy(${gx},${gy}) = c:${c} s:${s}, want ${expected}`);
}

// ---- 4. dense grid: both implementations agree EVERYWHERE
let checked = 0;
for (let gx = -140; gx <= 140; gx += 0.5) {
  for (let gy = -140; gy <= 140; gy += 0.5) {
    const c = client.ringOfGalaxy(gx, gy);
    const s = server.ringOfGalaxy(gx, gy);
    checked++;
    if (c !== s) {
      fail(`parity mismatch at (${gx},${gy}): client ${c}, server ${s}`);
      if (failures > 20) { gx = 1e9; break; }
    }
  }
}

if (failures) {
  console.error(`ring parity FAILED (${failures} issues, ${checked} points checked)`);
  process.exit(1);
}
console.log(`ring parity OK — ${checked} grid points, bands ${JSON.stringify(boundsExpected)}`);
