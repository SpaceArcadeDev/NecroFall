// NECROFALL — GEOLOGICAL FORMATIONS (complete rework, phases 9/10/59/60).
//
// The rendering half of `FormationGenerator`: every planned formation is composed from the
// shared low-poly asset library into ONE instanced mesh per family (rock / dark rock / spire /
// crystal / glow). Compositions — not random scatters — are the point: a stone ring is a ring,
// a cliff line is a wall of slabs, a crystal field is a glowing bed. Deterministic from the
// planet seed and terrain-contoured through the shared composer.
import * as THREE from 'three/webgpu';
import { color } from 'three/tsl';
import { PlanetSurface, createSurfaceSample } from '../../planet/PlanetSurface';
import type { SurfaceSample } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import type { PlanetObstacles } from '../../planet/PlanetObstacles';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { createEmissiveMaterial } from '../materials/EmissiveMaterial';
import { PropComposer } from './PropComposer';
import { boulderGeometry, coneGeometry, fanGeometry, shardGeometry, slabGeometry } from './PropGeometry';
import { mulberry32 } from '../../planet/PlanetSeed';
import { RADIOACTIVE_PALETTE } from '../materials/PlanetPalette';
import { generateFormations, type Formation } from '../../world/formations/FormationGenerator';

export class Formations {
  readonly group = new THREE.Group();
  readonly formationCount: number;
  readonly propCount: number;

