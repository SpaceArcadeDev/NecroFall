/**
 * NECROFALL — placement pipeline (plan §57/§58/§65).
 *
 * seed → direction → terrain sample → biome/slope/water filters → tangent
 * yaw → scale → aligned matrix. Runs at LOAD time only; nothing here is ever
 * called from an update loop.
 */
import * as THREE from 'three/webgpu';
import type { PlanetSurface, SurfaceSample } from './PlanetSurface';
import type { PlanetGenerator } from './PlanetGenerator';
import { createSurfaceSample } from './PlanetSurface';

export interface Placement {
  /** Terrain-aligned world matrix (object local +Y = surface normal). */
  matrix: THREE.Matrix4;
  position: THREE.Vector3;
  normal: THREE.Vector3;
  scale: number;
  yaw: number;
  grass: number;
  slope: number;
  radiation: number;
  wetness: number;
  height: number;
}

export interface PlacementFilters {
  minSlope?: number;
  maxSlope?: number;
  minGrass?: number;
  maxGrass?: number;
  /** Minimum metres above the waterline (negative allows shoreline). */
  aboveWater?: number;
  maxRadiation?: number;
  minRadiation?: number;
  /** Extra predicate for gameplay-defined exclusion zones. */
  accept?: (sample: SurfaceSample) => boolean;
}

export interface ScatterOptions extends PlacementFilters {
  count: number;
  salt: number;
  scaleMin?: number;
  scaleMax?: number;
  /** Sink fraction of the instance scale (plan §75/§76: roots below the surface). */
  sinkFactor?: number;
  /** Tries per wanted instance. */
  attemptsPerInstance?: number;
  /** Keep a clearing around this direction (e.g. the player spawn). */
  excludeDirection?: THREE.Vector3;
  /** Clearing radius in metres. */
  excludeRadius?: number;
}

/**
 * Plan §57 filter block — biome mask is emulated by the accept() predicate +
 * radiation/grass windows; slope and water are first-class.
 */
export function canPlace(sample: SurfaceSample, filters: PlacementFilters, waterHeight: number): boolean {
  if (filters.minSlope !== undefined && sample.slope < filters.minSlope) return false;
  if (filters.maxSlope !== undefined && sample.slope > filters.maxSlope) return false;
  if (filters.minGrass !== undefined && sample.grass < filters.minGrass) return false;
  if (filters.maxGrass !== undefined && sample.grass > filters.maxGrass) return false;
  if (filters.minRadiation !== undefined && sample.radiation < filters.minRadiation) return false;
  if (filters.maxRadiation !== undefined && sample.radiation > filters.maxRadiation) return false;
  const aboveWater = sample.height - waterHeight;
  if (filters.aboveWater !== undefined && aboveWater < filters.aboveWater) return false;
  if (filters.accept && !filters.accept(sample)) return false;
  return true;
}

const dummy = new THREE.Object3D();

export function scatterPlacements(
  surface: PlanetSurface,
  generator: PlanetGenerator,
  options: ScatterOptions,
): Placement[] {
  const random = generator.rand(options.salt);
  const sample = createSurfaceSample();
  const placements: Placement[] = [];
  const attempts = options.count * (options.attemptsPerInstance ?? 6);
  const waterHeight = surface.waterLevel - surface.radius;
  const scaleMin = options.scaleMin ?? 1;
  const scaleMax = options.scaleMax ?? scaleMin;
  const excludeCosine = options.excludeDirection && options.excludeRadius !== undefined
    ? Math.cos(options.excludeRadius / surface.radius)
    : null;

  for (let i = 0; i < attempts && placements.length < options.count; i++) {
    surface.randomSample(random, sample);
    if (!canPlace(sample, options, waterHeight)) continue;
    if (excludeCosine !== null && sample.up.dot(options.excludeDirection!) > excludeCosine) continue;

    const scale = scaleMin + random() * (scaleMax - scaleMin);
    const yaw = random() * Math.PI * 2;
    const sink = (options.sinkFactor ?? 0) * scale;

    surface.alignToSurface(dummy, sample, yaw, scale, sink);
    dummy.updateMatrix();

    placements.push({
      matrix: dummy.matrix.clone(),
      position: sample.point.clone(),
      normal: sample.normal.clone(),
      scale,
      yaw,
      grass: sample.grass,
      slope: sample.slope,
      radiation: sample.radiation,
      wetness: sample.wetness,
      height: sample.height,
    });
  }

  return placements;
}
