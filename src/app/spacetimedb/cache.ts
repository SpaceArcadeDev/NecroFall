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
  PlanetControlHistoryRow,
  PlanetDiscoveryRow,
  PlayerInventoryRow,
  PlayerLoadoutRow,
  PlayerPresenceRow,
  PlayerRow,
  PlayerSettingsRow,
  PlayerStatsRow,
  PlayerWalletRow,
  ProfileViewRow,
  QueueEntryRow,
  RankedPlanetRow,
  RankedPlanetReservationRow,
  RankedSeasonRow,
  RankedLocationDiscoveryRow,
  RankHistoryRow,
  ServerClockRow,
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
  'rankedSeason',
  'rankedPlanet',
  'planetDiscovery',
  'rankedLocationDiscovery',
  'rankedPlanetReservation',
  'planetControlHistory',
  'rankHistory',
  'serverClock',
] as const;

const VIEWS = ['myQueueEntry', 'myCandidate', 'myCandidatePlayers', 'myMatchUsage', 'rankedTop'] as const;

export class ClientCache {
  static readonly shared = new ClientCache();

  private rows = new Map<string, Row[]>();
  private listeners = new Set<() => void>();
  private attached: SpacetimeConnectionLike | null = null;
  private pending = false;
  /** SERVER CLOCK (plan §14): last server stamp + the client time it landed at. */
  private clockServerUs = 0;
  private clockClientUs = 0;

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
        const next = [...handle.iter()] as Row[];
        this.rows.set(name, next);
        // The clock row is special: remember WHEN it landed so `serverNowUs`
        // can interpolate server time between the 1 Hz stamps.
        if (name === 'serverClock' && next[0]) {
          this.clockServerUs = Number((next[0] as unknown as ServerClockRow).nowUs);
          this.clockClientUs = Date.now() * 1000;
        }
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

  // ------------------------------------------------------------ ranked (plan §33–§57)

  /** The ACTIVE season (or the newest one) — source of the universe seed. */
  rankedSeason(): RankedSeasonRow | null {
    const rows = this.list<RankedSeasonRow>('rankedSeason');
    return rows.find(r => r.active) ?? rows[0] ?? null;
  }

  /** Every persistent planet row of one galaxy (discovered / controlled only). */
  rankedPlanetsForGalaxy(galaxyId: number): RankedPlanetRow[] {
    return this.list<RankedPlanetRow>('rankedPlanet').filter(r => r.galaxyId === galaxyId);
  }

  /** Every persistent planet row, all galaxies (the ownership overlay's source). */
  rankedPlanetsAll(): RankedPlanetRow[] {
    return this.list<RankedPlanetRow>('rankedPlanet');
  }

  rankedPlanet(key: string): RankedPlanetRow | null {
    return this.list<RankedPlanetRow>('rankedPlanet').find(r => r.planetKey === key) ?? null;
  }

  /** Keys locked by a filling/playing ranked match (plan §36). */
  reservedPlanetKeys(): Set<string> {
    const out = new Set<string>();
    for (const r of this.list<RankedPlanetReservationRow>('rankedPlanetReservation')) out.add(r.planetKey);
    return out;
  }

  /** First discoverers of a planet, in order (plan §35). */
  planetDiscoveries(key: string): PlanetDiscoveryRow[] {
    return this.list<PlanetDiscoveryRow>('planetDiscovery')
      .filter(r => r.planetKey === key)
      .sort((a, b) => a.discoveryOrder - b.discoveryOrder);
  }

  // ------------------------------------------------------------ location discovery (plan §1–§4)

  /**
   * The first discoverers of ONE location (`G:gx:gy` / `…:S:id` / `…:P:id`),
   * in order — slot 1 is the first footfall, slot 9 is the last that counts.
   * Empty when the location is undiscovered OR its scope is not subscribed.
   */
  locationDiscoveries(locationKey: string): RankedLocationDiscoveryRow[] {
    return this.list<RankedLocationDiscoveryRow>('rankedLocationDiscovery')
      .filter(r => r.locationKey === locationKey)
      .sort((a, b) => a.discoveryIndex - b.discoveryIndex);
  }

  /**
   * SERVER TIME in micros (plan §14/§46) — the last 1 Hz stamp plus the client
   * milliseconds elapsed since it landed. Falls back to the device clock while
   * the subscription is still empty (offline/guest), never for authoritative
   * decisions: the server owns every expiry.
   */
  serverNowUs(): number {
    if (!this.clockClientUs) return Date.now() * 1000;
    return this.clockServerUs + (Date.now() * 1000 - this.clockClientUs);
  }

  /** Ownership stints of a planet, newest first (plan §77). */
  planetControlHistory(key: string): PlanetControlHistoryRow[] {
    return this.list<PlanetControlHistoryRow>('planetControlHistory')
      .filter(r => r.planetKey === key)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  }

  /** The caller's rank movements, newest first (plan §57). */
  myRankHistory(hex: string): RankHistoryRow[] {
    return this.list<RankHistoryRow>('rankHistory')
      .filter(r => hexOf(r.identity) === hex)
      .sort((a, b) => b.id - a.id);
  }

  /** The KING OF GODS leaderboard (plan §78) — top ranked survivors. */
  rankedTop(): PlayerRow[] {
    return this.list<PlayerRow>('rankedTop');
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
