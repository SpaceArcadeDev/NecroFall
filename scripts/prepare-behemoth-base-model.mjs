import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, getBounds, meshopt, prune, simplify, transformPrimitive, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { BufferGeometry, Float32BufferAttribute } from 'three/webgpu';
import { createServer } from 'vite';
import sharp from 'sharp';

const output = 'src/enemies/base_models/behemoth.glb';
const source = '.asset-sources/behemoth/source.glb';
mkdirSync('.asset-sources/behemoth', { recursive: true });
if (!existsSync(source)) copyFileSync(output, source);
await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder,
});
const document = await io.read(source);
const root = document.getRoot();
assert.equal(root.listSkins().length, 0, 'The preserved source must be the original static model');
const bounds = getBounds(root.listScenes()[0]);
const scale = 1 / (bounds.max[1] - bounds.min[1]);
const matrix = [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0,
  -(bounds.min[0] + bounds.max[0]) * scale / 2, -bounds.min[1] * scale,
  -(bounds.min[2] + bounds.max[2]) * scale / 2, 1];
for (const mesh of root.listMeshes()) for (const primitive of mesh.listPrimitives()) transformPrimitive(primitive, matrix);
await document.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0.09, error: 0.006 }));

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { autoRig, BEHEMOTH_RIG } = await server.ssrLoadModule('/src/enemies/imported/AutoRig.ts');
  const buffer = root.listBuffers()[0];
  const joints = BEHEMOTH_RIG.joints.map(joint => document.createNode(joint.name));
  BEHEMOTH_RIG.joints.forEach((joint, index) => {
    const parentIndex = BEHEMOTH_RIG.joints.findIndex(candidate => candidate.name === joint.parent);
    const parent = parentIndex >= 0 ? BEHEMOTH_RIG.joints[parentIndex].position : [0, 0, 0];
    joints[index].setTranslation(joint.position.map((value, axis) => value - parent[axis]));
    if (parentIndex >= 0) joints[parentIndex].addChild(joints[index]);
  });
  root.listScenes()[0].addChild(joints[0]);
  let skin;
  for (const mesh of root.listMeshes()) for (const primitive of mesh.listPrimitives()) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(primitive.getAttribute('POSITION').getArray(), 3));
    const skeleton = autoRig(geometry, BEHEMOTH_RIG);
    primitive.setAttribute('JOINTS_0', document.createAccessor().setType('VEC4').setArray(geometry.attributes.skinIndex.array).setBuffer(buffer));
    primitive.setAttribute('WEIGHTS_0', document.createAccessor().setType('VEC4').setArray(geometry.attributes.skinWeight.array).setBuffer(buffer));
    if (!skin) {
      skin = document.createSkin('behemoth:anatomical').setSkeleton(joints[0]);
      joints.forEach(joint => skin.addJoint(joint));
      const inverses = new Float32Array(skeleton.boneInverses.flatMap(inverse => inverse.toArray()));
      skin.setInverseBindMatrices(document.createAccessor().setType('MAT4').setArray(inverses).setBuffer(buffer));
    }
    geometry.dispose();
    skeleton.dispose();
  }
  for (const node of root.listNodes()) if (node.getMesh()) node.setSkin(skin);
} finally { await server.close(); }

for (const material of root.listMaterials()) {
  material.setName('behemoth:chitin').setMetallicFactor(0).setRoughnessFactor(0.9);
  for (const extension of material.listExtensions()) material.setExtension(extension.extensionName, null);
}
for (const texture of root.listTextures()) {
  const base = root.listMaterials().some(material => material.getBaseColorTexture() === texture);
  let image;
  if (base) {
    const { data, info } = await sharp(texture.getImage()).resize(1024, 1024, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const palette = [[24, 29, 38], [112, 63, 100], [199, 230, 128]];
    for (let offset = 0; offset < data.length; offset += info.channels) {
      const level = Math.min(1, Math.max(0, ((data[offset] * 0.24 + data[offset + 1] * 0.63 + data[offset + 2] * 0.13) / 255 - 0.06) / 0.55));
      const band = level < 0.45 ? 0 : 1;
      const blend = band === 0 ? level / 0.45 : (level - 0.45) / 0.55;
      for (let channel = 0; channel < 3; channel++) data[offset + channel] = Math.round(palette[band][channel] * (1 - blend) + palette[band + 1][channel] * blend);
    }
    image = await sharp(data, { raw: info }).webp({ quality: 94 }).toBuffer();
  } else image = await sharp(texture.getImage()).resize(1024, 1024, { fit: 'inside' }).webp({ quality: 90 }).toBuffer();
  texture.setImage(image).setMimeType('image/webp').setURI('');
}
document.createExtension(EXTTextureWebP).setRequired(true);
root.getAsset().generator = 'NecroFall anatomical Behemoth pipeline';
await document.transform(prune(), dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
await io.write(output, document);
const verified = await io.read(output);
assert.equal(verified.getRoot().listSkins()[0].listJoints().length, 24);
let vertices = 0;
let worstWeightError = 0;
for (const mesh of verified.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
  const weights = primitive.getAttribute('WEIGHTS_0');
  vertices += weights.getCount();
  for (let vertex = 0; vertex < weights.getCount(); vertex++) {
    worstWeightError = Math.max(worstWeightError, Math.abs(1 - weights.getElement(vertex, []).reduce((sum, value) => sum + value, 0)));
  }
}
assert.ok(vertices > 5000 && worstWeightError < 0.01);
const report = { source, sourceSHA256: createHash('sha256').update(readFileSync(source)).digest('hex'), vertices,
  joints: 24, clips: 0, animation: 'runtime terrain-contact IK, no baked movement', worstWeightError,
  bytes: readFileSync(output).length, bounds: getBounds(verified.getRoot().listScenes()[0]) };
writeFileSync('src/enemies/base_models/behemoth.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));