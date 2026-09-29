// NECROFALL — TREE SYSTEM (rework plan §10/§11/§26/§56/§57/§59/§72).
//
// Five deterministic archetypes — DEAD, BURNT, MUTATED, ALIEN, INFECTED — each a hand-authored
// low-poly silhouette readable from the isometric gameplay camera (plan §10). One shared geometry
// per archetype + per-instance height/width/lean/yaw/tint gives thousands of visual combinations
// without thousands of models (plan §11).
//
// Trees are the game's first DESTRUCTIBLE environment objects (plan §26):
//   intact → damaged (darker, leaning) → destroyed (collapsed, a fallen trunk + debris burst).
// State changes go to the shared `DestructionLedger` under a deterministic object id, so the host
// can sync them as `{id, state}` without ever networking transforms (plan §73).
//
// Placement is a per-cell deterministic census: candidate slots are enumerated in a fixed order,
// each candidate carries a STABLE identity (its index), and the habitat/cluster fields decide
// whether it becomes a tree and which archetype it is. Two clients with different quality
// profiles still agree about every tree they both show (plan §20).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, tangentBasis } from '../../utils/Utils';
import { geometryHeight } from '../Vegetation';
import { InstancedEnvironmentGroup } from '../instancing/InstancedEnvironmentGroup';
import { createEnvironmentMaterial } from '../rendering/EnvironmentMaterials';
import { cellRand, fbm3, environmentObjectId } from '../EnvironmentSeed';
import { createHabitat, type HabitatSample } from '../terrain/TerrainSurfaceQuery';
import { STATE_DAMAGED, STATE_DESTROYED, STATE_INTACT, type DestructionState } from '../interaction/DestructionLedger';
import type { EnvironmentContext, EnvironmentSystem } from '../EnvironmentContext';

/** Kind tag used in deterministic object ids (`environmentObjectId(cell, kind, slot)`). */
export const ENV_KIND_TREE = 2;

export const TREE_ARCHETYPES = ['DEAD', 'BURNT', 'MUTATED', 'ALIEN', 'INFECTED'] as const;
export type TreeArchetype = (typeof TREE_ARCHETYPES)[number];

const SALT_TREES = 0x7e01;

const _upY = new THREE.Vector3(0, 1, 0);
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _qAlign = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _scale = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _color = new THREE.Color();

// ---------------------------------------------------------------- geometry builders

/** Adds one tapered limb between two points to a parts list. */
function limb(
  parts: THREE.BufferGeometry[],
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  r0: number, r1: number, seg = 5
): void {
  const dir = new THREE.Vector3(bx - ax, by - ay, bz - az);
  const len = dir.length();
  if (len < 0.01) return;
  dir.normalize();
  // Non-indexed: `mergeGeometries` refuses to mix indexed and non-indexed parts, and the canopy
  // blobs (Icosahedron/Sphere) are non-indexed polyhedra.
  const geo = new THREE.CylinderGeometry(r1, r0, len, seg, 1, true).toNonIndexed();
  const q = new THREE.Quaternion().setFromUnitVectors(_upY, dir);
  geo.applyQuaternion(q);
  geo.translate(ax + dir.x * len * 0.5, ay + dir.y * len * 0.5, az + dir.z * len * 0.5);
  parts.push(geo);
}

function blob(parts: THREE.BufferGeometry[], x: number, y: number, z: number, r: number, squash = 0.75, detail = 0): void {
  const geo = new THREE.IcosahedronGeometry(r, detail);
  geo.scale(1, squash, 1);
  geo.translate(x, y, z);
  parts.push(geo);
}

/**
 * Builds one archetype's geometry. `detail` false = the cheap LOD1 silhouette (trunk + one crown
 * blob), which keeps the same footprint so the LOD switch never pops.
 */
