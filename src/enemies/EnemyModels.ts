// NECROFALL — procedural Necrophage creature models.
// Every archetype is assembled from shared low-poly primitives and shaded with two
// custom shaders: a veined *carapace* material and an emissive *energy* material.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { EnemyGenome } from './EnemyGenomes';
import { nfUniforms, NF_UNIFORMS_GLSL, NF_LIGHTING_GLSL, NF_FOG_GLSL } from '../world/ShaderGlobals';
import { Rand } from '../utils/Utils';

const GEO = {
  shell: new THREE.IcosahedronGeometry(1, 2),
  head: new THREE.SphereGeometry(1, 10, 8),
  snout: new THREE.ConeGeometry(1, 1, 7),
  eye: new THREE.SphereGeometry(1, 7, 6),
  spike: new THREE.ConeGeometry(1, 1, 5),
  claw: new THREE.ConeGeometry(1, 1, 5),
  leg: new THREE.CylinderGeometry(1, 0.7, 1, 6),
  plate: new THREE.CylinderGeometry(1, 0.66, 1, 9),
  core: new THREE.IcosahedronGeometry(1, 1),
  crown: new THREE.TorusGeometry(1, 0.14, 6, 14),
};

const _m4 = new THREE.Matrix4();

/** The one colour every freeze surface is built from: pale, cold, unmistakably "ice". */
const ICE_GLSL = /* glsl */ `
  const vec3 ICE_COL = vec3(0.60, 0.90, 1.00);
`;

const CARAPACE_VERT = /* glsl */ `
  varying vec3 vColor;
  varying vec3 vN;
  varying vec3 vW;
  varying vec3 vUp;
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
    vW = wp;
    vUp = normalize(vec3(0.0, 0.0, 0.0) - wp);
    vN = normalize(mat3(modelMatrix) * normal);
    vColor = color;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const CARAPACE_FRAG = /* glsl */ `
  ${NF_UNIFORMS_GLSL}
  ${ICE_GLSL}
  uniform vec3 uShell;
  uniform vec3 uAccent;
  uniform float uAggro;
  uniform float uMembrane;
  uniform float uFlash;
  uniform float uFreeze;
  uniform float uIcePhase;
  varying vec3 vColor;
  varying vec3 vN;
  varying vec3 vW;
  varying vec3 vUp;
  varying vec3 vLocal;
  ${NF_LIGHTING_GLSL}
  ${NF_FOG_GLSL}

  void main() {
    // faceted (flat) normals reconstructed from screen-space derivatives -> crisp low-poly carapace
    vec3 n = normalize(vN);
    vec3 facet = normalize(cross(dFdx(vW), dFdy(vW)));
    if (dot(facet, facet) > 0.001) n = facet * sign(dot(facet, n));

    vec3 radialUp = normalize(vW);           // planet centre at origin
    vec3 base = uShell * (0.78 + 0.45 * vColor.r);
    vec3 lit = nfLight(base, n, radialUp, vW, 0.3);
    // carapace energy veins
    float vein = sin(vW.x * 1.7) * sin(vW.y * 1.35 + uTime * 0.6) * sin(vW.z * 1.55);
    float v = smoothstep(0.55, 0.98, vein * 0.5 + 0.5);
    lit += uAccent * v * (0.3 + uAggro * 0.8);
    lit = mix(lit, uFogColor, nfFog(vW));

    vec3 viewDir = normalize(uCamPos - vW);

    // translucent jelly membranes glow from the inside
    if (uMembrane > 0.01) {
      float inner = pow(1.0 - clamp(abs(dot(n, viewDir)), 0.0, 1.0), 1.5);
      lit += uAccent * (0.35 + inner * 0.9) * uMembrane;
    }

    // FROST: the WHOLE carapace crusts over in pale blue. uFreeze says how frozen the body is
    // (0 chilled .. 1 solid); the throb is applied here off uTime so it pulses on every client, not
    // just the host that runs the simulation, and a fresh ice phase per creature stops a frozen
    // crowd from breathing in unison. Frost crystals ride on the local position so the crust reads
    // as a growth over the shell rather than a flat blue wash.
    if (uFreeze > 0.001) {
      float rim = pow(1.0 - clamp(abs(dot(n, viewDir)), 0.0, 1.0), 1.35);
      float crust = sin(vLocal.x * 2.3) * sin(vLocal.y * 2.9) * sin(vLocal.z * 2.1);
      crust = smoothstep(-0.1, 0.85, crust);
      float throb = 0.78 + 0.22 * sin(uTime * 3.6 + uIcePhase);
      float k = clamp(uFreeze * throb * (0.62 + 0.24 * rim + 0.2 * crust), 0.0, 0.86);
      lit = mix(lit, ICE_COL, k) + ICE_COL * rim * uFreeze * throb * 0.35;
    }

    // short white flash on every hit so damage always reads instantly
    lit = mix(lit, vec3(1.0), clamp(uFlash, 0.0, 1.0));
    float alpha = uMembrane > 0.01 ? mix(1.0, 0.72, uMembrane) : 1.0;
    gl_FragColor = vec4(lit, alpha);
  }
