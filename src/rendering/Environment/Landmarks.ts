/**
 * NECROFALL — landmark composition (visual rework plan §16–§18, §28, §63).
 *
 * Plan §18 calls this "one of the biggest changes needed to get away from procedural game arena
 * and toward planet": every world's carved landmarks (`LandmarkGenerator`, gameplay side) now
 * grow a deterministic PROP COMPOSITION around their site — crystal groves, dead forests,
 * ruined colonies, nests — plus ONE hero formation, large enough to navigate by from across the
 * field (§17/§63 strong macro composition).
 *
 * Rules kept from the plan:
 *   • reuse the existing assets/geometry language — no new model per landmark (§17);
 *   • every prop is terrain-aligned, physics-anchored, and only 70–90 % normal-aligned so trees
 *     and structures never read as leaning tents (§28);
 *   • instancing everywhere: one geometry + one material + many instances (§15/§42), grouped by
 *     kind and accent colour so a whole planet costs a dozen draw calls;
 *   • per-instance imperfection from the SAME planet seed (§29) — same seed, same world.
 */
import * as THREE from 'three/webgpu';
import { color, mix, positionWorld, texture } from 'three/tsl';
import type { PlanetSurface, SurfaceSample } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import type { PlanetObstacles } from '../../planet/PlanetObstacles';
import type { Placement } from '../../planet/Placement';
import { createSurfaceSample } from '../../planet/PlanetSurface';
import { mulberry32 } from '../../planet/PlanetSeed';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { createEmissiveMaterial, type BloomTier } from '../materials/EmissiveMaterial';
import { attachOutline } from '../materials/OutlineMaterial';
import { RADIOACTIVE_PALETTE } from '../materials/PlanetPalette';
import { ART_DIRECTION } from '../ArtDirection';
import type { Landmark, LandmarkType } from '../../world/LandmarkGenerator';
import type { Noises } from './Noises';

/** Prop families the composition draws from (all procedural, all shared). */
type PropKind = 'crystal' | 'shard' | 'spire' | 'rock' | 'bone' | 'stalk' | 'cap' | 'panel';

interface PropSpec {
  kind: PropKind;
  min: number;
  max: number;
  scaleMin: number;
  scaleMax: number;
  /** Accent override; defaults to the landmark's own accent colour. */
  accent?: string;
  bloom?: BloomTier;
  /** Extra height above the surface (metres) — the FLOATING_ROCKS field uses it. */
  hover?: number;
}

