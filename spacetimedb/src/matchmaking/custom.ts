// NECROFALL — CUSTOM LOBBIES (user ask 2026-09-30).
//
// Custom mode is the P2P loop — create a lobby, share the code, friends join,
// the host starts when everyone is ready — but the match runs on the HYBRID
// server architecture: the official `match` / `match_player` rows own the
// lifecycle, the WebRTC mesh carries gameplay, the relay is the fallback and
// the verification layer audits the streams. Nothing about gameplay changes.
//
// A custom lobby IS a match row in MATCH_STARTING (status 0, mode 1) with a
// join code and a host; its seats are ordinary match_player rows with a `ready`
// flag. `start_custom_match` flips it to RUNNING and arms the same 10 Hz tick
// every official match uses — from there the client path is identical.
import { SenderError, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import { spacetimedb } from '../schema';
import { match, match_player } from '../schema/match';
import { match_event, match_tick } from '../schema/game';
import {
  EVENT_MATCH_STARTED,
  MATCH_MAX_PLAYERS,
  MATCH_MODE_CUSTOM,
  MATCH_RUNNING,
  MATCH_STARTING,
  PRESENCE_IN_MATCH,
  TICK_INTERVAL_US,
} from '../constants';
import { requireOnboarded } from '../auth/authorization';
import { player_presence } from '../schema/player';

/** No I/O/0/1 — codes are read aloud and typed by hand. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;

/** A waiting lobby nobody started dissolves after this long (2 h). */
const CUSTOM_LOBBY_TTL_US = 2n * 60n * 60n * 1_000_000n;

/**
 * Sweep (1 Hz scanner): dissolve waiting lobbies that have aged out — a host that
 * abandoned a lobby (closed tab before START) must not leave rows behind forever.
 */
export function sweepCustomLobbies(ctx: any, now: bigint): void {
  const created = (m: any): bigint =>
    m.created_at ? (m.created_at.microsSinceUnixEpoch as bigint) : now;
  for (const m of [...ctx.db.match.iter()]) {
    if (m.mode !== MATCH_MODE_CUSTOM || m.status !== MATCH_STARTING) continue;
    if (now - created(m) < CUSTOM_LOBBY_TTL_US) continue;
    for (const seat of [...ctx.db.match_player.match_id.filter(m.match_id)]) {
      ctx.db.match_player.id.delete(seat.id);
    }
    ctx.db.match.match_id.delete(m.match_id);
  }
}

function nowMicros(ctx: any): bigint {
  return ctx.timestamp.microsSinceUnixEpoch as bigint;
}

function hexOf(identity: any): string {
  return identity.toHexString();
}

/** Normalise a share code the way the UI does (upper-case, bounded). */
function normalizeCode(raw: string): string {
  const s = (raw ?? '').trim().toUpperCase().slice(0, 8);
  if (!/^[A-Z0-9]{4,8}$/.test(s)) throw new SenderError('Enter a valid lobby code.');
  return s;
}

/** Random join code, guaranteed unique among live custom lobbies. */
function freshCode(ctx: any): string {
  for (let attempt = 0; attempt < 40; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(ctx.random() * CODE_ALPHABET.length)];
    }
    let taken = false;
    for (const m of ctx.db.match.iter()) {
      if (m.mode === MATCH_MODE_CUSTOM && m.status === MATCH_STARTING && m.room_code === code) {
        taken = true;
        break;
      }
    }
    if (!taken) return code;
  }
  throw new SenderError('Could not allocate a lobby code — try again.');
}

/** The caller's live match seat, if any — one live match per player (status < 2). */
function activeMatchFor(ctx: any, identity: any): any | undefined {
  for (const mp of ctx.db.match_player.identity.filter(identity)) {
    if (mp.left) continue;
    const m = ctx.db.match.match_id.find(mp.match_id);
    if (m && m.status !== 2) return m;
  }
  return undefined;
}

/** The caller's seat in a WAITING custom lobby, with its match row. */
function myLobbySeat(ctx: any): { seat: any; m: any } | undefined {
  for (const mp of ctx.db.match_player.identity.filter(ctx.sender)) {
    const m = ctx.db.match.match_id.find(mp.match_id);
    if (m && m.mode === MATCH_MODE_CUSTOM && m.status === MATCH_STARTING && !mp.left) {
      return { seat: mp, m };
    }
  }
  return undefined;
}

function findLobbyByCode(ctx: any, code: string): any | undefined {
  for (const m of ctx.db.match.iter()) {
    if (m.mode === MATCH_MODE_CUSTOM && m.status === MATCH_STARTING && m.room_code === code) return m;
  }
  return undefined;
}

/**
 * CREATE A CUSTOM LOBBY — the caller becomes its host. A random map seed is
 * rolled up front (the world is decided even before START; harmless).
 */
