// NECROFALL — OFFICIAL multiplayer provider (plan §10/§12–§28/§77).
//
// Bridges three worlds:
//   • the shell's matchmaking UI   (queue/candidate state, events),
//   • SpacetimeDB                  (reducers + subscribed rows),
//   • the 3D game                  (pose messages via `OfficialGameBridge`).
//
// THE COST RULE (plan §18/§77): the game hands us a pose 20×/s; we do NOT
// forward that. We diff it and call `submitInput` only when direction/speed/
// aim/dash materiality changes, plus a 1 Hz heartbeat while moving and a
// `syncPose` correction every ~2.5 s. Holding one stick direction costs ~1
// reducer per second no matter the frame rate.
import { ClientCache } from '../spacetimedb/cache';
import { SpacetimeConnection } from '../spacetimedb/connection';
import {
  submitInput,
  syncPose,
  findMatch,
  cancelFindMatch,
  confirmMatch,
  declineMatch,
  createParty,
  joinParty,
  joinPartyByCode,
  kickFromParty,
  leaveParty,
  setPartyLoadout,
  leaveMatch as leaveMatchReducer,
  joinMatch as joinMatchReducer,
} from '../spacetimedb/reducers';
import { hexOf, Identity, MatchPlayerRow, PlayerRow } from '../spacetimedb/rows';
import { subscribeMatch, subscribePlayer, releaseMatch } from '../spacetimedb/subscriptions';
import { loadSelection, selectionToWire } from '../../customization/CustomizationStore';
import { MultiplayerProvider, ProviderConnectionState, ProviderGameEvent } from './MultiplayerProvider';
import {
  OfficialGameApi,
  OfficialGameBridge,
  OfficialGamePlayerInfo,
  OfficialMatchPayload,
  OfficialStateMessage,
} from './OfficialTypes';

/** Movement sent to the server at most this often while actively moving (heartbeat). */
const MOVE_HEARTBEAT_S = 1.0;
/** Absolute pose correction cadence. */
const POSE_SYNC_S = 2.5;
/** Direction change that counts as material (degrees). */
const DIR_EPS_DEG = 12;
/** Aim change that counts as material (degrees). */
const AIM_EPS_DEG = 10;
/** Speed change that counts as material (u/s). */
const SPEED_EPS = 1.4;

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function angleBetween(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const la = Math.hypot(ax, ay, az);
  const lb = Math.hypot(bx, by, bz);
  if (la < 1e-4 || lb < 1e-4) return 0;
  const dot = Math.min(1, Math.max(-1, (ax * bx + ay * by + az * bz) / (la * lb)));
  return (Math.acos(dot) * 180) / Math.PI;
}

export class OfficialMultiplayerProvider implements MultiplayerProvider, OfficialGameBridge {
  readonly mode = 'official' as const;

  private myHex = '';
  private myGameId = '';
  private gameApi: OfficialGameApi | null = null;
  private matchId = 0;
  private payload: OfficialMatchPayload | null = null;
  private matchEndEmitted = false;
  /** Matches this session already FINISHED — they must never pull the player back in. */
  private endedMatchIds = new Set<number>();

  // pose diffing state (all in local seconds / world units)
  private lastPos = { x: 0, y: 0, z: 0, t: 0 };
  private lastDir = { x: 0, y: 0, z: 0 };
  private lastAim = { x: 0, y: 0, z: 1 };
  private lastSpeed = 0;
  private lastDash = false;
  private lastAlive = true;
  private lastInputSentAt = 0;
  private lastPoseSentAt = 0;
  private forcePose = true;
  private seq = 0n;

  // remote application bookkeeping
  private appliedPoses = new Map<string, bigint>();
  private cacheUnsub: (() => void) | null = null;

  private gameListeners = new Set<(e: ProviderGameEvent) => void>();
  private stateListeners = new Set<(s: ProviderConnectionState) => void>();
  private lastQueueSignature = '';
  private lastCandidateSignature = '';

  // ------------------------------------------------------------ lifecycle

