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
  ) {
    const placements = scatterPlacements(surface, generator, {
      count,
      salt: 41,
      maxSlope: 0.55,
      minGrass: 0.3,
      aboveWater: 0.1,
      scaleMin: 0.55,
      scaleMax: 1.35,
      sinkFactor: 0.12,
      attemptsPerInstance: 8,
      excludeDirection: spawnClear?.direction,
      excludeRadius: spawnClear?.radius,
    });

    for (const placement of placements) obstacles?.add(placement, 0.45 * placement.scale, 0.55 * placement.scale, true);

    const matrices = placements.map((placement) => placement.matrix);
    this.foliage = new Foliage(
      preRenderer,
      wind,
      matrices,
      uniform(color(RADIOACTIVE_PALETTE.foliageDark)),
      uniform(color(RADIOACTIVE_PALETTE.foliage)),
      ticker,
      { planeCount: 46, planeSize: 0.62, seed: 907, seeThrough: true, castShadow: false },
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
