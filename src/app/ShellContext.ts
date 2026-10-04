// NECROFALL — shared context passed to every shell screen (plan §87 file map).
// Keeps pages decoupled from the concrete AppShell implementation.
import { FpsPref, QualityPref } from '../core/Config';
import { AppConfig } from './config';
import { OfficialMultiplayerProvider } from './multiplayer/OfficialMultiplayerProvider';
import { P2PMultiplayerProvider } from './multiplayer/P2PMultiplayerProvider';
import type { PlanetDescriptor } from '../rankmap/procedural/GalaxyTypes';
import type { GameModeDefinition } from '../ui/data/GameModeRegistry';

export interface LegacyLaunchOptions {
  roomCode?: string;
  host?: boolean;
  /** LIBERATOR NAME from the PLAY screen (falls back to the game's stored name). */
  name?: string;
}

/** One figure on the OFFICIAL LOBBY line-up (the P2P lobby's avatar rail, in the shell). */
export interface LobbySeatInfo {
  id: string;
  colony: number;
  acc: string;
  me: boolean;
  ready: boolean;
  /** An OPEN seat: the rail draws just its lit platform and the card says OPEN SLOT. */
  empty?: boolean;
}

/** The FORMAT an official lobby belongs to — the tag its screen wears + how many seats it holds. */
export type LobbyFormat = 'CLASSIC' | 'RANK' | 'P2P';

/** Seat caps per format (OFFICIAL lobbies hold 3; P2P rooms hold 9). */
export function lobbySeatCount(mode: LobbyFormat): number {
  return mode === 'P2P' ? 9 : 3;
}

export interface ShellContext {
  readonly config: AppConfig;
  /** The player's SpacetimeDB identity hex ('' while offline). */
  myHex(): string;
  readonly official: OfficialMultiplayerProvider;
  readonly p2p: P2PMultiplayerProvider;
  openProfile(hex: string): void;
  goHome(): void;
  goPlay(): void;
  /** The contextual back — pages that render the shared PageHeader call this (§2). */
  goBack(): void;
  /** The RANK page — the intergalactic map (plan §48). */
  goRank(): void;
  /** The GRAPHICS settings page (preset + frame-rate cap). */
  goGraphics(): void;
  /** The saved graphics choice (the live game's, or the stored one before it boots). */
  currentGraphicsPref(): QualityPref;
  /** Apply + persist a graphics choice on the running world (settings ▸ GRAPHICS). */
  setGraphicsPref(pref: QualityPref): void;
  /** The saved frame-rate ceiling. */
  currentFpsPref(): FpsPref;
  /** Apply + persist a frame-rate ceiling on the running world. */
  setFpsPref(pref: FpsPref): void;
  /** Jump back into the queue screen (the ranked panel's "VIEW SEARCH"). */
  goQueue(): void;
  /** The LOBBY screen (CLASSIC's home): official party or the P2P entry. */
  goLobby(): void;
  /** The OFFICIAL LOBBY screen — the P2P lobby's own dress, CREATEd from the lobby/rank menus. */
  goLobbyRoom(): void;
  /** The lobby screen's BACK: return to the screen that OPENED it. */
  goBackFromLobbyRoom(): void;
  /** Tag the official lobby with its FORMAT (RANK when opened from the rank menu, else CLASSIC). */
  setLobbyFormat(mode: LobbyFormat): void;
  lobbyFormat(): LobbyFormat;
  /** JOIN a lobby by its code: the room opens once the server's rows land, never before. */
  joinLobbyByCode(code: string): void;
  /** Where the player belongs after the queue ends: their party, or the CLASSIC setup. */
  returnFromQueue(): void;
  /** Boot the existing WebRTC game (P2P lobbies and offline play live there). */
  launchLegacy(options: LegacyLaunchOptions): void;
  /** The SOLO picker (speedrun / survival) — the rank map as a run picker (user ask 2026-09-30). */
  goSolo(mode: 'speedrun' | 'survival'): void;
  /** The CUSTOM lobby setup screen (create / join by code). */
  goCustom(): void;
  /** Open the reused LOBBY screen for MY custom lobby (when its rows land). */
  goCustomRoom(): void;
  /** Start a solo run on one planet: records load here, the game takes the screen. */
  startSoloRun(mode: 'speedrun' | 'survival', planet: PlanetDescriptor): void;
  /** FREEROAM (user ask): a single-player sandbox on a PROCEDURAL planet — no enemies, no clock,
   *  no class picker (defaults to RIFT), spawned on the ground. The world takes the screen. */
  startFreeroam(): void;
  /** Create (host) a custom lobby; its room opens when the server rows land. */
  createCustomLobby(): void;
  /** Join a custom lobby by code; its room opens when the server rows land. */
  joinCustomLobbyByCode(code: string): void;
  /** Stage (or park, with host=null) the OFFICIAL lobby line-up on the shell. */
  stageLobbyAvatars(host: HTMLElement | null, members: LobbySeatInfo[]): void;
  /** The find-survivors sheet (friends ▸ ADD FRIEND): search by name or player id. */
  openPlayerSearch(): void;
  /**
   * Friends rail ▸ INVITE (user ask): when no lobby is open, first create one for the
   * LAST-PLAYED mode, then invite the friend. A mode that cannot open a lobby raises a
   * top notification instead ("Please select correct game Mode").
   */
  inviteFriend(hex: string): void;
  /** Push a plain notification onto the top stack (friends rail) — lobby/mode warnings. */
  notifyTop(title: string, body?: string): void;
  /** Remember the mode the player LAUNCHED (user ask 2026-10-03): the bottom bar's hero
   *  button becomes that mode — its own icon, its menu, and RANK's golden star row. */
  setLastMode(id: GameModeDefinition['id']): void;
  toast(message: string): void;
}