export function buildTreeGeometry(kind: number, detail: boolean, variant = 0): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const v = variant === 0 ? 0 : variant;
  switch (kind) {
    case 0: { // DEAD — bare, broken, slightly twisted
      const h = 2.9 + v * 0.35;
      limb(parts, 0, 0, 0, 0.12, h * 0.55, 0.1, 0.2, 0.11);
      limb(parts, 0.12, h * 0.55, 0.1, 0.05, h, -0.05, 0.11, 0.05);
      if (detail) {
        limb(parts, 0.1, h * 0.62, 0.08, 0.9, h * 0.95, 0.4, 0.06, 0.02);
        limb(parts, 0.08, h * 0.7, 0.05, -0.7, h * 0.9, -0.5, 0.05, 0.02);
        limb(parts, 0.1, h * 0.5, 0.06, -0.5, h * 0.72, 0.7, 0.05, 0.02);
        limb(parts, 0.06, h * 0.8, -0.02, 0.4, h * 1.06, -0.6, 0.04, 0.015);
      } else {
        limb(parts, 0.1, h * 0.62, 0.08, 0.8, h * 0.92, 0.35, 0.05, 0.02, 4);
      }
      break;
    }
    case 1: { // BURNT — charred stump with thick broken arms
      const h = 2.1 + v * 0.3;
      limb(parts, 0, 0, 0, 0.06, h * 0.5, 0.04, 0.26, 0.16);
      limb(parts, 0.06, h * 0.5, 0.04, 0, h, 0, 0.15, 0.05);
      if (detail) {
        limb(parts, 0.05, h * 0.45, 0.03, 0.75, h * 0.66, 0.2, 0.09, 0.03);
        limb(parts, 0.02, h * 0.55, 0.03, -0.65, h * 0.85, -0.35, 0.08, 0.02);
        blob(parts, 0.1, h * 1.0, 0.05, 0.34, 0.4);
        blob(parts, -0.25, h * 0.9, -0.15, 0.26, 0.4);
      } else {
        blob(parts, 0.05, h * 0.98, 0.03, 0.42, 0.45);
      }
      break;
    }
    case 2: { // MUTATED — bulbous growths, upcurved limbs
      const h = 3.1 + v * 0.4;
      limb(parts, 0, 0, 0, 0.05, h * 0.6, 0.06, 0.22, 0.13);
      limb(parts, 0.05, h * 0.6, 0.06, 0, h * 0.92, 0, 0.12, 0.07);
      if (detail) {
        limb(parts, 0.06, h * 0.6, 0.05, 0.85, h * 0.98, 0.3, 0.08, 0.04);
        limb(parts, 0.03, h * 0.7, 0.04, -0.8, h * 1.02, -0.4, 0.08, 0.04);
        blob(parts, 0.15, h * 1.05, 0.1, 0.55, 0.85);
        blob(parts, -0.45, h * 0.95, -0.2, 0.42, 0.8);
        blob(parts, 0.5, h * 0.85, 0.35, 0.35, 0.75);
      } else {
        blob(parts, 0.05, h * 0.98, 0.03, 0.72, 0.8);
      }
      break;
    }
    case 3: { // ALIEN — tall spire with a floating-ish crown
      const h = 3.8 + v * 0.5;
      limb(parts, 0, 0, 0, 0.03, h * 0.66, 0.04, 0.16, 0.08);
      if (detail) {
        // ConeGeometry is INDEXED in three while limbs/blobs are not — convert to keep the merge legal.
        const spire = new THREE.ConeGeometry(0.34, h * 0.5, 6).toNonIndexed();
        spire.translate(0.03, h * 0.62 + h * 0.25, 0.04);
        parts.push(spire);
        limb(parts, 0.04, h * 0.6, 0.03, 0.7, h * 0.78, 0.5, 0.05, 0.02);
        limb(parts, 0.02, h * 0.55, 0.02, -0.6, h * 0.72, -0.45, 0.05, 0.02);
        blob(parts, 0.7, h * 0.8, 0.5, 0.22, 0.9);
        blob(parts, -0.6, h * 0.74, -0.45, 0.2, 0.9);
      } else {
        const spire = new THREE.ConeGeometry(0.4, h * 0.55, 5).toNonIndexed();
        spire.translate(0.03, h * 0.62 + h * 0.27, 0.04);
        parts.push(spire);
      }
      break;
    }
    default: { // INFECTED — drooping membranes + thin tendrils
      const h = 2.7 + v * 0.35;
      limb(parts, 0, 0, 0, 0.04, h * 0.55, 0.05, 0.2, 0.1);
      limb(parts, 0.04, h * 0.55, 0.05, 0, h * 0.95, 0.02, 0.1, 0.05);
      if (detail) {
        limb(parts, 0.04, h * 0.5, 0.04, 0.7, h * 0.78, 0.3, 0.07, 0.025);
        limb(parts, 0.03, h * 0.6, 0.04, -0.75, h * 0.82, -0.25, 0.07, 0.025);
        limb(parts, 0.02, h * 0.45, 0.03, 0.3, h * 0.6, -0.65, 0.06, 0.02);
        blob(parts, 0.3, h * 0.82, 0.12, 0.5, 0.5);
        blob(parts, -0.4, h * 0.84, -0.1, 0.44, 0.5);
        // hanging tendrils
        limb(parts, 0.42, h * 0.72, 0.18, 0.45, h * 0.45, 0.2, 0.03, 0.01, 4);
        limb(parts, -0.5, h * 0.74, -0.15, -0.52, h * 0.42, -0.2, 0.03, 0.01, 4);
      } else {
        blob(parts, 0.05, h * 0.85, 0.03, 0.62, 0.5);
      }
      break;
    }
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.computeVertexNormals();
  return merged;
}