`;

const ENERGY_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vW;
  varying float vX;
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
    vW = wp;
    vX = position.x + position.y;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const ENERGY_FRAG = /* glsl */ `
  ${NF_UNIFORMS_GLSL}
  ${ICE_GLSL}
  uniform vec3 uGlow;
  uniform float uPulse;
  uniform float uFlash;
  uniform float uFreeze;
  uniform float uIcePhase;
  varying vec3 vN;
  varying vec3 vW;
  varying float vX;
  varying vec3 vLocal;
  void main() {
    vec3 viewDir = normalize(uCamPos - vW);
    float fres = pow(1.0 - clamp(dot(normalize(vN), viewDir), 0.0, 1.0), 1.6);
    float pulse = 0.65 + 0.35 * sin(uTime * 4.0 * uPulse + vX * 2.0);
    vec3 col = uGlow * (0.55 + 0.9 * fres) * pulse;
    // FROST: the glowing bits (eyes, cores, maw) ice over too, or the body reads half-frozen.
    if (uFreeze > 0.001) {
      float throb = 0.78 + 0.22 * sin(uTime * 3.6 + uIcePhase);
      col = mix(col, ICE_COL * 1.25, clamp(uFreeze * 0.85 * throb, 0.0, 0.92));
    }
    col = mix(col, vec3(1.0), clamp(uFlash, 0.0, 1.0));
    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface CreatureLeg {
  root: THREE.Group;
  knee: THREE.Group;
  side: number;
  phase: number;
}

export interface CreatureRig {
  group: THREE.Group;
  legs: CreatureLeg[];
  /** Segmented bodies (worms): a chain of meshes driven as a travelling wave. */
  segments: THREE.Mesh[];
  head: THREE.Group;
  body: THREE.Object3D;
  core: THREE.Mesh | null;
  coreBase: number;
  tail: THREE.Group | null;
  carapace: THREE.ShaderMaterial;
  energy: THREE.ShaderMaterial;
  /** Every material that carries uFlash — hit feedback whitens the whole body. */
  flashMats: THREE.ShaderMaterial[];
  scale: number;
  jelly: number;
  jellyBase: THREE.Vector3;
}

function makeCarapace(shellHex: number, accentHex: number, glowStrength: number, membrane: number): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    vertexShader: CARAPACE_VERT,
    fragmentShader: CARAPACE_FRAG,
    vertexColors: true,
    uniforms: nfUniforms({
      uShell: { value: new THREE.Color(shellHex) },
      uAccent: { value: new THREE.Color(accentHex) },
      uAggro: { value: 0 },
      uMembrane: { value: membrane },
      uFlash: { value: 0 },
      uFreeze: { value: 0 },
      uIcePhase: { value: 0 },
    }),
  });
  if (membrane > 0.05) {
    mat.transparent = true;
    mat.depthWrite = true;
  }
  return mat;
}

