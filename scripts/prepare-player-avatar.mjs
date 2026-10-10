import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds, transformPrimitive, weld, dedup, prune, simplify } from '@gltf-transform/functions';
import { Matrix4, Vector3, MathUtils } from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import manifold from 'manifold-3d';

const source = '.asset-sources/player-avatar/avatar.glb';
const output = 'src/player/assets/chameleon.glb';
mkdirSync('.asset-sources/player-avatar', { recursive: true });
mkdirSync('src/player/assets', { recursive: true });
if (process.argv[2]) copyFileSync(process.argv[2], source);
assert.ok(existsSync(source), 'Pass the original avatar.glb path as the first argument');
await MeshoptSimplifier.ready;
const library = await manifold();
library.setup();
const { Manifold, Mesh } = library;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const document = await io.read(source);
const root = document.getRoot(), buffer = root.listBuffers()[0];
assert.equal(root.listSkins().length, 0);
const original = getBounds(root.listScenes()[0]);
const scale = 1.9 / (original.max[1] - original.min[1]);
const normalize = new Matrix4().makeScale(scale, scale, scale);
normalize.setPosition(-(original.min[0] + original.max[0]) * scale / 2,
  -original.min[1] * scale, -(original.min[2] + original.max[2]) * scale / 2);
const accessor = (type, array) => document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const transform = normalize.clone().multiply(new Matrix4().fromArray(node.getWorldMatrix()));
  for (const primitive of mesh.listPrimitives()) {
    transformPrimitive(primitive, transform.elements);
    const input = new Mesh({ numProp: 3, vertProperties: primitive.getAttribute('POSITION').getArray(), triVerts: primitive.getIndices().getArray() });
    input.merge();
    const solid = new Manifold(input);
    assert.equal(solid.status(), 'NoError');
    const cleanSide = solid.warp(position => {
      position[0] += 0.032 * (1 - MathUtils.smoothstep(position[1], 0.60, 0.78)) * (1 - MathUtils.smoothstep(position[0], 0.12, 0.18));
    });
    const half = cleanSide.trimByPlane([1, 0, 0], -0.078).trimByPlane([0, -1, 0], -1.36).translate([0.078, 0, 0]);
    const upper = solid.trimByPlane([0, 1, 0], 1.4).decompose();
    const head = upper.filter(part => part.boundingBox().max[1] < 1.85).sort((first, second) => second.volume() - first.volume())[0];
    assert.ok(head, 'Unable to separate source head from the overhead arm');
    const neutral = half.add(half.mirror([1, 0, 0])).add(head.translate([-0.072, -0.09, 0]));
    assert.equal(neutral.status(), 'NoError');
    assert.equal(neutral.decompose().length, 1, 'Neutral avatar must be one connected solid');
    const surface = neutral.calculateNormals().getMesh();
    const positions = new Float32Array(surface.numVert * 3), normals = new Float32Array(surface.numVert * 3);
    for (let vertex = 0; vertex < surface.numVert; vertex++) {
      positions.set(surface.vertProperties.slice(vertex * surface.numProp, vertex * surface.numProp + 3), vertex * 3);
      normals.set(surface.vertProperties.slice(vertex * surface.numProp + 3, vertex * surface.numProp + 6), vertex * 3);
    }
    primitive.setAttribute('POSITION', accessor('VEC3', positions)).setAttribute('NORMAL', accessor('VEC3', normals));
    primitive.setAttribute('TEXCOORD_0', null).setIndices(accessor('SCALAR', surface.triVerts));
    for (const part of upper) part.delete();
    solid.delete(); cleanSide.delete(); half.delete(); neutral.delete();
  }
  node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
  node.setName('ChameleonAvatar'); mesh.setName('ChameleonAvatar');
}
await document.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0.18, error: 0.0008 }));
const definitions = [
  ['Hips', null, [0, 0.70, 0]],
  ['Spine', 'Hips', [0, 0.94, 0]],
  ['Chest', 'Spine', [0, 1.19, 0]],
  ['Neck', 'Chest', [0, 1.32, 0]],
  ['Head', 'Neck', [0, 1.50, 0]],
  ['UpperArm_L', 'Chest', [-0.292, 1.19, 0]],
  ['Forearm_L', 'UpperArm_L', [-0.313, 0.91, 0]],
  ['Hand_L', 'Forearm_L', [-0.313, 0.62, 0]],
  ['UpperArm_R', 'Chest', [0.292, 1.19, 0]],
  ['Forearm_R', 'UpperArm_R', [0.313, 0.91, 0]],
  ['Hand_R', 'Forearm_R', [0.313, 0.62, 0]],
  ['Thigh_L', 'Hips', [-0.132, 0.70, 0]],
  ['Shin_L', 'Thigh_L', [-0.130, 0.35, 0]],
  ['Foot_L', 'Shin_L', [-0.118, 0.062, 0]],
  ['Thigh_R', 'Hips', [0.132, 0.70, 0]],
  ['Shin_R', 'Thigh_R', [0.130, 0.35, 0]],
  ['Foot_R', 'Shin_R', [0.118, 0.062, 0]],
  ['FootTarget_L', null, [-0.118, 0.062, 0]],
  ['FootTarget_R', null, [0.118, 0.062, 0]],
];
const boneIndex = new Map(definitions.map(([name], index) => [name, index]));
let blendedVertices = 0;
for (const mesh of root.listMeshes()) for (const primitive of mesh.listPrimitives()) {
  const positions = primitive.getAttribute('POSITION');
  const parents = Array.from({ length: positions.getCount() }, (_, index) => index);
  const find = index => {
    while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; }
    return index;
  };
  const below = new Uint8Array(positions.getCount()), seen = new Map();
  for (let vertex = 0; vertex < positions.getCount(); vertex++) {
    const position = positions.getElement(vertex, []);
    below[vertex] = position[1] < 1.05 ? 1 : 0;
    if (!below[vertex]) continue;
    const key = position.map(value => Math.round(value * 1e5)).join(',');
    if (seen.has(key)) parents[find(vertex)] = find(seen.get(key));
    else seen.set(key, vertex);
  }
  const triangles = primitive.getIndices().getArray();
  for (let offset = 0; offset < triangles.length; offset += 3) {
    const vertices = Array.from(triangles.slice(offset, offset + 3)).filter(vertex => below[vertex]);
    for (const vertex of vertices.slice(1)) parents[find(vertex)] = find(vertices[0]);
  }
  const lowest = new Map();
  for (let vertex = 0; vertex < positions.getCount(); vertex++) if (below[vertex]) {
    const island = find(vertex);
    lowest.set(island, Math.min(lowest.get(island) ?? Infinity, positions.getElement(vertex, [])[1]));
  }
  const arms = new Set([...lowest].filter(([, height]) => height > 0.35).map(([island]) => island));
  assert.equal(arms.size, 2, 'Expected two separate lower-arm surfaces');
  const indices = new Uint16Array(positions.getCount() * 4), weights = new Float32Array(positions.getCount() * 4);
  for (let vertex = 0; vertex < positions.getCount(); vertex++) {
    const [horizontal, height] = positions.getElement(vertex, []);
    const contributions = new Map();
    const add = (name, weight) => { if (weight > 0.00001) contributions.set(name, (contributions.get(name) ?? 0) + weight); };
    const blend = (first, second, amount, weight) => { add(first, weight * (1 - amount)); add(second, weight * amount); };
    const armGate = MathUtils.smoothstep(Math.abs(horizontal), 0.19, 0.265) * (1 - MathUtils.smoothstep(height, 1.12, 1.32));
    const arm = below[vertex] ? MathUtils.lerp(arms.has(find(vertex)) ? 1 : 0, armGate, MathUtils.smoothstep(height, 0.96, 1.05)) : armGate;
    const suffix = horizontal < 0 ? 'L' : 'R';
    const elbow = 1 - MathUtils.smoothstep(height, 0.83, 0.99), hand = 1 - MathUtils.smoothstep(height, 0.64, 0.735);
    add(`UpperArm_${suffix}`, arm * (1 - elbow));
    add(`Forearm_${suffix}`, arm * elbow * (1 - hand));
    add(`Hand_${suffix}`, arm * elbow * hand);
    const legs = (1 - arm) * (1 - MathUtils.smoothstep(height, 0.60, 0.76));
    const knee = 1 - MathUtils.smoothstep(height, 0.27, 0.43), ankle = 1 - MathUtils.smoothstep(height, 0.09, 0.19);
    const side = MathUtils.smoothstep(horizontal, -0.055, 0.055);
    for (const [leg, share] of [['L', 1 - side], ['R', side]]) {
      add(`Thigh_${leg}`, legs * share * (1 - knee));
      add(`Shin_${leg}`, legs * share * knee * (1 - ankle));
      add(`Foot_${leg}`, legs * share * knee * ankle);
    }
    const torso = Math.max(0, 1 - arm - legs);
    if (height < 1.05) blend('Hips', 'Spine', MathUtils.smoothstep(height, 0.79, 0.99), torso);
    else if (height < 1.28) blend('Spine', 'Chest', MathUtils.smoothstep(height, 1.05, 1.22), torso);
    else if (height < 1.34) blend('Chest', 'Neck', MathUtils.smoothstep(height, 1.28, 1.34), torso);
    else blend('Neck', 'Head', MathUtils.smoothstep(height, 1.34, 1.40), torso);
    const ranked = [...contributions].sort((first, second) => second[1] - first[1]).slice(0, 4);
    const total = ranked.reduce((sum, [, weight]) => sum + weight, 0);
    assert.ok(total > 0);
    if (ranked.length > 1) blendedVertices++;
    ranked.forEach(([name, weight], influence) => {
      indices[vertex * 4 + influence] = boneIndex.get(name);
      weights[vertex * 4 + influence] = weight / total;
    });
  }
  primitive.setAttribute('JOINTS_0', accessor('VEC4', indices)).setAttribute('WEIGHTS_0', accessor('VEC4', weights));
}
const neutral = getBounds(root.listScenes()[0]);
const neutralScale = 1.9 / (neutral.max[1] - neutral.min[1]);
const fit = new Matrix4().makeScale(neutralScale, neutralScale, neutralScale);
fit.setPosition(0, -neutral.min[1] * neutralScale, 0);
for (const mesh of root.listMeshes()) for (const primitive of mesh.listPrimitives()) transformPrimitive(primitive, fit.elements);
const joints = definitions.map(([name, parent, target]) => ({ name, parent, position: new Vector3(...target).applyMatrix4(fit).toArray() }));
const nodes = joints.map(joint => document.createNode(joint.name));
const skeletonRoot = document.createNode('ChameleonSkeletonRoot');
root.listScenes()[0].addChild(skeletonRoot);
const skin = document.createSkin('ChameleonSkeleton').setSkeleton(skeletonRoot);
const inverseBinds = [];
joints.forEach((joint, index) => {
  const parent = boneIndex.get(joint.parent), origin = parent === undefined ? [0, 0, 0] : joints[parent].position;
  nodes[index].setTranslation(joint.position.map((value, axis) => value - origin[axis]));
  if (parent === undefined) skeletonRoot.addChild(nodes[index]);
  else nodes[parent].addChild(nodes[index]);
  skin.addJoint(nodes[index]);
  inverseBinds.push(...new Matrix4().makeTranslation(...joint.position).invert().elements);
});
skin.setInverseBindMatrices(accessor('MAT4', new Float32Array(inverseBinds)));
for (const node of root.listNodes()) if (node.getMesh()) node.setSkin(skin);
await document.transform(dedup(), prune());
await io.write(output, document);
const verified = await io.read(output), bounds = getBounds(verified.getRoot().listScenes()[0]);
assert.ok(Math.abs(bounds.max[1] - 1.9) < 0.00001 && Math.abs(bounds.min[1]) < 0.00001);
assert.equal(verified.getRoot().listSkins()[0].listJoints().length, 19);
let vertices = 0, weightError = 0;
for (const mesh of verified.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
  const weights = primitive.getAttribute('WEIGHTS_0');
  vertices += weights.getCount();
  for (let vertex = 0; vertex < weights.getCount(); vertex++) weightError = Math.max(weightError, Math.abs(1 - weights.getElement(vertex, []).reduce((sum, value) => sum + value, 0)));
}
assert.ok(weightError < 0.0001 && blendedVertices > 1000);
const report = {
  sourceSHA256: createHash('sha256').update(readFileSync(source)).digest('hex'),
  sourceName: 'meccha-chameleon-white-character/source/avatar.glb',
  preparation: 'Closed neutral body from the source clean side; original head and material retained; overhead arm repaired by symmetry.',
  height: 1.9, bounds, bytes: readFileSync(output).length, vertices, weightError, blendedVertices, joints,
  headRadius: 0.178 * neutralScale, backDepth: -0.14 * neutralScale,
};
writeFileSync('src/player/assets/chameleon.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, joints: joints.length }, null, 2));