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
    // Rank movements (plan §57/§80): the post-match overlay reads the newest row.
    `SELECT * FROM rank_history WHERE identity = ${hexLiteral(hex)}`,
  ]);
}

/** The queue + candidate views and the seats that tell us a match started. */
export function subscribeMatchmaking(hex: string): void {
  subscribeScope('matchmaking', [
    `SELECT * FROM my_queue_entry`,
    `SELECT * FROM my_candidate`,
    `SELECT * FROM my_candidate_players`,
    // The server usage summary of the caller's LATEST match — the debug block on the end screen.
    // It rode no scope before, so `matchEnded` always shipped `usage: undefined` and the results
    // screen never showed the SpacetimeDB numbers (user report).
    `SELECT * FROM my_match_usage`,
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

// ------------------------------------------------------------ ranked map (plan §61)

/**
 * The RANK page's world (plan §61 — never subscribe the whole universe):
 * the season seed, the top leaderboard, every ACTIVE reservation (a tiny
 * transient table) and the caller's own rank history. Galaxies and planets
 * are subscribed on demand as the player explores.
 */
export function subscribeRank(): void {
  subscribeScope('rank', [
    'SELECT * FROM ranked_season',
    'SELECT * FROM ranked_planet_reservation',
    'SELECT * FROM ranked_top',
    // The server's own clock (one tiny row, stamped every second by the scan):
    // shield countdowns render on SERVER time, not the device clock (plan §14).
    'SELECT * FROM server_clock',
  ]);
}

export function releaseRank(): void {
  releaseScope('rank');
}

/** One galaxy's persistent planet rows (only discovered/controlled planets have any). */
export function subscribeRankGalaxy(galaxyId: number): void {
  ensureScope(`rank-galaxy:${galaxyId}`, [`SELECT * FROM ranked_planet WHERE galaxy_id = ${galaxyId}`]);
}

/** One planet's discovery + ownership history (the detail panel). */
export function subscribePlanetDetail(planetKey: string): void {
  if (!planetKey || !/^[0-9:]+$/.test(planetKey)) return;
  ensureScope(`rank-planet:${planetKey}`, [`SELECT * FROM planet_control_history WHERE planet_key = '${planetKey}'`]);
}

// ------------------------------------------------------------ scoped discovery (plan §43)

/**
 * Discovery rows of ONE location — the galaxy / system / planet the expanded
 * panel is showing. Never the whole universe: the map can hold thousands of
 * galaxies, so only the location on screen is subscribed (plan §43).
 */
export function subscribeLocationDiscovery(locationKey: string): void {
  if (!locationKey || !/^[G0-9:SP-]+$/.test(locationKey)) return;
  ensureScope(`rank-disc:${locationKey}`, [
    `SELECT * FROM ranked_location_discovery WHERE location_key = '${locationKey}'`,
  ]);
}

/** Release one discovery scope when the panel moves on (keeps LRU bounds). */
export function releaseLocationDiscovery(locationKey: string): void {
  if (!locationKey) return;
  releaseScope(`rank-disc:${locationKey}`);
}
