// NECROFALL — the account shell (plan §8/§9/§55/§63/§84 phase 1–7).
//
// Boot decision:
//   • SpacetimeDB not configured        → the legacy P2P/offline game boots as before.
//   • Configured, signed out            → login screen (with an offline escape hatch).
//   • Configured, signed in             → connect, onboard if new, then the MOBA shell.
//
// The shell owns the account UI (home/play/profile/friends/matchmaking/loading)
// and hands control to the SAME 3D game for both modes:
//   • P2P      → the existing game boots untouched (its lobbies, its rules).
//   • OFFICIAL → the game boots with the official bridge attached; poses flow
//               through SpacetimeDB and the server computes the result.
import { Game, type SoloMode } from '../core/Game';
import { APP_CONFIG, AppConfig } from './config';
import { AuthProvider } from './auth/AuthProvider';
import { NullAuthProvider, SpacetimeAuthProvider } from './auth/SpacetimeAuthProvider';
import { isAuthCallbackUrl } from './auth/authCallback';
import { ClientCache } from './spacetimedb/cache';
import { clearStoredDbToken, hasStoredDbToken, SpacetimeConnection, storedDbTokenExpired, type ConnectionState } from './spacetimedb/connection';
import { reportMatchStats, chooseColony, setPlayerName, discoverLocation, recordPlanetPlay, submitPlanetRecord } from './spacetimedb/reducers';
import { COLONY_NONE, hexOf, RECORD_MODE_SPEEDRUN, RECORD_MODE_SURVIVAL } from './spacetimedb/rows';
import { subscribeAccount, subscribeMatchmaking, subscribePlayer } from './spacetimedb/subscriptions';
import { OfficialMultiplayerProvider } from './multiplayer/OfficialMultiplayerProvider';
import { ProviderGameEvent } from './multiplayer/MultiplayerProvider';
import { OfficialMatchPayload } from './multiplayer/OfficialTypes';
import { P2PMultiplayerProvider, LegacyLauncher } from './multiplayer/P2PMultiplayerProvider';
import { MultiplayerSession } from './multiplayer/MultiplayerSession';
import { COLONIES, IS_TOUCH, loadFpsPref, loadQualityPref, saveFpsPref, saveQualityPref, type FpsPref, type QualityPref } from '../core/Config';
import { loadSelection, selectionToWire } from '../customization/CustomizationStore';
import { Keybinds } from '../input/Keybinds';
import { ControlsModal } from './settings/ControlsModal';
import { GraphicsPage } from './settings/GraphicsPage';
import type { ScreenName } from '../ui/UI';
import { OrientationGate } from '../ui/Orientation';
import { fullscreenMode, toggleFullscreen } from '../ui/Fullscreen';
import { ShellContext, LegacyLaunchOptions, LobbySeatInfo, LobbyFormat } from './ShellContext';
import { navigate, onRouteChange, parseRoute, routeToHash } from './router';
import { CurrencyBar } from './ui/CurrencyBar';
import { FriendRail } from './ui/FriendRail';
import { MobileBottomNav, type BottomNavKey } from './ui/MobileBottomNav';
import { button, clear, el } from './ui/dom';
import { uiRouter, type UIScreen } from '../ui/shell/UIRouter';
import { auditShellScreen, assertNoHorizontalOverflow, installAuditHandle, validateMenuActions } from '../ui/dev/UIAudit';
import type { ContractScreen } from '../ui/data/MenuActionRegistry';
import { NFMoreSheet, type MoreSheetEntry } from '../ui/components/NFMoreSheet';
import { createPageHeader } from '../ui/shell/PageHeader';
import { getIcon } from '../ui/icons';
import { PlayerSearch } from './friends/PlayerSearch';
import { GAME_MODES, type GameModeDefinition } from '../ui/data/GameModeRegistry';
import { rankStarRow } from '../rank/RankService';
import { PlayPage } from './lobby/PlayPage';
import { LobbyPage } from './lobby/LobbyPage';
import { SoloPage } from './lobby/SoloPage';
import { CustomPage } from './lobby/CustomPage';
import { EventsPage } from './events/EventsPage';
import { MatchmakingPage } from './matchmaking/MatchmakingPage';
import { ProfilePage } from './profile/ProfilePage';
import { RankPage } from './rank/RankPage';
import { showRankResultOverlay } from './rank/RankResultOverlay';
import { DEFAULT_UNIVERSE_SEED, decodeGalaxyId, parsePlanetKey } from '../rankmap/procedural/SeedHash';
import type { PlanetDescriptor } from '../rankmap/procedural/GalaxyTypes';
import { LOCATION_GALAXY, LOCATION_PLANET, LOCATION_SYSTEM, galaxyLocationKey, planetLocationKey, systemLocationKey } from '../rankmap/DiscoveryTypes';

type ShellScreen = 'boot' | 'login' | 'onboarding' | 'home' | 'play' | 'lobby' | 'room' | 'rank' | 'solo' | 'custom' | 'events' | 'graphics' | 'match' | 'queue' | 'profile' | 'loading' | 'hidden';

interface ActivePage {
  onHide?: () => void;
  update?: () => void;
}

export class AppShell implements ShellContext {
  readonly config: AppConfig = APP_CONFIG;
  readonly official = new OfficialMultiplayerProvider();
  readonly p2p: P2PMultiplayerProvider;

  private root: HTMLElement;
  /** The row that carries the page pane and the friends bar SIDE BY SIDE (user ask:
   *  "the collapsed friends list has its own relative area, not an overlay"). */
  private bodyRow: HTMLElement;
  private screenHost: HTMLElement;
  private chrome: HTMLElement;
  private topBar: CurrencyBar;
  /** The screen the LOBBY ROOM returns to (set by goLobbyRoom()) and its FORMAT tag. */
  private roomReturnScreen: ShellScreen = 'lobby';
  private currentLobbyFormat: LobbyFormat = 'CLASSIC';
  /** A join-by-code in flight: open the room when its rows land, or toast after 6 s. */
  private pendingRoomJoin = '';
  private pendingRoomAt = 0;
  /** The centred boot / loading spinner (user ask: never a blank screen). */
  private bootSpin: HTMLElement;
  private bootSpinLabel: HTMLElement;
  private nav: MobileBottomNav;
  private rail: FriendRail;
  private moreSheet: NFMoreSheet;
  private toastEl: HTMLElement;
  private pill: HTMLButtonElement;
  /** The mode the player last LAUNCHED (user ask 2026-10-03): the bottom bar's hero button
   *  becomes that mode — its own icon, its menu, and RANK's golden star row. Persisted. */
  private lastModeId: GameModeDefinition['id'] = 'classic';

  private auth: AuthProvider;
  private screen: ShellScreen = 'boot';
  private page: ActivePage | null = null;
  /** The live RANK page (the nav's MAP tab expands its map — user ask 2026-10-03). */
  private rankPage: RankPage | null = null;
  /** Set by MAP: the next rank render opens with the intergalactic map EXPANDED. */
  private rankExpandOnShow = false;
  private shellHidden = false;
  private accountReady = false;
  private officialMatchActive = false;
  private game: Game | null = null;
  private gamePoll = 0;
  private lastStatsReport = 0;
  private loadingSince = 0;
  private cachedPayload: OfficialMatchPayload | null = null;
  private unsubs: (() => void)[] = [];
  private avatarStageHost: HTMLElement | null = null;
  private avatarStageArgs: { colony: number; acc: string } | null = null;
  private restageTimer = 0;
  /** The colony-onboarding takeover: shell-hidden legacy screen + a floating CONFIRM bar. */
  private onbBar: HTMLElement | null = null;
  private onbConfirm: HTMLButtonElement | null = null;
  private onbColonyPick = -1;
  private playerSearch: PlayerSearch | null = null;
  private controlsModal: ControlsModal | null = null;
  private backBtn: HTMLButtonElement;
  /** The fixed "RETURN TO LOBBY" chip (user ask 2026-10-03): visible on every shell
   *  page while the player stands in an open lobby and no match is running. */
  private lobbyReturn: HTMLButtonElement;
  private pendingGameScreen: 'customize' | 'howto' | 'controls' | null = null;  private gameScreenWatch = 0;
  /** Last in-game screen seen — the friends bar's menu-ish check reads it. */
  private lastGameScreen: ScreenName = 'play';
  /** The main menu's live chrome height + 6 — the floating friends bar's top offset. */
  private railTopPx = 78;
  /**
   * The OFFICIAL lobby is standing on the game's own P2P lobby screen (user ask 2026-09-29).
   * The shell owns the screen though — the flag routes the screen-change observer and feeds
   * `game.ui.updateOfficialLobby` from the data ticks.
   */
  private officialLobbyActive = false;
  private officialLobbySince = 0;
  private officialLobbySig = '';
  /** Toast shown by the observer when the official lobby hands the screen back. */
  private pendingLobbyExit = '';
  /** `?room=CODE` invite link (legacy `?party=CODE` still accepted) — consumed once ready. */
  private invitedRoomCode = '';
  /** `?custom=CODE` invite link for a CUSTOM lobby (user ask 2026-09-30). */
  private invitedCustomCode = '';
  /** The room screen's flavour: the official party lobby or a CUSTOM lobby. */
  private roomFlavour: 'party' | 'custom' = 'party';
  /** The CUSTOM lobby room state (the reused lobby screen wears P2P rules there). */
  private customLobbyActive = false;
  private customLobbySince = 0;
  private customLobbySig = '';
  /**
   * When each room's rows first went MISSING (0 = present). Every reconnect wipes and replays
   * the row cache — a mobile app switch (e.g. the share sheet) drops the socket, and the rooms
   * must ride that replay out instead of concluding the lobby is gone (user report 2026-10-03:
   * "share invite link, return to the browser, I'm automatically out of the lobby").
   */
  private roomLostSince: { official: number; custom: number } = { official: 0, custom: 0 };
  /** A SOLO run (speedrun / survival) owns the screen until its results are dismissed. */
  private soloRunActive = false;
  private lastSoloMode: SoloMode = 'speedrun';
  /** The arg the current screen was rendered with (mode screens re-render on a mode switch). */
  private screenArg = '';
  /** The last matchmaking queue we saw was RANKED — return there, not the lobby (plan §48). */
  private lastQueueRanked = false;
  /** Ranked-result overlays already shown (match ids). */
  private rankResultsShown = new Set<number>();
  /**
   * The boot watchdog (user report: "blank screen with the rotating planet, no UI"): a wedged
   * token refresh or a connect that never answers must NEVER leave the shell invisible. If no
   * account screen has appeared after this long, the login card surfaces with the reason — and a
   * late success still takes the screen over through `onData()`.
   */
  private bootWatchdog = 0;
  private static readonly BOOT_WATCHDOG_MS = 20_000;
  /** Room rows land a beat after CREATE / a code join — nothing closes inside this window. */
  private static readonly ROOM_GATHER_GRACE_MS = 4000;
  /** Rows missing for THIS long on a healthy connection = the lobby is actually gone. */
  private static readonly ROOM_LOST_GRACE_MS = 6000;
  /** ShellScreen → UIRouter screen (overhaul §2): one transition ledger. */
  private static readonly UI_SCREEN_MAP: Record<ShellScreen, UIScreen> = {
    boot: 'boot',
    login: 'login',
    onboarding: 'onboarding',
    home: 'main',
    play: 'play',
    lobby: 'lobby',
    room: 'lobby',
    rank: 'rank',
    solo: 'solo',
    custom: 'custom',
    events: 'events',
    graphics: 'graphics',
    match: 'match',
    queue: 'queue',
    profile: 'profile',
    loading: 'loading',
    hidden: 'loading',
  };
  /** Screens whose action contract the dev audit enforces (§42/§43). */
  private static readonly AUDIT_CONTRACT: Partial<Record<ShellScreen, ContractScreen>> = {
    home: 'main',
    play: 'play',
    solo: 'solo',
    custom: 'custom',
    events: 'events',
    rank: 'rank',
    profile: 'profile',
  };

