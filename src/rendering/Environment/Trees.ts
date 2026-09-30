/**
 * NECROFALL — tree systems (folio `World/Trees.js` port, plan §19–§21/§94).
 *
 * The folio split is kept: trunk geometry as ONE InstancedMesh, canopy leaf
 * cards as ONE Foliage draw, both placed by our own seeded planet pipeline.
 * Colours are the radioactive variants (birch green/yellow, oak dark
 * contaminated green, cherry mutated red/purple) applied through TSL — the
 * silhouettes and geometry are folio's own assets.
 */
import * as THREE from 'three/webgpu';
import { color, uniform } from 'three/tsl';
import type { ResourcesLoader } from '../Assets/ResourcesLoader';
import type { Materials } from '../materials/Materials';
import type { PreRenderer } from '../PreRenderer';
import type { Ticker } from '../Ticker';
import type { Wind } from './Wind';
import { Foliage } from './Foliage';
import type { PlanetSurface } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import { scatterPlacements } from '../../planet/Placement';

export interface TreeSpeciesOptions {
  name: string;
  url: string;
  /** Trees to place across the planet. */
  count: number;
  salt: number;
  leafColorA: string;
  leafColorB: string;
  /** Filters (plan §58 defaults: slope < 0.40, grass > 0.35). */
  maxSlope?: number;
  minGrass?: number;
  aboveWater?: number;
  /** Trunk height range in metres (scaled from the asset's own bounds). */
  heightMin?: number;
  heightMax?: number;
}

export interface SpawnClear {
  direction: THREE.Vector3;
  radius: number;
}

export interface TreesDependencies {
  loader: ResourcesLoader;
  materials: Materials;
  preRenderer: PreRenderer;
  wind: Wind;
  ticker: Ticker;
  surface: PlanetSurface;
  generator: PlanetGenerator;
  /** Keep a clearing around the player spawn (dev world + real spawns). */
  spawnClear?: SpawnClear;
}

export class Trees {
  readonly group = new THREE.Group();
  readonly trunkMesh: THREE.InstancedMesh | null;
  readonly foliage: Foliage | null;
  readonly treeCount: number;

  private constructor(trunkMesh: THREE.InstancedMesh | null, foliage: Foliage | null, treeCount: number) {
    this.trunkMesh = trunkMesh;
    this.foliage = foliage;
    this.treeCount = treeCount;
    if (trunkMesh) this.group.add(trunkMesh);
    if (foliage) this.group.add(foliage.mesh);
  }

  static async create(species: TreeSpeciesOptions, deps: TreesDependencies): Promise<Trees> {
    const gltf = await deps.loader.loadGLTF(species.url);
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);

    // every GLB material goes through the shared lighting language (plan §53)
    deps.materials.updateObject(scene);

    // ---- extract trunk + canopy references (folio's treeBody / treeLeaves)
    const parts: { body: THREE.Mesh | null } = { body: null };
    const leafNodes: THREE.Object3D[] = [];
    scene.traverse((object: any) => {
      if (!object.isMesh) return;
      if (object.name.startsWith('treeLeaves')) leafNodes.push(object);
      else if (object.name.startsWith('treeBody')) parts.body = object as THREE.Mesh;
    });
    const body = parts.body;

    // ---- asset height → world scale
    const bounds = new THREE.Box3().setFromObject(scene);
    const assetHeight = Math.max(0.5, bounds.max.y - bounds.min.y);
    const baseScale = (((species.heightMin ?? 6) + (species.heightMax ?? 10)) * 0.5) / assetHeight;

    // ---- placement (load time only — plan §65)
    const placements = scatterPlacements(deps.surface, deps.generator, {
      count: species.count,
      salt: species.salt,
      maxSlope: species.maxSlope ?? 0.4,
      minGrass: species.minGrass ?? 0.24,
      aboveWater: species.aboveWater ?? 0.4,
      scaleMin: baseScale * 0.78,
      scaleMax: baseScale * 1.3,
      sinkFactor: 0.05,
      attemptsPerInstance: 14,
      excludeDirection: deps.spawnClear?.direction,
      excludeRadius: deps.spawnClear?.radius,
    });

    // ---- trunk instancing
    let trunkMesh: THREE.InstancedMesh | null = null;
    if (body) {
      const geometry = body.geometry.clone();
      geometry.applyMatrix4(body.matrix);
      trunkMesh = new THREE.InstancedMesh(geometry, body.material as THREE.Material, Math.max(1, placements.length));
      trunkMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      trunkMesh.castShadow = true;
      trunkMesh.receiveShadow = true;
      trunkMesh.frustumCulled = false;
      for (let i = 0; i < placements.length; i++) trunkMesh.setMatrixAt(i, placements[i].matrix);
      trunkMesh.instanceMatrix.needsUpdate = true;
      trunkMesh.name = `${species.name}Trunks`;
    }

    // ---- canopy leaf cards
    let foliage: Foliage | null = null;
    if (leafNodes.length > 0 && placements.length > 0) {
      const leafMatrices: THREE.Matrix4[] = [];
      for (const placement of placements) {
        for (const node of leafNodes) {
          leafMatrices.push(new THREE.Matrix4().multiplyMatrices(placement.matrix, node.matrixWorld));
        }
      }
      foliage = new Foliage(
        deps.preRenderer,
        deps.wind,
        leafMatrices,
        uniform(color(species.leafColorA)),
        uniform(color(species.leafColorB)),
        deps.ticker,
        { seeThrough: true, castShadow: true, seed: species.salt + 17 },
      );
    }

    return new Trees(trunkMesh, foliage, placements.length);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.trunkMesh?.geometry.dispose();
    this.foliage?.dispose();
  }
}
