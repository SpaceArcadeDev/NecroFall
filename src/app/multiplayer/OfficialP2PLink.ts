// NECROFALL — official-match PEER-TO-PEER transport (hybrid architecture, 2026-09-29).
//
// Official matches keep their name and their SpacetimeDB control plane (queue,
// seats, lifecycle, verification) but the GAMEPLAY WIRE is now the same WebRTC
// DataChannel fabric the P2P mode uses — peer to peer, direct, one hop. This
// link is a small full mesh between the match's seats:
//
//   • every seat opens a PeerJS peer under a deterministic id derived from the
//     match and its seat (`nf-ofc-<matchId>-<seatId>`), so no code exchange or
//     extra signalling state is needed — the roster IS the address book;
//   • the lower seat id dials the higher one, so each pair has exactly one
//     dialer and no double connections;
//   • if a pair cannot connect (ICE failure, symmetric NAT), messages for that
//     pair fall back to the SpacetimeDB relay — the provider owns that policy,
//     this link simply reports `direct` or not;
//   • the mesh keeps retrying failed pairs in the background and upgrades them
//     to direct the moment they connect.
//
// The link never touches game state: it moves opaque message objects between
// seat ids. The relay fallback (match_msg) remains for pairs this link cannot
// serve; SpacetimeDB never gates a frame (the provider sends through whichever
// path is live, fire-and-forget).
import Peer, { DataConnection } from 'peerjs';
import { snapshotBacklogged } from '../../networking/SnapshotBackpressure';

export interface LinkSeat {
  seatId: number;
  hex: string;
}

export interface LinkPairState {
  seatId: number;
  hex: string;
  direct: boolean;
}

/** How often failed/not-yet-connected pairs are re-dialed. */
const REDIAL_INTERVAL_MS = 5000;
/** Peer-id namespace for official matches (P2P room codes never look like this). */
const PEER_ID_PREFIX = 'nf-ofc';

function peerIdFor(matchId: number, seatId: number): string {
  return `${PEER_ID_PREFIX}-${matchId}-${seatId}`;
}

export class OfficialP2PLink {
  private peer: Peer | null = null;
  private matchId = 0;
  private mySeat = -1;
  private seats = new Map<number, string>(); // seatId -> hex
  private conns = new Map<number, DataConnection>(); // OPEN data channels
  private dialing = new Map<number, number>(); // seatId -> performance.now of last dial attempt
  private sweepTimer = 0;
  private destroyed = false;
  private myPeerId = '';
  /** Throttle for `ensureAlive()` (send-miss recovery). */
  private lastAliveCheck = 0;

  constructor(
    /** One message arrived over a direct channel (from a seat's id). */
    private readonly onMessage: (fromSeatId: number, msg: unknown) => void,
    /** Direct/relay topology changed (fires at most a few times per match). */
    private readonly onStateChange: () => void,
  ) {}

  /** Arm the mesh for a match. Idempotent; call again with a fresh roster to update it. */
  start(matchId: number, mySeat: number, roster: LinkSeat[]): void {
    if (this.destroyed) return;
    const restart = this.matchId !== matchId || this.mySeat !== mySeat;
    this.matchId = matchId;
    this.mySeat = mySeat;
    if (restart) {
      this.teardownPeer();
      this.conns.clear();
      this.dialing.clear();
    }
    this.myPeerId = peerIdFor(matchId, mySeat);
    this.setSeats(roster);
    if (restart || !this.peer) this.openPeer();
    if (!this.sweepTimer) {
      this.sweepTimer = window.setInterval(() => this.sweep(), REDIAL_INTERVAL_MS);
    }
  }

  /** The roster changed (seat joined/left): update the address book and dial new pairs. */
  setSeats(roster: LinkSeat[]): void {
    const next = new Map<number, string>();
    for (const s of roster) if (s.seatId !== this.mySeat && s.hex) next.set(s.seatId, s.hex);
    this.seats = next;
    // Drop channels to seats that left.
    for (const [seatId, conn] of [...this.conns]) {
      if (!next.has(seatId)) {
        try { conn.close(); } catch { /* already gone */ }
        this.conns.delete(seatId);
        this.dialing.delete(seatId);
      }
    }
    for (const seatId of [...this.dialing.keys()]) if (!next.has(seatId)) this.dialing.delete(seatId);
    this.dialAll();
  }

  /** True when a direct channel to this seat is OPEN right now. */
  isDirect(seatId: number): boolean {
    return this.conns.get(seatId)?.open === true;
  }

  /** Try the direct channel. Returns false when the caller must use the relay fallback. */
  send(seatId: number, msg: unknown): boolean {
    const conn = this.conns.get(seatId);
    if (!conn || !conn.open) {
      // Opportunistic recovery: background tabs throttle timers, so the periodic sweep can
      // stall for a minute — a send miss is a much better trigger for a fresh attempt.
      this.ensureAlive();
      return false;
    }
    try {
      if (typeof msg === 'object' && msg !== null && snapshotBacklogged(conn, msg)) return true;
      conn.send(msg);
      return true;
    } catch {
      this.conns.delete(seatId);
      this.onStateChange();
      this.ensureAlive();
      return false;
    }
  }

  /**
   * Open the peer / re-dial missing pairs if not attempted recently. Called on send misses and
   * by the periodic sweep; the throttle keeps it cheap under the 15 Hz message streams.
   */
  ensureAlive(): void {
    if (this.destroyed || !this.matchId) return;
    const now = performance.now();
    if (now - this.lastAliveCheck < 3000) return;
    this.lastAliveCheck = now;
    if (!this.peer) this.openPeer();
    this.dialAll();
  }

