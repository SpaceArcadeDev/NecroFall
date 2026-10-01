#!/usr/bin/env node
/**
 * NECROFALL — environment asset pipeline (plan §27).
 *
 * The Folio reference ships a deliberate asset pipeline: GLB -> texture compression ->
 * GPU-friendly textures -> runtime loading. This script does the same for NECROFALL's
 * environment assets:
 *
 *   public/environment/**.glb   (SOURCE — never modified)
 *        ↓ gltf-transform optimize (weld, prune, resample, Draco, texture compression)
 *   public/assets/environment/compressed/**.glb
 *
 * The game ALREADY loads Draco + KTX2/Basis at runtime (public/draco, public/basis and the
 * ResourcesLoader wiring), so the compressed output is a drop-in replacement: point the asset
 * manifest at `public/assets/environment/compressed/...` when you want the smaller payloads.
 *
 * Usage:
 *   node scripts/compress-environment.mjs            # compress everything found
 *   node scripts/compress-environment.mjs <file.glb> # compress one file
 *
 * Requirements: Node 18+. The first run downloads `@gltf-transform/cli` via npx. If the machine
 * has no npm registry access, the script explains the manual steps and exits without touching
 * any source file.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRS = [
  join(root, 'public', 'environment'),
];
const OUT_DIR = join(root, 'public', 'assets', 'environment', 'compressed');

/** Collect .glb/.gltf files under a directory (recursive). */
function collectGltf(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) collectGltf(full, out);
    else if (/\.(glb|gltf)$/i.test(entry)) out.push(full);
  }
  return out;
}

function compress(input, output) {
  mkdirSync(dirname(output), { recursive: true });
  // `optimize` bundles weld/prune/resample + Draco geometry compression and texture compression
  // (WebP keeps the decode path dependency-free; switch `--texture-compress ktx2` when a KTX-Software
  // `toktx` binary is available for full GPU-native textures).
  const args = [
    '--yes', '@gltf-transform/cli@latest', 'optimize',
    input, output,
    '--compress', 'draco',
    '--texture-compress', 'webp',
    '--texture-size', '2048',
  ];
  const result = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  return result.status === 0;
}

function main() {
  const explicit = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const inputs = explicit.length > 0 ? explicit.map((p) => resolve(p)) : SOURCE_DIRS.flatMap((dir) => collectGltf(dir));

  if (inputs.length === 0) {
    console.log('[compress-environment] no .glb sources found under public/environment.');
    return;
  }

  console.log(`[compress-environment] ${inputs.length} source file(s) -> ${relative(root, OUT_DIR)}`);
  let ok = 0;
  for (const input of inputs) {
    const rel = relative(root, input).replace(/\\/g, '/');
    // keep the source tree shape, minus the `public/` prefix
    const output = join(OUT_DIR, rel.replace(/^public\//, ''));
    console.log(`  → ${rel}`);
    if (compress(input, output)) ok++;
    else console.warn(`    FAILED (kept source untouched): ${rel}`);
  }

  console.log(`[compress-environment] done: ${ok}/${inputs.length} compressed.`);
  if (ok < inputs.length) {
    console.log(
      '[compress-environment] if npx could not reach the registry, run the same pipeline manually:\n' +
      '  npx @gltf-transform/cli optimize <src.glb> <out.glb> --compress draco --texture-compress webp',
    );
    process.exitCode = 1;
  }
}

main();