  constructor(private app: HTMLElement) {
    this.auth = APP_CONFIG.authConfigured ? new SpacetimeAuthProvider() : new NullAuthProvider();
    // Every (re)connect may ask for the freshest credential: OIDC access tokens expire (15 min),
    // and a long-idle tab or a browser restart must be able to refresh — or resume the session
    // from the provider cookie — instead of retrying a dead token until the login wall appears.
    SpacetimeConnection.shared.setTokenSource(() => this.auth.validToken());
    // Console/debug handle (the game exposes `window.necrofall` the same way).
    (window as unknown as Record<string, unknown>).nfShell = this;

    this.root = el('div', 'nf-shell hidden');
    this.chrome = el('div', 'nf-chrome');
    this.screenHost = el('main', 'nf-main');
    // The pages and the friends bar share ONE flex row: the bar owns its column
    // (it never overlays the page — user ask 2026-09-29).
    this.bodyRow = el('div', 'nf-body');
    this.bodyRow.appendChild(this.screenHost);
    this.root.appendChild(this.chrome);
    this.root.appendChild(this.bodyRow);
    this.toastEl = el('div', 'nf-toasts');
    this.root.appendChild(this.toastEl);
    (document.body ?? app).appendChild(this.root);

    // ---- BOOT SPINNER (user ask 2026-09-29): while the shell has NOTHING to show
    // (the planet boots, the account connects) and while a match loads, a centred
    // spinner proves the app is alive — never a blank frame.
    this.bootSpin = el('div', 'nf-boot-spin');
    this.bootSpin.appendChild(el('div', 'nf-boot-spin-ring', ''));
    this.bootSpinLabel = el('div', 'nf-boot-spin-label', 'CONNECTING…');
    this.bootSpin.appendChild(this.bootSpinLabel);
    (document.body ?? app).appendChild(this.bootSpin);

    this.topBar = new CurrencyBar(() => this.myHex(), () => this.openProfile(this.myHex()));
    this.nav = new MobileBottomNav((key) => this.onNav(key));
    this.rail = new FriendRail(this);
    this.moreSheet = new NFMoreSheet(() => this.moreEntries());
    this.chrome.appendChild(this.topBar.element);
    this.chrome.appendChild(this.nav.element);
    // LAST-PLAYED MODE (user ask 2026-10-03): restore the hero button before the first paint —
    // RANK also needs its star row, refreshed on every data tick (`refreshNavMode`).
    try {
      const stored = localStorage.getItem('nf.mm.lastmode') as GameModeDefinition['id'] | null;
      if (stored && GAME_MODES.some((m) => m.id === stored)) this.lastModeId = stored;
    } catch {
      /* private mode */
    }
    this.refreshNavMode();
    // The bar sits in the body row's own column (the page never renders under it).
    this.bodyRow.appendChild(this.rail.element);
    // The friends OVERLAY + the notifications live OUTSIDE the shell root: the shell moves
    // them (and the collapsed bar) over the game whenever a P2P / official lobby hides it.
    (document.body ?? app).appendChild(this.rail.overlay);
    (document.body ?? app).appendChild(this.rail.notifications);

    // The chevron that returns from child screens (play, lobby, party, queue, profile).
    this.backBtn = button('', 'nf-back hidden', () => this.onBack());
    this.backBtn.setAttribute('aria-label', 'Back');
    this.backBtn.dataset.action = 'back';
    this.backBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>';
    this.chrome.insertBefore(this.backBtn, this.chrome.firstChild);

    // The fixed RETURN TO LOBBY chip (user ask 2026-10-03): a lobby is a place you
    // can step out of — the chip is the one-tap way back from any page while its
    // doors stay open. Hidden the moment a match starts or the lobby closes.
    this.lobbyReturn = button('', 'nf-return-lobby hidden', () => this.openCurrentLobby());
    this.lobbyReturn.type = 'button';
    this.lobbyReturn.dataset.action = 'lobby';
    this.lobbyReturn.setAttribute('aria-label', 'Return to lobby');
    // the lobby's ENTER-DOOR symbol (user ask 2026-10-03): the shell's one stroke icon map —
    // `door-in` points INTO the room (the plain `door` glyph arrows out and is the sign-out
    // icon), so the chip reads "back into the room" at a glance.
    this.lobbyReturn.innerHTML = `<span class="nf-return-ico">${getIcon('door-in')}</span><span class="nf-return-lbl">RETURN TO LOBBY</span>`;
    this.root.appendChild(this.lobbyReturn);

    const launcher: LegacyLauncher = (options) => this.launchLegacy(options);
    this.p2p = new P2PMultiplayerProvider(launcher);

    // The settings gear opens the MORE sheet (§30/§31).
    this.topBar.settings.addEventListener('click', () => this.moreSheet.toggle());
    // Dev-only UI integrity checker: `__nfAudit('main')` in the console (§42).
    if (import.meta.env.DEV) installAuditHandle(() => this.root);

    // The avatar stage is sized from its box — restage it when the window reflows
    // (and re-measure the friends bar's main-menu offset while we're at it).
    window.addEventListener('resize', () => {
      this.restageAvatar();
      this.refreshRail();
    });

    // The floating "ACCOUNT" pill lets a P2P player return to the shell from
    // the legacy menu without reloading.
    this.pill = button('ACCOUNT', 'nf-pill hidden', () => {
      if (!this.game || (this.game.phase !== 'menu' && this.game.phase !== 'ended')) return;
      // The shell is not a room session: drop the room link before returning.
      const url = new URL(window.location.href);
      url.searchParams.delete('lobby');
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
      this.showShell('home');
    });
    (document.body ?? app).appendChild(this.pill);

    // `?room=CODE` invite link — the lobby room's twin of the P2P `?lobby=CODE`.
    const params = new URLSearchParams(window.location.search);
    this.invitedRoomCode = (params.get('room') ?? params.get('party') ?? '').trim().toUpperCase();
    // `?custom=CODE` — the CUSTOM lobby's invite link (user ask 2026-09-30).
    this.invitedCustomCode = (params.get('custom') ?? '').trim().toUpperCase();

    this.unsubs.push(
      this.official.onGameEvent((event) => this.onProviderEvent(event)),
      ClientCache.shared.onChange(() => this.onData()),
      onRouteChange(() => this.onRoute()),
      SpacetimeConnection.shared.onConnect(() => this.onConnected()),
      SpacetimeConnection.shared.onState((state) => this.onConnectionState(state))
    );

    // Reducer validation failures (SenderError from the module) become toasts — with one
    // exception: "You are already in a match" is not a dead end but a fact (this identity
    // still holds a live seat). Hand the player their match page instead of a wall, where
    // they can rejoin or watch it conclude.
    const onReducerError = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ name?: string; message?: string }>).detail;
      if (!detail?.message) return;
      if (/already in a match/i.test(detail.message)) {
        const live = ClientCache.shared.activeMatchFor(this.myHex());
        if (live) {
          // A match this session ALREADY concluded locally is not a re-entry target: its server
          // finish is on the way (nexus report / time limit), so never yank the player back in.
          if (this.official.hasEndedLocally(live.matchId)) {
            this.toast('Your last match is wrapping up — try again in a moment.');
            return;
          }
          this.toast(`You're still in match #${live.matchId} — opening it…`);
          navigate({ name: 'match', id: live.matchId });
          return;
        }
      }
      this.toast(detail.message);
    };
    window.addEventListener('nf:reducer-error', onReducerError);
    this.unsubs.push(() => window.removeEventListener('nf:reducer-error', onReducerError));
  }

  // ------------------------------------------------------------ shell context

  myHex(): string {
    return SpacetimeConnection.shared.identityHex;
  }

  openProfile(hex: string): void {
    if (!hex) return;
    subscribePlayer(hex);
    navigate({ name: 'profile', hex });
  }

  goHome(): void {
    this.navigateTo({ name: 'home' });
  }

  /** The contextual back (ShellContext): pages with their own PageHeader call this. */
  goBack(): void {
    this.onBack();
  }

  goPlay(): void {
    this.navigateTo({ name: 'play' });
  }

  /** The LOBBY screen (CLASSIC's home): official party or the P2P entry. */
  goLobby(): void {
    this.navigateTo({ name: 'lobby' });
  }

  /** The OFFICIAL LOBBY ROOM screen (CREATE LOBBY's home) — the P2P lobby's own dress. */
  goLobbyRoom(): void {
    // Remember where we CAME FROM so the room's BACK returns there, not to a
    // hardcoded lobby: rank → rank, lobby → lobby, play → play.
    if (this.screen !== 'room' && this.screen !== 'queue') this.roomReturnScreen = this.screen;
    this.roomFlavour = 'party';
    this.navigateTo({ name: 'room' });
  }

  /** Leave the lobby room for the screen that opened it (its BACK / LEAVE answer). */
  goBackFromLobbyRoom(): void {
    // A CUSTOM lobby's back = LEAVE the lobby (server-side seat removal), then the setup screen.
    if (this.roomFlavour === 'custom') {
      this.official.leaveCustomLobby();
      this.customLobbyActive = false;
      this.game?.ui.updateOfficialLobby(null);
      this.roomFlavour = 'party';
      this.navigateTo({ name: 'custom' });
      return;
    }
    switch (this.roomReturnScreen) {
      case 'rank':
        this.goRank();
        break;
      case 'play':
        this.goPlay();
        break;
      case 'lobby':
        this.goLobby();
        break;
      default:
        this.goHome();
        break;
    }
  }

  /** The FORMAT tag the lobby room wears: set by whoever opens it. */
  setLobbyFormat(mode: LobbyFormat): void {
    this.currentLobbyFormat = mode;
  }

  lobbyFormat(): LobbyFormat {
    return this.currentLobbyFormat;
  }

  /**
   * JOIN a lobby by code (lobby setup + the rank menu's quick join). The join fires
   * immediately and the LOBBY ROOM opens only once the server's rows land — pasting a
   * code must never dump the player on a fresh-lobby page (user ask 2026-09-29). A
   * bad code toasts instead (the server's own error, or the 6 s grace below).
   */
  joinLobbyByCode(code: string): void {
    this.pendingRoomJoin = code.trim().toUpperCase();
    this.pendingRoomAt = performance.now();
    this.official.joinPartyByCode(this.pendingRoomJoin);
  }

  /** The RANK page — the intergalactic map (plan §48). */
  goRank(): void {
    this.navigateTo({ name: 'rank' });
  }

  /**
   * Nav MAP (user ask 2026-10-03): land on RANK with the intergalactic map ALREADY
   * EXPANDED — the dashboard's collapsed view is skipped. If rank is already up
   * (same-screen navigation is a no-op), expand the live page in place.
   */
  private goRankExpanded(): void {
    if (this.screen === 'rank' && !this.shellHidden) {
      this.rankPage?.openFullscreenMap();
      return;
    }
    this.rankExpandOnShow = true;
    this.goRank();
  }

  /** The GRAPHICS settings page (settings ▸ GRAPHICS): preset + frame-rate cap. */
  goGraphics(): void {
    this.navigateTo({ name: 'graphics' });
  }

  /** The EVENTS page (user ask 2026-10-03): the live-ops board — season + worlds in play. */
  goEvents(): void {
    this.navigateTo({ name: 'events' });
  }

  // ------------------------------------------------------------ solo + custom (user ask 2026-09-30)

  /** The SOLO picker (speedrun / survival) — the rank map as a run picker. */
  goSolo(mode: 'speedrun' | 'survival'): void {
    this.navigateTo({ name: 'solo', mode });
  }

  /** The CUSTOM lobby setup screen (create / join by code). */
  goCustom(): void {
    this.navigateTo({ name: 'custom' });
  }

  /** The reused LOBBY screen, wearing CUSTOM (P2P rules on the hybrid server). */
  goCustomRoom(): void {
    if (this.screen !== 'room' && this.screen !== 'queue') this.roomReturnScreen = this.screen;
    this.roomFlavour = 'custom';
    this.navigateTo({ name: 'room' });
  }

  /** CREATE a custom lobby: the room opens once its rows land. */
  createCustomLobby(): void {
    this.roomFlavour = 'custom';
    this.official.createCustomLobby();
    this.goCustomRoom();
  }

  /** JOIN a custom lobby by code: the room opens once its rows land. */
  joinCustomLobbyByCode(code: string): void {
    this.roomFlavour = 'custom';
    this.official.joinCustomLobbyByCode(code);
    this.goCustomRoom();
  }

  /**
   * START A SOLO RUN on one planet: the record board loads here (so the end screen can beat
   * it), the game takes the screen, and the finish reports through the record reducers.
   */
  startSoloRun(mode: 'speedrun' | 'survival', planet: PlanetDescriptor): void {
    this.setLastMode(mode);
    const game = this.ensureGame();
    const cache = ClientCache.shared;
    const me = cache.me(this.myHex());
    if (!me || me.colony === COLONY_NONE || !me.playerName) {
      this.toast('Finish onboarding first.');
      return;
    }
    const season = cache.rankedSeason();
    const universeSeed = season ? Number(season.universeSeed % 4294967296n) >>> 0 : DEFAULT_UNIVERSE_SEED;
    const rec = cache.planetRecord(planet.key, mode === 'speedrun' ? RECORD_MODE_SPEEDRUN : RECORD_MODE_SURVIVAL);
    this.soloRunActive = true;
    this.lastSoloMode = mode;
    this.hideShell(true);
    try {
      game.startSoloRun({
        mode,
        planetKey: planet.key,
        ring: planet.ring,
        universeSeed,
        seed: planet.seed,
        colony: me.colony,
        bestMs: rec ? Number(rec.timeMs) : 0,
        bestName: rec?.playerName ?? '',
        onStart: () => recordPlanetPlay(planet.key),
        onFinish: (info) =>
          submitPlanetRecord(
            info.mode === 'speedrun' ? RECORD_MODE_SPEEDRUN : RECORD_MODE_SURVIVAL,
            info.planetKey,
            info.timeMs
          ),
      });
    } catch (err) {
      this.soloRunActive = false;
      this.showShell('solo', mode);
      this.toast(err instanceof Error ? err.message : 'Could not start the run.');
    }
  }

  /**
   * FREEROAM (user ask): the single-player sandbox — a PROCEDURAL planet like a classic match,
   * no enemies, no clock, no objectives, the body dropped ON THE GROUND rather than on the
   * orbiting deck, and NO class picker (it roams on the default RIFT kit). The world takes the
   * screen the moment this is called. Nothing counts and nothing can end it, so there are no
   * records to load or submit; the Esc menu's LEAVE MATCH is the way out, and the shell returns
   * to the PLAY menu.
   */
  startFreeroam(): void {
    this.setLastMode('freeroam');
    const game = this.ensureGame();
    const hex = this.myHex();
    const me = hex ? ClientCache.shared.me(hex) : null;
    this.soloRunActive = true;
    this.lastSoloMode = 'freeroam';
    this.hideShell(true);
    try {
      game.startSoloRun({
        mode: 'freeroam',
        planetKey: '',
        ring: 0,
        universeSeed: DEFAULT_UNIVERSE_SEED,
        // A FRESH procedural world per visit — the run's own rolled seed IS the planet seed.
        seed: (Math.random() * 0xffffffff) >>> 0,
        colony: me && me.colony !== COLONY_NONE ? me.colony : 0,
      });
    } catch (err) {
      this.soloRunActive = false;
      this.showShell('play');
      this.toast(err instanceof Error ? err.message : 'Could not start freeroam.');
    }
  }

  private renderSolo(mode: 'speedrun' | 'survival'): void {
    const page = new SoloPage(this, mode);
    this.page = { onHide: () => page.onHide(), update: () => page.update() };
    this.screenHost.appendChild(page.element);
  }

  private renderCustom(): void {
    const page = new CustomPage(this);
    this.page = { update: () => undefined };
    this.screenHost.appendChild(page.element);
  }

  /** The EVENTS board (user ask 2026-10-03): season countdown + live worlds. */
  private renderEvents(): void {
    const page = new EventsPage(this);
    this.page = { onHide: () => page.onHide(), update: () => page.update() };
    this.screenHost.appendChild(page.element);
    page.update();
  }

  /** The saved graphics choice — the live game's, or the stored one before it boots. */
  currentGraphicsPref(): QualityPref {
    return this.game?.graphicsChoice ?? loadQualityPref();
  }

  /** Apply + persist a graphics choice on the running world (no-op-safe before the world boots). */
  setGraphicsPref(pref: QualityPref): void {
    if (this.game) this.game.setGraphicsPref(pref);
    else saveQualityPref(pref);
  }

  /** The saved frame-rate ceiling. */
  currentFpsPref(): FpsPref {
    return this.game?.fpsChoice ?? loadFpsPref();
  }

  /** Apply + persist a frame-rate ceiling on the running world. */
  setFpsPref(pref: FpsPref): void {
    if (this.game) this.game.setFpsPref(pref);
    else saveFpsPref(pref);
  }

  /** Jump back into the queue screen (the ranked panel's "SEARCHING…" button). */
  goQueue(): void {
    if (this.officialMatchActive || this.shellHidden) return;
    this.showShell('queue');
  }

  /** Where the player belongs after leaving the queue: their lobby room, or the CLASSIC setup. */
  returnFromQueue(): void {
    const hex = this.myHex();
    if (this.lastQueueRanked) {
      this.lastQueueRanked = false;
      this.goRank();
      return;
    }
    if (hex && ClientCache.shared.myParty(hex)) this.goLobbyRoom();
    else this.goLobby();
  }

  /** The chevron: the LOBBY ROOM returns to whatever opened it, the setup to the format menu. */
  private onBack(): void {
    if (this.screen === 'room') this.goBackFromLobbyRoom();
    // RANK is a mode menu: its back returns to the PLAY format menu (user ask 2026-10-03).
    else if (this.screen === 'lobby' || this.screen === 'solo' || this.screen === 'custom' || this.screen === 'rank') this.goPlay();
    else this.goHome();
  }

  /** Nav: step into the in-game customizer (its back button returns to the shell). */
  openCustomize(): void {
    this.openGameScreen('customize');
  }

  /**
   * Boot-level screens that live in the GAME's UI (customizer, how-to, controls):
   * the shell steps aside, and the moment the player backs out to the game menu
   * the shell takes over again — never the old P2P menu.
   */
  private openGameScreen(screen: 'customize' | 'howto' | 'controls'): void {
    if (!this.game) {
      this.toast('This screen opens once the world has loaded.');
      return;
    }
    this.hideShell(true);
    this.pendingGameScreen = screen;
    this.game.ui.show(screen);
    if (!this.gameScreenWatch) {
      this.gameScreenWatch = window.setInterval(() => this.checkPendingGameScreen(), 150);
    }
  }

  /** Watch for the player backing out of a shell-launched game screen. */
  private checkPendingGameScreen(): void {
    const game = this.game;
    if (!this.pendingGameScreen || !game) {
      window.clearInterval(this.gameScreenWatch);
      this.gameScreenWatch = 0;
      this.pendingGameScreen = null;
      return;
    }
    const screen = game.ui.currentScreen;
    if (screen === 'play' || screen === 'game') {
      this.handleGameScreenChange(screen);
    }
  }

  /** Synchronous screen-switch observer (UI.onScreenChange) — fires with no flash. */
  private handleGameScreenChange(name: ScreenName): void {
    this.lastGameScreen = name;
    // The friends bar's visibility follows the GAME's screen too (customize/how-to step
    // aside, lobby/play wear it — user ask).
    this.refreshRail();
    if (!this.pendingGameScreen) return;
    // The player backed out of a shell-launched screen (customizer / how-to / controls):
    // the game's base screen is PLAY now that the legacy menu screen is gone (user ask
    // 2026-10-03) — the shell takes the screen back with no flash.
    if (name !== 'play' && name !== 'game') return;
    this.pendingGameScreen = null;
    if (this.gameScreenWatch) {
      window.clearInterval(this.gameScreenWatch);
      this.gameScreenWatch = 0;
    }
    if (name === 'play') this.showShell('home');
  }

  /** Settings ▸ CONTROLS: the remap sheet, persisted to the account. */
  private openControls(): void {
    if (!this.controlsModal) this.controlsModal = new ControlsModal(this);
    this.controlsModal.open(this.root);
  }

  /** The find-survivors sheet (ADD FRIEND in the friends overlay): search by name or player id. */
  openPlayerSearch(): void {
    if (!this.playerSearch) {
      this.playerSearch = new PlayerSearch(
        () => this.myHex(),
        (hex) => {
          this.playerSearch?.close();
          this.openProfile(hex);
        }
      );
    }
    this.playerSearch.open(this.root);
  }

  /**
   * Navigation that never silently no-ops: when the target hash is ALREADY the
   * current one (e.g. leaving the QUEUE screen, which overlays the play route),
   * setting it does not raise `hashchange` — so the route is applied directly.
   */
  private navigateTo(route: Parameters<typeof routeToHash>[0]): void {
    if (routeToHash(route) === window.location.hash) this.onRoute();
    else navigate(route);
  }

  /**
   * `?room=CODE` invite (the lobby room's twin of the P2P `?lobby=CODE`): once the
   * account can join, fire the join, open the LOBBY ROOM and strip the param
   * so a refresh never re-fires a stale invite.
   */
  private consumeInvite(): void {
    // CUSTOM lobby invite (`?custom=CODE`, user ask 2026-09-30): same rules as `?room=` — join
    // once the account can, open the room, strip the param so a refresh never re-fires it.
    const customCode = this.invitedCustomCode;
    if (customCode) {
      const hex = this.myHex();
      const me = hex ? ClientCache.shared.me(hex) : null;
      if (!hex || !me || me.colony === COLONY_NONE || !me.playerName) return; // login/onboarding first
      if (this.officialMatchActive || this.screen === 'loading') return; // a live match owns the screen
      if (ClientCache.shared.activeMatchFor(hex)) return; // a mid-match rejoin wins
      this.invitedCustomCode = '';
      const url = new URL(window.location.href);
      url.searchParams.delete('custom');
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
      this.toast(`Joining lobby ${customCode}…`);
      this.official.joinCustomLobbyByCode(customCode);
      this.goCustomRoom(); // the room gathers as the rows land
      return;
    }
    const code = this.invitedRoomCode;
    if (!code) return;
    const hex = this.myHex();
    const me = hex ? ClientCache.shared.me(hex) : null;
    if (!hex || !me || me.colony === COLONY_NONE || !me.playerName) return; // login/onboarding first
    if (this.officialMatchActive || this.screen === 'loading') return; // a live match owns the screen
    const cache = ClientCache.shared;
    if (cache.activeMatchFor(hex)) return; // a mid-match rejoin wins over the invite
    this.invitedRoomCode = '';
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    url.searchParams.delete('party');
    window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
    if (cache.myParty(hex)) {
      this.goLobbyRoom(); // already in one — the invite is moot, just open it
      return;
    }
    this.toast(`Joining lobby ${code}…`);
    this.official.joinPartyByCode(code);
    this.goLobbyRoom(); // the LOBBY ROOM gathers the roster as the rows land
  }

  toast(message: string): void {
    const node = el('div', 'nf-toast', message);
    this.toastEl.appendChild(node);
    window.setTimeout(() => node.classList.add('out'), 3200);
    window.setTimeout(() => node.remove(), 3900);
  }

  /** Show / hide the centred boot spinner (blank shell or match load). */
  private setBootSpinner(on: boolean, label = 'CONNECTING…'): void {
    this.bootSpin.classList.toggle('hidden', !on);
    if (on) this.bootSpinLabel.textContent = label;
  }

  // ------------------------------------------------------------ boot

  async boot(): Promise<void> {
    // 0) Mobile: NECROFALL is a landscape game. The shared orientation gate (ui/Orientation.ts)
    //    guards the SHELL screens too, and the first gesture asks for fullscreen + a landscape
    //    lock — the exact contract the legacy P2P screens always had.
    OrientationGate.shared();
    if (IS_TOUCH) OrientationGate.shared().armAutoLock();

    // 1) A provider redirect may be landing right now.
    if (APP_CONFIG.authConfigured && isAuthCallbackUrl()) {
      try {
        await (this.auth as SpacetimeAuthProvider).completeLoginFromUrl();
      } catch (err) {
        this.toast(err instanceof Error ? err.message : 'Sign-in failed.');
      }
    }

    // 2) Without a configured backend the game is exactly what it always was.
    //    A room link is a legacy P2P session — never put the shell in front of it.
    const room = new URLSearchParams(window.location.search).get('lobby');
    if (!APP_CONFIG.configured || room) {
      this.launchLegacy(room ? { roomCode: room } : {});
      return;
    }

    // 2b) LIVE PLANET BACKDROP: the 3D world boots behind every account screen,
    //     so the shell menus sit on the same rotating planet the in-game menu did.
    this.ensureBackdrop();

    // The planet must never be the ONLY thing on screen: seconds, not forever.
    this.armBootWatchdog();

    // 3) No OIDC provider (local server / guest-only setup): connect straight
    //    away with the stored device identity.
    if (!APP_CONFIG.authConfigured) {
      await this.connectAccount();
      return;
    }

    // 4) Signed out. A browser that already holds a GUEST identity resumes it
    //    straight away (no login wall for returning guests); first-time
    //    visitors get the login screen.
    if (!this.auth.session()) {
      if (hasStoredDbToken()) {
        await this.connectAccount();
        return;
      }
      this.showShell('login');
      return;
    }

    await this.connectAccount();
  }

  private async connectAccount(): Promise<void> {
    // validToken also resumes a session from the provider cookie when the local session is
    // gone (a browser restart), so a returning player walks straight into the account.
    const token = await this.auth.validToken();
    // Nothing to present at all: no OIDC session (and no cookie resume) AND the stored device
    // token is missing or an EXPIRED access token the server would certainly refuse. Say so —
    // a failed connect here would read as "the server is down" (user report 2026-09-29).
    const storedCredential = hasStoredDbToken() && !storedDbTokenExpired();
    if (!token && APP_CONFIG.authConfigured && !storedCredential) {
      this.showShell('login', undefined, 'Your session expired — sign in again.');
      return;
    }
    const ok = await SpacetimeConnection.shared.connect(token);
    if (!ok || SpacetimeConnection.shared.state === 'error') {
      const reason = !SpacetimeConnection.shared.available
        ? 'Online play is not set up yet — generate the SpacetimeDB bindings (see spacetimedb/README.md).'
        : 'Could not reach the game server. Retry below.';
      this.showShell('login', undefined, reason);
      return;
    }
    // onConnected() fires from the connection listener and takes over.
  }

  /**
   * Watchdog arm: if the shell is still on 'boot' after BOOT_WATCHDOG_MS, surface the login card
   * with the reason instead of an invisible shell over a rotating planet. The connection keeps
   * retrying in the background; a later success still takes over via `onData()`.
   */
  private armBootWatchdog(): void {
    if (this.bootWatchdog) return;
    this.bootWatchdog = window.setTimeout(() => {
      this.bootWatchdog = 0;
      if (this.accountReady || this.screen !== 'boot') return;
      const reason =
        SpacetimeConnection.shared.state === 'connected'
          ? 'Your account did not load — retry below.'
          : 'Could not reach the game server. Retry below.';
      this.showShell('login', undefined, reason);
    }, AppShell.BOOT_WATCHDOG_MS);
  }

  private clearBootWatchdog(): void {
    if (!this.bootWatchdog) return;
    window.clearTimeout(this.bootWatchdog);
    this.bootWatchdog = 0;
  }

  /**
   * A failed FIRST connect must show something: without this the boot stayed silent (the old
   * `connect()` returned before the socket actually answered, so its error arrived after the
   * caller's one-shot state check) and the user stared at an empty planet until they cleared
   * site data. Sign-out still works because `accountReady` gates it.
   */
  private onConnectionState(state: ConnectionState): void {
    if (state !== 'error' || this.accountReady) return;
    if (this.screen !== 'boot') return; // login/loading screens already carry their own message
    this.showShell('login', undefined, 'Could not reach the game server. Retry below.');
  }

  private onConnected(): void {
    const hex = this.myHex();
    if (!hex) return;
    // The row cache MUST attach first: it registers the SDK table callbacks
    // that every panel reads from — without it, subscribed rows never surface.
    const conn = SpacetimeConnection.shared.current;
    if (conn) ClientCache.shared.attach(conn);
    subscribeAccount(hex);
    subscribeMatchmaking(hex);
    this.official.start();
    this.onData();
  }

  private onData(): void {
    this.topBar.update();
    this.refreshNavMode();
    this.rail.update();
    this.refreshRail();
    this.page?.update?.();
    // The RETURN TO LOBBY chip follows the lobby rows on EVERY data settle too — the
    // leave/join deletes land AFTER the screen switch, so a showShell-only refresh left
    // the chip stuck over a lobby that no longer existed (user report 2026-10-03:
    // "after leaving lobby, the return to lobby overlay still showing").
    this.refreshLobbyReturn();
    // The reused official lobby screen follows the party rows on every data settle.
    if (this.officialLobbyActive) this.updateOfficialLobby();

    // A join-by-code lands asynchronously: the moment the lobby's rows exist, walk in.
    if (this.pendingRoomJoin) {
      const hex = this.myHex();
      const joined = hex ? ClientCache.shared.myParty(hex) : null;
      if (joined) {
        this.pendingRoomJoin = '';
        this.goLobbyRoom();
      } else if (performance.now() - this.pendingRoomAt > 6000) {
        this.pendingRoomJoin = '';
        this.toast('No lobby found with that code.');
      }
    }

    // Control remaps ride the account: apply the authoritative row whenever it arrives.
    const hexNow = this.myHex();
    if (hexNow) Keybinds.hydrate(ClientCache.shared.settingsByHex(hexNow)?.keybinds ?? null);

    // A pending `?room=CODE` / `?custom=CODE` invite fires as soon as the account can join one.
    if (this.invitedRoomCode || this.invitedCustomCode) this.consumeInvite();

    const me = this.myHex() ? ClientCache.shared.me(this.myHex()) : null;
    // The customize stage's avatar wears the ACCOUNT colony (user ask) — pushed on every data
    // settle, so a deep link straight to Customize never shows a colony-less avatar (the home
    // screen's showShellAvatar push only covers routes that stage the home).
    if (me) this.game?.ui.setAvatarColony(me.colony);
    if (!this.accountReady && me) {
      this.accountReady = true;
      this.clearBootWatchdog();
      const needsOnboarding = me.colony === COLONY_NONE || !me.playerName;
      const route = parseRoute();
      if (needsOnboarding) this.showShell('onboarding');
      else if (route.name === 'profile') this.showShell('profile', route.hex);
      else if (route.name === 'play') this.showShell('play');
      else if (route.name === 'lobby') this.showShell('lobby');
      else if (route.name === 'room') this.showShell('room');
      else if (route.name === 'rank') this.showShell('rank');
      else if (route.name === 'solo') this.showShell('solo', route.mode);
      else if (route.name === 'custom') this.showShell('custom');
      else if (route.name === 'events') this.showShell('events');
      else if (route.name === 'graphics') this.showShell('graphics');
      else if (route.name === 'match') this.showShell('match', String(route.id));
      else this.showShell('home');
      if (!APP_CONFIG.authConfigured) {
        this.toast('Guest account — saved to this browser.');
      }
      return;
    }

    // Onboarding completion arrives ASYNCHRONOUSLY (the reducers apply and the
    // updated rows flow back through subscriptions): the moment the account
    // has both a colony and a name, leave the onboarding screen.
    if (this.accountReady && this.screen === 'onboarding' && me && me.colony !== COLONY_NONE && me.playerName) {
      const route = parseRoute();
      if (route.name === 'profile') this.showShell('profile', route.hex);
      else if (route.name === 'play') this.showShell('play');
      else if (route.name === 'lobby') this.showShell('lobby');
      else if (route.name === 'room') this.showShell('room');
      else if (route.name === 'rank') this.showShell('rank');
      else if (route.name === 'solo') this.showShell('solo', route.mode);
      else if (route.name === 'custom') this.showShell('custom');
      else if (route.name === 'events') this.showShell('events');
      else if (route.name === 'graphics') this.showShell('graphics');
      else if (route.name === 'match') this.showShell('match', String(route.id));
      else this.showShell('home');
      this.toast(`Welcome, ${me.playerName}.`);
    }
  }

  private onRoute(): void {
    if (!this.accountReady || this.shellHidden) return;
    if (this.officialMatchActive || this.soloRunActive) return;
    const route = parseRoute();
    if (route.name === 'profile') this.showShell('profile', route.hex);
    else if (route.name === 'play') this.showShell('play');
    else if (route.name === 'lobby') this.showShell('lobby');
    else if (route.name === 'room') this.showShell('room');
    else if (route.name === 'rank') this.showShell('rank');
    else if (route.name === 'solo') this.showShell('solo', route.mode);
    else if (route.name === 'custom') this.showShell('custom');
    else if (route.name === 'events') this.showShell('events');
    else if (route.name === 'graphics') this.showShell('graphics');
    else if (route.name === 'match') this.showShell('match', String(route.id));
    else if (this.screen !== 'queue' && this.screen !== 'onboarding' && this.screen !== 'loading') this.showShell('home');
  }

  private onProviderEvent(event: ProviderGameEvent): void {
    const e = event;
    if (e.type === 'queue') {
      const status = e.status;
      if (status === 'idle') {
        if (this.screen === 'queue') this.returnFromQueue();
      } else if (this.officialLobbyActive) {
        // The lobby leader pressed FIND MATCH: the queue owns the screen while the
        // whole party waits (user ask: the lobby keeps its own buttons, the search
        // switches the screen exactly like a solo FIND MATCH does).
        this.lastQueueRanked = Boolean(ClientCache.shared.myQueue()?.ranked);
        this.game?.ui.exitToMenu(); // the shell takes the screen (queue) right after
        this.showShell('queue');
      } else if (this.screen !== 'queue' && this.screen !== 'loading' && !this.shellHidden) {
        // Remember the MODE: a ranked search must return to the map, not the lobby.
        this.lastQueueRanked = Boolean(ClientCache.shared.myQueue()?.ranked);
        this.showShell('queue');
      }
    } else if (e.type === 'match-start') {
      this.beginLoading();
    } else if (e.type === 'match-end') {
      // Ranked matches get the RANK RESULT overlay once the game's own end
      // screen has landed (plan §80) — stars, ladder move and planet fate.
      this.scheduleRankResult(e.matchId);
    } else if (e.type === 'kicked') {
      // HYBRID ANTI-CHEAT (2026-09-29): the server force-removed this seat mid-match — its
      // stream disagreed with its own pose record. The seat is already a tombstone
      // server-side; detach the game (which also resets the provider) and take the screen back.
      this.toast(e.reason || 'Removed from the match.');
      if (this.game) this.game.leaveMatch();
      else this.official.leaveMatch();
      this.goHome();
    } else if (e.type === 'error') {
      this.toast(e.message || 'Multiplayer error.');
    }
  }

  /** Show the RANKED result overlay for a finished match (skip if not mine/not ranked). */
  private scheduleRankResult(matchId: number): void {
    if (this.rankResultsShown.has(matchId)) return;
    this.rankResultsShown.add(matchId);
    const m = ClientCache.shared.match(matchId);
    if (!m || !m.ranked) return;
    window.setTimeout(() => {
      const history = ClientCache.shared.myRankHistory(this.myHex()).find((h) => h.matchId === matchId);
      if (!history) return; // I left the match — no stars, no overlay
      const me = ClientCache.shared.playerByHex(this.myHex());
      const season = ClientCache.shared.rankedSeason();
      const universeSeed = season ? Number(season.universeSeed % 4294967296n) >>> 0 : DEFAULT_UNIVERSE_SEED;
      // Discovery is EARNED BY PLAYING (user ask 2026-09-28): the history row
      // proves this seat fought here, so the match's PLANET, its SOLAR SYSTEM and
      // its GALAXY all record the fighter through the ONE discovery path — the
      // server decides (duplicate slots / full lists / another ring all no-op).
      const planetKey = m.planetKey || history.planetKey;
      const parsed = planetKey ? parsePlanetKey(planetKey) : null;
      if (parsed) {
        const { gx, gy } = decodeGalaxyId(parsed.galaxyId);
        const galaxyKey = galaxyLocationKey(gx, gy);
        const systemKey = systemLocationKey(gx, gy, parsed.systemId);
        discoverLocation({
          locationType: LOCATION_PLANET,
          locationKey: planetLocationKey(gx, gy, parsed.systemId, parsed.planetId),
          galaxyId: parsed.galaxyId,
          systemId: parsed.systemId,
          planetId: parsed.planetId,
        });
        discoverLocation({
          locationType: LOCATION_SYSTEM,
          locationKey: systemKey,
          galaxyId: parsed.galaxyId,
          systemId: parsed.systemId,
          planetId: 0,
        });
        discoverLocation({
          locationType: LOCATION_GALAXY,
          locationKey: galaxyKey,
          galaxyId: parsed.galaxyId,
          systemId: 0,
          planetId: 0,
        });
      }
      showRankResultOverlay({
        matchId,
        delta: history.delta,
        oldTier: history.oldTier,
        oldDivision: history.oldDivision,
        newStars: Number(me?.rankPoints ?? history.newStars),
        winnerColony: m.winnerColony ?? null,
        myColony: me?.colony ?? 255,
        planetKey,
        universeSeed,
        onViewMap: () => {
          this.rankResultsShown.add(matchId);
          this.goRank();
        },
      });
    }, 2600);
  }

  // ------------------------------------------------------------ screens

  private showShell(screen: ShellScreen, arg?: string, message?: string): void {
    // The shell now owns the screen (the in-game UI layer is revealed only by hideShell).
    this.shellHidden = false;
    // Re-entering the SAME screen is a no-op — except when we carry a message
    // that must actually surface (e.g. "could not reach the server" on login).
    // MODE screens (solo) compare their ARG too: switching speedrun↔survival is a re-render.
    if (this.screen === screen && screen !== 'profile' && message === undefined && (arg ?? '') === this.screenArg) {
      this.page?.update?.();
      return;
    }
    // The colony-onboarding takeover belongs to the onboarding screen only.
    this.exitColonyOnboarding();
    // Mobile: every shell screen re-arms the one-tap fullscreen ask (a redirect or a refusal may
    // have consumed the previous window) — but never once fullscreen is actually on.
    if (IS_TOUCH && fullscreenMode() === 'none') OrientationGate.shared().armAutoLock();
    // Whatever screen is next, the previous one lets go of the shared avatar preview.
    this.game?.ui.hideShellAvatar();
    this.avatarStageHost = null;
    this.avatarStageArgs = null;
    this.page?.onHide?.();
    this.page = null;
    this.rankPage = null;
    clear(this.screenHost);
    // The pane is REUSED between screens: a fresh page inherits the previous one's scroll
    // position and reads as "cut off at the top" (user report on GRAPHICS, 2026-09-29).
    this.screenHost.scrollTop = 0;
    this.screenHost.scrollLeft = 0;
    this.screen = screen;
    this.screenArg = arg ?? '';
    this.root.classList.remove('hidden');
    // The friends bar rides back into its OWN column beside the page (it floated over a
    // game screen otherwise — user ask: never overlaying the page).
    if (this.rail.element.parentElement !== this.bodyRow) this.bodyRow.appendChild(this.rail.element);
    this.rail.element.classList.remove('floating');
    this.refreshRail();
    // The boot spinner is for the LOADING screen only — any real screen hides it.
    this.setBootSpinner(screen === 'loading', screen === 'loading' ? 'LOADING PLANET…' : 'CONNECTING…');
    // The `on-home` chrome tweaks (top bar order on the main menu) — the wordmark
    // itself now lives in the page header, not the chrome row (user ask 2026-10-03).
    this.root.classList.toggle('on-home', screen === 'home');
    // The planet stays as the backdrop: hide the in-game UI layer under the shell.
    this.game?.ui.setShellMode(true);
    // OWNERSHIP (user report 2026-09-29: the customize screen stayed visible UNDER the
    // profile page, so its "CUSTOMIZE" header read as the profile's own title):
    //   • a pending shell-launched game screen is moot — the shell owns the screen now;
    //   • the game may reveal its UI layer in the same tick (a boot race, or a delayed
    //     `ui.show()`), so the takeover is re-asserted on the next frame as well.
    this.pendingGameScreen = null;
    if (this.gameScreenWatch) {
      window.clearInterval(this.gameScreenWatch);
      this.gameScreenWatch = 0;
    }
    const takeover = this.game;
    if (takeover) {
      window.setTimeout(() => {
        if (!this.shellHidden) takeover.ui.setShellMode(true);
      }, 50);
    }
    // The bottom bar belongs to the MAIN MENU page ONLY (user ask 2026-10-03): child
    // pages navigate by their own chevrons and the bar returns on the home route.
    const childScreen = screen === 'play' || screen === 'lobby' || screen === 'room' || screen === 'rank' || screen === 'solo' || screen === 'custom' || screen === 'events' || screen === 'graphics' || screen === 'queue' || screen === 'profile';
    const navScreen = screen === 'home';
    this.nav.element.classList.toggle('hidden', !navScreen);
    this.backBtn.classList.toggle('hidden', !childScreen);
    this.root.classList.toggle('no-nav', !navScreen);
    // NOTE: the friends bar's visibility belongs to `refreshRail()` ALONE. The old
    // `noChrome` hide here turned it off on play/lobby and the next data tick turned it
    // back on — the "friends list pops in after a delay" report (user ask 2026-09-29).
    // The CLASSIC flow (play, setup, lobby room) wears the in-game menu dress: the
    // account chrome steps away (no profile button, currencies, ? or settings)
    // so the wordmark is the header, with the back chevron floating over the
    // top-left corner. The first signup/login screens drop the SAME chrome —
    // no friends rail, profile, currencies, help or settings around the card.
    //
    // The header chrome now belongs to the MAIN MENU ONLY (user ask 2026-09-28):
    // every other screen — play, lobby, room, rank, queue, profile, graphics —
    // runs chrome-less, wordmark or not.
    const noTopBar = screen !== 'home' && screen !== 'loading' && screen !== 'boot';
    this.topBar.element.classList.toggle('hidden', noTopBar);
    this.root.classList.toggle('bare-mode', noTopBar);

    switch (screen) {
      case 'login':
        this.nav.setActive(null);
        this.renderLogin(message);
        break;
      case 'onboarding':
        this.nav.setActive(null);
        this.renderOnboarding();
        break;
      case 'home':
        this.nav.setActive(null);
        this.renderHome();
        break;
      case 'play':
        // the bar lives on the MAIN MENU only; the hero key no longer exists (2026-10-03)
        this.nav.setActive(null);
        this.renderPlay();
        break;
      case 'lobby':
        this.nav.setActive(null);
        this.renderLobby();
        break;
      case 'room':
        this.nav.setActive(null);
        this.renderLobbyRoom();
        break;
      case 'rank':
        this.nav.setActive('map');
        this.renderRank();
        break;
      case 'solo':
        this.nav.setActive(null);
        this.renderSolo(arg === 'survival' ? 'survival' : 'speedrun');
        break;
      case 'custom':
        this.nav.setActive(null);
        this.renderCustom();
        break;
      case 'events':
        this.nav.setActive('events');
        this.renderEvents();
        break;
      case 'graphics':
        this.nav.setActive(null);
        this.renderGraphics();
        break;
      case 'match':
        this.nav.setActive(null);
        this.renderMatchJoin(Number(arg ?? 0));
        break;
      case 'queue':
        this.nav.setActive(null);
        this.renderQueue();
        break;
      case 'profile':
        this.nav.setActive(null);
        this.renderProfile(arg ?? this.myHex());
        break;
      case 'loading':
        this.nav.setActive(null);
        this.renderLoading();
        break;
      default:
        break;
    }

    // THE UI ROUTER (§2) + the DEV ACTION AUDIT (§42): one ledger for every
    // transition (motion/audio can hook `nf:ui:navigate`), and a fail-loud
    // check that the screen actually rendered its contracted actions.
    uiRouter.navigate(AppShell.UI_SCREEN_MAP[screen] ?? 'main');
    if (import.meta.env.DEV) {
      const contract = AppShell.AUDIT_CONTRACT[screen];
      if (contract) auditShellScreen(contract, this.root);
      // §38/§39: unknown action ids + document overflow are dev errors too.
      validateMenuActions(this.root);
      assertNoHorizontalOverflow();
    }
    // A page that rendered the shared PageHeader owns a REAL back chevron —
    // the floating one steps aside so there are never two controls (§2).
    const ownBack = Boolean(this.screenHost.querySelector('.nf-page-header [data-action="back"]'));
    if (ownBack) this.backBtn.classList.add('hidden');
    // The RETURN TO LOBBY chip follows the screen + the lobby rows (user ask 2026-10-03).
    this.refreshLobbyReturn();
  }

  private renderLogin(message?: string): void {
    const wrap = el('div', 'nf-page login-page');
    // Title + tagline live in their own wrapper so landscape can set them BESIDE the card.
    const side = el('div', 'nf-login-side');
    side.appendChild(el('div', 'menu-title nf-login-title', 'NECROFALL'));
    side.appendChild(el('div', 'menu-sub', 'Dive · Liberate · Dominate'));
    wrap.appendChild(side);

    const card = el('div', 'nf-login-card');
    card.appendChild(el('h1', 'nf-login-welcome', 'SIGN UP / LOG IN'));
    const slot = el('div', 'nf-login-slot');
    card.appendChild(slot);
    wrap.appendChild(card);
    this.screenHost.appendChild(wrap);

    const auth = this.auth as SpacetimeAuthProvider;

    // ---- the email form: one field, one button: the magic link goes out through the DIRECT API
    const showForm = (error?: string): void => {
      clear(slot);
      const form = el('div', 'nf-login-slot');
      if (error) form.appendChild(el('p', 'nf-error', error));
      // A wall is never a dead end: say that the shell keeps retrying in the
      // background (user report — "it stayed blank, then the login wall").
      if (error) {
        form.appendChild(
          el('p', 'nf-login-note', 'The app keeps retrying in the background — signing in resumes the moment the server answers.')
        );
      }
      const email = el('input', 'nf-input big nf-login-email') as HTMLInputElement;
      email.type = 'email';
      email.placeholder = 'EMAIL ADDRESS';
      email.autocomplete = 'email';
      email.spellcheck = false;
      const send = el('button', 'btn primary nf-wide-btn', 'SEND MAGIC LINK') as HTMLButtonElement;
      send.type = 'button';
      send.disabled = true;
      // SKIP is a bare text action — no button chrome; the card's only real control is the link.
      const skip = el('button', 'nf-skip-link', 'Skip') as HTMLButtonElement;
      skip.type = 'button';
      email.addEventListener('input', () => {
        send.disabled = !email.checkValidity();
      });
      email.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !send.disabled) send.click();
      });
      send.addEventListener('click', () => {
        const address = email.value.trim();
        if (!address) return;
        send.disabled = true;
        send.textContent = 'SENDING…';
        void auth
          .sendMagicLink(address)
          .then((result) => {
            // 'signed-in': a live provider session answered the flow in one hop — nothing to
            // email, so walk straight into the account (this used to need a manual refresh).
            if (result === 'sent') showSent(address);
            else void this.connectAccount();
          })
          .catch((err: unknown) => showForm(err instanceof Error ? err.message : 'Could not send the magic link.'));
      });
      skip.addEventListener('click', () => {
        skip.disabled = true;
        skip.textContent = 'Signing in…';
        void auth
          .loginAnonymous()
          .then((result) => {
            // Same one-hop short-circuit as the magic link: the session already landed.
            if (result === 'signed-in') void this.connectAccount();
          })
          .catch((err: unknown) => showForm(err instanceof Error ? err.message : 'Could not sign in anonymously.'));
      });
      form.appendChild(email);
      form.appendChild(send);
      form.appendChild(skip);
      slot.appendChild(form);
      window.setTimeout(() => email.focus(), 80);
    };

    // ---- waiting for the click: the tab finishes the sign-in the moment the link is used
    const showSent = (address: string): void => {
      clear(slot);
      const sent = el('div', 'nf-login-sent');
      sent.appendChild(el('div', 'nf-login-spinner', ''));
      sent.appendChild(el('h2', 'nf-login-sent-title', 'MAGIC LINK SENT'));
      const line = el('p', 'nf-login-note', 'CLICK THE LINK WE JUST SENT TO');
      sent.appendChild(line);
      sent.appendChild(el('p', 'nf-login-sent-mail', address));
      const back = el('button', 'btn nf-wide-btn', 'BACK') as HTMLButtonElement;
      back.type = 'button';
      back.addEventListener('click', () => showForm());
      sent.appendChild(back);
      slot.appendChild(sent);
      const timer = window.setInterval(() => {
        if (!sent.isConnected) {
          window.clearInterval(timer);
          return;
        }
        void auth.pollMagicLink().then(
          (state) => {
            if (state === 'used') {
              window.clearInterval(timer);
              auth.finishMagicLink();
            } else if (state === 'expired') {
              window.clearInterval(timer);
              showForm('That magic link expired — send a new one.');
            }
          },
          (err: unknown) => {
            window.clearInterval(timer);
            showForm(err instanceof Error ? err.message : 'The sign-in failed.');
          }
        );
      }, 2500);
    };

    if (message) showForm(message);
    else showForm();
  }

  private renderOnboarding(): void {
    const wrap = el('div', 'nf-page onboarding-page');
    this.screenHost.appendChild(wrap);
    // Two steps: the name first, then the colony. A reload resumes mid-flow (a name that already
    // landed jumps straight to the colony step).
    const me = ClientCache.shared.playerByHex(this.myHex());
    if (me?.playerName) this.enterColonyOnboarding();
    else this.renderNameStep(wrap);
  }

  /** Onboarding, step 1 — the name the colonies will remember. */
  private renderNameStep(wrap: HTMLElement): void {
    clear(wrap);
    wrap.appendChild(el('div', 'menu-title', 'ENTER THE FALL'));
    wrap.appendChild(el('p', 'menu-sub', 'Choose the name the colonies will remember'));

    const card = el('div', 'nf-onb-card');
    const input = el('input', 'nf-input big nf-onb-name') as HTMLInputElement;
    input.maxLength = 30;
    input.placeholder = 'LIBERATOR NAME';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const hint = el('div', 'nf-onb-hint', '3–30 CHARACTERS');
    card.appendChild(input);
    card.appendChild(hint);

    const next = el('button', 'btn primary nf-wide-btn', 'CONTINUE') as HTMLButtonElement;
    next.type = 'button';
    next.disabled = true;
    const repaint = (): void => {
      const value = input.value.trim();
      const ok = value.length >= 3;
      next.disabled = !ok;
      hint.classList.toggle('bad', value.length > 0 && !ok);
      hint.textContent = value.length > 0 && !ok ? 'AT LEAST 3 CHARACTERS' : '3–30 CHARACTERS';
    };
    input.addEventListener('input', repaint);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !next.disabled) next.click();
    });
    next.addEventListener('click', () => {
      const value = input.value.trim();
      if (value.length < 3) return;
      setPlayerName(value);
      this.enterColonyOnboarding(); // straight into the legacy SELECT COLONY screen, as a confirm step
    });

    wrap.appendChild(card);
    wrap.appendChild(next);
    repaint();
    window.setTimeout(() => input.focus(), 80);
  }

  /**
   * Onboarding, step 2 — the colony. This hands the view to the REAL in-game SELECT COLONY screen
   * (identical layout, scaling, champion avatars and animations as the legacy P2P flow); the
   * shell floats only a CONFIRM bar over it and waits for `choose_colony` to land.
   */
  private enterColonyOnboarding(): void {
    const game = this.game;
    if (!game) {
      window.setTimeout(() => {
        if (this.screen === 'onboarding') this.enterColonyOnboarding();
      }, 400);
      return;
    }
    this.onbColonyPick = -1;
    this.hideShell(false); // reveal the game canvas — `screen` stays 'onboarding' so completion lands
    game.ui.onColonyClick = (idx) => this.pickOnbColony(idx);
    game.ui.show('colony');
    game.ui.updateColonySelect(0, [0, 0, 0], -1, 1, 1);
    document.documentElement.classList.add('nf-onb-colony');

    const bar = el('div', 'nf-onb-bar');
    const confirm = el('button', 'btn primary', 'CONFIRM COLONY') as HTMLButtonElement;
    confirm.type = 'button';
    confirm.disabled = true;
    confirm.addEventListener('click', () => {
      if (this.onbColonyPick < 0) return;
      confirm.disabled = true;
      confirm.textContent = `JOINING ${COLONIES[this.onbColonyPick].name}\u2026`;
      chooseColony(this.onbColonyPick);
    });
    bar.appendChild(confirm);
    document.body.appendChild(bar);
    this.onbBar = bar;
    this.onbConfirm = confirm;
  }

  /** The legacy colony screen reported a pick — mirror it into the confirm bar. */
  private pickOnbColony(idx: number): void {
    this.onbColonyPick = idx;
    this.game?.ui.updateColonySelect(0, [0, 0, 0], idx, 1, 1);
    if (this.onbConfirm) {
      this.onbConfirm.disabled = false;
      this.onbConfirm.textContent = `CONFIRM ${COLONIES[idx].name}`;
    }
  }

  /** Tear the colony takeover down — showShell() calls this on every real screen change. */
  private exitColonyOnboarding(): void {
    if (!this.onbBar) return;
    this.onbBar.remove();
    this.onbBar = null;
    this.onbConfirm = null;
    this.onbColonyPick = -1;
    document.documentElement.classList.remove('nf-onb-colony');
    if (this.game) {
      this.game.ui.onColonyClick = () => undefined;
      if (this.game.ui.currentScreen === 'colony') this.game.ui.show('play');
    }
  }

  private renderHome(): void {
    const wrap = el('div', 'nf-page home-page');

    // ---- the shared page header (user ask 2026-10-03): the SAME title anchor and
    // gradient typography as GRAPHICS and every other page — one component, one look.
    // No second wordmark lives in the chrome row any more.
    wrap.appendChild(
      createPageHeader({ title: 'NECROFALL', subtitle: 'Dive • Purge • Dominate' })
    );

    // ---- the player's own character, staged exactly like the lobby line-up
    // (name / level / currency live in the top bar — nothing here repeats them).
    const me = ClientCache.shared.me(this.myHex());
    const colonyIdx = me && me.colony < 3 ? me.colony : -1;
    const stage = el('div', 'nf-stage');
    wrap.appendChild(stage);
    this.avatarStageHost = stage;
    this.avatarStageArgs = { colony: colonyIdx, acc: selectionToWire(loadSelection()) };

    // ---- a single colony caption under the model: identity, not a second profile card
    const colony = colonyIdx >= 0 ? COLONIES[colonyIdx] : null;
    const caption = el('div', 'nf-home-caption');
    const badge = el('div', 'nf-home-colony', colony ? colony.name : 'NO COLONY');
    if (colony) badge.style.setProperty('--nf-colony', colony.css);
    caption.appendChild(badge);
    wrap.appendChild(caption);

    this.screenHost.appendChild(wrap);
    // Stage after the box has laid out (the preview sizes itself from the element).
    this.restageAvatar();
  }

  /** (Re)hands the avatar stage to the game's shared lobby preview once layout is ready. */
  private restageAvatar(): void {
    if (!this.avatarStageHost || !this.avatarStageArgs || !this.game) return;
    if (this.restageTimer) window.clearTimeout(this.restageTimer);
    this.restageTimer = window.setTimeout(() => {
      this.restageTimer = 0;
      if (this.avatarStageHost?.isConnected && this.avatarStageArgs && !this.shellHidden) {
        this.game?.ui.showShellAvatar(this.avatarStageHost, this.avatarStageArgs.colony, this.avatarStageArgs.acc);
      }
    }, 60);
  }

  /** OFFICIAL lobby: the line-up inside the shell — same rail, real characters. */
  stageLobbyAvatars(host: HTMLElement | null, members: LobbySeatInfo[]): void {
    if (!host || members.length === 0) {
      this.game?.ui.hideShellAvatar();
      return;
    }
    this.game?.ui.showShellParty(host, members);
  }

  private renderPlay(): void {
    const page = new PlayPage(this);
    this.page = page;
    this.screenHost.appendChild(page.element);
    page.update();
  }

  private renderLobby(): void {
    const page = new LobbyPage(this);
    this.page = page;
    this.screenHost.appendChild(page.element);
    page.update();
  }

  private renderLobbyRoom(): void {
    // CUSTOM lobbies reuse the SAME screen with P2P rules (user ask 2026-09-30): READY in
    // every seat, HOST starts. The mapping lives below; the DOM is byte-for-byte the P2P lobby.
    if (this.roomFlavour === 'custom') {
      this.renderCustomRoom();
      return;
    }
    // The OFFICIAL LOBBY is the game's OWN P2P lobby screen (user ask 2026-09-29: "delete
    // [the lookalike], reuse the exact same lobby as P2P — correct tags, text, logic"):
    // the shell maps party rows in and swaps the actions, while the DOM, avatar rail and
    // mobile scaling stay byte-for-byte the P2P screen.
    this.official.refreshPartyLoadout();
    const game = this.game;
    if (!game) {
      // The shared world boots behind the shell; wait it out like the colony takeover does.
      window.setTimeout(() => {
        if (this.screen === 'room' && !this.shellHidden) this.renderLobbyRoom();
      }, 400);
      return;
    }
    this.officialLobbyActive = true;
    this.officialLobbySince = performance.now();
    this.officialLobbySig = '';
    this.pendingLobbyExit = '';
    this.roomLostSince.official = 0;
    game.ui.officialLobby = {
      findMatch: () => this.official.findMatch(),
      leave: () => {
        this.official.leaveParty();
        // The shell takes the screen back (rank → rank, lobby → lobby).
        game.ui.exitToMenu();
      },
      kick: (hex: string) => {
        const target = ClientCache.shared.playerByHex(hex)?.identity;
        if (target) this.official.kickFromParty(target);
      },
    };
    this.hideShell(true); // the game owns the screen now — exactly like a P2P lobby
    game.ui.show('lobby');
    this.updateOfficialLobby();
  }

  /**
   * Liveness of a subscription-backed room against its row cache. A reconnect wipes and
   * replays the cache — a mobile app switch (the share sheet, another app) kills the socket,
   * and the room must ride the replay out instead of exiting (user report 2026-10-03).
   * Returns 'gathering' (rows on their way, right after CREATE/join), 'waiting' (keep the
   * last painted roster) or 'lost' (the rows are really gone — the caller exits the room).
   */
  private roomRowState(key: 'official' | 'custom', since: number): 'gathering' | 'waiting' | 'lost' {
    if (performance.now() - since < AppShell.ROOM_GATHER_GRACE_MS) return 'gathering';
    if (SpacetimeConnection.shared.state !== 'connected') {
      // An unreachable server proves nothing about the lobby: an empty cache is expected.
      this.roomLostSince[key] = 0;
      return 'waiting';
    }
    if (!this.roomLostSince[key]) {
      this.roomLostSince[key] = performance.now();
      return 'waiting'; // first missing tick (cache replay) — hold the last painted roster
    }
    return performance.now() - this.roomLostSince[key] >= AppShell.ROOM_LOST_GRACE_MS ? 'lost' : 'waiting';
  }

  /** Push the party rows into the reused lobby screen (sig-guarded: no needless re-renders). */
  private updateOfficialLobby(): void {
    const game = this.game;
    if (!game || !this.officialLobbyActive) return;
    const hex = this.myHex();
    const cache = ClientCache.shared;
    const party = hex ? cache.myParty(hex) : null;
    if (!party) {
      const state = this.roomRowState('official', this.officialLobbySince);
      if (state === 'gathering') {
        // Rows land a beat after CREATE / a code join — show the empty gathering frame.
        const sig = 'gathering';
        if (sig !== this.officialLobbySig) {
          this.officialLobbySig = sig;
          game.ui.updateOfficialLobby({
            code: '',
            format: this.currentLobbyFormat,
            players: [],
            leader: false,
            ready: false,
            gathering: true,
          });
        }
        return;
      }
      if (state === 'waiting') return; // reconnect replay / server unreachable — keep the roster
      // A reload boots #/room as the PARTY flavour; when the lobby this identity actually
      // holds is a CUSTOM one, walk into it instead of exiting (user report 2026-10-03).
      if (hex && cache.myCustomLobby(hex)) {
        this.officialLobbyActive = false;
        this.roomFlavour = 'custom';
        this.renderCustomRoom();
        return;
      }
      this.pendingLobbyExit = 'NO LOBBY FOUND — it may have been closed.';
      game.ui.exitToMenu(); // the shell takes the screen back
      return;
    }
    this.roomLostSince.official = 0;
    // The room's MODE belongs to the LOBBY (`party.format`) — every member ADOPTS it, so a
    // joiner never renders CLASSIC for a RANK lobby and a reload keeps the tag (user report
    // 2026-10-04). The leader's own clients SET it via setPartyFormat when they create/open
    // the lobby from a page (RANK menu → RANK, CLASSIC menu → CLASSIC).
    const roomFormat = party.format === 'RANK' ? 'RANK' : 'CLASSIC';
    if (roomFormat !== this.currentLobbyFormat) this.currentLobbyFormat = roomFormat;
    const members = cache.partyMembers(party.partyId);
    const leader = party.leader.toHexString() === hex;
    const me = cache.playerByHex(hex);
    const ready = Boolean(me && me.playerName && me.colony < 3);
    const players = members.map((m) => {
      const mh = m.identity.toHexString();
      subscribePlayer(mh);
      const p = cache.playerByHex(mh);
      return {
        id: mh,
        name: p?.playerName || 'Recruit',
        ready: true,
        colony: p && p.colony < 3 ? p.colony : -1,
        nt: -1,
        isHost: party.leader.toHexString() === mh,
        me: mh === hex,
        acc: m.acc ?? '',
      };
    });
    const sig =
      `${party.partyId}|${party.joinCode}|${this.currentLobbyFormat}|${leader ? 1 : 0}|${ready ? 1 : 0}|` +
      players.map((p) => `${p.id}:${p.name}:${p.colony}:${p.acc}:${p.isHost ? 1 : 0}`).join(';');
    if (sig === this.officialLobbySig) return;
    this.officialLobbySig = sig;
    game.ui.updateOfficialLobby({
      code: party.joinCode,
      format: this.currentLobbyFormat,
      players,
      leader,
      ready,
      gathering: false,
    });
  }

  /** Leave the reused lobby screen back into the shell (the screen observer routes here). */
  private returnFromOfficialLobby(): void {
    if (!this.officialLobbyActive && !this.customLobbyActive) return;
    const wasCustom = this.customLobbyActive;
    this.officialLobbyActive = false;
    this.customLobbyActive = false;
    const message = this.pendingLobbyExit;
    this.pendingLobbyExit = '';
    this.game?.ui.updateOfficialLobby(null);
    const target: ShellScreen = wasCustom
      ? 'custom'
      : this.roomReturnScreen === 'rank'
        ? 'rank'
        : this.roomReturnScreen === 'play'
          ? 'play'
          : 'lobby';
    this.roomFlavour = 'party';
    const url = new URL(window.location.href);
    url.searchParams.delete('lobby');
    url.searchParams.delete('room');
    url.searchParams.delete('custom');
    url.hash = wasCustom ? '#/custom' : target === 'rank' ? '#/rank' : target === 'play' ? '#/play' : '#/lobby';
    window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
    this.showShell(target);
    if (message) this.toast(message);
  }

  // ------------------------------------------------------------ CUSTOM lobby (2026-09-30)

  /**
   * The CUSTOM lobby on the reused lobby screen: the same DOM, the P2P handshake (READY +
   * host START MATCH) and the custom match's seats mapped in. The screen observer and the
   * data tick keep it fresh until the match starts (the ordinary official boot path takes over).
   */
  private renderCustomRoom(): void {
    const game = this.game;
    if (!game) {
      window.setTimeout(() => {
        if (this.screen === 'room' && this.roomFlavour === 'custom' && !this.shellHidden) this.renderCustomRoom();
      }, 400);
      return;
    }
    this.customLobbyActive = true;
    this.customLobbySince = performance.now();
    this.customLobbySig = '';
    this.pendingLobbyExit = '';
    this.roomLostSince.custom = 0;
    game.ui.officialLobby = {
      findMatch: () => undefined, // custom lobbies never queue — the host starts directly
      leave: () => {
        this.official.leaveCustomLobby();
        // The shell takes the screen back (the CUSTOM setup screen).
        game.ui.exitToMenu();
      },
      kick: (hex: string) => this.official.kickCustomSeat(hex),
      ready: (ready: boolean) => {
        this.official.setCustomReady(ready);
        this.customLobbySig = ''; // repaint on the next tick even before the row lands
      },
      start: () => this.official.startCustomMatch(),
    };
    this.hideShell(true); // the game owns the screen now — exactly like a P2P lobby
    game.ui.show('lobby');
    this.updateCustomRoom();
  }

  /** Push the custom lobby's rows into the reused lobby screen (sig-guarded). */
  private updateCustomRoom(): void {
    const game = this.game;
    if (!game || !this.customLobbyActive) return;
    const state = this.official.customLobby();
    if (!state) {
      const rowState = this.roomRowState('custom', this.customLobbySince);
      if (rowState === 'gathering') {
        // Rows land a beat after CREATE / a code join — show the empty gathering frame.
        const sig = 'gathering';
        if (sig !== this.customLobbySig) {
          this.customLobbySig = sig;
          game.ui.updateOfficialLobby({
            code: '',
            format: 'CUSTOM',
            players: [],
            leader: false,
            ready: true,
            gathering: true,
            custom: true,
            myReady: false,
            canStart: false,
          });
        }
        return;
      }
      if (rowState === 'waiting') return; // reconnect replay / server unreachable — keep the roster
      this.pendingLobbyExit = 'NO LOBBY FOUND — it may have been closed.';
      game.ui.exitToMenu(); // the shell takes the screen back
      return;
    }
    this.roomLostSince.custom = 0;
    const players = state.players.map((p) => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      colony: p.colony,
      nt: p.nt,
      isHost: p.isHost,
      me: p.me,
      acc: p.acc,
    }));
    const sig =
      `${state.code}|${state.hostHex}|${state.myReady ? 1 : 0}|${state.canStart ? 1 : 0}|` +
      players.map((p) => `${p.id}:${p.name}:${p.colony}:${p.ready ? 1 : 0}:${p.isHost ? 1 : 0}`).join(';');
    if (sig === this.customLobbySig) return;
    this.customLobbySig = sig;
    game.ui.updateOfficialLobby({
      code: state.code,
      format: 'CUSTOM',
      players,
      leader: state.host,
      ready: true,
      gathering: false,
      custom: true,
      myReady: state.myReady,
      canStart: state.canStart,
    });
  }

  private renderRank(): void {
    const page = new RankPage(this);
    this.page = page;
    this.rankPage = page;
    this.screenHost.appendChild(page.element);
    // The nav bar's MAP tab lands with the intergalactic map ALREADY EXPANDED
    // (user ask 2026-10-03) — consumed once, the dashboard keeps its normal state.
    if (this.rankExpandOnShow) {
      this.rankExpandOnShow = false;
      page.openFullscreenMap();
    }
  }

  /** Settings ▸ GRAPHICS: the preset list and the frame-rate chips (applies live, persists). */
  private renderGraphics(): void {
    const page = new GraphicsPage(this);
    this.page = page;
    this.screenHost.appendChild(page.element);
    page.update();
  }

  /**
   * #/match/<id> — join (or rejoin) an official match by its shareable id. A live seat of mine
   * rejoins on its own the moment the provider sees it; this page exists for FRESH joins: pick a
   * colony and drop in mid-match (the server validates the caps).
   */
  private renderMatchJoin(id: number): void {
    const wrap = el('div', 'nf-page match-join-page');
    wrap.appendChild(el('div', 'menu-title nf-matchjoin-title', id > 0 ? `MATCH #${id}` : 'MATCH'));
    const body = el('div', 'nf-matchjoin-body');
    wrap.appendChild(body);
    this.screenHost.appendChild(wrap);
    if (id > 0) this.official.watchMatch(id);

    let picked = -1;
    let joining = false;
    const draw = (): void => {
      if (joining) return;
      clear(body);
      const m = id > 0 ? ClientCache.shared.match(id) : null;
      if (id <= 0) {
        body.appendChild(el('p', 'menu-sub', 'No match id in the link.'));
      } else if (!m) {
        body.appendChild(el('p', 'menu-sub', 'Looking up the match…'));
      } else if (m.status !== 1 || m.endedAt) {
        body.appendChild(el('p', 'menu-sub', 'THAT MATCH HAS ALREADY ENDED'));
      } else {
        const players = ClientCache.shared.matchPlayers(id);
        body.appendChild(el('p', 'menu-sub', `${players.length} survivor${players.length === 1 ? '' : 's'} in the arena — drop in and take the planet`));
        const row = el('div', 'nf-matchjoin-colonies');
        COLONIES.forEach((col, idx) => {
          const b = el('button', `btn nf-colony-btn${picked === idx ? ' on' : ''}`, col.name) as HTMLButtonElement;
          b.type = 'button';
          b.style.setProperty('--nf-colony', col.css);
          b.addEventListener('click', () => {
            picked = idx;
            draw();
          });
          row.appendChild(b);
        });
        body.appendChild(row);
        const join = el('button', 'btn primary nf-wide-btn', picked < 0 ? 'PICK A COLONY' : 'JOIN MATCH') as HTMLButtonElement;
        join.type = 'button';
        join.disabled = picked < 0;
        join.addEventListener('click', () => {
          joining = true;
          join.disabled = true;
          join.textContent = 'JOINING…';
          this.official.joinMatchById(id, picked, 0);
        });
        body.appendChild(join);
        body.appendChild(el('p', 'nf-login-note', 'The arena is live — you will drop in exactly where it stands.'));
      }
      const back = el('button', 'btn ghost nf-wide-btn', 'BACK TO MAIN MENU') as HTMLButtonElement;
      back.type = 'button';
      back.addEventListener('click', () => this.goHome());
      body.appendChild(back);
    };
    draw();
    const openedAt = performance.now();
    let endedNoticeAt = 0;
    const timer = window.setInterval(() => {
      if (!wrap.isConnected) {
        window.clearInterval(timer);
        return;
      }
      const m = id > 0 ? ClientCache.shared.match(id) : null;
      // A link to a match that does not exist must never strand the player on "Looking up the
      // match…": after a short lookup window, walk back to the main menu (user ask 2026-09-28).
      // (A LIVE seat of mine short-circuits this: `detectMatchStart` boots the match instead and
      // this page is torn down.)
      if (id > 0 && !m && performance.now() - openedAt > 6_000) {
        window.clearInterval(timer);
        this.toast(`Match #${id} was not found — returning to the main menu.`);
        this.goHome();
        return;
      }
      // An already-finished match keeps its "ALREADY ENDED" notice for a beat, then leaves too.
      if (m && (m.status !== 1 || m.endedAt)) {
        if (!endedNoticeAt) endedNoticeAt = performance.now();
        else if (performance.now() - endedNoticeAt > 4_000) {
          window.clearInterval(timer);
          this.toast('That match has already ended — returning to the main menu.');
          this.goHome();
          return;
        }
      } else {
        endedNoticeAt = 0;
      }
      draw();
    }, 700);
  }

  private renderQueue(): void {
    const page = new MatchmakingPage(this);
    this.page = { onHide: () => page.dispose(), update: () => undefined };
    this.screenHost.appendChild(page.element);
  }

  private renderProfile(hex: string): void {
    const page = new ProfilePage(this, hex);
    this.page = page;
    this.screenHost.appendChild(page.element);
  }

  private renderLoading(): void {
    const wrap = el('div', 'nf-page loading-page');
    wrap.appendChild(el('div', 'nf-login-logo', 'NECROFALL'));
    const colonies = el('div', 'nf-loading-colonies');
    colonies.appendChild(el('span', 'nf-loading-colony', 'HELIOS'));
    colonies.appendChild(el('span', 'nf-loading-vs', 'VS'));
    colonies.appendChild(el('span', 'nf-loading-colony', 'AEGIS'));
    colonies.appendChild(el('span', 'nf-loading-vs', 'VS'));
    colonies.appendChild(el('span', 'nf-loading-colony', 'VANTA'));
    wrap.appendChild(colonies);
    wrap.appendChild(el('div', 'nf-loading-title', 'Loading Planet…'));
    const players = el('div', 'nf-loading-players');
    wrap.appendChild(players);
    wrap.appendChild(el('p', 'nf-muted', 'Connecting to the official server…'));
    this.screenHost.appendChild(wrap);

    // Live seat names once the match subscription lands.
    const paint = (): void => {
      if (!this.screenHost.contains(players)) return;
      const matchId = this.official.getMatchPayload()?.matchId ?? 0;
      clear(players);
      const rows = matchId ? ClientCache.shared.matchPlayers(matchId) : [];
      for (const row of rows) {
        const chip = el('span', 'nf-loading-player', row.name || 'Survivor');
        const hex = hexOf(row.identity);
        chip.style.setProperty('--nf-colony', COLONIES[row.colony]?.css ?? '#8fd7ff');
        if (hex === this.myHex()) chip.classList.add('me');
        players.appendChild(chip);
      }
      window.setTimeout(paint, 400);
    };
    window.setTimeout(paint, 50);
  }

  // ------------------------------------------------------------ game control

  /** The bottom bar's destinations (user ask 2026-10-03): EVENTS · CUSTOMIZE · MAP · PLAY. */
  /** The bottom bar's destinations (user ask 2026-10-03): EVENTS · CUSTOMIZE · MAP ·
   *  MODES · the LAST-PLAYED mode's own menu. */
  private onNav(key: BottomNavKey): void {
    if (key === 'mode') this.launchLastMode();
    else if (key === 'modes') this.goPlay();
    else if (key === 'map') this.goRankExpanded();
    else if (key === 'events') this.goEvents();
    else this.openCustomize();
  }

  /** Remember the launched mode (ShellContext): persist + repaint the hero button. */
  setLastMode(id: GameModeDefinition['id']): void {
    this.lastModeId = id;
    try {
      localStorage.setItem('nf.mm.lastmode', id);
    } catch {
      /* private mode */
    }
    this.refreshNavMode();
  }

  /** The hero button's answer: open the LAST-PLAYED mode's own menu. */
  private launchLastMode(): void {
    switch (this.lastModeId) {
      case 'rank':
        this.goRank();
        break;
      case 'speedrun':
        this.goSolo('speedrun');
        break;
      case 'survival':
        this.goSolo('survival');
        break;
      case 'custom':
        this.goCustom();
        break;
      case 'freeroam':
        this.startFreeroam();
        break;
      default:
        this.goLobby();
        break;
    }
  }

  /** Push the last-played mode into the bottom bar — RANK carries the golden star row. */
  private refreshNavMode(): void {
    // the fallback stays CLASSIC, never registry[0] — RANK leads the grid now (user ask 2026-10-03)
    const mode =
      GAME_MODES.find((m) => m.id === this.lastModeId) ??
      GAME_MODES.find((m) => m.id === 'classic') ??
      GAME_MODES[0];
    const hex = this.myHex();
    const me = hex ? ClientCache.shared.me(hex) : null;
    const stars = mode.id === 'rank' ? rankStarRow(Number(me?.rankPoints ?? 0)).html : null;
    this.nav.setMode(mode, stars);
  }

  /**
   * P2P / offline: boot or reuse the legacy game. The existing lobby rules,
   * host migration and room codes are all untouched (plan §34).
   */
  launchLegacy(options: LegacyLaunchOptions): void {
    MultiplayerSession.begin('p2p', this.p2p);
    const wasBooted = Boolean(this.game);
    const game = this.ensureGame();
    this.hideShell(true);

    if (options.roomCode) {
      const room = options.roomCode.toUpperCase();
      // Keep the room in the URL so a refresh walks back in (legacy behaviour).
      const url = new URL(window.location.href);
      url.searchParams.set('lobby', room);
      url.hash = '';
      window.history.replaceState({}, document.title, url.toString());
      if (wasBooted) {
        // The instance is already up (shell backdrop): use the existing lobby flow.
        game.ui.show('play');
        game.joinP2PLobby(room, options.name);
      }
      // A freshly booted instance reads `?lobby` itself (autoJoinRoom).
      return;
    }
    if (options.host) {
      game.ui.show('play');
      game.hostP2PLobby(options.name);
      return;
    }
    game.ui.show('play');
  }

  /** Boot (once) the 3D world the shell sits on and that plays both match modes. */
  private ensureGame(): Game {
    if (this.game) return this.game;
    const game = new Game(this.app);
    game.start();
    this.game = game;
    // The shell listens to every screen switch: the instant a shell-launched game
    // screen hands over to the game menu, the shell takes the screen back — no
    // flash of the old P2P menu in between.
    game.ui.onScreenChange = (name) => this.handleGameScreenChange(name);
    // ...and the reverse edge: when the game ASKS for "the menu" (match over, lobby
    // left, customizer backed out), the SHELL is the menu now (user ask 2026-10-03).
    game.ui.onExitToMenu = (hint) => this.onGameExitToMenu(hint);
    (window as unknown as { necrofall: Game }).necrofall = game;
    this.startGamePoll();
    return game;
  }

  /**
   * The account shell's planet backdrop: boot the world once and hide its UI
   * layer while the shell owns the screen (the planet keeps rendering).
   */
  private ensureBackdrop(): void {
    if (!APP_CONFIG.configured) return;
    const game = this.ensureGame();
    if (!this.shellHidden) game.ui.setShellMode(true);
  }

  private bootOfficialGame(payload: OfficialMatchPayload): void {
    this.officialMatchActive = true;
    this.cachedPayload = payload;
    MultiplayerSession.begin('official', this.official);
    MultiplayerSession.setOfficialMatch(payload.matchId);
    const game = this.ensureGame();
    this.hideShell(true); // reveal the game UI for the match
    try {
      game.startOfficialMatch(this.official, payload);
    } catch (err) {
      // Rare: the instance is mid-P2P-session. The match lives server-side —
      // a reload walks straight back into it.
      console.warn('[NECROFALL] live instance busy — reloading into the official match', err);
      window.location.reload();
    }
  }

  private startGamePoll(): void {
    if (this.gamePoll) return;
    this.gamePoll = window.setInterval(() => this.gameTick(), 700);
  }

  private gameTick(): void {
    const game = this.game;
    if (!game) return;

    // The reused official lobby screen (no data tick arrives while nothing changes — the
    // GATHERING grace still has to expire).
    if (this.officialLobbyActive) this.updateOfficialLobby();
    if (this.customLobbyActive) this.updateCustomRoom();

    if (this.soloRunActive) {
      // A SOLO run owns the screen until it is left (Game.returnToMenu) — then back to the picker
      // for another attempt (user ask 2026-09-30). FREEROAM never had a picker: its home is the
      // PLAY format menu it was started from (user ask).
      if (game.phase === 'menu') {
        this.soloRunActive = false;
        if (this.lastSoloMode === 'freeroam') this.showShell('play');
        else this.showShell('solo', this.lastSoloMode);
      }
      this.pill.classList.add('hidden');
      return;
    }

    if (this.officialMatchActive) {
      // Interim combat reporting until the server sim owns damage (plan §74).
      if (game.phase === 'playing' && game.localPlayer) {
        const now = performance.now();
        if (now - this.lastStatsReport > 25_000) {
          this.lastStatsReport = now;
          const p = game.localPlayer;
          reportMatchStats(p.kills, p.deaths, 0, Math.round(p.damageDealt));
        }
      }
      if (game.phase === 'menu') {
        // The official results screen was dismissed — back to the shell.
        this.officialMatchActive = false;
        this.official.resetMatch();
        MultiplayerSession.end();
        // The match is over: its id leaves the URL (a stale #/match would try to rejoin a corpse).
        window.history.replaceState({}, document.title, '#/home');
        this.showShell('home');
      }
      this.pill.classList.add('hidden');
      return;
    }

    // Legacy/P2P: offer the way back to the account shell — a P2P match ends on the
    // results screen, and the legacy menu no longer exists (user ask 2026-10-03).
    const onReturnableScreen = game.ui.currentScreen === 'results';
    const canReturn =
      APP_CONFIG.configured && this.accountReady && (game.phase === 'menu' || game.phase === 'ended') && onReturnableScreen;
    this.pill.classList.toggle('hidden', !(this.shellHidden && canReturn));
  }

  private beginLoading(): void {
    // An official match that is already live owns the screen: a stray match-start must never
    // re-enter the loading path (it used to be able to re-boot a playing instance and reload-loop).
    if (this.officialMatchActive) return;
    // A queued lobby dissolves into the match — the lobby screen is done.
    if (this.officialLobbyActive) {
      this.officialLobbyActive = false;
      this.game?.ui.updateOfficialLobby(null);
    }
    // A CUSTOM lobby's START dissolves it the same way (the match boot path takes over).
    if (this.customLobbyActive) {
      this.customLobbyActive = false;
      this.game?.ui.updateOfficialLobby(null);
    }
    this.roomFlavour = 'party';
    this.loadingSince = performance.now();
    this.showShell('loading');

    const tryBoot = (): void => {
      const payload = this.official.getMatchPayload();
      const matchId = payload?.matchId ?? 0;
      const expected = matchId ? ClientCache.shared.match(matchId)?.playerCount ?? 0 : 0;
      const present = matchId ? ClientCache.shared.matchPlayers(matchId).length : 0;
      const waited = performance.now() - this.loadingSince;
      const rosterReady = Boolean(payload && payload.players.length > 0 && present >= Math.max(1, expected));
      const timedOut = waited > 4000;
      if (rosterReady || (timedOut && payload)) {
        if (payload) {
          // OFFICIAL MATCHES CARRY THEIR ID IN THE URL — shareable, and a reload rejoins it.
          window.history.replaceState({}, document.title, `#/match/${payload.matchId}`);
          this.bootOfficialGame(payload);
        }
        return;
      }
      if (timedOut) {
        // No usable payload: never strand the loading screen. Drop the match state (a re-entry
        // loop would keep the player pinned here) and hand the screen back to the shell.
        this.toast('Match found, but no server state arrived — returning to the menu.');
        this.official.resetMatch();
        // The queued row may still exist server-side; cancelling is idempotent.
        this.official.cancelFindMatch();
        this.showShell('home');
        return;
      }
      window.setTimeout(tryBoot, 250);
    };
    window.setTimeout(tryBoot, 300);
  }

  // ------------------------------------------------------------ chrome helpers

  private hideShell(andReset: boolean): void {
    this.shellHidden = true;
    this.root.classList.add('hidden');
    this.setBootSpinner(false); // the game owns the screen now — no spinner over it
    // Hand the screen back to the game: HUD, lobby screens or its own menu.
    this.game?.ui.hideShellAvatar();
    this.avatarStageHost = null;
    this.avatarStageArgs = null;
    this.game?.ui.setShellMode(false);
    // The friends bar FOLLOWS the player out of the shell (user ask: "show the collapsed
    // friends bar in classic, rank, p2p, lobby") — floating above the game UI (there is no
    // page layout to share there; the bar is the only shell element on screen).
    if (this.accountReady && this.rail.element.parentElement !== document.body) {
      document.body.appendChild(this.rail.element);
      this.rail.element.classList.add('floating');
    }
    this.refreshRail();
    if (andReset) {
      this.page?.onHide?.();
      this.page = null;
      this.screen = 'hidden';
      clear(this.screenHost);
    }
  }

  /**
   * The collapsed friends bar is visible on every menu — shell screens AND the in-game P2P /
   * official lobby — and steps aside only where it would obstruct: the auth screens, the
   * matchmaking modal, the full-bleed profile/graphics pages and a live match.
   */
  private refreshRail(): void {
    const g = this.game;
    // The floating bar must sit EXACTLY where the main menu's bar sits: measure the
    // chrome's live height here (it collapses to 0 on bare/game screens — keep the last
    // good value) and hand it to the CSS as `--nf-rail-top` (user ask 2026-09-29 PM).
    const chromeH = this.chrome.getBoundingClientRect().height;
    if (chromeH > 8) this.railTopPx = Math.round(chromeH) + 6;
    this.rail.element.style.setProperty('--nf-rail-top', `${this.railTopPx}px`);
    const inSession = !!g && (g.phase === 'playing' || g.phase === 'colony' || g.phase === 'necrotech' || g.phase === 'starting');
    const excluded =
      this.screen === 'login' ||
      this.screen === 'onboarding' ||
      this.screen === 'boot' ||
      this.screen === 'loading' ||
      this.screen === 'queue' ||
      this.screen === 'profile' ||
      this.screen === 'graphics';
    // While the GAME owns the screen (shell hidden), the bar only shows on the menu-ish
    // screens — the P2P / official lobby and the classic play setup (user ask).
    const gameScreen = g?.ui.currentScreen ?? 'play';
    const menuishGame = gameScreen === 'play' || gameScreen === 'lobby';
    const show =
      this.accountReady &&
      !excluded &&
      !inSession &&
      (!this.shellHidden || menuishGame) &&
      !(this.officialMatchActive && (gameScreen === 'game' || gameScreen === 'results'));
    this.rail.element.classList.toggle('hidden', !show);
    if (!show) this.rail.collapse();
  }

  /**
   * The game asks for "the menu" (match over, lobby left, customizer backed out).
   * THE MENU IS THE SHELL now — the legacy menu screen no longer exists (user ask
   * 2026-10-03). Returns false in builds without an account screen, so the game
   * falls back to its own PLAY board (offline play).
   */
  private onGameExitToMenu(hint: 'home' | 'lobby'): boolean {
    if (!APP_CONFIG.configured || !this.accountReady) return false;
    // A live SOLO run routes itself home from `gameTick` — never pre-empt it.
    if (this.soloRunActive) return true;
    if (this.officialLobbyActive || this.customLobbyActive) {
      this.returnFromOfficialLobby();
      return true;
    }
    if (hint === 'lobby') {
      // Drop the room link (a refresh must not rejoin a lobby that was left) and
      // put the route back on the CLASSIC setup.
      const url = new URL(window.location.href);
      url.searchParams.delete('lobby');
      url.hash = '#/lobby';
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
      this.showShell('lobby');
      return true;
    }
    this.showShell('home');
    return true;
  }

  /** The RETURN TO LOBBY chip's answer: step back into whichever lobby is still open. */
  private openCurrentLobby(): void {
    const hex = this.myHex();
    if (hex && ClientCache.shared.myParty(hex)) this.goLobbyRoom();
    else if (hex && ClientCache.shared.myCustomLobby(hex)) this.goCustomRoom();
  }

  /**
   * The fixed RETURN TO LOBBY chip (user ask 2026-10-03): a lobby keeps its doors
   * open while the player browses — the chip rides every shell page and disappears
   * the moment a match boots, the lobby closes, or the shell itself steps aside.
   */
  private refreshLobbyReturn(): void {
    const hex = this.myHex();
    const inLobby = Boolean(hex && (ClientCache.shared.myParty(hex) || ClientCache.shared.myCustomLobby(hex)));
    const busy = this.shellHidden || this.officialMatchActive || this.soloRunActive;
    const excluded =
      this.screen === 'room' ||
      this.screen === 'boot' ||
      this.screen === 'login' ||
      this.screen === 'onboarding' ||
      this.screen === 'loading' ||
      this.screen === 'match';
    this.lobbyReturn.classList.toggle('hidden', !(inLobby && !busy && !excluded));
  }

  /** The MORE sheet's entries (§30/§31; user ask 2026-10-03: PROFILE and CUSTOMIZE
   *  left the list — the avatar chip opens the profile and the nav's CUSTOMIZE tab
   *  opens the customizer, one entry point each). */
  private moreEntries(): MoreSheetEntry[] {
    const entries: MoreSheetEntry[] = [];
    entries.push({ label: 'GRAPHICS', icon: 'star', action: 'graphics', onClick: () => this.goGraphics() });
    entries.push({ label: 'CONTROLS', icon: 'locate', action: 'controls', onClick: () => this.openControls() });
    entries.push({ label: 'HOW TO PLAY', icon: 'help', action: 'howto', onClick: () => this.openGameScreen('howto') });
    const fs = fullscreenMode() !== 'none';
    entries.push({
      label: fs ? 'EXIT FULLSCREEN' : 'FULLSCREEN',
      icon: fs ? 'collapse' : 'expand',
      action: 'fullscreen',
      onClick: () => void toggleFullscreen(),
    });
    if (this.game && this.shellHidden) {
      entries.push({
        label: 'RESUME GAME',
        icon: 'play',
        tone: 'primary',
        onClick: () => {
          if (this.game && (this.game.phase === 'menu' || this.game.phase === 'ended')) this.showShell('home');
        },
      });
    }
    entries.push({ label: 'SIGN OUT', icon: 'door', action: 'signout', tone: 'danger', onClick: () => void this.signOut() });
    return entries;
  }

  private async signOut(): Promise<void> {
    const hadOidcSession = Boolean(this.auth.session());
    SpacetimeConnection.shared.disconnect();
    ClientCache.shared.detach();
    clearStoredDbToken();
    try {
      await this.auth.logout();
    } catch {
      /* ignore */
    }
    // Guests have no provider page to land on: return to the login screen.
    // (With a real OIDC session, logout() navigates there itself.)
    if (!hadOidcSession) window.location.reload();
  }

  /** The current visual state, for tests/debugging. */
  get screenName(): ShellScreen {
    return this.screen;
  }
}
