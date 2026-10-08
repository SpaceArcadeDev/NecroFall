import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { cloneDocument, compactPrimitive, dedup, getBounds, meshopt, prune, resample, simplifyPrimitive, transformPrimitive, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import draco3d from 'draco3d';

export const recipes = [
  { key: 'canopy', source: 'jacaranda_tree', resolution: '1k', triangles: 50000, height: 22, role: 'scarlet-canopy' },
  { key: 'cliff', source: 'namaqualand_cliff_02', resolution: '1k', triangles: 10000, height: 16, role: 'mineral-strata' },
  { key: 'grass', source: 'grass_medium_01', resolution: '1k', triangles: 550, height: 1, role: 'sulfur-meadow' },
  { key: 'roots', source: 'root_cluster_01', resolution: '1k', triangles: 4500, height: 3, role: 'infected-roots' },
  { key: 'boulder', source: 'boulder_01', resolution: '1k', triangles: 1800, height: 3, role: 'mineral-strata' },
];

const cacheRoot = path.resolve('.asset-sources');
const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
const identity = 'NecroFall-AssetStudy/1.0';

function ensureSafeURL(url) {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'https:');
  assert(['api.polyhaven.com', 'dl.polyhaven.org'].includes(parsed.hostname), `Unexpected source host: ${parsed.hostname}`);
}

function download(url, destination, expectedMD5) {
  ensureSafeURL(url);
  mkdirSync(path.dirname(destination), { recursive: true });
  if (!existsSync(destination)) {
    console.log(`Download ${path.basename(destination)}`);
    execFileSync(curl, ['-fL', '--retry', '2', '-A', identity, '-o', destination, url], { stdio: 'pipe' });
  }
  const bytes = readFileSync(destination);
  if (expectedMD5) assert.equal(createHash('md5').update(bytes).digest('hex'), expectedMD5, `Source checksum mismatch: ${destination}`);
  return bytes;
}

export function sourceMetadata(recipe) {
  const directory = path.join(cacheRoot, recipe.source);
  const metadataPath = path.join(directory, 'files.json');
  const metadata = JSON.parse(download(`https://api.polyhaven.com/files/${recipe.source}`, metadataPath));
  const entry = metadata.gltf?.[recipe.resolution]?.gltf;
  assert(entry?.url, `No ${recipe.resolution} glTF for ${recipe.source}`);
  const sourceFile = path.join(directory, `${recipe.source}.gltf`);
  const json = JSON.parse(download(entry.url, sourceFile, entry.md5));
  return { directory, metadata, entry, sourceFile, json };
}

export function acquire(recipe) {
  const source = sourceMetadata(recipe);
  for (const [relativeName, dependency] of Object.entries(source.entry.include ?? {})) {
    const destination = path.resolve(source.directory, relativeName);
    assert(destination.startsWith(source.directory + path.sep), 'Source dependency escaped its cache directory');
    download(dependency.url, destination, dependency.md5);
  }
  const alphaEntry = Object.entries(source.metadata).find(([name]) => /alpha$/i.test(name))?.[1]?.[recipe.resolution];
  const alphaFile = alphaEntry?.png ?? alphaEntry?.jpg;
  if (alphaFile) {
    source.alphaPath = path.join(source.directory, 'opacity.png');
    download(alphaFile.url, source.alphaPath, alphaFile.md5);
  }
  writeFileSync(path.join(source.directory, 'provenance.json'), JSON.stringify({
    source: `https://polyhaven.com/a/${recipe.source}`, license: 'CC0-1.0', licenseURL: 'https://polyhaven.com/license',
    sourceURL: source.entry.url, sourceSHA256: createHash('sha256').update(readFileSync(source.sourceFile)).digest('hex'),
    downloadedAt: new Date().toISOString(),
  }, null, 2));
  return source;
}

const outputRoot = path.resolve('src/concepts/assets');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

