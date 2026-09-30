// NECROFALL — PlanetSurfaceData (plan §63, §64): the packed terrain-data contract shared by the
// CPU bakers and the GPU shaders.
//
// The convention (one 4-channel lane per vertex/instance, matching the TSL attribute contract in
// PlanetTerrainNodes.ts):
//
//   x = slope            0..1      (0 = flat)
//   y = height01         0..1      (relief band position)
//   z = moisture         0..1      (wetness / ground classification)
//   w = corruption       0..1      (radiation / necrotic contamination, biomes included)
//
// A second optional lane (vegetation density) travels separately as a single float — grass,
// rocks, spikes, crystals and trees all read the SAME lanes at their own position, which is what
// makes the world read as one surface. Do not add ten independent textures for convenience.
import type { TerrainDataTuple } from '../world/vegetation/VegetationTypes';

/** The channel names, in packing order — for debug readouts and documentation. */
export const TERRAIN_CHANNELS = ['slope', 'height01', 'moisture', 'corruption'] as const;

export interface TerrainSampleChannels {
  slope: number;
  height01: number;
  moisture: number;
  corruption: number;
}

/** Unpack a shader-lane tuple into named fields. */
export function unpackTerrainData(data: TerrainDataTuple, out: TerrainSampleChannels): TerrainSampleChannels {
  out.slope = data[0];
  out.height01 = data[1];
  out.moisture = data[2];
  out.corruption = data[3];
  return out;
}

/** Pack named fields into a shader-lane tuple. */
export function packTerrainData(sample: TerrainSampleChannels): TerrainDataTuple {
  return [sample.slope, sample.height01, sample.moisture, sample.corruption];
}
