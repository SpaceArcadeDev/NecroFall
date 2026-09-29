// NECROFALL — ENVIRONMENTAL PROPS (rework plan §56/§57/§58).
//
// The manufactured layer of the post-apocalyptic world: abandoned crates, fuel barrels, wreck
// panels, pipe sections and scattered debris. All instanced; only CRATES and BARRELS are
// destructible (they register in the DestructionLedger and can be broken by explosions —
// plan §57), and broken props spawn a short visual debris burst from the pooled dynamic physics
// (plan §58: visual simulation first, no rigid body per prop).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, tangentBasis } from '../../utils/Utils';
import { geometryHeight } from '../Vegetation';
import { InstancedEnvironmentGroup } from '../instancing/InstancedEnvironmentGroup';
import { createEnvironmentMaterial } from '../rendering/EnvironmentMaterials';
import { cellRand, environmentObjectId, fbm3 } from '../EnvironmentSeed';
import { createHabitat, type HabitatSample } from '../terrain/TerrainSurfaceQuery';
import { STATE_DAMAGED, STATE_DESTROYED, STATE_INTACT, type DestructionState } from '../interaction/DestructionLedger';
import type { EnvironmentContext, EnvironmentSystem } from '../EnvironmentContext';

export const ENV_KIND_PROP = 3;

/** Prop kinds: crates and barrels are destructible; panels/pipes/debris are decor. */
export const PROP_KINDS = ['CRATE', 'BARREL', 'PANEL', 'PIPE', 'DEBRIS'] as const;
const DESTRUCTIBLE = [true, true, false, false, false];

const SALT_PROPS = 0x9d03;

const _upY = new THREE.Vector3(0, 1, 0);
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _qAlign = new THREE.Quaternion();
const _qSpin = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _scale = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _color = new THREE.Color();

function buildPropGeometry(kind: number, detail: boolean): THREE.BufferGeometry {
  switch (kind) {
    case 0: { // CRATE — plated supply box
      const g = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
      if (detail) {
        const rim = new THREE.BoxGeometry(1.06, 0.12, 1.06);
        rim.translate(0, 0.34, 0);
        const merged = mergeGeometries([g, rim], false);
        g.dispose();
        rim.dispose();
        merged.computeVertexNormals();
        return merged;
      }
      g.computeVertexNormals();
      return g;
    }
    case 1: { // BARREL — dented fuel drum
      const g = new THREE.CylinderGeometry(0.5, 0.5, 1.25, detail ? 8 : 6);
      if (detail) {
        const band = new THREE.CylinderGeometry(0.54, 0.54, 0.1, 8);
        band.translate(0, 0.2, 0);
        const merged = mergeGeometries([g, band], false);
        g.dispose();
        band.dispose();
        merged.computeVertexNormals();
        return merged;
      }
      g.computeVertexNormals();
      return g;
    }
    case 2: { // PANEL — wreck hull plate
      const parts: THREE.BufferGeometry[] = [];
      const plate = new THREE.BoxGeometry(1.6, 0.1, 1.1);
      plate.rotateZ(0.12);
      parts.push(plate);
      if (detail) {
        const strut = new THREE.BoxGeometry(0.12, 0.12, 1.2);
        strut.rotateX(0.4);
        strut.translate(0.6, 0.24, 0);
        parts.push(strut);
      }
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      merged.computeVertexNormals();
      return merged;
    }
    case 3: { // PIPE — broken industrial pipe
      const parts: THREE.BufferGeometry[] = [];
      const pipe = new THREE.CylinderGeometry(0.16, 0.18, 2.4, 6, 1, true);
      pipe.rotateZ(Math.PI / 2);
      parts.push(pipe);
      if (detail) {
        const elbow = new THREE.CylinderGeometry(0.15, 0.15, 0.7, 6);
        elbow.translate(0, 0.3, 0);
        parts.push(elbow);
      }
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      merged.computeVertexNormals();
      return merged;
    }
    default: { // DEBRIS — twisted scrap
      const parts: THREE.BufferGeometry[] = [];
      const a = new THREE.BoxGeometry(0.6, 0.08, 0.4);
      a.rotateZ(0.3);
      parts.push(a);
      if (detail) {
        const b = new THREE.BoxGeometry(0.3, 0.07, 0.5);
        b.rotateY(0.7);
        b.translate(0.25, 0.05, 0.1);
        parts.push(b);
        // CylinderGeometry is indexed like BoxGeometry — mixed-part merges stay legal, but keep
        // the non-indexed rule when combining with polyhedra (see TreeSystem/RockSystem).
        const c = new THREE.CylinderGeometry(0.04, 0.04, 0.7, 4);
        c.rotateX(1.1);
        c.translate(-0.2, 0.06, -0.08);
        parts.push(c);
      }
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      merged.computeVertexNormals();
      return merged;
    }
  }
}

