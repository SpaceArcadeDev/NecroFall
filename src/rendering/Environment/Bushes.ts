/**
 * NECROFALL — bushes (folio `World/Bushes.js` port, plan §19/§58).
 *
 * Folio bushes are pure leaf-card canopies — same Foliage system, darker
 * contaminated greens, smaller cards, their own seeded placement pass.
 */
import * as THREE from 'three/webgpu';
import { color, uniform } from 'three/tsl';
import type { PreRenderer } from '../PreRenderer';
import type { Ticker } from '../Ticker';
import type { Wind } from './Wind';
import { Foliage } from './Foliage';
import type { PlanetSurface } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import type { PlanetObstacles } from '../../planet/PlanetObstacles';
import { scatterPlacements } from '../../planet/Placement';
import { RADIOACTIVE_PALETTE } from '../materials/PlanetPalette';

export interface SpawnClear {
  direction: THREE.Vector3;
  radius: number;
}

export class Bushes {
  readonly foliage: Foliage;
  readonly count: number;

  constructor(
    preRenderer: PreRenderer,
    wind: Wind,
    ticker: Ticker,
    surface: PlanetSurface,
    generator: PlanetGenerator,
    count = 240,
    spawnClear?: SpawnClear,
    obstacles?: PlanetObstacles,
    blocked?: (positionX: number, positionY: number, positionZ: number) => boolean,
  ) {
    const placements = scatterPlacements(surface, generator, {
      count,
      salt: 41,
      maxSlope: 0.55,
      minGrass: 0.3,
      aboveWater: 0.1,
      // Bigger bushes (user ask: "increase the amount of bushes and their sizes").
      scaleMin: 0.8,
      scaleMax: 2.0,
      sinkFactor: 0.12,
      attemptsPerInstance: 10,
      excludeDirection: spawnClear?.direction,
      excludeRadius: spawnClear?.radius,
      accept: sample => !blocked?.(sample.up.x, sample.up.y, sample.up.z),
    });

    for (const placement of placements) obstacles?.add(placement, 0.45 * placement.scale, 0.55 * placement.scale, true);

    const matrices = placements.map((placement) => placement.matrix);
    this.foliage = new Foliage(
      preRenderer,
      wind,
      matrices,
      uniform(color(generator.archetype.art?.foliage ?? RADIOACTIVE_PALETTE.foliageDark)),
      uniform(color(generator.archetype.art?.foliageLight ?? RADIOACTIVE_PALETTE.foliage)),
      ticker,
      // NO see-through fade on bushes (user ask): unlike tall tree canopies a knee-high bush
      // never blocks the view, so it just stays solid — no pop-out when the camera pans past.
      { planeCount: 72, planeSize: 0.56, seed: 907, seeThrough: false, castShadow: false },
    );
    this.count = placements.length;
  }

  setVisible(visible: boolean): void {
    this.foliage.setVisible(visible);
  }

  dispose(): void {
    this.foliage.dispose();
  }
}
