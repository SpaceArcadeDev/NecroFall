// NECROFALL — procedural Necrophage creature models.
// Every archetype is assembled from shared low-poly primitives and shaded with two
// hand-written TSL node materials: a veined *carapace* material and an emissive *energy* one.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  Fn,
  If,
  attribute,
  cross,
  dFdx,
  dFdy,
  mix,
  mul,
  normalWorld,
  positionLocal,
  positionWorld,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import type { EnemyGenome } from './EnemyGenomes';
import { FOLIO } from '../world/folio/FolioShaderGlobals';
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
  /** Flat wide blade for wing membranes (a squashed cone reads from both sides). */
  blade: new THREE.ConeGeometry(1, 1, 6),
};

const _m4 = new THREE.Matrix4();

/** The one colour every freeze surface is built from: pale, cold, unmistakably "ice". */
const iceCol = (): any => vec3(0.6, 0.9, 1.0);

/**
 * TSL port of the shared `nfLight` chunk (`world/ShaderGlobals.ts`): sun + hemisphere ambient,
 * slope darkening, rim light and the vibrance pass. It reads the Folio globals, which
 * `Planet.update()` keeps at the same values the GLSL `nfUniforms` still carry.
 */
function nfLight(albedo: any, n: any, radialUp: any, wp: any, rimStrength: number): any {
  const ndl = n.dot(FOLIO.lighting.direction).max(0);
  const hemi = n.dot(radialUp).mul(0.5).add(0.5).clamp(0, 1);
  const ambient = mix(FOLIO.lighting.groundColor, FOLIO.lighting.skyColor, hemi);
  const lit = albedo.mul(ambient.add(FOLIO.lighting.color.mul(ndl)));
  const slope = radialUp.dot(n).clamp(0, 1).oneMinus();
  const shaded = lit.mul(mix(1.0, 0.86, slope));
  const viewDir = (FOLIO.cameraPosition as any).sub(wp).normalize();
  const rim = n.dot(viewDir).clamp(0, 1).oneMinus().pow(3);
  const withRim = shaded.add(FOLIO.lighting.rimColor.mul(rim).mul(rimStrength));
  // Vibrance: push saturation a touch so stylised colours stay vivid under the atmosphere
  // instead of washing toward the fog/sky tints (reference: Folio's saturated readability).
  const lum = withRim.dot(vec3(0.299, 0.587, 0.114));
  return withRim.add(withRim.sub(lum).mul(0.18));
}

/** TSL port of the shared `nfFog` chunk (`world/ShaderGlobals.ts`): exponential-squared distance fog. */
function nfFog(wp: any): any {
  const d = (FOLIO.cameraPosition as any).sub(wp).length();
  return d.mul(FOLIO.fog.density).pow(2).negate().exp().oneMinus().clamp(0, 1);
}

/**
 * The uniform handles other files animate the creature materials through. They are attached to
 * the material objects as named properties (`mat.uFlash.value = ...`): a node material has no
 * `.uniforms` table like the old GLSL ShaderMaterial did.
 */
export interface CarapaceUniforms {
  uShell: { value: THREE.Color };
  uAccent: { value: THREE.Color };
  uAggro: { value: number };
  uMembrane: { value: number };
  uFlash: { value: number };
  uFreeze: { value: number };
  uIcePhase: { value: number };
}

export interface EnergyUniforms {
  uGlow: { value: THREE.Color };
  uPulse: { value: number };
  uFlash: { value: number };
  uFreeze: { value: number };
  uIcePhase: { value: number };
}

/** The TSL twins of the two creature shaders — the full custom pipeline lives in `colorNode`. */
export type CarapaceMaterial = THREE.MeshBasicNodeMaterial & CarapaceUniforms;
export type EnergyMaterial = THREE.MeshBasicNodeMaterial & EnergyUniforms;
/** Every material that carries uFlash — hit feedback whitens the whole body. */
export type CreatureMaterial = CarapaceMaterial | EnergyMaterial;

export interface CreatureLeg {
  root: THREE.Group;
  knee: THREE.Group;
  side: number;
  phase: number;
}

