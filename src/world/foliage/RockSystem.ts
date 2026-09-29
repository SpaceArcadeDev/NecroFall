// NECROFALL — ROCK SYSTEM (rework plan §17/§18/§59/§64).
//
// 5–10 base shapes instanced across the planet: small rubble, medium boulders, large formations,
// alien crystals (emissive) and contaminated growths. Placement reads the shared habitat field —
// rocks gather on steep ground, crest lines, ravines and shorelines, and stay OFF gameplay paths
// (plan §17/§61/§64).
//
// Same deterministic cell census as the trees (plan §59): candidates are enumerated in a fixed
// order and each rock's identity is its candidate index, so the same world grows on every client.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, tangentBasis } from '../../utils/Utils';
import { geometryHeight } from '../Vegetation';
import { InstancedEnvironmentGroup } from '../instancing/InstancedEnvironmentGroup';
import { createEnvironmentMaterial } from '../rendering/EnvironmentMaterials';
import { cellRand, environmentObjectId } from '../EnvironmentSeed';
import { createHabitat, type HabitatSample } from '../terrain/TerrainSurfaceQuery';
import type { EnvironmentContext, EnvironmentSystem } from '../EnvironmentContext';

/** Kind tag used in deterministic object ids (`environmentObjectId(cell, kind, slot)`). */
export const ENV_KIND_ROCK = 4;

/** Variant order shared with `BiomeDefinition.rockSet`. */
export const ROCK_VARIANTS = ['SMALL', 'MEDIUM', 'LARGE', 'CRYSTAL', 'CONTAMINATED'] as const;

const SALT_ROCKS = 0x7c02;

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

/** Builds one variant's geometry; `detail` false returns a coarser LOD1 shape. */
export function buildRockGeometry(variant: number, detail: boolean): THREE.BufferGeometry {
  switch (variant) {
    case 0: { // SMALL — rubble chunk
      const geo = new THREE.DodecahedronGeometry(1, 0);
      geo.scale(1, 0.72, 0.9);
      geo.computeVertexNormals();
      return geo;
    }
    case 1: { // MEDIUM — boulder
      const geo = new THREE.DodecahedronGeometry(1, detail ? 0 : 0);
      geo.scale(1.15, 0.85, 1);
      geo.computeVertexNormals();
      return geo;
    }
    case 2: { // LARGE — formation (two merged slabs)
      if (!detail) {
        const geo = new THREE.IcosahedronGeometry(1, 0);
        geo.scale(1.1, 1.35, 1);
        geo.computeVertexNormals();
        return geo;
      }
      const a = new THREE.IcosahedronGeometry(1, 1);
      a.scale(1.15, 1.5, 1);
      const b = new THREE.IcosahedronGeometry(0.62, 0);
      b.translate(0.85, -0.2, 0.35);
      b.scale(1, 1.7, 1);
      const merged = mergeGeometries([a, b], false);
      a.dispose();
      b.dispose();
      merged.computeVertexNormals();
      return merged;
    }
    case 3: { // CRYSTAL — clustered shards
      const parts: THREE.BufferGeometry[] = [];
      const spike = (r: number, h: number, x: number, z: number, tilt: number): THREE.BufferGeometry => {
        // ConeGeometry is indexed; the polyhedron bases are not — keep every part non-indexed.
        const g = new THREE.ConeGeometry(r, h, 5).toNonIndexed();
        g.translate(0, h * 0.45, 0);
        g.rotateX(tilt);
        g.translate(x, 0, z);
        return g;
      };
      parts.push(spike(0.42, 2.6, 0, 0, 0));
      if (detail) {
        parts.push(spike(0.3, 1.6, 0.6, 0.25, 0.28));
        parts.push(spike(0.26, 1.3, -0.5, -0.35, -0.22));
        parts.push(spike(0.18, 0.9, 0.15, -0.6, 0.18));
      }
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      merged.computeVertexNormals();
      return merged;
    }
    default: { // CONTAMINATED — boulder with growth spikes
      const base = new THREE.DodecahedronGeometry(1, 0);
      base.scale(1, 0.8, 1);
      if (!detail) {
        base.computeVertexNormals();
        return base;
      }
      const parts: THREE.BufferGeometry[] = [base];
      for (let i = 0; i < 3; i++) {
        const g = new THREE.ConeGeometry(0.22, 0.9, 4).toNonIndexed();
        const a = (i / 3) * Math.PI * 2;
        g.rotateZ(0.3);
        g.rotateY(a);
        g.translate(Math.cos(a) * 0.55, 0.55, Math.sin(a) * 0.55);
        parts.push(g);
      }
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      merged.computeVertexNormals();
      return merged;
    }
  }
}