  constructor(
    surface: PlanetSurface,
    generator: PlanetGenerator,
    timeUniform: any,
    spawnClear?: { direction: THREE.Vector3; radius: number },
    obstacles?: PlanetObstacles,
  ) {
    const formations = generateFormations(
      generator.seed,
      generator.radius,
      generator.terrain.landmarks,
      spawnClear?.direction ?? null,
    );
    this.formationCount = formations.length;

    const composer = new PropComposer();
    const rock = new MeshDefaultMaterial({ colorNode: color(RADIOACTIVE_PALETTE.rock), hasLightBounce: true, hasFog: true });
    (rock as any).flatShading = true;
    const rockDark = new MeshDefaultMaterial({ colorNode: color(RADIOACTIVE_PALETTE.rockDark), hasLightBounce: true, hasFog: true });
    (rockDark as any).flatShading = true;
    const rockLight = new MeshDefaultMaterial({ colorNode: color(RADIOACTIVE_PALETTE.rockLight), hasLightBounce: true, hasFog: true });
    (rockLight as any).flatShading = true;
    const crystal = createEmissiveMaterial({
      color: '#b6ff54',
      edgeColor: '#36ff9b',
      intensity: 2.4,
      bloom: 'medium',
      pulseSpeed: 1.2,
      pulseAmount: 0.2,
      facet: true,
      gradient: 'y',
      time: timeUniform,
    });
    const glow = createEmissiveMaterial({
      color: RADIOACTIVE_PALETTE.radioactive,
      edgeColor: RADIOACTIVE_PALETTE.radioactive3,
      intensity: 1.4,
      bloom: 'low',
      pulseSpeed: 0.8,
      pulseAmount: 0.3,
      facet: true,
      gradient: 'y',
      time: timeUniform,
    });

    composer.bucket('formationRock', boulderGeometry(0x9a01, 0.72), rock, true);
    composer.bucket('formationDark', boulderGeometry(0x9a02, 0.9), rockDark, true);
    composer.bucket('formationSlab', slabGeometry(0x9a03), rockDark, true);
    composer.bucket('formationSpire', coneGeometry(0x9a04, 5), rockLight, true);
    composer.bucket('formationCrystal', shardGeometry(), crystal, false);
    composer.bucket('formationGlow', fanGeometry(), glow, false);

    const sample = createSurfaceSample();
    const t1 = new THREE.Vector3();
    const t2 = new THREE.Vector3();
    const dir = new THREE.Vector3();
    /** Direction inside a formation site: `radial` 0 centre → 1 rim, `azimuth` radians. */
    const dirInSite = (site: Formation, radial: number, azimuth: number): THREE.Vector3 => {
      PlanetSurface.stableTangent(site.dir, t1);
      t2.crossVectors(site.dir, t1).normalize();
      const angle = Math.max(0, radial) * (site.radius / surface.radius);
      const sinA = Math.sin(angle);
      return dir
        .copy(site.dir)
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(t1, sinA * Math.cos(azimuth))
        .addScaledVector(t2, sinA * Math.sin(azimuth))
        .normalize();
    };

    for (const site of formations) {
      const random = mulberry32(site.seed);
      switch (site.type) {
        case 'ROCK_CLUSTER': {
          const count = 5 + Math.floor(random() * 5);
          for (let i = 0; i < count; i++) {
            const s = surface.sample(dirInSite(site, Math.sqrt(random()) * 0.85, random() * Math.PI * 2), sample);
            const scale = 0.8 + random() * 1.6;
            composer.place(random() < 0.55 ? 'formationRock' : 'formationDark', s, {
              yaw: random() * Math.PI * 2,
              scale: new THREE.Vector3(scale * (0.8 + random() * 0.5), scale, scale * (0.8 + random() * 0.5)),
              sink: scale * 0.24,
              tiltX: (random() - 0.5) * 0.5,
              tiltZ: (random() - 0.5) * 0.5,
              collide: { radius: 0.85 * scale, height: 0.9 * scale, steppable: true },
            });
          }
          // one hero block anchoring the family
          const s = surface.sample(dirInSite(site, 0.2 + random() * 0.3, random() * Math.PI * 2), sample);
          const scale = 2.6 + random() * 1.8;
          composer.place('formationSlab', s, {
            yaw: random() * Math.PI * 2,
            scale: new THREE.Vector3(scale, scale * (0.9 + random() * 0.5), scale * (0.7 + random() * 0.5)),
            sink: scale * 0.3,
            tiltX: (random() - 0.5) * 0.3,
            collide: { radius: scale * 0.9, height: scale, steppable: false },
          });
          break;
        }
        case 'BOULDER_FIELD': {
          const count = 14 + Math.floor(random() * 8);
          for (let i = 0; i < count; i++) {
            const s = surface.sample(dirInSite(site, Math.sqrt(random()), random() * Math.PI * 2), sample);
            const scale = 0.5 + random() * 1.6;
            composer.place(random() < 0.5 ? 'formationRock' : random() < 0.6 ? 'formationDark' : 'formationSpire', s, {
              yaw: random() * Math.PI * 2,
              scale: new THREE.Vector3(scale * (0.75 + random() * 0.6), scale * (0.7 + random() * 0.6), scale * (0.75 + random() * 0.6)),
              sink: scale * 0.3,
              tiltX: (random() - 0.5) * 0.6,
              tiltZ: (random() - 0.5) * 0.6,
              collide: { radius: 0.85 * scale, height: 0.9 * scale, steppable: true },
            });
          }
          break;
        }
        case 'STONE_RING': {
          const ringRadius = 0.55 + random() * 0.25;
          const count = 8 + Math.floor(random() * 4);
          for (let i = 0; i < count; i++) {
            const azimuth = (i / count) * Math.PI * 2 + random() * 0.16;
            const s = surface.sample(dirInSite(site, ringRadius * (0.94 + random() * 0.12), azimuth), sample);
            const scale = 1.2 + random() * 1.4;
            composer.place(random() < 0.6 ? 'formationDark' : 'formationRock', s, {
              // face the ring centre so the wall reads as one circle
              yaw: azimuth + Math.PI / 2 + (random() - 0.5) * 0.3,
              scale: new THREE.Vector3(scale * 0.9, scale * (1.1 + random() * 0.6), scale * 0.7),
              sink: scale * 0.28,
              tiltX: (random() - 0.5) * 0.12,
              collide: { radius: 0.9 * scale, height: 1.2 * scale, steppable: false },
            });
          }
          // the altar: one shard + a fan ring in the middle
          const altar = surface.sample(dirInSite(site, 0.06, 0), sample);
          composer.place('formationCrystal', altar, {
            scale: new THREE.Vector3(0.9, 1.5 + random() * 0.7, 0.9),
            sink: 0.1,
            collide: { radius: 0.9, height: 1.9, steppable: false },
          });
          for (let i = 0; i < 4; i++) {
            const s = surface.sample(dirInSite(site, 0.1 + random() * 0.08, random() * Math.PI * 2), sample);
            composer.place('formationGlow', s, { yaw: random() * Math.PI * 2, scale: 0.7 + random() * 0.6, sink: 0.04 });
          }
          break;
        }
        case 'SPIRE_FIELD': {
          const count = 6 + Math.floor(random() * 6);
          for (let i = 0; i < count; i++) {
            const s = surface.sample(dirInSite(site, 0.15 + Math.sqrt(random()) * 0.9, random() * Math.PI * 2), sample);
            const width = 0.6 + random() * 0.8;
            const height = 2.8 + random() * 4.8;
            composer.place('formationSpire', s, {
              yaw: random() * Math.PI * 2,
              scale: new THREE.Vector3(width, height, width * (0.8 + random() * 0.4)),
              sink: 0.16,
              tiltX: (random() - 0.5) * 0.22,
              tiltZ: (random() - 0.5) * 0.22,
              collide: { radius: width * 1.6, height, steppable: false },
            });
          }
          break;
        }
        case 'CLIFF_LINE': {
          // A wall of slabs along an arc — the "cliff band" silhouette.
          const span = 0.5 + random() * 0.24; // half-arc in radians of the footprint
          const count = 6 + Math.floor(random() * 5);
          for (let i = 0; i < count; i++) {
            const azimuth = -span + (i / (count - 1)) * span * 2 + (random() - 0.5) * 0.06;
            const s = surface.sample(dirInSite(site, 0.72 + random() * 0.2, azimuth), sample);
            const width = 3.2 + random() * 2.4;
            const height = 3.6 + random() * 4.4;
            composer.place('formationSlab', s, {
              yaw: azimuth + Math.PI / 2 + (random() - 0.5) * 0.18,
              scale: new THREE.Vector3(width, height, 1.4 + random() * 0.9),
              sink: height * 0.3,
              tiltX: (random() - 0.5) * 0.1,
              collide: { radius: 2.4, height, steppable: false },
            });
            if (random() < 0.6) {
              const rubble = surface.sample(dirInSite(site, 0.55 + random() * 0.3, azimuth + (random() - 0.5) * 0.1), sample);
              const scale = 0.9 + random() * 1.5;
              composer.place('formationRock', rubble, {
                yaw: random() * Math.PI * 2,
                scale,
                sink: scale * 0.3,
                collide: { radius: 0.85 * scale, height: 0.9 * scale, steppable: true },
              });
            }
          }
          break;
        }
        case 'CRYSTAL_FIELD': {
          const count = 10 + Math.floor(random() * 8);
          for (let i = 0; i < count; i++) {
            const s = surface.sample(dirInSite(site, Math.sqrt(random()), random() * Math.PI * 2), sample);
            const scale = 0.6 + random() * 1.4;
            composer.place('formationCrystal', s, {
              yaw: random() * Math.PI * 2,
              scale: new THREE.Vector3(scale * (0.6 + random() * 0.5), scale * (1.2 + random() * 1.1), scale * (0.6 + random() * 0.5)),
              sink: scale * 0.12,
              tiltX: (random() - 0.5) * 0.7,
              tiltZ: (random() - 0.5) * 0.7,
              collide: { radius: 0.85 * scale, height: 1.7 * scale, steppable: false },
            });
          }
          // the sheet's giant core — visible from far (plan §13 hero object energy)
          const core = surface.sample(dirInSite(site, 0.08, 0), sample);
          const coreScale = 2.4 + random() * 1.2;
          composer.place('formationCrystal', core, {
            scale: new THREE.Vector3(coreScale * 0.8, coreScale * 1.9, coreScale * 0.8),
            sink: 0.2,
            collide: { radius: coreScale, height: coreScale * 1.9, steppable: false },
          });
          for (let i = 0; i < 6 + Math.floor(random() * 5); i++) {
            const s = surface.sample(dirInSite(site, 0.2 + Math.sqrt(random()) * 0.8, random() * Math.PI * 2), sample);
            composer.place('formationGlow', s, { yaw: random() * Math.PI * 2, scale: 0.5 + random() * 0.9, sink: 0.04 });
          }
          break;
        }
      }
    }

    this.propCount = composer.commit(this.group, obstacles);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.group.traverse((object: any) => {
      if (object.isInstancedMesh) {
        object.geometry.dispose();
        (object.material as THREE.Material | undefined)?.dispose();
      }
    });
    this.group.removeFromParent();
  }
}