  /** Once the SDK connection is up: wire the cache and start watching matchmaking. */
  start(): void {
    this.myHex = SpacetimeConnection.shared.identityHex;
    this.myGameId = this.gameIdFor(this.myHex);
    if (!this.cacheUnsub) {
      this.cacheUnsub = ClientCache.shared.onChange(() => this.onCacheChanged());
    }
    this.onCacheChanged();
  }

  stop(): void {
    this.cacheUnsub?.();
    this.cacheUnsub = null;
    if (this.matchId) releaseMatch(this.matchId);
    this.appliedPoses.clear();
    this.matchId = 0;
    this.payload = null;
    this.matchEndEmitted = false;
    this.gameApi = null;
  }

  /** A finished match: drop its subscription and state, stay ready for the next queue. */
  resetMatch(): void {
    if (this.matchId) releaseMatch(this.matchId);
    this.matchId = 0;
    this.payload = null;
    this.matchEndEmitted = false;
    this.appliedPoses.clear();
    this.gameApi = null;
    this.lastQueueSignature = '';
    this.lastCandidateSignature = '';
  }

  // ------------------------------------------------------------ provider api

  async connect(): Promise<void> {
    await SpacetimeConnection.shared.connect();
  }

  async disconnect(): Promise<void> {
    this.stop();
  }

  async createLobby(): Promise<boolean> {
    this.findMatch();
    return true;
  }

  async joinLobby(): Promise<boolean> {
    this.findMatch();
    return true;
  }

  async leaveLobby(): Promise<void> {
    cancelFindMatch();
  }

  findMatch(): void {
    findMatch();
  }

  cancelFindMatch(): void {
    cancelFindMatch();
  }

  confirmMatch(): void {
    confirmMatch();
  }

  declineMatch(): void {
    declineMatch();
  }

  createParty(): void {
    createParty(this.myOutfit());
  }

  joinPartyByCode(code: string): void {
    joinPartyByCode(code, this.myOutfit());
  }

  joinParty(partyId: number): void {
    joinParty(partyId, this.myOutfit());
  }

  leaveParty(): void {
    leaveParty();
  }

  kickFromParty(target: Identity): void {
    kickFromParty(target);
  }

  /** Keep the party row's outfit wire current (the line-up renders every member's figure). */
  refreshPartyLoadout(): void {
    setPartyLoadout(this.myOutfit());
  }

  /** The caller's current outfit wire — party members render this on the line-up. */
  private myOutfit(): string {
    return selectionToWire(loadSelection());
  }

  sendInput(input: unknown): void {
    this.sendLocalState(input as OfficialStateMessage);
  }

  sendAbility(): void {
    // Milestone: abilities are still simulated locally; casts are validated by
    // the server in a later Phase 8 step (plan §74). Intentionally empty.
  }

  getPlayers(): string[] {
    if (!this.matchId) return [];
    return ClientCache.shared.matchPlayers(this.matchId).map(r => r.name);
  }

  getWorldState(): unknown {
    if (!this.matchId) return { mode: 'official', matchId: 0 };
    const players = ClientCache.shared.matchPlayers(this.matchId);
    return { mode: 'official', matchId: this.matchId, players: players.map(p => ({ name: p.name, colony: p.colony })) };
  }

  getMatchState(): unknown {
    if (!this.matchId) return { status: 'idle' };
    const m = ClientCache.shared.match(this.matchId);
    return m ? { status: m.status, durationSeconds: m.durationSeconds, winnerColony: m.winnerColony ?? null } : { status: 'loading' };
  }

  onGameEvent(cb: (event: ProviderGameEvent) => void): () => void {
    this.gameListeners.add(cb);
    return () => this.gameListeners.delete(cb);
  }