function makeEnergy(glowHex: number, pulse: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: ENERGY_VERT,
    fragmentShader: ENERGY_FRAG,
    uniforms: nfUniforms({
      uGlow: { value: new THREE.Color(glowHex) },
      uPulse: { value: pulse },
      uFlash: { value: 0 },
      uFreeze: { value: 0 },
      uIcePhase: { value: 0 },
    }),
  });
}

/**
 * Collapses the rig down to as few draw calls as possible.
 *
 * A creature is assembled from 20-45 little meshes, and at 100+ Necrophages that meant thousands of
 * draw calls per frame (measured: 3,260 calls / 106 ms) — a hard freeze on modest GPUs. Every
 * group's *static* meshes that share a material are therefore merged into a single mesh, with each
 * child's local transform baked in. Parts that are animated individually (segmented bodies, the
 * pulsing core, the boss crown) are deliberately left alone, and so are the groups themselves, so
 * the walk cycle and hit flashes keep working.
 */
function mergeStaticChildren(root: THREE.Object3D, skip: Set<THREE.Object3D>): number {
  let removed = 0;
  const walk = (parent: THREE.Object3D): void => {
    // bucket direct mesh children by material
    const buckets = new Map<THREE.Material, THREE.Mesh[]>();
    for (const child of [...parent.children]) {
      if (!(child as THREE.Mesh).isMesh) continue;
      if (skip.has(child)) continue;
      const mesh = child as THREE.Mesh;
      const mat = mesh.material as THREE.Material;
      const list = buckets.get(mat);
      if (list) list.push(mesh);
      else buckets.set(mat, [mesh]);
    }
    for (const [, meshes] of buckets) {
      if (meshes.length < 2) continue;
      const parts: THREE.BufferGeometry[] = [];
      for (const m of meshes) {
        m.updateMatrix();
        // toNonIndexed normalises attribute sets so primitives of different kinds can merge
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        g.applyMatrix4(m.matrix);
        parts.push(g);
      }
      const merged = mergeGeometries(parts, false);
      for (const g of parts) g.dispose();
      if (!merged) continue;
      const first = meshes[0];
      const combined = new THREE.Mesh(merged, first.material);
      combined.name = `${first.name || 'part'}-merged`;
      // merged parts are already in parent space
      parent.add(combined);
      for (const m of meshes) {
        parent.remove(m);
        removed++;
      }
    }
    for (const child of [...parent.children]) {
      if (child.children.length > 0) walk(child);
    }
  };
  walk(root);
  return removed;
}

/**
 * Builds one creature from its genome. Supports three body plans:
 * legged (spiders / crawlers / brutes), jelly blobs (slimes) and segmented
 * burrowers (worms). `variantGate` shifts proportions/colour per instance.
 */
