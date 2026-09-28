// NECROFALL — BODY GRAMMAR (plan §17). Independent modules — core shape, head, sensory
// organs, defense — combine freely instead of "species = template + modifiers". Every choice
// writes into `GenomeVisual` AND into physics (`mass`, `armor`, `speedMul`), because the plan's
// core rule is VISUAL ↔ PHYSICS ↔ BEHAVIOR ↔ ATTACK (plan §18): a plated body must FEEL heavy.
import type { Rand } from '../../utils/Utils';
import type { GenomeVisual } from '../EnemyGenomes';
import type { EcoRole, LocomotionId } from './EnemyGenome';

export type BodyCore = 'ROUND' | 'OVAL' | 'ELONGATED' | 'FLATTENED' | 'SEGMENTED' | 'BULBOUS' | 'ARMORED';
export type HeadType = 'NONE' | 'FORWARD_MAW' | 'RADIAL_MAW' | 'SPLIT_JAW' | 'BEAK' | 'MANDIBLES' | 'EYE_CLUSTER';
export type SensorType = 'EYES' | 'ANTENNAE' | 'TENDRILS' | 'VIBRATION' | 'NODES';
export type DefenseType = 'PLATES' | 'SPIKES' | 'SHELL' | 'SHIELD_SACS' | 'REGENERATIVE';

export interface BodyPlan {
  core: BodyCore;
  head: HeadType;
  sensors: SensorType;
  defense: DefenseType;
  /** 0.6 (light frame) .. 1.6 (living wall): drives speed down, hp up. */
  mass: number;
  /** Flat incoming-damage reduction multiplier (1 = none, 0.82 = 18 % off). */
  armor: number;
  speedMul: number;
  visual: Partial<GenomeVisual>;
}

const CORES: BodyCore[] = ['ROUND', 'OVAL', 'ELONGATED', 'FLATTENED', 'SEGMENTED', 'BULBOUS', 'ARMORED'];
const HEADS: HeadType[] = ['NONE', 'FORWARD_MAW', 'RADIAL_MAW', 'SPLIT_JAW', 'BEAK', 'MANDIBLES', 'EYE_CLUSTER'];
const SENSORS: SensorType[] = ['EYES', 'ANTENNAE', 'TENDRILS', 'VIBRATION', 'NODES'];
const DEFENSES: DefenseType[] = ['PLATES', 'SPIKES', 'SHELL', 'SHIELD_SACS', 'REGENERATIVE'];

/** Ring unlocks the fancier modules (plan §29: complexity climbs with the ring, not stats). */
function corePool(ring: number, role: EcoRole): BodyCore[] {
  if (role === 'BOSS' || role === 'OVERSEER' || role === 'APEX') return ring >= 3 ? ['ARMORED', 'SEGMENTED', 'BULBOUS', 'ELONGATED'] : ['ARMORED', 'SEGMENTED', 'ROUND'];
  if (ring <= 0) return ['ROUND', 'OVAL', 'SEGMENTED'];
  if (ring <= 2) return CORES.slice(0, 5);
  return CORES;
}

