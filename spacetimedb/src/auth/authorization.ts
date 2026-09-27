// NECROFALL — server-side authorization helpers (plan §41/§42).
//
// Every reducer that touches player-owned data funnels through these checks.
// The client is never trusted: it asks, the module verifies against tables.
import { SenderError } from 'spacetimedb/server';
import { admin_identity } from '../schema/player';
import { COLONY_NONE } from '../constants';

/** The caller's account row, created on first connection — must exist. */
export function requirePlayer(ctx: any): any {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) throw new SenderError('No player account for this identity.');
  if (p.banned) throw new SenderError('This account is banned.');
  return p;
}

/** An account that finished onboarding (name + colony) — required to queue (plan §63). */
export function requireOnboarded(ctx: any): any {
  const p = requirePlayer(ctx);
  if (p.colony === COLONY_NONE) throw new SenderError('Choose a colony first.');
  if (!p.player_name) throw new SenderError('Choose a player name first.');
  return p;
}

/** Admin gate (plan §42). */
export function requireAdmin(ctx: any): void {
  if (!ctx.db.admin_identity.identity.find(ctx.sender)) {
    throw new SenderError('Admin only.');
  }
}

/**
 * Bootstrap the very first admin. Callable ONLY while no admin exists — after
 * that it always throws. For production, seed `admin_identity` directly from
 * the CLI instead:
 *   spacetime sql <db> "INSERT INTO admin_identity (identity) VALUES (0x...)"
 */
export function isFirstAdminAvailable(ctx: any): boolean {
  for (const _ of ctx.db.admin_identity.iter()) return false;
  return true;
}

void admin_identity; // referenced by reducers through the schema, kept import-local for the helper above