/** A simple fallen trunk used when a tree is destroyed (plan §26). */
export function buildFallenTrunkGeometry(): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(0.09, 0.18, 3.4, 5);
  geo.rotateZ(Math.PI / 2);
  geo.translate(1.7, 0.16, 0);
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------- records

export interface TreeRecord {
  id: number;
  candidate: number;
  archetype: number;
  /** Instance slot inside the archetype's group. */
  slot: number;
  state: DestructionState;
  hp: number;
  /** Surface direction (identity for rebuilds). */
  dirX: number;
  dirY: number;
  dirZ: number;
  posX: number;
  posY: number;
  posZ: number;
  upX: number;
  upY: number;
  upZ: number;
  yaw: number;
  scaleH: number;
  scaleW: number;
  tint: number;
}

interface CellTrees {
  records: TreeRecord[];
  /** Per-archetype instance blocks owned by this cell (freed as one range on unload). */
  allocs: { kind: number; start: number; count: number }[];
}

export class TreeSystem implements EnvironmentSystem {
  readonly name = 'trees';

  private readonly groups: InstancedEnvironmentGroup[] = [];
  private readonly cells = new Map<number, CellTrees>();
  private readonly habitat: HabitatSample = createHabitat();
  /** Scratch arrays for the two-phase cell build (enumerate → allocate). */
  private readonly scratch: TreeRecord[] = [];
  private readonly fallen: InstancedEnvironmentGroup;
  private visible = true;
  private instanceTotal = 0;
  private fallenCount = 0;

  constructor(private readonly ctx: EnvironmentContext) {
    const cellArea = ctx.cells.cellSize * ctx.cells.cellSize * 1.15;
    const densityPerCell = cellArea * 0.055 * ctx.profile.trees;
    const activeCells = Math.ceil((Math.PI * ctx.profile.activationRadius * ctx.profile.activationRadius) / cellArea);
    const totalCapacity = Math.max(96, Math.round(densityPerCell * activeCells * 1.6));
    // Archetype capacity split follows the planet's tree-set weights (never a flat fifth each).
    const weights = ctx.biome.treeSet;
    const sum = weights.reduce((a, b) => a + b, 0) || 1;

    for (let kind = 0; kind < 5; kind++) {
      const capacity = Math.max(32, Math.round((totalCapacity * weights[kind]) / sum));
      const detailMat = createEnvironmentMaterial(ctx.wind, {
        wind: 'canopy', dither: true, noise: 0.4, fresnel: kind === 4 ? 0.3 : 0.08,
        lodBand: 'keep-near', lodSoft: 6,
      });
      if (kind === 4) (detailMat.uniforms.uEmissive.value as number) = 0.22;
      detailMat.uniforms.uTagColor.value = new THREE.Color(ctx.biome.grassTip);
      const farMat = createEnvironmentMaterial(ctx.wind, {
        wind: 'canopy', dither: true, noise: 0.3, fresnel: 0.05, lodBand: 'keep-far', lodSoft: 6,
      });
      const group = new InstancedEnvironmentGroup(
        `env-tree-${TREE_ARCHETYPES[kind]}`,
        ctx.assets.ensure(`geo:tree-${kind}-d`, () => buildTreeGeometry(kind, true)),
        detailMat,
        capacity,
        {
          geometry: ctx.assets.ensure(`geo:tree-${kind}-f`, () => buildTreeGeometry(kind, false)),
          material: farMat,
        }
      );
      this.groups.push(group);
      ctx.root.add(group.mesh, group.farMesh!);
    }

    // Fallen trunks from destroyed trees (plan §26): a tiny pool, never a full tree simulation.
    const fallenMat = createEnvironmentMaterial(ctx.wind, { noise: 0.5, fresnel: 0.05, dither: true });
    this.fallen = new InstancedEnvironmentGroup(
      'env-fallen-trunks',
      ctx.assets.ensure('geo:fallen-trunk', () => buildFallenTrunkGeometry()),
      fallenMat,
      96
    );
    ctx.root.add(this.fallen.mesh);
  }