export const create_custom_lobby = spacetimedb.reducer((ctx) => {
  const me = requireOnboarded(ctx);
  if (activeMatchFor(ctx, ctx.sender)) throw new SenderError('You are already in a match.');
  if (ctx.db.queue_entry.identity.find(ctx.sender)) {
    throw new SenderError('You are searching for a match — cancel the search first.');
  }

  const now = ctx.timestamp;
  const code = freshCode(ctx);
  const m = ctx.db.match.insert({
    match_id: 0,
    status: MATCH_STARTING,
    created_at: now,
    started_at: undefined,
    ended_at: undefined,
    map_seed: Math.floor(ctx.random() * 0xffffffff) >>> 0,
    winner_colony: undefined,
    duration_seconds: 0,
    server_tick: 0n,
    player_count: 1,
    empty_since: undefined,
    ranked: false,
    planet_key: '',
    rank_ring: 255,
    mode: MATCH_MODE_CUSTOM,
    room_code: code,
    host_hex: hexOf(ctx.sender),
  });
  ctx.db.match_player.insert({
    id: 0,
    match_id: m.match_id,
    identity: ctx.sender,
    name: me.player_name ?? 'Survivor',
    colony: me.colony,
    kills: 0,
    deaths: 0,
    damage: 0,
    objectives: 0,
    necrotech: 0,
    confirmed: true,
    connected: true,
    x: 0, y: 0, z: 0,
    fx: 0, fy: 0, fz: 1,
    vx: 0, vy: 0, vz: 0,
    hp: 100,
    max_hp: 100,
    alive: true,
    has_pose: false,
    stats_reported_at: 0n,
    updated_at: now,
    left: false,
    kick_reason: '',
    ready: true, // the host is ready by definition
  });
});

/** JOIN A CUSTOM LOBBY BY CODE — revives a lapsed seat, else takes an open one. */
export const join_custom_lobby = spacetimedb.reducer(
  { code: t.string() },
  (ctx, { code }) => {
    const me = requireOnboarded(ctx);
    const wanted = normalizeCode(code);
    const m = findLobbyByCode(ctx, wanted);
    if (!m) throw new SenderError('Lobby not found — check the code.');

    // Rejoining the lobby we are already in: idempotent. Any OTHER live match blocks the join.
    let seatInThis: any | undefined;
    let anyOtherLive = false;
    for (const mp of ctx.db.match_player.identity.filter(ctx.sender)) {
      if (mp.match_id === m.match_id) {
        seatInThis = mp;
        continue;
      }
      const other = ctx.db.match.match_id.find(mp.match_id);
      if (!mp.left && other && other.status !== 2) anyOtherLive = true;
    }
    if (seatInThis && !seatInThis.left) return;
    if (anyOtherLive) throw new SenderError('You are already in a match.');

    const now = ctx.timestamp;
    if (seatInThis && seatInThis.left) {
      ctx.db.match_player.id.update({
        ...seatInThis,
        left: false,
        kick_reason: '',
        connected: true,
        ready: false,
        colony: me.colony,
        name: me.player_name ?? seatInThis.name,
        updated_at: now,
      });
      let revived = 0;
      for (const mp of ctx.db.match_player.match_id.filter(m.match_id)) {
        if (!mp.left) revived++;
      }
      ctx.db.match.match_id.update({ ...m, player_count: revived });
      return;
    }

    let seats = 0;
    for (const mp of ctx.db.match_player.match_id.filter(m.match_id)) {
      if (!mp.left) seats++;
    }
    if (seats >= MATCH_MAX_PLAYERS) throw new SenderError('That lobby is full.');

    ctx.db.match_player.insert({
      id: 0,
      match_id: m.match_id,
      identity: ctx.sender,
      name: me.player_name ?? 'Survivor',
      colony: me.colony,
      kills: 0,
      deaths: 0,
      damage: 0,
      objectives: 0,
      necrotech: 0,
      confirmed: true,
      connected: true,
      x: 0, y: 0, z: 0,
      fx: 0, fy: 0, fz: 1,
      vx: 0, vy: 0, vz: 0,
      hp: 100,
      max_hp: 100,
      alive: true,
      has_pose: false,
      stats_reported_at: 0n,
      updated_at: now,
      left: false,
      kick_reason: '',
      ready: false,
    });
    ctx.db.match.match_id.update({ ...m, player_count: seats + 1 });
  }
);

/**
 * SET READY — the host's START gate. The host itself is always ready.
 */
export const set_custom_ready = spacetimedb.reducer(
  { ready: t.bool() },
  (ctx, { ready }) => {
    const found = myLobbySeat(ctx);
    if (!found) throw new SenderError('You are not in a lobby.');
    const isHost = found.m.host_hex === hexOf(ctx.sender);
    ctx.db.match_player.id.update({ ...found.seat, ready: ready || isHost });
  }
);

/**
 * SET SEAT — pick a colony (and optionally a starter class) in the lobby.
 * P2P rules: free choice, one seat per player, no colony caps.
 */
