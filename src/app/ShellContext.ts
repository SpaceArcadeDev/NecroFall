// NECROFALL — shared context passed to every shell screen (plan §87 file map).
// Keeps pages decoupled from the concrete AppShell implementation.
import { FpsPref, QualityPref } from '../core/Config';
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
  /** An OPEN seat: the rail draws just its lit platform and the card says OPEN SLOT. */
  empty?: boolean;
}

/** The FORMAT a party belongs to — the tag its screen wears + how many seats it holds. */
export type PartyMode = 'CLASSIC' | 'RANK' | 'P2P';

/** Seat caps per party format (OFFICIAL parties hold 3; P2P rooms hold 9). */
export function partySeatCount(mode: PartyMode): number {
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
  /** The OFFICIAL PARTY screen — CREATE PARTY's home, in the in-game lobby's dress. */
  goParty(): void;
  /** The party screen's BACK: return to the screen that OPENED the party. */
  goBackFromParty(): void;
  /** Tag the party screen with its FORMAT (RANK when opened from the rank menu, else CLASSIC). */
  setPartyMode(mode: PartyMode): void;
  partyMode(): PartyMode;
  /** Where the player belongs after the queue ends: their party, or the CLASSIC setup. */
  returnFromQueue(): void;
  /** Boot the existing WebRTC game (P2P lobbies and offline play live there). */
  launchLegacy(options: LegacyLaunchOptions): void;
  /** Stage (or park, with host=null) the OFFICIAL party line-up on the shell. */
  stagePartyAvatars(host: HTMLElement | null, members: PartyAvatarInfo[]): void;
  toast(message: string): void;
}