export function buildCreature(genome: EnemyGenome, variantGate: number): CreatureRig {
  const v = genome.visual;
  const rand = new Rand(variantGate * 2654435761);
  const s = genome.scale;

  const shellBase = new THREE.Color(genome.color).multiplyScalar(0.62);
  shellBase.offsetHSL(rand.range(-0.03, 0.03), rand.range(-0.06, 0.08), rand.range(-0.05, 0.08));
  const accent = new THREE.Color(genome.accent);
  const isBoss = genome.tier === 'boss' || genome.tier === 'nexus';
  const carapace = makeCarapace(shellBase.getHex(), accent.getHex(), isBoss ? 0.55 : 0.34, v.membrane);
  const energy = makeEnergy(genome.accent, isBoss ? 1.6 : 2.2);
  // One shared frost phase per creature (the two materials breathe together) and a per-instance
  // offset, so a herd of frozen Necrophages throbs out of step instead of in lockstep.
  const icePhase = rand.range(0, Math.PI * 2);
  carapace.uniforms.uIcePhase.value = icePhase;
  energy.uniforms.uIcePhase.value = icePhase;

  const group = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = s * 0.62;
  group.add(body);

  const wMul = v.bodyWidth * rand.range(0.94, 1.06);
  const lMul = v.bodyLength * rand.range(0.94, 1.08);
  const hMul = v.bodyHeight * rand.range(0.92, 1.08);

  const segments: THREE.Mesh[] = [];
  const legs: CreatureLeg[] = [];
  let head = new THREE.Group();
  let core: THREE.Mesh | null = null;
  let tail: THREE.Group | null = null;
  const coreBase = s * 0.22;

  if (v.segments > 2) {
    // ---------------- segmented burrower (worm): a chain of body rings
    const count = Math.round(v.segments);
    let parent: THREE.Object3D = body;
    for (let i = 0; i < count; i++) {
      const k = i / (count - 1);
      const ring = new THREE.Mesh(i === 0 ? GEO.shell : GEO.plate, carapace);
      const rw = s * (0.62 - k * 0.34) * wMul;
      ring.scale.set(rw, rw * 1.0, s * (0.45 - k * 0.14) * lMul);
      ring.position.z = i === 0 ? 0 : -s * (0.5 - k * 0.06) * lMul;
      parent.add(ring);
      segments.push(ring);
      // each following ring hangs off the previous one so the chain can wriggle
      if (i > 0) parent = ring;
    }
    const headGroup = new THREE.Group();
    headGroup.position.set(0, s * 0.1, s * 0.62 * lMul);
    const skull = new THREE.Mesh(GEO.head, carapace);
    skull.scale.set(s * 0.34 * wMul, s * 0.3, s * 0.34);
    headGroup.add(skull);
    // circular maw with teeth
    const maw = new THREE.Mesh(GEO.core, energy);
    maw.scale.setScalar(s * 0.14);
    maw.position.z = s * 0.28;
    headGroup.add(maw);
    for (let i = 0; i < Math.max(3, v.mandibles); i++) {
      const a = (i / Math.max(3, v.mandibles)) * Math.PI * 2;
      const tooth = new THREE.Mesh(GEO.claw, energy);
      tooth.scale.setScalar(s * 0.13);
      tooth.position.set(Math.cos(a) * s * 0.24, Math.sin(a) * s * 0.24, s * 0.3);
      tooth.rotation.set(Math.PI * 0.5, 0, -a);
      headGroup.add(tooth);
    }
    for (let i = 0; i < Math.max(2, v.eyes); i++) {
      const eye = new THREE.Mesh(GEO.eye, energy);
      eye.scale.setScalar(s * 0.07);
      eye.position.set((i % 2 === 0 ? -1 : 1) * s * 0.16, s * 0.22, s * 0.3);
      headGroup.add(eye);
    }
    body.add(headGroup);
    head = headGroup;
    if (v.core) {
      core = new THREE.Mesh(GEO.core, energy);
      core.scale.setScalar(coreBase);
      core.position.set(0, s * 0.1, -s * 0.4);
      body.add(core);
    }
  } else if (v.jelly > 0.5) {
    // ---------------- jelly blob (slime): wobbling translucent sac + inner nuclei
    const sac = new THREE.Mesh(GEO.shell, carapace);
    sac.scale.set(s * 0.85 * wMul, s * 0.78 * hMul, s * 0.9 * lMul);
    body.add(sac);
    const cap = new THREE.Mesh(GEO.shell, carapace);
    cap.scale.set(s * 0.66 * wMul, s * 0.5 * hMul, s * 0.68 * lMul);
    cap.position.set(0, s * 0.42 * hMul, -s * 0.12 * lMul);
    body.add(cap);
    // nuclei
    for (let i = 0; i < 3; i++) {
      const nuc = new THREE.Mesh(GEO.core, energy);
      const a = rand.range(0, Math.PI * 2);
      nuc.scale.setScalar(s * rand.range(0.1, 0.2));
      nuc.position.set(Math.cos(a) * s * 0.3, s * rand.range(-0.1, 0.35), Math.sin(a) * s * 0.3);
      body.add(nuc);
    }
    // eyes scattered on the sac
    for (let i = 0; i < Math.max(2, v.eyes); i++) {
      const a = rand.range(0, Math.PI * 2);
      const eye = new THREE.Mesh(GEO.eye, energy);
      eye.scale.setScalar(s * rand.range(0.06, 0.1));
      eye.position.set(Math.cos(a) * s * 0.5 * wMul, s * rand.range(0.0, 0.3), Math.sin(a) * s * 0.55 * lMul);
      body.add(eye);
    }
    if (v.spikes > 0) {
      for (let i = 0; i < v.spikes; i++) {
        const a = (i / v.spikes) * Math.PI * 2;
        const sp = new THREE.Mesh(GEO.spike, energy);
        sp.scale.set(s * 0.08, s * 0.3 * v.spikeSize, s * 0.08);
        sp.position.set(Math.cos(a) * s * 0.5 * wMul, s * 0.5, Math.sin(a) * s * 0.5 * lMul);
        sp.rotation.set(0.6, -a, 0);
        body.add(sp);
      }
    }
    core = new THREE.Mesh(GEO.core, energy);
    core.scale.setScalar(coreBase);
    body.add(core);
  } else {
    // ---------------- legged chassis (spider / crawler / brute)
    const thorax = new THREE.Mesh(GEO.shell, carapace);
    thorax.scale.set(s * 0.6 * wMul, s * 0.54 * hMul, s * 0.78 * lMul);
    body.add(thorax);
    const abdomen = new THREE.Mesh(GEO.shell, carapace);
    abdomen.scale.set(s * 0.48 * wMul, s * 0.44 * hMul, s * 0.58 * lMul);
    abdomen.position.set(0, -s * 0.05, -s * 0.7 * lMul);
    abdomen.rotation.x = 0.16;
    body.add(abdomen);
    segments.push(thorax, abdomen);

    for (let i = 0; i < v.plates; i++) {
      const k = v.plates > 1 ? i / (v.plates - 1) : 0;
      const plate = new THREE.Mesh(GEO.plate, i % 2 === 0 ? carapace : energy);
      plate.scale.set(s * (0.52 - k * 0.14) * wMul, s * 0.16, s * (0.34 - k * 0.05) * lMul);
      plate.position.set(0, s * (0.28 + Math.sin(k * Math.PI) * 0.12) * hMul, s * (0.32 - k * 0.72) * lMul);
      plate.rotation.x = 0.1 + k * 0.25;
      body.add(plate);
    }

    head = new THREE.Group();
    head.position.set(0, s * 0.12, s * 0.86 * lMul);
    const skull = new THREE.Mesh(GEO.head, carapace);
    skull.scale.set(s * 0.32 * wMul, s * 0.28, s * 0.36);
    head.add(skull);
    const snout = new THREE.Mesh(GEO.snout, carapace);
    snout.scale.set(s * 0.18, s * 0.34, s * 0.18);
    snout.rotation.x = Math.PI / 2;
    snout.position.z = s * 0.36;
    head.add(snout);
    for (let i = 0; i < v.mandibles; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const m = new THREE.Mesh(GEO.claw, energy);
      m.scale.setScalar(s * 0.26);
      m.position.set(side * s * 0.24, -s * 0.1, s * 0.34 + Math.floor(i / 2) * s * 0.12);
      m.rotation.set(-0.9, 0, side * 0.4);
      head.add(m);
    }
    for (let i = 0; i < v.eyes; i++) {
      const a = (i - (v.eyes - 1) / 2) * 0.45;
      const e = new THREE.Mesh(GEO.eye, energy);
      e.scale.setScalar(s * 0.075);
      e.position.set(Math.sin(a) * s * 0.28 * wMul, s * 0.08 + (i % 2) * s * 0.09, s * 0.26 * Math.cos(a) + s * 0.08);
      head.add(e);
    }
    body.add(head);

    for (let i = 0; i < v.spikes; i++) {
      const k = v.spikes > 1 ? i / (v.spikes - 1) : 0.5;
      const spike = new THREE.Mesh(GEO.spike, carapace);
      const size = s * (0.12 + 0.16 * Math.sin(k * Math.PI)) * v.spikeSize;
      spike.scale.set(size, size * 2.6, size);
      spike.position.set(0, s * (0.3 + 0.16 * Math.sin(k * Math.PI)) * hMul, s * (0.42 - k * 1.25) * lMul);
      spike.rotation.x = -0.5 - 0.35 * Math.sin(k * Math.PI);
      body.add(spike);
    }

    for (let i = 0; i < v.horns; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const row = Math.floor(i / 2);
      const horn = new THREE.Mesh(GEO.spike, energy);
      horn.scale.set(s * 0.09, s * (0.5 - row * 0.08), s * 0.09);
      horn.position.set(side * s * (0.24 + row * 0.08), s * (0.16 + row * 0.06), s * (0.4 - row * 0.2));
      horn.rotation.set(-0.75, 0, side * (0.7 + row * 0.15));
      body.add(horn);
    }

    if (v.tail) {
      tail = new THREE.Group();
      tail.position.set(0, -s * 0.02, -s * 1.05 * lMul);
      for (let i = 0; i < 4; i++) {
        const seg = new THREE.Mesh(GEO.plate, i === 3 ? energy : carapace);
        const k = i / 3;
        seg.scale.set(s * (0.22 - k * 0.14), s * (0.12 - k * 0.06), s * (0.28 - k * 0.16));
        seg.rotation.x = Math.PI / 2;
        seg.position.z = -s * (0.3 + i * 0.34);
        tail.add(seg);
      }
      body.add(tail);
    }

    if (v.core) {
      core = new THREE.Mesh(GEO.core, energy);
      core.scale.setScalar(coreBase);
      core.position.set(0, s * 0.06, -s * 0.1);
      body.add(core);
    }

    // legs: hip -> (upper) -> knee -> (lower + claw)
    for (let i = 0; i < v.legPairs * 2; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const row = Math.floor(i / 2);
      const root = new THREE.Group();
      const z = (row - (v.legPairs - 1) / 2) * s * 0.62 * lMul;
      const thickness = s * v.legThickness;
      const upperLen = s * v.legLength * 0.6;
      const lowerLen = s * v.legLength * 0.6;
      root.position.set(side * s * 0.42 * wMul, -s * 0.08, z);
      root.rotation.z = side * 0.55;

      const upper = new THREE.Mesh(GEO.leg, carapace);
      upper.scale.set(thickness, upperLen, thickness);
      upper.position.y = -upperLen * 0.5;
      root.add(upper);

      const knee = new THREE.Group();
      knee.position.y = -upperLen;
      knee.rotation.z = side * -0.75;
      root.add(knee);

      const lower = new THREE.Mesh(GEO.leg, carapace);
      lower.scale.set(thickness * 0.8, lowerLen, thickness * 0.8);
      lower.position.y = -lowerLen * 0.5;
      knee.add(lower);

      // the claw shares the carapace material so it merges with the lower leg: one draw per knee
      const claw = new THREE.Mesh(GEO.claw, carapace);
      claw.scale.setScalar(thickness * 1.1);
      claw.position.y = -lowerLen;
      claw.rotation.x = Math.PI;
      knee.add(claw);

      body.add(root);
      // Collapse the whole leg (hip + knee + claw) into ONE mesh: legs are the biggest draw-call
      // item on a spider (8 of them), and the hip swing reads as a walk cycle on its own.
      knee.updateMatrix();
      const parts: THREE.BufferGeometry[] = [];
      const bake = (mesh: THREE.Mesh, extra: THREE.Matrix4 | null): void => {
        mesh.updateMatrix();
        const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
        if (extra) g.applyMatrix4(_m4.multiplyMatrices(extra, mesh.matrix));
        else g.applyMatrix4(mesh.matrix);
        parts.push(g);
      };
      bake(upper, null);
      bake(lower, knee.matrix);
      bake(claw, knee.matrix);
      const legGeo = mergeGeometries(parts, false);
      for (const g of parts) g.dispose();
      if (legGeo) {
        root.remove(upper);
        knee.clear();
        root.add(new THREE.Mesh(legGeo, carapace));
      }
      legs.push({ root, knee, side, phase: row * 0.85 + (side > 0 ? Math.PI : 0) });
    }
  }

  // ---- trait-driven dorsal hardware.
  // Vents say "this one shoots", glowing sacs say "this one bursts". Both are built from parts the
  // kit already owns (snout cones, spikes, energy nodes), so a behaviour trait never invents a look
  // of its own — it only decides how much of the existing kit the creature grew.
  const tubes = Math.round(v.tubes ?? 0);
  for (let i = 0; i < tubes; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const tube = new THREE.Mesh(GEO.snout, carapace);
    tube.scale.set(s * 0.1, s * (0.6 - row * 0.08), s * 0.1);
    tube.position.set(side * s * (0.16 + row * 0.06), s * 0.44, s * (0.3 - row * 0.24) * lMul);
    tube.rotation.set(-2.1, 0, side * 0.28);
    body.add(tube);
    const vent = new THREE.Mesh(GEO.core, energy);
    vent.scale.setScalar(s * 0.075);
    vent.position.set(side * s * (0.16 + row * 0.06), s * 0.62, s * (0.24 - row * 0.22) * lMul);
    body.add(vent);
  }

  const nodes = Math.round(v.glowNodes ?? 0);
  for (let i = 0; i < nodes; i++) {
    const a = (i / nodes) * Math.PI * 2 + 0.6;
    const sac = new THREE.Mesh(GEO.core, energy);
    sac.scale.setScalar(s * (0.15 + (i % 3) * 0.05));
    sac.position.set(Math.cos(a) * s * 0.4 * wMul, s * (0.18 + (i % 3) * 0.14), Math.sin(a) * s * 0.45 * lMul);
    body.add(sac);
  }

  // ---- the Hunter crest: a raised spine fin and hooked forelimbs, so a hunter is unmistakable
  // from any angle and never reads as "just a bigger grunt".
  if (genome.hunter) {
    const crest = new THREE.Mesh(GEO.spike, energy);
    crest.scale.set(s * 0.09, s * 0.85, s * 0.09);
    crest.position.set(0, s * 0.58, s * 0.08 * lMul);
    crest.rotation.x = -0.45;
    body.add(crest);
    for (let i = 0; i < 4; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const row = Math.floor(i / 2);
      const hook = new THREE.Mesh(GEO.claw, carapace);
      hook.scale.set(s * 0.1, s * (0.85 - row * 0.12), s * 0.1);
      hook.position.set(side * s * (0.34 + row * 0.1), s * (0.3 - row * 0.06), s * (0.5 - row * 0.1) * lMul);
      hook.rotation.set(-1.35 - row * 0.2, 0, side * (0.5 + row * 0.2));
      body.add(hook);
    }
  }

  // boss crown ring
  if (isBoss) {
    const crown = new THREE.Mesh(GEO.crown, energy);
    crown.scale.setScalar(s * 0.8);
    crown.rotation.x = Math.PI / 2;
    crown.position.y = s * 0.42;
    body.add(crown);
  }

  // Collapse the dozens of little parts into a handful of meshes (see mergeStaticChildren).
  // Animated pieces are excluded so the walk cycle, the core pulse and the crown stay alive.
  const skip = new Set<THREE.Object3D>();
  for (const seg of segments) skip.add(seg);
  if (core) skip.add(core);
  if (tail) skip.add(tail);
  mergeStaticChildren(group, skip);

  return {
    group,
    legs,
    segments,
    head,
    body,
    core,
    coreBase,
    tail,
    carapace,
    energy,
    flashMats: [carapace, energy],
    scale: s,
    jelly: v.jelly,
    jellyBase: body.scale.clone(),
  };
}
