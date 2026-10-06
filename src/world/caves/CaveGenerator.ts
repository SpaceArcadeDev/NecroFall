// NECROFALL — CAVE GENERATOR (complete visual + terrain + underground rework, phases 28/35/38).
//
// Every planet gets 4–8 deterministic caves: 3 small (one chamber pocket), 2 medium (chamber +
// side branch) and 1 large MAJOR underground landmark (two chambers joined by a tunnel). A cave
// is a node GRAPH — entrance ledge → descending tunnel nodes → chamber(s) — that the height
// field carves as a stepped, anisotropic basin (see `TerrainGenerator`), so the same walkable
// floor the player sees is the same floor collision answers with. No second collision layer is
// invented: the carve IS the cave (plan §24 "ONE authoritative surface query").
//
// Placement follows the plan §12 composition rules: caves prefer points of interest — a crystal
// canyon keeps a crystal cave, a colony wreck keeps the ruin cave — and otherwise spread on a
// jittered golden-angle spiral with a guaranteed minimum separation. Nothing is random-anywhere.
import * as THREE from 'three/webgpu';
import { Rand } from '../../utils/Utils';
import { mulberry32 } from '../../planet/PlanetSeed';
import type { EnemyBias, Landmark } from '../LandmarkGenerator';
import type { BiomeClass } from '../PlanetArchetypes';

export type CaveType = 'CRYSTAL_CAVES' | 'RADIOACTIVE_CAVERNS' | 'NECROPHAGE_NEST' | 'ROOT_CAVES' | 'ANCIENT_RUINS';

export type CaveSize = 'small' | 'medium' | 'large';

export interface CavePalette {
  /** Dark strata the terrain rock reads inside the footprint (plan §35 rock colour). */
  rock: number;
  /** Emissive crystal shard colour. */
  crystal: number;
  /** Second crystal tone (edge glow). */
  crystalEdge: number;
  /** Glow flora / mote colour. */
  glow: number;
  /** Underground fog + core-shadow tint. */
  fog: number;
}

export interface CaveNode {
  id: number;
  /** Unit direction of the node centre. */
  dir: THREE.Vector3;
  /** Collision/carve radius in radians. */
  radius: number;
  /** Carve depth at the node centre, metres below the local surface. */
  depth: number;
  /** True for chamber nodes (larger, flatter floor). */
  chamber: boolean;
  parent: number | null;
  /** Anisotropy axes: the carve warp makes every chamber a warped ellipse, never a circle. */
  axis: THREE.Vector3;
  axis2: THREE.Vector3;
}

export interface PlanetCave {
  id: number;
  type: CaveType;
  size: CaveSize;
  label: string;
  /** The ONE major underground landmark of the planet (plan §38). */
  major: boolean;
  /** Entrance centre direction. */
  dir: THREE.Vector3;
  /** Footprint angular radius (includes node offsets) — the shader mask + prefilters use this. */
  radius: number;
  /** Deepest carve, metres below the base surface. */
  depth: number;
  nodes: CaveNode[];
  palette: CavePalette;
  /** Ecology bias the underground spawner reads (plan §36/§70). */
  bias: EnemyBias;
  seed: number;
}

export const CAVE_PALETTES: Record<CaveType, CavePalette> = {
  CRYSTAL_CAVES: { rock: 0x27333d, crystal: 0x36f5ff, crystalEdge: 0x9dfcff, glow: 0x7dff46, fog: 0x071c24 },
  RADIOACTIVE_CAVERNS: { rock: 0x2b3323, crystal: 0x7dff46, crystalEdge: 0xd8ff8a, glow: 0xb6ff54, fog: 0x0e1a0a },
  NECROPHAGE_NEST: { rock: 0x2a151c, crystal: 0xff2148, crystalEdge: 0xff7a90, glow: 0xff5a3d, fog: 0x180508 },
  ROOT_CAVES: { rock: 0x2c2f1d, crystal: 0xffd76a, crystalEdge: 0xffeeb0, glow: 0xa8e06a, fog: 0x10140a },
  ANCIENT_RUINS: { rock: 0x2d323c, crystal: 0x7fd8ff, crystalEdge: 0xc6ecff, glow: 0x4fdcff, fog: 0x070d15 },
};

const LABELS: Record<CaveType, string> = {
  CRYSTAL_CAVES: 'CRYSTAL CAVERN',
  RADIOACTIVE_CAVERNS: 'RADIOACTIVE CAVERN',
  NECROPHAGE_NEST: 'NECROPHAGE BURROW',
  ROOT_CAVES: 'ROOT CAVERN',
  ANCIENT_RUINS: 'BURIED RUINS',
};

const BIAS: Record<CaveType, EnemyBias> = {
  CRYSTAL_CAVES: 'RANGED',
  RADIOACTIVE_CAVERNS: 'VENOM',
  NECROPHAGE_NEST: 'SWARM',
  ROOT_CAVES: 'AMBUSH',
  ANCIENT_RUINS: 'GUARDIAN',
};

