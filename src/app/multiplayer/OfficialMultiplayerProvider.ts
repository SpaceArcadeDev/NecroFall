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
  reportNexusCapture,
  reportNecrophageVictory,
  findRankedMatch as findRankedMatchReducer,
  sendMatchMsg,
} from '../spacetimedb/reducers';
import { hexOf, Identity, MatchMsgRow } from '../spacetimedb/rows';
import { subscribeMatch, subscribePlayer, releaseMatch } from '../spacetimedb/subscriptions';
import { loadSelection, selectionToWire } from '../../customization/CustomizationStore';
import { MultiplayerProvider, ProviderConnectionState, ProviderGameEvent } from './MultiplayerProvider';
import {
  OfficialGameApi,
  OfficialGameBridge,
  OfficialGamePlayerInfo,
  OfficialMatchPayload,
  OfficialNetMessage,
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
/**
 * How long a merely-DISCONNECTED authority keeps its role before the relay hands it to the
 * next seat (a clean LEAVE hands over immediately). Covers a link blip without ping-ponging
 * the host role between two clients.
 */
const AUTHORITY_GRACE_MS = 2500;

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
  /** sessionStorage key for the ended-match latch (survives a reload of THIS tab). */
  private static readonly ENDED_STORE = 'nf-ended-matches';
  /**
   * Latch a finished match and persist it for the tab. The in-memory set alone died with a
   * reload, so a refresh right after the end screen walked straight back into the finished game
   * (bug report 2026-09-29: "on reload it brings me back into the game").
   */
  private latchEnded(matchId: number): void {
    this.endedMatchIds.add(matchId);
    try {
      const parsed: unknown = JSON.parse(sessionStorage.getItem(OfficialMultiplayerProvider.ENDED_STORE) ?? '[]');
      const list = Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : [];
      if (!list.includes(matchId)) list.push(matchId);
      sessionStorage.setItem(OfficialMultiplayerProvider.ENDED_STORE, JSON.stringify(list.slice(-20)));
    } catch {
      /* storage unavailable — the in-memory latch still covers this page's session */
    }
  }
  /**
   * CONFIRM clicked locally: the colony summary flips to its ✓ instantly instead of waiting for
   * the server round trip. In a SOLO candidate the server finalizes the match in the SAME reducer
   * call, so no confirmed state ever renders on its own — without this the ✓ was unreachable
   * (user review). Server truth clears it the moment the confirmed seat row arrives.
   */
  private optimisticConfirmed = false;

  /**
   * The 0.5 s all-confirmed beat (user ask 2026-09-28): the last ✓ must be SEEN before the loading
   * screen takes over. A candidate that vanishes (finalized) within this window means the match
   * was born from a confirmation, so `beginMatch` holds the summary — every slot forced ✓ — for
   * CONFIRM_HOLD_MS. Clients that confirmed EARLIER never render the last ✓ themselves (the server
   * finalizes in the same commit), which is exactly why the hold synthesizes it.
   */
  private static readonly CONFIRM_HOLD_MS = 500;
  /** The last live candidate snapshot (seats + effective confirmed flags), kept for the hold. */
  private lastCandidateView: {
    deadlineSeconds: number;
    seats: { colony: number; confirmed: boolean; me: boolean }[];
    myConfirmed: boolean;
  } | null = null;
  /** When the candidate row disappeared (0 = none recently) — the confirmation-birth signal. */
  private candidateGoneAt = 0;
  /** While set, `currentCandidateInfo` renders this held all-✓ summary until `until`. */
  private confirmHold: { until: number; seats: { colony: number; confirmed: boolean; me: boolean }[] } | null = null;
  /** Pending deferred queue-idle emit (a consumed candidate may still become a match). */
  private idleEmitTimer = 0;

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
  private cacheUnsub: (() => void) | null = null;

  // ---- relay wire (2026-09-29): the official match's P2P message channel
  /** Highest match_msg id already fed to the game (monotonic — rows are swept by the server). */
  private lastRelayId = 0n;
  /** Sender-monotonic counter for outgoing relay messages (diagnostics). */
  private relaySeq = 0n;
  /** The game id of the current match authority ('' until determined from the seat rows). */
  private authorityId = '';
  /** A disagreed-on authority candidate and when it first appeared (role-handover hysteresis). */
  private authorityPendingId = '';
  private authorityPendingSince = 0;
  /** Roster signature last pushed to the game — names/colonies/classes/tombstones. */
  private rosterSignature = '';

  private gameListeners = new Set<(e: ProviderGameEvent) => void>();
  private stateListeners = new Set<(s: ProviderConnectionState) => void>();
  private lastQueueSignature = '';
  private lastCandidateSignature = '';

  // ------------------------------------------------------------ lifecycle

  /** Once the SDK connection is up: wire the cache and start watching matchmaking. */
  start(): void {
    this.myHex = SpacetimeConnection.shared.identityHex;
    this.myGameId = this.gameIdFor(this.myHex);
    // Reload-safe ended latch: a refresh straight after an end screen must not re-enter the match.
    try {
      const parsed: unknown = JSON.parse(sessionStorage.getItem(OfficialMultiplayerProvider.ENDED_STORE) ?? '[]');
      if (Array.isArray(parsed)) for (const v of parsed) if (typeof v === 'number') this.endedMatchIds.add(v);
    } catch {
      /* storage unavailable */
    }
    if (!this.cacheUnsub) {
      this.cacheUnsub = ClientCache.shared.onChange(() => this.onCacheChanged());
    }
    this.onCacheChanged();
  }

  stop(): void {
    this.cacheUnsub?.();
    this.cacheUnsub = null;
    if (this.matchId) releaseMatch(this.matchId);
    this.clearRelayState();
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
    this.clearRelayState();
    this.gameApi = null;
    this.lastQueueSignature = '';
    this.lastCandidateSignature = '';
    this.clearConfirmHold();
  }

  /** Forget everything that belongs to one match's relay wire. */
  private clearRelayState(): void {
    this.lastRelayId = 0n;
    this.relaySeq = 0n;
    this.authorityId = '';
    this.authorityPendingId = '';
    this.authorityPendingSince = 0;
    this.rosterSignature = '';
  }

  /** Forget any pending all-confirmed beat — a new queue must never inherit the old one's. */
  private clearConfirmHold(): void {
    this.lastCandidateView = null;
    this.candidateGoneAt = 0;
    this.confirmHold = null;
    if (this.idleEmitTimer) {
      window.clearTimeout(this.idleEmitTimer);
      this.idleEmitTimer = 0;
    }
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

  /** FIND RANKED MATCH — queue solo for one planet (plan §5/§53). */
  findRankedMatch(ring: number, galaxyId: number, systemId: number, planetId: number): void {
    findRankedMatchReducer(ring, galaxyId, systemId, planetId);
  }

  cancelFindMatch(): void {
    this.optimisticConfirmed = false;
    this.clearConfirmHold();
    cancelFindMatch();
  }

  confirmMatch(): void {
    // Optimistic ✓ — see `optimisticConfirmed`. Emit immediately so the summary flips this frame.
    this.optimisticConfirmed = true;
    confirmMatch();
    this.onCacheChanged();
  }

  declineMatch(): void {
    this.optimisticConfirmed = false;
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

  /**
   * The LOCAL simulation concluded the match. Latch the id FIRST (persisted for the tab): between
   * now and the server's status-2 row there is a window in which `detectMatchStart` could
   * otherwise pull the player back into a match that is, for them, over (the "brought back into
   * the game / back to the end screen" reports) — and a reload in that window used to re-enter
   * the finished match too. The result is ALWAYS reported so the server row concludes at once:
   * a Nexus capture (`colony` non-null) with its winner, a Necrophage victory (null) as a
   * no-winner finish — without that report the RUNNING row kept answering "You are already in a
   * match" for up to the 30 s rejoin grace after every screen had already ended (bug 2026-09-29).
   */
  reportVictory(colony: number | null): void {
    if (!this.matchId) return;
    this.latchEnded(this.matchId);
    if (colony !== null) reportNexusCapture(colony);
    else reportNecrophageVictory();
  }

  /** True when this session already concluded the given match locally (never re-enter it). */
  hasEndedLocally(matchId: number): boolean {
    return this.endedMatchIds.has(matchId);
  }

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
    /** Every seat is ✓ — the summary holds this state for a beat instead of blinking away. */
    allConfirmed: boolean;
    filling: boolean;
  } | null {
    const cache = ClientCache.shared;
    const candidate = cache.myCandidate();
    if (!candidate) {
      // The 0.5 s all-confirmed beat: the candidate row is CONSUMED the moment everyone confirms
      // (the server finalizes in the same commit), so the last ✓ would otherwise never render.
      const hold = this.confirmHold;
      if (hold && performance.now() < hold.until) {
        return {
          deadlineSeconds: Math.max(0, (hold.until - performance.now()) / 1000),
          seats: hold.seats,
          myConfirmed: true,
          allConfirmed: true,
          filling: false,
        };
      }
      this.confirmHold = null;
      return null;
    }
    const seats = cache.myCandidatePlayers();
    const mySeat = seats.find(s => hexOf(s.identity) === this.myHex);
    // The optimistic flag is what makes the local ✓ visible in the server-finalize-in-one-call
    // solo case (see `optimisticConfirmed`) — the polling page reads THIS path, not the event.
    const mine = Boolean(mySeat?.confirmed) || this.optimisticConfirmed;
    const view = seats.map(s => ({
      colony: s.colony,
      confirmed: hexOf(s.identity) === this.myHex ? mine : s.confirmed,
      me: hexOf(s.identity) === this.myHex,
    }));
    return {
      deadlineSeconds: Math.max(0, (Number(candidate.deadline) - this.serverNowUs()) / 1e6),
      seats: view,
      myConfirmed: mine,
      allConfirmed: view.length > 0 && view.every(s => s.confirmed),
      filling: candidate.status === 0,
    };
  }

  // ------------------------------------------------------------ game bridge

  attachGame(api: OfficialGameApi): void {
    this.gameApi = api;
    this.forcePose = true;
    this.lastInputSentAt = 0;
    this.lastPoseSentAt = 0;
    if (this.payload) {
      // Push the current seats + authority immediately: the game may have booted before the
      // last cache change, and the relay needs BOTH before it can route anything.
      this.rosterSignature = ''; // force a fresh push
      this.syncRosterAndAuthority(ClientCache.shared);
      // Re-send the initial spawn pose right away so the server record is anchored.
      window.setTimeout(() => this.sendPoseNow(), 400);
      window.setTimeout(() => this.sendPoseNow(), 1400);
    }
  }

  // ------------------------------------------------------------ relay wire (official)

  /**
   * Relay one P2P message to ONE seat (game id). The game id is mapped back to the seat's
   * identity; unknown ids are dropped (the sender's roster and ours can differ for a beat).
   */
  sendNetTo(toId: string, msg: OfficialNetMessage): void {
    if (!this.matchId) return;
    const hex = this.hexForGameId(toId);
    if (!hex || hex === this.myHex) return;
    this.relay(msg, hex);
  }

  /**
   * Relay one P2P message to every seat (the authority's broadcast). `exceptId` rides along as
   * the `ex` field, which receivers check against their own game id — the P2P
   * `broadcast(msg, exceptId)` rule, preserved across the SpacetimeDB hop.
   */
  broadcastNet(msg: OfficialNetMessage, exceptId?: string): void {
    if (!this.matchId) return;
    this.relay(exceptId ? { ...msg, ex: exceptId } : msg, '');
  }

  /** Serialize one message into a `match_msg` row (kind + JSON body, `t` stripped). */
  private relay(msg: OfficialNetMessage, toHex: string): void {
    const kind = typeof msg.t === 'string' ? msg.t : '';
    if (!kind) return;
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(msg)) if (k !== 't') body[k] = v;
    this.relaySeq += 1n;
    try {
      sendMatchMsg({
        matchId: this.matchId,
        toHex,
        kind,
        seq: this.relaySeq,
        payload: JSON.stringify(body),
      });
    } catch (err) {
      console.warn('[NECROFALL] relay encode failed', err);
    }
  }

  /** A game id ("og-<hex12>") back to the sender's identity hex — reverse of `gameIdFor`. */
  private hexForGameId(id: string): string {
    if (!this.matchId || !id.startsWith('og-')) return '';
    const short = id.slice(3);
    for (const row of ClientCache.shared.matchPlayers(this.matchId)) {
      const hex = hexOf(row.identity);
      if (hex && hex.startsWith(short)) return hex;
    }
    return '';
  }

  /**
   * Deliver newly committed relay rows to the game. Rows older than the subscription seed
   * are skipped (a fresh subscription replays the last few seconds), our own sends never come
   * back to us, private traffic for someone else is ignored, and `ex` is the broadcast
   * exclusion. Everything else is fed VERBATIM into the game — the same `onNetMessage` switch
   * a P2P packet enters.
   */
  private emitRelay(cache: ClientCache): void {
    if (!this.matchId || !this.gameApi) return;
    // Collect the not-yet-seen rows first (usually zero to a few), then apply them in id
    // order — the cache list is a hot stream and is not kept sorted for us.
    let fresh: { id: bigint; row: MatchMsgRow }[] | null = null;
    for (const row of cache.matchMessages(this.matchId)) {
      if (row.id <= this.lastRelayId) continue;
      (fresh ??= []).push({ id: row.id, row });
    }
    if (!fresh) return;
    fresh.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const { id, row } of fresh) {
      this.lastRelayId = id;
      if (row.fromHex === this.myHex) continue;
      if (row.toHex && row.toHex !== this.myHex) continue;
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        continue; // corrupt body — the streams are continuous, the next message recovers
      }
      if (!body || typeof body !== 'object') continue;
      if (typeof body.ex === 'string' && body.ex === this.myGameId) continue;
      this.gameApi.applyNetMessage(this.gameIdFor(row.fromHex), { t: row.kind, ...body });
    }
  }

  /**
   * Keep the game's roster and the authority role in step with the seat rows. The authority
   * is the LOWEST connected non-left seat id — deterministic for every client, so a dropped
   * authority hands over to the same successor everywhere. A merely-disconnected authority
   * keeps the role for `AUTHORITY_GRACE_MS` (a clean LEAVE hands over at once); a flapping
   * `connected` flag can never ping-pong the role.
   */
  private syncRosterAndAuthority(cache: ClientCache): void {
    if (!this.matchId || !this.gameApi) return;
    const rows = cache.matchPlayers(this.matchId);
    if (rows.length === 0) return;
    const players: OfficialGamePlayerInfo[] = [];
    const segs: string[] = [];
    for (const r of rows) {
      const hex = hexOf(r.identity);
      players.push({
        id: this.gameIdFor(hex),
        name: r.name || 'Survivor',
        colony: r.colony,
        necrotech: r.necrotech,
        left: r.left,
      });
      segs.push(`${r.id}:${r.name}|${r.colony}|${r.necrotech}|${r.left ? 1 : 0}`);
    }
    const sig = segs.join(';');
    if (sig !== this.rosterSignature) {
      this.rosterSignature = sig;
      this.gameApi.setRoster(players);
    }

    const live = rows.filter(r => !r.left);
    if (live.length === 0) return;
    const connected = live.filter(r => r.connected);
    const pick = (connected.length > 0 ? connected : live).slice().sort((a, b) => a.id - b.id)[0];
    const candidate = this.gameIdFor(hexOf(pick.identity));
    if (!candidate || candidate === this.authorityId) {
      this.authorityPendingId = '';
      this.authorityPendingSince = 0;
      return;
    }
    if (!this.authorityId) {
      this.setAuthorityNow(candidate);
      return;
    }
    const current = live.find(r => this.gameIdFor(hexOf(r.identity)) === this.authorityId);
    // GONE (left or row removed) — the seat itself decided; hand over now.
    if (!current) {
      this.setAuthorityNow(candidate);
      return;
    }
    // DISCONNECTED — a link blip looks exactly like a drop for a moment; wait the grace out.
    if (!current.connected) {
      if (this.authorityPendingId !== candidate) {
        this.authorityPendingId = candidate;
        this.authorityPendingSince = performance.now();
      } else if (performance.now() - this.authorityPendingSince >= AUTHORITY_GRACE_MS) {
        this.setAuthorityNow(candidate);
      }
      return;
    }
    this.authorityPendingId = '';
    this.authorityPendingSince = 0;
  }

  /** The authority is us or someone else — push the new role into the game once. */
  private setAuthorityNow(id: string): void {
    this.authorityId = id;
    this.authorityPendingId = '';
    this.authorityPendingSince = 0;
    this.gameApi?.setAuthority(id);
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
    this.emitRelay(cache);
    this.syncRosterAndAuthority(cache);
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
    // The candidate was JUST consumed (all confirmed): the confirmation beat and the match-start
    // take over from here. Emitting 'idle' now would navigate the shell back to the lobby before
    // the all-✓ summary could render (observed live: the hold died before its first frame).
    // Deferred: if no match starts within the beat (the candidate expired instead), idle fires.
    if (!q && !this.matchId && (this.lastCandidateView || this.candidateGoneAt)) {
      this.lastQueueSignature = '';
      this.deferQueueIdle();
      return;
    }
    const signature = `${status}`;
    if (signature === this.lastQueueSignature) return;
    this.lastQueueSignature = signature;
    if (!q && !this.matchId) this.emit({ type: 'queue', status: 'idle', queuedSeconds: 0 });
    else if (status !== 'idle') this.emit({ type: 'queue', status, queuedSeconds: 0 });
  }

  /**
   * Defer the queue-idle signal while a consumed candidate may still become a match. The match
   * start cancels it (see `beginMatch`); otherwise it fires after the confirmation beat, which is
   * exactly the old "candidate expired → back to the lobby" behaviour, just a moment later.
   */
  private deferQueueIdle(): void {
    if (this.idleEmitTimer) return;
    this.idleEmitTimer = window.setTimeout(() => {
      this.idleEmitTimer = 0;
      if (this.matchId) return; // a match started — nothing to report
      const cache = ClientCache.shared;
      if (cache.myQueue() || cache.myCandidate()) return; // the queue moved on
      this.emit({ type: 'queue', status: 'idle', queuedSeconds: 0 });
    }, OfficialMultiplayerProvider.CONFIRM_HOLD_MS + 250);
  }

  private emitCandidate(cache: ClientCache): void {
    const candidate = cache.myCandidate();
    if (!candidate) {
      this.optimisticConfirmed = false;
      // Mark the moment the candidate row was consumed: a match that starts right after was born
      // from a confirmation and earns the 0.5 s all-confirmed beat (see `startConfirmHold`).
      if (this.lastCandidateView && !this.candidateGoneAt) this.candidateGoneAt = performance.now();
      this.lastCandidateView = null;
      if (this.lastCandidateSignature) {
        this.lastCandidateSignature = '';
      }
      return;
    }
    this.confirmHold = null; // a live candidate owns the summary again
    const seats = cache.myCandidatePlayers();
    const mySeat = seats.find(s => hexOf(s.identity) === this.myHex);
    if (mySeat?.confirmed) this.optimisticConfirmed = false; // the server caught up — truth takes over
    const mine = Boolean(mySeat?.confirmed) || this.optimisticConfirmed;
    const deadlineSeconds = Math.max(0, (Number(candidate.deadline) - this.serverNowUs()) / 1e6);
    const view = {
      deadlineSeconds,
      seats: seats.map(s => ({
        colony: s.colony,
        confirmed: hexOf(s.identity) === this.myHex ? mine : s.confirmed,
        me: hexOf(s.identity) === this.myHex,
      })),
      myConfirmed: mine,
    };
    this.lastCandidateView = view;
    this.candidateGoneAt = 0;
    const signature = `${candidate.matchId}:${deadlineSeconds.toFixed(0)}:${view.seats.map(s => `${s.me ? (mine ? 'me+' : 'me-') : s.colony + (s.confirmed ? '+' : '-')}`).join(',')}`;
    if (signature === this.lastCandidateSignature) return;
    this.lastCandidateSignature = signature;
    this.emit({ type: 'candidate', deadlineSeconds, myConfirmed: mine, seats: view.seats });
  }

  /**
   * Arm the all-confirmed beat when this match was born from a confirmation (the candidate row
   * vanished moments ago — user ask 2026-09-28). Returns the delay `beginMatch` waits before
   * handing the game over, so the summary shows every ✓ for a beat instead of vanishing.
   */
  private startConfirmHold(): number {
    const since = this.candidateGoneAt ? performance.now() - this.candidateGoneAt : Number.POSITIVE_INFINITY;
    this.candidateGoneAt = 0;
    const view = this.lastCandidateView;
    this.lastCandidateView = null;
    if (!view || view.seats.length === 0 || since > 3000) return 0;
    this.confirmHold = {
      until: performance.now() + OfficialMultiplayerProvider.CONFIRM_HOLD_MS,
      seats: view.seats.map(s => ({ ...s, confirmed: true })),
    };
    return OfficialMultiplayerProvider.CONFIRM_HOLD_MS;
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
    // Fresh relay wire for this match: skip every row that already exists (the subscription
    // replays a few seconds of history) and wait for the live stream from here.
    this.clearRelayState();
    for (const row of cache.matchMessages(matchId)) {
      if (row.id > this.lastRelayId) this.lastRelayId = row.id;
    }
    if (this.idleEmitTimer) {
      // The match materialized — the deferred idle signal would be a lie.
      window.clearTimeout(this.idleEmitTimer);
      this.idleEmitTimer = 0;
    }
    // A match born from a confirmation holds the all-✓ summary for a beat first (see above).
    const holdMs = this.startConfirmHold();
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
    }, holdMs);
  }

  private buildPayload(): OfficialMatchPayload {
    const cache = ClientCache.shared;
    const players: OfficialGamePlayerInfo[] = cache.matchPlayers(this.matchId).map(row => ({
      id: this.gameIdFor(hexOf(row.identity)),
      name: row.name || 'Survivor',
      colony: row.colony,
      necrotech: row.necrotech,
      left: row.left,
    }));
    const row = cache.match(this.matchId);
    const season = cache.rankedSeason();
    // The boot-time authority: lowest connected non-left seat — recomputed live by
    // `syncRosterAndAuthority` as seats come and go.
    const live = (cache.matchPlayers(this.matchId) ?? []).filter(r => !r.left);
    const connected = live.filter(r => r.connected);
    const authorityPick = (connected.length > 0 ? connected : live).slice().sort((a, b) => a.id - b.id)[0];
    return {
      matchId: this.matchId,
      seed: row?.mapSeed ?? 1,
      elapsed: row?.durationSeconds ?? 0,
      meId: this.myGameId,
      players,
      authorityId: authorityPick ? this.gameIdFor(hexOf(authorityPick.identity)) : this.myGameId,
      // Ranked facts (plan §32): the game regenerates the whole planet + ecology from these.
      ranked: Boolean(row?.ranked),
      planetKey: row?.planetKey ?? '',
      rankRing: row?.rankRing ?? 255,
      universeSeed: season ? Number(season.universeSeed % 4294967296n) >>> 0 : undefined,
    };
  }

  private detectMatchEnd(cache: ClientCache): void {
    if (!this.matchId || this.matchEndEmitted) return;
    const m = cache.match(this.matchId);
    if (!m || m.status !== 2) return;
    this.matchEndEmitted = true;
    // Latch the id: no cache churn may re-enter a concluded match (persisted for a reload too).
    this.latchEnded(this.matchId);
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
