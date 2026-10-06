/**
 * NECROFALL — the ONE shared sci-fi terrain material (visual rework plan §4–§7, §19–§21, §62).
 *
 * Every terrain pixel is classified from the SAME baked masks the rest of the planet reads
 * (`PlanetTerrainNodes` / `PlanetSurfaceData`):
 *
 *   tex1  R height01 · G grass · B wetness · A radiation
 *   tex2  R rock     · G biome · B puddle
 *
 * …and layered, cheapest-first, into the hand-painted look the plan asks for:
 *
 *   1. palette gradient (the shipped folio ramp, per plan §8 "keep the existing style")
 *   2. vegetation wash + the fixed grass-clump shadow (GrassField parity)
 *   3. elevation bands, broken up by large + medium noise so no horizontal line ever shows
 *   4. slope-based rock exposure from the fragment normal (plan §7)
 *   5. wetness darkening / cooling (plan §27)
 *   6. radiation tint + darkening + an emissive glow term (plan §4/§66)
 *   7. fine noise colour breakup (plan §62 micro detail)
 *   8. distance colour compression + a subtle atmospheric rim (plan §19–§21/§60)
 *
 * The material is created ONCE per planet and shared by the terrain mesh — no per-region
 * materials (plan §4/§43).
 */
import * as THREE from 'three/webgpu';
import { cameraPosition, color, dot, float, mix, normalWorld, normalize, positionLocal, positionWorld, smoothstep, texture, vec3, vec2 } from 'three/tsl';
import type { TerrainNodeBundle } from '../Environment/PlanetTerrainNodes';
import type { Noises } from '../Environment/Noises';
import { MeshDefaultMaterial } from './MeshDefaultMaterial';
import { ART_DIRECTION, SKY_PALETTE } from '../ArtDirection';
import { gradeAlbedo } from './CelShading';
import { RADIOACTIVE_PALETTE } from './PlanetPalette';
import {
  GRASS_PATCH_UV_SCALE,
  GRASS_SHADOW_DEPTH,
  GRASS_SHADOW_EDGE_HIGH,
  GRASS_SHADOW_EDGE_LOW,
} from '../Environment/GrassField';

export interface TerrainMaterialOptions {
  nodes: TerrainNodeBundle;
  noises: Noises;
}

/** Cave strata (plan §35): dark blue-teal rock the carved underground settles toward. */
const CAVE_STRATA = '#232c33';
const CAVE_STRATA_DEEP = '#101820';
/** Crystal light spilled on the cave floor (plan §34/§35 — environmental, never a flashlight). */
const CAVE_GLOW = 0.3;

export interface TerrainMaterialBundle {
  material: MeshDefaultMaterial;
  /** The lit albedo BEFORE the atmosphere pass — reused by the lawn-glow term. */
  albedoNode: any;
}

