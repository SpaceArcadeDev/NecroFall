// NECROFALL — SOLO-MODE PLANET RECORDS (user ask 2026-09-30).
//
// Speedrun and survival run entirely on the player's own machine; the server is
// the RECORD BOARD. These reducers are deliberately permissive about gameplay
// (like P2P community stats) but strict about shape: canonical planet keys, a
// known mode, and a plausible time window — so a typo can never poison a row.
//
// `record_planet_play` logs the first MAX_PLANET_PLAYS players to touch a planet
// in ANY mode. Ranked matches do this server-side from `createMatch`; the solo
// modes call in when their run boots. The planet info overlay merges this log
// with the ranked discovery list for its DISCOVERED BY block.
import { SenderError, t } from 'spacetimedb/server';
import { spacetimedb } from '../schema';
import { planet_play, planet_record } from '../schema/records';
import {
  MAX_PLANET_PLAYS,
  RECORD_MAX_SPEEDRUN_MS,
  RECORD_MAX_SURVIVAL_MS,
  RECORD_MIN_SPEEDRUN_MS,
  RECORD_MIN_SURVIVAL_MS,
  RECORD_MODE_SPEEDRUN,
  RECORD_MODE_SURVIVAL,
} from '../constants';
import { requireOnboarded } from '../auth/authorization';
import { parsePlanetKey } from './seed';

/** Canonical key validation shared by both reducers. */
function requireCanonicalKey(key: string): { ring: number; galaxyId: number; systemId: number; planetId: number } {
  const parsed = parsePlanetKey(key);
  if (!parsed) throw new SenderError('That planet key is not valid.');
  return parsed;
}

/** The record row for one (planet, mode), if any. */
function findRecord(ctx: any, key: string, mode: number): any | undefined {
  for (const row of ctx.db.planet_record.planet_key.filter(key)) {
    if (row.mode === mode) return row;
  }
  return undefined;
}

/**
 * SUBMIT A PLANET RECORD (speedrun finish / survival death).
 * Speedrun keeps the LOWEST time, survival the HIGHEST; only a better time
 * replaces the row (name and holder move with it).
 */
export const submit_planet_record = spacetimedb.reducer(
  { mode: t.u8(), planet_key: t.string(), time_ms: t.u64() },
  (ctx, { mode, planet_key, time_ms }) => {
    const me = requireOnboarded(ctx);
    if (mode !== RECORD_MODE_SPEEDRUN && mode !== RECORD_MODE_SURVIVAL) {
      throw new SenderError('Unknown record mode.');
    }
    requireCanonicalKey(planet_key);
    if (mode === RECORD_MODE_SPEEDRUN) {
      if (time_ms < RECORD_MIN_SPEEDRUN_MS || time_ms > RECORD_MAX_SPEEDRUN_MS) {
        throw new SenderError('That speedrun time is outside the plausible window.');
      }
    } else if (time_ms < RECORD_MIN_SURVIVAL_MS || time_ms > RECORD_MAX_SURVIVAL_MS) {
      throw new SenderError('That survival time is outside the plausible window.');
    }

    const now = ctx.timestamp;
    const row = findRecord(ctx, planet_key, mode);
    const better = !row || (mode === RECORD_MODE_SPEEDRUN ? time_ms < row.time_ms : time_ms > row.time_ms);
    if (!better) return;
    if (row) {
      ctx.db.planet_record.id.update({
        ...row,
        time_ms,
        player_name: me.player_name,
        identity: ctx.sender,
        set_at: now,
      });
    } else {
      ctx.db.planet_record.insert({
        id: 0,
        planet_key,
        mode,
        time_ms,
        player_name: me.player_name,
        identity: ctx.sender,
        set_at: now,
      });
    }
  }
);

/**
 * The shared first-play logger. One row per (planet, identity); the first
 * MAX_PLANET_PLAYS unique players get a slot, later players are no-ops.
 * Exported so `createMatch` can log ranked seats through the same path.
 */
export function recordPlanetPlayInternal(
  ctx: any,
  key: string,
  identity: any,
  name: string,
  now: any
): void {
  let count = 0;
  const myHex = identity.toHexString();
  for (const row of ctx.db.planet_play.planet_key.filter(key)) {
    if (row.identity.toHexString() === myHex) return; // already on the board
    count++;
  }
  if (count >= MAX_PLANET_PLAYS) return;
  ctx.db.planet_play.insert({
    id: 0,
    planet_key: key,
    identity,
    player_name: name || 'Survivor',
    slot: count,
    first_played_at: now,
  });
}

/** RECORD A PLANET PLAY (solo modes) — no-op when full or already logged. */
export const record_planet_play = spacetimedb.reducer(
  { planet_key: t.string() },
  (ctx, { planet_key }) => {
    const me = requireOnboarded(ctx);
    requireCanonicalKey(planet_key);
    recordPlanetPlayInternal(ctx, planet_key, ctx.sender, me.player_name, ctx.timestamp);
  }
);
