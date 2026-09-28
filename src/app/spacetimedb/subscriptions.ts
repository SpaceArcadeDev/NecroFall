// NECROFALL — subscription strategy (plan §48).
//
// Scopes map one-to-one onto screens: account rows on login, friend summaries
// on the main menu, the viewed profile on the profile page, the queue/candidate
// on the play page, and only the current match during a match. Unsubscribing a
// scope removes its rows from the client cache again — players are never wired
// to the whole database.
import { SpacetimeConnection } from './connection';
import { SpacetimeSubscriptionHandle } from './bindings';

const scopeHandles = new Map<string, SpacetimeSubscriptionHandle>();
const scopeQueries = new Map<string, string[]>();

function hexLiteral(hex: string): string {
  return `0x${hex}`;
}

/** (Re)subscribe one scope, replacing any previous queries under that name. */
export function subscribeScope(name: string, queries: string[]): void {
  releaseScope(name, false);
  scopeQueries.set(name, queries);
  applyScope(name);
}

function applyScope(name: string): void {
  const queries = scopeQueries.get(name);
  const conn = SpacetimeConnection.shared.current;
  if (!conn || !queries || queries.length === 0) return;
  try {
    const sub = conn
      .subscriptionBuilder()
      .onError((_ctx, err) => console.warn(`[NECROFALL] subscription "${name}" error:`, err?.message ?? err))
      .subscribe(queries);
    SpacetimeConnection.shared.track(sub);
    scopeHandles.set(name, sub);
  } catch (err) {
    console.warn(`[NECROFALL] subscription "${name}" failed`, err);
  }
}

/**
 * Subscribe a scope UNLESS an identical one is already live. Panels call the
 * per-player helpers on every data tick; without this guard each render would
 * release/re-create subscriptions (and the SDK would replay every row).
 */
export function ensureScope(name: string, queries: string[]): void {
  if (scopeHandles.has(name)) return;
  subscribeScope(name, queries);
}

export function releaseScope(name: string, forget = true): void {
  const handle = scopeHandles.get(name);
  if (handle) {
    scopeHandles.delete(name);
    try {
      handle.unsubscribe();
    } catch {
      /* already gone */
    }
  }
  if (forget) scopeQueries.delete(name);
}

export function releaseAllScopes(): void {
  for (const name of [...scopeHandles.keys()]) releaseScope(name, false);
  scopeQueries.clear();
}

/** Re-arm every active scope after a reconnect (and once at boot). */
export function resubscribeAllScopes(): void {
  for (const name of scopeQueries.keys()) applyScope(name);
}

// The connection drop wipes the client cache; reconnect re-applies the scopes.
SpacetimeConnection.shared.onConnect(() => resubscribeAllScopes());

// ------------------------------------------------------------ scope builders

/** The account's own world: player, wallet, inventory, loadout, stats, presence, follow graph, own queue views. */
export function subscribeAccount(hex: string): void {
  subscribeScope('account', [
    // OWN row only. The whole-roster subscription is GONE: it made every client
    // sequentially scan `player` (SpacetimeDB advisor: 209 subscription scans) and
    // replicated every account row update to everyone. Name/friend-code search now
    // runs through the `searchPlayers` procedure, and other players' rows arrive
    // through the per-hex `subscribePlayer` scopes below.
    `SELECT * FROM player WHERE identity = ${hexLiteral(hex)}`,
    `SELECT * FROM player_wallet WHERE identity = ${hexLiteral(hex)}`,
    `SELECT * FROM player_inventory WHERE identity = ${hexLiteral(hex)}`,
    `SELECT * FROM player_loadout WHERE identity = ${hexLiteral(hex)}`,
    `SELECT * FROM player_stats WHERE identity = ${hexLiteral(hex)}`,
    `SELECT * FROM player_presence WHERE identity = ${hexLiteral(hex)}`,
    `SELECT * FROM player_settings WHERE identity = ${hexLiteral(hex)}`,
    `SELECT * FROM follow WHERE follower = ${hexLiteral(hex)}`,
  ]);
}

/** The queue + candidate views and the seats that tell us a match started. */
export function subscribeMatchmaking(hex: string): void {
  subscribeScope('matchmaking', [
    `SELECT * FROM my_queue_entry`,
    `SELECT * FROM my_candidate`,
    `SELECT * FROM my_candidate_players`,
    `SELECT * FROM match_player WHERE identity = ${hexLiteral(hex)}`,
    // Parties: membership, members and the invite code — the OFFICIAL lobby reads these.
    'SELECT * FROM party',
    'SELECT * FROM party_member',
  ]);
}

/** One player's summary + presence (friend rail, viewer avatars, party members). */
export function subscribePlayer(hex: string): void {
  ensureScope(`player:${hex}`, [
    `SELECT * FROM player WHERE identity = ${hexLiteral(hex)}`,
    `SELECT * FROM player_presence WHERE identity = ${hexLiteral(hex)}`,
  ]);
}

/** A full profile page: the target's public data, stats, history and the follow edges both ways. */
export function subscribeProfile(hex: string): void {
  ensureScope(`profile:${hex}`, [
    `SELECT * FROM player WHERE identity = ${hexLiteral(hex)}`,
    `SELECT * FROM player_stats WHERE identity = ${hexLiteral(hex)}`,
    `SELECT * FROM player_presence WHERE identity = ${hexLiteral(hex)}`,
    `SELECT * FROM player_loadout WHERE identity = ${hexLiteral(hex)}`,
    `SELECT * FROM match_history WHERE identity = ${hexLiteral(hex)}`,
    `SELECT * FROM follow WHERE follower = ${hexLiteral(hex)}`,
    `SELECT * FROM follow WHERE following = ${hexLiteral(hex)}`,
    `SELECT * FROM profile_view WHERE profile = ${hexLiteral(hex)}`,
  ]);
}

export function releaseProfile(hex: string): void {
  releaseScope(`profile:${hex}`);
}

/** The running match: the row, every seat and its events. */
export function subscribeMatch(matchId: number): void {
  ensureScope(`match:${matchId}`, [
    `SELECT * FROM match WHERE match_id = ${matchId}`,
    `SELECT * FROM match_player WHERE match_id = ${matchId}`,
    `SELECT * FROM match_event WHERE match_id = ${matchId}`,
  ]);
}

export function releaseMatch(matchId: number): void {
  releaseScope(`match:${matchId}`);
}
