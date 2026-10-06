// NECROFALL — GEOLOGICAL FORMATION PLANNER (complete rework, phases 9/10/12/61/62).
//
// The world's authored-composition pass. Instead of scattering yet more individual rocks, the
// planet gets a small number of FORMATIONS — rock families, boulder fields, stone rings, spire
// fields, cliff lines and crystal beds — plus a handful of sci-fi sites (one crashed colony
// ship, a landing pad, a ruined antenna, an energy relay). Each is deterministic from the seed,
// placed by the plan's composition rules (away from spawn, off cave mouths, off landmark
// footprints) and composed from the shared low-poly asset library.
import * as THREE from 'three/webgpu';
import { Rand } from '../../utils/Utils';
import type { Landmark } from '../LandmarkGenerator';
import type { PlanetCave } from '../caves/CaveGenerator';

export type FormationType = 'ROCK_CLUSTER' | 'BOULDER_FIELD' | 'STONE_RING' | 'SPIRE_FIELD' | 'CLIFF_LINE' | 'CRYSTAL_FIELD';

export interface Formation {
  id: number;
  type: FormationType;
  dir: THREE.Vector3;
  /** Site radius in metres (props live inside it). */
  radius: number;
  /** Deterministic prop-count band (low + roll * (high - low)). */
  count: number;
  seed: number;
}

export type SciFiSiteType = 'CRASHED_SHIP' | 'LANDING_PAD' | 'RUINED_ANTENNA' | 'ENERGY_RELAY';

export interface SciFiSite {
  id: number;
  type: SciFiSiteType;
  dir: THREE.Vector3;
  radius: number;
  /** True for the ONE hero-scale site (the crashed ship) — it gets an outline + debris field. */
  major: boolean;
  seed: number;
}

/** 12 formations: every family twice (plan §9's asset library, composed not scattered). */
const FORMATION_PLAN: FormationType[] = [
  'ROCK_CLUSTER',
  'BOULDER_FIELD',
  'SPIRE_FIELD',
  'STONE_RING',
  'CLIFF_LINE',
  'CRYSTAL_FIELD',
  'ROCK_CLUSTER',
  'BOULDER_FIELD',
  'SPIRE_FIELD',
  'STONE_RING',
  'CLIFF_LINE',
  'CRYSTAL_FIELD',
];

const FORMATION_RADIUS: Record<FormationType, [number, number]> = {
  ROCK_CLUSTER: [4, 7],
  BOULDER_FIELD: [9, 14],
  STONE_RING: [6, 10],
  SPIRE_FIELD: [7, 12],
  CLIFF_LINE: [16, 26],
  CRYSTAL_FIELD: [8, 14],
};

/** Minimum angular gap between two sites (metres of arc / planet radius). */
const MIN_GAP_RADIANS = 0.24;

function angleBetween(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
}

/**
 * Deterministic formations for a planet. `spawnDirection` keeps the arena clear, cave footprints
 * and landmark cores are respected, and every site is separated from the next.
 */
