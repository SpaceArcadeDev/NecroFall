// NECROFALL — RANK LADDER (client mirror of `spacetimedb/src/ranked/rank.ts`).
//
// PURE FUNCTIONS, no imports — keep BYTE-FOR-BYTE in sync with the server copy:
// the server decides every star change, the client only DERIVES the display the
// same way, so both sides can never disagree about what "Gold II, 3 stars" is.
//
// The ladder is ONE integer: `player.rankPoints` = TOTAL stars across the climb.
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

export const LIBERATOR_BASE = 100;
export const GOD_BASE = LIBERATOR_BASE + 25; // 125
export const KOG_BASE = GOD_BASE + 25; // 150
export const HIGH_TIER_DISPLAY_BASE = LIBERATOR_BASE;

export const RANK_RESULT_WIN = 0;
export const RANK_RESULT_DRAW = 1;
export const RANK_RESULT_LOSS = 2;

const HIGH_TIER_SPAN = 25;

interface DivisionTier {
  tier: number;
  divisions: number;
  per: number;
}

const LADDER: readonly DivisionTier[] = [
  { tier: TIER_BRONZE, divisions: 3, per: 3 },
  { tier: TIER_SILVER, divisions: 4, per: 4 },
  { tier: TIER_GOLD, divisions: 5, per: 5 },
  { tier: TIER_DIAMOND, divisions: 5, per: 5 },
  { tier: TIER_PLATINUM, divisions: 5, per: 5 },
];

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
  tier: number;
  division: number;
  stars: number;
  toNext: number;
  progress: number;
}

export function getRankFromStars(totalStars: number): RankInfo {
  const total = Math.max(0, Math.floor(totalStars));
  if (total >= LIBERATOR_BASE) {
    const personal = total - HIGH_TIER_DISPLAY_BASE;
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
    if (total >= base) {
      const within = total - base;
      const fromBottom = Math.floor(within / step.per);
      const stars = within % step.per;
      const division = step.divisions - fromBottom;
      return { tier: step.tier, division, stars, toNext: step.per - stars, progress: stars / step.per };
    }
  }
  return { tier: TIER_BRONZE, division: 3, stars: 0, toNext: 3, progress: 0 };
}

/**
 * The rank strip's star-row model — ONE source for the RANK page, the MODES card and the
 * bottom bar's RANK button (user ask 2026-10-03: "the same stars ui as the rank menu").
 * `html` carries the exact `.rk-star` markup the rank menu renders: lit stars gold with a
 * glow, the NEXT star blinking (`rk-star-next`), each popping in on its own delay.
 */
export function rankStarRow(totalStars: number): { html: string; lit: number; max: number; name: string } {
  const info = getRankFromStars(totalStars);
  const cap = info.tier >= TIER_LIBERATOR ? 25 : info.tier === 0 ? 3 : info.tier === 1 ? 4 : 5;
  const lit = Math.min(cap - 1, info.stars);
  const max = info.tier === TIER_KOG ? 8 : cap;
  let html = '';
  for (let i = 0; i < max; i++) {
    html += `<span class="rk-star ${i < lit ? 'on' : ''}${i === lit ? ' next' : ''}" style="animation-delay:${i * 70}ms">★</span>`;
  }
  if (info.tier === TIER_KOG) html += `<span class="rk-star-count">${info.stars} ★</span>`;
  return { html, lit, max, name: getRankDisplayName(totalStars) };
}

export function getRankDisplayName(totalStars: number): string {
  const info = getRankFromStars(totalStars);
  if (info.tier >= TIER_LIBERATOR) return RANK_TIER_NAMES[info.tier];
  return `${RANK_TIER_NAMES[info.tier]} ${DIVISION_ROMAN[info.division]}`;
}

export function getRankRing(totalStars: number): number {
  return getRankFromStars(totalStars).tier;
}

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

export function applyRankResult(totalStars: number, result: number): { stars: number; delta: number } {
  const total = Math.max(0, Math.floor(totalStars));
  if (result === RANK_RESULT_WIN) {
    const next = total + 1;
    // A win that CROSSES into a new division lands with its FIRST STAR lit (3★ Bronze III →
    // 1★ Bronze II) instead of a blank 0★ — it reads as a promotion, not as lost progress (user
    // ask 2026-09-29). The granted star is a normal star: a later loss can take it back down to
    // 0★ of the same division. `delta` stays the match's own +1 — the grant is the promotion.
    if (onDivisionBoundary(next)) return { stars: next + 1, delta: 1 };
    return { stars: next, delta: 1 };
  }
  if (result === RANK_RESULT_DRAW) return { stars: total, delta: 0 };
  const tier = getRankFromStars(total).tier;
  if (tier === TIER_BRONZE) return { stars: total, delta: 0 };
  if (total <= LIBERATOR_BASE) return { stars: total, delta: 0 };
  return { stars: total - 1, delta: -1 };
}

export function rankLabel(tier: number, division: number): string {
  if (tier >= TIER_LIBERATOR) return String(RANK_TIER_NAMES[tier] ?? tier);
  return `${RANK_TIER_NAMES[tier]} ${DIVISION_ROMAN[division] ?? ''}`.trim();
}
