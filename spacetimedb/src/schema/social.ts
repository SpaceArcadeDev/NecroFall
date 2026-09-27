// NECROFALL — social schema (plan §5/§6/§24).
//
// Friendship is NOT stored: it is `A follows B AND B follows A`, computed by the
// client from the follow table. That removes the "follow=true friend=false"
// desync class of bugs entirely.
import { table, t } from 'spacetimedb/server';

export const follow = table(
  { name: 'follow', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    follower: t.identity().index('btree'),
    following: t.identity().index('btree'),
    created_at: t.timestamp(),
  }
);

/**
 * Upserted per (viewer, profile) pair — one row total, never appended per visit
 * (plan §6). `last_viewed_at` is throttled so refreshing a page is not a write.
 */
export const profile_view = table(
  { name: 'profile_view', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    viewer: t.identity().index('btree'),
    profile: t.identity().index('btree'),
    last_viewed_at: t.timestamp(),
    view_count: t.u32(),
  }
);
