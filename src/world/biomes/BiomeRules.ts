// NECROFALL — BiomeRules (plan §63): each biome gets a controlled ASSET PALETTE and density
// multipliers instead of a random mix of Folio models. The generator consults these rules; the
// art direction is data, not scattered conditionals.
import type { TreeKind } from '../vegetation/VegetationTypes';

export interface BiomeRule {
  name: string;
  /** Relative chance per tree kind (weights, not percentages). */
  treeWeights: Record<TreeKind, number>;
  /** How likely a bush cluster is where a bush is allowed at all. */
  bushChance: number;
  /** How likely a flower cluster is. */
  flowerChance: number;
  /** Multiplies the global density budget. */
  density: number;
}

export const BIOME_RULES = {
  FOREST: {
    name: 'FOREST',
    treeWeights: { OAK: 1.2, BIRCH: 1.0, CHERRY: 0.12 },
    bushChance: 0.42,
    flowerChance: 0.3,
    density: 1.25,
  },
  MEADOW: {
    name: 'MEADOW',
    treeWeights: { OAK: 0.35, BIRCH: 0.5, CHERRY: 1.1 },
    bushChance: 0.5,
    flowerChance: 0.85,
    density: 0.8,
  },
  CORRUPTED: {
    name: 'CORRUPTED',
    treeWeights: { OAK: 0.5, BIRCH: 0.7, CHERRY: 0.04 },
    bushChance: 0.35,
    flowerChance: 0.15,
    density: 0.75,
  },
  ROCK: {
    name: 'ROCK',
    treeWeights: { OAK: 0.06, BIRCH: 0.1, CHERRY: 0.02 },
    bushChance: 0.12,
    flowerChance: 0.08,
    density: 0.3,
  },
  SHORE: {
    name: 'SHORE',
    treeWeights: { OAK: 0.25, BIRCH: 0.4, CHERRY: 0.3 },
    bushChance: 0.3,
    flowerChance: 0.25,
    density: 0.45,
  },
} as const satisfies Record<string, BiomeRule>;

export type BiomeRuleName = keyof typeof BIOME_RULES;

/**
 * Pick the rule from the BiomeField weights — the strongest signal wins, with corruption
 * overriding everything (necrotic land never reads as pristine meadow).
 */
export function ruleForWeights(weights: {
  grass: number;
  forest: number;
  rock: number;
  sand: number;
  water: number;
  necrotic: number;
}): BiomeRule {
  if (weights.necrotic > 0.55) return BIOME_RULES.CORRUPTED;
  if (weights.water > 0.4 || weights.sand > 0.55) return BIOME_RULES.SHORE;
  if (weights.rock > 0.55) return BIOME_RULES.ROCK;
  if (weights.forest > 0.45) return BIOME_RULES.FOREST;
  return BIOME_RULES.MEADOW;
}

/** Weighted pick of a tree kind for a rule (deterministic — `roll` in [0,1)). */
export function pickTreeKind(rule: BiomeRule, roll: number): TreeKind {
  const entries = Object.entries(rule.treeWeights) as Array<[TreeKind, number]>;
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let acc = roll * total;
  for (const [kind, weight] of entries) {
    acc -= weight;
    if (acc <= 0) return kind;
  }
  return entries[0][0];
}
