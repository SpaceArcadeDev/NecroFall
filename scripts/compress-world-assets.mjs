// NECROFALL — world asset compression pipeline (plan §28).
//
// Mirrors Folio 2025's `scripts/compress.js` for the GLB files we reuse:
//
//   1. `gltf-transform etc1s`  — compress embedded textures to KTX2/ETC1S
//   2. `gltf-transform draco`  — mesh compression (edgebreaker), mesh-space quantisation
//
// Usage:
//   node scripts/compress-world-assets.mjs <dir>        # walk <dir> for *.glb
//
// Output files are named `<name>-compressed.glb` next to their source; already-compressed
// files are skipped, so the script is idempotent. Sources stay in the repo (assets/…), only
// the compressed output is served from `public/`.
//
// Requires the gltf-transform CLI:  npx @gltf-transform/cli
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/compress-world-assets.mjs <dir>');
  process.exit(1);
}

/** Collect every *.glb under `dir`, skipping files we have already produced. */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      collect(path, out);
    } else if (extname(name).toLowerCase() === '.glb' && !/-(draco|ktx|compressed)\.glb$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

for (const input of collect(root)) {
  const output = input.replace(/\.glb$/, '-compressed.glb');
  console.log(`[compress] ${input}`);

  // 1 — textures → ETC1S/KTX2 (no-op texture-wise when the source has none).
  execFileSync('npx', ['gltf-transform', 'etc1s', input, output, '--quality', '255'], { stdio: 'inherit' });

  // 2 — geometry → Draco (edgebreaker), quantised in mesh space (Folio's exact settings).
  execFileSync(
    'npx',
    [
      'gltf-transform', 'draco', output, output,
      '--method', 'edgebreaker',
      '--quantization-volume', 'mesh',
      '--quantize-position', '12',
      '--quantize-normal', '6',
      '--quantize-texcoord', '6',
      '--quantize-color', '2',
      '--quantize-generic', '2',
    ],
    { stdio: 'inherit' },
  );

  console.log(`[compress] → ${output}`);
}
