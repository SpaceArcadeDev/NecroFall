// NECROFALL — LIMB GRAMMAR (plan §17/§19). The movement vocabulary decides the LIMBS, and the
// limbs decide reach, stride and silhouette (plan §18: "long legs → fast → leap locomotion").
import type { Rand } from '../../utils/Utils';
import type { GenomeVisual } from '../EnemyGenomes';
import type { BodyPlan } from './BodyGrammar';
import type { LocomotionId } from './EnemyGenome';

export interface LimbPlan {
  legPairs: number;
  legLength: number;
  legThickness: number;
  /** Side flippers (FLOATING) — drawn as broad blades. */
  fins: number;
  /** Membrane wings (FLOATING at higher rings) — drawn as wide flat fans. */
  wings: number;
  /** Rear storage organs for LEAPER compression + CHARGER build-up. */
  sacs: number;
  /** Hooked forelimbs (ambushers/leapers) — the "this thing grapples" read. */
  claws: number;
  /** Segmented tail length (SLITHER / balance). */
  tailSegments: number;
  visual: Partial<GenomeVisual>;
}

export function rollLimbs(rng: Rand, locomotion: LocomotionId, body: BodyPlan, ring: number): LimbPlan {
  const heavy = body.mass > 1.25;
  let legPairs = 3;
  let legLength = 1;
  let legThickness = 0.1;
  let fins = 0;
  let wings = 0;
  let sacs = 0;
  let claws = 0;
  let tailSegments = 0;

  switch (locomotion) {
    case 'WALKER':
      legPairs = rng.int(3, 4);
      legLength = rng.range(0.95, 1.25);
      legThickness = heavy ? 0.16 : 0.1;
      break;
    case 'CRAWLER':
      legPairs = rng.int(3, 4);
      legLength = rng.range(0.6, 0.85);
      legThickness = heavy ? 0.13 : 0.08;
      break;
    case 'LEAPER':
      legPairs = rng.int(2, 3);
      legLength = rng.range(1.35, 1.75); // the long legs the plan asks for
      legThickness = heavy ? 0.15 : 0.09;
      sacs = rng.int(1, 3);
      claws = rng.next() < 0.6 ? 2 : 0;
      break;
    case 'HOPPER':
      legPairs = rng.int(1, 2);
      legLength = rng.range(1.5, 2);
      legThickness = heavy ? 0.16 : 0.1;
      sacs = rng.int(1, 2);
      break;
    case 'BURROWER':
      legPairs = rng.int(0, 2);
      legLength = rng.range(0.7, 1.1);
      legThickness = 0.18;
      claws = 4; // digging hooks
      tailSegments = rng.int(3, 5);
      break;
    case 'SLITHER':
      legPairs = 0;
      legLength = 0.6;
      legThickness = 0.1;
      tailSegments = rng.int(4, 7);
      break;
    case 'CHARGER':
      legPairs = rng.int(3, 4);
      legLength = rng.range(1.0, 1.2);
      legThickness = heavy ? 0.2 : 0.13;
      sacs = rng.int(1, 2);
      break;
    case 'FLOATING':
      legPairs = rng.next() < 0.35 ? rng.int(1, 2) : 0;
      legLength = 0.9;
      legThickness = 0.08;
      fins = rng.int(2, 4);
      wings = ring >= 3 && rng.next() < 0.5 ? 2 : 0;
      break;
    case 'STALKING':
      legPairs = 4;
      legLength = rng.range(1.25, 1.6);
      legThickness = heavy ? 0.13 : 0.065;
      claws = 2;
      break;
    case 'SWARM':
      legPairs = rng.int(2, 3);
      legLength = rng.range(0.7, 1.0);
      legThickness = 0.06;
      break;
  }

  const visual: Partial<GenomeVisual> = {
    legPairs,
    legLength,
    legThickness,
    ...(fins || wings ? { fins, wings } : {}),
    ...(sacs ? { sacs } : {}),
    ...(claws ? { claws } : {}),
  };
  if (tailSegments > 0) visual.tail = true;
  // segmented bodies always keep a tail chain
  if ((body.visual.segments ?? 1) > 1) visual.tail = visual.tail ?? true;
  return { legPairs, legLength, legThickness, fins, wings, sacs, claws, tailSegments, visual };
}