/** One flapping wing (AVIAN / winged floating bodies): the root pivots at the shoulder. */
export interface CreatureWing {
  root: THREE.Group;
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
  carapace: CarapaceMaterial;
  energy: EnergyMaterial;
  /** Every material that carries uFlash — hit feedback whitens the whole body. */
  flashMats: CreatureMaterial[];
  scale: number;
  jelly: number;
  jellyBase: THREE.Vector3;
  /** Wings, flapped every frame (empty for legless/ground rigs without wings). */
  wings: CreatureWing[];
  /** Tentacle strands (MOLLUSK / WRAITH), writhed from the root. */
  tentacles: THREE.Group[];
  /** Orbiting shard crown (WRAITH / CRYSTAL_ARMOR): the whole ring revolves. */
  shardRing: THREE.Group | null;
  /** Stacked neck joints (AVIAN): the head rides the last one. */
  neck: THREE.Group[];
}

function makeCarapace(shellHex: number, accentHex: number, glowStrength: number, membrane: number): CarapaceMaterial {
  const uShell = uniform(new THREE.Color(shellHex));
  const uAccent = uniform(new THREE.Color(accentHex));
  const uAggro = uniform(0);
  const uMembrane = uniform(membrane);
  const uFlash = uniform(0);
  const uFreeze = uniform(0);
  const uIcePhase = uniform(0);

  // The old GLSL vertex stage handed these to the fragment stage as varyings; the node shader
  // declares the same ones (vUp was computed but never read by the fragment — it stays dropped).
  const vW = varying(positionWorld) as any;
  const vN = varying(normalWorld) as any;
  const vLocal = varying(positionLocal) as any;
  const vColor = varying(attribute('color', 'vec3')) as any;

  const mat = new THREE.MeshBasicNodeMaterial();
  // The GLSL material rolled its own `nfFog` and three's scene fog was off for it
  // (`ShaderMaterial.fog` defaults to false) — keep the node twin on the same contract.
  mat.fog = false;

  mat.colorNode = Fn(() => {
    // faceted (flat) normals reconstructed from screen-space derivatives -> crisp low-poly carapace
    const vn = vN.normalize();
    const rawFacet = cross(dFdx(vW) as any, dFdy(vW) as any);
    const facet = rawFacet.normalize();
    const n = rawFacet.dot(rawFacet).greaterThan(0.001).select(facet.mul(facet.dot(vn).sign()), vn);

    const radialUp = vW.normalize();           // planet centre at origin
    const base = uShell.mul(vColor.x.mul(0.45).add(0.78));
    const lit = nfLight(base, n, radialUp, vW, 0.3).toVar();
    // carapace energy veins
    const vein = vW.x.mul(1.7).sin().mul(vW.y.mul(1.35).add(FOLIO.time.mul(0.6)).sin()).mul(vW.z.mul(1.55).sin());
    const v = vein.mul(0.5).add(0.5).smoothstep(0.55, 0.98);
    lit.addAssign(uAccent.mul(v).mul(uAggro.mul(0.8).add(0.3)));
    lit.assign(mix(lit, FOLIO.fog.color, nfFog(vW)));

    const viewDir = (FOLIO.cameraPosition as any).sub(vW).normalize();

    // translucent jelly membranes glow from the inside
    If(uMembrane.greaterThan(0.01), () => {
      const inner = n.dot(viewDir).abs().clamp(0, 1).oneMinus().pow(1.5);
      lit.addAssign(uAccent.mul(inner.mul(0.9).add(0.35)).mul(uMembrane));
    });

    // FROST: the WHOLE carapace crusts over in pale blue. uFreeze says how frozen the body is
    // (0 chilled .. 1 solid); the throb is applied here off FOLIO.time so it pulses on every
    // client, not just the host that runs the simulation, and a fresh ice phase per creature stops
    // a frozen crowd from breathing in unison. Frost crystals ride on the local position so the
    // crust reads as a growth over the shell rather than a flat blue wash.
    const ice = iceCol();
    If(uFreeze.greaterThan(0.001), () => {
      const rim = n.dot(viewDir).abs().clamp(0, 1).oneMinus().pow(1.35);
      const crust = vLocal.x.mul(2.3).sin().mul(vLocal.y.mul(2.9).sin()).mul(vLocal.z.mul(2.1).sin()).smoothstep(-0.1, 0.85);
      const throb = FOLIO.time.mul(3.6).add(uIcePhase).sin().mul(0.22).add(0.78);
      const k = mul(uFreeze, throb, crust.mul(0.2).add(rim.mul(0.24)).add(0.62)).clamp(0, 0.86);
      lit.assign(mix(lit, ice, k).add(ice.mul(rim).mul(uFreeze).mul(throb).mul(0.35)));
    });

    // short white flash on every hit so damage always reads instantly
    lit.assign(mix(lit, vec3(1.0), uFlash.clamp(0, 1)));
    const alpha = uMembrane.greaterThan(0.01).select(mix(1.0, 0.72, uMembrane), 1.0);
    return vec4(lit, alpha);
  })();

  if (membrane > 0.05) {
    mat.transparent = true;
    mat.depthWrite = true;
  }
  // Attach the uniform nodes under their GLSL names — callers animate the material through these
  // handles (`mat.uFlash.value = ...`) exactly like they did with `material.uniforms`.
  const attached = mat as unknown as CarapaceMaterial;
  attached.uShell = uShell;
  attached.uAccent = uAccent;
  attached.uAggro = uAggro;
  attached.uMembrane = uMembrane;
  attached.uFlash = uFlash;
  attached.uFreeze = uFreeze;
  attached.uIcePhase = uIcePhase;
  return attached;
}

