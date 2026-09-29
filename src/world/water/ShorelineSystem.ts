// NECROFALL — SHORELINE SYSTEM (rework plan §16).
//
// Dresses the band where water meets land: reed clumps in the wet margin plus half-submerged
// pebbles. Both are instanced and placed by the same deterministic cell census as the rest of
// the foliage. The foam itself lives in the water shader; this system makes the edge *physical*
// so the water reads as integrated with the terrain instead of a cut-out sheet.
import * as THREE from 'three';
import { clamp, tangentBasis } from '../../utils/Utils';
import { bladeGeometry, geometryHeight, mergeSimple } from '../Vegetation';
import { InstancedEnvironmentGroup } from '../instancing/InstancedEnvironmentGroup';
import { createEnvironmentMaterial } from '../rendering/EnvironmentMaterials';
import { cellRand } from '../EnvironmentSeed';
import { buildRockGeometry } from '../foliage/RockSystem';
import type { EnvironmentContext, EnvironmentSystem } from '../EnvironmentContext';

const SALT_SHORE = 0x5b04;
const REEDS_PER_CELL = 26;
const PEBBLES_PER_CELL = 34;

const _upY = new THREE.Vector3(0, 1, 0);
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _qAlign = new THREE.Quaternion();
const _qLean = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _scale = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _color = new THREE.Color();

/** A reed clump: five tall thin blades fanning out of one root. */
function buildReedGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const blade = bladeGeometry(3);
    blade.scale(0.7, 2.1, 0.7);
    blade.rotateZ((i / 5) * Math.PI * 2 * 0.5 + 0.2);
    blade.rotateX(-0.28 - (i % 3) * 0.18);
    parts.push(blade);
  }
  return mergeSimple(parts);
}

interface CellShore {
  reeds: { start: number; count: number } | null;
  pebbles: { start: number; count: number } | null;
}

export class ShorelineSystem implements EnvironmentSystem {
  readonly name = 'shoreline';

  private readonly reeds: InstancedEnvironmentGroup;
  private readonly pebbles: InstancedEnvironmentGroup;
  private readonly reedMat: THREE.ShaderMaterial;
  private readonly cells = new Map<number, CellShore>();
  private visible = true;
  private instanceTotal = 0;
  private readonly level: number;

  constructor(private readonly ctx: EnvironmentContext) {
    this.level = ctx.provider.waterLevel;
    const reedMat = createEnvironmentMaterial(ctx.wind, {
      wind: 'blade', dither: true, tiers: true, huePreserve: true, noise: 0.2,
    });
    reedMat.uniforms.uTierDists.value.set(40, 80, 130, 9999);
    reedMat.uniforms.uTierFracs.value.set(1, 0.4, 0.1, 0);
    reedMat.uniforms.uTagColor.value = new THREE.Color(ctx.biome.grassRoot);
    this.reedMat = reedMat;
    const pebbleMat = createEnvironmentMaterial(ctx.wind, { facet: 0.8, noise: 0.5, fresnel: 0.12, dither: true });
    pebbleMat.uniforms.uTagColor.value = new THREE.Color(ctx.biome.waterShallow);

    this.reeds = new InstancedEnvironmentGroup('env-reeds', ctx.assets.ensure('geo:reed', () => buildReedGeometry()), reedMat, 1400);
    this.pebbles = new InstancedEnvironmentGroup(
      'env-shore-pebbles',
      // Shares the rock system's small-rock BASE geometry — one build, two groups (plan §69).
      ctx.assets.ensure('geo:rock-0-f', () => buildRockGeometry(0, false)),
      pebbleMat,
      1600
    );
    ctx.root.add(this.reeds.mesh, this.pebbles.mesh);
  }