export function generateFormations(
  seed: number,
  planetRadius: number,
  caves: readonly PlanetCave[],
  landmarks: readonly Landmark[],
  spawnDirection?: THREE.Vector3 | null,
): Formation[] {
  const rng = new Rand((seed ^ 0x27d4eb2f) >>> 0);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Formation[] = [];
  const spawnClear = 14 / planetRadius;

  const blocked = (candidate: THREE.Vector3, radiusMetres: number): boolean => {
    if (spawnDirection && angleBetween(candidate, spawnDirection) < spawnClear + radiusMetres / planetRadius) return true;
    const reach = radiusMetres / planetRadius;
    for (const cave of caves) {
      if (angleBetween(candidate, cave.dir) < cave.radius * 1.3 + reach) return true;
    }
    for (const lm of landmarks) {
      if (angleBetween(candidate, lm.dir) < lm.radius * 0.72 + reach * 0.4) return true;
    }
    for (const existing of out) {
      if (angleBetween(candidate, existing.dir) < MIN_GAP_RADIANS + (existing.radius + radiusMetres) / planetRadius) return true;
    }
    return false;
  };

  for (let i = 0; i < FORMATION_PLAN.length; i++) {
    const type = FORMATION_PLAN[i];
    const [minR, maxR] = FORMATION_RADIUS[type];
    let placed: Formation | null = null;
    for (let attempt = 0; attempt < 40 && !placed; attempt++) {
      const step = i * 1.31 + attempt * 0.29;
      const y = 1 - (2 * step + 1) / (FORMATION_PLAN.length + 1);
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const a = golden * step + rng.range(-0.3, 0.3);
      const candidate = new THREE.Vector3(Math.cos(a) * r, y + rng.range(-0.1, 0.1), Math.sin(a) * r).normalize();
      const radius = minR + rng.next() * (maxR - minR);
      if (blocked(candidate, radius)) continue;
      placed = {
        id: i,
        type,
        dir: candidate,
        radius,
        count: Math.round(5 + rng.next() * 8),
        seed: (seed ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0,
      };
    }
    if (placed) out.push(placed);
  }

  return out;
}

/**
 * Sci-fi sites (plan §61/§62): the ONE crashed colony ship plus three smaller structures. The
 * ship prefers a COLONY_WRECK landmark (the story lands where the map says it did).
 */
export function generateSciFiSites(
  seed: number,
  planetRadius: number,
  landmarks: readonly Landmark[],
  spawnDirection?: THREE.Vector3 | null,
): SciFiSite[] {
  const rng = new Rand((seed ^ 0x165667b1) >>> 0);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: SciFiSite[] = [];
  const spawnClear = 18 / planetRadius;

  const wreck = landmarks.find((lm) => lm.type === 'COLONY_WRECK');

  // ---- the crashed ship (major): the wreck landmark keeps it, else a far, open spot.
  let shipDir: THREE.Vector3;
  if (wreck) {
    const axis = new THREE.Vector3(wreck.dir.z, 0.3, -wreck.dir.x).normalize().cross(wreck.dir).normalize();
    shipDir = wreck.dir.clone().applyAxisAngle(axis, wreck.radius * 0.42).normalize();
  } else {
    let candidate: THREE.Vector3 | null = null;
    for (let attempt = 0; attempt < 40 && !candidate; attempt++) {
      const step = 2 + attempt * 0.41;
      const y = 1 - (2 * step + 1) / 14;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const a = golden * step + rng.range(-0.4, 0.4);
      const c = new THREE.Vector3(Math.cos(a) * r, y + rng.range(-0.1, 0.1), Math.sin(a) * r).normalize();
      if (spawnDirection && angleBetween(c, spawnDirection) < 0.5) continue;
      if (landmarks.some((lm) => angleBetween(c, lm.dir) < lm.radius * 0.8)) continue;
      candidate = c;
    }
    shipDir = candidate ?? new THREE.Vector3(0.2, 0.7, -0.6).normalize();
  }
  out.push({ id: 0, type: 'CRASHED_SHIP', dir: shipDir, radius: 16, major: true, seed: (seed ^ 0x51ab77) >>> 0 });

  // ---- three small structures (plan §61), spread away from spawn + each other.
  const small: SciFiSiteType[] = ['LANDING_PAD', 'RUINED_ANTENNA', 'ENERGY_RELAY'];
  for (let i = 0; i < small.length; i++) {
    const type = small[i];
    const radius = type === 'LANDING_PAD' ? 9 : 7;
    let placed: SciFiSite | null = null;
    for (let attempt = 0; attempt < 40 && !placed; attempt++) {
      const step = i * 2.11 + attempt * 0.33;
      const y = 1 - (2 * step + 1) / (small.length + 2);
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const a = golden * step + rng.range(-0.35, 0.35);
      const candidate = new THREE.Vector3(Math.cos(a) * r, y + rng.range(-0.1, 0.1), Math.sin(a) * r).normalize();
      // Small structures may sit NEAR the arena (the player should see sci-fi early) but never
      // in the spawn clearing itself.
      if (spawnDirection && angleBetween(candidate, spawnDirection) < spawnClear) continue;
      if (landmarks.some((lm) => angleBetween(candidate, lm.dir) < lm.radius * 0.6)) continue;
      if (out.some((site) => angleBetween(candidate, site.dir) < 0.3)) continue;
      placed = { id: i + 1, type, dir: candidate, radius, major: false, seed: (seed ^ Math.imul(i + 3, 0xc2b2ae35)) >>> 0 };
    }
    if (placed) out.push(placed);
  }

  return out;
}