  /** Builds one cell's trees deterministically (plan §72). */
  activateCell(cell: number): boolean {
    if (this.cells.has(cell)) return true;
    const rng = cellRand(this.ctx.seed, cell, SALT_TREES, this.ctx.version);
    const scale = clamp(this.ctx.qualityScale(), 0.1, 1);
    const area = this.ctx.cells.cellSize * this.ctx.cells.cellSize * 1.15;
    const candidates = Math.max(4, Math.round(area * 0.06 * this.ctx.profile.trees * scale * 1.4));
    const half = this.ctx.cells.cellSize * 0.62;
    const R = this.ctx.radius;
    const level = this.ctx.provider.waterLevel;

    this.ctx.cells.centerOf(cell, _dir);
    tangentBasis(_dir, _t1, _t2);
    this.scratch.length = 0;
    const perKind: number[] = [0, 0, 0, 0, 0];

    for (let c = 0; c < candidates; c++) {
      const ox = rng.range(-half, half);
      const oy = rng.range(-half, half);
      // Rebuild the direction every time: base centre (from the precomputed grid) + tangent offset.
      _dir.set(this.ctx.cells.centerX(cell), this.ctx.cells.centerY(cell), this.ctx.cells.centerZ(cell))
        .multiplyScalar(R)
        .addScaledVector(_t1, ox)
        .addScaledVector(_t2, oy)
        .normalize();

      const h = this.ctx.provider.getHeight(_dir.x, _dir.y, _dir.z);
      const slope = this.ctx.provider.getSlope(_dir.x, _dir.y, _dir.z);
      if (slope > 0.98) continue;
      if (level > 0 && h < level + 0.25) continue;
      if (!this.ctx.masks.isClear(_dir)) continue;

      const habitat = this.ctx.query.habitatAt(_dir, this.habitat);
      if (habitat.tree < 0.05) continue;
      // Forest clumping: a low-frequency field so trees form woods and clearings (plan §37).
      const cluster = fbm3(_dir.x * 2.6 + 5.1, _dir.y * 2.6 + 2.2, _dir.z * 2.6 + 8.3, 2, (this.ctx.seed ^ 0x7ee5) >>> 0);
      const accept = clamp(habitat.tree * this.ctx.biome.foliageDensity, 0, 1) * clamp(cluster * 1.9, 0, 1);
      if (rng.next() > accept) continue;

      // Archetype selection from the biome set, pushed by contamination/corruption (plan §13).
      const weights = [...this.ctx.biome.treeSet];
      const corr = habitat.contamination;
      if (corr > 0.55) {
        weights[4] += (corr - 0.55) * 0.9;   // infected
        weights[2] += (corr - 0.55) * 0.4;   // mutated
        weights[3] += (corr - 0.55) * 0.3;   // alien
      }
      if (habitat.temperature < 0.3) { weights[0] += 0.25; weights[1] += 0.1; }
      const wsum = weights.reduce((a, b) => a + b, 0) || 1;
      let roll = rng.next() * wsum;
      let archetype = 0;
      for (let k = 0; k < 5; k++) {
        roll -= weights[k];
        if (roll <= 0) { archetype = k; break; }
      }

      const id = environmentObjectId(cell, ENV_KIND_TREE, c);
      const ledgerState = this.ctx.ledger.get(id);
      if (ledgerState === STATE_DESTROYED) continue;      // stays destroyed across rebuilds

      this.ctx.provider.getNormal(_dir.x, _dir.y, _dir.z, _normal);
      const scaleH = rng.range(0.75, 1.35);
      const scaleW = rng.range(0.85, 1.15);
      const rec: TreeRecord = {
        id,
        candidate: c,
        archetype,
        slot: -1,
        state: ledgerState === STATE_DAMAGED ? STATE_DAMAGED : STATE_INTACT,
        hp: 100,
        dirX: _dir.x, dirY: _dir.y, dirZ: _dir.z,
        posX: _dir.x * h, posY: _dir.y * h, posZ: _dir.z * h,
        upX: _normal.x, upY: _normal.y, upZ: _normal.z,
        yaw: rng.range(0, Math.PI * 2),
        scaleH,
        scaleW,
        tint: rng.range(0.85, 1.1),
      };
      this.scratch.push(rec);
      perKind[archetype]++;
    }

    // Phase 2 — allocate contiguous blocks per archetype; abort the whole cell if any group is
    // out of budget, so partial cells never exist (content is identical on every rebuild).
    const allocs: ({ start: number; count: number } | null)[] = [];
    for (let k = 0; k < 5; k++) {
      allocs.push(perKind[k] > 0 ? this.groups[k].alloc(perKind[k]) : null);
      if (perKind[k] > 0 && !allocs[k]) {
        for (let j = 0; j < k; j++) {
          const a = allocs[j];
          if (a) this.groups[j].free(a.start, a.count);
        }
        return false;
      }
    }

    const cursor = [0, 1, 2, 3, 4].map(k => (allocs[k] ? allocs[k]!.start : 0));
    const records: TreeRecord[] = [];
    const cellAllocs: { kind: number; start: number; count: number }[] = [];
    for (let k = 0; k < 5; k++) {
      const a = allocs[k];
      if (a) cellAllocs.push({ kind: k, start: a.start, count: a.count });
    }
    for (const rec of this.scratch) {
      const g = this.groups[rec.archetype];
      const slot = cursor[rec.archetype]++;
      rec.slot = slot;
      this.writeTree(g, rec, true);
      records.push(rec);
    }

    for (let k = 0; k < 5; k++) this.groups[k].commit();
    this.cells.set(cell, { records, allocs: cellAllocs });
    this.instanceTotal += records.length;
    return true;
  }