  activateCell(cell: number): boolean {
    if (this.cells.has(cell)) return true;
    if (this.level <= 0) {
      this.cells.set(cell, { reeds: null, pebbles: null });
      return true;
    }
    const rng = cellRand(this.ctx.seed, cell, SALT_SHORE, this.ctx.version);
    const scale = clamp(this.ctx.qualityScale(), 0.15, 1);
    const half = this.ctx.cells.cellSize * 0.62;
    const R = this.ctx.radius;

    const cx = this.ctx.cells.centerX(cell), cy = this.ctx.cells.centerY(cell), cz = this.ctx.cells.centerZ(cell);
    _dir.set(cx, cy, cz);
    tangentBasis(_dir, _t1, _t2);

    // Reeds: depth in the wet margin [-0.7 .. +0.5] (roots just under, tips above the water).
    const reedTargets = Math.max(2, Math.round(REEDS_PER_CELL * scale));
    const reedAlloc = this.reeds.alloc(reedTargets);
    let reedPlaced = 0;
    if (reedAlloc) {
      let slot = reedAlloc.start;
      for (let c = 0; c < reedTargets * 6 && reedPlaced < reedTargets; c++) {
        const ox = rng.range(-half, half);
        const oy = rng.range(-half, half);
        _dir.set(cx, cy, cz).multiplyScalar(R).addScaledVector(_t1, ox).addScaledVector(_t2, oy).normalize();
        const h = this.ctx.provider.getHeight(_dir.x, _dir.y, _dir.z);
        const depth = this.level - h;
        if (depth < -0.7 || depth > 0.55) continue;       // must be right at the waterline
        if (!this.ctx.masks.isClear(_dir)) continue;
        this.ctx.provider.getNormal(_dir.x, _dir.y, _dir.z, _normal);
        _pos.set(_dir.x * h, _dir.y * h, _dir.z * h).addScaledVector(_normal, 0.05);
        _qAlign.setFromUnitVectors(_upY, _normal);
        _e.set(rng.range(-0.18, 0.18), rng.range(0, 6.28), rng.range(-0.18, 0.18), 'YXZ');
        _qLean.setFromEuler(_e);
        _q.copy(_qAlign).multiply(_qLean);
        const s = rng.range(0.7, 1.2);
        _scale.set(s, s * rng.range(0.8, 1.25), s);
        _m.compose(_pos, _q, _scale);
        _color.setHex(this.ctx.biome.grassRoot).offsetHSL(0, rng.range(-0.05, 0.05), rng.range(-0.08, 0.1));
        this.reeds.set(slot++, {
          matrix: _m, color: _color, tint: rng.range(0.8, 1.15), phase: rng.range(0, 6.28),
          height: geometryHeight(this.reeds.mesh.geometry) * _scale.y, rand: rng.next(), lod: 1,
        });
        reedPlaced++;
      }
      if (reedPlaced < reedAlloc.count) this.reeds.free(reedAlloc.start + reedPlaced, reedAlloc.count - reedPlaced);
      this.reeds.commit();
    }

    // Pebbles: scattered generously in and around the shallow band.
    const pebbleTargets = Math.max(2, Math.round(PEBBLES_PER_CELL * scale));
    const pebbleAlloc = this.pebbles.alloc(pebbleTargets);
    let pebblePlaced = 0;
    if (pebbleAlloc) {
      let slot = pebbleAlloc.start;
      for (let c = 0; c < pebbleTargets * 5 && pebblePlaced < pebbleTargets; c++) {
        const ox = rng.range(-half, half);
        const oy = rng.range(-half, half);
        _dir.set(cx, cy, cz).multiplyScalar(R).addScaledVector(_t1, ox).addScaledVector(_t2, oy).normalize();
        const h = this.ctx.provider.getHeight(_dir.x, _dir.y, _dir.z);
        const depth = this.level - h;
        if (depth < -1.6 || depth > 0.9) continue;
        this.ctx.provider.getNormal(_dir.x, _dir.y, _dir.z, _normal);
        _pos.set(_dir.x * h, _dir.y * h, _dir.z * h);
        _qAlign.setFromUnitVectors(_upY, _normal);
        _e.set(rng.range(-0.3, 0.3), rng.range(0, 6.28), rng.range(-0.3, 0.3), 'YXZ');
        _qLean.setFromEuler(_e);
        _q.copy(_qAlign).multiply(_qLean);
        const s = rng.range(0.1, 0.3);
        _scale.set(s, s, s);
        _m.compose(_pos, _q, _scale);
        _color.setHex(this.ctx.biome.waterDeep).offsetHSL(0, 0, rng.range(0, 0.25));
        this.pebbles.set(slot++, {
          matrix: _m, color: _color, tint: rng.range(0.85, 1.1), phase: rng.range(0, 6.28),
          height: 1, rand: rng.next(), lod: 1,
        });
        pebblePlaced++;
      }
      if (pebblePlaced < pebbleAlloc.count) this.pebbles.free(pebbleAlloc.start + pebblePlaced, pebbleAlloc.count - pebblePlaced);
      this.pebbles.commit();
    }

    this.instanceTotal += reedPlaced + pebblePlaced;
    this.cells.set(cell, {
      reeds: reedPlaced > 0 ? { start: reedAlloc!.start, count: reedPlaced } : null,
      pebbles: pebblePlaced > 0 ? { start: pebbleAlloc!.start, count: pebblePlaced } : null,
    });
    return true;
  }

  deactivateCell(cell: number): void {
    const entry = this.cells.get(cell);
    if (!entry) return;
    if (entry.reeds) {
      for (let i = entry.reeds.start; i < entry.reeds.start + entry.reeds.count; i++) this.reeds.setState(i, 0);
      this.reeds.commitStates();
      this.reeds.free(entry.reeds.start, entry.reeds.count);
      this.instanceTotal -= entry.reeds.count;
    }
    if (entry.pebbles) {
      for (let i = entry.pebbles.start; i < entry.pebbles.start + entry.pebbles.count; i++) this.pebbles.setState(i, 0);
      this.pebbles.commitStates();
      this.pebbles.free(entry.pebbles.start, entry.pebbles.count);
      this.instanceTotal -= entry.pebbles.count;
    }
    this.cells.delete(cell);
  }

  update(): void {}

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.reeds.mesh.visible = visible;
    this.pebbles.mesh.visible = visible;
  }

  stats(): { instances: number; activeCells: number } {
    return { instances: this.instanceTotal, activeCells: this.cells.size };
  }

  /** LOD dials: reeds thin by distance tiers (plan §8/§47). */
  lodMaterials(): { lod: THREE.ShaderMaterial[]; tiers: THREE.ShaderMaterial[] } {
    return { lod: [], tiers: [this.reedMat] };
  }

  dispose(): void {
    this.reeds.dispose();
    this.pebbles.dispose();
    this.cells.clear();
  }
}
