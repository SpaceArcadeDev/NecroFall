// NECROFALL — GRASS SYSTEM (rework plan §7/§8/§9/§25/§59/§72).
//
// Cell-streamed, instanced grass with:
//   * deterministic placement (per-cell seeded streams, hash-thinned by the shared habitat field);
//   * one global InstancedMesh per planet — a single draw call for tens of thousands of blades;
//   * per-instance wind phase + tint, animated entirely in the vertex shader (plan §9);
//   * distance TIERS inside the shader (plan §8): full / 45 % / 12 % / none, each with a random
//     offset so fields thin out instead of popping in rings;
//   * player interaction uniforms: nearby players (and their speed) bend the blades away
//     (plan §25) — no CPU per-blade work, no geometry mutation;
//   * cells: only cells around the players exist; deactivated cells collapse their instances
//     (plan §19), and rebuilding a cell later reproduces the exact same grass (plan §59).
import * as THREE from 'three';
import { clamp, tangentBasis } from '../../utils/Utils';
import { bladeGeometry, dirtAmount, flowerGeometry } from '../Vegetation';
import { InstancedEnvironmentGroup, type InstanceSpec } from '../instancing/InstancedEnvironmentGroup';
import { createEnvironmentMaterial, createInteractUniforms, type InteractUniforms } from '../rendering/EnvironmentMaterials';
import { cellRand } from '../EnvironmentSeed';
import { createHabitat, type HabitatSample } from '../terrain/TerrainSurfaceQuery';
import type { EnvironmentContext, EnvironmentSystem } from '../EnvironmentContext';

const CLUMP = 5;            // blades per clump
const BLADE_H = 0.85;       // bladeGeometry height
const FLOWER_H = 0.42;      // flowerGeometry height
const SALT_GRASS = 0x67a2;
const SALT_FLOWER = 0x67b4;

const _upY = new THREE.Vector3(0, 1, 0);
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _base = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _qAlign = new THREE.Quaternion();
const _qLean = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _color = new THREE.Color();

/** A focus the grass should react to (a player, normally). */
export interface GrassFocus {
  position: THREE.Vector3;
  /** Horizontal speed (m/s) — stronger push at speed. */
  speed: number;
}

interface CellRange {
  start: number;
  count: number;
}

export class GrassSystem implements EnvironmentSystem {
  readonly name = 'grass';

  private readonly blades: InstancedEnvironmentGroup;
  private readonly flowers: InstancedEnvironmentGroup;
  private readonly grassMat: THREE.ShaderMaterial;
  private readonly flowerMat: THREE.ShaderMaterial;
  private readonly interact: InteractUniforms;
  private readonly ranges = new Map<number, CellRange>();
  private readonly flowerRanges = new Map<number, CellRange>();
  private readonly habitat: HabitatSample = createHabitat();
  private readonly bladesPerCell: number;
  private readonly flowersPerCell: number;
  private readonly interactRadius = 2.6;
  private visible = true;
  private activeCells = 0;
  private instanceTotal = 0;

