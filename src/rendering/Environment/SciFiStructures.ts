// NECROFALL — SCI-FI STRUCTURES (complete rework, phases 13/61/62).
//
// One crashed colony ship (the hero sci-fi landmark), a landing pad, a ruined antenna and an
// energy relay per planet. The ship lands where the map says the colony died — a COLONY_WRECK
// landmark — and is assembled from modular pieces (hull segments, fins, wing slab, debris field,
// running lights, a torn-open reactor glow). Lights and cores are EMISSIVE materials feeding the
// restrained bloom (plan §21/§26) — never real lights, never a per-frame CPU cost.
import * as THREE from 'three/webgpu';
import { color } from 'three/tsl';
import type { PlanetSurface, SurfaceSample } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import type { PlanetObstacles } from '../../planet/PlanetObstacles';
import type { Placement } from '../../planet/Placement';
import { PlanetSurface as PlanetSurfaceClass, createSurfaceSample } from '../../planet/PlanetSurface';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { createEmissiveMaterial } from '../materials/EmissiveMaterial';
import { attachOutline } from '../materials/OutlineMaterial';
import { ART_DIRECTION } from '../ArtDirection';
import { PropComposer } from './PropComposer';
import { beamGeometry, boulderGeometry, fanGeometry, hullGeometry, padGeometry, panelGeometry, ringGeometry, shardGeometry, slabGeometry } from './PropGeometry';
import { mulberry32 } from '../../planet/PlanetSeed';
import { generateSciFiSites, type SciFiSite } from '../../world/formations/FormationGenerator';

const TECH_METAL = '#4c5963';
const TECH_DARK = '#39434c';
const TECH_LIGHT = '#bfd5dc';
const LIGHT_CYAN = '#4fdcff';
const LIGHT_RED = '#ff4356';
const EMBER = '#ff8a3d';

export class SciFiStructures {
  readonly group = new THREE.Group();
  readonly siteCount: number;
  readonly propCount: number;
  /** Module geometries/materials shared by instanced debris and non-instanced parts. */
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();

