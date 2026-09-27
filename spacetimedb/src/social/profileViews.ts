// NECROFALL — profile views (plan §6).
//
// UPSERT, never append: one row per (viewer, profile) pair. A repeat visit
// inside VIEW_COOLDOWN only refreshes nothing — it is simply ignored — so
// refreshing a page cannot inflate anyone's numbers or spam writes.
import { t } from 'spacetimedb/server';
import { spacetimedb } from '../schema';
import { profile_view } from '../schema/social';

/** One counted view per viewer per hour. */
const VIEW_COOLDOWN_US = 60n * 60n * 1_000_000n;

export const record_profile_view = spacetimedb.reducer({ profile: t.identity() }, (ctx, { profile }) => {
  if (profile.toHexString() === ctx.sender.toHexString()) return; // own profile is not a view
  const viewer = ctx.sender;
  const existing = [...ctx.db.profile_view.viewer.filter(viewer)]
    .find(row => row.profile.toHexString() === profile.toHexString());

  const now = ctx.timestamp.microsSinceUnixEpoch as bigint;
  // Always throttle writes; if a row exists we only update when the cooldown passed.
  const lastUs = existing ? (existing.last_viewed_at.microsSinceUnixEpoch as bigint) : 0n;
  if (existing && now - lastUs < VIEW_COOLDOWN_US) return;

  if (existing) {
    ctx.db.profile_view.id.update({ ...existing, last_viewed_at: ctx.timestamp, view_count: existing.view_count + 1 });
  } else {
    ctx.db.profile_view.insert({
      id: 0,
      viewer,
      profile,
      last_viewed_at: ctx.timestamp,
      view_count: 1,
    });
  }

  // Denormalized headline counter on the profile itself (read by the header).
  const target = ctx.db.player.identity.find(profile);
  if (target && (!existing || now - lastUs >= VIEW_COOLDOWN_US)) {
    ctx.db.player.identity.update({ ...target, profile_views: target.profile_views + 1 });
  }
});