interface CellRocks {
  allocs: { variant: number; start: number; count: number }[];
  /** Large formations that act as camera occluders (plan §27). */
  large: { id: number; x: number; y: number; z: number; r: number; slot: number }[];
}

export class RockSystem implements EnvironmentSystem {
  readonly name = 'rocks';

  private readonly groups: InstancedEnvironmentGroup[] = [];
  private readonly cells = new Map<number, CellRocks>();
  private readonly habitat: HabitatSample = createHabitat();
  private visible = true;
  private instanceTotal = 0;

  constructor(private readonly ctx: EnvironmentContext) {
    const cellArea = ctx.cells.cellSize * ctx.cells.cellSize * 1.15;
    const densityPerCell = cellArea * 0.05 * ctx.profile.rocks;
    const activeCells = Math.ceil((Math.PI * ctx.profile.activationRadius * ctx.profile.activationRadius) / cellArea);
    const totalCapacity = Math.max(64, Math.round(densityPerCell * activeCells * 1.6));
    const weights = ctx.biome.rockSet;
    const sum = weights.reduce((a, b) => a + b, 0) || 1;

    for (let variant = 0; variant < 5; variant++) {
      if (weights[variant] <= 0.01) continue;
      const capacity = Math.max(24, Math.round((totalCapacity * weights[variant]) / sum));
      const material = variant === 3
        ? createEnvironmentMaterial(ctx.wind, { facet: 0.6, noise: 0.25, emissive: 0.55, fresnel: 0.45, alpha: 0.92, transparent: true, dither: true, lodBand: 'keep-near', lodSoft: 6 })
        : createEnvironmentMaterial(ctx.wind, { facet: 0.85, noise: 0.5, fresnel: 0.1, dither: true, lodBand: 'keep-near', lodSoft: 6 });
      material.uniforms.uTagColor.value = new THREE.Color(variant === 3 ? ctx.biome.waterContamination : ctx.biome.terrainColor);
      const farMaterial = createEnvironmentMaterial(ctx.wind, { facet: 0.85, noise: 0.45, fresnel: 0.06, dither: true, lodBand: 'keep-far', lodSoft: 6 });
      const group = new InstancedEnvironmentGroup(
        `env-rock-${ROCK_VARIANTS[variant]}`,
        ctx.assets.ensure(`geo:rock-${variant}-d`, () => buildRockGeometry(variant, true)),
        material,
        capacity,
        {
          geometry: ctx.assets.ensure(`geo:rock-${variant}-f`, () => buildRockGeometry(variant, false)),
          material: farMaterial,
        }
      );
      this.groups[variant] = group;
      ctx.root.add(group.mesh, group.farMesh!);
    }
  }