/** Per-landmark composition (plan §16/§17): what grows around each carved site. */
function compositionFor(type: LandmarkType): PropSpec[] {
  switch (type) {
    case 'CRYSTAL_CANYON':
      return [
        { kind: 'crystal', min: 6, max: 11, scaleMin: 2.2, scaleMax: 5.5, bloom: 'medium' },
        { kind: 'shard', min: 8, max: 14, scaleMin: 0.6, scaleMax: 1.5, bloom: 'medium' },
        { kind: 'rock', min: 3, max: 6, scaleMin: 0.8, scaleMax: 2.2 },
      ];
    case 'CORRUPTED_PEAK':
      return [
        { kind: 'crystal', min: 5, max: 9, scaleMin: 2.5, scaleMax: 6, accent: '#7fe6ff', bloom: 'medium' },
        { kind: 'spire', min: 3, max: 5, scaleMin: 3, scaleMax: 7, accent: '#3b1930' },
        { kind: 'rock', min: 4, max: 7, scaleMin: 1, scaleMax: 2.6 },
      ];
    case 'NECROTIC_CRATER':
      return [
        { kind: 'spire', min: 5, max: 8, scaleMin: 2.5, scaleMax: 6, accent: '#3a0d19' },
        { kind: 'crystal', min: 3, max: 6, scaleMin: 1.2, scaleMax: 3.2, accent: '#ff3d63', bloom: 'medium' },
        { kind: 'rock', min: 4, max: 7, scaleMin: 0.9, scaleMax: 2.4 },
      ];
    case 'NECROPHAGE_NEST':
      return [
        { kind: 'spire', min: 7, max: 11, scaleMin: 2.5, scaleMax: 7, accent: '#31060f' },
        { kind: 'crystal', min: 3, max: 6, scaleMin: 1.4, scaleMax: 3.4, accent: '#ff2d4d', bloom: 'medium' },
        { kind: 'rock', min: 3, max: 6, scaleMin: 1, scaleMax: 2.6 },
      ];
    case 'FUNGAL_FOREST':
      return [
        { kind: 'stalk', min: 6, max: 10, scaleMin: 2.2, scaleMax: 5.5, accent: '#6a5a46' },
        { kind: 'cap', min: 6, max: 10, scaleMin: 2.2, scaleMax: 5.5, accent: '#4b6d3a' },
        { kind: 'rock', min: 2, max: 4, scaleMin: 0.7, scaleMax: 1.8 },
      ];
    case 'BONE_VALLEY':
      return [
        { kind: 'bone', min: 8, max: 13, scaleMin: 1.6, scaleMax: 4.6 },
        { kind: 'rock', min: 3, max: 6, scaleMin: 0.9, scaleMax: 2.2 },
      ];
    case 'TOXIC_LAKE':
      return [
        { kind: 'crystal', min: 5, max: 9, scaleMin: 1.2, scaleMax: 3.4, accent: '#8dff5a', bloom: 'medium' },
        { kind: 'shard', min: 6, max: 10, scaleMin: 0.5, scaleMax: 1.2, accent: '#4dffc3', bloom: 'medium' },
        { kind: 'rock', min: 3, max: 6, scaleMin: 0.8, scaleMax: 2 },
      ];
    case 'COLONY_WRECK':
      return [
        { kind: 'panel', min: 7, max: 11, scaleMin: 2, scaleMax: 5, accent: '#d6e6ee' },
        { kind: 'crystal', min: 2, max: 4, scaleMin: 1, scaleMax: 2.4, accent: '#6fd2ff', bloom: 'low' },
        { kind: 'rock', min: 3, max: 6, scaleMin: 0.9, scaleMax: 2.2 },
      ];
    case 'MASSIVE_SINKHOLE':
      return [
        { kind: 'rock', min: 7, max: 11, scaleMin: 1.6, scaleMax: 4, accent: '#54505f' },
        { kind: 'crystal', min: 2, max: 4, scaleMin: 1, scaleMax: 2.4, accent: '#9fe8d8', bloom: 'low' },
      ];
    case 'FLOATING_ROCKS':
      return [
        { kind: 'rock', min: 6, max: 10, scaleMin: 1.4, scaleMax: 3.4, hover: 3.2 },
        { kind: 'shard', min: 3, max: 6, scaleMin: 0.6, scaleMax: 1.4, accent: '#9fb6ff', bloom: 'low', hover: 2.6 },
      ];
    default:
      return [
        { kind: 'rock', min: 4, max: 8, scaleMin: 0.9, scaleMax: 2.4 },
        { kind: 'crystal', min: 2, max: 4, scaleMin: 1, scaleMax: 2.6, bloom: 'low' },
      ];
  }
}

/** The plan §28 ground-contact blend: mostly the terrain normal, partly world-up. */
const TERRAIN_ALIGNMENT = 0.85;

const WORLD_UP = new THREE.Vector3(0, 1, 0);

interface PropBucket {
  kind: PropKind;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrices: THREE.Matrix4[];
  castShadow: boolean;
  receiveShadow: boolean;
}

export class Landmarks {
  readonly group = new THREE.Group();
  readonly propCount: number;
  /** The hero formation's identity (telemetry / docs): "TYPE @ …" or '' when none was built. */
  readonly heroLabel: string;

  private readonly dummy = new THREE.Object3D();
  private readonly sample: SurfaceSample = createSurfaceSample();
  private readonly scratchDirection = new THREE.Vector3();
  private readonly upQuaternion = new THREE.Quaternion();
  private readonly normalQuaternion = new THREE.Quaternion();
  private readonly yawQuaternion = new THREE.Quaternion();

