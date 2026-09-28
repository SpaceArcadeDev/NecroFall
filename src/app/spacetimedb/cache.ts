// NECROFALL — client row cache (plan §23/§48).
//
// A thin, dependency-free store fed by the SDK's table callbacks: subscriptions
// decide which rows RESIDE here (own profile, friends, the viewed profile, the
// match), and panels read straight from the cache and re-render on change.
import { SpacetimeConnectionLike } from './bindings';
import {
  CandidatePlayerRow,
  CandidateRow,
  FollowRow,
  hexOf,
  MatchHistoryRow,
  MatchPlayerRow,
  MatchRow,
  MatchServerUsageRow,
  PartyMemberRow,
  PartyRow,
  PlayerInventoryRow,
  PlayerLoadoutRow,
  PlayerPresenceRow,
  PlayerRow,
  PlayerSettingsRow,
  PlayerStatsRow,
  PlayerWalletRow,
  ProfileViewRow,
  QueueEntryRow,
} from './rows';

type Row = { [key: string]: unknown };

const TABLES = [
  'player',
  'playerStats',
  'playerWallet',
  'playerInventory',
  'playerLoadout',
  'playerPresence',
  'playerSettings',
  'follow',
  'profileView',
  'party',
  'partyMember',
  'match',
  'matchPlayer',
  'matchHistory',
] as const;

const VIEWS = ['myQueueEntry', 'myCandidate', 'myCandidatePlayers', 'myMatchUsage'] as const;

export class ClientCache {
  static readonly shared = new ClientCache();

  private rows = new Map<string, Row[]>();
  private listeners = new Set<() => void>();
  private attached: SpacetimeConnectionLike | null = null;
  private pending = false;

  attach(conn: SpacetimeConnectionLike): void {
    if (this.attached === conn) return;
    this.attached = conn;
    this.rows.clear();
    for (const name of [...TABLES, ...VIEWS]) this.watch(conn, name);
    this.changed();
  }

  detach(): void {
    this.attached = null;
    this.rows.clear();
    this.changed();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Coalesces bursts into one notification per animation frame. */
  private changed(): void {
    if (this.pending) return;
    this.pending = true;
    const flush = (): void => {
      this.pending = false;
      for (const cb of [...this.listeners]) {
        try {
          cb();
        } catch (err) {
          console.warn('[NECROFALL] cache listener failed', err);
        }
      }
    };
    if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') {
      requestAnimationFrame(flush);
    } else {
      // rAF NEVER fires in a background tab — and the shell's boot waits on this
      // notification (account rows arriving), so always fall back to a timer.
      setTimeout(flush, 16);
    }
  }

  private watch(conn: SpacetimeConnectionLike, name: string): void {
    const handle = conn.db?.[name];
    if (!handle) return;
    const rebuild = (): void => {
      try {
        this.rows.set(name, [...handle.iter()] as Row[]);
      } catch (err) {
        console.warn(`[NECROFALL] cache rebuild failed for ${name}`, err);
        this.rows.set(name, []);
      }
      this.changed();
    };
    handle.onInsert?.(rebuild as never);
    handle.onDelete?.(rebuild as never);
    handle.onUpdate?.(rebuild as never);
    rebuild();
  }

  private list<T>(name: string): T[] {
    return (this.rows.get(name) ?? []) as T[];
  }

  /** The caller's latest match usage summary (debug end-screen stats), or null. */
  myMatchUsage(): MatchServerUsageRow | null {
    return this.list<MatchServerUsageRow>('myMatchUsage')[0] ?? null;
  }

  // ------------------------------------------------------------ typed accessors
  me(myHex: string): PlayerRow | null {
    return this.playerByHex(myHex);
  }

  playerByHex(hex: string): PlayerRow | null {
    if (!hex) return null;
    return this.list<PlayerRow>('player').find(r => hexOf(r.identity) === hex) ?? null;
  }

  /** Every known player row (the roster subscription) — name / friend-code search reads this. */
  allPlayers(): PlayerRow[] {
    return this.list<PlayerRow>('player');
  }

  statsByHex(hex: string): PlayerStatsRow | null {
    return this.list<PlayerStatsRow>('playerStats').find(r => hexOf(r.identity) === hex) ?? null;
  }