interface PropRecord {
  id: number;
  kind: number;
  slot: number;
  state: DestructionState;
  hp: number;
  posX: number;
  posY: number;
  posZ: number;
  radius: number;
}

interface CellProps {
  records: PropRecord[];
  allocs: { kind: number; start: number; count: number }[];
}

export class PropSystem implements EnvironmentSystem {
  readonly name = 'props';

  private readonly groups: (InstancedEnvironmentGroup | null)[] = [null, null, null, null, null];
  private readonly cells = new Map<number, CellProps>();
  private readonly habitat: HabitatSample = createHabitat();
  private visible = true;
  private instanceTotal = 0;
  private destructibleTotal = 0;

  constructor(private readonly ctx: EnvironmentContext) {
    const cellArea = ctx.cells.cellSize * ctx.cells.cellSize * 1.15;
    const densityPerCell = cellArea * 0.012 * ctx.profile.props;
    const activeCells = Math.ceil((Math.PI * ctx.profile.activationRadius * ctx.profile.activationRadius) / cellArea);
    const totalCapacity = Math.max(24, Math.round(densityPerCell * activeCells * 1.5));
    // Kind mix: decor dominates, destructibles are the rare interactive find.
    const mix = [0.18, 0.12, 0.24, 0.18, 0.28];

    for (let kind = 0; kind < 5; kind++) {
      const capacity = Math.max(8, Math.round(totalCapacity * mix[kind]));
      const material = createEnvironmentMaterial(ctx.wind, {
        facet: 0.35, noise: 0.4, fresnel: 0.12, dither: true, lodBand: 'keep-near', lodSoft: 5,
      });
      material.uniforms.uTagColor.value = new THREE.Color(kind === 0 ? 0xb08a2c : ctx.biome.terrainColor);
      const group = new InstancedEnvironmentGroup(
        `env-prop-${PROP_KINDS[kind]}`,
        ctx.assets.ensure(`geo:prop-${kind}-d`, () => buildPropGeometry(kind, true)),
        material,
        capacity
      );
      this.groups[kind] = group;
      ctx.root.add(group.mesh);
    }
  }

