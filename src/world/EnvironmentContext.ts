// NECROFALL — ENVIRONMENT SYSTEM CONTEXT (rework plan §1/§87).
//
// The bundle every environment system receives at construction: terrain provider, query layer,
// cell grid, masks, palette and quality profile. Systems never reach into `Planet` or `Game` —
// this is the whole surface they are allowed to depend on (plan §0 step 8).
import * as THREE from 'three';
import type { EnvironmentProfile } from './EnvironmentConfig';
import type { PlanetTerrainProvider } from './terrain/PlanetTerrainProvider';
import type { TerrainSurfaceQuery } from './terrain/TerrainSurfaceQuery';
import type { EnvironmentCells } from './cells/EnvironmentCells';
import type { GameplayMasks } from './GameplayMasks';
import type { BiomeDefinition } from './EnvironmentPalette';
import type { WindUniforms } from './Vegetation';
import type { DestructionLedger } from './interaction/DestructionLedger';
import type { AssetRegistry } from './AssetRegistry';

/**
 * Visual-only hooks the world offers to environment systems (destruction bursts, debris rings).
 * The game passes its pooled `Effects` behind this tiny interface, so environment code never
 * imports gameplay systems directly (plan §24: visual simulation first, no full physics).
 */
export interface EnvironmentFxHooks {
  burst(pos: THREE.Vector3, color: number, opts?: { count?: number; size?: number; speed?: number }): void;
  ring(pos: THREE.Vector3, up: THREE.Vector3, radius: number, color: number, opts?: { dur?: number; rings?: number }): void;
  dust(pos: THREE.Vector3, up: THREE.Vector3, color: number, amount: number): void;
}

export interface EnvironmentContext {
  /** The planet seed — root of every deterministic stream (plan §59). */
  seed: number;
  /** Generation revision (plan §60). */
  version: number;
  /** Planet reference radius (metres). */
  radius: number;
  /** Active quality profile (plan §46). */
  profile: EnvironmentProfile;
  /** Terrain seam (plan §0). */
  provider: PlanetTerrainProvider;
  /** Shared surface queries (plan §4). */
  query: TerrainSurfaceQuery;
  /** Streamable cell partition (plan §19). */
  cells: EnvironmentCells;
  /** Gameplay keep-out masks (plan §61). */
  masks: GameplayMasks;
  /** The planet's dominant biome definition (art direction, plan §13). */
  biome: BiomeDefinition;
  /** The world's shared wind state (plan §9). */
  wind: WindUniforms;
  /** Scene root new environment objects should join. */
  root: THREE.Group;
  /** Authoritative destruction states shared across cells and peers (plan §26/§57). */
  ledger: DestructionLedger;
  /** Load-once shared asset cache (plan §68/§69). */
  assets: AssetRegistry;
  /** Visual hooks (bursts, rings, dust) — optional so headless tests can omit them. */
  fx?: EnvironmentFxHooks;
  /**
   * Dynamic quality scale (plan §47): 1 = full profile density, <1 = watchdog has stepped the
   * budget down. Sampled at cell build time — existing instances are never yanked.
   */
  qualityScale(): number;
}

/** Every streamable environment system implements this lifecycle. */
export interface EnvironmentSystem {
  readonly name: string;
  /** Builds one cell's content (deterministic). Returns false when the system is out of budget. */
  activateCell(cell: number): boolean;
  /** Collapses/free one cell's content (plan §19: inactive cells cost nothing). */
  deactivateCell(cell: number): void;
  /** Per-frame uniform/visual updates. */
  update(dt: number): void;
  /** Watchdog / rescue hook (plan §47). */
  setVisible(visible: boolean): void;
  /** Telemetry counters for the debug overlay (plan §65). */
  stats(): { instances: number; activeCells: number; note?: string };
  dispose(): void;
}
