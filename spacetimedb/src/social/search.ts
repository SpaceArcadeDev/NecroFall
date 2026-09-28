// NECROFALL — survivor directory lookup (plan §8/§64).
//
// WHY A PROCEDURE: the client used to subscribe the WHOLE `player` table to power
// name/friend-code search — every connected player then caused a sequential scan
// of the roster on the server (SpacetimeDB flagged 209 of them) and received every
// account row update. Searching is an ON-DEMAND read, so it runs here instead:
// nothing is replicated, the caller gets a compact ranked projection back, and the
// only player-table queries left in the schema are primary-key/unique-index lookups.
//
// Ranking matches the old client-side search exactly:
//   exact code (0) → code prefix (1) → exact name (2) → name prefix (3) → substring (4).
import { t } from 'spacetimedb/server';
import { spacetimedb } from '../schema';
import { player } from '../schema/player';

/** Compact public projection — deliberately NOT the whole account row. */
export const PlayerSearchHit = t.object('PlayerSearchHit', {
  identity: t.identity(),
  player_name: t.string(),
  player_code: t.string(),
  colony: t.u8(),
  level: t.u32(),
});

const MAX_RESULTS = 24;

export const search_players = spacetimedb.procedure(
  { term: t.string() },
  t.array(PlayerSearchHit),
  (ctx, { term }) => {
    const needle = term.trim().toLowerCase();
    if (!needle) return [];
    const mine = ctx.sender.toHexString();

    // Procedures run OUTSIDE the transaction; `withTx` gives the (read) db view.
    return ctx.withTx((tx) => {
      // Candidates are collected, ranked and capped BEFORE mapping into the compact
      // projection, so no partial account data ever leaves this procedure.
      const scored: { row: any; s: number }[] = [];
      for (const p of tx.db.player.iter()) {
        if (!p.player_name || !p.player_name.trim()) continue; // not onboarded yet
        if (p.identity.toHexString() === mine) continue;       // never list yourself
        const code = (p.player_code || '').toLowerCase();
        const name = p.player_name.toLowerCase();
        let s = -1;
        if (code === needle) s = 0;
        else if (code.startsWith(needle)) s = 1;
        else if (name === needle) s = 2;
        else if (name.startsWith(needle)) s = 3;
        else if (name.includes(needle)) s = 4;
        if (s >= 0) scored.push({ row: p, s });
      }

      scored.sort((a, b) => a.s - b.s || a.row.player_name.localeCompare(b.row.player_name));
      return scored.slice(0, MAX_RESULTS).map(({ row }) => ({
        identity: row.identity,
        player_name: row.player_name,
        player_code: row.player_code,
        colony: row.colony,
        level: row.level,
      }));
    });
  }
);