  constructor(private readonly ctx: EnvironmentContext) {
    const cellArea = ctx.cells.cellSize * ctx.cells.cellSize * 1.15;
    // Density comes straight from the profile's `grass` multiplier (plan §74): blades per m² at
    // full quality ≈ 0.5, scaled down per device class — grass is the biggest instance pool, so
    // it gets the strictest cap (plan §43).
    const density = 0.5 * ctx.profile.grass;
    this.bladesPerCell = Math.round(cellArea * density);
    this.flowersPerCell = Math.round(this.bladesPerCell * 0.09);

    const grassMat = createEnvironmentMaterial(ctx.wind, {
      wind: 'blade', interact: true, dither: true, tiers: true, huePreserve: true, noise: 0.25,
    });
    this.interact = createInteractUniforms();
    Object.assign(grassMat.uniforms, this.interact as unknown as Record<string, THREE.IUniform>);
    grassMat.uniforms.uTagColor.value = new THREE.Color(ctx.biome.grassTip);
    this.applyTierUniforms(grassMat);
    this.grassMat = grassMat;

    const activeCellsEstimate = Math.ceil(
      (Math.PI * ctx.profile.activationRadius * ctx.profile.activationRadius) / cellArea
    );
    const bladeCapacity = Math.min(76000, Math.ceil(this.bladesPerCell * activeCellsEstimate * 1.3) + CLUMP);
    this.blades = new InstancedEnvironmentGroup(
      'env-grass',
      ctx.assets.ensure('geo:grass-blade', () => bladeGeometry(5)),
      grassMat,
      bladeCapacity
    );

    const flowerMat = createEnvironmentMaterial(ctx.wind, {
      wind: 'blade', interact: true, dither: true, tiers: true, huePreserve: true, noise: 0.2,
    });
    Object.assign(flowerMat.uniforms, this.interact as unknown as Record<string, THREE.IUniform>);
    flowerMat.uniforms.uTagColor.value = new THREE.Color(ctx.biome.grassTip);
    this.applyTierUniforms(flowerMat);
    this.flowerMat = flowerMat;
    const flowerCapacity = Math.max(64, Math.ceil(bladeCapacity * 0.09));
    this.flowers = new InstancedEnvironmentGroup(
      'env-flowers',
      ctx.assets.ensure('geo:grass-flower', () => flowerGeometry()),
      flowerMat,
      flowerCapacity
    );

    ctx.root.add(this.blades.mesh, this.flowers.mesh);
  }

  private applyTierUniforms(mat: THREE.ShaderMaterial): void {
    const tiers = this.ctx.profile.grassTiers;
    mat.uniforms.uTierDists.value.set(tiers[0], tiers[1], tiers[2], 9999);
    // Fractions are the plan §8 tiers: 100 % / 45 % / 12 % / 0 %.
    mat.uniforms.uTierFracs.value.set(1, 0.45, 0.12, 0);
  }

