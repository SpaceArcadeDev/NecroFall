// NECROFALL — RANK LADDER (plan §1–§4). PURE FUNCTIONS, no SpacetimeDB types.
//
// The ladder is ONE integer: `player.rank_points` = TOTAL STARS earned across
// the whole climb. Tier, division and the displayed stars are DERIVED here —
// never stored as strings. The client keeps an EXACT copy of this file in
// `src/rank/RankService.ts`; THIS one is authoritative (the server decides
// every result — clients only display).
//
//   BRONZE  III→I   3 divisions × 3 stars   =  9   (losses cost no stars)
//   SILVER  IV→I    4 divisions × 4 stars   = 16
//   GOLD    V→I     5 divisions × 5 stars   = 25
//   DIAMOND V→I     5 divisions × 5 stars   = 25
//   PLATINUM V→I    5 divisions × 5 stars   = 25   → Liberator from 100
//   LIBERATOR       0–24 stars (100–124)     (0-star floor is protected)
//   GOD             25–49 stars (125–149)
//   KING OF GODS    50+ stars (150+)         (leaderboard tier)

export const TIER_BRONZE = 0;
export const TIER_SILVER = 1;
export const TIER_GOLD = 2;
export const TIER_DIAMOND = 3;
export const TIER_PLATINUM = 4;
export const TIER_LIBERATOR = 5;
export const TIER_GOD = 6;
export const TIER_KOG = 7;
export const TIER_MAX = TIER_KOG;

export const RANK_TIER_NAMES = [
  'BRONZE',
  'SILVER',
  'GOLD',
  'DIAMOND',
  'PLATINUM',
  'LIBERATOR',
  'GOD',
  'KING OF GODS',
] as const;

/** Division display numerals (division 1 = 'I', the one before promotion). */
export const DIVISION_ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'] as const;

/** Total stars at which LIBERATOR begins (9+16+25+25+25). */
export const LIBERATOR_BASE = 100;
/** Total stars at which GOD begins. */
export const GOD_BASE = LIBERATOR_BASE + 25; // 125
/** Total stars at which KING OF GODS begins. */
export const KOG_BASE = GOD_BASE + 25; // 150
/** Every high-tier display restarts its star count here (plan §2.5–2.7). */
export const HIGH_TIER_DISPLAY_BASE = LIBERATOR_BASE;

export const RANK_RESULT_WIN = 0;
export const RANK_RESULT_DRAW = 1;
export const RANK_RESULT_LOSS = 2;

/** How many stars each high tier spans before the next (LIBERATOR/GOD). */
const HIGH_TIER_SPAN = 25;

interface DivisionTier {
  tier: number;
  divisions: number;
  per: number;
}

/** Division ladder below the high tiers, in climb order. */
const LADDER: readonly DivisionTier[] = [
  { tier: TIER_BRONZE, divisions: 3, per: 3 },
  { tier: TIER_SILVER, divisions: 4, per: 4 },
  { tier: TIER_GOLD, divisions: 5, per: 5 },
  { tier: TIER_DIAMOND, divisions: 5, per: 5 },
  { tier: TIER_PLATINUM, divisions: 5, per: 5 },
];

/** Cumulative star threshold at which each ladder tier begins. */
const TIER_BASE: number[] = (() => {
  const bases: number[] = [0];
  let acc = 0;
  for (const step of LADDER) {
    acc += step.divisions * step.per;
    bases.push(acc);
  }
  return bases;
})();

export interface RankInfo {
  /** 0..7 — also the galactic RING index (plan §6). */
  tier: number;
  /** 1..5 for division tiers, 0 for LIBERATOR/GOD/KING OF GODS. */
  division: number;
  /** Stars within the current division (or the high-tier personal count). */
  stars: number;
  /** Stars needed to leave the current division / tier. 0 for KOG (open ended). */
  toNext: number;
  /** Progress within the current division 0..1 (or within 25 stars for GOD/KOG ring). */
  progress: number;
}

/**
 * THE canonical derivation: total stars → { tier, division, stars }. Clamps at
 * Bronze III / 0 stars. KOG is open ended (progress reports the last 25-star
 * ring so the UI can still draw something honest).
 */
