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
import { Game } from '../core/Game';
import { APP_CONFIG, AppConfig } from './config';
import { AuthProvider } from './auth/AuthProvider';
import { NullAuthProvider, SpacetimeAuthProvider } from './auth/SpacetimeAuthProvider';
import { isAuthCallbackUrl } from './auth/authCallback';
import { ClientCache } from './spacetimedb/cache';
import { clearStoredDbToken, hasStoredDbToken, SpacetimeConnection, type ConnectionState } from './spacetimedb/connection';
import { reportMatchStats, chooseColony, setPlayerName } from './spacetimedb/reducers';
import { COLONY_NONE, hexOf } from './spacetimedb/rows';
import { subscribeAccount, subscribeMatchmaking, subscribePlayer } from './spacetimedb/subscriptions';
import { OfficialMultiplayerProvider } from './multiplayer/OfficialMultiplayerProvider';
import { ProviderGameEvent } from './multiplayer/MultiplayerProvider';
import { OfficialMatchPayload } from './multiplayer/OfficialTypes';
import { P2PMultiplayerProvider, LegacyLauncher } from './multiplayer/P2PMultiplayerProvider';
import { MultiplayerSession } from './multiplayer/MultiplayerSession';
import { COLONIES, IS_TOUCH } from '../core/Config';
import { loadSelection, selectionToWire } from '../customization/CustomizationStore';
import { Keybinds } from '../input/Keybinds';
import { ControlsModal } from './settings/ControlsModal';
import type { ScreenName } from '../ui/UI';
import { OrientationGate } from '../ui/Orientation';
import { fullscreenMode } from '../ui/Fullscreen';
import { ShellContext, LegacyLaunchOptions, PartyAvatarInfo } from './ShellContext';
import { navigate, onRouteChange, parseRoute, routeToHash } from './router';
import { CurrencyBar } from './ui/CurrencyBar';
import { FriendRail } from './ui/FriendRail';
import { MobileBottomNav, type BottomNavKey } from './ui/MobileBottomNav';
import { button, clear, el } from './ui/dom';
import { PlayerSearch } from './friends/PlayerSearch';
import { PlayPage } from './lobby/PlayPage';
import { LobbyPage } from './lobby/LobbyPage';
import { PartyPage } from './lobby/PartyPage';
import { MatchmakingPage } from './matchmaking/MatchmakingPage';
import { ProfilePage } from './profile/ProfilePage';

type ShellScreen = 'boot' | 'login' | 'onboarding' | 'home' | 'play' | 'lobby' | 'party' | 'match' | 'queue' | 'profile' | 'loading' | 'hidden';

interface ActivePage {
  onHide?: () => void;
  update?: () => void;
}

export class AppShell implements ShellContext {
  readonly config: AppConfig = APP_CONFIG;
  readonly official = new OfficialMultiplayerProvider();
  readonly p2p: P2PMultiplayerProvider;

  private root: HTMLElement;
  private screenHost: HTMLElement;
  private chrome: HTMLElement;
  private topBar: CurrencyBar;
  private nav: MobileBottomNav;
  private rail: FriendRail;
  private toastEl: HTMLElement;
  private pill: HTMLButtonElement;

  private auth: AuthProvider;
  private screen: ShellScreen = 'boot';
  private page: ActivePage | null = null;
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
  private pendingGameScreen: 'customize' | 'howto' | 'controls' | null = null;
  private gameScreenWatch = 0;
  /** Last in-game screen seen — leaving the P2P LOBBY must return to the shell, not the legacy menu. */
  private lastGameScreen: ScreenName = 'menu';
  /** `?party=CODE` invite link — consumed once the account is ready to join. */
  private invitedPartyCode = '';
  /**
   * The boot watchdog (user report: "blank screen with the rotating planet, no UI"): a wedged
   * token refresh or a connect that never answers must NEVER leave the shell invisible. If no
   * account screen has appeared after this long, the login card surfaces with the reason — and a
   * late success still takes the screen over through `onData()`.
   */
  private bootWatchdog = 0;
  private static readonly BOOT_WATCHDOG_MS = 12_000;

