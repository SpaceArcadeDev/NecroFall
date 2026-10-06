// NECROFALL — peer-to-peer networking over WebRTC DataChannels (PeerJS for signaling only).
//
// The lobby host is the P2P host and the gameplay authority, but it is not irreplaceable: the host
// publishes a shuffled migration order and, if it disappears, the survivors elect the next player
// on that list. The winner re-claims the room code as its peer id, so the code shown in the Esc
// menu keeps working — the match continues and new players can still drop in mid-match.
//
// Player identity (`myId`) is stable for the whole session and is what the game keys players by;
// the peer id (`peerId`) may change when a client takes the room code over.
import Peer, { DataConnection } from 'peerjs';
import { clamp } from '../utils/Utils';
import type { SavedRun } from './Session';

export type NetMessage = { t: string } & Record<string, any>;

/**
 * The OFFICIAL transport (2026-09-29): when set, every P2P send is routed through the
 * SpacetimeDB relay instead of WebRTC DataChannels. The topology is identical — clients
 * still `sendToHost`, the authority still `broadcast`s — so the whole gameplay protocol
 * runs unchanged; only the wire differs. `toId` is a GAME id ("og-…"), not a peer id.
 */
export interface NetRelay {
  send(toId: string, msg: NetMessage): void;
  broadcast(msg: NetMessage, exceptId?: string): void;
}

export interface NetCallbacks {
  onOpen(): void;
  /**
   * A peer introduced itself. `resume` means it is returning to a room it already played in and
   * `run` is the local save it wants to be restored from; `rejoin` means it never left the match
   * at all (it is coming back after a host migration) and must be left exactly as it is.
   */
  onJoin(id: string, name: string, resume: boolean, run?: SavedRun | null, rejoin?: boolean): void;
  onLeave(id: string): void;
  onMessage(fromId: string, msg: NetMessage): void;
  /** The host went silent: the election started. The match must NOT end. */
  onHostLost(reason: string): void;
  /** This peer won the election and now runs the match. */
  onPromoted(): void;
  /** Reconnected to the freshly elected host. */
  onMigrated(hostId: string): void;
  /** The room code changed (a migrated host had to pick a new one) — refresh the UI. */
  onCodeChanged(code: string): void;
  /** Nobody answered: play on under local authority instead of losing the match. */
  onMigrateFailed(): void;
  onFatal(reason: string): void;
}

const ID_PREFIX = 'nf-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Grace period before the elected host claims the room (the old host may come back). */
const PROMOTE_GRACE = 1000;
/** How long a survivor waits for one candidate host before trying the next one. */
const CONNECT_WINDOW = 8000;
/** Pause between connection attempts inside one election round. */
const CONNECT_RETRY = 900;
/** Longest single connection probe (kept short so a round fits several attempts). */
const PROBE_TIMEOUT = 2000;
/** Per-attempt timeout when claiming the room code back. */
const CODE_BIND_TIMEOUT = 2500;
const CODE_BIND_RETRY = 400;
/** Foreground claim budget: it has to fit inside the survivors' wait for this host. */
const CLAIM_BUDGET = 3000;
/**
 * How long the survivors' elected host keeps trying to reclaim the ORIGINAL room code before it
 * gives up and adopts a new one. A short window here was the reason a host's network switch made
 * the room vanish: the old host usually comes back on the same code within seconds, its reclaim
 * failed instantly, the room silently moved to a random code — and everyone who tried to rejoin
 * with the code they had got "lobby not found". The room's own peer id serves traffic meanwhile.
 */
const SAME_CODE_GRACE = 16000;
/** A host that loses EVERY channel at once waits this long for a survivor to come back. */
const DESERT_GRACE = 5000;
/** How long a deserted host probes the room code for the new authority before rebuilding the room. */
const DESERT_JOIN_WINDOW = 7000;

function randomCode(len = 5): string {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, Math.max(0, ms)));
}

