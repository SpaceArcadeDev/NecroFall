// NECROFALL — ENEMY COMPATIBILITY MATRIX (plan §70). Some combinations must be illegal: an
// underwater locomotion with a ground-only attack, a leap organ on a legless blob, a web shot
// without a web gland. The generator aims to satisfy these by construction; this module is the
// QA gate that PROVES it (and the hook future generators must pass).
import type { EnemyGenome } from '../EnemyGenomes';

export interface CompatContext {
  /** True when the planet has solid ground at the spawn band (there is no water gameplay yet). */
  solidGround: boolean;
}

/** Returns the list of violations — empty means the genome is legal. */
export function validateGenome(g: EnemyGenome, ctx: CompatContext = { solidGround: true }): string[] {
  const issues: string[] = [];
  const loco = g.locomotion;
  const has = (a: string): boolean => g.abilities.indexOf(a as never) >= 0;
  const v = g.visual;

  // ---- numeric sanity (plan §69: no NaN, no impossible slopes, no zero-length limbs)
  const numeric: [string, number][] = [
    ['hp', g.hp], ['speed', g.speed], ['damage', g.damage], ['radius', g.radius],
    ['scale', g.scale], ['attackRange', g.attackRange], ['attackCd', g.attackCd],
  ];
  for (const [name, value] of numeric) {
    if (!Number.isFinite(value) || value <= 0) issues.push(`${name} is not a positive number (${value})`);
  }
  if ((v.legPairs ?? 0) > 0 && !((v.legLength ?? 0) > 0.2)) issues.push('legged body with zero-length legs');
  if ((v.segments ?? 1) > 1 && (v.segments ?? 1) < 3) issues.push('segmented body with fewer than 3 segments');

  // ---- BURROW requires suitable terrain OR a body built to dig
  if (has('burrow') && loco !== 'BURROWER' && !((v.segments ?? 1) >= 4) && !((v.claws ?? 0) > 0)) {
    issues.push('burrow without a burrowing body (needs BURROWER locomotion, segments or claws)');
  }
  // ---- LEAP requires locomotion support
  if (has('leap') && !(loco === 'LEAPER' || loco === 'HOPPER' || loco === 'FLYER' || (v.legPairs ?? 0) > 0)) {
    issues.push('leap without leaping support');
  }
  // ---- RANGED requires a ranged organ on the body
  if (g.ranged && !(v.tubes && v.tubes > 0)) issues.push('ranged attack without ranged organs (tubes)');
  if (has('web') && !(v.tubes && v.tubes > 0)) issues.push('web without a web gland (tubes)');
  // ---- EXPLOSIVE requires an explosive organ
  if (has('detonate') && !((v.glowNodes ?? 0) > 0 || g.traits.indexOf('explosive') >= 0)) {
    issues.push('detonate without an explosive organ');
  }
  // ---- CHARGE + FLOATING/FLYER dont mix; airborne bodies do not ram
  if (has('charge') && (loco === 'FLOATING' || loco === 'FLYER')) issues.push('ground charge on a flying body');
  // ---- a winged rig without wings (or a segment chain too short to read) is a broken model
  if (v.rig === 'AVIAN' && !((v.wings ?? 0) > 0)) issues.push('avian body without wings');
  if (v.rig === 'MYRIAPOD' && !((v.segments ?? 1) >= 4)) issues.push('myriapod body with too few segments');
  if ((v.rig === 'MOLLUSK' || v.rig === 'WRAITH') && !((v.tentacles ?? 0) > 0)) issues.push('tentacled rig without tentacles');
  // ---- SLITHER and legged gaits are contradictory
  if (loco === 'SLITHER' && (v.legPairs ?? 0) > 2) issues.push('slither with more than one leg pair');
  // ---- ground-only attacks need solid ground (plan §70's underwater example, generalised)
  if (!ctx.solidGround && !g.ranged) issues.push('ground-only attack on a world without ground');

  // ---- attack-list sanity
  for (const atk of g.attacks ?? []) {
    if (!Number.isFinite(atk.telegraph.lead) || atk.telegraph.lead <= 0.2) issues.push(`attack ${atk.id} has an unreadable telegraph lead`);
    if (!Number.isFinite(atk.range) || atk.range <= 0) issues.push(`attack ${atk.id} has no range`);
    if (!Number.isFinite(atk.windup) || atk.windup < 0.2) issues.push(`attack ${atk.id} has no wind-up`);
  }
  if (g.attacks && g.attacks.length === 0) issues.push('no attacks generated');
  // every attack ability must exist in the sim's ability list
  const abilitySet = new Set(g.abilities);
  for (const atk of g.attacks ?? []) {
    if (!abilitySet.has(atk.ability)) issues.push(`attack ${atk.id} ability ${atk.ability} missing from abilities`);
  }
  return issues;
}
