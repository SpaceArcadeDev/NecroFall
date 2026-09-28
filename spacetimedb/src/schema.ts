// NECROFALL — the module schema. Every table is registered here exactly once;
// reducers import this builder (`spacetimedb`) and the table refs.
import { schema } from 'spacetimedb/server';

import { admin_identity, player, player_inventory, player_loadout, player_presence, player_settings, player_stats, player_wallet } from './schema/player';
import { follow, profile_view } from './schema/social';
import { candidate_match, match_candidate_player, matchmaking_scan, party, party_member, queue_entry } from './schema/matchmaking';
import { match, match_history, match_input, match_player, match_server_usage } from './schema/match';
import { match_entity, match_event, match_objective, match_tick } from './schema/game';
import { planet_control_history, planet_discovery, rank_history, ranked_planet, ranked_planet_reservation, ranked_season } from './schema/ranked';

export const spacetimedb = schema({
  // player
  admin_identity,
  player,
  player_stats,
  player_wallet,
  player_inventory,
  player_loadout,
  player_presence,
  player_settings,
  // social
  follow,
  profile_view,
  // matchmaking
  party,
  party_member,
  queue_entry,
  candidate_match,
  match_candidate_player,
  matchmaking_scan,
  // match
  match,
  match_player,
  match_input,
  match_history,
  match_server_usage,
  // live world
  match_tick,
  match_entity,
  match_objective,
  match_event,
  // ranked mode (plan §33–§57)
  ranked_season,
  ranked_planet,
  planet_discovery,
  ranked_planet_reservation,
  planet_control_history,
  rank_history,
});

export {
  admin_identity,
  candidate_match,
  follow,
  match,
  match_candidate_player,
  match_entity,
  match_event,
  match_history,
  match_input,
  match_objective,
  match_player,
  match_server_usage,
  match_tick,
  matchmaking_scan,
  party,
  party_member,
  planet_control_history,
  planet_discovery,
  player,
  player_inventory,
  player_loadout,
  player_presence,
  player_settings,
  player_stats,
  player_wallet,
  profile_view,
  queue_entry,
  rank_history,
  ranked_planet,
  ranked_planet_reservation,
  ranked_season,
};
