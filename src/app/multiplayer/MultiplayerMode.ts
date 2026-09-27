// NECROFALL — which multiplayer the player chose (plan §9/§35).
//
// The toggle lives on the PLAY page and remembers the last choice locally; it
// never bleeds into how the modes work internally.
import { APP_CONFIG, STORAGE } from '../config';

export type MultiplayerMode = 'official' | 'p2p';

export function loadMultiplayerMode(): MultiplayerMode {
  try {
    const raw = localStorage.getItem(STORAGE.multiplayerMode);
    if (raw === 'official' || raw === 'p2p') return raw;
  } catch {
    /* ignore */
  }
  return APP_CONFIG.defaultMode;
}

export function saveMultiplayerMode(mode: MultiplayerMode): void {
  try {
    localStorage.setItem(STORAGE.multiplayerMode, mode);
  } catch {
    /* ignore */
  }
}
