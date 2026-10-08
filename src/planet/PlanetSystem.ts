import { Vector3 } from 'three/webgpu';
import { systemAt, systemPlanetCount } from '../rankmap/procedural/SolarSystemGenerator';
import { planetAt } from '../rankmap/procedural/PlanetGenerator';
import { galaxyAt } from '../rankmap/procedural/GalaxyGenerator';
import { decodeGalaxyId, DEFAULT_UNIVERSE_SEED, encodeGalaxyId, parsePlanetKey, ringCenterRadius } from '../rankmap/procedural/SeedHash';
import type { PlanetDescriptor, SystemDescriptor } from '../rankmap/procedural/GalaxyTypes';
import { basePlanetClimate, basePlanetForSeed } from './BasePlanetProfile';

export interface PlanetSystemContext { planetKey?: string; universeSeed?: number }
export interface SystemBody { descriptor: PlanetDescriptor; position: Vector3; radius: number }
export interface PlanetSystem {
  descriptor: SystemDescriptor;
  bodies: SystemBody[];
  active: SystemBody;
  sunPosition: Vector3;
  sunDirection: Vector3;
  sunColor: string;
  sunRadius: number;
}

export function createPlanetSystem(seed: number, radius: number, ring = 0, context: PlanetSystemContext = {}): PlanetSystem {
  const parsed = context.planetKey ? parsePlanetKey(context.planetKey) : null;
  const universe = parsed ? context.universeSeed ?? DEFAULT_UNIVERSE_SEED : seed >>> 0;
  const galaxyId = parsed?.galaxyId ?? encodeGalaxyId(Math.floor(ringCenterRadius(ring)), 0);
  const systemId = parsed?.systemId ?? (seed >>> 0) % 97;
  const systemRing = parsed?.ring ?? ring;
  const descriptor = systemAt(universe, systemRing, galaxyId, systemId);
  const count = systemPlanetCount(universe, systemRing, galaxyId, systemId);
  const activeIndex = parsed?.planetId ?? 0;
  if (!Number.isInteger(activeIndex) || activeIndex < 0 || activeIndex >= count) throw new Error('Planet is outside its generated solar system');
  const scale = radius * 58;
  const bodies = Array.from({ length: count }, (_, index): SystemBody => {
    const planet = planetAt(universe, systemRing, galaxyId, systemId, index);
    if (!parsed && index === activeIndex) {
      const base = basePlanetForSeed(seed);
      planet.seed = seed >>> 0; planet.key = `procedural:${seed >>> 0}:0`;
      planet.name = `${base.name} Prime`; planet.biome = basePlanetClimate(seed, ring).biome;
      planet.biomeLabel = base.name; planet.biomeColor = base.ground;
    }
    const distance = planet.orbitRadius * scale;
    const position = new Vector3(Math.cos(planet.orbit) * distance, Math.sin(planet.orbit + index * 0.8) * distance * 0.035, Math.sin(planet.orbit) * distance);
    return { descriptor: planet, position, radius: index === activeIndex ? radius : radius * (0.75 + planet.radius * 0.25) };
  });
  const active = bodies[activeIndex];
  const coordinate = decodeGalaxyId(galaxyId);
  const galaxy = galaxyAt(universe, coordinate.gx, coordinate.gy);
  const sunPosition = new Vector3();
  return { descriptor: { ...descriptor, planetCount: count }, bodies, active, sunPosition,
    sunDirection: sunPosition.clone().sub(active.position).normalize(), sunColor: galaxy?.starColor ?? '#ffe8bb', sunRadius: radius * 1.8 };
}