  onConnectionState(cb: (state: ProviderConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    cb(this.connectionState());
    return () => this.stateListeners.delete(cb);
  }

  endMatch(): void {
    // The server decides when a match ends (plan §27). A client "end" is just
    // leaving: the disconnect lifecycle marks the seat disconnected.
  }

  /**
   * LEAVE MATCH (the pause menu): abandon the seat server-side and drop every local trace.
   * `leftMatchId` makes sure nothing (row ticks, a reload) can pull this client back into the
   * match it just left — the old bug was exactly that pull-back ("leave not working").
   */
  leaveMatch(): void {
    if (!this.matchId) return;
    this.leftMatchId = this.matchId;
    this.resetMatch();
    leaveMatchReducer();
  }

  /** The match id this session has already walked out of (never auto-rejoin it). */
  private leftMatchId: number | null = null;

  /** The boot payload for the game, available once a match has started. */
  getMatchPayload(): OfficialMatchPayload | null {
    return this.payload;
  }

  /**
   * Fresh view of the current candidate (display-only; recomputed on demand so
   * the confirmation countdown can tick between row updates).
   */
  currentCandidateInfo(): {
    deadlineSeconds: number;
    seats: { colony: number; confirmed: boolean; me: boolean }[];
    myConfirmed: boolean;
    filling: boolean;
  } | null {
    const cache = ClientCache.shared;
    const candidate = cache.myCandidate();
    if (!candidate) return null;
    const seats = cache.myCandidatePlayers();
    const mySeat = seats.find(s => hexOf(s.identity) === this.myHex);
    return {
      deadlineSeconds: Math.max(0, (Number(candidate.deadline) - this.serverNowUs()) / 1e6),
      seats: seats.map(s => ({ colony: s.colony, confirmed: s.confirmed, me: hexOf(s.identity) === this.myHex })),
      myConfirmed: Boolean(mySeat?.confirmed),
      filling: candidate.status === 0,
    };
  }

  // ------------------------------------------------------------ game bridge

  attachGame(api: OfficialGameApi): void {
    this.gameApi = api;
    this.forcePose = true;
    this.lastInputSentAt = 0;
    this.lastPoseSentAt = 0;
    this.appliedPoses.clear();
    if (this.payload) {
      // Re-send the initial spawn pose right away so other clients see us.
      window.setTimeout(() => this.sendPoseNow(), 400);
      window.setTimeout(() => this.sendPoseNow(), 1400);
    }
  }

  /**
   * The plan §18/§77 gate. Called at 20 Hz by the game; sends at most a few
   * reducer calls per second.
   */
  sendLocalState(msg: OfficialStateMessage): void {
    if (!this.matchId || !this.myHex) return;
    const s = msg.state ?? {};
    const now = performance.now() / 1000;
    const x = Number(s.x) || 0;
    const y = Number(s.y) || 0;
    const z = Number(s.z) || 0;
    const fx = Number(s.fx) || 0;
    const fy = Number(s.fy) || 0;
    const fz = Number(s.fz) || 1;
    const alive = Number(s.alive) !== 0;
    const dash = Number(s.dsh) > 0;

    // Implied world velocity from successive poses (the wire has no velocity).
    const dt = this.lastPos.t > 0 ? Math.max(1 / 60, now - this.lastPos.t) : 0;
    let vx = 0, vy = 0, vz = 0;
    if (dt > 0) {
      vx = (x - this.lastPos.x) / dt;
      vy = (y - this.lastPos.y) / dt;
      vz = (z - this.lastPos.z) / dt;
    }
    const speed = Math.hypot(vx, vy, vz);
    const dirX = speed > 0.2 ? vx / speed : 0;
    const dirY = speed > 0.2 ? vy / speed : 0;
    const dirZ = speed > 0.2 ? vz / speed : 0;

    const dirChanged = angleBetween(dirX, dirY, dirZ, this.lastDir.x, this.lastDir.y, this.lastDir.z) > DIR_EPS_DEG
      && (speed > 0.2 || this.lastSpeed > 0.2);
    const speedChanged = Math.abs(speed - this.lastSpeed) > SPEED_EPS
      || (speed <= 0.2) !== (this.lastSpeed <= 0.2);
    const aimChanged = angleBetween(fx, fy, fz, this.lastAim.x, this.lastAim.y, this.lastAim.z) > AIM_EPS_DEG;
    const dashChanged = dash !== this.lastDash;
    const aliveChanged = alive !== this.lastAlive;
    const heartbeat = speed > 0.5 && now - this.lastInputSentAt > MOVE_HEARTBEAT_S;

    if (dirChanged || speedChanged || aimChanged || dashChanged || aliveChanged || heartbeat) {
      this.seq += 1n;
      submitInput({
        // Send the intended velocity; the server clamps to MAX_MOVE_SPEED (plan §74).
        moveX: round2(vx),
        moveY: round2(vy),
        moveZ: round2(vz),
        aimX: round2(fx),
        aimY: round2(fy),
        aimZ: round2(fz),
        seq: this.seq,
        dash,
      });
      this.lastInputSentAt = now;
      this.lastDir = { x: dirX, y: dirY, z: dirZ };
      this.lastSpeed = speed;
      this.lastAim = { x: fx, y: fy, z: fz };
      this.lastDash = dash;
      this.lastAlive = alive;
    }

    // Absolute correction: spawn/teleport/dash/state transitions + slow tick.
    const teleport = dt > 0 && Math.hypot(x - this.lastPos.x, y - this.lastPos.y, z - this.lastPos.z) > 8;
    if (
      this.forcePose || teleport || dashChanged || aliveChanged || !alive
      || now - this.lastPoseSentAt > POSE_SYNC_S
    ) {
      syncPose({ x: round2(x), y: round2(y), z: round2(z), fx: round2(fx), fy: round2(fy), fz: round2(fz) });
      this.lastPoseSentAt = now;
      this.forcePose = false;
    }

    this.lastPos = { x, y, z, t: now };
  }

  /** Immediate pose correction (used right after spawning / attaching). */
  sendPoseNow(): void {
    this.forcePose = true;
    if (!this.lastPos.t) return; // no pose observed yet — the next tick covers it
    syncPose({
      x: round2(this.lastPos.x),
      y: round2(this.lastPos.y),
      z: round2(this.lastPos.z),
      fx: round2(this.lastAim.x),
      fy: round2(this.lastAim.y),
      fz: round2(this.lastAim.z),
    });
    this.lastPoseSentAt = performance.now() / 1000;
    this.forcePose = false;
  }

  // ------------------------------------------------------------ cache reaction

  private onCacheChanged(): void {
    const cache = ClientCache.shared;
    this.emitQueue(cache);
    this.emitCandidate(cache);
    this.detectMatchStart(cache);
    this.applyRemotePoses(cache);
    this.detectMatchEnd(cache);
  }

  private emitQueue(cache: ClientCache): void {
    const q = cache.myQueue();
    // "Queued seconds" is measured locally from when we first SAW the state:
    // server clocks are unknowable here and the countdown is cosmetic anyway.
    const status: 'idle' | 'queued' | 'candidate' | 'confirmed' = !q
      ? 'idle'
      : q.status === 1
        ? 'candidate'
        : q.status === 2
          ? 'confirmed'
          : 'queued';
    const signature = `${status}`;
    if (signature === this.lastQueueSignature) return;
    this.lastQueueSignature = signature;
    if (!q && !this.matchId) this.emit({ type: 'queue', status: 'idle', queuedSeconds: 0 });
    else if (status !== 'idle') this.emit({ type: 'queue', status, queuedSeconds: 0 });
  }

  private emitCandidate(cache: ClientCache): void {
    const candidate = cache.myCandidate();
    if (!candidate) {
      if (this.lastCandidateSignature) {
        this.lastCandidateSignature = '';
      }
      return;
    }
    const seats = cache.myCandidatePlayers();
    const mySeat = seats.find(s => hexOf(s.identity) === this.myHex);
    const deadlineSeconds = Math.max(0, (Number(candidate.deadline) - this.serverNowUs()) / 1e6);
    const signature = `${candidate.matchId}:${deadlineSeconds.toFixed(0)}:${seats.map(s => `${hexOf(s.identity) === this.myHex ? 'me' : s.colony}${s.confirmed ? '+' : '-'}`).join(',')}`;
    if (signature === this.lastCandidateSignature) return;
    this.lastCandidateSignature = signature;
    this.emit({
      type: 'candidate',
      deadlineSeconds,
      myConfirmed: Boolean(mySeat?.confirmed),
      seats: seats.map(s => ({ colony: s.colony, confirmed: s.confirmed, me: hexOf(s.identity) === this.myHex })),
    });
  }

  private detectMatchStart(cache: ClientCache): void {
    if (this.matchId || !this.myHex) return;
    // Find my seats: match_player rows are only subscribed for MY identity in
    // the matchmaking scope, so anything resident here is mine.
    const mySeats = cache.matchPlayersOfSelf(this.myHex);
    if (mySeats.length === 0) return;
    for (const seat of mySeats) {
      // A seat abandoned via LEAVE MATCH (this session or an earlier one) never pulls us back in.
      if (seat.left || seat.matchId === this.leftMatchId) continue;
      // A match that already FINISHED this session is final: the end screen must stay put.
      if (this.endedMatchIds.has(seat.matchId)) continue;
      const m = cache.match(seat.matchId);
      if (!m) {
        // The `match` row is NOT part of the matchmaking scope — pull the match
        // scope in on first sight of a seat, then start once the row lands
        // (its live-query updates arrive through the next cache change).
        subscribeMatch(seat.matchId);
        continue;
      }
      // ONLY a live, running match: the status alone leaves a race window while a finish
      // transaction propagates, so the ended stamp and a decided winner are checked too.
      if (m.status === 1 && !m.endedAt && m.winnerColony == null) {
        this.beginMatch(cache, m.matchId, m.mapSeed, m.durationSeconds);
        return;
      }
    }
  }

  /** Pull a match row into the cache so the #/match/<id> join page can render it. */
  watchMatch(matchId: number): void {
    if (matchId > 0) subscribeMatch(matchId);
  }

  /**
   * JOIN / REJOIN a running match by id (the shareable URL). The reducer revives or creates the
   * seat; the seat's arrival drives the ordinary match-start path from there.
   */
  joinMatchById(matchId: number, colony: number, necrotech = 0): void {
    if (this.matchId && this.matchId !== matchId) this.resetMatch();
    joinMatchReducer(matchId, colony, necrotech);
  }

  private beginMatch(cache: ClientCache, matchId: number, seed: number, elapsed: number): void {
    this.matchId = matchId;
    this.matchEndEmitted = false;
    subscribeMatch(matchId);
    const rows = cache.matchPlayers(matchId);
    for (const p of rows) {
      const hex = hexOf(p.identity);
      if (hex && hex !== this.myHex) subscribePlayer(hex);
    }
    // Re-read after subscribing (rows may arrive after the initial pass).
    window.setTimeout(() => {
      if (this.matchId !== matchId) return;
      this.payload = this.buildPayload();
      this.emit({ type: 'match-start', matchId });
    }, 0);
  }

  private buildPayload(): OfficialMatchPayload {
    const cache = ClientCache.shared;
    const players: OfficialGamePlayerInfo[] = cache.matchPlayers(this.matchId).map(row => ({
      id: this.gameIdFor(hexOf(row.identity)),
      name: row.name || 'Survivor',
      colony: row.colony,
      necrotech: row.necrotech,
    }));
    return {
      matchId: this.matchId,
      seed: cache.match(this.matchId)?.mapSeed ?? 1,
      elapsed: cache.match(this.matchId)?.durationSeconds ?? 0,
      meId: this.myGameId,
      players,
    };
  }

  private applyRemotePoses(cache: ClientCache): void {
    if (!this.matchId || !this.gameApi) return;
    for (const row of cache.matchPlayers(this.matchId)) {
      const hex = hexOf(row.identity);
      if (!hex || hex === this.myHex || !row.hasPose) continue;
      const stamp = row.updatedAt.microsSinceUnixEpoch;
      if ((this.appliedPoses.get(hex) ?? 0n) >= stamp) continue;
      this.appliedPoses.set(hex, stamp);
      this.gameApi.applyRemote(this.gameIdFor(hex), this.toPoseMessage(row));
    }
  }

  private toPoseMessage(row: MatchPlayerRow): OfficialStateMessage {
    const id = this.gameIdFor(hexOf(row.identity));
    // The wire `time`/`pt` carry the SERVER clock: Game's ClockSync maps it onto
    // the local clock, exactly like a P2P host's poses.
    const time = Number(row.updatedAt.microsSinceUnixEpoch) / 1e6;
    return {
      t: 'st',
      time,
      state: {
        id,
        pt: time,
        x: round2(row.x), y: round2(row.y), z: round2(row.z),
        fx: round2(row.fx), fy: round2(row.fy), fz: round2(row.fz),
        hp: Math.round(row.hp),
        col: row.colony,
        alive: row.alive ? 1 : 0,
        lvl: 1,
        ntn: '',
        ntc: '',
        mut: 0,
        bl: 0,
        xp: 0,
        xpn: 0,
        frz: 0,
        acc: '',
        sh: 0,
        shm: 0,
        inv: 0,
        dsh: 0,
      },
    };
  }

  private detectMatchEnd(cache: ClientCache): void {
    if (!this.matchId || this.matchEndEmitted) return;
    const m = cache.match(this.matchId);
    if (!m || m.status !== 2) return;
    this.matchEndEmitted = true;
    // Latch the id: no cache churn may re-enter a concluded match.
    this.endedMatchIds.add(this.matchId);
    const winner = m.winnerColony ?? null;
    // The server usage summary rides along (plan §28): the results screen prints it for debug.
    const usage = cache.myMatchUsage();
    if (this.gameApi) {
      this.gameApi.matchEnded({
        winnerColony: winner,
        reason: 'OFFICIAL MATCH COMPLETE',
        usage: usage
          ? {
              matchId: usage.matchId,
              serverTicks: Number(usage.serverTicks),
              inputCommands: Number(usage.inputCommands),
              stateUpdates: Number(usage.stateUpdates),
              events: Number(usage.events),
              egressBytes: Number(usage.estimatedEgressBytes),
              storageBytes: Number(usage.storageBytes),
              playerCount: usage.playerCount,
              durationSeconds: usage.durationSeconds,
            }
          : undefined,
      });
    }
    this.emit({ type: 'match-end', matchId: this.matchId, winnerColony: winner });
  }

  // ------------------------------------------------------------ helpers

  /** Stable game-side id for a SpacetimeDB identity (plan §52 identity mapping). */
  gameIdFor(hex: string): string {
    return hex ? `og-${hex.slice(0, 12)}` : 'og-local';
  }

  /**
   * Rough server clock in micros. The offset is sampled ONCE per anchor row (a new candidate or
   * queue entry): `performance.now()` advances every call, so recomputing the offset each time
   * pinned `serverNow` to the anchor and froze every deadline countdown at its full window —
   * the "matchmaking countdown stuck at 5 and 10" bug.
   */
  private serverOffsetUs = 0;
  private serverAnchorUs = 0;
  private serverNowUs(): number {
    const cache = ClientCache.shared;
    const anchorUs = Number(cache.myCandidate()?.createdAt ?? cache.myQueue()?.queuedAt ?? 0);
    if (anchorUs && anchorUs !== this.serverAnchorUs) {
      this.serverAnchorUs = anchorUs;
      this.serverOffsetUs = anchorUs - performance.now() * 1000;
    }
    return performance.now() * 1000 + this.serverOffsetUs;
  }

  private connectionState(): ProviderConnectionState {
    const s = SpacetimeConnection.shared.state;
    return { status: s === 'connected' ? 'connected' : s === 'reconnecting' ? 'reconnecting' : s === 'connecting' ? 'connecting' : 'offline' };
  }

  private emit(event: ProviderGameEvent): void {
    for (const cb of [...this.gameListeners]) {
      try {
        cb(event);
      } catch (err) {
        console.warn('[NECROFALL] provider listener failed', err);
      }
    }
  }
}
