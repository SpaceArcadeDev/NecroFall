#!/usr/bin/env node
/**
 * NECROFALL — enemy base model pipeline: Tripo crawler source → game-ready base model.
 *
 * The base-planets endpoint ships its cell-shaded enemy base model (`parasite-near.glb`)
 * through `prepare-concept-assets.mjs` (recolour, normalize, simplify, meshopt). The main
 * game's SECOND imported enemy model — `src/enemies/base_models/crawler.glb` — goes through
 * the same treatment here, so both imported bodies arrive in the engine with the same
 * conventions:
 *
 *   .asset-sources/crawler/source.glb      (SOURCE — never modified)
 *        ↓ weld + simplify + texture resize/WebP + meshopt + normalize
 *   src/enemies/base_models/crawler.glb    (game asset, meshopt compressed)
 *
 * Normalization baked into the vertices (the runtime rig depends on it):
 *   • yaw −90° so the creature FACES +Z — the convention `orientToSurface` gives every enemy;
 *   • uniform scale to 1.0 unit height, feet at y = 0, centered on x/z.
 *
 * The source is a static Tripo mesh (no skeleton, no clips). The runtime auto-rig
 * (`src/enemies/imported/AutoRig.ts`) derives the skeleton + skin weights from this geometry,
 * which is why the pose must stay baked: the rig is fitted per model, not carried in the file.
 *
 * Usage:
 *   node scripts/prepare-crawler-base-model.mjs                 # default budget (16k tris)
 *   node scripts/prepare-crawler-base-model.mjs --triangles=24000
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { compactPrimitive, dedup, getBounds, meshopt, prune, simplifyPrimitive, transformPrimitive, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = path.join(root, '.asset-sources', 'crawler', 'source.glb');
const outputFile = path.join(root, 'src', 'enemies', 'base_models', 'crawler.glb');
const reportFile = path.join(root, 'src', 'enemies', 'base_models', 'crawler.json');

const argument = (name, fallback) => {
  const raw = process.argv.find(value => value.startsWith(`--${name}=`))?.split('=')[1];
  return raw === undefined ? fallback : Number(raw);
};
const TARGET_TRIANGLES = argument('triangles', 16000);
/** Texture ceiling: WebP at 1024 keeps the painted detail without the 4K payload. */
const TEXTURE_SIZE = argument('textureSize', 1024);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder,
  'meshopt.decoder': MeshoptDecoder,
});