  /** Debug/telemetry view: who is direct, who is still on the relay path. */
  state(): { myPeerId: string; mySeat: number; pairs: LinkPairState[] } {
    const pairs: LinkPairState[] = [];
    for (const [seatId, hex] of this.seats) {
      pairs.push({ seatId, hex, direct: this.isDirect(seatId) });
    }
    return { myPeerId: this.myPeerId, mySeat: this.mySeat, pairs };
  }

  stop(): void {
    this.destroyed = true;
    if (this.sweepTimer) {
      window.clearInterval(this.sweepTimer);
      this.sweepTimer = 0;
    }
    for (const conn of this.conns.values()) {
      try { conn.close(); } catch { /* already gone */ }
    }
    this.conns.clear();
    this.dialing.clear();
    this.seats.clear();
    this.teardownPeer();
  }

  // ------------------------------------------------------------ internals

  private openPeer(): void {
    if (this.destroyed || this.peer || !this.matchId) return;
    const peer = new Peer(this.myPeerId);
    this.peer = peer;
    peer.on('open', () => {
      this.dialAll();
      this.onStateChange();
    });
    peer.on('connection', (conn) => this.bind(conn));
    peer.on('disconnected', () => {
      // Signalling socket dropped (common on the public PeerJS cloud): reconnect.
      if (!this.destroyed && this.peer === peer) {
        try { peer.reconnect(); } catch { /* will retry on the sweep */ }
      }
    });
    peer.on('close', () => {
      // The peer itself gave up — let the next send miss / sweep reopen it.
      if (this.peer === peer) this.peer = null;
    });
    peer.on('error', (err: unknown) => {
      const type = (err as { type?: string })?.type ?? '';
      if (type === 'unavailable-id') {
        // A previous instance (a reload race, a stale tab) still holds our id on the
        // signalling server. Back off and try again — the sweep reopens the peer.
        this.teardownPeer();
      } else if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
        this.teardownPeer();
      }
      // 'peer-unavailable' just means a dial target is not registered yet: silent retry.
    });
  }

  private teardownPeer(): void {
    const peer = this.peer;
    this.peer = null;
    if (!peer) return;
    try { peer.destroy(); } catch { /* already gone */ }
  }

  /** Periodic: keep the peer alive and re-dial every pair that is not direct yet. */
  private sweep(): void {
    if (this.destroyed) return;
    if (!this.peer) this.openPeer();
    this.dialAll();
  }

  private dialAll(): void {
    for (const seatId of this.seats.keys()) this.tryDial(seatId);
  }

  private tryDial(seatId: number): void {
    if (this.destroyed || seatId === this.mySeat) return;
    if (this.isDirect(seatId)) return;
    const peer = this.peer;
    // One dialer per pair: the LOWER seat id dials, the higher one waits for `connection`.
    if (this.mySeat < 0 || this.mySeat > seatId) return;
    if (!peer || peer.destroyed || !peer.open) return;
    const last = this.dialing.get(seatId) ?? 0;
    // A dial may take several seconds to fail; don't stack attempts.
    if (performance.now() - last < REDIAL_INTERVAL_MS - 500) return;
    this.dialing.set(seatId, performance.now());
    try {
      const conn = peer.connect(peerIdFor(this.matchId, seatId), { reliable: true });
      this.bind(conn, seatId);
    } catch {
      /* retried on the sweep */
    }
  }

  private bind(conn: DataConnection, hintedSeat?: number): void {
    const resolveSeat = (): number | undefined => {
      if (hintedSeat !== undefined) return hintedSeat;
      const id = this.seatOfPeerId(conn.peer);
      return id;
    };

    conn.on('open', () => {
      const seatId = resolveSeat();
      if (seatId === undefined || seatId === this.mySeat) {
        try { conn.close(); } catch { /* fine */ }
        return;
      }
      this.conns.set(seatId, conn);
      this.onStateChange();
    });
    conn.on('data', (data: unknown) => {
      const seatId = resolveSeat();
      if (seatId === undefined) return;
      if (!this.conns.has(seatId)) this.conns.set(seatId, conn);
      this.onMessage(seatId, data);
    });
    conn.on('close', () => {
      const seatId = resolveSeat();
      if (seatId !== undefined && this.conns.get(seatId) === conn) {
        this.conns.delete(seatId);
        this.onStateChange();
      } else {
        // Seat unknown (closed before it ever opened) — clear any stale entry by value.
        for (const [id, c] of [...this.conns]) if (c === conn) {
          this.conns.delete(id);
          this.onStateChange();
        }
      }
    });
    conn.on('error', () => {
      const seatId = resolveSeat();
      if (seatId !== undefined && this.conns.get(seatId) === conn) {
        this.conns.delete(seatId);
        this.onStateChange();
      }
    });
    // The dialed (outgoing) side may already be open by the time we bind.
    if (conn.open) {
      const seatId = resolveSeat();
      if (seatId !== undefined && seatId !== this.mySeat) {
        this.conns.set(seatId, conn);
        this.onStateChange();
      }
    }
  }

  /** `nf-ofc-<matchId>-<seatId>` back to the seat id. */
  private seatOfPeerId(peerId: string): number | undefined {
    const parts = peerId.split('-');
    if (parts.length < 4) return undefined;
    const seat = Number(parts[parts.length - 1]);
    return Number.isFinite(seat) ? seat : undefined;
  }
}