  activateCell(cell: number): boolean {
    if (this.cells.has(cell)) return true;
    const rng = cellRand(this.ctx.seed, cell, SALT_PROPS, this.ctx.version);
    const scale = clamp(this.ctx.qualityScale(), 0.15, 1);
    const area = this.ctx.cells.cellSize * this.ctx.cells.cellSize * 1.15;
    // Props favour settled ground near landmarks — the human-ruin layer (plan §56).
    const candidates = Math.max(2, Math.round(area * 0.014 * this.ctx.profile.props * scale * 1.4));
    const half = this.ctx.cells.cellSize * 0.62;
    const R = this.ctx.radius;

    const cx = this.ctx.cells.centerX(cell), cy = this.ctx.cells.centerY(cell), cz = this.ctx.cells.centerZ(cell);
    _dir.set(cx, cy, cz);
    tangentBasis(_dir, _t1, _t2);

    const ruinField = (x: number, y: number, z: number): number =>
      fbm3(x * 3.4 + 1.2, y * 3.4 + 6.6, z * 3.4 + 3.3, 2, (this.ctx.seed ^ 0x51a7) >>> 0);

    const placed: { kind: number; matrix: THREE.Matrix4; color: THREE.Color; tint: number; rand: number; height: number; destructible: boolean; radius: number }[] = [];
    const perKind: number[] = [0, 0, 0, 0, 0];

    for (let c = 0; c < candidates; c++) {
      const ox = rng.range(-half, half);
      const oy = rng.range(-half, half);
      _dir.set(cx, cy, cz).multiplyScalar(R).addScaledVector(_t1, ox).addScaledVector(_t2, oy).normalize();

      const h = this.ctx.provider.getHeight(_dir.x, _dir.y, _dir.z);
      const slope = this.ctx.provider.getSlope(_dir.x, _dir.y, _dir.z);
      if (slope > 0.55) continue;                                  // props need settled ground
      if (!this.ctx.masks.isClear(_dir)) continue;
      const habitat = this.ctx.query.habitatAt(_dir, this.habitat);
      // Clustered at ruin sites: the low-frequency field decides where people used to live.
      const ruin = clamp(ruinField(_dir.x, _dir.y, _dir.z) * 2.2, 0, 1);
      const accept = clamp(habitat.prop, 0, 1) * ruin * this.ctx.biome.propDensity;
      if (rng.next() > accept * 0.55) continue;

      // Kind mixture: ruins toward panels/pipes, wasteland toward debris/barrels.
      const weights = [0.2, 0.14, 0.24, 0.16, 0.26];
      if (this.ctx.biome.structures === 'INDUSTRIAL') { weights[3] += 0.2; weights[1] += 0.12; }
      if (this.ctx.biome.structures === 'WRECKAGE') { weights[2] += 0.18; weights[4] += 0.1; }
      if (this.ctx.biome.structures === 'RUINS') { weights[0] += 0.15; weights[2] += 0.1; }
      if (this.ctx.biome.structures === 'BONES') { weights[4] += 0.15; }
      const wsum = weights.reduce((a, b) => a + b, 0);
      let roll = rng.next() * wsum;
      let kind = 0;
      for (let k = 0; k < 5; k++) {
        roll -= weights[k];
        if (roll <= 0) { kind = k; break; }
      }

      this.ctx.provider.getNormal(_dir.x, _dir.y, _dir.z, _normal);
      _pos.set(_dir.x * h, _dir.y * h, _dir.z * h);
      _qAlign.setFromUnitVectors(_upY, _normal);
      _e.set(kind === 2 ? rng.range(0.1, 0.45) : rng.range(-0.08, 0.08), rng.range(0, Math.PI * 2), rng.range(-0.1, 0.1), 'YXZ');
      _qSpin.setFromEuler(_e);
      _q.copy(_qAlign).multiply(_qSpin);
      const size = rng.range(0.7, 1.25) * (kind === 4 ? 0.8 : 1);
      _scale.set(size, size * rng.range(0.8, 1.05), size);
      _pos.addScaledVector(_normal, kind === 4 ? 0.04 : size * 0.3);
      _m.compose(_pos, _q, _scale);
      const tint = rng.range(0.8, 1.15);
      const baseHex = kind === 0 ? 0x8a6a3a : kind === 1 ? 0x8a4a2c : this.ctx.biome.terrainColor;
      _color.setHex(baseHex).offsetHSL(0, rng.range(-0.05, 0.03), rng.range(-0.1, 0.1));
      const destructible = DESTRUCTIBLE[kind];
      placed.push({
        kind, matrix: _m.clone(), color: _color.clone(), tint, rand: rng.next(),
        height: geometryHeight(this.groups[kind]!.mesh.geometry) * _scale.y,
        destructible,
        radius: size * (kind === 0 ? 0.9 : kind === 1 ? 0.7 : 1.2),
      });
      perKind[kind]++;
    }

    const allocs: { kind: number; start: number; count: number }[] = [];
    for (let k = 0; k < 5; k++) {
      if (perKind[k] === 0) continue;
      const a = this.groups[k]!.alloc(perKind[k]);
      if (!a) {
        for (const done of allocs) this.groups[done.kind]!.free(done.start, done.count);
        return false;
      }
      allocs.push({ kind: k, start: a.start, count: a.count });
    }

    const cursor: Record<number, number> = {};
    for (const a of allocs) cursor[a.kind] = a.start;
    const records: PropRecord[] = [];
    for (const p of placed) {
      const slot = cursor[p.kind]++;
      const id = environmentObjectId(cell, ENV_KIND_PROP, slot);
      const ledgerState = this.ctx.ledger.get(id);
      if (ledgerState === STATE_DESTROYED) {
        this.groups[p.kind]!.set(slot, { matrix: p.matrix, color: p.color, tint: p.tint, phase: p.rand * 6.28, height: p.height, rand: p.rand, state: 0 });
        continue;
      }
      this.groups[p.kind]!.set(slot, {
        matrix: p.matrix,
        color: p.color,
        tint: p.tint,
        phase: p.rand * 6.28,
        height: p.height,
        rand: p.rand,
        lod: 0.9 + p.rand * 0.2,
        state: 1,
      });
      if (p.destructible) {
        records.push({
          id, kind: p.kind, slot,
          state: ledgerState === STATE_DAMAGED ? STATE_DAMAGED : STATE_INTACT,
          hp: 100,
          posX: p.matrix.elements[12], posY: p.matrix.elements[13], posZ: p.matrix.elements[14],
          radius: p.radius,
        });
        this.destructibleTotal++;
      }
    }
    for (const a of allocs) this.groups[a.kind]!.commit();
    this.cells.set(cell, { records, allocs });
    this.instanceTotal += placed.length;
    return true;
  }

