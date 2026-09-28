// NECROFALL — SWARM GRAMMAR (plan §22). Small-tier Necrophages get their own steering
// rules: where they commit around their prey, how fast they circle, how tightly they
// hold the ring with their kin. These are executed by the movement code — two
// "swarmlings" from different seeds genuinely move differently.
import type { Rand } from '../../utils/Utils';
import type { LocomotionId, SwarmFormation, SwarmProfile } from './EnemyGenome';

export const FORMATION_BLURB: Record<SwarmFormation, string> = {
  BALL: 'swarms in a tight ball',
  RING: 'encircles the prey',
  ARC: 'attacks from an arc',
  WEDGE: 'drives in a wedge',
  CLOUD: 'drifts as a loose cloud',
  SURROUND: 'surrounds from all sides',
  SPIRAL: 'spirals inward',
  STREAM: 'streams in single file',
};

/** Locomotion has a strong say: flyers drift, leapers arc, crawlers circle. */
const LEAN: Partial<Record<LocomotionId, SwarmFormation[]>> = {
  FLOATING: ['CLOUD', 'RING'],
  LEAPER: ['ARC', 'WEDGE'],
  HOPPER: ['BALL', 'STREAM'],
  SWARM: ['BALL', 'SURROUND', 'RING', 'CLOUD'],
  CRAWLER: ['RING', 'SPIRAL', 'SURROUND'],
  SLITHER: ['SPIRAL', 'STREAM'],
  CHARGER: ['WEDGE', 'ARC'],
};

const ALL: SwarmFormation[] = ['BALL', 'RING', 'ARC', 'WEDGE', 'CLOUD', 'SURROUND', 'SPIRAL', 'STREAM'];

/** Rolls one swarm profile. Higher rings unlock the exotic formations (plan §29). */
export function rollSwarm(rng: Rand, locomotion: LocomotionId, ring: number): SwarmProfile {
  const lean = LEAN[locomotion] ?? ALL;
  const pool = ring >= 4 ? ALL : lean;
  const formation = pool[Math.floor(rng.next() * pool.length)];
  return {
    cohesion: 0.35 + rng.next() * 0.6,
    separation: 0.4 + rng.next() * 0.8,
    alignment: 0.2 + rng.next() * 0.7,
    orbitRadius: 1.6 + rng.next() * 4.2,
    aggression: 0.5 + rng.next() * 1.3,
    regroupDistance: 14 + rng.next() * 22,
    splitThreshold: 2 + Math.floor(rng.next() * 4),
    formation,
  };
}