  activateCell(cell: number): boolean {
    if (this.cells.has(cell)) return true;
    const rng = cellRand(this.ctx.seed, cell, SALT_ROCKS, this.ctx.version);
    const scale = clamp(this.ctx.qualityScale(), 0.1, 1);
    const area = this.ctx.cells.cellSize * this.ctx.cells.cellSize * 1.15;
    const candidates = Math.max(4, Math.round(area * 0.055 * this.ctx.profile.rocks * scale * 1.5));
    const half = this.ctx.cells.cellSize * 0.62;
    const R = this.ctx.radius;
    const level = this.ctx.provider.waterLevel;

    const cx = this.ctx.cells.centerX(cell), cy = this.ctx.cells.centerY(cell), cz = this.ctx.cells.centerZ(cell);
    _dir.set(cx, cy, cz);
    tangentBasis(_dir, _t1, _t2);

    const colorBase = this.ctx.biome.terrainColor;
    const placed: { variant: number; matrix: THREE.Matrix4; color: THREE.Color; tint: number; rand: number; height: number }[] = [];
    const perVariant: number[] = [0, 0, 0, 0, 0];

    for (let c = 0; c < candidates; c++) {
      const ox = rng.range(-half, half);
      const oy = rng.range(-half, half);
      _dir.set(cx, cy, cz).multiplyScalar(R).addScaledVector(_t1, ox).addScaledVector(_t2, oy).normalize();

      const h = this.ctx.provider.getHeight(_dir.x, _dir.y, _dir.z);
      const slope = this.ctx.provider.getSlope(_dir.x, _dir.y, _dir.z);
      if (!this.ctx.masks.isClear(_dir)) continue;

      const habitat = this.ctx.query.habitatAt(_dir, this.habitat);
      let weight = clamp(habitat.rock, 0, 1);
      // Cliffs, ravines and shorelines gather extra rubble (plan §17).
      if (slope > 0.95) weight = clamp(weight + 0.35, 0, 1);
      if (level > 0 && h > level - 2.4 && h < level + 1.2) weight = clamp(weight + 0.3, 0, 1);
      if (weight < 0.05) continue;
      if (rng.next() > weight * 0.75) continue;

      // Variant selection from the biome set; crystals prefer cold/crystal worlds, contaminated
      // growth prefers corrupt ones.
      const weights = [...this.ctx.biome.rockSet];
      if (habitat.temperature < 0.32) weights[3] += 0.2;
      if (habitat.contamination > 0.6) weights[4] += (habitat.contamination - 0.6) * 0.8;
      const wsum = weights.reduce((a, b) => a + b, 0) || 1;
      let roll = rng.next() * wsum;
      let variant = 0;
      for (let k = 0; k < 5; k++) {
        roll -= weights[k];
        if (roll <= 0) { variant = k; break; }
      }
      if (!this.groups[variant]) variant = 0;

      this.ctx.provider.getNormal(_dir.x, _dir.y, _dir.z, _normal);
      _pos.set(_dir.x * h, _dir.y * h, _dir.z * h);
      _qAlign.setFromUnitVectors(_upY, _normal);
      _e.set(rng.range(-0.12, 0.12), rng.range(0, Math.PI * 2), rng.range(-0.12, 0.12), 'YXZ');
      _qYaw.setFromEuler(_e);
      _q.copy(_qAlign).multiply(_qYaw);
      const size = variant === 0 ? rng.range(0.28, 0.7)
        : variant === 1 ? rng.range(0.7, 1.5)
        : variant === 2 ? rng.range(1.4, 2.6)
        : variant === 3 ? rng.range(0.7, 1.6)
        : rng.range(0.5, 1.2);
      // Half-buried: rock geometry is centred, so sitting it ON the ground buries its lower half
      // naturally; crystals root at their base and only get a slight embed.
      const lift = variant === 3 ? size * 0.1 : 0;
      _pos.addScaledVector(_normal, lift);
      _scale.set(size * rng.range(0.85, 1.15), size * rng.range(0.75, 1.2), size * rng.range(0.85, 1.15));
      _m.compose(_pos, _q, _scale);
      const tint = rng.range(0.85, 1.15);
      _color.setHex(variant === 3 ? this.ctx.biome.waterContamination : variant === 4 ? 0x4a2a5a : colorBase);
      _color.offsetHSL(0, rng.range(-0.04, 0.03), rng.range(-0.08, 0.08));
      placed.push({ variant, matrix: _m.clone(), color: _color.clone(), tint, rand: rng.next(), height: geometryHeight(this.groups[variant].mesh.geometry) * _scale.y });
      perVariant[variant]++;
    }

    const allocs: { variant: number; start: number; count: number }[] = [];
    for (let v = 0; v < 5; v++) {
      if (perVariant[v] === 0 || !this.groups[v]) continue;
      const a = this.groups[v].alloc(perVariant[v]);
      if (!a) {
        for (const done of allocs) this.groups[done.variant].free(done.start, done.count);
        return false;
      }
      allocs.push({ variant: v, start: a.start, count: a.count });
    }

    const cursor: Record<number, number> = {};
    for (const a of allocs) cursor[a.variant] = a.start;
    const large: { id: number; x: number; y: number; z: number; r: number; slot: number }[] = [];
    for (const p of placed) {
      const slot = cursor[p.variant]++;
      this.groups[p.variant].set(slot, {
        matrix: p.matrix,
        color: p.color,
        tint: p.tint,
        phase: p.rand * Math.PI * 2,
        height: p.height,
        rand: p.rand,
        lod: 0.9 + p.rand * 0.2,
      });
      if (p.variant === 2) {
        const e = p.matrix.elements;
        large.push({
          id: environmentObjectId(cell, ENV_KIND_ROCK, slot),
          x: e[12], y: e[13], z: e[14],
          r: Math.max(Math.abs(e[0]), Math.abs(e[10])) * 1.35,
          slot,
        });
      }
    }
    for (const a of allocs) this.groups[a.variant].commit();
    this.cells.set(cell, { allocs, large });
    this.instanceTotal += placed.length;
    return true;
  }