export function getRankFromStars(totalStars: number): RankInfo {
  const total = Math.max(0, Math.floor(totalStars));
  if (total >= LIBERATOR_BASE) {
    const personal = total - HIGH_TIER_DISPLAY_BASE; // 0 at Liberator, 25 at God, 50+ at KOG
    if (total >= KOG_BASE) {
      return { tier: TIER_KOG, division: 0, stars: personal, toNext: 0, progress: ((personal - 50) % HIGH_TIER_SPAN) / HIGH_TIER_SPAN };
    }
    if (total >= GOD_BASE) {
      const within = personal - 25;
      return { tier: TIER_GOD, division: 0, stars: personal, toNext: HIGH_TIER_SPAN - within, progress: within / HIGH_TIER_SPAN };
    }
    return { tier: TIER_LIBERATOR, division: 0, stars: personal, toNext: HIGH_TIER_SPAN - personal, progress: personal / HIGH_TIER_SPAN };
  }
  for (let i = LADDER.length - 1; i >= 0; i--) {
    const step = LADDER[i];
    const base = TIER_BASE[i];
    const span = step.divisions * step.per;
    if (total >= base) {
      const within = total - base;
      const fromBottom = Math.floor(within / step.per);
      const stars = within % step.per;
      const division = step.divisions - fromBottom; // III→1... display order
      return { tier: step.tier, division, stars, toNext: step.per - stars, progress: stars / step.per };
    }
    void span;
  }
  return { tier: TIER_BRONZE, division: 3, stars: 0, toNext: 3, progress: 0 };
}

/** 'GOLD III' / 'LIBERATOR' / 'KING OF GODS'. */
export function getRankDisplayName(totalStars: number): string {
  const info = getRankFromStars(totalStars);
  if (info.tier >= TIER_LIBERATOR) return RANK_TIER_NAMES[info.tier];
  return `${RANK_TIER_NAMES[info.tier]} ${DIVISION_ROMAN[info.division]}`;
}

/** The galactic ring for a rank — ring === tier (plan §6). */
export function getRankRing(totalStars: number): number {
  return getRankFromStars(totalStars).tier;
}

/** Stars still needed to reach the next division/tier (0 for KOG). */
export function getStarsToPromotion(totalStars: number): number {
  return getRankFromStars(totalStars).toNext;
}

/**
 * PROMOTION GRANT (user ask 2026-09-29): true when `total` sits EXACTLY on a division
 * boundary below Liberator — the total a win lands on when it crosses into the next
 * division (or the next tier's bottom division).
 */
function onDivisionBoundary(total: number): boolean {
  if (total <= 0 || total >= LIBERATOR_BASE) return false;
  for (let i = 0; i < LADDER.length; i++) {
    const step = LADDER[i];
    const base = TIER_BASE[i];
    const span = step.divisions * step.per;
    if (total > base + span) continue;
    return (total - base) % step.per === 0;
  }
  return false;
}

/**
 * APPLY A MATCH RESULT (plan §2/§4):
 *   WIN  = +1 star · DRAW = 0 · LOSS = −1 star
 * Explicit edge cases:
 *   • PROMOTION GRANT (user ask 2026-09-29): a win that CROSSES into a new division lands with
 *     its FIRST STAR lit (3★ Bronze III → 1★ Bronze II) instead of a blank 0★. The granted
 *     star is a normal star — a later loss can take it back down to 0★ of the same division.
 *     `delta` stays the match's own +1; the grant is the promotion itself.
 *   • BRONZE losses cost no stars (plan §4 — "Bronze losses").
 *   • LIBERATOR at 0 stars (total 100) never drops to Platinum (plan §4).
 *   • GOD/KOG DO drop a star across the boundary (KOG is not protected):
 *     KOG 50 → 49 = God 49; God 25 → 24 = Liberator 24.
 *   • Stars never go negative (floor 0).
 * Returns the NEW TOTAL and the delta actually applied.
 */
export function applyRankResult(totalStars: number, result: number): { stars: number; delta: number } {
  const total = Math.max(0, Math.floor(totalStars));
  if (result === RANK_RESULT_WIN) {
    const next = total + 1;
    if (onDivisionBoundary(next)) return { stars: next + 1, delta: 1 };
    return { stars: next, delta: 1 };
  }
  if (result === RANK_RESULT_DRAW) return { stars: total, delta: 0 };
  // LOSS
  const tier = getRankFromStars(total).tier;
  if (tier === TIER_BRONZE) return { stars: total, delta: 0 };
  if (total <= LIBERATOR_BASE) return { stars: total, delta: 0 };
  return { stars: total - 1, delta: -1 };
}

/** 'Bronze III' short label for history rows. */
export function rankLabel(tier: number, division: number): string {
  if (tier >= TIER_LIBERATOR) return String(RANK_TIER_NAMES[tier] ?? tier);
  return `${RANK_TIER_NAMES[tier]} ${DIVISION_ROMAN[division] ?? ''}`.trim();
}
