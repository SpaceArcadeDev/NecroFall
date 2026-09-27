// NECROFALL — follow graph (plan §5).
//
// One row per directed follow; counts are denormalized on both accounts so the
// profile page never scans. FRIENDSHIP IS NOT STORED — mutual follow is the
// definition, computed by the client, which removes a whole class of desync
// bugs (plan §5).
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from '../schema';
import { follow } from '../schema/social';

/** The caller's follow row towards `following`, if any. */
function existingFollow(ctx: any, follower: any, following: any): any | undefined {
  const target = following.toHexString();
  return [...ctx.db.follow.follower.filter(follower)].find(row => row.following.toHexString() === target);
}

/** Local helper — keeps this file independent of the auth module. */
function player_required(ctx: any): any {
  const p = ctx.db.player.identity.find(ctx.sender);
  if (!p) throw new SenderError('No player account for this identity.');
  if (p.banned) throw new SenderError('This account is banned.');
  return p;
}

export const follow_player = spacetimedb.reducer({ target: t.identity() }, (ctx, { target }) => {
  const me = player_required(ctx);
  if (target.toHexString() === ctx.sender.toHexString()) throw new SenderError('You cannot follow yourself.');
  const them = ctx.db.player.identity.find(target);
  if (!them) throw new SenderError('No such player.');
  if (existingFollow(ctx, ctx.sender, target)) return; // idempotent

  ctx.db.follow.insert({ id: 0, follower: ctx.sender, following: target, created_at: ctx.timestamp });
  ctx.db.player.identity.update({ ...me, following_count: me.following_count + 1 });
  ctx.db.player.identity.update({ ...them, followers_count: them.followers_count + 1 });
});

export const unfollow_player = spacetimedb.reducer({ target: t.identity() }, (ctx, { target }) => {
  const me = player_required(ctx);
  const row = existingFollow(ctx, ctx.sender, target);
  if (!row) return;
  ctx.db.follow.id.delete(row.id);
  const them = ctx.db.player.identity.find(target);
  if (them) ctx.db.player.identity.update({ ...them, followers_count: Math.max(0, them.followers_count - 1) });
  ctx.db.player.identity.update({ ...me, following_count: Math.max(0, me.following_count - 1) });
});