  constructor(
    private readonly surface: PlanetSurface,
    private readonly generator: PlanetGenerator,
    private readonly noises: Noises,
    private readonly timeUniform: any,
    spawnClear?: { direction: THREE.Vector3; radius: number },
    obstacles?: PlanetObstacles,
  ) {
    const landmarks = generator.terrain.landmarks;
    const buckets = new Map<string, PropBucket>();
    const geometries = new Map<string, THREE.BufferGeometry>();
    const materials = new Map<string, THREE.Material>();

    const geometryFor = (kind: PropKind): THREE.BufferGeometry => {
      const existing = geometries.get(kind);
      if (existing) return existing;
      const created = Landmarks.createGeometry(kind, generator.seed);
      geometries.set(kind, created);
      return created;
    };

    const materialFor = (kind: PropKind, accent: string, bloom: BloomTier): THREE.Material => {
      const key = `${kind}|${accent}|${bloom}`;
      const existing = materials.get(key);
      if (existing) return existing;

      let material: THREE.Material;
      if (kind === 'crystal' || kind === 'shard') {
        material = createEmissiveMaterial({
          color: accent,
          edgeColor: kind === 'crystal' ? '#e9ffd9' : accent,
          intensity: ART_DIRECTION.radiation.intensity,
          bloom,
          facet: true,
          gradient: kind === 'crystal' ? 'uv' : 'none',
          time: timeUniform,
        });
      } else if (kind === 'spire') {
        // Necrophage tissue: near-black red body with a faint crimson sheen (plan §31).
        const variation = (texture(noises.perlin, (positionWorld as any).xz.mul(0.12)).r as any).mul(0.35).add(0.72);
        material = new MeshDefaultMaterial({
          colorNode: mix(color(accent), color('#0d0509'), variation.oneMinus()) as any,
          glowNode: color('#ff2f4e').mul(0.12) as any,
          hasLightBounce: true,
        });
      } else if (kind === 'bone') {
        material = new MeshDefaultMaterial({ colorNode: color(RADIOACTIVE_PALETTE.rockLight), hasLightBounce: true });
      } else if (kind === 'stalk' || kind === 'cap') {
        material = new MeshDefaultMaterial({
          colorNode: mix(color(accent), color(RADIOACTIVE_PALETTE.foliageDark), 0.5) as any,
          hasLightBounce: true,
        });
      } else if (kind === 'panel') {
        // Human technology: white/cold blue with a faint cold emissive lift (plan §1 palette).
        material = new MeshDefaultMaterial({
          colorNode: color(accent),
          glowNode: color('#7fd8ff').mul(0.18) as any,
          hasLightBounce: false,
        });
      } else {
        // Rocks keep the shipped muted family with a whisper of albedo breakup (plan §62).
        const variation = (texture(noises.perlin, (positionWorld as any).xz.mul(0.05)).r as any).mul(0.18).add(0.91);
        material = new MeshDefaultMaterial({
          colorNode: color(accent ?? RADIOACTIVE_PALETTE.rock).mul(variation) as any,
          hasLightBounce: true,
        });
      }
      materials.set(key, material);
      return material;
    };

    const push = (kind: PropKind, accent: string, bloom: BloomTier, matrix: THREE.Matrix4): void => {
      const key = `${kind}|${accent}|${bloom}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          kind,
          geometry: geometryFor(kind),
          material: materialFor(kind, accent, bloom),
          matrices: [],
          castShadow: kind === 'crystal' || kind === 'spire' || kind === 'bone',
          receiveShadow: true,
        };
        buckets.set(key, bucket);
      }
      bucket.matrices.push(matrix);
    };

    // ---- per-landmark compositions (plan §16/§29): deterministic from the planet seed
    for (const landmark of landmarks) {
      const random = Landmarks.landmarkRandom(generator.seed, landmark);
      const spread = Math.max(6, landmark.radius * generator.radius * 1.6);
      for (const spec of compositionFor(landmark.type)) {
        const count = spec.min + Math.floor(random() * (spec.max - spec.min + 1));
        for (let i = 0; i < count; i++) {
          if (!this.sampleSite(landmark, random, spread, spawnClear)) continue;
          const scale = spec.scaleMin + random() * (spec.scaleMax - spec.scaleMin);
          const yaw = random() * Math.PI * 2;
          const sink = spec.hover ? -spec.hover : scale * 0.12;
          this.alignObject(this.sample, yaw, scale, sink);
          this.dummy.updateMatrix();
          const accent = spec.accent ?? Landmarks.accentHex(landmark);
          push(spec.kind, accent, spec.bloom ?? 'medium', this.dummy.matrix.clone());
          // Grounded props with real bulk become colliders; hovering debris never does (it is
          // metres above the surface the player walks on).
          if (obstacles && scale >= 2 && !spec.hover) {
            obstacles.add({ position: this.sample.point } as unknown as Placement, scale * 0.45, scale * 0.9, false);
          }
        }
      }
    }

    // ---- the campus: instanced buckets (one geometry + one material + N instances)
    let props = 0;
    for (const bucket of buckets.values()) {
      if (bucket.matrices.length === 0) continue;
      const mesh = new THREE.InstancedMesh(bucket.geometry, bucket.material, bucket.matrices.length);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.castShadow = bucket.castShadow;
      mesh.receiveShadow = bucket.receiveShadow;
      mesh.frustumCulled = false;
      for (let i = 0; i < bucket.matrices.length; i++) mesh.setMatrixAt(i, bucket.matrices[i]);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.name = `landmark_${bucket.kind}`;
      this.group.add(mesh);
      props += bucket.matrices.length;
    }
    this.propCount = props;

    // ---- the HERO landmark (plan §18): ONE major formation, visible from distance, that the
    // player can navigate by. It reuses the same geometry/material language — only bigger.
    const hero = Landmarks.pickHero(landmarks);
    this.heroLabel = hero ? `${hero.type} #${hero.id}` : '';
    if (hero) {
      const random = Landmarks.landmarkRandom(generator.seed ^ 0x5eed, hero);
      if (this.sampleSite(hero, random, Math.max(5, hero.radius * generator.radius * 0.6), spawnClear)) {
        this.buildHero(hero, random, obstacles);
      }
    }
  }

  /** Deterministic per-landmark RNG — the same landmark always grows the same composition. */
  private static landmarkRandom(seed: number, landmark: Landmark): () => number {
    return mulberry32((seed ^ Math.imul(landmark.id + 1, 2654435761) ^ landmark.color) >>> 0);
  }

  private static accentHex(landmark: Landmark): string {
    return `#${landmark.color.toString(16).padStart(6, '0')}`;
  }

  /** Highest-strength landmark, tie-broken toward the arena-facing first site (plan §18/§63). */
  private static pickHero(landmarks: readonly Landmark[]): Landmark | null {
    if (landmarks.length === 0) return null;
    let hero = landmarks[0];
    for (const landmark of landmarks) {
      const dominance = landmark.strength + (landmark.id === 0 ? 0.18 : 0);
      const best = hero.strength + (hero.id === 0 ? 0.18 : 0);
      if (dominance > best) hero = landmark;
    }
    return hero;
  }

  /**
   * Samples a legal site inside a landmark's footprint (plan §28): above water, not absurdly
   * steep, outside the spawn clearing. Returns false when the draw misses.
   */
  private sampleSite(
    landmark: Landmark,
    random: () => number,
    spreadMetres: number,
    spawnClear?: { direction: THREE.Vector3; radius: number },
  ): boolean {
    const offset = spreadMetres / this.surface.radius;
    const direction = this.scratchDirection
      .copy(landmark.dir)
      .add(new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(offset * 2))
      .normalize();
    if (spawnClear && direction.dot(spawnClear.direction) > Math.cos(spawnClear.radius / this.surface.radius)) {
      return false;
    }
    this.surface.sample(direction, this.sample);
    if (this.sample.height - (this.surface.waterLevel - this.surface.radius) < 0.2) return false;
    if (this.sample.slope > 0.72) return false;
    return true;
  }

  /**
   * Terrain alignment with the plan §28 blend: `alignment` of the surface normal + the rest
   * world-up, then a yaw around the up axis. `sink` (negative = hover) offsets along the up.
   */
  private alignObject(sample: SurfaceSample, yaw: number, scale: number, sink: number): void {
    this.dummy.position.copy(sample.point).addScaledVector(sample.up, -sink);
    this.dummy.scale.setScalar(scale);
    this.upQuaternion.setFromUnitVectors(WORLD_UP, sample.up);
    this.normalQuaternion.setFromUnitVectors(WORLD_UP, sample.normal).slerp(this.upQuaternion, 1 - TERRAIN_ALIGNMENT);
    this.yawQuaternion.setFromAxisAngle(sample.up, yaw);
    this.dummy.quaternion.copy(this.yawQuaternion).multiply(this.normalQuaternion);
  }

  /**
   * The ONE major formation (plan §18): a giant shard cluster + energy beam (crystal worlds), a
   * ruined colony tower (tech), or a twisted monolith (everything else). Non-instanced so the
   * selective outline (plan §59) can wrap its silhouette.
   */
  private buildHero(landmark: Landmark, random: () => number, obstacles?: PlanetObstacles): void {
    const family = heroFamily(landmark.type);
    const accent = Landmarks.accentHex(landmark);
    const yaw = random() * Math.PI * 2;
    const heroRoot = new THREE.Group();
    this.alignObject(this.sample, yaw, 1, 0);
    heroRoot.position.copy(this.dummy.position);
    heroRoot.quaternion.copy(this.dummy.quaternion);
    heroRoot.name = 'landmarkHero';

    if (family === 'crystal') {
      const height = 34 + random() * 18;
      const shard = new THREE.Mesh(heroCrystalGeometry(), createEmissiveMaterial({
        color: accent,
        edgeColor: '#e9ffd9',
        intensity: ART_DIRECTION.radiation.intensity,
        bloom: 'high',
        facet: true,
        gradient: 'uv',
        time: this.timeUniform,
      }));
      shard.scale.set(4.2, height, 4.2);
      shard.castShadow = true;
      shard.name = 'landmarkHeroCrystal';
      heroRoot.add(shard);
      for (let i = 0; i < 2; i++) {
        const satellite = new THREE.Mesh(heroCrystalGeometry(), shard.material);
        satellite.scale.set(2.2 - i * 0.5, height * (0.45 - i * 0.12), 2.2 - i * 0.5);
        satellite.position.set(Math.cos(i * 2.4) * 6, 0, Math.sin(i * 2.4) * 6);
        satellite.rotation.set(0.18 - i * 0.3, i * 1.7, 0.12);
        satellite.castShadow = true;
        heroRoot.add(satellite);
      }
      // Energy beam (plan §33 language, one draw, emissive only — never a real light).
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.9, 1.6, height * 1.6, 8, 1, true),
        createEmissiveMaterial({
          color: accent,
          edgeColor: '#0a1a1c',
          intensity: ART_DIRECTION.radiation.intensity,
          bloom: 'medium',
          gradient: 'uv',
        }),
      );
      beam.position.y = height * 0.8;
      beam.name = 'landmarkHeroBeam';
      heroRoot.add(beam);
      attachOutline(shard, ART_DIRECTION.outlines.distance * 2.2);
    } else if (family === 'tech') {
      // Ruined colony tower (plan §18): stacked, slightly rotated slabs in the human-technology
      // palette, with a cold emissive mast. MeshDefaultMaterial keeps it inside the shared
      // lighting/fog language (a standard PBR material would need its own lights).
      const material = new MeshDefaultMaterial({
        colorNode: color('#d6e2ea'),
        glowNode: color('#7fd8ff').mul(0.12) as any,
        hasLightBounce: false,
      });
      const segments = 5;
      let y = 0;
      let width = 9;
      let silhouette: THREE.Mesh | null = null;
      for (let i = 0; i < segments; i++) {
        const segment = new THREE.Mesh(new THREE.BoxGeometry(width, 8 + random() * 3, width * 0.7), material);
        segment.position.y = y + 4;
        segment.rotation.y = (random() - 0.5) * 0.5;
        segment.castShadow = true;
        heroRoot.add(segment);
        silhouette = segment;
        y += 8 + random() * 3;
        width *= 0.82;
      }
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.6, 16, 6),
        createEmissiveMaterial({ color: '#d8f2ff', intensity: 2, bloom: 'low' }),
      );
      mast.position.y = y + 8;
      heroRoot.add(mast);
      if (silhouette) attachOutline(silhouette, ART_DIRECTION.outlines.distance * 2.4);
    } else {
      const monolith = new THREE.Mesh(heroMonolithGeometry(this.generator.seed), createEmissiveMaterial({
        color: '#2a2330',
        edgeColor: accent,
        intensity: 1.1,
        bloom: 'low',
        gradient: 'y',
      }));
      monolith.scale.set(7 + random() * 3, 26 + random() * 14, 6 + random() * 3);
      monolith.castShadow = true;
      monolith.name = 'landmarkHeroMonolith';
      heroRoot.add(monolith);
      attachOutline(monolith, ART_DIRECTION.outlines.distance * 2.6);
    }

    this.group.add(heroRoot);
    obstacles?.add({ position: this.sample.point } as unknown as Placement, 6, 20, false);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    // geometries + materials are owned by this system (buckets share them), so release the
    // unique set once; the PlanetRoot traversal is the safety net for anything missed.
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.group.traverse((object: any) => {
      if (object.isMesh || object.isInstancedMesh) {
        if (object.geometry) geometries.add(object.geometry);
        if (object.material) materials.add(object.material);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.group.clear();
  }

  // ---------------------------------------------------------------- shared geometry library

  private static createGeometry(kind: PropKind, seed: number): THREE.BufferGeometry {
    switch (kind) {
      case 'crystal':
        return crystalGeometry(seed, 0.5, 1.9);
      case 'shard':
        return crystalGeometry(seed ^ 0x71, 0.22, 1);
      case 'spire': {
        const geometry = new THREE.ConeGeometry(0.5, 1, 6, 3);
        jitterRadial(geometry, seed, 0.35);
        geometry.translate(0, 0.5, 0);
        return geometry;
      }
      case 'bone': {
        const geometry = new THREE.ConeGeometry(0.24, 1, 5, 2);
        jitterRadial(geometry, seed ^ 0x31, 0.2);
        geometry.translate(0, 0.5, 0);
        return geometry;
      }
      case 'stalk': {
        const geometry = new THREE.CylinderGeometry(0.09, 0.16, 1, 6, 2);
        jitterRadial(geometry, seed ^ 0x55, 0.12);
        geometry.translate(0, 0.5, 0);
        return geometry;
      }
      case 'cap': {
        const geometry = new THREE.SphereGeometry(0.6, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.55);
        geometry.scale(1, 0.55, 1);
        geometry.translate(0, 1, 0);
        return geometry;
      }
      case 'panel':
        return new THREE.BoxGeometry(1, 1.5, 0.22);
      default: {
        const geometry = new THREE.IcosahedronGeometry(0.5, 1);
        jitterRadial(geometry, seed ^ 0x99, 0.55, 0.72);
        return geometry;
      }
    }
  }
}

/** Crystals/shard geometry: an elongated octahedron, tip up, base at y = 0. */
function crystalGeometry(seed: number, radius: number, height: number): THREE.BufferGeometry {
  const geometry = new THREE.OctahedronGeometry(radius, 0);
  geometry.scale(0.5, height, 0.5);
  jitterRadial(geometry, seed, 0.18);
  // The octahedron spans ±height·radius after the scale; lift it so the BASE sits on y = 0
  // (every instance is then anchored by its own ground contact, plan §28).
  geometry.translate(0, height * radius, 0);
  return geometry;
}

/** Hero shard: a longer, cleaner crystal (its own geometry so the hull outline fits it). */
function heroCrystalGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.OctahedronGeometry(0.5, 0);
  geometry.scale(0.5, 1, 0.5);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

/** Hero monolith: a chunky jittered prism. */
function heroMonolithGeometry(seed: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(0.5, 0.62, 1, 7, 3);
  jitterRadial(geometry, seed ^ 0xbeef, 0.22);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

/** Deterministic radial jitter — the plan §29 "imperfection from the planet seed". */
function jitterRadial(geometry: THREE.BufferGeometry, seed: number, amount: number, flatten = 1): void {
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const array = position.array as Float32Array;
  for (let i = 0; i < array.length; i += 3) {
    const x = array[i];
    const y = array[i + 1];
    const z = array[i + 2];
    const hash = mulberry32(
      seed ^
        Math.imul(Math.round(x * 997) | 0, 374761393) ^
        Math.imul(Math.round(y * 997) | 0, 668265263) ^
        Math.imul(Math.round(z * 997) | 0, 1442695041),
    )();
    const scale = 1 + (hash - 0.5) * amount;
    array[i] = x * scale;
    array[i + 1] = y * (flatten === 1 ? scale : 1 + (hash - 0.5) * amount * flatten);
    array[i + 2] = z * scale;
  }
  geometry.computeVertexNormals();
}

/** Which hero formation a landmark type gets (plan §18 examples). */
function heroFamily(type: LandmarkType): 'crystal' | 'tech' | 'monolith' {
  switch (type) {
    case 'CRYSTAL_CANYON':
    case 'CORRUPTED_PEAK':
    case 'TOXIC_LAKE':
    case 'NECROTIC_CRATER':
    case 'NECROPHAGE_NEST':
      return 'crystal';
    case 'COLONY_WRECK':
      return 'tech';
    default:
      return 'monolith';
  }
}
