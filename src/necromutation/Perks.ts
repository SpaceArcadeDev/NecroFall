// NECROFALL — Necromutation perks (level-up choices).
import type { Mods } from '../core/Config';
import type { Player } from '../player/Player';
import type { Rand } from '../utils/Utils';

export interface Perk {
  id: string;
  name: string;
  desc: string;
  /**
   * What the perk ACTUALLY does to the numbers, as pills the level-up card can print in colour.
   * Authored per perk instead of parsed out of `desc`: a perk like "−12% damage taken" is a GAIN
   * written as a minus, so only the author knows whether the pill is good news. `k` picks the
   * colour (up = green, down = red, alt = violet for effects that are not a percentage at all).
   */
  pills?: { v: string; l: string; k: 'up' | 'down' | 'alt' }[];
  /**
   * How strong the pick is MEANT to be — the level-up card is painted by it: common = green,
   * rare = blue, mythic = violet (the colour the game reserves for its best things), legendary =
   * gold, worn by the GAME-CHANGING picks that rewrite how the body moves and kills. The colour
   * therefore describes the PERK, never its seat: `openLevelUp` shuffles the three seats on every
   * deal, so the colours land in a different order each level-up.
   */
  tier: PerkTier;
  apply: (mods: Mods, player: Player) => void;
}

/** Narrow stat pill → green, upgraded kit → blue, best of the numeric picks → violet, game-changing → gold. */
export type PerkTier = 'common' | 'rare' | 'mythic' | 'legendary';

