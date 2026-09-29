// NECROFALL — ENVIRONMENT LOD (rework plan §6/§8/§23/§47).
//
// Owns the LIVE LOD dials the dynamic quality manager can turn without rebuilding anything:
//
//   * per-material LOD switch distances (tree/rock/prop detail ↔ cheap meshes);
//   * grass/shoreline tier distance multipliers;
//   * the fog-distance hint used by telemetry.
//
// Materials register themselves once; every later quality change writes the uniforms in place,
// so stepping the quality is O(materials), not O(instances) (plan §47).
import type { ShaderMaterial } from 'three';
import { clamp } from '../../utils/Utils';

interface LodEntry {
  material: ShaderMaterial;
  base: number;
  softBase: number;
}

interface TierEntry {
  material: ShaderMaterial;
  base: [number, number, number, number];
}

export class EnvironmentLOD {
  private readonly lodEntries: LodEntry[] = [];
  private readonly tierEntries: TierEntry[] = [];
  private lodScale = 1;
  private tierScale = 1;

  /** Registers a material with a LOD band (reads its current `uLodSwitch` as the base). */
  registerMaterial(material: ShaderMaterial): void {
    const u = material.uniforms.uLodSwitch as { value: number } | undefined;
    if (!u) return;
    const soft = material.uniforms.uLodSoft as { value: number } | undefined;
    this.lodEntries.push({ material, base: u.value, softBase: soft?.value ?? 6 });
    this.applyLod(material, this.lodScale);
  }

  /** Registers a tiered material (grass/reeds) — base distances read from its uniforms. */
  registerTierMaterial(material: ShaderMaterial): void {
    const d = material.uniforms.uTierDists as { value: { x: number; y: number; z: number; w: number } } | undefined;
    if (!d) return;
    this.tierEntries.push({ material, base: [d.value.x, d.value.y, d.value.z, d.value.w] });
    this.applyTiers(material, this.tierScale);
  }

  /** Applies both scales (called by the quality manager when the dynamic step changes). */
  setScales(lodScale: number, tierScale: number): void {
    this.lodScale = clamp(lodScale, 0.4, 1.4);
    this.tierScale = clamp(tierScale, 0.4, 1.4);
    for (const entry of this.lodEntries) this.applyLod(entry.material, this.lodScale);
    for (const entry of this.tierEntries) this.applyTiers(entry.material, this.tierScale);
  }

  private applyLod(material: ShaderMaterial, scale: number): void {
    const u = material.uniforms.uLodSwitch as { value: number } | undefined;
    const soft = material.uniforms.uLodSoft as { value: number } | undefined;
    const entry = this.lodEntries.find(e => e.material === material);
    if (!u || !entry) return;
    u.value = entry.base * scale;
    if (soft) soft.value = entry.softBase + (scale < 1 ? 4 : 0);
  }

  private applyTiers(material: ShaderMaterial, scale: number): void {
    const d = material.uniforms.uTierDists as { value: { x: number; y: number; z: number; w: number } } | undefined;
    const entry = this.tierEntries.find(e => e.material === material);
    if (!d || !entry) return;
    d.value.x = entry.base[0] * scale;
    d.value.y = entry.base[1] * scale;
    d.value.z = entry.base[2] * scale;
    d.value.w = entry.base[3];
  }

  get scale(): number {
    return this.lodScale;
  }
}