  constructor(
    surface: PlanetSurface,
    generator: PlanetGenerator,
    timeUniform: any,
    spawnClear?: { direction: THREE.Vector3; radius: number },
    obstacles?: PlanetObstacles,
  ) {
    const sites = generateSciFiSites(generator.seed, generator.radius, generator.terrain.landmarks, spawnClear?.direction ?? null);
    this.siteCount = sites.length;

    // ONE geometry/material per module type — shared by the instanced buckets (debris) and the
    // non-instanced parts (hull segments, fins), disposed exactly once in `dispose()`.
    const geo = <T extends THREE.BufferGeometry>(geometry: T): T => {
      this.geometries.add(geometry);
      return geometry;
    };
    const mat = <T extends THREE.Material>(material: T): T => {
      this.materials.add(material);
      return material;
    };
    const hullGeo = geo(hullGeometry(0x77a2));
    const finGeo = geo(slabGeometry(0x77b1));
    const wingGeo = geo(slabGeometry(0x77b2));
    const rampGeo = geo(slabGeometry(0x77c1));
    const relayGeo = geo(slabGeometry(0x77d1));
    const beamGeo = geo(beamGeometry());
    const shardGeo = geo(shardGeometry());
    const ringGeo = geo(ringGeometry(1, 0.1)); // scaled per use
    const padGeo = geo(padGeometry(1, 0.1)); // scaled per use (unit radius)
    const panelGeo = geo(panelGeometry(0x77a1));
    const rockGeo = geo(boulderGeometry(0x77a3, 0.8));
    const fanGeo = geo(fanGeometry());

    const composer = new PropComposer();
    const hullMaterial = new MeshDefaultMaterial({ colorNode: color(TECH_METAL), hasLightBounce: true, hasFog: true });
    (hullMaterial as any).flatShading = true;
    const darkMaterial = new MeshDefaultMaterial({ colorNode: color(TECH_DARK), hasLightBounce: true, hasFog: true });
    (darkMaterial as any).flatShading = true;
    const paleMaterial = new MeshDefaultMaterial({ colorNode: color(TECH_LIGHT), hasLightBounce: true, hasFog: true });
    (paleMaterial as any).flatShading = true;
    mat(hullMaterial);
    mat(darkMaterial);
    mat(paleMaterial);
    const redLight = createEmissiveMaterial({ color: LIGHT_RED, intensity: 1.6, bloom: 'low', pulseSpeed: 2.2, pulseAmount: 0.4, time: timeUniform });
    const cyanLight = createEmissiveMaterial({ color: LIGHT_CYAN, edgeColor: '#bfeaff', intensity: 2.4, bloom: 'medium', pulseSpeed: 1.0, pulseAmount: 0.22, facet: true, gradient: 'y', time: timeUniform });
    const emberGlow = createEmissiveMaterial({ color: EMBER, edgeColor: '#ffd76a', intensity: 1.5, bloom: 'low', pulseSpeed: 0.7, pulseAmount: 0.35, time: timeUniform });

    composer.bucket('scifiPanel', panelGeo, mat(darkMaterial), false);
    composer.bucket('scifiHull', hullGeo, mat(hullMaterial), false);
    composer.bucket('scifiRock', rockGeo, mat(darkMaterial), true);
    composer.bucket('scifiGlow', fanGeo, mat(emberGlow), false);

    const sample = createSurfaceSample();
    const up = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const basis = new THREE.Matrix4();
    const scratchQuat = new THREE.Quaternion();
    const tiltQuat = new THREE.Quaternion();
    const emitterPositions: number[] = [];
    const emitterColors: number[] = [];

    const keyLightAt = (position: THREE.Vector3): void => {
      emitterPositions.push(position.x, position.y, position.z);
      emitterColors.push(1, 0.55, 0.24);
    };

    const frame = (site: SciFiSite, s: SurfaceSample, yaw: number): void => {
      up.copy(s.up);
      PlanetSurfaceClass.stableTangent(up, forward);
      forward.applyAxisAngle(up, yaw).normalize();
      right.crossVectors(forward, up).normalize();
      basis.makeBasis(right, up, forward);
    };

    /** Non-instanced module placed in the site frame (hull segments, pads, masts, lights). */
    const part = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material | THREE.Material[],
      s: SurfaceSample,
      along: number,
      height: number,
      scale: THREE.Vector3,
      localYaw: number,
      tilt: number,
      roll = 0,
      collider?: { radius: number; height: number; steppable: boolean },
      outline = 0,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, material as THREE.Material);
      mesh.position.copy(s.point).addScaledVector(forward, along).addScaledVector(up, height);
      scratchQuat.setFromRotationMatrix(basis);
      scratchQuat.multiply(tiltQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), localYaw));
      if (tilt !== 0) scratchQuat.multiply(tiltQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt));
      if (roll !== 0) scratchQuat.multiply(tiltQuat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
      mesh.quaternion.copy(scratchQuat);
      mesh.scale.copy(scale);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'scifiPart';
      if (!Array.isArray(material)) this.materials.add(material);
      if (outline > 0) {
        attachOutline(mesh, ART_DIRECTION.outlines.distance * outline);
      }
      this.group.add(mesh);
      if (collider && obstacles) {
        const placement: Placement = {
          matrix: mesh.matrixWorld,
          position: mesh.position.clone(),
          normal: s.normal.clone(),
          scale: Math.max(scale.x, scale.y, scale.z),
          yaw: localYaw,
          grass: s.grass,
          slope: s.slope,
          radiation: s.radiation,
          wetness: s.wetness,
          height: s.height,
        };
        obstacles.add(placement, collider.radius, collider.height, collider.steppable);
      }
      return mesh;
    };

    for (const site of sites) {
      const random = mulberry32(site.seed);
      const s = surface.sample(site.dir, sample);
      const yaw = random() * Math.PI * 2;
      frame(site, s, yaw);

      switch (site.type) {
        case 'CRASHED_SHIP': {
          // ---- fuselage: three modular segments, nose buried, tail broken off and kicked up.
          part(hullGeo, hullMaterial, s, -3.6, 0.15, new THREE.Vector3(1.5, 1.25, 4.5), 0, 0.16, 0, { radius: 2.3, height: 3.4, steppable: false }, 2.6);
          part(hullGeo, hullMaterial, s, 2.6, 0.35, new THREE.Vector3(1.4, 1.15, 4.1), 0.12, -0.05, 0, { radius: 2.2, height: 3.2, steppable: false });
          part(hullGeo, hullMaterial, s, 7.4, 0.9, new THREE.Vector3(1.15, 0.95, 2.6), 0.34, 0.42, 0, { radius: 1.8, height: 2.6, steppable: false });

          // ---- fins + wing slab (hull geometry is a 2-unit cylinder along Z; scale.z = length/2)
          part(finGeo, darkMaterial, s, 2.2, 3.6, new THREE.Vector3(0.4, 2.6, 2.6), 0.1, 0.24, 0.35);
          part(finGeo, darkMaterial, s, 4.0, 3.3, new THREE.Vector3(0.4, 2.2, 2.3), 0.5, -0.2, -0.3);
          part(wingGeo, hullMaterial, s, -0.6, 0.6, new THREE.Vector3(4.6, 0.4, 2.8), 0.55, 0.1, 0.35, { radius: 3.0, height: 1.2, steppable: false });

          // ---- running lights along the spine + the torn reactor glow
          for (let i = 0; i < 4; i++) {
            const along = -5 + i * 3.6;
            part(beamGeo, redLight, s, along, 2.35, new THREE.Vector3(0.16, 0.16, 0.16), 0, 0, 0);
            keyLightAt(new THREE.Vector3().copy(s.point).addScaledVector(forward, along).addScaledVector(up, 2.6));
          }
          part(shardGeo, cyanLight, s, 5.1, 0.8, new THREE.Vector3(0.55, 1.2, 0.55), 0, 0, 0.2, { radius: 1.4, height: 3.2, steppable: false });

          // ---- debris field + scorched rocks
          const debris = 12 + Math.floor(random() * 6);
          for (let i = 0; i < debris; i++) {
            const px = (random() - 0.5) * 34;
            const pz = (random() - 0.5) * 34;
            const dir = new THREE.Vector3().copy(s.point).addScaledVector(right, px).addScaledVector(forward, pz).normalize();
            const spot = surface.sample(dir, sample);
            const scale = 0.6 + random() * 1.9;
            composer.place(random() < 0.72 ? 'scifiPanel' : 'scifiHull', spot, {
              yaw: random() * Math.PI * 2,
              scale: new THREE.Vector3(scale, scale * (0.7 + random() * 0.6), scale * (0.8 + random() * 0.5)),
              sink: scale * 0.32,
              tiltX: (random() - 0.5) * 0.9,
              tiltZ: (random() - 0.5) * 0.9,
              collide: { radius: 0.9 * scale, height: 0.8 * scale, steppable: true },
            });
            if (random() < 0.2) keyLightAt(spot.point.clone().addScaledVector(spot.up, 0.4));
          }
          for (let i = 0; i < 4; i++) {
            const px = (random() - 0.5) * 14;
            const pz = (random() - 0.5) * 14;
            const dir = new THREE.Vector3().copy(s.point).addScaledVector(right, px).addScaledVector(forward, pz).normalize();
            const spot = surface.sample(dir, sample);
            const scale = 1.1 + random() * 1.5;
            composer.place('scifiRock', spot, {
              yaw: random() * Math.PI * 2,
              scale,
              sink: scale * 0.35,
              collide: { radius: scale, height: scale, steppable: true },
            });
          }
          for (let i = 0; i < 5; i++) {
            const dir = new THREE.Vector3().copy(s.point).addScaledVector(right, (random() - 0.5) * 16).addScaledVector(forward, (random() - 0.5) * 16).normalize();
            const spot = surface.sample(dir, sample);
            composer.place('scifiGlow', spot, { yaw: random() * Math.PI * 2, scale: 0.5 + random() * 0.7, sink: 0.05 });
          }
          break;
        }

        case 'LANDING_PAD': {
          // ---- hex pad + emissive guide ring + corner posts + beacon mast
          part(padGeo, hullMaterial, s, 0, 0.02, new THREE.Vector3(3.6, 2.6, 3.6), 0, 0, 0, { radius: 3.7, height: 0.3, steppable: true });
          const ring = part(ringGeo, cyanLight, s, 0, 0.24, new THREE.Vector3(2.7, 0.9, 2.7), 0, Math.PI / 2, 0);
          ring.castShadow = false;
          for (let i = 0; i < 4; i++) {
            const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
            const px = Math.cos(angle) * 3.3;
            const pz = Math.sin(angle) * 3.3;
            const dir = new THREE.Vector3().copy(s.point).addScaledVector(right, px).addScaledVector(forward, pz).normalize();
            const spot = surface.sample(dir, sample);
            part(beamGeo, darkMaterial, spot, 0, 0.75, new THREE.Vector3(0.16, 1.5, 0.16), 0, 0, 0, { radius: 0.3, height: 1.5, steppable: false });
            const tip = part(beamGeo, cyanLight, spot, 0, 1.55, new THREE.Vector3(0.12, 0.16, 0.12), 0, 0, 0);
            tip.castShadow = false;
            keyLightAt(new THREE.Vector3().copy(spot.point).addScaledVector(spot.up, 1.7));
          }
          // beacon mast + ramp slab
          part(beamGeo, darkMaterial, s, -5.2, 2.0, new THREE.Vector3(0.2, 4.0, 0.2), 0.2, 0.04, 0, { radius: 0.4, height: 4, steppable: false });
          part(beamGeo, redLight, s, -5.2, 4.1, new THREE.Vector3(0.14, 0.3, 0.14), 0.2, 0);
          part(rampGeo, hullMaterial, s, -4.2, 0.5, new THREE.Vector3(2.2, 0.35, 1.2), 0.5, 0.28, 0);
          break;
        }

        case 'RUINED_ANTENNA': {
          const segments = [
            { along: 0, height: 1.7, tilt: 0.04, scale: new THREE.Vector3(0.34, 3.4, 0.34) },
            { along: 0.5, height: 4.7, tilt: 0.16, scale: new THREE.Vector3(0.26, 2.8, 0.26) },
            { along: 1.2, height: 7.0, tilt: 0.34, scale: new THREE.Vector3(0.18, 2.0, 0.18) },
          ];
          for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            part(
              beamGeo,
              i === 0 ? hullMaterial : darkMaterial,
              s,
              segment.along,
              segment.height,
              segment.scale,
              0,
              segment.tilt,
              0,
              i === 0 ? { radius: 0.5, height: 3.4, steppable: false } : undefined,
            );
          }
          const dish = part(padGeo, paleMaterial, s, 1.5, 7.6, new THREE.Vector3(1.5, 1.4, 1.5), 0, 0.9, 0.3);
          dish.castShadow = true;
          part(beamGeo, redLight, s, 1.5, 8.6, new THREE.Vector3(0.12, 0.24, 0.12), 0, 0);
          for (let i = 0; i < 4; i++) {
            const dir = new THREE.Vector3().copy(s.point).addScaledVector(right, (random() - 0.5) * 12).addScaledVector(forward, (random() - 0.5) * 12).normalize();
            const spot = surface.sample(dir, sample);
            const scale = 0.7 + random() * 1.2;
            composer.place('scifiPanel', spot, {
              yaw: random() * Math.PI * 2,
              scale,
              sink: scale * 0.3,
              tiltX: (random() - 0.5) * 0.8,
              collide: { radius: 0.8 * scale, height: 0.7 * scale, steppable: true },
            });
          }
          break;
        }

        case 'ENERGY_RELAY': {
          // ---- alien machine: base slab, three legs, floating emissive ring + core
          part(relayGeo, darkMaterial, s, 0, 0.35, new THREE.Vector3(2.6, 0.7, 2.6), 0, 0, 0, { radius: 2.7, height: 0.9, steppable: false });
          for (let i = 0; i < 3; i++) {
            const angle = (i / 3) * Math.PI * 2;
            part(beamGeo, hullMaterial, s, 0, 1.6, new THREE.Vector3(0.22, 2.6, 0.22), angle, 0.16, 0.16, { radius: 0.4, height: 2.6, steppable: false });
          }
          const energyRing = part(ringGeo, cyanLight, s, 0, 3.0, new THREE.Vector3(1.5, 1.5, 1.5), 0, Math.PI / 2, 0);
          energyRing.castShadow = false;
          part(shardGeo, cyanLight, s, 0, 2.6, new THREE.Vector3(0.6, 1.2, 0.6), 0, 0, 0, { radius: 1.2, height: 3.0, steppable: false });
          for (let i = 0; i < 4; i++) {
            const dir = new THREE.Vector3().copy(s.point).addScaledVector(right, (random() - 0.5) * 10).addScaledVector(forward, (random() - 0.5) * 10).normalize();
            const spot = surface.sample(dir, sample);
            composer.place('scifiGlow', spot, { yaw: random() * Math.PI * 2, scale: 0.5 + random() * 0.7, sink: 0.05 });
          }
          keyLightAt(new THREE.Vector3().copy(s.point).addScaledVector(up, 3.2));
          break;
        }
      }
    }

    this.propCount = composer.commit(this.group, obstacles);

    // ---- ember motes: ONE additive Points cloud over every lit site (plan §46/§62).
    if (emitterPositions.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(emitterPositions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(emitterColors, 3));
      const material = new THREE.PointsMaterial({
        size: 0.22,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const points = new THREE.Points(geometry, material);
      points.name = 'scifiMotes';
      points.frustumCulled = false;
      this.group.add(points);
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.group.traverse((object: any) => {
      if (object.isPoints) {
        object.geometry.dispose();
        (object.material as THREE.Material | undefined)?.dispose();
      }
    });
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.group.removeFromParent();
  }
}