function countTriangles(document) {
  return document.getRoot().listMeshes().reduce((sum, mesh) => sum + mesh.listPrimitives().reduce((subtotal, primitive) => subtotal + (primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION').getCount()) / 3, 0), 0);
}

function chooseGrass(document, distant) {
  const name = distant ? 'grass_medium_01_tiny_a_LOD0' : 'grass_medium_01_mid_b_LOD0';
  const chosen = document.getRoot().listNodes().find((node) => node.getName() === name);
  assert(chosen, `Missing authored grass tuft: ${name}`);
  for (const node of document.getRoot().listNodes()) if (node !== chosen) node.dispose();
}

function normalizeModel(document, recipe) {
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    assert(!node.getSkin(), 'Static asset converter cannot flatten a skinned model');
    const matrix = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) transformPrimitive(primitive, matrix);
    node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
  }
  const bounds = getBounds(document.getRoot().listScenes()[0]);
  const scale = recipe.height / Math.max(0.001, bounds.max[1] - bounds.min[1]);
  const centerX = (bounds.max[0] + bounds.min[0]) * 0.5;
  const centerZ = (bounds.max[2] + bounds.min[2]) * 0.5;
  const matrix = [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, -centerX * scale, -bounds.min[1] * scale, -centerZ * scale, 1];
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    transformPrimitive(primitive, matrix);
    if (recipe.key !== 'canopy') continue;
    const position = primitive.getAttribute('POSITION');
    const values = position.getArray();
    for (let index = 0; index < values.length; index += 3) {
      const height = values[index + 1];
      const crown = Math.max(0, Math.min(1, (height / recipe.height - 0.3) / 0.5));
      values[index] = values[index] * (1 + crown * 0.28) + Math.sin(height * 0.13) * crown * 0.65;
      values[index + 1] = height - crown * Math.max(0, height - recipe.height * 0.45) * 0.12;
      values[index + 2] *= 1 + crown * 0.18;
    }
    position.setArray(values);
  }
}

async function paintTexture(texture, palette, alphaPath) {
  const { data, info } = await sharp(texture.getImage()).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = alphaPath ? await sharp(alphaPath).resize(info.width, info.height).greyscale().raw().toBuffer() : null;
  const [shadow, midtone, highlight] = palette;
  for (let index = 0; index < data.length; index += 4) {
    const luminance = (data[index] * 0.24 + data[index + 1] * 0.63 + data[index + 2] * 0.13) / 255;
    const value = Math.min(1, Math.max(0, luminance * 1.35));
    const first = value < 0.5 ? shadow : midtone;
    const second = value < 0.5 ? midtone : highlight;
    const blend = value < 0.5 ? value * 2 : (value - 0.5) * 2;
    for (let channel = 0; channel < 3; channel++) data[index + channel] = Math.round(first[channel] + (second[channel] - first[channel]) * blend);
    if (alpha) data[index + 3] = alpha[index / 4];
  }
  texture.setImage(await sharp(data, { raw: info }).webp({ quality: 94, alphaQuality: 100 }).toBuffer()).setMimeType('image/webp');
}