  /** Writes (or rewrites) one tree instance from its record. */
  private writeTree(group: InstancedEnvironmentGroup, rec: TreeRecord, initial: boolean): void {
    const damaged = rec.state === STATE_DAMAGED;
    _pos.set(rec.posX, rec.posY, rec.posZ);
    _normal.set(rec.upX, rec.upY, rec.upZ);
    _qAlign.setFromUnitVectors(_upY, _normal);
    _e.set(damaged ? 0.22 : 0, rec.yaw, 0, 'YXZ');
    _qYaw.setFromEuler(_e);
    _q.copy(_qAlign).multiply(_qYaw);
    const h = rec.scaleH * (damaged ? 0.94 : 1);
    _scale.set(rec.scaleW, h, rec.scaleW);
    _m.compose(_pos, _q, _scale);
    const base = this.ctx.biome;
    const treeColors = [0x6a5a4a, 0x2f2622, 0x6a3f7a, 0x4a7a8a, 0x7a2a4a];
    _color.setHex(treeColors[rec.archetype]).offsetHSL(0, 0, (rec.tint - 1) * 0.35);
    if (rec.archetype === 4) _color.lerp(new THREE.Color(0x8a1f3c), this.ctx.biome.contamination * 0.35);
    if (damaged) _color.multiplyScalar(0.72);
    if (initial) {
      group.set(rec.slot, {
        matrix: _m,
        color: _color,
        tint: rec.tint * base.foliageDensity * 0.9 + 0.1,
        phase: hash01FromId(rec.id),
        height: geometryHeight(this.groups[rec.archetype].mesh.geometry) * h,
        rand: hash01FromId(rec.id ^ 0x9e37),
        lod: 0.9 + hash01FromId(rec.id ^ 0x51ed) * 0.25,
        state: 1,
      });
    } else {
      group.setMatrix(rec.slot, _m);
      group.setColor(rec.slot, _color);
      group.setTint(rec.slot, rec.tint * base.foliageDensity * 0.9 + 0.1);
    }
  }

