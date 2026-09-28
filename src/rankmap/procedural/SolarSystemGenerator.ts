// NECROFALL — solar system generation (plan §8). Each galaxy contains
// `systemCount` deterministic systems laid out on a golden-angle spiral so the
// map reads as a real cluster, never a grid.
import { SystemDescriptor, SYSTEM_DESIGNATIONS } from './GalaxyTypes';
import { hash32, rng } from './SeedHash';
import { galaxyName } from './GalaxyGenerator';

export function systemAt(universeSeed: number, ring: number, galaxyId: number, systemId: number): SystemDescriptor {
  const seed = hash32(universeSeed >>> 0, 'system', ring, galaxyId, systemId);
  const r = rng(seed);
  // Golden-angle spiral: even coverage, organic feel, fully deterministic.
  const angle = systemId * 2.399963 + r() * 0.5;
  const radius = systemId === 0 ? 0 : Math.sqrt((systemId + 0.6) / 12) * 0.92;
  const base = galaxyName(hash32(universeSeed >>> 0, 'galaxy', ring, galaxyId));
  const designation = SYSTEM_DESIGNATIONS[Math.floor(r() * SYSTEM_DESIGNATIONS.length)];
  return {
    ring,
    galaxyId,
    systemId,
    seed,
    name: systemId === 0 ? `${base} PRIME` : `${base} ${designation}`,
    planetCount: 0, // filled by PlanetGenerator via systemPlanetCount()
    ux: 0.5 + Math.cos(angle) * radius,
    uy: 0.5 + Math.sin(angle) * radius,
  };
}

/** Planets per system: 1–12, ring-scaled (plan §8). */
export function systemPlanetCount(universeSeed: number, ring: number, galaxyId: number, systemId: number): number {
  const r = rng(hash32(universeSeed >>> 0, 'planets', ring, galaxyId, systemId));
  const cfgMin = 1;
  const cfgMax = 12;
  return cfgMin + Math.floor(r() * (cfgMax - cfgMin + 1));
}

/** All systems of a galaxy. */
export function systemsInGalaxy(universeSeed: number, ring: number, galaxyId: number, systemCount: number): SystemDescriptor[] {
  const out: SystemDescriptor[] = [];
  for (let s = 0; s < systemCount; s++) out.push(systemAt(universeSeed, ring, galaxyId, s));
  return out;
}