async function stylizeMaterials(document, recipe, source) {
  const palettes = {
    foliage: [[52, 24, 52], [176, 43, 78], [255, 147, 121]],
    bark: [[26, 42, 50], [70, 86, 85], [164, 171, 143]],
    rock: [[40, 55, 70], [107, 125, 126], [209, 201, 166]],
    grass: [[29, 51, 40], [117, 141, 49], [224, 213, 116]],
    roots: [[37, 29, 50], [87, 58, 86], [184, 128, 143]],
  };
  const painted = new Set();
  for (const material of document.getRoot().listMaterials()) {
    const foliage = /leav|grass/i.test(material.getName());
    const palette = recipe.key === 'grass' ? palettes.grass : /leav/i.test(material.getName()) ? palettes.foliage
      : recipe.key === 'roots' ? palettes.roots : recipe.key === 'canopy' ? palettes.bark : palettes.rock;
    const texture = material.getBaseColorTexture();
    if (texture && !painted.has(texture)) {
      await paintTexture(texture, palette, foliage ? source.alphaPath : null);
      painted.add(texture);
    }
    material.setName(`${recipe.key}:${material.getName()}`);
    material.setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(foliage ? 0.9 : 0.84);
    material.setNormalScale(foliage ? 0.55 : 0.8);
    material.setAlphaMode(foliage ? 'MASK' : 'OPAQUE').setAlphaCutoff(0.46).setDoubleSided(foliage);
    for (const extension of material.listExtensions()) material.setExtension(extension.extensionName, null);
  }
  for (const texture of document.getRoot().listTextures()) {
    texture.setName(`${recipe.key}:${texture.getName() || path.basename(texture.getURI())}`);
    if (!painted.has(texture)) texture.setImage(await sharp(texture.getImage()).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 94 }).toBuffer()).setMimeType('image/webp');
    texture.setURI('');
  }
}

async function prepare(recipe) {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;
  const source = acquire(recipe);
  const original = await io.read(source.sourceFile);
  const originalTriangles = countTriangles(original);
  mkdirSync(outputRoot, { recursive: true });
  const variants = [];
  for (const level of ['near', 'far']) {
    const document = cloneDocument(original);
    if (recipe.key === 'grass') chooseGrass(document, level === 'far');
    await document.transform(prune(), dedup(), weld());
    normalizeModel(document, recipe);
    const total = countTriangles(document);
    const target = level === 'far' ? Math.min(recipe.triangles * 0.26, 6000) : recipe.triangles;
    for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      const before = primitive.getIndices().getCount() / 3;
      const budget = Math.max(4, Math.floor(target * before / total));
      simplifyPrimitive(primitive, { simplifier: MeshoptSimplifier, ratio: Math.min(1, target / total), error: level === 'far' ? 0.05 : 0.016, lockBorder: false });
      if (primitive.getIndices().getCount() / 3 > budget * 1.4 && (level === 'far' || recipe.key === 'boulder')) {
        const [indices] = MeshoptSimplifier.simplifySloppy(new Uint32Array(primitive.getIndices().getArray()),
          primitive.getAttribute('POSITION').getArray(), 3, null, budget * 3, level === 'far' ? 0.06 : 0.035);
        assert(indices.length > 0, 'Simplification removed the entire source primitive');
        primitive.getIndices().setArray(indices);
        compactPrimitive(primitive);
      }
    }
    await stylizeMaterials(document, recipe, source);
    document.createExtension(EXTTextureWebP).setRequired(true);
    await document.transform(prune(), dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    const triangles = countTriangles(document);
    const name = `${recipe.key}-${level}.glb`;
    await io.write(path.join(outputRoot, name), document);
    const verified = await io.read(path.join(outputRoot, name));
    assert.equal(countTriangles(verified), triangles, 'Compressed geometry did not round-trip');
    const bounds = getBounds(verified.getRoot().listScenes()[0]);
    assert(bounds.max.every(Number.isFinite) && bounds.min.every(Number.isFinite), 'Invalid model bounds');
    const bytes = readFileSync(path.join(outputRoot, name));
    const result = { file: name, triangles, bytes: bytes.length, bounds, sha256: createHash('sha256').update(bytes).digest('hex') };
    variants.push(result);
    console.log(JSON.stringify({ key: recipe.key, sourceTriangles: originalTriangles, ...result }));
  }
  writeFileSync(path.join(outputRoot, `${recipe.key}.json`), JSON.stringify({
    source: `https://polyhaven.com/a/${recipe.source}`, license: 'CC0-1.0',
    modifications: ['geometry normalized and canopy profile edited where applicable', 'authored texture detail recolored to NECROFALL palette', 'opacity restored where supplied', 'near/far simplification and meshopt compression'],
    role: recipe.role, sourceTriangles: originalTriangles, variants,
  }, null, 2));
}