/** Size budget: 3 small + 2 medium + 1 large = 6 entrances (plan §38: 4–8, 2–3 small, 2 medium, 1 large). */
const SIZE_PLAN: CaveSize[] = ['small', 'small', 'small', 'medium', 'medium', 'large'];

const SIZE_PARAMS: Record<CaveSize, { radians: number; depth: number; steps: number }> = {
  small: { radians: 0.075, depth: 10.5, steps: 2 },
  medium: { radians: 0.095, depth: 16.5, steps: 3 },
  large: { radians: 0.115, depth: 22, steps: 4 },
};

/** Which cave a landmark type attracts (plan §12 composition rules). */
const LANDMARK_CAVE: Record<string, { type: CaveType; offset: number }> = {
  CRYSTAL_CANYON: { type: 'CRYSTAL_CAVES', offset: 0.86 },
  COLONY_WRECK: { type: 'ANCIENT_RUINS', offset: 1.02 },
  NECROPHAGE_NEST: { type: 'NECROPHAGE_NEST', offset: 0.92 },
  FUNGAL_FOREST: { type: 'ROOT_CAVES', offset: 0.95 },
  TOXIC_LAKE: { type: 'RADIOACTIVE_CAVERNS', offset: 1.05 },
  NECROTIC_CRATER: { type: 'NECROPHAGE_NEST', offset: 1.0 },
  FLOATING_ROCKS: { type: 'CRYSTAL_CAVES', offset: 0.98 },
  BONE_VALLEY: { type: 'ANCIENT_RUINS', offset: 0.96 },
};

/** Planet biome → default cave character when no landmark attracts the cave. */
function caveTypeForBiome(biome: BiomeClass | string, roll: number): CaveType {
  switch (biome) {
    case 'CRYSTAL':
      return roll < 0.72 ? 'CRYSTAL_CAVES' : 'RADIOACTIVE_CAVERNS';
    case 'TOXIC':
    case 'CORRUPTED':
      return roll < 0.55 ? 'RADIOACTIVE_CAVERNS' : 'NECROPHAGE_NEST';
    case 'FUNGAL':
    case 'JUNGLE':
    case 'SWAMP':
    case 'OCEANIC':
      return roll < 0.66 ? 'ROOT_CAVES' : 'CRYSTAL_CAVES';
    case 'VOLCANIC':
    case 'DEAD':
      return roll < 0.5 ? 'RADIOACTIVE_CAVERNS' : 'ANCIENT_RUINS';
    case 'DESERT':
    case 'FROZEN':
      return roll < 0.5 ? 'ANCIENT_RUINS' : 'CRYSTAL_CAVES';
    default:
      return roll < 0.4 ? 'ANCIENT_RUINS' : roll < 0.7 ? 'CRYSTAL_CAVES' : 'ROOT_CAVES';
  }
}

/** Unit tangent pair for a node direction — the carve anisotropy axes (stable, deterministic). */
function nodeAxes(dir: THREE.Vector3, rng: Rand): { axis: THREE.Vector3; axis2: THREE.Vector3 } {
  const seedish = new THREE.Vector3(-dir.z, 0.37 + rng.range(-0.2, 0.2), dir.x).normalize();
  const axis = new THREE.Vector3().crossVectors(seedish, dir).normalize();
  const axis2 = new THREE.Vector3().crossVectors(axis, dir).normalize();
  return { axis, axis2 };
}

/**
 * Approach azimuth of a cave's MOUTH (user ask 2026-10-06): the Caves render layer clears this
 * azimuth for the entrance and orients the roof dome's wedge at it. Shared here so dev capture
 * aids frame the actual mouth instead of guessing.
 */
export function caveApproachAzimuth(cave: PlanetCave): number {
  return mulberry32(cave.seed ^ 0x51ed270b)() * Math.PI * 2;
}

/** Centre direction of a cave's deepest chamber (the roof dome is planted on its floor). */
export function caveChamberNode(cave: PlanetCave): CaveNode {
  return [...cave.nodes].reverse().find((node) => node.chamber) ?? cave.nodes[cave.nodes.length - 1];
}

/**
 * Deterministic cave list for a planet. The LAST (large) entry is the major underground landmark
 * (plan §38) — the one that gets ruin compositions + the strongest glow.
 */