function makeEnergy(glowHex: number, pulse: number): EnergyMaterial {
  const uGlow = uniform(new THREE.Color(glowHex));
  const uPulse = uniform(pulse);
  const uFlash = uniform(0);
  const uFreeze = uniform(0);
  const uIcePhase = uniform(0);

  // The old GLSL vertex stage handed these to the fragment stage as varyings; the node shader
  // declares the same ones (the energy fragment never read vLocal — it stays dropped).
  const vW = varying(positionWorld) as any;
  const vN = varying(normalWorld) as any;
  const vX = varying(positionLocal.x.add(positionLocal.y)) as any;

  const mat = new THREE.MeshBasicNodeMaterial();
  // The GLSL energy shader never fogged — keep the node twin unfogged.
  mat.fog = false;

  mat.colorNode = Fn(() => {
    const viewDir = (FOLIO.cameraPosition as any).sub(vW).normalize();
    const fres = vN.normalize().dot(viewDir).clamp(0, 1).oneMinus().pow(1.6);
    const pulseN = FOLIO.time.mul(4.0).mul(uPulse).add(vX.mul(2.0)).sin().mul(0.35).add(0.65);
    const col = uGlow.mul(fres.mul(0.9).add(0.55)).mul(pulseN).toVar();
    // FROST: the glowing bits (eyes, cores, maw) ice over too, or the body reads half-frozen.
    If(uFreeze.greaterThan(0.001), () => {
      const throb = FOLIO.time.mul(3.6).add(uIcePhase).sin().mul(0.22).add(0.78);
      col.assign(mix(col, iceCol().mul(1.25), uFreeze.mul(0.85).mul(throb).clamp(0, 0.92)));
    });
    col.assign(mix(col, vec3(1.0), uFlash.clamp(0, 1)));
    return vec4(col, 1.0);
  })();

  // Attach the uniform nodes under their GLSL names (see makeCarapace).
  const attached = mat as unknown as EnergyMaterial;
  attached.uGlow = uGlow;
  attached.uPulse = uPulse;
  attached.uFlash = uFlash;
  attached.uFreeze = uFreeze;
  attached.uIcePhase = uIcePhase;
  return attached;
}

/**
 * One hip → upper → knee → lower → claw leg, collapsed into a SINGLE merged mesh (legs are the
 * biggest draw-call item on a many-legged body). Shared by the chassis and the avian talons.
 */