export const PERKS: Perk[] = [
  { id: 'butcher', name: 'Butcher', desc: '+15% auto-attack damage.', pills: [{ v: '+15%', l: 'DAMAGE', k: 'up' }], tier: 'common', apply: m => { m.dmgMul *= 1.15; } },
  { id: 'rapid', name: 'Rapid Core', desc: '+12% attack speed.', pills: [{ v: '+12%', l: 'FIRE RATE', k: 'up' }], tier: 'common', apply: m => { m.rateMul *= 1.12; } },
  { id: 'vital', name: 'Vital Plating', desc: '+20% max HP.', pills: [{ v: '+20%', l: 'MAX HP', k: 'up' }], tier: 'common', apply: m => { m.hpMul *= 1.2; } },
  { id: 'fleet', name: 'Fleet Feet', desc: '+12% movement speed.', pills: [{ v: '+12%', l: 'MOVE SPEED', k: 'up' }], tier: 'common', apply: m => { m.spdMul *= 1.12; } },
  { id: 'overclock', name: 'Overclock', desc: '+20% dash recharge rate.', pills: [{ v: '+20%', l: 'DASH RECHARGE', k: 'up' }], tier: 'common', apply: m => { m.dashRechargeMul *= 1.2; } },
  { id: 'adrenal', name: 'Adrenal Surge', desc: '+30% dash recharge rate, +6% movement speed.', pills: [{ v: '+30%', l: 'DASH RECHARGE', k: 'up' }, { v: '+6%', l: 'MOVE SPEED', k: 'up' }], tier: 'common', apply: m => { m.dashRechargeMul *= 1.3; m.spdMul *= 1.06; } },
  { id: 'empowered', name: 'Empowered', desc: '+15% Skill & Ultimate damage.', pills: [{ v: '+15%', l: 'ABILITY DMG', k: 'up' }], tier: 'common', apply: m => { m.abilityMul *= 1.15; } },
  { id: 'chrono', name: 'Chrono Shard', desc: '−12% ability cooldowns.', pills: [{ v: '−12%', l: 'COOLDOWNS', k: 'up' }], tier: 'common', apply: m => { m.cdMul *= 0.88; } },
  { id: 'longshot', name: 'Longshot', desc: '+12% attack range, +15% projectile speed.', pills: [{ v: '+12%', l: 'RANGE', k: 'up' }, { v: '+15%', l: 'BOLT SPEED', k: 'up' }], tier: 'common', apply: m => { m.rangeMul *= 1.12; m.projSpeedMul *= 1.15; } },
  { id: 'siphon', name: 'Siphon', desc: 'Heal 6 HP per kill.', pills: [{ v: '+6', l: 'HP / KILL', k: 'up' }], tier: 'common', apply: m => { m.lifesteal += 6; } },
  { id: 'regenerator', name: 'Regenerator', desc: '+30% health regeneration.', pills: [{ v: '+30%', l: 'REGEN', k: 'up' }], tier: 'common', apply: m => { m.regenMul *= 1.3; } },
  { id: 'necroderm', name: 'Necroderm', desc: '−12% damage taken.', pills: [{ v: '−12%', l: 'DMG TAKEN', k: 'up' }], tier: 'common', apply: m => { m.takenMul *= 0.88; } },
  { id: 'grave', name: 'Grave Memory', desc: '+20% Necromutation gain.', pills: [{ v: '+20%', l: 'XP GAIN', k: 'up' }], tier: 'common', apply: m => { m.xpMul *= 1.2; } },
  { id: 'resonant', name: 'Resonant Burst', desc: '+25% Necrotech Burst radius and damage, +15% Ultimate duration.', pills: [{ v: '+25%', l: 'BURST', k: 'up' }, { v: '+15%', l: 'ULT TIME', k: 'up' }], tier: 'common', apply: m => { m.burstMul *= 1.25; m.ultDurMul *= 1.15; } },
  { id: 'instinct', name: 'Killer Instinct', desc: '+12% critical strike chance (2× damage).', pills: [{ v: '+12%', l: 'CRIT', k: 'up' }], tier: 'common', apply: m => { m.crit += 0.12; } },
  { id: 'executioner', name: 'Executioner', desc: '+18% damage to enemies below 50% HP.', pills: [{ v: '+18%', l: 'DMG · LOW HP', k: 'up' }], tier: 'common', apply: m => { m.execMul *= 1.18; } },
  // ---- signature picks: mobility, firepower and defence
  {
    id: 'doublejump',
    name: 'Winged Sinew',
    desc: '+1 jump — one more leap while airborne.',
    pills: [{ v: '+1', l: 'JUMP', k: 'up' }],
    tier: 'rare',
    apply: m => { m.jumps += 1; },
  },
  {
    id: 'multishot',
    name: 'Split Chamber',
    desc: '+1 projectile on every auto-attack.',
    pills: [{ v: '+1', l: 'PROJECTILE', k: 'up' }],
    tier: 'mythic',
    apply: m => { m.projCount += 1; },
  },
  {
    id: 'ward',
    name: 'Necrotic Ward',
    desc: 'Regenerating shield that absorbs 45 damage before your health.',
    pills: [{ v: '45', l: 'SHIELD', k: 'alt' }],
    tier: 'rare',
    apply: m => { m.shieldHp += 45; },
  },
  {
    id: 'wardmaster',
    name: 'Ward Mastery',
    desc: '+30 shield, and it recharges 40% faster.',
    pills: [{ v: '+30', l: 'SHIELD', k: 'up' }, { v: '+40%', l: 'RECHARGE', k: 'up' }],
    tier: 'rare',
    apply: m => { m.shieldHp += 30; m.regenMul *= 1.15; },
  },
  {
    id: 'ritual',
    name: 'Extended Ritual',
    desc: '+25% Ultimate duration — fields, zones and self-buffs all hold longer.',
    pills: [{ v: '+25%', l: 'ULT TIME', k: 'up' }],
    tier: 'rare',
    apply: m => { m.ultDurMul *= 1.25; },
  },
  {
    id: 'deepritual',
    name: 'Deep Ritual',
    desc: '+45% Ultimate duration.',
    pills: [{ v: '+45%', l: 'ULT TIME', k: 'up' }],
    tier: 'mythic',
    apply: m => { m.ultDurMul *= 1.45; },
  },
  // ---- game-changing picks: these rewrite how the body MOVES and kills, not just by a percentage
  {
    id: 'quakefall',
    name: 'Quakefall',
    desc: 'Landing from a leap erupts in a shockwave — nearby Necrophages are hurt and thrown back.',
    pills: [{ v: '★', l: 'LEAP SHOCKWAVE', k: 'alt' }],
    tier: 'legendary',
    apply: m => { m.landShock += 1; },
  },
  {
    id: 'moltenwake',
    name: 'Molten Wake',
    desc: 'Running leaves a trail of lava that burns everything standing in it.',
    pills: [{ v: '★', l: 'LAVA TRAIL', k: 'alt' }],
    tier: 'legendary',
    apply: m => { m.lavaWake += 1; },
  },
  {
    id: 'echodecoy',
    name: 'Echo Decoy',
    desc: 'Dashing leaves a ghastly double behind. It draws the horde — then detonates.',
    pills: [{ v: '★', l: 'DASH DECOY', k: 'alt' }],
    tier: 'legendary',
    apply: m => { m.decoy += 1; },
  },
  {
    id: 'cadaverbloom',
    name: 'Cadaver Bloom',
    desc: 'Slain Necrophages burst, splashing the pack around them.',
    pills: [{ v: '★', l: 'CORPSE BURST', k: 'alt' }],
    tier: 'legendary',
    apply: m => { m.killBoom += 1; },
  },
  {
    id: 'voltaicspine',
    name: 'Voltaic Spine',
    desc: 'Auto-attacks arc to an extra enemy.',
    pills: [{ v: '+1', l: 'ARC TARGET', k: 'up' }],
    tier: 'legendary',
    apply: m => { m.chainAdd += 1; },
  },
];

export function rollPerks(rng: Rand, count: number, exclude: Set<string>): Perk[] {
  const pool = PERKS.filter(p => !exclude.has(p.id));
  const out: Perk[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = rng.int(0, pool.length - 1);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}