export function generateCaves(
  seed: number,
  planetRadius: number,
  landmarks: readonly Landmark[],
  biome: BiomeClass | string,
  focusDir?: { x: number; y: number; z: number } | null,
): PlanetCave[] {
  const rng = new Rand((seed ^ 0x9e3779b9) >>> 0);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const caves: PlanetCave[] = [];
  const placed: THREE.Vector3[] = [];
  /** Minimum angle between two caves (plan §38: give exploration room, not a cave soup). */
  const minSeparation = 0.34;
  const spawnClearAngle = 12 / Math.max(1, planetRadius);

  const consumeLandmark = new Set<number>();

  for (let i = 0; i < SIZE_PLAN.length; i++) {
    const size = SIZE_PLAN[i];
    const params = SIZE_PARAMS[size];
    const caveSeed = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;

    // ---- direction: prefer an unattracted landmark (points of interest), else the spiral.
    let dir: THREE.Vector3 | null = null;
    let forcedType: CaveType | null = null;
    if (i >= 1 && i <= 4 && landmarks.length > 0) {
      for (let li = 0; li < landmarks.length; li++) {
        if (consumeLandmark.has(li)) continue;
        const lm = landmarks[li];
        const rule = LANDMARK_CAVE[lm.type];
        if (!rule) continue;
        // Sit just OUTSIDE the carved landmark footprint so the two shapes read as one place.
        const tangent = new THREE.Vector3(-lm.dir.z, 0.2, lm.dir.x).normalize();
        const axis = new THREE.Vector3().crossVectors(tangent, lm.dir).normalize();
        const candidate = lm.dir.clone().applyAxisAngle(axis, lm.radius * rule.offset);
        candidate.normalize();
        if (focusDir && candidate.dot(focusDir) > Math.cos(spawnClearAngle)) continue;
        dir = candidate;
        forcedType = rule.type;
        consumeLandmark.add(li);
        break;
      }
    }
    if (!dir) {
      for (let attempt = 0; attempt < 24 && !dir; attempt++) {
        const step = i + attempt * 0.37;
        const y = 1 - (2 * step + 1) / (SIZE_PLAN.length + 1);
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const a = golden * step + rng.range(-0.35, 0.35);
        const candidate = new THREE.Vector3(Math.cos(a) * r, y + rng.range(-0.12, 0.12), Math.sin(a) * r).normalize();
        if (focusDir && candidate.dot(focusDir) > Math.cos(spawnClearAngle)) continue;
        if (placed.some((p) => p.angleTo(candidate) < minSeparation)) continue;
        dir = candidate;
      }
    }
    if (!dir) dir = new THREE.Vector3(0, 1, 0); // degenerate guard — never expected
    placed.push(dir.clone());

    // ---- type: landmark rule wins, then biome character, then the roll.
    const type = forcedType ?? caveTypeForBiome(biome, rng.next());
    const palette = CAVE_PALETTES[type];

    // ---- node graph (plan §28): entrance ledge → tunnel nodes → chamber (large gets a
    // second chamber + branch pocket).
    const nodes: CaveNode[] = [];
    const steps = params.steps + (size === 'large' ? 1 : 0);
    const nodeRng = new Rand(caveSeed);
    let nodeDir = dir.clone();
    // Per-cave spin keeps the descent from being a straight line to the centre.
    let spin = nodeRng.range(-1, 1) >= 0 ? 1 : -1;

    for (let step = 0; step <= steps; step++) {
      const k = steps === 0 ? 1 : step / steps;
      const depth = params.depth * (0.26 + 0.74 * Math.pow(k, 0.92));
      const chamber = step === steps || (size === 'large' && step === steps - 1);
      const radius = chamber ? params.radians * (0.78 + 0.22 * k) : params.radians * (0.58 + 0.22 * k);
      const axes = nodeAxes(nodeDir, nodeRng);
      nodes.push({
        id: nodes.length,
        dir: nodeDir.clone(),
        radius,
        depth,
        chamber,
        parent: step === 0 ? null : step - 1,
        axis: axes.axis,
        axis2: axes.axis2,
      });
      if (step === steps) break;
      // Walk the node centre along a lopsided spiral: tangent offset, chamber steps shorten.
      const axis = new THREE.Vector3(-nodeDir.z, 0.35 * nodeRng.range(-1, 1), nodeDir.x).normalize().cross(nodeDir).normalize();
      const stride = params.radians * (chamber ? 0.42 : 0.55) * nodeRng.range(0.8, 1.25);
      nodeDir = nodeDir.clone().applyAxisAngle(axis, stride * spin).normalize();
      spin *= nodeRng.next() < 0.32 ? -1 : 1; // occasional switchback
    }

    // medium/large: a side pocket branch off the last tunnel node (dead-end with loot flavour).
    if (size !== 'small') {
      const parentIdx = Math.max(0, nodes.length - 2);
      const parent = nodes[parentIdx];
      const axis = new THREE.Vector3(parent.dir.z, 0.4, -parent.dir.x).normalize().cross(parent.dir).normalize();
      const branchDir = parent.dir
        .clone()
        .applyAxisAngle(axis, params.radians * 0.72 * (nodeRng.next() < 0.5 ? 1 : -1))
        .normalize();
      const branchAxes = nodeAxes(branchDir, nodeRng);
      nodes.push({
        id: nodes.length,
        dir: branchDir,
        radius: params.radians * 0.52,
        depth: parent.depth * 0.88,
        chamber: false,
        parent: parentIdx,
        axis: branchAxes.axis,
        axis2: branchAxes.axis2,
      });
    }

    // ---- footprint: every node's reach from the entrance centre + margin.
    let reach = params.radians;
    for (const node of nodes) reach = Math.max(reach, dir.angleTo(node.dir) + node.radius);
    reach += 0.02;

    caves.push({
      id: i,
      type,
      size,
      label: LABELS[type],
      major: size === 'large',
      dir: dir.clone(),
      radius: reach,
      depth: params.depth,
      nodes,
      palette,
      bias: BIAS[type],
      seed: caveSeed,
    });
  }

  return caves;
}