async function prepareParasite() {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;
  const sourceFile = path.join(cacheRoot, 'insectoid/source.glb');
  assert(existsSync(sourceFile), 'Download the approved Insectoid Monster Rig GLB and stage it in .asset-sources/insectoid/source.glb');
  const sourceBytes = readFileSync(sourceFile);
  const source = await io.read(sourceFile);
  assert(source.getRoot().listSkins().length > 0, 'The source must retain its skeleton');
  assert(source.getRoot().listAnimations().some((animation) => animation.getName() === 'Prowl'), 'The source Prowl animation is missing');
  const metadata = {
    source: 'https://sketchfab.com/3d-models/insectoid-monster-rig-01323e4b2563430f9da85cd255b6e176',
    title: 'Insectoid Monster Rig', author: 'DM-913', authorURL: 'https://sketchfab.com/SuperKapoo913',
    license: 'CC-BY-4.0', licenseURL: 'https://creativecommons.org/licenses/by/4.0/',
    sourceSHA256: createHash('sha256').update(sourceBytes).digest('hex'),
    modifications: ['NECROFALL chitin and wing texture repaint', 'radiated crest morph variation', 'normalized display scale', 'runtime LOD and texture optimization'],
  };
  writeFileSync(path.join(cacheRoot, 'insectoid/provenance.json'), JSON.stringify(metadata, null, 2));
  const variants = [];
  for (const level of ['near', 'far']) {
    const document = cloneDocument(source);
    const root = document.getRoot();
    const scene = root.listScenes()[0];
    const buffer = root.listBuffers()[0];
    for (const node of root.listNodes()) {
      const mesh = node.getMesh(), skin = node.getSkin();
      if (!mesh || !skin) continue;
      const joints = skin.listJoints();
      for (const primitive of mesh.listPrimitives()) {
        const positions = primitive.getAttribute('POSITION');
        const indices = primitive.getAttribute('JOINTS_0');
        const weights = primitive.getAttribute('WEIGHTS_0');
        const values = positions.getArray(), deltas = new Float32Array(values.length);
        const center = [0, 0, 0];
        let total = 0;
        const influence = new Float32Array(positions.getCount());
        for (let vertex = 0; vertex < positions.getCount(); vertex++) {
          for (let joint = 0; joint < 4; joint++) {
            if (/^Head_/.test(joints[indices.getArray()[vertex * 4 + joint]]?.getName() ?? '')) influence[vertex] += weights.getArray()[vertex * 4 + joint];
          }
          total += influence[vertex];
          for (let axis = 0; axis < 3; axis++) center[axis] += values[vertex * 3 + axis] * influence[vertex];
        }
        if (total < 0.1) continue;
        for (let axis = 0; axis < 3; axis++) center[axis] /= total;
        for (let vertex = 0; vertex < positions.getCount(); vertex++) {
          for (let axis = 0; axis < 3; axis++) deltas[vertex * 3 + axis] = (values[vertex * 3 + axis] - center[axis]) * influence[vertex] * [0.18, 0.14, 0.08][axis];
        }
        primitive.addTarget(document.createPrimitiveTarget('Radiated crest').setAttribute('POSITION',
          document.createAccessor('Radiated crest delta', buffer).setType('VEC3').setArray(deltas)));
        mesh.setWeights([0.85]);
      }
    }
    for (const material of root.listMaterials()) {
      const wings = material.getName() === 'WINGS';
      const base = material.getBaseColorTexture();
      if (base) await paintTexture(base, wings ? [[19, 50, 58], [69, 143, 125], [201, 232, 180]]
        : [[22, 24, 36], [102, 44, 64], [236, 142, 120]]);
      material.setName(wings ? 'parasite:membrane' : 'parasite:chitin');
      material.setMetallicFactor(0.05).setRoughnessFactor(wings ? 0.65 : 0.54).setNormalScale(0.8);
      material.setAlphaMode(wings ? 'MASK' : 'OPAQUE').setAlphaCutoff(0.3).setDoubleSided(wings);
      for (const extension of material.listExtensions()) material.setExtension(extension.extensionName, null);
    }
    for (const texture of root.listTextures()) {
      const usedAsBase = root.listMaterials().some((material) => material.getBaseColorTexture() === texture);
      if (!usedAsBase) texture.setImage(await sharp(texture.getImage()).resize(1024, 1024, { fit: 'inside' }).webp({ quality: 95 }).toBuffer()).setMimeType('image/webp');
      texture.setName(`parasite:${root.listTextures().indexOf(texture)}`).setURI('');
    }
    const bounds = getBounds(scene);
    const scale = 4.8 / (bounds.max[1] - bounds.min[1]);
    const wrapper = document.createNode('NECROFALL Pollen Reaver').setScale([scale, scale, scale])
      .setTranslation([-(bounds.min[0] + bounds.max[0]) * scale / 2, -bounds.min[1] * scale, -(bounds.min[2] + bounds.max[2]) * scale / 2]);
    for (const child of scene.listChildren()) { scene.removeChild(child); wrapper.addChild(child); }
    scene.addChild(wrapper);
    await document.transform(weld());
    if (level === 'far') for (const mesh of root.listMeshes()) for (const primitive of mesh.listPrimitives()) {
      simplifyPrimitive(primitive, { simplifier: MeshoptSimplifier, ratio: 0.45, error: 0.008, lockBorder: true });
    }
    document.createExtension(EXTTextureWebP).setRequired(true);
    root.getAsset().copyright = 'Insectoid Monster Rig by DM-913, CC BY 4.0. Geometry and textures adapted for NECROFALL. See ATTRIBUTION.md.';
    await document.transform(prune(), dedup(), resample(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    const name = `parasite-${level}.glb`;
    await io.write(path.join(outputRoot, name), document);
    const verified = await io.read(path.join(outputRoot, name));
    assert.equal(verified.getRoot().listSkins()[0].listJoints().length, source.getRoot().listSkins()[0].listJoints().length);
    assert.equal(verified.getRoot().listAnimations().length, source.getRoot().listAnimations().length);
    assert(verified.getRoot().listMeshes().some((mesh) => mesh.listPrimitives().some((primitive) => primitive.listTargets().length > 0)));
    const bytes = readFileSync(path.join(outputRoot, name));
    const variant = { file: name, triangles: countTriangles(verified), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    variants.push(variant);
    console.log(JSON.stringify({ parasite: 'Pollen Reaver', ...variant, animation: 'Prowl', skinPreserved: true, morphPreserved: true }));
  }
  writeFileSync(path.join(outputRoot, 'parasite.json'), JSON.stringify({ ...metadata, variants }, null, 2));
}

async function prepareGround() {
  const directory = path.join(cacheRoot, 'aerial_grass_rock');
  const metadata = JSON.parse(download('https://api.polyhaven.com/files/aerial_grass_rock', path.join(directory, 'files.json')));
  const results = [];
  for (const [channel, name] of [['Diffuse', 'color'], ['nor_gl', 'normal'], ['arm', 'arm']]) {
    const entry = metadata[channel]?.['1k']?.jpg;
    assert(entry?.url, `Missing terrain ${channel} texture`);
    const bytes = download(entry.url, path.join(directory, `${name}.jpg`), entry.md5);
    let processor = sharp(bytes).resize(1024, 1024);
    if (name === 'color') processor = processor.modulate({ saturation: 0.85, brightness: 1.12 });
    const output = await processor.webp({ quality: 95 }).toBuffer();
    const info = await sharp(output).metadata();
    assert.equal(info.width, 1024);
    assert.equal(info.height, 1024);
    const file = `ground-${name}.webp`;
    writeFileSync(path.join(outputRoot, file), output);
    results.push({ file, bytes: output.length, sha256: createHash('sha256').update(output).digest('hex') });
  }
  writeFileSync(path.join(outputRoot, 'ground.json'), JSON.stringify({
    source: 'https://polyhaven.com/a/aerial_grass_rock', author: 'Rob Tuytel', license: 'CC0-1.0',
    modifications: 'Subtle saturation/brightness adjustment and runtime texture compression.', files: results,
  }, null, 2));
  console.log(JSON.stringify(results, null, 2));
}

async function prepareProjectTrees() {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  io.registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
  for (const species of ['oak', 'cherry', 'birch']) {
    const original = path.resolve(`public/environment/folio/trees/${species}TreesVisual.glb`);
    const bytes = readFileSync(original);
    const document = await io.read(original);
    const root = document.getRoot();
    const markers = root.listNodes().filter((node) => node.getName().startsWith('treeLeaves'));
    assert(markers.length > 0, 'Original canopy markers are missing');
    assert(root.listNodes().some((node) => node.getName().startsWith('treeBody')), 'Original tree trunk is missing');
    for (const extension of root.listExtensionsUsed()) if (extension.extensionName === 'KHR_draco_mesh_compression') extension.dispose();
    await document.transform(prune(), dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    const file = `original-${species}.glb`;
    await io.write(path.join(outputRoot, file), document);
    const verified = await io.read(path.join(outputRoot, file));
    assert.equal(verified.getRoot().listNodes().filter((node) => node.getName().startsWith('treeLeaves')).length, markers.length);
    writeFileSync(path.join(outputRoot, `original-${species}.json`), JSON.stringify({
      source: `public/environment/folio/trees/${species}TreesVisual.glb`,
      sourceSHA256: createHash('sha256').update(bytes).digest('hex'),
      license: 'Existing project asset; retain its original applicable license and attribution. No new license asserted.',
      modifications: 'Container recompressed to Meshopt; trunk and canopy markers preserved for the user-authorized reuse.',
      file, canopyMarkers: markers.length,
    }, null, 2));
    console.log(`${species}: original trunk and ${markers.length} canopy markers retained; ${readFileSync(path.join(outputRoot, file)).length} bytes`);
  }
}

function inspect(recipe) {
  const { json, entry } = sourceMetadata(recipe);
  const meshes = (json.meshes ?? []).map((mesh, meshIndex) => ({
    mesh: meshIndex, name: mesh.name,
    triangles: mesh.primitives.reduce((total, primitive) => total + (json.accessors[primitive.indices ?? primitive.attributes.POSITION]?.count ?? 0) / 3, 0),
    materials: mesh.primitives.map((primitive) => json.materials[primitive.material]?.name),
  }));
  console.log(JSON.stringify({ asset: recipe.key, source: recipe.source,
    downloadMiB: Math.round(Object.values(entry.include ?? {}).reduce((total, dependency) => total + dependency.size, entry.size) / 1048576),
    meshes, nodes: (json.nodes ?? []).map((node) => ({ name: node.name, mesh: node.mesh })),
    materials: (json.materials ?? []).map((material) => ({ name: material.name, alpha: material.alphaMode, normal: Boolean(material.normalTexture) })),
  }, null, 2));
}

async function prepareMushroom() {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;
  const sourceFile = path.join(cacheRoot, 'mushrooms/source.glb');
  const original = await io.read(sourceFile);
  const variants = [];
  for (const level of ['near', 'far']) {
    const document = cloneDocument(original);
    const root = document.getRoot(), scene = root.listScenes()[0];
    const selected = root.listNodes().find((node) => node.getName() === 'Circle_mushroms_0');
    assert(selected?.getMesh(), 'The authored hero mushroom mesh is missing');
    const worldMatrix = selected.getWorldMatrix();
    for (const primitive of selected.getMesh().listPrimitives()) transformPrimitive(primitive, worldMatrix);
    for (const node of root.listNodes()) if (node !== selected && node.getMesh()) node.setMesh(null);
    for (const child of scene.listChildren()) scene.removeChild(child);
    selected.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
    scene.addChild(selected);
    await document.transform(prune(), weld());
    normalizeModel(document, { key: 'mushroom', height: 18 });
    if (level === 'far') for (const mesh of root.listMeshes()) for (const primitive of mesh.listPrimitives()) {
      simplifyPrimitive(primitive, { simplifier: MeshoptSimplifier, ratio: 0.5, error: 0.01, lockBorder: false });
    }
    for (const material of root.listMaterials()) {
      material.setName('fungus:painted').setRoughnessFactor(1).setMetallicFactor(0);
      material.setEmissiveFactor([0.25, 0.25, 0.25]);
    }
    for (const texture of root.listTextures()) {
      texture.setImage(await sharp(texture.getImage()).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 95 }).toBuffer()).setMimeType('image/webp').setURI('');
    }
    document.createExtension(EXTTextureWebP).setRequired(true);
    root.getAsset().copyright = 'Stylized mushrooms by QumoDone, CC BY 4.0. Selected mesh adapted for NECROFALL. See ATTRIBUTION.md.';
    await document.transform(dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    const file = `mushroom-${level}.glb`;
    await io.write(path.join(outputRoot, file), document);
    const verified = await io.read(path.join(outputRoot, file));
    assert.equal(verified.getRoot().listMeshes().length, 1);
    const result = { file, triangles: countTriangles(verified), bytes: readFileSync(path.join(outputRoot, file)).length };
    variants.push(result);
    console.log(JSON.stringify(result));
  }
  writeFileSync(path.join(outputRoot, 'mushroom.json'), JSON.stringify({
    source: 'https://sketchfab.com/3d-models/stylized-mushrooms-9d22e02ce2a548959b1c4c4c1d546842',
    author: 'QumoDone', license: 'CC-BY-4.0', licenseURL: 'https://creativecommons.org/licenses/by/4.0/',
    sourceSHA256: createHash('sha256').update(readFileSync(sourceFile)).digest('hex'),
    modifications: 'Hero mushroom mesh extracted, normalized, LOD/texture optimized; painted color and emission preserved for biome shading.', variants,
  }, null, 2));
}

async function receiveMushroomDownload() {
  const server = createServer((request, response) => {
    const origin = request.headers.origin;
    if (origin !== 'https://sketchfab.com' || request.url !== '/mushrooms') { response.writeHead(403).end(); return; }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 30000000) { request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const bytes = Buffer.concat(chunks);
      if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(8) !== bytes.length) { response.writeHead(400).end('Invalid GLB'); return; }
      const directory = path.join(cacheRoot, 'mushrooms');
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'source.glb'), bytes);
      const result = { saved: '.asset-sources/mushrooms/source.glb', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(result));
      console.log(JSON.stringify(result));
      server.close();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  console.log(`One-use authorized asset receiver: http://127.0.0.1:${server.address().port}/mushrooms`);
}

const argument = process.argv.find((value) => value.startsWith('--asset='))?.split('=')[1];
const selected = argument ? recipes.filter((recipe) => recipe.key === argument) : recipes;
assert(selected.length > 0, 'Unknown asset recipe');
if (process.argv.includes('--build-mushroom')) {
  await prepareMushroom();
} else if (process.argv.includes('--receive-mushrooms')) {
  await receiveMushroomDownload();
} else if (process.argv.includes('--build-project-trees')) {
  await prepareProjectTrees();
} else if (process.argv.includes('--build-ground')) {
  await prepareGround();
} else if (process.argv.includes('--build-parasite')) {
  await prepareParasite();
} else if (process.argv.includes('--build')) {
  for (const recipe of selected) await prepare(recipe);
} else if (process.argv.includes('--fetch')) {
  for (const recipe of selected) { acquire(recipe); console.log(`Source verified: ${recipe.key}`); }
} else if (process.argv.includes('--inspect')) {
  for (const recipe of selected) inspect(recipe);
}