  deactivateCell(cell: number): void {
    const entry = this.cells.get(cell);
    if (!entry) return;
    // Collapse every slot this cell owned and return the FULL blocks to the free lists; destroyed
    // slots are freed with their block (their instances are collapsed already). The ledger keeps
    // destroyed/damaged states so a rebuild restores exactly what the world remembers (§59/§60).
    let alive = 0;
    for (const rec of entry.records) if (rec.state !== STATE_DESTROYED) alive++;
    for (const block of entry.allocs) {
      const g = this.groups[block.kind];
      for (let i = block.start; i < block.start + block.count; i++) g.setState(i, 0);
      g.commitStates();
      g.free(block.start, block.count);
    }
    this.instanceTotal = Math.max(0, this.instanceTotal - alive);
    this.cells.delete(cell);
  }

  /**
   * Applies damage around a point (explosions — plan §24/§57). Returns the changed records so the
   * caller can emit FX and (as host) push ledger updates. Visual simulation only: no rigid bodies.
   */
  damageAt(pos: THREE.Vector3, radius: number, amount: number): TreeRecord[] {
    const changed: TreeRecord[] = [];
    this.cells.forEach((entry) => {
      for (const rec of entry.records) {
        if (rec.state === STATE_DESTROYED) continue;
        const dx = rec.posX - pos.x, dy = rec.posY - pos.y, dz = rec.posZ - pos.z;
        const dist2 = dx * dx + dy * dy + dz * dz;
        if (dist2 > radius * radius) continue;
        rec.hp -= amount;
        const next: DestructionState = rec.hp <= 40 ? STATE_DESTROYED : rec.hp <= 75 ? STATE_DAMAGED : rec.state;
        if (next !== rec.state) {
          this.applyState(rec, next);
          changed.push(rec);
        }
      }
    });
    return changed;
  }

  /** Sets a record's state and restyles its instance (used by damage + network application). */
  applyState(rec: TreeRecord, state: DestructionState): void {
    if (rec.state === state) return;
    rec.state = state;
    const group = this.groups[rec.archetype];
    if (state === STATE_DESTROYED) {
      group.setState(rec.slot, 0);
      group.commitStates();
      rec.hp = Math.min(rec.hp, 0);
      // Fallen trunk + debris burst (host and clients alike run this from the ledger change).
      this.spawnFallen(rec);
      this.ctx.fx?.burst(new THREE.Vector3(rec.posX, rec.posY, rec.posZ), 0x9a6b4a, { count: 14, size: 0.4, speed: 3.4 });
      if (this.ctx.fx) {
        this.ctx.fx.dust(
          new THREE.Vector3(rec.posX, rec.posY, rec.posZ),
          new THREE.Vector3(rec.upX, rec.upY, rec.upZ),
          0x8a7a5a,
          8
        );
      }
      this.instanceTotal = Math.max(0, this.instanceTotal - 1);
    } else {
      rec.hp = Math.min(rec.hp, state === STATE_DAMAGED ? 74 : rec.hp);
      this.writeTree(group, rec, false);
      group.commitTransforms();
      group.commitTints();
    }
  }