  walletByHex(hex: string): PlayerWalletRow | null {
    return this.list<PlayerWalletRow>('playerWallet').find(r => hexOf(r.identity) === hex) ?? null;
  }

  inventoryByHex(hex: string): PlayerInventoryRow[] {
    return this.list<PlayerInventoryRow>('playerInventory').filter(r => hexOf(r.identity) === hex);
  }

  loadoutByHex(hex: string): PlayerLoadoutRow[] {
    return this.list<PlayerLoadoutRow>('playerLoadout').filter(r => hexOf(r.identity) === hex);
  }

  presenceByHex(hex: string): PlayerPresenceRow | null {
    return this.list<PlayerPresenceRow>('playerPresence').find(r => hexOf(r.identity) === hex) ?? null;
  }

  /** The account's settings row (control remaps live here). */
  settingsByHex(hex: string): PlayerSettingsRow | null {
    return this.list<PlayerSettingsRow>('playerSettings').find(r => hexOf(r.identity) === hex) ?? null;
  }

  /** Who `hex` follows. */
  following(hex: string): FollowRow[] {
    return this.list<FollowRow>('follow').filter(r => hexOf(r.follower) === hex);
  }

  /** Who follows `hex`. */
  followers(hex: string): FollowRow[] {
    return this.list<FollowRow>('follow').filter(r => hexOf(r.following) === hex);
  }

  /** Mutual follows = friends (plan §5). */
  friends(hex: string): string[] {
    const following = new Set(this.following(hex).map(r => hexOf(r.following)));
    return this.followers(hex)
      .map(r => hexOf(r.follower))
      .filter(h => following.has(h));
  }

  isFollowing(hex: string, targetHex: string): boolean {
    return this.following(hex).some(r => hexOf(r.following) === targetHex);
  }

  profileViewers(profileHex: string): ProfileViewRow[] {
    return this.list<ProfileViewRow>('profileView')
      .filter(r => hexOf(r.profile) === profileHex)
      .sort((a, b) => Number(b.lastViewedAt.microsSinceUnixEpoch - a.lastViewedAt.microsSinceUnixEpoch));
  }

  myParty(hex: string): PartyRow | null {
    const membership = this.list<PartyMemberRow>('partyMember').find(r => hexOf(r.identity) === hex);
    if (!membership) return null;
    return this.list<PartyRow>('party').find(r => r.partyId === membership.partyId) ?? null;
  }

  partyMembers(partyId: number): PartyMemberRow[] {
    return this.list<PartyMemberRow>('partyMember').filter(r => r.partyId === partyId);
  }

  myQueue(): QueueEntryRow | null {
    return this.list<QueueEntryRow>('myQueueEntry')[0] ?? null;
  }

  myCandidate(): CandidateRow | null {
    return this.list<CandidateRow>('myCandidate')[0] ?? null;
  }

  myCandidatePlayers(): CandidatePlayerRow[] {
    return this.list<CandidatePlayerRow>('myCandidatePlayers');
  }

  match(matchId: number): MatchRow | null {
    return this.list<MatchRow>('match').find(r => r.matchId === matchId) ?? null;
  }

  matchPlayers(matchId: number): MatchPlayerRow[] {
    return this.list<MatchPlayerRow>('matchPlayer')
      .filter(r => r.matchId === matchId)
      .sort((a, b) => a.id - b.id);
  }

  /** Every resident seat belonging to `hex` (the matchmaking scope subscribes only these). */
  matchPlayersOfSelf(hex: string): MatchPlayerRow[] {
    return this.list<MatchPlayerRow>('matchPlayer').filter(r => hexOf(r.identity) === hex);
  }

  /** The live match the given player is seated in (if any). */
  activeMatchFor(hex: string): MatchRow | null {
    for (const row of this.list<MatchPlayerRow>('matchPlayer')) {
      if (hexOf(row.identity) !== hex) continue;
      if (row.left) continue; // an abandoned seat never counts as "in a match"
      const m = this.match(row.matchId);
      if (m && m.status !== 2) return m;
    }
    return null;
  }

  historyFor(hex: string): MatchHistoryRow[] {
    return this.list<MatchHistoryRow>('matchHistory')
      .filter(r => hexOf(r.identity) === hex)
      .sort((a, b) => Number(b.endedAt.microsSinceUnixEpoch - a.endedAt.microsSinceUnixEpoch));
  }
}