export function rollBodyPlan(rng: Rand, role: EcoRole, locomotion: LocomotionId, ring: number): BodyPlan {
  let core = rng.pick(corePool(ring, role));
  // locomotion compatibility: slither/burrow need length, hoppers/floating favour compact cores
  if (locomotion === 'SLITHER') core = rng.next() < 0.7 ? 'SEGMENTED' : 'ELONGATED';
  if (locomotion === 'BURROWER') core = rng.next() < 0.6 ? 'ELONGATED' : 'SEGMENTED';
  if (locomotion === 'FLOATING') core = rng.next() < 0.6 ? 'BULBOUS' : 'ROUND';
  if (locomotion === 'HOPPER' || locomotion === 'LEAPER') core = rng.next() < 0.55 ? 'ROUND' : 'OVAL';

  const head = rng.pick(HEADS);
  const sensors = rng.pick(SENSORS);
  const defense = role === 'BULWARK' || role === 'GUARDIAN' ? (rng.next() < 0.6 ? 'SHELL' : rng.pick(DEFENSES)) : rng.pick(DEFENSES);

  // ---- core → dims / mass / armour (plan §18: heavy shell = slow + tanky + defensive)
  const visual: Partial<GenomeVisual> = { jelly: 0, segments: 1, membrane: 0 };
  let mass = 1;
  let bodyW = 1;
  let bodyL = 1;
  let bodyH = 1;
  switch (core) {
    case 'ROUND': bodyW = 1.1; bodyL = 1.05; bodyH = 1.05; mass = 1; break;
    case 'OVAL': bodyW = 1.0; bodyL = 1.25; bodyH = 0.98; mass = 1.05; break;
    case 'ELONGATED': bodyW = 0.72; bodyL = 1.75; bodyH = 0.82; mass = 1.1; break;
    case 'FLATTENED': bodyW = 1.3; bodyL = 1.15; bodyH = 0.6; mass = 0.9; break;
    case 'SEGMENTED': bodyW = 0.7; bodyL = 1.5; bodyH = 0.85; visual.segments = 6; mass = 1.15; break;
    case 'BULBOUS': bodyW = 1.35; bodyL = 1.1; bodyH = 1.35; visual.membrane = 0.45; mass = 1.2; break;
    case 'ARMORED': bodyW = 1.25; bodyL = 1.2; bodyH = 1.1; mass = 1.45; break;
  }
  visual.bodyWidth = bodyW;
  visual.bodyLength = bodyL;
  visual.bodyHeight = bodyH;

  // ---- head → jaw hardware
  switch (head) {
    case 'NONE': visual.mandibles = 0; visual.eyes = Math.max(1, (visual.eyes ?? 2) - 1); break;
    case 'FORWARD_MAW': visual.mandibles = 4; break;
    case 'RADIAL_MAW': visual.mandibles = 6; bodyH *= 1.08; break;
    case 'SPLIT_JAW': visual.mandibles = 4; visual.bodyLength = bodyL * 1.08; break;
    case 'BEAK': visual.mandibles = 2; break;
    case 'MANDIBLES': visual.mandibles = 6; visual.spikes = (visual.spikes ?? 0) + 1; break;
    case 'EYE_CLUSTER': visual.eyes = 5; break;
  }

  // ---- sensors → look
  switch (sensors) {
    case 'EYES': visual.eyes = (visual.eyes ?? 2); break;
    case 'ANTENNAE': visual.horns = (visual.horns ?? 0) + 2; visual.eyes = 2; break;
    case 'TENDRILS': visual.tubes = (visual.tubes ?? 0) + 2; visual.eyes = 2; break;
    case 'VIBRATION': visual.eyes = 1; visual.membrane = Math.min(0.9, (visual.membrane ?? 0) + 0.2); break;
    case 'NODES': visual.glowNodes = (visual.glowNodes ?? 0) + 2; break;
  }

  // ---- defense → armour
  let armor = 1;
  switch (defense) {
    case 'PLATES': visual.plates = (visual.plates ?? 1) + 2; armor = 0.94; break;
    case 'SPIKES': visual.spikes = (visual.spikes ?? 0) + 6; break;
    case 'SHELL': visual.plates = (visual.plates ?? 1) + 3; bodyW *= 1.15; armor = 0.86; mass *= 1.15; break;
    case 'SHIELD_SACS': visual.glowNodes = (visual.glowNodes ?? 0) + 2; armor = 0.9; break;
    case 'REGENERATIVE': visual.membrane = Math.min(0.9, (visual.membrane ?? 0) + 0.25); break;
  }

  // mass → speed (the plan's "heavy shell → slow acceleration, high defense")
  const speedMul = 1 / Math.pow(mass, 0.7);
  return { core, head, sensors, defense, mass, armor, speedMul, visual };
}