  deactivateCell(cell: number): void {
    const entry = this.cells.get(cell);
    if (!entry) return;
    for (const a of entry.allocs) {
      const g = this.groups[a.kind]!;
      for (let i = a.start; i < a.start + a.count; i++) g.setState(i, 0);
      g.commitStates();
      g.free(a.start, a.count);
      this.instanceTotal = Math.max(0, this.instanceTotal - a.count);
    }
    this.destructibleTotal = Math.max(0, this.destructibleTotal - entry.records.length);
    this.cells.delete(cell);
  }

  /** Explosion damage (host authoritative — plan §57). Returns changed records. */
  damageAt(pos: THREE.Vector3, radius: number, amount: number): PropRecord[] {
    const changed: PropRecord[] = [];
    this.cells.forEach(entry => {
      for (const rec of entry.records) {
        if (rec.state === STATE_DESTROYED) continue;
        const dx = rec.posX - pos.x, dy = rec.posY - pos.y, dz = rec.posZ - pos.z;
        const dist2 = dx * dx + dy * dy + dz * dz;
        const hit = dist2 <= (radius + rec.radius) * (radius + rec.radius);
        if (!hit) continue;
        rec.hp -= amount;
        const next: DestructionState = rec.hp <= 0 ? STATE_DESTROYED : rec.hp <= 55 ? STATE_DAMAGED : rec.state;
        if (next !== rec.state) {
          this.applyState(rec, next);
          changed.push(rec);
        }
      }
    });
    return changed;
  }

  applyState(rec: PropRecord, state: DestructionState): void {
    if (rec.state === state) return;
    rec.state = state;
    const g = this.groups[rec.kind]!;
    if (state === STATE_DESTROYED) {
      g.setState(rec.slot, 0);
      g.commitStates();
      this.ctx.fx?.burst(new THREE.Vector3(rec.posX, rec.posY, rec.posZ), rec.kind === 1 ? 0xff8a3d : 0x9a8a6a, {
        count: rec.kind === 1 ? 22 : 14, size: 0.34, speed: rec.kind === 1 ? 6 : 3.6,
      });
      if (rec.kind === 1 && this.ctx.fx) {
        this.ctx.fx.ring(new THREE.Vector3(rec.posX, rec.posY, rec.posZ), new THREE.Vector3(rec.posX, rec.posY, rec.posZ).normalize(), 3.2, 0xff8a3d, { dur: 0.5, rings: 2 });
      }
      this.destructibleTotal = Math.max(0, this.destructibleTotal - 1);
    } else {
      rec.hp = Math.min(rec.hp, 54);
      // Damaged: darken + knock askew.
      _color.setHex(0x777770);
      g.setTint(rec.slot, 0.5);
      g.commitTints();
    }
  }

  applyNetworkState(id: number, state: DestructionState): void {
    this.cells.forEach(entry => {
      for (const rec of entry.records) {
        if (rec.id === id) {
          if (rec.state !== state) this.applyState(rec, state);
          return;
        }
      }
    });
  }

  /** Iterates loaded destructible props (interaction/debug). */
  forEachLoaded(cb: (rec: { id: number; kind: number; x: number; y: number; z: number; radius: number; state: DestructionState }) => void): void {
    this.cells.forEach(entry => {
      for (const rec of entry.records) {
        if (rec.state === STATE_DESTROYED) continue;
        cb({ id: rec.id, kind: rec.kind, x: rec.posX, y: rec.posY, z: rec.posZ, radius: rec.radius, state: rec.state });
      }
    });
  }

  update(): void {}

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    for (const g of this.groups) {
      if (g) g.mesh.visible = visible;
    }
  }

  stats(): { instances: number; activeCells: number; note?: string } {
    return { instances: this.instanceTotal, activeCells: this.cells.size, note: `destroyables ${this.destructibleTotal}` };
  }

  /** LOD dials for prop shapes (plan §6/§47). */
  lodMaterials(): { lod: THREE.ShaderMaterial[]; tiers: THREE.ShaderMaterial[] } {
    const lod: THREE.ShaderMaterial[] = [];
    for (const g of this.groups) {
      if (g) lod.push(g.mesh.material as THREE.ShaderMaterial);
    }
    return { lod, tiers: [] };
  }

  dispose(): void {
    for (const g of this.groups) g?.dispose();
    this.cells.clear();
  }
}