  deactivateCell(cell: number): void {
    const entry = this.cells.get(cell);
    if (!entry) return;
    for (const a of entry.allocs) {
      const g = this.groups[a.variant];
      for (let i = a.start; i < a.start + a.count; i++) g.setState(i, 0);
      g.commitStates();
      g.free(a.start, a.count);
      this.instanceTotal = Math.max(0, this.instanceTotal - a.count);
    }
    this.cells.delete(cell);
  }

  update(): void {
    // Static instances — wind and LOD are shader-side.
  }

  // ------------------------------------------------------------ occluders (plan §27/§54)

  /** Large formations are camera blockers too; small rubble never registers. */
  forEachOccluder(cb: (id: number, x: number, y: number, z: number, radius: number, group: InstancedEnvironmentGroup, slot: number) => void): void {
    const g = this.groups[2];
    if (!g) return;
    this.cells.forEach(entry => {
      for (const rec of entry.large) cb(rec.id, rec.x, rec.y, rec.z, rec.r, g, rec.slot);
    });
  }

  setOcclusion(id: number, fade: number): void {
    const g = this.groups[2];
    if (!g) return;
    this.cells.forEach(entry => {
      for (const rec of entry.large) {
        if (rec.id !== id) continue;
        g.setFade(rec.slot, fade);
        g.commitFades();
        return;
      }
    });
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    for (const g of this.groups) {
      if (!g) continue;
      g.mesh.visible = visible;
      if (g.farMesh) g.farMesh.visible = visible;
    }
  }

  stats(): { instances: number; activeCells: number } {
    return { instances: this.instanceTotal, activeCells: this.cells.size };
  }

  /** LOD dials for the rock shapes (plan §6/§47). */
  lodMaterials(): { lod: THREE.ShaderMaterial[]; tiers: THREE.ShaderMaterial[] } {
    const lod: THREE.ShaderMaterial[] = [];
    for (const g of this.groups) {
      if (!g) continue;
      lod.push(g.mesh.material as THREE.ShaderMaterial);
      if (g.farMesh) lod.push(g.farMesh.material as THREE.ShaderMaterial);
    }
    return { lod, tiers: [] };
  }

  dispose(): void {
    for (const g of this.groups) g?.dispose();
    this.groups.length = 0;
    this.cells.clear();
  }
}