  constructor(private app: HTMLElement) {
    this.auth = APP_CONFIG.authConfigured ? new SpacetimeAuthProvider() : new NullAuthProvider();

    this.root = el('div', 'nf-shell hidden');
    this.chrome = el('div', 'nf-chrome');
    this.screenHost = el('main', 'nf-main');
    this.root.appendChild(this.chrome);
    this.root.appendChild(this.screenHost);
    this.toastEl = el('div', 'nf-toasts');
    this.root.appendChild(this.toastEl);
    (document.body ?? app).appendChild(this.root);

    this.topBar = new CurrencyBar(() => this.myHex(), () => this.openProfile(this.myHex()));
    this.nav = new MobileBottomNav((key) => this.onNav(key));
    this.rail = new FriendRail(() => this.myHex(), (hex) => this.openProfile(hex), () => this.openPlayerSearch());
    this.chrome.appendChild(this.topBar.element);
    this.chrome.appendChild(this.rail.element);
    this.chrome.appendChild(this.nav.element);

    // The chevron that returns from child screens (play, lobby, party, queue, profile).
    this.backBtn = button('', 'nf-back hidden', () => this.onBack());
    this.backBtn.setAttribute('aria-label', 'Back');
    this.backBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>';
    this.chrome.insertBefore(this.backBtn, this.chrome.firstChild);

    const launcher: LegacyLauncher = (options) => this.launchLegacy(options);
    this.p2p = new P2PMultiplayerProvider(launcher);

    // Settings dropdown (profile, controls, sign out) + the how-to entry beside it.
    this.topBar.settings.addEventListener('click', () => this.toggleSettings());
    this.topBar.howto.addEventListener('click', () => this.openGameScreen('howto'));

    // The avatar stage is sized from its box — restage it when the window reflows.
    window.addEventListener('resize', () => this.restageAvatar());

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

    // `?party=CODE` invite link — the party twin of the lobby's `?lobby=CODE`.
    this.invitedPartyCode = (new URLSearchParams(window.location.search).get('party') ?? '').trim().toUpperCase();

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

  goPlay(): void {
    this.navigateTo({ name: 'play' });
  }

  /** The LOBBY screen (CLASSIC's home): official party or the P2P entry. */
  goLobby(): void {
    this.navigateTo({ name: 'lobby' });
  }

  /** The OFFICIAL PARTY screen (CREATE PARTY's home) — its own menu page. */
  goParty(): void {
    this.navigateTo({ name: 'party' });
  }

  /** Where the player belongs after leaving the queue: their party, or the CLASSIC setup. */
  returnFromQueue(): void {
    const hex = this.myHex();
    if (hex && ClientCache.shared.myParty(hex)) this.goParty();
    else this.goLobby();
  }

  /** The chevron: PARTY returns to its setup, the setup returns to the format menu. */
  private onBack(): void {
    if (this.screen === 'party') this.goLobby();
    else if (this.screen === 'lobby') this.goPlay();
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
    if (screen === 'menu' || screen === 'game') {
      this.handleGameScreenChange(screen);
    }
  }

  /** Synchronous screen-switch observer (UI.onScreenChange) — fires with no flash. */
  private handleGameScreenChange(name: ScreenName): void {
    const previous = this.lastGameScreen;
    this.lastGameScreen = name;
    if (!this.pendingGameScreen) {
      // Leaving the in-game P2P LOBBY hands the screen back to the account shell
      // (where the player launched it) — never the legacy main menu.
      if (name === 'menu' && previous === 'lobby' && this.shellHidden && this.accountReady) {
        // Drop the room link (a refresh must not rejoin a lobby that was left)
        // and put the route back on the CLASSIC setup the player came from.
        const url = new URL(window.location.href);
        url.searchParams.delete('lobby');
        url.hash = '#/lobby';
        window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
        this.showShell('lobby');
      }
      return;
    }
    if (name !== 'menu' && name !== 'game') return;
    this.pendingGameScreen = null;
    if (this.gameScreenWatch) {
      window.clearInterval(this.gameScreenWatch);
      this.gameScreenWatch = 0;
    }
    if (name === 'menu') this.showShell('home');
  }

  /** Settings ▸ CONTROLS: the remap sheet, persisted to the account. */
  private openControls(): void {
    if (!this.controlsModal) this.controlsModal = new ControlsModal(this);
    this.controlsModal.open(this.root);
  }

  /** The find-survivors sheet: search the roster by name or friend code. */
  private openPlayerSearch(): void {
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
   * `?party=CODE` invite (the party twin of the lobby's `?lobby=CODE`): once the
   * account can join, fire the join, open the PARTY screen and strip the param
   * so a refresh never re-fires a stale invite.
   */
  private consumeInvite(): void {
    const code = this.invitedPartyCode;
    if (!code) return;
    const hex = this.myHex();
    const me = hex ? ClientCache.shared.me(hex) : null;
    if (!hex || !me || me.colony === COLONY_NONE || !me.playerName) return; // login/onboarding first
    if (this.officialMatchActive || this.screen === 'loading') return; // a live match owns the screen
    const cache = ClientCache.shared;
    if (cache.activeMatchFor(hex)) return; // a mid-match rejoin wins over the invite
    this.invitedPartyCode = '';
    const url = new URL(window.location.href);
    url.searchParams.delete('party');
    window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
    if (cache.myParty(hex)) {
      this.goParty(); // already in a party — the invite is moot, just open it
      return;
    }
    this.toast(`Joining party ${code}…`);
    this.official.joinPartyByCode(code);
    this.goParty(); // the PARTY screen gathers the roster as the rows land
  }

  toast(message: string): void {
    const node = el('div', 'nf-toast', message);
    this.toastEl.appendChild(node);
    window.setTimeout(() => node.classList.add('out'), 3200);
    window.setTimeout(() => node.remove(), 3900);
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
    const token = await this.auth.validToken();
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
    this.rail.update();
    this.page?.update?.();

    // Control remaps ride the account: apply the authoritative row whenever it arrives.
    const hexNow = this.myHex();
    if (hexNow) Keybinds.hydrate(ClientCache.shared.settingsByHex(hexNow)?.keybinds ?? null);

    // A pending `?party=CODE` invite fires as soon as the account can join one.
    if (this.invitedPartyCode) this.consumeInvite();

    const me = this.myHex() ? ClientCache.shared.me(this.myHex()) : null;
    if (!this.accountReady && me) {
      this.accountReady = true;
      this.clearBootWatchdog();
      const needsOnboarding = me.colony === COLONY_NONE || !me.playerName;
      const route = parseRoute();
      if (needsOnboarding) this.showShell('onboarding');
      else if (route.name === 'profile') this.showShell('profile', route.hex);
      else if (route.name === 'play') this.showShell('play');
      else if (route.name === 'lobby') this.showShell('lobby');
      else if (route.name === 'party') this.showShell('party');
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
      else if (route.name === 'party') this.showShell('party');
      else if (route.name === 'match') this.showShell('match', String(route.id));
      else this.showShell('home');
      this.toast(`Welcome, ${me.playerName}.`);
    }
  }

  private onRoute(): void {
    if (!this.accountReady || this.shellHidden) return;
    if (this.officialMatchActive) return;
    const route = parseRoute();
    if (route.name === 'profile') this.showShell('profile', route.hex);
    else if (route.name === 'play') this.showShell('play');
    else if (route.name === 'lobby') this.showShell('lobby');
    else if (route.name === 'party') this.showShell('party');
    else if (route.name === 'match') this.showShell('match', String(route.id));
    else if (this.screen !== 'queue' && this.screen !== 'onboarding' && this.screen !== 'loading') this.showShell('home');
  }

  private onProviderEvent(event: ProviderGameEvent): void {
    const e = event;
    if (e.type === 'queue') {
      const status = e.status;
      if (status === 'idle') {
        if (this.screen === 'queue') this.returnFromQueue();
      } else if (this.screen !== 'queue' && this.screen !== 'loading' && !this.shellHidden) {
        this.showShell('queue');
      }
    } else if (e.type === 'match-start') {
      this.beginLoading();
    } else if (e.type === 'error') {
      this.toast(e.message || 'Multiplayer error.');
    }
  }

  // ------------------------------------------------------------ screens

  private showShell(screen: ShellScreen, arg?: string, message?: string): void {
    // The shell now owns the screen (the in-game UI layer is revealed only by hideShell).
    this.shellHidden = false;
    // Re-entering the SAME screen is a no-op — except when we carry a message
    // that must actually surface (e.g. "could not reach the server" on login).
    if (this.screen === screen && screen !== 'profile' && message === undefined) {
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
    clear(this.screenHost);
    this.screen = screen;
    this.root.classList.remove('hidden');
    // The planet stays as the backdrop: hide the in-game UI layer under the shell.
    this.game?.ui.setShellMode(true);
    // The floating nav belongs to the MAIN menu only; child screens get the chevron.
    const childScreen = screen === 'play' || screen === 'lobby' || screen === 'party' || screen === 'queue' || screen === 'profile';
    this.nav.element.classList.toggle('hidden', screen !== 'home');
    this.backBtn.classList.toggle('hidden', !childScreen);
    this.root.classList.toggle('no-nav', screen !== 'home');
    // The CLASSIC flow (play, setup, party) wears the in-game menu dress: the
    // account chrome steps away (no profile button, currencies, ? or settings)
    // so the wordmark is the header, with the back chevron floating over the
    // top-left corner. The first signup/login screens drop the SAME chrome —
    // no friends rail, profile, currencies, help or settings around the card.
    const bareScreen = screen === 'play' || screen === 'lobby' || screen === 'party';
    const noChrome = bareScreen || screen === 'login' || screen === 'onboarding';
    this.topBar.element.classList.toggle('hidden', noChrome);
    this.rail.element.classList.toggle('hidden', noChrome);
    this.root.classList.toggle('bare-mode', noChrome);

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
        this.nav.setActive('play');
        this.renderPlay();
        break;
      case 'lobby':
        this.nav.setActive('play');
        this.renderLobby();
        break;
      case 'party':
        this.nav.setActive('play');
        this.renderParty();
        break;
      case 'match':
        this.nav.setActive('play');
        this.renderMatchJoin(Number(arg ?? 0));
        break;
      case 'queue':
        this.nav.setActive('play');
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
            // 'signed-in': a live provider session answered the flow in one hop — nothing to email.
            if (result === 'sent') showSent(address);
          })
          .catch((err: unknown) => showForm(err instanceof Error ? err.message : 'Could not send the magic link.'));
      });
      skip.addEventListener('click', () => {
        skip.disabled = true;
        skip.textContent = 'Signing in…';
        void auth.loginAnonymous().catch((err: unknown) =>
          showForm(err instanceof Error ? err.message : 'Could not sign in anonymously.')
        );
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
      if (this.game.ui.currentScreen === 'colony') this.game.ui.show('menu');
    }
  }

  private renderHome(): void {
    const wrap = el('div', 'nf-page home-page');

    // ---- the wordmark at the top, floating over the see-through part of the gradient
    const head = el('div', 'nf-home-head');
    head.appendChild(el('div', 'menu-title nf-home-title', 'NECROFALL'));
    head.appendChild(el('div', 'menu-sub', 'Dive • Purge • Dominate'));
    wrap.appendChild(head);

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

  /** OFFICIAL party: the lobby line-up inside the shell — same rail, real characters. */
  stagePartyAvatars(host: HTMLElement | null, members: PartyAvatarInfo[]): void {
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

  private renderParty(): void {
    // The line-up wears each member's outfit from the party rows — refresh ours
    // first so the page shows the current customization (no-op with no party).
    this.official.refreshPartyLoadout();
    const page = new PartyPage(this);
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
    const timer = window.setInterval(() => {
      if (!wrap.isConnected) {
        window.clearInterval(timer);
        return;
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

  private onNav(key: BottomNavKey): void {
    if (key === 'play') this.goPlay();
    else if (key === 'customize') this.openCustomize();
    else this.toast('Events are coming soon.');
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
    game.ui.show('menu');
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

    // Legacy/P2P: offer the way back to the account shell from its menu —
    // but only when there IS an account shell to return to, and ONLY on its
    // menu/results screens. Shell-launched screens (customizer, how-to,
    // controls) hide the pill: their own back button returns to the shell.
    const onReturnableScreen = game.ui.currentScreen === 'menu' || game.ui.currentScreen === 'results';
    const canReturn =
      APP_CONFIG.configured && this.accountReady && (game.phase === 'menu' || game.phase === 'ended') && onReturnableScreen;
    this.pill.classList.toggle('hidden', !(this.shellHidden && canReturn));
  }

  private beginLoading(): void {
    // An official match that is already live owns the screen: a stray match-start must never
    // re-enter the loading path (it used to be able to re-boot a playing instance and reload-loop).
    if (this.officialMatchActive) return;
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
    // Hand the screen back to the game: HUD, lobby screens or its own menu.
    this.game?.ui.hideShellAvatar();
    this.avatarStageHost = null;
    this.avatarStageArgs = null;
    this.game?.ui.setShellMode(false);
    if (andReset) {
      this.page?.onHide?.();
      this.page = null;
      this.screen = 'hidden';
      clear(this.screenHost);
    }
  }

  private toggleSettings(): void {
    const existing = this.root.querySelector('.nf-settings-menu');
    if (existing) {
      existing.remove();
      return;
    }
    const menu = el('div', 'nf-settings-menu');
    menu.appendChild(button('PROFILE', 'nf-btn ghost', () => {
      menu.remove();
      this.openProfile(this.myHex());
    }));
    menu.appendChild(button('CONTROLS', 'nf-btn ghost', () => {
      menu.remove();
      this.openControls();
    }));
    menu.appendChild(button('SIGN OUT', 'nf-btn ghost', () => {
      menu.remove();
      void this.signOut();
    }));
    if (this.game && this.shellHidden) {
      menu.appendChild(button('RESUME GAME', 'nf-btn ghost', () => {
        menu.remove();
        if (this.game && (this.game.phase === 'menu' || this.game.phase === 'ended')) this.showShell('home');
      }));
    }
    this.chrome.appendChild(menu);
    window.setTimeout(() => {
      const close = (ev: MouseEvent): void => {
        if (!menu.contains(ev.target as Node)) {
          menu.remove();
          document.removeEventListener('click', close);
        }
      };
      document.addEventListener('click', close);
    }, 0);
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