export const set_custom_seat = spacetimedb.reducer(
  { colony: t.u8(), necrotech: t.u32() },
  (ctx, { colony, necrotech }) => {
    const found = myLobbySeat(ctx);
    if (!found) throw new SenderError('You are not in a lobby.');
    if (colony > 2) throw new SenderError('Unknown colony.');
    if (necrotech > 64) throw new SenderError('Unknown Necrotech.');
    ctx.db.match_player.id.update({ ...found.seat, colony, necrotech });
  }
);

/** KICK — the host removes a seat from its lobby. */
export const kick_custom_seat = spacetimedb.reducer(
  { target: t.identity() },
  (ctx, { target }) => {
    const found = myLobbySeat(ctx);
    if (!found) throw new SenderError('You are not in a lobby.');
    if (found.m.host_hex !== hexOf(ctx.sender)) throw new SenderError('Only the host can remove players.');
    if (hexOf(target) === hexOf(ctx.sender)) throw new SenderError('The host cannot remove itself.');
    let seat: any | undefined;
    for (const mp of ctx.db.match_player.identity.filter(target)) {
      if (mp.match_id === found.m.match_id && !mp.left) {
        seat = mp;
        break;
      }
    }
    if (!seat) return;
    ctx.db.match_player.id.delete(seat.id);
    let seats = 0;
    for (const mp of ctx.db.match_player.match_id.filter(found.m.match_id)) {
      if (!mp.left) seats++;
    }
    ctx.db.match.match_id.update({ ...found.m, player_count: seats });
  }
);

/**
 * LEAVE — walk out of a WAITING lobby. The seat row is removed outright (a
 * lobby has no tombstones); a leaving HOST hands the role to the lowest seat,
 * or dissolves the lobby when it was the last one in it.
 */
export const leave_custom_lobby = spacetimedb.reducer((ctx) => {
  const found = myLobbySeat(ctx);
  if (!found) {
    // A started match is left through `leave_match` — this reducer is a no-op then.
    return;
  }
  const { seat, m } = found;
  ctx.db.match_player.id.delete(seat.id);
  const rest = [...ctx.db.match_player.match_id.filter(m.match_id)].filter(mp => !mp.left);
  if (rest.length === 0) {
    ctx.db.match.match_id.delete(m.match_id);
    return;
  }
  let nextHost = m.host_hex;
  if (m.host_hex === hexOf(ctx.sender)) {
    rest.sort((a, b) => a.id - b.id);
    nextHost = hexOf(rest[0].identity);
  }
  ctx.db.match.match_id.update({ ...m, host_hex: nextHost, player_count: rest.length });
});

/**
 * START MATCH — the host (and only the host) flips the lobby to a RUNNING
 * hybrid match once every other seat is ready. The tail mirrors `createMatch`:
 * usage skeleton, opening event, 10 Hz tick — the client boot path is the
 * ordinary official one from the first frame on.
 */
export const start_custom_match = spacetimedb.reducer((ctx) => {
  const found = myLobbySeat(ctx);
  if (!found) throw new SenderError('You are not in a lobby.');
  const { m } = found;
  if (m.host_hex !== hexOf(ctx.sender)) throw new SenderError('Only the host can start the match.');

  const seats = [...ctx.db.match_player.match_id.filter(m.match_id)].filter(mp => !mp.left);
  if (seats.length === 0) throw new SenderError('Nobody is in this lobby.');
  for (const s of seats) {
    if (hexOf(s.identity) === m.host_hex) continue;
    if (!s.ready) throw new SenderError('Every survivor must be ready first.');
  }

  const now = ctx.timestamp;
  const micros = nowMicros(ctx);
  void micros;
  ctx.db.match.match_id.update({
    ...m,
    status: MATCH_RUNNING,
    started_at: now,
    duration_seconds: 0,
    server_tick: 0n,
    player_count: seats.length,
    empty_since: undefined,
  });
  for (const s of seats) {
    const presence = ctx.db.player_presence.identity.find(s.identity);
    if (presence) {
      ctx.db.player_presence.identity.update({ ...presence, status: PRESENCE_IN_MATCH, last_seen: now });
    }
  }

  ctx.db.match_server_usage.insert({
    match_id: m.match_id,
    started_at: now,
    ended_at: undefined,
    duration_seconds: 0,
    player_count: seats.length,
    server_ticks: 0n,
    input_commands: 0n,
    state_updates: 0n,
    events: 0n,
    estimated_egress_bytes: 0n,
    storage_bytes: 0n,
  });
  ctx.db.match_event.insert({
    id: 0,
    match_id: m.match_id,
    kind: EVENT_MATCH_STARTED,
    a: 0, b: 0,
    x: 0, y: 0, z: 0,
    at: now,
  });
  ctx.db.match_tick.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.interval(TICK_INTERVAL_US),
    match_id: m.match_id,
  });
});