export function createTerrainMaterial(options: TerrainMaterialOptions): TerrainMaterialBundle {
  const { nodes, noises } = options;
  const gradientTexture = nodes.gradientTexture;

  const direction = normalize(positionLocal) as any;
  const terrainData = nodes.terrainNode(positionLocal);
  const data2 = nodes.data2Node(positionLocal);

  // ---- mask channels (the ONE shared terrain field)
  const height01 = terrainData.x;
  const grass = terrainData.y;
  const wetness = terrainData.z;
  const radiation = terrainData.a;
  const rock = data2.x;
  // Cave mask (plan §35): 0 open ground → 1 the carved underground (saturated 6 m below the rim).
  const cave = data2.w;

  // ---- three noise octaves of breakup (plan §5/§62): broad biome patches, medium colour
  // breakup, fine material variation.
  const largeNoise = texture(noises.patch, (direction.xz as any).mul(1.15)).r as any;
  const mediumNoise = texture(noises.perlin, (direction.xz as any).mul(6.0)).r as any;
  const fineNoise = texture(noises.perlin, (direction.xz as any).mul(26.0)).r as any;

  // ---- elevation bands (plan §6), blended through the noise so they read as terrain, not lines
  const bandedHeight = height01
    .add(largeNoise.sub(0.5).mul(0.09))
    .add(mediumNoise.sub(0.5).mul(0.03));
  const lowBand = smoothstep(0.16, 0.30, bandedHeight).oneMinus(); // dark wet soil pockets
  const midBand = smoothstep(0.40, 0.58, bandedHeight); // dry grass / exposed rock
  const highBand = smoothstep(0.60, 0.76, bandedHeight); // rock
  const peakBand = smoothstep(0.78, 0.90, bandedHeight); // pale exposed rock

  const albedo = (() => {
    // 1 — palette gradient (bottom of the ramp = 1 - height01, folio parity)
    const gradient = texture(gradientTexture, vec2(0, height01.oneMinus())) as any;
    let result: any = gradient.rgb;

    // 2 — vegetation wash + the fixed grass-clump shadow, EXACTLY the shipped samples/thresholds
    const grassBlend = mix(color(RADIOACTIVE_PALETTE.grass), color(RADIOACTIVE_PALETTE.grassDark), radiation.mul(0.6));
    result = mix(result, grassBlend, grass);
    const patchNoise = texture(noises.patch, (direction.xz as any).mul(GRASS_PATCH_UV_SCALE)).r as any;
    const clumpShade = smoothstep(GRASS_SHADOW_EDGE_LOW, GRASS_SHADOW_EDGE_HIGH, patchNoise);
    result = result.mul(mix(float(1), float(GRASS_SHADOW_DEPTH), clumpShade));

    // 3 — elevation bands (muted, noise-weighted so they never band visibly)
    result = mix(result, color(RADIOACTIVE_PALETTE.soilDark), lowBand.mul(0.45).mul(mediumNoise.mul(0.4).add(0.8)));
    result = mix(result, color(RADIOACTIVE_PALETTE.soil), midBand.mul(0.30));
    result = mix(result, color(RADIOACTIVE_PALETTE.rock), highBand.mul(0.5).mul(rock.mul(0.5).add(0.75)));
    result = mix(result, color(RADIOACTIVE_PALETTE.rockLight), peakBand.mul(0.55));

    // 4 — slope-based rock exposure (plan §7): steep faces lose colour and become rock
    const slope = float(1).sub(normalWorld.dot(direction)).clamp(0, 1);
    const steep = smoothstep(0.34, 0.72, slope);
    result = mix(result, color(RADIOACTIVE_PALETTE.rockDark), steep.mul(0.5).mul(fineNoise.mul(0.35).add(0.85)));

    // 5 — wet ground is darker, slightly cooler and smoother (plan §27)
    const wetTint = mix(color(RADIOACTIVE_PALETTE.waterDark), color(RADIOACTIVE_PALETTE.water), mediumNoise);
    result = mix(result, wetTint, wetness.mul(0.34));

    // 6 — radiation: darken + alien cyan/green tint (plan §4/§66 — never a flat green wash)
    const contamination = mix(color(SKY_PALETTE.haze), color(RADIOACTIVE_PALETTE.radioactive3), mediumNoise);
    result = mix(result, contamination, radiation.mul(0.30));
    result = result.mul(float(1).sub(radiation.mul(0.22)));

    // 7 — fine material breakup (plan §62) + the global muted/contrast grade (plan §2)
    result = result.mul(fineNoise.mul(0.14).add(0.93));

    // 7b — CAVES (plan §35): strata darken toward the cave rock colour, the vegetation wash
    // drops out, and the floor keeps only the fine rock breakup. The tint is the shared
    // contaminated-teal family so every cave still reads as THIS planet.
    const caveRock = mix(color(CAVE_STRATA), color(CAVE_STRATA_DEEP), cave);
    result = mix(result, caveRock, cave.mul(0.78));
    const caveStrata = smoothstep(0.15, 0.55, fineNoise.add(mediumNoise.mul(0.6)));
    result = result.mul(float(1).sub(cave.mul(caveStrata).mul(0.22)));
    return gradeAlbedo(result, ART_DIRECTION.terrain.saturation, ART_DIRECTION.terrain.contrast) as any;
  })();

  // ---- atmosphere (plan §19–§21/§60): distance colour compression + a subtle rim. Applied
  // AFTER the albedo so the lawn-glow term keeps reading the un-hazed ground colour.
  const base = (() => {
    const toCamera = (cameraPosition as any).sub(positionWorld);
    const distance = toCamera.length();
    const viewDirection = toCamera.div(distance.max(1e-3));
    const horizon = color(SKY_PALETTE.horizon);

    // Distance compresses the image: desaturate, then tint toward the atmosphere colour.
    const haze = smoothstep(ART_DIRECTION.atmosphere.hazeStart, ART_DIRECTION.atmosphere.hazeEnd, distance).mul(
      ART_DIRECTION.atmosphere.hazeStrength,
    );
    const luma = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
    const compressed = mix(vec3(luma, luma, luma), horizon, float(0.55));
    let result: any = mix(albedo, compressed, haze);

    // Atmospheric rim (plan §20): grazing-angle faces catch a faint scattering lift — gated to
    // mid/far distances so nothing within arm's reach glows. The `max(1e-4)` guard is the
    // project's own rule: `pow(0, x)` evaluates to NaN on some WebGPU/D3D drivers and the bloom
    // blur then smears the NaN over the whole frame (see Grass.ts for the original report).
    const rim = float(1)
      .sub(viewDirection.dot(normalWorld).abs())
      .max(0.0001)
      .pow(ART_DIRECTION.atmosphere.horizonFalloff);
    const rimReach = smoothstep(18, 110, distance);
    result = result.add(horizon.mul(rim.mul(ART_DIRECTION.atmosphere.rimStrength).mul(rimReach)));
    return result;
  })();

  const material = new MeshDefaultMaterial({
    colorNode: base as any,
    lawnGlowData: terrainData,
    lawnGlowColor: albedo as any,
    // A convex planet constantly presents far-slope BACKFACES to a low camera;
    // single-sided terrain left see-through voids wherever grass didn't cover.
    side: THREE.DoubleSide,
    hasCoreShadows: true,
    hasDropShadows: true,
    hasLightBounce: false,
    hasFog: true,
    // The terrain carries the plan §2 band ladder; every other environment surface shades with
    // the plain cel bands (and the plan's 80 % muted rule holds because their albedos already sit
    // in the muted palette).
    bandTint: { ...ART_DIRECTION.terrain },
    // Radioactive ground glows: the shader's radiation mask feeds the material glow term (plan §4).
    glowNode: radiation
      .mul(radiation)
      .mul(ART_DIRECTION.radiation.terrainGlow)
      .mul(mix(color(RADIOACTIVE_PALETTE.radioactive3), color(RADIOACTIVE_PALETTE.radioactive2), mediumNoise))
      // Cave floors catch the crystal light (plan §34/§35): the glow is strongest where the
      // carve is deep and where the noise reads as a crystal bed — environmental, not a lamp.
      .add(
        cave
          .mul(cave)
          .mul(CAVE_GLOW)
          .mul(smoothstep(0.35, 0.8, mediumNoise))
          .mul(mix(color(RADIOACTIVE_PALETTE.radioactive3), color(RADIOACTIVE_PALETTE.waterLight), fineNoise)),
      ),
  });

  return { material, albedoNode: albedo };
}