  private spawnFallen(rec: TreeRecord): void {
    const a = this.fallen.alloc(1);
    if (!a) return;
    _normal.set(rec.upX, rec.upY, rec.upZ);
    _qAlign.setFromUnitVectors(_upY, _normal);
    _e.set(0, rec.yaw + rec.candidate * 0.7, 0, 'YXZ');
    _qYaw.setFromEuler(_e);
    _q.copy(_qAlign).multiply(_qYaw);
    _pos.set(rec.posX, rec.posY, rec.posZ).addScaledVector(_normal, 0.05);
    // The fallen trunk geometry lies along +X; scale length by height and thickness by width.
    _scale.set(rec.scaleH * rec.scaleW, rec.scaleW, rec.scaleW);
    _m.compose(_pos, _q, _scale);
    _color.setHex(0x5a4a42).multiplyScalar(rec.tint * 0.9);
    this.fallen.set(a.start, {
      matrix: _m, color: _color, tint: rec.tint, phase: hash01FromId(rec.id ^ 0x77),
      height: 0.35, rand: hash01FromId(rec.id ^ 0x88), lod: 1,
    });
    this.fallen.commit();
    this.fallenCount++;
  }

  /** Rebuilds a record's instance after a network state change (client side — plan §26). */
  applyNetworkState(id: number, state: DestructionState): void {
    this.cells.forEach((entry) => {
      for (const rec of entry.records) {
        if (rec.id === id) {
          if (rec.state !== state) this.applyState(rec, state);
          return;
        }
      }
    });
  }

  /** Iterates every loaded tree (occlusion, interaction, debug) without allocating. */
  forEachLoaded(cb: (rec: { id: number; archetype: number; x: number; y: number; z: number; scaleH: number; state: DestructionState }) => void): void {
    this.cells.forEach((entry) => {
      for (const rec of entry.records) {
        if (rec.state === STATE_DESTROYED) continue;
        cb({ id: rec.id, archetype: rec.archetype, x: rec.posX, y: rec.posY, z: rec.posZ, scaleH: rec.scaleH, state: rec.state });
      }
    });
  }

  // ------------------------------------------------------------ occluders (plan §27/§54)

  /** Supplies fadeable occluders to the look-through system. */
  forEachOccluder(cb: (id: number, x: number, y: number, z: number, radius: number, group: InstancedEnvironmentGroup, slot: number) => void): void {
    this.cells.forEach((entry) => {
      for (const rec of entry.records) {
        if (rec.state === STATE_DESTROYED) continue;
        // Canopy radius: trees are the classic camera blockers, so err generous.
        cb(rec.id, rec.posX, rec.posY, rec.posZ, 0.85 * rec.scaleH, this.groups[rec.archetype], rec.slot);
      }
    });
  }

  /** Applies a dither-fade value to one tree instance (look-through system only). */
  setOcclusion(id: number, fade: number): void {
    this.cells.forEach((entry) => {
      for (const rec of entry.records) {
        if (rec.id !== id) continue;
        this.groups[rec.archetype].setFade(rec.slot, fade);
        this.groups[rec.archetype].commitFades();
        return;
      }
    });
  }

  update(): void {
    // Static instances + shader wind: nothing to do per frame.
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    for (const g of this.groups) {
      g.mesh.visible = visible;
      if (g.farMesh) g.farMesh.visible = visible;
    }
    this.fallen.mesh.visible = visible;
  }

  stats(): { instances: number; activeCells: number; note?: string } {
    return { instances: this.instanceTotal, activeCells: this.cells.size, note: `fallen ${this.fallenCount}` };
  }

  /** LOD dials: detail ↔ cheap tree meshes switch by distance (plan §6/§47). */
  lodMaterials(): { lod: THREE.ShaderMaterial[]; tiers: THREE.ShaderMaterial[] } {
    const lod: THREE.ShaderMaterial[] = [];
    for (const g of this.groups) {
      lod.push(g.mesh.material as THREE.ShaderMaterial);
      if (g.farMesh) lod.push(g.farMesh.material as THREE.ShaderMaterial);
    }
    return { lod, tiers: [] };
  }

  dispose(): void {
    for (const g of this.groups) g.dispose();
    this.groups.length = 0;
    this.fallen.dispose();
    this.cells.clear();
    this.scratch.length = 0;
  }
}

/** Stable 0..1 value from an object id (phase/random attributes). */
function hash01FromId(id: number): number {
  let h = (id ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