export class NetworkManager {
  peer: Peer | null = null;
  /** Live connections, keyed by the **peer** id of the other side. */
  conns = new Map<string, DataConnection>();
  isHost = false;
  /** Stable player identity: what the game keys players, roster entries and messages by. */
  myId = 'solo';
  /** Player id of whoever currently runs the match (equal to `myId` while hosting). */
  hostId = '';
  /** Id of the local peer — differs from `myId` after taking the room code over. */
  peerId = 'solo';
  code = '';
  /** True while playing in a room (hosting counts, solo-offline counts). */
  connected = false;
  /** true when multiplayer signalling is available. */
  online = false;
  /**
   * The caller's latest local save. It rides along with a re-announcement after a host migration:
   * the newly elected host may never have seen this player, and the save is what puts it back.
   */
  lastRun: SavedRun | null = null;
  /** Official (SpacetimeDB) transport — see `NetRelay`. Null = plain P2P / solo. */
  relay: NetRelay | null = null;
  /** Why the last join attempt failed: `unavailable` = no room with that code, `timeout` = silence. */
  joinError: 'unavailable' | 'timeout' | '' = '';
  /** True while a join is in flight — the caller reports the failure, not the generic fatal path. */
  private joining = false;
  /** Peer id of the current host connection. */
  private hostPeer = '';
  /**
   * Second peer that only answers the room code. It appears when the elected host could not claim
   * the code in time (it is still held by the old host) and is claimed later in the background, so
   * the code shown in the Esc menu keeps working for players who drop in after the migration.
   */
  private codePeer: Peer | null = null;
  private lastSeen = new Map<string, number>();
  private rosterIds: string[] = [];
  /** Election order published by the host: `[host, ...survivors]`. */
  private hostOrder: string[] = [];
  /** peer id ↔ player id (identity for everyone except a host that took the room code over). */
  private peerToPlayer = new Map<string, string>();
  private playerToPeer = new Map<string, string>();
  private joined = new Set<string>();
  private migrating = false;
  private migrationFrom = '';
  private migrationAttempt = 0;
  private pingT = 0;
  /** When the room went empty at once (a network event) — the desert-recovery clock's anchor. */
  private desertArmedAt = 0;
  /** When this peer last had at least one live connection (or was promoted / re-hosted). */
  private lastConnAt = 0;
  /** When this peer last became the authority (its own election or a desert rebuild). */
  private promotedAt = 0;
  /** True while the deserted host is deciding whether to follow the room or rebuild it. */
  private recovering = false;
  private cbs: NetCallbacks;
  private name = 'Survivor';

  constructor(cbs: NetCallbacks) {
    this.cbs = cbs;
  }

  /**
   * Fixes the player identity before hosting or joining. The game derives it from the room session
   * (see SessionStore) so a reload keeps the same seat instead of arriving as a stranger.
   */
  setIdentity(id: string): void {
    if (!id) return;
    this.myId = id;
    if (!this.online && !this.peer) this.peerId = id;
  }

  /** Which player ids exist in the room (excluding self) — used for host election. */
  setRoster(ids: string[]): void {
    this.rosterIds = ids.filter(id => id !== this.myId);
  }

  /**
   * Election order from the host: it starts with the host and continues with every survivor in a
   * random order, so everyone agrees on who takes over first, second, third…
   */
  setHostOrder(order: string[]): void {
    if (!Array.isArray(order) || order.length === 0) return;
    this.hostOrder = order.filter(id => typeof id === 'string' && id.length > 0);
  }

  get hostOrderView(): string[] {
    return this.hostOrder.slice();
  }

  /**
   * Corrects the host's player id after the lobby tells us who really runs the room. The election
   * picks a name in advance, so this keeps routing honest if somebody else answered in the end.
   */
  setHostIdentity(playerId: string): void {
    if (!playerId || this.isHost || !this.hostPeer) return;
    if (this.playerIdOf(this.hostPeer) === playerId) return;
    // The host channel belongs to the host alone: any other player id still pointing at it is a
    // leftover from a rejoin that guessed the wrong name, and would misroute later traffic.
    for (const [pid, peer] of this.playerToPeer) {
      if (peer === this.hostPeer && pid !== playerId) this.playerToPeer.delete(pid);
    }
    this.peerToPlayer.set(this.hostPeer, playerId);
    this.playerToPeer.set(playerId, this.hostPeer);
    this.hostId = playerId;
  }

  /** The host broadcast a new room code after a migration. */
  setCode(code: string): void {
    const next = code.toUpperCase().slice(0, 8);
    if (this.isHost || !next || next === this.code) return;
    this.code = next;
    this.cbs.onCodeChanged(next);
  }

  /** True while a host election is running. */
  get migratingNow(): boolean {
    return this.migrating;
  }

  peerCount(): number {
    return this.conns.size;
  }

  // ------------------------------------------------------------ identity routing

  private link(peerId: string, playerId: string): void {
    if (!peerId || !playerId || peerId === playerId) return;
    this.peerToPlayer.set(peerId, playerId);
    this.playerToPeer.set(playerId, peerId);
  }

  /**
   * A player can only sit in a room once: when the same player id arrives on a new connection —
   * a page refresh, or a client re-announcing itself after a migration — the old channel is
   * dropped *silently*, so its close event cannot evict the fresh session from the roster.
   */
  private supersede(conn: DataConnection, playerId: string): void {
    const prev = this.playerToPeer.get(playerId);
    if (!prev || prev === conn.peer) return;
    const old = this.conns.get(prev);
    this.conns.delete(prev);
    this.lastSeen.delete(prev);
    this.peerToPlayer.delete(prev);
    this.playerToPeer.delete(playerId);
    this.joined.delete(prev);
    if (old) this.closeQuietly(old);
  }

  private playerIdOf(peerId: string): string {
    return this.peerToPlayer.get(peerId) ?? peerId;
  }

  private peerIdOf(playerId: string): string {
    if (playerId === this.myId) return this.peerId;
    return this.playerToPeer.get(playerId) ?? playerId;
  }