  /** Builds one cell of grass + flowers. Deterministic per (seed, version, cell). */
  activateCell(cell: number): boolean {
    if (this.ranges.has(cell)) return true;
    const rng = cellRand(this.ctx.seed, cell, SALT_GRASS, this.ctx.version);
    const scale = clamp(this.ctx.qualityScale(), 0.05, 1);
    const targets = Math.max(CLUMP, Math.round(this.bladesPerCell * scale));
    const clumps = Math.ceil(targets / CLUMP);
    // Candidates are generated up front; acceptance follows the habitat field, so grass grows in
    // believable patches (dense in meadows, gone on cliffs) instead of uniform sprinkle.
    const candidates = Math.ceil(clumps * 1.5);

    const alloc = this.blades.alloc(clumps * CLUMP);
    if (!alloc) return false;

    const flowerTargets = Math.max(1, Math.round(this.flowersPerCell * scale));
    const flowerAlloc = this.flowers.alloc(flowerTargets);

    this.ctx.cells.centerOf(cell, _dir);
    tangentBasis(_dir, _t1, _t2);
    const R = this.ctx.radius;
    const half = this.ctx.cells.cellSize * 0.62;
    const baseColor = this.ctx.biome;

    let bladeSlot = alloc.start;
    let flowerSlot = flowerAlloc ? flowerAlloc.start : 0;
    let bladesPlaced = 0;
    let flowersPlaced = 0;

    for (let c = 0; c < candidates && bladesPlaced < targets; c++) {
      const ox = rng.range(-half, half);
      const oy = rng.range(-half, half);
      _base.copy(_dir).multiplyScalar(R).addScaledVector(_t1, ox).addScaledVector(_t2, oy).normalize();

      // --- habitat gate ---------------------------------------------------------------------
      const h = this.ctx.provider.getHeight(_base.x, _base.y, _base.z);
      const slope = this.ctx.provider.getSlope(_base.x, _base.y, _base.z);
      if (slope > 1.15) continue;                                    // cliffs hold no grass
      const level = this.ctx.provider.waterLevel;
      if (level > 0 && h < level + 0.15) continue;                   // water
      if (!this.ctx.masks.isClear(_base)) continue;                  // gameplay zones (plan §61)
      const dirt = dirtAmount(_base.x, _base.z);
      if (dirt > 0.62 && rng.next() < (dirt - 0.62) * 2.2) continue; // bare earth patches
      const habitat = this.ctx.query.habitatAt(_base, this.habitat);
      const biomeScale = (baseColor.foliageDensity - 0.5) * 0.5 + 1; // 0.5 → 1.0, 1.35 → 1.2…
      if (rng.next() > clamp(habitat.grass * biomeScale * 0.9, 0, 1)) continue;

      // --- clump transform ------------------------------------------------------------------
      _pos.copy(_base).multiplyScalar(h);
      this.ctx.provider.getNormal(_base.x, _base.y, _base.z, _normal);
      _qAlign.setFromUnitVectors(_upY, _normal);
      const clumpTint = rng.range(0.82, 1.22);
      const clumpH = rng.range(0.75, 1.2);
      _color.setHex(baseColor.grassTip).offsetHSL(0, rng.range(-0.06, 0.02), rng.range(-0.12, 0.06));

      const take = Math.min(CLUMP, targets - bladesPlaced);
      for (let k = 0; k < take; k++) {
        const ba = rng.range(0, Math.PI * 2);
        const br = Math.sqrt(rng.range(0, 1)) * 0.85;
        _dir.copy(_base)
          .addScaledVector(_t1, Math.cos(ba) * br)
          .addScaledVector(_t2, Math.sin(ba) * br)
          .normalize();
        const hb = this.ctx.provider.getHeight(_dir.x, _dir.y, _dir.z);
        _pos.copy(_dir).multiplyScalar(hb + 0.04);
        _e.set(rng.range(-0.2, 0.2), rng.range(0, Math.PI * 2), rng.range(-0.2, 0.2), 'YXZ');
        _qLean.setFromEuler(_e);
        _q.copy(_qAlign).multiply(_qLean);
        const s = rng.range(0.72, 1.05) * clumpH;
        _scale.set(s * rng.range(0.85, 1.15), s, s * rng.range(0.85, 1.15));
        _m.compose(_pos, _q, _scale);
        const spec: InstanceSpec = {
          matrix: _m,
          color: _color,
          tint: clumpTint * rng.range(0.92, 1.08),
          phase: rng.range(0, Math.PI * 2),
          height: BLADE_H * s,
          rand: rng.next(),
          lod: 1,
        };
        this.blades.set(bladeSlot++, spec);
        bladesPlaced++;
      }

      // --- occasional flower in this clump ----------------------------------------------------
      if (flowerAlloc && flowersPlaced < flowerTargets && rng.next() < 0.35) {
        _dir.copy(_base)
          .addScaledVector(_t1, rng.range(-0.6, 0.6))
          .addScaledVector(_t2, rng.range(-0.6, 0.6))
          .normalize();
        const hf = this.ctx.provider.getHeight(_dir.x, _dir.y, _dir.z);
        _pos.copy(_dir).multiplyScalar(hf + 0.03);
        _e.set(rng.range(-0.15, 0.15), rng.range(0, Math.PI * 2), rng.range(-0.15, 0.15), 'YXZ');
        _qLean.setFromEuler(_e);
        _q.copy(_qAlign).multiply(_qLean);
        const s = rng.range(0.8, 1.25);
        _scale.set(s, s, s);
        _m.compose(_pos, _q, _scale);
        this.flowers.set(flowerSlot++, {
          matrix: _m,
          color: _color.setHex(baseColor.grassTip).offsetHSL(rng.range(-0.08, 0.08), 0, rng.range(-0.05, 0.12)),
          tint: 1,
          phase: rng.range(0, Math.PI * 2),
          height: FLOWER_H * s,
          rand: rng.next(),
          lod: 1,
        });
        flowersPlaced++;
      }
    }

    // Keep exactly what was filled; the unused tail returns to the group's free list so later
    // cells can use it. (Blades are always written contiguously from `alloc.start`, so freeing
    // the tail never strands a hole in the middle.)
    if (bladesPlaced > 0) {
      this.ranges.set(cell, { start: alloc.start, count: bladesPlaced });
      this.instanceTotal += bladesPlaced;
      if (bladesPlaced < alloc.count) this.blades.free(alloc.start + bladesPlaced, alloc.count - bladesPlaced);
    } else {
      this.blades.free(alloc.start, alloc.count);
    }
    if (flowerAlloc) {
      if (flowersPlaced > 0) {
        this.flowerRanges.set(cell, { start: flowerAlloc.start, count: flowersPlaced });
        if (flowersPlaced < flowerAlloc.count) {
          this.flowers.free(flowerAlloc.start + flowersPlaced, flowerAlloc.count - flowersPlaced);
        }
      } else {
        this.flowers.free(flowerAlloc.start, flowerAlloc.count);
      }
    }
    this.blades.commit();
    this.flowers.commit();
    this.activeCells++;
    return true;
  }

