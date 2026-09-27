// NECROFALL — shared context passed to every shell screen (plan §87 file map).
// Keeps pages decoupled from the concrete AppShell implementation.
import { AppConfig } from './config';
import { OfficialMultiplayerProvider } from './multiplayer/OfficialMultiplayerProvider';
import { P2PMultiplayerProvider } from './multiplayer/P2PMultiplayerProvider';

export interface LegacyLaunchOptions {
  roomCode?: string;
  host?: boolean;
  /** LIBERATOR NAME from the PLAY screen (falls back to the game's stored name). */
  name?: string;
}

/** One figure on the OFFICIAL party line-up (the P2P lobby's avatar rail, in the shell). */
export interface PartyAvatarInfo {
  id: string;
  colony: number;
  acc: string;
  me: boolean;
  ready: boolean;
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
  /** The LOBBY screen (CLASSIC's home): official party or the P2P entry. */
  goLobby(): void;
  /** The OFFICIAL PARTY screen — CREATE PARTY's home, in the in-game lobby's dress. */
  goParty(): void;
  /** Where the player belongs after the queue ends: their party, or the CLASSIC setup. */
  returnFromQueue(): void;
  /** Boot the existing WebRTC game (P2P lobbies and offline play live there). */
  launchLegacy(options: LegacyLaunchOptions): void;
  /** Stage (or park, with host=null) the OFFICIAL party line-up on the shell. */
  stagePartyAvatars(host: HTMLElement | null, members: PartyAvatarInfo[]): void;
  toast(message: string): void;
}
