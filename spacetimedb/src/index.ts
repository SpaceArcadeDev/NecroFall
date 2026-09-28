// NECROFALL — SpacetimeDB module entry.
//
//   Players:  identity, profile, wallet, inventory, loadout, stats, presence.
//   Social:   follow graph, profile views.
//   Official: matchmaking queue -> candidate -> confirmation -> authoritative
//             10 Hz match simulation -> server-computed results & rewards.
//   P2P:      untouched by this module; community games report into separate
//             counters via `submit_peer_result` and never touch official data.
//
// Build/publish: see spacetimedb/README.md.
import { spacetimedb } from './schema';
import { armMatchmakingScan } from './matchmaking/queue';
import { ensureActiveSeason } from './ranked/planets';

// ---- lifecycle
export { on_client_connected, on_client_disconnected } from './auth/connect';

// ---- account / profile / cosmetics / admin (plan §3/§7/§42/§63–§66)
export {
  choose_colony,
  set_player_name,
  set_profile_name,
  set_profile_picture,
  set_avatar,
  equip_item,
  set_keybinds,
  submit_peer_result,
  claim_admin,
  grant_currency_admin,
  grant_item_admin,
  set_ban_admin,
} from './account/account';

// ---- parties + matchmaking (plan §12/§14/§72)
export { create_party, join_party, join_party_by_code, leave_party, kick_from_party, set_party_loadout } from './matchmaking/party';
export { find_match, cancel_find_match, matchmaking_scan_tick } from './matchmaking/queue';
export { confirm_match, decline_match } from './matchmaking/confirmation';

// ---- the official game server (plan §16–§19/§40/§74)
export { submit_input, sync_pose, match_sim_tick, leave_match, join_match, report_nexus_capture } from './game/simulation';
export { report_match_stats } from './game/rewards';

// ---- social (plan §5/§6)
export { follow_player, unfollow_player } from './social/follow';
export { record_profile_view } from './social/profileViews';
// On-demand directory lookup (procedure — no whole-table subscription, plan §64).
export { search_players } from './social/search';

// ---- ranked mode (plan §33–§60)
export { discover_planet, colony_stats } from './ranked/planets';
export { discover_location } from './ranked/discovery';
export { find_ranked_match } from './ranked/matchmaking';

// ---- views (plan §22/§23)
export { my_queue_entry, my_candidate, my_candidate_players, my_match_usage, ranked_top } from './views';

/**
 * Arm the global 1 Hz matchmaking scanner exactly once, when the database is
 * created (plan §40: ONE scanner row for the whole queue — never per player).
 */
export const init = spacetimedb.init((ctx) => {
  armMatchmakingScan(ctx);
  ensureActiveSeason(ctx);
});

export default spacetimedb;
