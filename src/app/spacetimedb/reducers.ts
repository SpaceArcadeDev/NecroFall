// NECROFALL — typed reducer calls (plan §41/§57).
//
// The client ASKS; the module validates. Every wrapper here is a single
// reducer invocation (plan §39) and failures only log — the authoritative
// reply arrives through the subscribed rows.
import { SpacetimeConnection } from './connection';
import { Identity, PlayerSearchHitRow } from './rows';

export function callReducer(name: string, args?: unknown): void {
  const conn = SpacetimeConnection.shared.current;
  const fn = conn?.reducers?.[name];
  if (!fn) {
    console.warn(`[NECROFALL] reducer "${name}" unavailable (not connected or bindings missing)`);
    return;
  }
  try {
    void fn(args).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[NECROFALL] reducer "${name}" failed: ${message}`);
      // The shell listens for this and turns validation failures into a toast —
      // module reducers throw SenderError so `message` is user-readable.
      try {
        window.dispatchEvent(new CustomEvent('nf:reducer-error', { detail: { name, message } }));
      } catch {
        /* non-browser context */
      }
    });
  } catch (err) {
    console.warn(`[NECROFALL] reducer "${name}" threw`, err);
  }
}

// ------------------------------------------------------------ account
export const chooseColony = (colony: number): void => callReducer('chooseColony', { colony });
export const setPlayerName = (name: string): void => callReducer('setPlayerName', { name });
export const setProfileName = (name: string): void => callReducer('setProfileName', { name });
export const setProfilePicture = (picture: number): void => callReducer('setProfilePicture', { picture });
export const setAvatar = (avatar: number): void => callReducer('setAvatar', { avatar });
export const equipItem = (slot: number, itemId: number): void => callReducer('equipItem', { slot, itemId });
/** Save the control remap blob (JSON action → key code) to the account. */
export const setKeybinds = (binds: string): void => callReducer('setKeybinds', { binds });

// ------------------------------------------------------------ social
export const followPlayer = (target: Identity): void => callReducer('followPlayer', { target });
export const unfollowPlayer = (target: Identity): void => callReducer('unfollowPlayer', { target });
export const recordProfileView = (profile: Identity): void => callReducer('recordProfileView', { profile });

// ------------------------------------------------------------ parties
export const createParty = (acc: string): void => callReducer('createParty', { acc });
export const joinParty = (partyId: number, acc: string): void => callReducer('joinParty', { partyId, acc });
export const joinPartyByCode = (code: string, acc: string): void => callReducer('joinPartyByCode', { code, acc });
export const leaveParty = (): void => callReducer('leaveParty');
export const setPartyLoadout = (acc: string): void => callReducer('setPartyLoadout', { acc });
export const kickFromParty = (target: Identity): void => callReducer('kickFromParty', { target });

// ------------------------------------------------------------ matchmaking
export const findMatch = (): void => callReducer('findMatch');
export const cancelFindMatch = (): void => callReducer('cancelFindMatch');
export const confirmMatch = (): void => callReducer('confirmMatch');
export const declineMatch = (): void => callReducer('declineMatch');

// ------------------------------------------------------------ official match
export interface SubmitInputArgs {
  moveX: number;
  moveY: number;
  moveZ: number;
  aimX: number;
  aimY: number;
  aimZ: number;
  seq: bigint;
  dash: boolean;
}
export const submitInput = (args: SubmitInputArgs): void => callReducer('submitInput', args);

/** LEAVE MATCH — abandon the live seat; the row becomes a tombstone (plan §27/§71). */
export const leaveMatch = (): void => callReducer('leaveMatch');

export interface SyncPoseArgs {
  x: number;
  y: number;
  z: number;
  fx: number;
  fy: number;
  fz: number;
}
export const syncPose = (args: SyncPoseArgs): void => callReducer('syncPose', args);

export const reportMatchStats = (kills: number, deaths: number, objectives: number, damage: number): void =>
  callReducer('reportMatchStats', { kills, deaths, objectives, damage });

// ------------------------------------------------------------ procedures (on-demand reads)

/**
 * Survivor search (plan §8/§64). A PROCEDURE: nothing is subscribed, the server
 * ranks by friend code / name and returns a compact projection. Returns null when
 * the connection or the bindings are unavailable (offline shell).
 */
export async function searchPlayers(term: string): Promise<PlayerSearchHitRow[] | null> {
  const conn = SpacetimeConnection.shared.current;
  const fn = conn?.procedures?.searchPlayers;
  if (!fn) return null;
  const rows = await fn({ term });
  return Array.isArray(rows) ? (rows as PlayerSearchHitRow[]) : [];
}

// ------------------------------------------------------------ community (P2P)
export const submitPeerResult = (won: boolean, kills: number, deaths: number, durationSeconds: number): void =>
  callReducer('submitPeerResult', { won, kills, deaths, durationSeconds });