  // ------------------------------------------------------------ hosting

  /**
   * Opens a room. `preferredCode` is tried first — that is how a host that reloaded its own room
   * link reopens the same room instead of inventing a new code nobody has. With `onlyPreferred`
   * the code is the ONLY thing this peer will bind: a collision is reported back to the caller
   * (which then joins whoever took it) instead of quietly moving to a random code.
   */
  async hostLobby(name: string, preferredCode = '', onlyPreferred = false): Promise<string> {
    this.name = name;
    const wanted = preferredCode ?[preferredCode.toUpperCase()] : [];
    const attempts = onlyPreferred ? 1 : 5;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const code = wanted[attempt] ?? randomCode();
      try {
        await this.createPeer(ID_PREFIX + code);
        this.isHost = true;
        this.peerId = this.peer!.id;
        // The player identity is whatever the session says it is: a host that reloads keeps its id
        // (and its saved run) instead of being reborn as a different survivor.
        if (!this.myId || this.myId === 'solo') this.myId = this.peerId;
        this.hostId = this.myId;
        this.hostPeer = this.peerId;
        this.link(this.peerId, this.myId);
        this.code = code;
        this.connected = true;
        this.cbs.onOpen();
        return code;
      } catch (err) {
        const type = (err as { type?: string })?.type;
        if (type === 'unavailable-id') {
          if (onlyPreferred) throw err; // the code is held by somebody else — the caller joins them
          continue; // code collision — retry
        }
        // signalling unreachable: allow offline solo play
        this.isHost = true;
        if (!this.myId || this.myId === 'solo') this.myId = 'solo';
        this.peerId = 'solo';
        this.hostId = this.myId;
        this.hostPeer = '';
        this.code = code;
        this.connected = true;
        this.online = false;
        this.cbs.onOpen();
        return code;
      }
    }
    this.isHost = true;
    this.myId = 'solo';
    this.peerId = 'solo';
    this.hostId = 'solo';
    this.hostPeer = '';
    this.code = 'SOLO';
    this.connected = true;
    this.online = false;
    this.cbs.onOpen();
    return this.code;
  }

  private createPeer(id?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id) : new Peer();
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            peer.destroy();
          } catch {
            /* ignore */
          }
          reject({ type: 'timeout' });
        }
      }, 9000);
      peer.on('open', () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        this.peer = peer;
        this.peerId = peer.id;
        // The player identity is minted once and then never changes — not even when this peer
        // later takes the room code over and gets a different peer id.
        if (!this.myId || this.myId === 'solo') this.myId = peer.id;
        this.online = true;
        this.wirePeer(peer);
        resolve();
      });
      peer.on('error', err => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  private wirePeer(peer: Peer): void {
    peer.on('connection', conn => {
      if (!this.isHost) {
        conn.close();
        return;
      }
      this.wireConn(conn, true);
    });
    peer.on('disconnected', () => {
      // signalling lost: existing DataChannels keep working
      if (this.online) {
        try {
          peer.reconnect();
        } catch {
          /* ignore */
        }
      }
    });
    peer.on('error', err => {
      const type = (err as { type?: string })?.type;
      // A failed probe at a candidate host is expected while electing or while a deserted host is
      // looking for where its room went — only a real join fails hard. Leaving the recovery probe
      // out of this guard was what bounced players to the main menu: the probe against an empty
      // code raised `peer-unavailable`, which the game read as "Lobby not found".
      if (type === 'peer-unavailable' && !this.migrating && !this.recovering) {
        this.joinError = 'unavailable';
        // A join started from the game (`joinLobby`) reports its own failure, with better wording.
        if (!this.joining) this.cbs.onFatal('Lobby not found. Check the code.');
      }
    });
  }

  private wireConn(conn: DataConnection, acceptAsHost: boolean): void {
    if (this.conns.get(conn.peer) !== conn) {
      this.conns.set(conn.peer, conn);
      this.lastSeen.set(conn.peer, performance.now());
    }
    conn.on('open', () => {
      this.conns.set(conn.peer, conn);
      this.lastSeen.set(conn.peer, performance.now());
      this.lastConnAt = performance.now();
      // A client keeps only the connection it made to the host: stale migration probes are dropped.
      if (!acceptAsHost && this.hostPeer && conn.peer !== this.hostPeer) {
        try {
          conn.close();
        } catch {
          /* ignore */
        }
      }
    });
    conn.on('data', data => {
      this.lastSeen.set(conn.peer, performance.now());
      const msg = data as NetMessage;
      if (!msg || typeof msg.t !== 'string') return;
      this.noteTraffic(msg, 'rx');
      if (msg.t === 'ping') {
        if (this.isHost) {
          try {
            conn.send({ t: 'pong' });
          } catch {
            /* ignore */
          }
        }
        return;
      }
      if (msg.t === 'pong') return;
      if (msg.t === 'hello' && acceptAsHost) {
        // The hello carries the sender's stable player id, which is how a host that took the room
        // code over is told apart from the peers that kept their own connection id.
        const pid = typeof msg.pid === 'string' && msg.pid ? msg.pid : conn.peer;
        this.supersede(conn, pid);
        this.link(conn.peer, pid);
        if (!this.joined.has(conn.peer)) {
          this.joined.add(conn.peer);
          const name = String(msg.name ?? 'Peer').slice(0, 16) || 'Peer';
          const run = msg.run && typeof msg.run === 'object' ? (msg.run as SavedRun) : null;
          this.cbs.onJoin(pid, name, msg.resume === true, run, msg.rejoin === 1);
        }
      }
      this.cbs.onMessage(this.playerIdOf(conn.peer), msg);
    });
    const dropped = (): void => {
      if (this.conns.get(conn.peer) !== conn) return;
      const pid = this.playerIdOf(conn.peer);
      this.conns.delete(conn.peer);
      this.lastSeen.delete(conn.peer);
      this.joined.delete(conn.peer);
      this.cbs.onLeave(pid);
      if (!this.isHost && conn.peer === this.hostPeer) this.onHostConnectionLost('The host disconnected');
      // A deserted host is spotted by `update` — it needs a recent live connection to count at all.
    };
    conn.on('close', dropped);
    conn.on('error', dropped);
  }

  // ------------------------------------------------------------ joining

  /** `run` is the caller's local save — it travels with the hello so the host can restore it. */
  async joinLobby(code: string, name: string, run: SavedRun | null = null): Promise<void> {
    this.name = name;
    this.joinError = '';
    await this.createPeer();
    this.isHost = false;
    this.code = code.toUpperCase();
    this.joining = true;
    try {
      await this.connectToHost(ID_PREFIX + this.code, run);
    } finally {
      this.joining = false;
    }
  }

  private connectToHost(peerId: string, run: SavedRun | null = null): Promise<void> {
    return new Promise((resolve, reject) => {
      const peer = this.peer!;
      const conn = peer.connect(peerId, { reliable: true });
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          this.joinError = this.joinError || 'timeout';
          reject(new Error('timeout'));
        }
      }, 9000);
      conn.on('open', () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        this.conns.set(peerId, conn);
        this.lastSeen.set(peerId, performance.now());
        this.lastConnAt = performance.now();
        this.hostId = peerId;
        this.hostPeer = peerId;
        this.connected = true;
        this.wireConn(conn, false);
        this.sendTo(peerId, { t: 'hello', name: this.name, pid: this.myId, resume: !!run, run: run ?? undefined });
        this.cbs.onOpen();
        resolve();
      });
      conn.on('error', err => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  // ------------------------------------------------------------ host migration

  /** The host connection died: run the election instead of ending the match. */
  private onHostConnectionLost(reason: string): void {
    if (this.isHost || this.migrating) return;
    this.migrating = true;
    this.migrationFrom = this.hostId || this.hostPeer;
    this.migrationAttempt = 0;
    this.connected = false;
    this.hostId = '';
    this.hostPeer = '';
    this.cbs.onHostLost(reason);
    this.electionStep();
  }

  /** The host announced it is leaving (before its socket closes) — start the election at once. */
  hostGone(reason = 'The host left the planet'): void {
    if (this.isHost) return;
    this.onHostConnectionLost(reason);
  }

  /**
   * Survivors in the order the host published. Every client filters out the same departed host,
   * so all of them walk the same list in the same order at the same time — no two hosts at once.
   */
  private migrationCandidates(): string[] {
    // The published order is the source of truth; if we never received one, fall back to the
    // roster so the room still recovers.
    const order = this.hostOrder.length > 0 ? this.hostOrder : this.rosterIds;
    const out: string[] = [];
    for (const id of order) {
      if (!id || id === this.migrationFrom) continue;
      if (out.includes(id)) continue;
      out.push(id);
    }
    if (this.myId !== this.migrationFrom && !out.includes(this.myId)) out.push(this.myId);
    return out;
  }

  private electionStep(): void {
    if (!this.migrating || this.isHost) return;
    const candidates = this.migrationCandidates();
    if (candidates.length === 0 || this.migrationAttempt >= candidates.length) {
      this.failMigration();
      return;
    }
    const nominee = candidates[this.migrationAttempt];
    if (nominee === this.myId) {
      window.setTimeout(() => {
        if (this.migrating && !this.isHost) void this.takeOver();
      }, PROMOTE_GRACE);
      return;
    }
    void this.waitForHost(nominee);
  }

  /** Waits for one candidate host, then hands over to the next name on the list. */
  private async waitForHost(nominee: string): Promise<void> {
    const deadline = performance.now() + CONNECT_WINDOW;
    // The elected host first tries to reclaim the room code (so late joiners keep working); if it
    // cannot, it stays on its own peer id and we reach it directly.
    const targets = [ID_PREFIX + this.code, nominee];
    let i = 0;
    while (performance.now() < deadline) {
      if (!this.migrating || this.isHost) return;
      // Alternate: the elected host may claim the room code and drop its own peer id, or keep its
      // peer id when the code is still taken — either answer has to be retried.
      const target = targets[i % targets.length];
      i++;
      const conn = await this.tryConnect(target, Math.min(PROBE_TIMEOUT, deadline - performance.now()));
      if (!this.migrating || this.isHost) {
        if (conn) this.closeQuietly(conn);
        return;
      }
      if (conn) {
        this.rejoin(conn);
        return;
      }
      await delay(CONNECT_RETRY);
    }
    if (!this.migrating || this.isHost) return;
    this.migrationAttempt++;
    this.electionStep();
  }

  /** Talks to a peer id for at most `ms` milliseconds and reports the connection (or nothing). */
  private tryConnect(target: string, ms: number): Promise<DataConnection | null> {
    return new Promise(resolve => {
      const peer = this.peer;
      if (!peer || peer.destroyed) {
        resolve(null);
        return;
      }
      let conn: DataConnection;
      try {
        conn = peer.connect(target, { reliable: true });
      } catch {
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        // A candidate that never answered must not leave a half-open channel behind.
        if (!ok) this.closeQuietly(conn);
        resolve(ok ? conn : null);
      };
      const timer = window.setTimeout(() => finish(false), Math.max(500, ms));
      // Settle briefly after opening: a peer that is still a plain client closes the channel at
      // once, and being fooled by that would restart the election.
      conn.on('open', () => window.setTimeout(() => finish(conn.open), 150));
      conn.on('close', () => finish(false));
      conn.on('error', () => finish(false));
    });
  }

  private closeQuietly(conn: DataConnection): void {
    try {
      conn.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * The host lost every peer at once and nobody came back. Two possibilities: the room elected a
   * new host (it is still out there on this same code, and this peer should rejoin it as a
   * survivor), or the room really is gone (rebuild it, same code).
   *
   * Squatting on the empty code was what wedged the room after a host's network switch: the elected
   * host could never claim it, so the room drifted to a random code nobody was told about and every
   * rejoin finished with "lobby not found".
   */
  private async recoverFromDesert(): Promise<void> {
    if (!this.isHost || this.recovering || this.conns.size > 0) return;
    if (!this.online || !this.code || this.code === 'SOLO') {
      this.desertArmedAt = 0;
      return;
    }
    this.recovering = true;
    this.desertArmedAt = 0;
    const code = this.code;
    const wasHostId = this.myId;
    try {
      // Release the room code (and any stale channels) before anything else. The `online` flag is
      // dropped first so the 'disconnected' handler cannot start a reconnect underneath the
      // teardown — a reconnect that finished after the destroy would leave the room code held by a
      // socket nobody owns any more, and no survivor could claim it.
      this.online = false;
      this.disposePeer();
      try {
        await this.createPeer();
      } catch {
        // Signalling is down as well: try again shortly rather than pretending anything changed.
        this.desertArmedAt = performance.now() - DESERT_GRACE + 2500;
        return;
      }
      const until = performance.now() + DESERT_JOIN_WINDOW;
      while (performance.now() < until && this.conns.size === 0) {
        const conn = await this.tryConnect(ID_PREFIX + code, Math.min(PROBE_TIMEOUT, until - performance.now()));
        if (!conn) {
          if (performance.now() < until) await delay(CONNECT_RETRY);
          continue;
        }
        // Somebody answered on the code — whoever elected themselves keeps the room. Rejoin them
        // exactly like any survivor would after a migration.
        this.isHost = false;
        this.hostPeer = conn.peer;
        this.hostId = conn.peer; // a temporary address; their lobby message names the real host
        this.conns.set(conn.peer, conn);
        this.lastSeen.set(conn.peer, performance.now());
        this.connected = true;
        this.wireConn(conn, false);
        this.sendTo(conn.peer, {
          t: 'hello', name: this.name, pid: wasHostId, resume: true, rejoin: 1,
          run: this.lastRun ?? undefined,
        });
        this.cbs.onMigrated(conn.peer);
        return;
      }
      // Nobody else runs the room: take the code back and keep hosting.
      const peer = await this.bindPeer(ID_PREFIX + code, CLAIM_BUDGET, CODE_BIND_TIMEOUT);
      if (peer) {
        this.peer = peer;
        this.peerId = peer.id;
        this.link(peer.id, this.myId);
        this.online = true;
        this.wirePeer(peer);
        this.hostPeer = peer.id;
        this.hostId = this.myId;
        this.connected = true;
        // The room is rebuilt on its own; stand the recovery down until company is really lost
        // again (earning that needs a live connection or a fresh promotion — see `update`).
        this.promotedAt = 0;
        this.lastConnAt = 0;
        this.cbs.onPromoted();
        return;
      }
      // Somebody is holding the code but did not answer: try the whole dance again soon.
      this.desertArmedAt = performance.now() - DESERT_GRACE + 2500;
    } finally {
      this.recovering = false;
    }
  }

  /** Back online with a freshly elected host: re-announce ourselves and keep playing. */
  private rejoin(conn: DataConnection): void {
    this.conns.set(conn.peer, conn);
    this.lastSeen.set(conn.peer, performance.now());
    // The connection may have come from the room CODE rather than the nominee's own peer id, so do
    // not guess a player id here: a peer id is a valid routing address, and the host's own lobby
    // message replaces it with the real identity the moment it arrives (see setHostIdentity).
    this.hostPeer = conn.peer;
    this.hostId = conn.peer;
    this.migrating = false;
    this.connected = true;
    this.wireConn(conn, false);
    this.sendTo(conn.peer, { t: 'hello', name: this.name, pid: this.myId, resume: true, rejoin: 1, run: this.lastRun ?? undefined });
    this.cbs.onMigrated(conn.peer);
  }

  /**
   * Elected host: claim the room code back (or keep our own peer id) and take the match over.
   * The claim starts immediately but is only kept once the grace period has passed, so a host that
   * comes back right away keeps its room.
   */
  private async takeOver(): Promise<void> {
    if (!this.migrating || this.isHost) return;
    const wanted = !!this.code && this.code !== 'SOLO';
    const claim = wanted ? this.bindPeer(ID_PREFIX + this.code, CLAIM_BUDGET, CODE_BIND_TIMEOUT) : Promise.resolve(null);
    await delay(PROMOTE_GRACE);
    const claimed = await claim;
    if (!this.migrating || this.isHost) {
      // Somebody else took the room while we were claiming the code — give it straight back.
      if (claimed) claimed.destroy();
      return;
    }
    if (claimed) {
      this.disposePeer();
      this.peer = claimed;
      this.peerId = claimed.id;
      this.link(claimed.id, this.myId);
      this.online = true;
      // The claimed peer is brand new: wire it to accept connections as the authority.
      this.wirePeer(claimed);
    } else {
      // The code is held by SOMEBODY. If that somebody answers, they are the authority: either the
      // old host that never actually left (it was our own link that died), or a rival claimant that
      // got there first. Defer to them — standing up a second room on our own peer id while a live
      // authority holds the code is exactly how one match becomes two.
      const responder = await this.tryConnect(ID_PREFIX + this.code, PROBE_TIMEOUT);
      if (responder) {
        this.rejoin(responder);
        return;
      }
      if (this.peer && !this.peer.destroyed) {
        // The code is held by a ghost (a request that got there but never answers): keep the peer
        // we have and be reached by its id.
        this.peerId = this.peer.id;
        this.link(this.peerId, this.myId);
      } else {
        this.failMigration();
        return;
      }
    }
    this.isHost = true;
    this.hostId = this.myId;
    this.hostPeer = this.peerId;
    this.migrating = false;
    this.connected = true;
    this.promotedAt = performance.now();
    this.cbs.onPromoted();
    // The old room code is usually still held by the signalling server, so hand the room a code
    // that actually works. Survivors stay on the connection they already have.
    if (wanted && !claimed) void this.reopenRoomCode();
  }

  /**
   * Opens the door for late joiners after a migration. The room code that was in use cannot be
   * re-registered straight away, so if it does not come back within a moment the host takes a fresh
   * one and broadcasts it: the code shown in the Esc menu is always one that works.
   */
  private async reopenRoomCode(): Promise<void> {
    const previous = this.code;
    let gateway = await this.bindPeer(ID_PREFIX + previous, SAME_CODE_GRACE, CODE_BIND_TIMEOUT);
    for (let i = 0; i < 6 && !gateway; i++) {
      const code = randomCode();
      const peer = await this.tryPeer(ID_PREFIX + code, CODE_BIND_TIMEOUT);
      if (peer) {
        gateway = peer;
        this.code = code;
      }
    }
    if (!gateway || !this.isHost || this.migrating) {
      gateway?.destroy();
      return;
    }
    this.codePeer = gateway;
    this.wirePeer(gateway);
    this.broadcast({ t: 'code', code: this.code });
    if (this.code !== previous) this.cbs.onCodeChanged(this.code);
  }

  /** Creates a peer bound to a specific id, retrying until the time budget runs out. */
  private async bindPeer(id: string, budgetMs: number, perTimeout: number): Promise<Peer | null> {
    const until = performance.now() + budgetMs;
    for (;;) {
      const remaining = until - performance.now();
      if (remaining <= 0) return null;
      const peer = await this.tryPeer(id, Math.min(perTimeout, remaining));
      if (peer) return peer;
      if (performance.now() + CODE_BIND_RETRY >= until) return null;
      await delay(CODE_BIND_RETRY);
    }
  }

  private tryPeer(id: string, timeoutMs = CODE_BIND_TIMEOUT): Promise<Peer | null> {
    return new Promise(resolve => {
      let peer: Peer;
      try {
        peer = new Peer(id);
      } catch {
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (!ok) peer.destroy();
        resolve(ok ? peer : null);
      };
      const timer = window.setTimeout(() => finish(false), timeoutMs);
      peer.on('open', () => finish(true));
      peer.on('error', () => finish(false));
    });
  }

  /** Nobody answered: run the match locally instead of showing a defeat screen. */
  private failMigration(): void {
    if (!this.migrating) return;
    this.migrating = false;
    this.cbs.onMigrateFailed();
  }

  /** Last-resort mode: this client becomes its own authority but stays in the match. */
  goSolo(): void {
    this.migrating = false;
    this.isHost = true;
    this.connected = false;
    this.online = false;
    this.hostId = this.myId;
    this.disposePeer();
    this.peerId = this.myId;
    this.hostPeer = '';
  }

  private disposePeer(): void {
    for (const conn of this.conns.values()) this.closeQuietly(conn);
    this.conns.clear();
    this.lastSeen.clear();
    this.joined.clear();
    this.peerToPlayer.clear();
    this.playerToPeer.clear();
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch {
        /* ignore */
      }
    }
    this.peer = null;
    if (this.codePeer) {
      try {
        this.codePeer.destroy();
      } catch {
        /* ignore */
      }
    }
    this.codePeer = null;
  }

  /** Tells the host we are leaving (so it can remove us) before closing the connections. */
  sendLeave(): void {
    if (this.relay) return; // official: the provider tombstones the seat instead (leave_match)
    if (this.isHost) {
      // Announce first: the survivors start electing immediately instead of waiting for a timeout.
      this.broadcast({ t: 'hostgone', reason: 'The host left the planet' });
    } else if (this.hostId) {
      this.sendTo(this.hostId, { t: 'bye', pid: this.myId });
    }
  }

  /**
   * Host only: removes one player from the room. The reason travels to their client (which leaves
   * the lobby and shows it), and the channel is closed right after — the close is what actually
   * drops them from the host's roster, exactly like any other departure. The short delay is only so
   * the 'kick' message is flushed before the channel goes away.
   */
  kickPlayer(id: string, reason: string): void {
    const peer = this.peerIdOf(id);
    const conn = this.conns.get(peer);
    if (!conn) return;
    try {
      conn.send({ t: 'kick', reason });
    } catch {
      /* ignore */
    }
    window.setTimeout(() => this.closeQuietly(conn), 140);
  }

  // ------------------------------------------------------------ messaging

  /** Sends to a *player* id (the id the game keys players by) — peer ids are resolved here. */
  sendTo(id: string, msg: NetMessage): void {
    if (!id || id === this.myId) return;
    if (this.relay) {
      this.relay.send(id, msg);
      return;
    }
    const conn = this.conns.get(this.peerIdOf(id));
    if (conn && conn.open) {
      try {
        conn.send(msg);
        this.noteTraffic(msg);
      } catch {
        /* ignore */
      }
    }
  }

  sendToHost(msg: NetMessage): void {
    if (this.relay) {
      // Official: the authority is the "host". Its own sends loop back locally exactly like
      // a P2P host's do; everyone else addresses the authority seat.
      if (this.isHost) {
        this.cbs.onMessage(this.myId, msg);
        return;
      }
      if (this.hostId && this.hostId !== this.myId) this.relay.send(this.hostId, msg);
      return;
    }
    if (this.isHost) {
      this.cbs.onMessage(this.myId, msg);
      return;
    }
    this.sendTo(this.hostId, msg);
  }

  broadcast(msg: NetMessage, exceptId?: string): void {
    if (this.relay) {
      this.relay.broadcast(msg, exceptId);
      return;
    }
    const skipPeer = exceptId ? this.peerIdOf(exceptId) : '';
    for (const [id, conn] of this.conns) {
      if (id === skipPeer || id === this.peerId) continue;
      if (!conn.open) continue;
      try {
        conn.send(msg);
        this.noteTraffic(msg);
      } catch {
        /* ignore */
      }
    }
  }

  update(dt: number): void {
    if (this.relay) {
      // Official transport: no channels to ping, no elections, no desert recovery — the
      // authority is decided server-side from seat liveness. Only the traffic meter runs.
      this.statT += dt;
      if (this.statT >= 1) {
        this.msgsPerSec = this.statsOn ? this.statMsgs / this.statT : 0;
        this.bytesPerSec = this.statsOn ? this.statBytes / this.statT : 0;
        this.rxBytesPerSec = this.statsOn ? this.statRxBytes / this.statT : 0;
        this.txBytesPerSec = this.statsOn ? this.statTxBytes / this.statT : 0;
        this.statMsgs = 0;
        this.statBytes = 0;
        this.statRxBytes = 0;
        this.statTxBytes = 0;
        this.statT = 0;
      }
      return;
    }
    // keepalive / stale connection detection
    this.pingT -= dt;
    if (this.pingT <= 0) {
      this.pingT = 4;
      if (this.isHost) {
        this.broadcast({ t: 'ping', ts: Date.now() });
      } else if (this.hostPeer && this.hostId) {
        this.sendTo(this.hostId, { t: 'ping', ts: Date.now() });
      }
    }
    // traffic meter window (diagnostics only — zero cost while F1 is closed)
    this.statT += dt;
    if (this.statT >= 1) {
      this.msgsPerSec = this.statsOn ? this.statMsgs / this.statT : 0;
      this.bytesPerSec = this.statsOn ? this.statBytes / this.statT : 0;
      this.rxBytesPerSec = this.statsOn ? this.statRxBytes / this.statT : 0;
      this.txBytesPerSec = this.statsOn ? this.statTxBytes / this.statT : 0;
      this.statMsgs = 0;
      this.statBytes = 0;
      this.statRxBytes = 0;
      this.statTxBytes = 0;
      this.statT = 0;
    }
    // Never drop peers while the tab is backgrounded: browsers throttle timers there.
    const now = performance.now();
    if (document.visibilityState === 'visible') {
      for (const [id, t] of this.lastSeen) {
        if (now - t > 60000 && id !== this.hostPeer) {
          const conn = this.conns.get(id);
          if (conn) conn.close();
        }
      }
    }
    // A host with NO connections that recently HAD them (or was just handed the room) goes looking
    // for where its players went: probe the code, rejoin whoever answers, or rebuild the room on
    // the same code. A host that has simply always been alone (solo play) never arms — chasing an
    // empty room is what used to bounce it to the main menu — and a finished rebuild stands itself
    // down until company is actually lost again.
    if (this.isHost && !this.recovering) {
      if (this.conns.size > 0) {
        this.desertArmedAt = 0;
        this.lastConnAt = now;
      } else {
        const last = Math.max(this.promotedAt, this.lastConnAt);
        if (last > 0 && now - last < 30000) {
          if (this.desertArmedAt === 0) this.desertArmedAt = now;
          else if (now - this.desertArmedAt >= DESERT_GRACE) void this.recoverFromDesert();
        } else {
          this.desertArmedAt = 0;
        }
      }
    }
  }

  leave(): void {
    this.disposePeer();
    this.relay = null; // dropping the room drops the official wire too — never leak it into P2P
    this.isHost = false;
    this.connected = false;
    this.online = false;
    this.migrating = false;
    this.migrationFrom = '';
    this.migrationAttempt = 0;
    this.desertArmedAt = 0;
    this.lastConnAt = 0;
    this.promotedAt = 0;
    this.recovering = false;
    this.code = '';
    // The identity outlives the room: the same tab that joins another one keeps its seat.
    this.peerId = this.myId;
    this.hostId = '';
    this.hostPeer = '';
    this.rosterIds = [];
    this.hostOrder = [];
  }

  /** 0..1 quality hint from recent ping (approximate, for the debug overlay). */
  latencyHint = -1;

  noteLatency(ms: number): void {
    this.latencyHint = clamp(ms, 0, 999);
  }

  // ------------------------------------------------------------ diagnostics (F1 overlay)

  /**
   * Traffic meters for the debug overlay. They are only sampled while the overlay is open: the
   * byte figure is an estimate of the serialized message size, which costs one JSON.stringify per
   * message, and the game's own tick paths never stringify anything (state is packed into the
   * objects PeerJS serializes once per send, at the network tick rate).
   */
  msgsPerSec = 0;
  bytesPerSec = 0;
  /** Split RX/TX meters (r186 plan §0.3/§49) — the overlay can show which direction is heavy. */
  rxBytesPerSec = 0;
  txBytesPerSec = 0;
  private statsOn = false;
  private statMsgs = 0;
  private statBytes = 0;
  private statRxBytes = 0;
  private statTxBytes = 0;
  private statT = 0;

  setStats(on: boolean): void {
    if (on === this.statsOn) return;
    this.statsOn = on;
    this.msgsPerSec = 0;
    this.bytesPerSec = 0;
    this.rxBytesPerSec = 0;
    this.txBytesPerSec = 0;
    this.statMsgs = 0;
    this.statBytes = 0;
    this.statRxBytes = 0;
    this.statTxBytes = 0;
    this.statT = 0;
  }

  /** One word for the F1 overlay: no signalling at all is OFFLINE, solo play included. */
  roleLabel(): 'OFFLINE' | 'HOST' | 'CLIENT' {
    if (!this.online) return 'OFFLINE';
    return this.isHost ? 'HOST' : 'CLIENT';
  }

  private noteTraffic(msg: NetMessage, direction: 'rx' | 'tx' = 'tx'): void {
    if (!this.statsOn) return;
    this.statMsgs++;
    let size = 0;
    try {
      size = JSON.stringify(msg).length;
    } catch {
      /* circular payload (never happens with the game's messages) — the count still counts */
    }
    this.statBytes += size;
    if (direction === 'rx') this.statRxBytes += size;
    else this.statTxBytes += size;
  }
}
