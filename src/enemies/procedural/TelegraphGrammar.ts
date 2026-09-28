// NECROFALL — TELEGRAPH GRAMMAR (plan §23/§24). Every dangerous attack gets a READABLE warning
// derived from its type — never hand-authored per enemy. The shapes map onto the game's existing
// surface telegraph system (TelegraphSystem: disc / ring / line / cone), so a generated attack
// automatically arrives with a warning the terrain projects correctly (plan §24).
import type { Rand } from '../../utils/Utils';
import type { AbilityId } from '../EnemyGenomes';
import type { TelegraphSpec } from './EnemyGenome';

/**
 * Attack type → telegraph shape (plan §23's table):
 *   leap → target circle + landing ring · charge → line · slam → expanding ring ·
 *   projectile → glow + marker · web/toxin → disc · burrow → ripple ring · explosion → radius.
 */
const SHAPES: Record<string, TelegraphSpec['shape']> = {
  leap: 'circle',
  charge: 'line',
  slam: 'ring',
  gravPull: 'ring',
  spit: 'disc',
  web: 'disc',
  volley: 'cone',
  venomCloud: 'disc',
  burrow: 'ring',
  blink: 'circle',
  detonate: 'disc',
  shield: 'ring',
};

/**
 * Warning windows SHRINK with the ring (plan §29: higher rings telegraph later/tighter), but
 * never below a human read: bronze gives 0.95 s, King of Gods 0.62 s.
 */
export function telegraphFor(ability: AbilityId, rng: Rand, ring: number): TelegraphSpec {
  const shape = SHAPES[ability] ?? 'disc';
  const leadBase: Record<TelegraphSpec['shape'], number> = { circle: 0.9, disc: 0.75, line: 0.8, cone: 0.75, ring: 0.85 };
  const lead = Math.max(0.55, leadBase[shape] - ring * 0.04) * rng.range(0.92, 1.1);
  return {
    shape,
    lead,
    radius: 2.4 + rng.range(0, 1.6),
    length: 9 + rng.range(0, 7),
    color: 0,
  };
}
