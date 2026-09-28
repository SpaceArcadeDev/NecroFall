// NECROFALL — DISCOVERY MODEL (plan §1/§2/§41). The client-side twin of
// `spacetimedb/src/ranked/location.ts` — KEEP THE KEY FORMATS IN SYNC.
//
// Every galaxy, system and planet carries its own discovery history: the first
// 9 UNIQUE players, in chronological order. Slot 1 is the first footfall, slot
// 9 is the last one that counts — never "the last 9", always the FIRST 9.
//
//   galaxy:  G:12:38
//   system:  G:12:38:S:127
//   planet:  G:12:38:S:127:P:4
//
// The map and the panels only ever RENDER what the server sent; discovery
// itself is requested from the server (plan §6 — never invented locally).
import { COLONY_NONE, LOCATION_GALAXY, LOCATION_PLANET, LOCATION_SYSTEM, MAX_LOCATION_DISCOVERERS } from '../app/spacetimedb/rows';
import type { RankedLocationDiscoveryRow } from '../app/spacetimedb/rows';

export { LOCATION_GALAXY, LOCATION_PLANET, LOCATION_SYSTEM, MAX_LOCATION_DISCOVERERS };

export type LocationType = typeof LOCATION_GALAXY | typeof LOCATION_SYSTEM | typeof LOCATION_PLANET;

/** One entry of a location's DISCOVERED BY list (max 9, chronological). */
export interface DiscoveryEntry {
  /** The player's identity hex (never shown — the display name is). */
  playerId: string;
  playerName: string;
  /** Colony AT DISCOVERY TIME (COLONY_NONE renders as UNALIGNED). */
  colony: number;
  /** Server micros since epoch. */
  discoveredAt: number;
  /** 1-based slot: 1 = first footfall. */
  index: number;
}

export function galaxyLocationKey(gx: number, gy: number): string {
  return `G:${gx}:${gy}`;
}

export function systemLocationKey(gx: number, gy: number, systemId: number): string {
  return `G:${gx}:${gy}:S:${systemId}`;
}

export function planetLocationKey(gx: number, gy: number, systemId: number, planetId: number): string {
  return `G:${gx}:${gy}:S:${systemId}:P:${planetId}`;
}

/** Map one server row to the compact display entry. */
export function toDiscoveryEntry(row: RankedLocationDiscoveryRow): DiscoveryEntry {
  return {
    playerId: row.playerIdentity.toHexString(),
    playerName: row.playerName || 'SURVIVOR',
    colony: row.colony ?? COLONY_NONE,
    discoveredAt: Number(row.discoveredAt),
    index: row.discoveryIndex,
  };
}

/** "4h ago" / "2d ago" — relative only, never a wall-clock timestamp (plan §42). */
export function relativeTime(fromUs: number, nowUs: number): string {
  const s = Math.max(0, Math.floor((nowUs - fromUs) / 1e6));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}
