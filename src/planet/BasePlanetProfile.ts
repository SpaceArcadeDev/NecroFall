import { BASE_PLANETS, type BasePlanet } from '../concepts/definitions';
import { Color } from 'three/webgpu';
import { Rand, clamp } from '../utils/Utils';
import type { BiomeClass, PlanetArchetype, PlanetClimate } from '../world/PlanetArchetypes';

const CLIMATES: readonly { biome: BiomeClass; temperature: number; moisture: number; corruption: number }[] = [
  { biome: 'TOXIC', temperature: 0.6, moisture: 0.65, corruption: 0.45 },
  { biome: 'OCEAN', temperature: 0.52, moisture: 0.9, corruption: 0.3 },
  { biome: 'DESERT', temperature: 0.91, moisture: 0.18, corruption: 0.35 },
  { biome: 'FUNGAL', temperature: 0.43, moisture: 0.82, corruption: 0.7 },
  { biome: 'FROZEN', temperature: 0.13, moisture: 0.55, corruption: 0.3 },
  { biome: 'JUNGLE', temperature: 0.72, moisture: 0.85, corruption: 0.35 },
  { biome: 'VOLCANIC', temperature: 0.98, moisture: 0.17, corruption: 0.8 },
  { biome: 'CRYSTAL', temperature: 0.38, moisture: 0.2, corruption: 0.4 },
  { biome: 'CORRUPTED', temperature: 0.45, moisture: 0.55, corruption: 0.55 },
  { biome: 'JUNGLE', temperature: 0.55, moisture: 0.65, corruption: 0.2 },
];

export function basePlanetIndex(seed: number): number {
  return Math.floor(new Rand((seed ^ 0x73ac941d) >>> 0).next() * BASE_PLANETS.length);
}

export function basePlanetForSeed(seed: number): BasePlanet {
  return BASE_PLANETS[basePlanetIndex(seed)];
}

export function classicPlanetSeed(matchSeed: number): number {
  return Math.imul(matchSeed >>> 0, 2654435761) >>> 0;
}

export function rollClassicMatchSeed(previousPlanetSeed?: number, random: () => number = Math.random): number {
  const previous = previousPlanetSeed === undefined ? -1 : basePlanetIndex(previousPlanetSeed);
  let candidate = 0;
  for (let attempt = 0; attempt < 32; attempt++) {
    candidate = Math.floor(random() * 0x100000000) >>> 0;
    if (basePlanetIndex(classicPlanetSeed(candidate)) !== previous) return candidate;
  }
  do { candidate = (candidate + 1) >>> 0; } while (basePlanetIndex(classicPlanetSeed(candidate)) === previous);
  return candidate;
}

export function basePlanetVariant(seed: number): BasePlanet {
  const base = basePlanetForSeed(seed);
  const random = new Rand((seed ^ 0x613af2b7) >>> 0);
  const hue = random.range(-0.018, 0.018), saturation = random.range(-0.045, 0.025), lightness = random.range(-0.02, 0.025);
  const tint = (value: string) => `#${new Color(value).offsetHSL(hue, saturation, lightness).getHexString()}`;
  return { ...base, waterSurface: base.waterSurface ?? 'liquid', seed: seed >>> 0, ground: tint(base.ground), highland: tint(base.highland), rock: tint(base.rock),
    foliage: tint(base.foliage), foliageLight: tint(base.foliageLight), water: tint(base.water), infection: tint(base.infection),
    sky: tint(base.sky), horizon: tint(base.horizon) };
}

export function baseTerrainParameters(seed: number): Partial<PlanetArchetype> {
  const base = basePlanetForSeed(seed);
  switch (base.id) {
    case 'cinderbloom': return { continentBias: 0.12, mountainPower: 0.85, canyonDepth: 4.5, riverCount: 2, sinkholeCount: 0, roughness: 0.7, plantDensity: 1.2 };
    case 'glass-tide': return { continentBias: -0.5, mountainPower: 0.7, riverCount: 0, roughness: 0.65, plantDensity: 0.8 };
    case 'saffron-waste': return { continentBias: 0.36, plateauLift: 5, mountainPower: 0.6, roughness: 0.7, plantDensity: 0.4 };
    case 'mycelial-night': return { continentBias: -0.1, mountainPower: 0.55, riverCount: 3, canyonDepth: 3, plantDensity: 1.3 };
    case 'frostwound': return { ridgeSharpness: 3.2, mountainPower: 1.15, roughness: 0.65, plantDensity: 0.55 };
    case 'verdant-tempest': return { continentBias: 0.2, canyonDepth: 6, riverCount: 4, riverDepth: 3.5, plantDensity: 1.6 };
    case 'emberwake': return { continentBias: 0.2, craterCount: 6, craterDepth: 6, roughness: 0.9, riverCount: 0, plantDensity: 0.35 };
    case 'roseshard-basin': return { continentBias: -0.15, plateauLift: 1.4, mountainPower: 0.35, canyonDepth: 2, roughness: 0.5, riverCount: 0, plantDensity: 0.45 };
    case 'stormglass-reach': return { continentBias: 0.25, plateauLift: 5, canyonDepth: 6, valleyDepth: 5.5, mountainPower: 1.05, plantDensity: 0.6 };
    case 'aether-garden': return { continentBias: 0.4, plateauLift: 7, mountainPower: 0.8, riverCount: 0, roughness: 0.65, plantDensity: 1.1 };
    default: return {};
  }
}

export function basePlanetClimate(seed: number, ring = 0): PlanetClimate {
  const preset = CLIMATES[basePlanetIndex(seed)];
  const random = new Rand((seed ^ 0x5f356495) >>> 0);
  return {
    temperature: clamp(preset.temperature + random.range(-0.07, 0.07), 0, 1),
    moisture: clamp(preset.moisture + random.range(-0.09, 0.09), 0, 1),
    corruption: clamp(preset.corruption + random.range(-0.12, 0.12) + ring * 0.025, 0, 1),
    biome: preset.biome,
  };
}