// NECROFALL — BODY GRAMMAR (plan §17). Independent modules — core shape, head, sensory
// organs, defense — combine freely instead of "species = template + modifiers". Every choice
// writes into `GenomeVisual` AND into physics (`mass`, `armor`, `speedMul`), because the plan's
// core rule is VISUAL ↔ PHYSICS ↔ BEHAVIOR ↔ ATTACK (plan §18): a plated body must FEEL heavy.
import type { Rand } from '../../utils/Utils';
import type { GenomeVisual } from '../EnemyGenomes';
import type { EcoRole, LocomotionId } from './EnemyGenome';

export type BodyCore = 'ROUND' | 'OVAL' | 'ELONGATED' | 'FLATTENED' | 'SEGMENTED' | 'BULBOUS' | 'ARMORED'
  | 'WINGED'     // avian: hunched body, long neck, membrane wings, talons (FLYER)
  | 'MYRIAPOD'   // long segment chain with a leg pair on EVERY segment
  | 'ETHEREAL'   // hovering core ringed by orbiting shards (FLOATING)
  | 'MOLLUSK'    // bulbed shell trailing writhing tentacles (slow, heavy)
  ;
export type HeadType = 'NONE' | 'FORWARD_MAW' | 'RADIAL_MAW' | 'SPLIT_JAW' | 'BEAK' | 'MANDIBLES' | 'EYE_CLUSTER' | 'HOOK_BEAK' | 'LAMPREY' | 'PRISM';
export type SensorType = 'EYES' | 'ANTENNAE' | 'TENDRILS' | 'VIBRATION' | 'NODES' | 'PLUMES' | 'SHARDS';
export type DefenseType = 'PLATES' | 'SPIKES' | 'SHELL' | 'SHIELD_SACS' | 'REGENERATIVE' | 'CRYSTAL_ARMOR';

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
/** New architectures: these join the BASE pool (they are body plans, not power unlocks), while
 *  the truly alien ETHEREAL frame waits for ring 2. */
const CORES_EXOTIC: BodyCore[] = ['MYRIAPOD', 'MOLLUSK'];
const CORES_ELDRITCH: BodyCore[] = ['ETHEREAL'];
const HEADS: HeadType[] = ['NONE', 'FORWARD_MAW', 'RADIAL_MAW', 'SPLIT_JAW', 'BEAK', 'MANDIBLES', 'EYE_CLUSTER', 'HOOK_BEAK', 'LAMPREY', 'PRISM'];
const SENSORS: SensorType[] = ['EYES', 'ANTENNAE', 'TENDRILS', 'VIBRATION', 'NODES', 'PLUMES', 'SHARDS'];
const DEFENSES: DefenseType[] = ['PLATES', 'SPIKES', 'SHELL', 'SHIELD_SACS', 'REGENERATIVE', 'CRYSTAL_ARMOR'];

/** Ring unlocks the fancier modules (plan §29: complexity climbs with the ring, not stats). */
function corePool(ring: number, role: EcoRole): BodyCore[] {
  if (role === 'BOSS' || role === 'OVERSEER' || role === 'APEX') {
    return ring >= 3 ? ['ARMORED', 'SEGMENTED', 'BULBOUS', 'ELONGATED', 'MYRIAPOD'] : ['ARMORED', 'SEGMENTED', 'ROUND'];
  }
  const base: BodyCore[] = ring <= 0 ? ['ROUND', 'OVAL', 'SEGMENTED'] : ring <= 2 ? CORES.slice(0, 5) : CORES;
  const exotic = ring >= 2 ? [...CORES_EXOTIC, ...CORES_ELDRITCH] : CORES_EXOTIC;
  return [...base, ...exotic];
}

