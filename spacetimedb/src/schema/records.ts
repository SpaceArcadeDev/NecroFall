// NECROFALL — planet records + first-play log (user ask 2026-09-30).
//
// Two small public tables back the SOLO modes and the planet info overlay:
//
//   planet_record — the BEST run per (planet, mode): fastest speedrun win and
//                   longest survival, each with the holder's name.
//   planet_play   — the first MAX_PLANET_PLAYS players to play the planet in ANY
//                   mode (ranked matches are logged by `createMatch`, solo runs
//                   report in through `record_planet_play`). This is the overlay's
//                   DISCOVERED BY list, merged with the ranked discovery log.
//
// Records are COMMUNITY data (like P2P stats): the server validates shape and
// bounds, never gameplay — the solo match runs on the player's own machine.
import { table, t } from 'spacetimedb/server';

export const planet_record = table(
  { name: 'planet_record', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    /** Canonical `ring:g:s:p` planet key. */
    planet_key: t.string().index('btree'),
    /** RECORD_MODE_SPEEDRUN (0) / RECORD_MODE_SURVIVAL (1). */
    mode: t.u8(),
    /** The recorded time in milliseconds (speedrun: lowest wins; survival: highest). */
    time_ms: t.u64(),
    player_name: t.string(),
    identity: t.identity(),
    set_at: t.timestamp(),
  }
);

export const planet_play = table(
  { name: 'planet_play', public: true },
  {
    id: t.u32().primaryKey().autoInc(),
    /** Canonical `ring:g:s:p` planet key. */
    planet_key: t.string().index('btree'),
    identity: t.identity(),
    player_name: t.string(),
    /** 0-based discovery order (0 = first footfall), capped at MAX_PLANET_PLAYS - 1. */
    slot: t.u8(),
    first_played_at: t.timestamp(),
  }
);