const countTriangles = document => document.getRoot().listMeshes().reduce((sum, mesh) =>
  sum + mesh.listPrimitives().reduce((subtotal, primitive) =>
    subtotal + (primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION').getCount()) / 3, 0), 0);

/**
 * NECROFALL chitin palette — the three-point repaint the Mega Necrophage's insectoid rig already
 * received, so both imported bodies read in the same graphic register:
 *
 *   deep indigo shell  →  violet plates  →  pale venom glands
 *
 * The authored detail survives as LUMINANCE and is remapped onto the palette (with the same 1.35
 * contrast lift the concept assets use), which keeps the painted plating, the gland blisters and
 * the cell structure readable while replacing the muddy photographic colours with the game's
 * saturated, cel-shaded set.
 */
const CHITIN_PALETTE = [[20, 18, 30], [104, 58, 112], [176, 236, 128]];

async function paintChitin(image) {
  const { data, info } = await sharp(image).resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [shadow, midtone, highlight] = CHITIN_PALETTE;
  for (let index = 0; index < data.length; index += info.channels) {
    const luminance = (data[index] * 0.24 + data[index + 1] * 0.63 + data[index + 2] * 0.13) / 255;
    // Levels first: the source is a DARK low-contrast photo texture (median luminance 0.22,
    // p90 0.50), so the ramp is stretched over its real range — plating sinks into the indigo
    // shadow, the venom glands climb into the bright green.
    const value = Math.min(1, Math.max(0, (luminance - 0.1) / 0.5));
    const first = value < 0.5 ? shadow : midtone;
    const second = value < 0.5 ? midtone : highlight;
    const blend = value < 0.5 ? value * 2 : (value - 0.5) * 2;
    for (let channel = 0; channel < 3; channel++) data[index + channel] = Math.round(first[channel] + (second[channel] - first[channel]) * blend);
  }
  return sharp(data, { raw: info }).webp({ quality: 94, alphaQuality: 100 }).toBuffer();
}

function assertGameBounds(document) {
  const bounds = getBounds(document.getRoot().listScenes()[0]);
  assert(bounds.min.every(Number.isFinite) && bounds.max.every(Number.isFinite), 'Invalid model bounds');
  assert(Math.abs(bounds.min[1]) < 1e-3, `Feet must sit on y = 0 (got ${bounds.min[1]})`);
  const height = bounds.max[1] - bounds.min[1];
  assert(Math.abs(height - 1) < 5e-3, `Normalized height must be 1.0 (got ${height})`);
  assert(Math.abs(bounds.min[2] + bounds.max[2]) < 5e-3 && Math.abs(bounds.min[0] + bounds.max[0]) < 5e-3, 'Model must be centered on x/z');
  assert(Math.abs(bounds.max[2] - 0.826) < 0.02 && bounds.max[2] > 0, 'Head must face +Z after the yaw fix');
  return bounds;
}

async function main() {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;
  assert(existsSync(sourceFile), `Stage the Tripo crawler GLB at ${path.relative(root, sourceFile)} first`);

  const sourceBytes = readFileSync(sourceFile);
  const document = await io.read(sourceFile);
  const scene = document.getRoot().listScenes()[0];
  assert.equal(document.getRoot().listSkins().length, 0, 'The crawler source is static — rigging is derived at runtime');
  assert.equal(countTriangles(document), 286732, 'Unexpected crawler source geometry');
  const sourceTriangles = countTriangles(document);

  // Collapse duplicated vertices FIRST: the Tripo export splits every edge, and welding roughly
  // halves the vertex count before simplification ever runs.
  await document.transform(weld());

  // Normalize: yaw the head from +X onto +Z, scale to unit height, feet on the floor, centered.
  // The mapping is `p' = scale · (−z, y, x) + T`; T re-centers x'/z' on the source centers and
  // lifts the feet onto y' = 0.
  const bounds = getBounds(scene);
  const scale = 1 / (bounds.max[1] - bounds.min[1]);
  const centerX = (bounds.min[0] + bounds.max[0]) / 2;
  const centerZ = (bounds.min[2] + bounds.max[2]) / 2;
  // Column-major 4x4: columns are (±scale on the mapped axes), then the translation.
  const matrix = [0, 0, scale, 0, 0, scale, 0, 0, -scale, 0, 0, 0,
    centerZ * scale, -bounds.min[1] * scale, -centerX * scale, 1];
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) transformPrimitive(primitive, matrix);

  const total = countTriangles(document);
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    const before = primitive.getIndices().getCount() / 3;
    const budget = Math.max(4, Math.floor(TARGET_TRIANGLES * before / total));
    simplifyPrimitive(primitive, { simplifier: MeshoptSimplifier, ratio: Math.min(1, TARGET_TRIANGLES / total), error: 0.012, lockBorder: false });
    if (primitive.getIndices().getCount() / 3 > budget * 1.4) {
      const [indices] = MeshoptSimplifier.simplifySloppy(new Uint32Array(primitive.getIndices().getArray()),
        primitive.getAttribute('POSITION').getArray(), 3, null, budget * 3, 0.03);
      assert(indices.length > 0, 'Simplification removed the entire source primitive');
      primitive.getIndices().setArray(indices);
      compactPrimitive(primitive);
    }
  }

  // Materials: ONE chitin surface, world-lit and cel-banded by the runtime (see ImportedVisual).
  for (const material of document.getRoot().listMaterials()) {
    material.setName('crawler:chitin');
    material.setMetallicFactor(0.06).setRoughnessFactor(0.6);
    if (material.getNormalTexture()) material.setNormalScale(0.85);
    for (const extension of material.listExtensions()) material.setExtension(extension.extensionName, null);
  }
  for (const texture of document.getRoot().listTextures()) {
    const base = document.getRoot().listMaterials().some(material => material.getBaseColorTexture() === texture);
    const size = base || document.getRoot().listMaterials().some(material => material.getNormalTexture() === texture) ? TEXTURE_SIZE : 512;
    // The base colour is repainted into the NECROFALL chitin palette; everything else is merely
    // resized to a WebP the GPU can sample cheaply.
    const image = base
      ? await paintChitin(texture.getImage())
      : await sharp(texture.getImage()).resize(size, size, { fit: 'inside' }).webp({ quality: 92 }).toBuffer();
    texture.setImage(image).setMimeType('image/webp');
    texture.setName(`crawler:${document.getRoot().listTextures().indexOf(texture)}`).setURI('');
  }

  document.createExtension(EXTTextureWebP).setRequired(true);
  document.getRoot().getAsset().generator = 'NecroFall crawler base model pipeline';
  await document.transform(prune(), dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));

  mkdirSync(path.dirname(outputFile), { recursive: true });
  await io.write(outputFile, document);

  const verified = await io.read(outputFile);
  const triangles = countTriangles(verified);
  assert.equal(triangles, countTriangles(document), 'Compressed geometry did not round-trip');
  assert.equal(verified.getRoot().listMaterials()[0].getName(), 'crawler:chitin');
  const finalBounds = assertGameBounds(verified);

  const bytes = readFileSync(outputFile);
  const report = {
    file: path.basename(outputFile),
    role: 'crawler enemy base model (cell-shaded, auto-rigged at runtime)',
    sourceFile: '.asset-sources/crawler/source.glb',
    sourceGenerator: 'Tripo',
    sourceSHA256: createHash('sha256').update(sourceBytes).digest('hex'),
    sourceTriangles,
    triangles,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bounds: finalBounds,
    conventions: ['faces +Z', 'height 1.0', 'feet on y = 0', 'centered on x/z', 'material crawler:chitin'],
    modifications: ['welded, simplified to the mobile budget', 'base colour repainted into the NECROFALL chitin palette', 'textures resized to WebP', 'yaw/scale normalization baked in', 'meshopt compression'],
  };
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ sourceTriangles, ...report, bytes: `${(bytes.length / 1024).toFixed(0)} KB` }, null, 2));
}

await main();