export function rollBodyPlan(rng: Rand, role: EcoRole, locomotion: LocomotionId, ring: number): BodyPlan {
  let core = rng.pick(corePool(ring, role));
  // locomotion compatibility: slither/burrow need length, hoppers/floating favour compact cores
  if (locomotion === 'SLITHER') core = rng.next() < 0.7 ? 'SEGMENTED' : 'ELONGATED';
  if (locomotion === 'BURROWER') core = rng.next() < 0.6 ? 'ELONGATED' : 'SEGMENTED';
  if (locomotion === 'FLOATING') core = rng.next() < 0.4 && ring >= 2 ? 'ETHEREAL' : rng.next() < 0.6 ? 'BULBOUS' : 'ROUND';
  if (locomotion === 'HOPPER' || locomotion === 'LEAPER') core = rng.next() < 0.55 ? 'ROUND' : 'OVAL';
  // a FLYER is ALWAYS the winged frame — wings are its locomotion, not decoration
  if (locomotion === 'FLYER') core = 'WINGED';
  // ... and the architectures that need solid ground or lift cannot hold a leaping/floating frame
  if (core === 'MYRIAPOD' && (locomotion === 'SLITHER' || locomotion === 'BURROWER' || locomotion === 'LEAPER' || locomotion === 'HOPPER' || locomotion === 'FLOATING' || locomotion === 'FLYER')) core = 'SEGMENTED';
  if (core === 'ETHEREAL' && locomotion !== 'FLOATING' && locomotion !== 'FLYER') core = 'BULBOUS';
  if (core === 'MOLLUSK' && (locomotion === 'LEAPER' || locomotion === 'HOPPER' || locomotion === 'FLYER')) core = 'BULBOUS';
  if (core === 'WINGED' && locomotion !== 'FLYER' && locomotion !== 'STALKING') core = 'OVAL';

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
    // ---- the new architectures (plan §17): each sets its own RIG, because these are different
    // SKELETONS rather than different proportions of the same one.
    case 'WINGED':
      bodyW = 0.95; bodyL = 1.35; bodyH = 1.15; mass = 0.95;
      visual.rig = 'AVIAN'; visual.wings = 2; visual.legPairs = 1; visual.plumes = 3; visual.tail = true;
      break;
    case 'MYRIAPOD':
      bodyW = 0.6; bodyL = 1.9; bodyH = 0.8; mass = 1.12;
      visual.rig = 'MYRIAPOD'; visual.segments = 9; visual.legPairs = 0;
      break;
    case 'ETHEREAL':
      bodyW = 1.0; bodyL = 1.0; bodyH = 1.3; mass = 0.82;
      visual.rig = 'WRAITH'; visual.tentacles = 4; visual.shards = 5; visual.membrane = 0.5;
      break;
    case 'MOLLUSK':
      bodyW = 1.25; bodyL = 1.1; bodyH = 1.3; mass = 1.28;
      visual.rig = 'MOLLUSK'; visual.tentacles = 6;
      break;
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
    case 'HOOK_BEAK': visual.mandibles = 2; visual.plumes = (visual.plumes ?? 0) + 2; break;
    case 'LAMPREY': visual.mandibles = 6; visual.core = true; break;
    case 'PRISM': visual.shards = (visual.shards ?? 0) + 2; visual.eyes = 3; break;
  }

  // ---- sensors → look
  switch (sensors) {
    case 'EYES': visual.eyes = (visual.eyes ?? 2); break;
    case 'ANTENNAE': visual.horns = (visual.horns ?? 0) + 2; visual.eyes = 2; break;
    case 'TENDRILS': visual.tubes = (visual.tubes ?? 0) + 2; visual.eyes = 2; break;
    case 'VIBRATION': visual.eyes = 1; visual.membrane = Math.min(0.9, (visual.membrane ?? 0) + 0.2); break;
    case 'NODES': visual.glowNodes = (visual.glowNodes ?? 0) + 2; break;
    case 'PLUMES': visual.plumes = (visual.plumes ?? 0) + 4; visual.eyes = 2; break;
    case 'SHARDS': visual.shards = (visual.shards ?? 0) + 3; visual.eyes = 2; break;
  }

  // ---- defense → armour
  let armor = 1;
  switch (defense) {
    case 'PLATES': visual.plates = (visual.plates ?? 1) + 2; armor = 0.94; break;
    case 'SPIKES': visual.spikes = (visual.spikes ?? 0) + 6; break;
    case 'SHELL': visual.plates = (visual.plates ?? 1) + 3; bodyW *= 1.15; armor = 0.86; mass *= 1.15; break;
    case 'SHIELD_SACS': visual.glowNodes = (visual.glowNodes ?? 0) + 2; armor = 0.9; break;
    case 'REGENERATIVE': visual.membrane = Math.min(0.9, (visual.membrane ?? 0) + 0.25); break;
    case 'CRYSTAL_ARMOR': visual.shards = (visual.shards ?? 0) + 2; visual.plates = (visual.plates ?? 1) + 1; armor = 0.9; break;
  }

  // mass → speed (the plan's "heavy shell → slow acceleration, high defense")
  const speedMul = 1 / Math.pow(mass, 0.7);
  return { core, head, sensors, defense, mass, armor, speedMul, visual };
}