function buildLeg(s: number, side: number, thickness: number, length: number, carapace: THREE.Material): { root: THREE.Group; knee: THREE.Group } {
  const root = new THREE.Group();
  const upperLen = length * 0.6;
  const lowerLen = length * 0.6;
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

  // the claw shares the carapace material so it merges with the lower leg: one draw per leg
  const claw = new THREE.Mesh(GEO.claw, carapace);
  claw.scale.setScalar(thickness * 1.1);
  claw.position.y = -lowerLen;
  claw.rotation.x = Math.PI;
  knee.add(claw);

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
  return { root, knee };
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
      // parts the animator drives per-frame (glow sacs, `userData.dynamic`) stay their own meshes
      if (child.userData.dynamic === true) continue;
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
  carapace.uIcePhase.value = icePhase;
  energy.uIcePhase.value = icePhase;

  const group = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = s * 0.62;
  group.add(body);

  const wMul = v.bodyWidth * rand.range(0.94, 1.06);
  const lMul = v.bodyLength * rand.range(0.94, 1.08);
  const hMul = v.bodyHeight * rand.range(0.92, 1.08);

  const segments: THREE.Mesh[] = [];
  const legs: CreatureLeg[] = [];
  const wingsList: CreatureWing[] = [];
  const tentacles: THREE.Group[] = [];
  const neck: THREE.Group[] = [];
  let shardRing: THREE.Group | null = null;
  let head = new THREE.Group();
  let core: THREE.Mesh | null = null;
  let tail: THREE.Group | null = null;
  const coreBase = s * 0.22;

  /**
   * A strand of shrinking links, merged into ONE mesh per strand (the animator rotates the whole
   * root — a travelling wave per link would cost a draw call per link). Used by the mollusk's
   * tentacle skirt and the wraith's hanging tendrils.
   */
  const addTentacles = (count: number, anchorY: number, radius: number, droop: number): void => {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + 0.4;
      const root = new THREE.Group();
      root.position.set(Math.cos(a) * radius * wMul * s, anchorY, Math.sin(a) * radius * lMul * s);
      root.rotation.z = -Math.cos(a) * 0.3;
      root.rotation.x = Math.sin(a) * 0.3;
      const parts: THREE.BufferGeometry[] = [];
      let parentY = 0;
      let len = s * (0.55 + droop);
      for (let k = 0; k < 3; k++) {
        const link = new THREE.Mesh(GEO.leg, carapace);
        const l = len * (1 - k * 0.22);
        link.scale.set(s * (0.075 - k * 0.016), l, s * (0.075 - k * 0.016));
        link.position.y = parentY - l * 0.5;
        link.updateMatrix();
        const g = link.geometry.index ? link.geometry.toNonIndexed() : link.geometry.clone();
        g.applyMatrix4(link.matrix);
        parts.push(g);
        parentY -= l + Math.max(0.01, s * 0.02);
        len *= 0.85;
      }
      const strandGeo = mergeGeometries(parts, false);
      for (const g of parts) g.dispose();
      if (strandGeo) root.add(new THREE.Mesh(strandGeo, carapace));
      body.add(root);
      tentacles.push(root);
    }
  };

  /** Which structural ARCHITECTURE to assemble. Absent on hand-authored genomes → infer from the
   *  original two signals (segment chain, jelly sac) exactly like the old three-way branch did. */
  const rig = v.rig ?? (v.segments > 2 ? 'WORM' : v.jelly > 0.5 ? 'JELLY' : 'CHASSIS');

  if (rig === 'WORM') {
    // ---------------- segmented burrower (worm): a chain of body rings
    // The rings are FLAT children of `body`, each at its own ABSOLUTE offset, and the animator
    // marches them along a cumulative heading (see EnemyAnimator). They used to be NESTED (each
    // ring the child of the previous one), which multiplied every ring's offsets by all of its
    // ancestors' scales — the tail then grew GEOMETRICALLY with the genome and a large segmented
    // creature trailed a multi-kilometre tail (user report 2026-09-29: "super duper long tail").
    // Flat links scale LINEARLY with `s`, like every other body part.
    const count = Math.round(v.segments);
    let chainZ = 0;
    for (let i = 0; i < count; i++) {
      const k = i / (count - 1);
      const ring = new THREE.Mesh(i === 0 ? GEO.shell : GEO.plate, carapace);
      const rw = s * (0.62 - k * 0.34) * wMul;
      const step = s * (0.5 - k * 0.06) * lMul;
      ring.scale.set(rw, rw * 1.0, s * (0.45 - k * 0.14) * lMul);
      chainZ -= i === 0 ? 0 : step;
      ring.position.z = chainZ;
      if (i > 0) {
        // the animator marches chain links: it needs each link's own spacing
        ring.userData.chain = 1;
        ring.userData.step = step;
      }
      body.add(ring);
      segments.push(ring);
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
  } else if (rig === 'JELLY') {
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
  } else if (rig === 'AVIAN') {
    // ---------------- avian (vulture-like): hunched chest, jointed neck, hooked beak, talons
    const chest = new THREE.Mesh(GEO.shell, carapace);
    chest.scale.set(s * 0.62 * wMul, s * 0.72 * hMul, s * 0.92 * lMul);
    chest.rotation.x = -0.16;
    body.add(chest);
    const abdomen = new THREE.Mesh(GEO.shell, carapace);
    abdomen.scale.set(s * 0.5 * wMul, s * 0.5 * hMul, s * 0.72 * lMul);
    abdomen.position.set(0, -s * 0.08, -s * 0.72 * lMul);
    body.add(abdomen);
    segments.push(chest, abdomen);

    // neck: three joints curling up and forward; the head rides the last one
    let neckParent: THREE.Object3D = body;
    for (let i = 0; i < 3; i++) {
      const joint = new THREE.Group();
      const segLen = s * (0.34 - i * 0.06);
      const link = new THREE.Mesh(GEO.leg, carapace);
      link.scale.set(s * (0.15 - i * 0.02), segLen, s * (0.15 - i * 0.02));
      link.position.y = segLen * 0.5;
      joint.add(link);
      if (i === 0) {
        joint.position.set(0, s * 0.5 * hMul, s * 0.52 * lMul);
        joint.rotation.x = -0.72;
      } else {
        joint.position.y = s * (0.34 - (i - 1) * 0.06);
        joint.rotation.x = i === 1 ? 0.66 : 0.5;
      }
      neckParent.add(joint);
      neckParent = joint;
      neck.push(joint);
    }

    head = new THREE.Group();
    head.position.y = s * 0.26;
    const skull = new THREE.Mesh(GEO.head, carapace);
    skull.scale.set(s * 0.3 * wMul, s * 0.3, s * 0.34);
    head.add(skull);
    // hooked beak: upper cone with a down-turned tip + a clutch of barb-teeth
    const beak = new THREE.Mesh(GEO.snout, carapace);
    beak.scale.set(s * 0.13, s * 0.52, s * 0.15);
    beak.rotation.x = Math.PI / 2 + 0.42;
    beak.position.set(0, -s * 0.02, s * 0.42);
    head.add(beak);
    const hook = new THREE.Mesh(GEO.claw, carapace);
    hook.scale.set(s * 0.085, s * 0.24, s * 0.085);
    hook.rotation.x = Math.PI + 0.3;
    hook.position.set(0, -s * 0.2, s * 0.62);
    head.add(hook);
    for (let i = 0; i < Math.max(2, v.mandibles); i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const tooth = new THREE.Mesh(GEO.claw, energy);
      tooth.scale.setScalar(s * 0.1);
      tooth.position.set(side * s * 0.12, -s * 0.12, s * 0.4 + Math.floor(i / 2) * s * 0.08);
      tooth.rotation.set(-1.1, 0, side * 0.35);
      head.add(tooth);
    }
    for (let i = 0; i < Math.max(2, v.eyes); i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const eye = new THREE.Mesh(GEO.eye, energy);
      eye.scale.setScalar(s * 0.075);
      eye.position.set(side * s * (0.2 + Math.floor(i / 2) * 0.07), s * 0.05 + (i % 2) * s * 0.08, s * 0.3);
      head.add(eye);
    }
    neckParent.add(head);

    // talons: the walking legs, tucked under the chest
    for (let i = 0; i < Math.max(1, Math.round(v.legPairs)) * 2; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const row = Math.floor(i / 2);
      const { root, knee } = buildLeg(s, side, s * Math.max(0.09, v.legThickness), s * Math.max(0.85, v.legLength), carapace);
      root.position.set(side * s * 0.34 * wMul, -s * 0.18, s * (0.24 - row * 0.52) * lMul);
      root.rotation.x = -0.22;
      body.add(root);
      legs.push({ root, knee, side, phase: row * 0.85 + (side > 0 ? Math.PI : 0) });
    }
  } else if (rig === 'MYRIAPOD') {
    // ---------------- myriapod (centipede-like): long chain, a leg pair on EVERY segment
    // (FLAT chain links, exactly like the WORM rig above — see the comment there for the
    // geometric tail explosion the old nested version produced.)
    const count = Math.max(4, Math.round(v.segments));
    let chainZ = 0;
    for (let i = 0; i < count; i++) {
      const k = i / (count - 1);
      const ring = new THREE.Mesh(i === 0 ? GEO.shell : GEO.plate, carapace);
      const rw = s * (0.5 - k * 0.27) * wMul;
      const step = s * (0.44 - k * 0.05) * lMul;
      ring.scale.set(rw, rw * (0.95 - k * 0.25), s * (0.42 - k * 0.1) * lMul);
      chainZ -= i === 0 ? 0 : step;
      ring.position.z = chainZ;
      if (i > 0) {
        // the signature: a small leg pair swept off each segment, registered with the gait
        const legLen = Math.max(s * 0.3, s * (0.62 - k * 0.3));
        for (const side of [-1, 1]) {
          const { root, knee } = buildLeg(s, side, s * 0.045, legLen, carapace);
          root.position.set(side * rw * 0.9, -rw * 0.25, 0);
          ring.add(root);
          legs.push({ root, knee, side, phase: i * 1.05 + (side > 0 ? Math.PI : 0) });
        }
        ring.userData.chain = 1;
        ring.userData.step = step;
      }
      body.add(ring);
      segments.push(ring);
    }
    const headGroup = new THREE.Group();
    headGroup.position.set(0, s * 0.08, s * 0.55 * lMul);
    const skull = new THREE.Mesh(GEO.head, carapace);
    skull.scale.set(s * 0.36 * wMul, s * 0.26, s * 0.4);
    headGroup.add(skull);
    const bite = new THREE.Mesh(GEO.core, energy);
    bite.scale.setScalar(s * 0.12);
    bite.position.z = s * 0.3;
    headGroup.add(bite);
    for (let i = 0; i < Math.max(3, v.mandibles); i++) {
      const a = (i / Math.max(3, v.mandibles)) * Math.PI * 2;
      const tooth = new THREE.Mesh(GEO.claw, energy);
      tooth.scale.setScalar(s * 0.12);
      tooth.position.set(Math.cos(a) * s * 0.2, Math.sin(a) * s * 0.14, s * 0.32);
      tooth.rotation.set(Math.PI * 0.5, 0, -a);
      headGroup.add(tooth);
    }
    for (let i = 0; i < Math.max(2, v.eyes); i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const eye = new THREE.Mesh(GEO.eye, energy);
      eye.scale.setScalar(s * 0.06);
      eye.position.set(side * s * 0.2, s * 0.14, s * 0.24);
      headGroup.add(eye);
    }
    // antennae: two long swept quills, the 'this one tastes the air' read
    for (const side of [-1, 1]) {
      const ant = new THREE.Mesh(GEO.spike, energy);
      ant.scale.set(s * 0.035, s * 0.72, s * 0.035);
      ant.position.set(side * s * 0.12, s * 0.16, s * 0.3);
      ant.rotation.set(-1.85, 0, side * 0.45);
      headGroup.add(ant);
    }
    body.add(headGroup);
    head = headGroup;
    if (v.core) {
      core = new THREE.Mesh(GEO.core, energy);
      core.scale.setScalar(coreBase);
      core.position.set(0, s * 0.1, -s * 0.9);
      body.add(core);
    }
  } else if (rig === 'WRAITH') {
    // ---------------- wraith: a hovering core inside a torn shroud, trailed by tendrils
    const coreShell = new THREE.Mesh(GEO.shell, carapace);
    coreShell.scale.set(s * 0.55 * wMul, s * 0.74 * hMul, s * 0.55 * lMul);
    body.add(coreShell);
    segments.push(coreShell);
    const shroud = new THREE.Mesh(GEO.plate, carapace);
    shroud.scale.set(s * 0.88 * wMul, s * 0.58, s * 0.88 * lMul);
    shroud.position.y = -s * 0.42;
    body.add(shroud);
    // ragged hem: spikes pointing down all around the shroud rim
    const hem = Math.max(5, v.spikes);
    for (let i = 0; i < hem; i++) {
      const a = (i / hem) * Math.PI * 2 + 0.2;
      const rag = new THREE.Mesh(GEO.spike, carapace);
      rag.scale.set(s * 0.07, s * (0.3 + (i % 3) * 0.12), s * 0.07);
      rag.position.set(Math.cos(a) * s * 0.62 * wMul, -s * 0.62, Math.sin(a) * s * 0.62 * lMul);
      rag.rotation.x = Math.PI;
      body.add(rag);
    }
    core = new THREE.Mesh(GEO.core, energy);
    core.scale.setScalar(coreBase * 1.4);
    body.add(core);
    // tendrils hanging from the shroud (the whole strand writhes from its root)
    addTentacles(Math.max(3, Math.round(v.tentacles ?? 3)), -s * 0.5, 0.5, 0.35);
    head = new THREE.Group();
    head.position.set(0, s * 0.44, s * 0.16 * lMul);
    const mask = new THREE.Mesh(GEO.head, carapace);
    mask.scale.set(s * 0.24 * wMul, s * 0.32, s * 0.2);
    head.add(mask);
    const thirdEye = new THREE.Mesh(GEO.core, energy);
    thirdEye.scale.setScalar(s * 0.1);
    thirdEye.position.set(0, s * 0.05, s * 0.18);
    head.add(thirdEye);
    for (let i = 0; i < Math.max(2, v.eyes); i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const eye = new THREE.Mesh(GEO.eye, energy);
      eye.scale.setScalar(s * 0.055);
      eye.position.set(side * s * 0.14, s * 0.08, s * 0.16);
      head.add(eye);
    }
    body.add(head);
  } else if (rig === 'MOLLUSK') {
    // ---------------- mollusk: a bulbed shell on a skirt of writhing tentacles
    const bell = new THREE.Mesh(GEO.shell, carapace);
    bell.scale.set(s * 0.8 * wMul, s * 0.76 * hMul, s * 0.85 * lMul);
    body.add(bell);
    segments.push(bell);
    const hood = new THREE.Mesh(GEO.plate, carapace);
    hood.scale.set(s * 0.58 * wMul, s * 0.5, s * 0.58 * lMul);
    hood.position.y = s * 0.38 * hMul;
    hood.rotation.x = 0.18;
    body.add(hood);
    core = new THREE.Mesh(GEO.core, energy);
    core.scale.setScalar(coreBase);
    core.position.set(0, -s * 0.08, 0);
    body.add(core);
    // eye stalks poking out under the hood
    for (const side of [-1, 1]) {
      const stalk = new THREE.Mesh(GEO.leg, carapace);
      stalk.scale.set(s * 0.05, s * 0.5, s * 0.05);
      stalk.position.set(side * s * 0.3 * wMul, s * 0.34, s * 0.42 * lMul);
      stalk.rotation.set(-0.5, 0, side * 0.25);
      body.add(stalk);
      const eye = new THREE.Mesh(GEO.eye, energy);
      eye.scale.setScalar(s * 0.08);
      eye.position.set(side * s * 0.42 * wMul, s * 0.56, s * 0.52 * lMul);
      body.add(eye);
    }
    head = new THREE.Group();
    head.position.set(0, -s * 0.02, s * 0.4 * lMul);
    for (let i = 0; i < Math.max(3, v.mandibles); i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const hook = new THREE.Mesh(GEO.claw, energy);
      hook.scale.setScalar(s * 0.12);
      hook.position.set(side * s * (0.08 + Math.floor(i / 2) * 0.1), -s * 0.16, s * 0.12);
      hook.rotation.set(-0.8, 0, side * 0.4);
      head.add(hook);
    }
    body.add(head);
    // tentacle skirt: the locomotion AND the mouth — strands hang all around the bell
    addTentacles(Math.max(4, Math.round(v.tentacles ?? 6)), -s * 0.22, 0.6, 0.05);
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

    // legs: hip -> (upper) -> knee -> (lower + claw), one merged mesh per leg (see buildLeg)
    for (let i = 0; i < v.legPairs * 2; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const row = Math.floor(i / 2);
      const z = (row - (v.legPairs - 1) / 2) * s * 0.62 * lMul;
      const { root, knee } = buildLeg(s, side, s * v.legThickness, s * v.legLength, carapace);
      root.position.set(side * s * 0.42 * wMul, -s * 0.08, z);
      body.add(root);
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

  // ---- locomotion organs (plan §18/§19): fins and membrane wings say "this one drifts", rear
  // sacs say "this one compresses and springs", hooked forelimbs say "this one grapples".
  const fins = Math.round(v.fins ?? 0);
  for (let i = 0; i < fins; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const fin = new THREE.Mesh(GEO.snout, carapace);
    fin.scale.set(s * 0.09, s * (0.5 - row * 0.1), s * 0.05);
    fin.rotation.set(0, 0, side * (1.15 + row * 0.15));
    fin.position.set(side * s * (0.5 + row * 0.08) * wMul, s * 0.34, s * (0.15 - row * 0.25) * lMul);
    body.add(fin);
  }
  const wings = Math.round(v.wings ?? 0);
  for (let i = 0; i < wings; i++) {
    // One ANIMATED wing per blade: the shoulder root is what the animator flaps, and the wing
    // itself is a fan of membrane blades with a glowing tip. This is the whole silhouette of an
    // AVIAN (vulture-like) body and the float gear of a winged drifter.
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const root = new THREE.Group();
    root.position.set(side * s * (0.4 + row * 0.06) * wMul, s * (0.52 - row * 0.16) * hMul, s * (0.16 - row * 0.44) * lMul);
    for (let b = 0; b < 3; b++) {
      const blade = new THREE.Mesh(GEO.blade, carapace);
      const len = s * (1.4 - b * 0.32);
      blade.scale.set(len * 0.3, len, s * 0.05);
      blade.rotation.z = -side * (Math.PI / 2 + 0.28 - b * 0.14);
      blade.rotation.y = side * (0.2 - b * 0.14);
      blade.position.set(side * len * 0.42, 0, -s * (0.06 + b * 0.3));
      root.add(blade);
    }
    const tip = new THREE.Mesh(GEO.core, energy);
    tip.scale.setScalar(s * 0.08);
    tip.position.set(side * s * 0.82, 0, -s * 0.5);
    root.add(tip);
    body.add(root);
    wingsList.push({ root, side, phase: row * 1.7 + (side > 0 ? 0.9 : 0) });
  }
  // ---- PLUMES: a fan of long quills off the rear — the avian tail / display crest
  const plumes = Math.round(v.plumes ?? 0);
  for (let i = 0; i < plumes; i++) {
    const a = plumes > 1 ? (i / (plumes - 1) - 0.5) * 0.95 : 0;
    const plume = new THREE.Mesh(GEO.spike, i % 3 === 0 ? energy : carapace);
    const len = s * (0.9 - Math.abs(a) * 0.35);
    plume.scale.set(s * 0.05, len, s * 0.05);
    plume.position.set(Math.sin(a) * s * 0.3 * wMul, s * 0.32, -s * (0.9 + Math.abs(a) * 0.3) * lMul);
    plume.rotation.set(-2.15, a, 0);
    body.add(plume);
  }
  // ---- SHARDS: a revolving crown of crystal — the wraith's orbit, and CRYSTAL_ARMOR's plates.
  // The whole RING turns (one rotation per frame), so the shards stay inside the static merge.
  const shards = Math.round(v.shards ?? 0);
  if (shards > 0) {
    shardRing = new THREE.Group();
    for (let i = 0; i < shards; i++) {
      const a = (i / shards) * Math.PI * 2 + 0.3;
      const shard = new THREE.Mesh(GEO.snout, i % 2 === 0 ? energy : carapace);
      const len = s * (0.45 + (i % 3) * 0.13);
      shard.scale.set(s * 0.09, len, s * 0.09);
      shard.position.set(Math.cos(a) * s * 0.74 * wMul, s * (0.08 + (i % 2) * 0.18), Math.sin(a) * s * 0.74 * lMul);
      shard.rotation.z = -Math.cos(a) * 0.9;
      shard.rotation.x = Math.sin(a) * 0.9;
      shardRing.add(shard);
    }
    body.add(shardRing);
  }
  const sacs = Math.round(v.sacs ?? 0);
  for (let i = 0; i < sacs; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const sac = new THREE.Mesh(GEO.core, energy);
    sac.scale.set(s * 0.16, s * 0.22, s * 0.16);
    sac.position.set(side * s * (0.3 + row * 0.06) * wMul, s * (0.42 - row * 0.06), s * (-0.55 - row * 0.18) * lMul);
    sac.userData.dynamic = true; // kept out of the static merge so the animator can pulse it
    sac.userData.sacPulse = 1;
    sac.userData.baseScale = sac.scale.clone();
    body.add(sac);
  }
  const claws = Math.round(v.claws ?? 0);
  for (let i = 0; i < claws; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const claw = new THREE.Mesh(GEO.claw, carapace);
    claw.scale.set(s * 0.08, s * (0.5 - row * 0.08), s * 0.08);
    claw.position.set(side * s * (0.4 + row * 0.08) * wMul, s * (0.3 - row * 0.05), s * (0.62 - row * 0.08) * lMul);
    claw.rotation.set(-1.1 - row * 0.15, 0, side * 0.35);
    body.add(claw);
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
    wings: wingsList,
    tentacles,
    shardRing,
    neck,
  };
}