  deactivateCell(cell: number): void {
    const range = this.ranges.get(cell);
    if (range) {
      for (let i = range.start; i < range.start + range.count; i++) this.blades.setState(i, 0);
      this.blades.free(range.start, range.count);
      this.instanceTotal = Math.max(0, this.instanceTotal - range.count);
      this.ranges.delete(cell);
      this.activeCells--;
    }
    const flowers = this.flowerRanges.get(cell);
    if (flowers) {
      for (let i = flowers.start; i < flowers.start + flowers.count; i++) this.flowers.setState(i, 0);
      this.flowers.free(flowers.start, flowers.count);
      this.flowerRanges.delete(cell);
    }
    if (range) this.blades.commitStates();
  }

  /**
   * Grass reacts to nearby players (plan §25). The world feeds in positions + speeds at the
   * interaction frequency (plan §71) — not per frame, not per blade. Up to 4 slots; unused slots
   * are zeroed (radius 0) so stale players stop bending grass.
   */
  setFocuses(focuses: readonly GrassFocus[]): void {
    const slots = [this.interact.uInt0.value, this.interact.uInt1.value, this.interact.uInt2.value, this.interact.uInt3.value];
    const pushes = this.interact.uIntPush.value;
    let n = 0;
    for (let i = 0; i < focuses.length && n < 4; i++) {
      const f = focuses[i];
      const speed = Number.isFinite(f.speed) ? f.speed : 0; // NaN would poison the shader uniform
      slots[n].set(f.position.x, f.position.y, f.position.z, this.interactRadius);
      const push = clamp(speed * 0.16, 0.06, 0.42);
      if (n === 0) pushes.x = push;
      else if (n === 1) pushes.y = push;
      else if (n === 2) pushes.z = push;
      else pushes.w = push;
      n++;
    }
    for (let i = n; i < 4; i++) slots[i].set(0, 0, 0, 0);
    if (n <= 0) pushes.x = 0;
    if (n <= 1) pushes.y = 0;
    if (n <= 2) pushes.z = 0;
    if (n <= 3) pushes.w = 0;
  }

  update(): void {
    // Uniforms only — the shader does every per-blade decision (plan §9/§8).
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.blades.mesh.visible = visible;
    this.flowers.mesh.visible = visible;
  }

  stats(): { instances: number; activeCells: number; note?: string } {
    return { instances: this.instanceTotal, activeCells: this.activeCells };
  }

  /** LOD dials: the grass field thins by distance tiers (plan §8/§47). */
  lodMaterials(): { lod: THREE.ShaderMaterial[]; tiers: THREE.ShaderMaterial[] } {
    return { lod: [], tiers: [this.grassMat, this.flowerMat] };
  }

  dispose(): void {
    this.blades.dispose();
    this.flowers.dispose();
    this.ranges.clear();
    this.flowerRanges.clear();
  }
}
