// NECROFALL — CAVE COMPOSITIONS (complete visual + terrain + underground rework, §30/§35/§59).
//
// The visual layer that turns each carved cave footprint (CaveGenerator → TerrainGenerator) into
// a readable underground PLACE:
//
//   roof dome    a rock roof with a wedge MOUTH facing the approach azimuth — the cave entrance
//                (blocks the sun; its ring is collidable except at the mouth)
//   rim arches   broken cliff teeth + flanking pillars around the mouth, embedded deep
//   stalactites  hang from the analytic dome shell; stalagmites rise from the floor
//   crystals     emissive shard beds (per-cave-type palette; bloom tier medium)
//   glow fans    sci-fi vegetation / energy veins (plan §18, low bloom tier)
//   ruins        buried panel + beam compositions (ANCIENT_RUINS only)
//   motes        ONE additive Points cloud for every cave — GPU-side, one draw
//
// Everything is deterministic from the planet seed, terrain-aligned, and instanced: the whole
// layer is ~20 draw calls for six caves. `?caves=0` removes the props (the carve stays walkable).
import * as THREE from 'three/webgpu';
import { color } from 'three/tsl';
import { PlanetSurface, createSurfaceSample, type SurfaceSample } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import type { PlanetObstacles } from '../../planet/PlanetObstacles';
import type { Placement } from '../../planet/Placement';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { createEmissiveMaterial } from '../materials/EmissiveMaterial';
import { boulderGeometry, coneGeometry, domeGeometry, fanGeometry, panelGeometry, shardGeometry } from './PropGeometry';
import { mulberry32 } from '../../planet/PlanetSeed';
import { caveApproachAzimuth, caveChamberNode, type CaveType, type PlanetCave } from '../../world/caves/CaveGenerator';

/** Dark slate every cave rock prop shares — the crystal/glow palettes carry the identity. */
const CAVE_ROCK = '#262d33';
const CAVE_ROCK_DARK = '#181d22';

interface Bucket {
  /** Family id (also the material key). */
  key: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrices: THREE.Matrix4[];
  placements: Placement[];
  castsShadow: boolean;
  /** How placements register as obstacles (radius/height fractions of the placement scale). */
  obstacle?: { radius: number; height: number; steppable: boolean };
}

export class Caves {
  readonly group = new THREE.Group();
  readonly caveCount: number;
  readonly propCount: number;
  readonly moteCount: number;

  private readonly buckets: Bucket[] = [];
  private points: THREE.Points | null = null;

  constructor(
    private readonly surface: PlanetSurface,
    private readonly generator: PlanetGenerator,
    timeUniform: any,
    spawnClear?: { direction: THREE.Vector3; radius: number },
    obstacles?: PlanetObstacles,
  ) {
    const caves = generator.terrain.caves;
    this.caveCount = caves.length;
    const sample: SurfaceSample = {
      point: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      normal: new THREE.Vector3(0, 1, 0),
      radius: 0,
      height: 0,
      slope: 0,
      grass: 0,
      wetness: 0,
      radiation: 0,
      rock: 0,
      biomeWeight: 0,
    };
    const motePositions: number[] = [];
    const moteColors: number[] = [];

    const rockMaterial = new MeshDefaultMaterial({ colorNode: color(CAVE_ROCK), hasLightBounce: true, hasFog: true });
    (rockMaterial as any).flatShading = true;
    const rockDarkMaterial = new MeshDefaultMaterial({ colorNode: color(CAVE_ROCK_DARK), hasLightBounce: true, hasFog: true });
    (rockDarkMaterial as any).flatShading = true;
    // The roof dome is seen from both sides (outside rock, inside ceiling) — double-sided, a
    // touch darker than the rim rock so the interior reads as depth, not as a lit shell.
    const roofMaterial = new MeshDefaultMaterial({
      colorNode: color(CAVE_ROCK),
      side: THREE.DoubleSide,
      hasLightBounce: true,
      hasFog: true,
      hasCoreShadows: true,
    });
    (roofMaterial as any).flatShading = true;

    const rim = this.bucket('caveRim', boulderGeometry(0x1a11, 0.6), rockMaterial, true, { radius: 0.75, height: 1.5, steppable: true });
    const roof = this.bucket('caveRoof', domeGeometry(0x2b22), roofMaterial, true, { radius: 1, height: 1, steppable: false });
    const stalactites = this.bucket('caveStalactites', coneGeometry(0x3c33), rockDarkMaterial, false);
    const stalagmites = this.bucket('caveStalagmites', coneGeometry(0x4d44), rockDarkMaterial, false);
    const ruins = this.bucket('caveRuins', panelGeometry(0x5e55), rockDarkMaterial, false);

    /** Per-cave-type emissive buckets are created lazily — a planet only pays for what it has. */
    const crystalBuckets = new Map<CaveType, Bucket>();
    const glowBuckets = new Map<CaveType, Bucket>();
    const crystalMaterialFor = (cave: PlanetCave): Bucket => {
      let bucket = crystalBuckets.get(cave.type);
      if (!bucket) {
        const material = createEmissiveMaterial({
          color: hex(cave.palette.crystal),
          edgeColor: hex(cave.palette.crystalEdge),
          intensity: 2.6,
          bloom: 'medium',
          pulseSpeed: 1.1,
          pulseAmount: 0.18,
          facet: true,
          gradient: 'y',
          time: timeUniform,
        });
        bucket = this.bucket(`caveCrystal:${cave.type}`, shardGeometry(), material, false);
        crystalBuckets.set(cave.type, bucket);
      }
      return bucket;
    };
    const glowMaterialFor = (cave: PlanetCave): Bucket => {
      let bucket = glowBuckets.get(cave.type);
      if (!bucket) {
        const material = createEmissiveMaterial({
          color: hex(cave.palette.glow),
          edgeColor: hex(cave.palette.crystalEdge),
          intensity: 1.5,
          bloom: 'low',
          pulseSpeed: 0.8,
          pulseAmount: 0.3,
          facet: true,
          gradient: 'y',
          time: timeUniform,
        });
        bucket = this.bucket(`caveGlow:${cave.type}`, fanGeometry(), material, false);
        glowBuckets.set(cave.type, bucket);
      }
      return bucket;
    };

    const dummy = new THREE.Object3D();
    const alignQuat = new THREE.Quaternion();
    const yawQuat = new THREE.Quaternion();
    const flipQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    const worldUp = new THREE.Vector3(0, 1, 0);
    const dirScratch = new THREE.Vector3();
    const t1 = new THREE.Vector3();
    const t2 = new THREE.Vector3();
    /** Reusable sample for the cave centre (the floor the roof dome is planted on). */
    const centreSample = createSurfaceSample();
    const basis = new THREE.Matrix4();
    const roofQuat = new THREE.Quaternion();
    const hangQuat = new THREE.Quaternion();

    /** Direct matrix push for props anchored to analytic shells (roof stalactites). */
    const pushMatrix = (bucket: Bucket, position: THREE.Vector3, quat: THREE.Quaternion, scale: THREE.Vector3 | number): void => {
      dummy.position.copy(position);
      if (typeof scale === 'number') dummy.scale.setScalar(scale);
      else dummy.scale.copy(scale);
      dummy.quaternion.copy(quat);
      dummy.updateMatrix();
      bucket.matrices.push(dummy.matrix.clone());
    };

    /** A direction inside the footprint: `radial` 0 centre → 1 rim, `azimuth` radians. */
    const dirInFootprint = (cave: PlanetCave, radial: number, azimuth: number, out: THREE.Vector3): THREE.Vector3 => {
      PlanetSurface.stableTangent(cave.dir, t1);
      t2.crossVectors(cave.dir, t1).normalize();
      const a = Math.max(0, radial) * cave.radius;
      const sinA = Math.sin(a);
      return out
        .copy(cave.dir)
        .multiplyScalar(Math.cos(a))
        .addScaledVector(t1, sinA * Math.cos(azimuth))
        .addScaledVector(t2, sinA * Math.sin(azimuth))
        .normalize();
    };

    const pushProp = (
      bucket: Bucket,
      s: SurfaceSample,
      yaw: number,
      scale: THREE.Vector3 | number,
      sink: number,
      tiltX = 0,
      tiltZ = 0,
      lift = 0,
      pointDown = false,
      collide?: { radius: number; height: number; steppable: boolean },
    ): void => {
      dummy.position.copy(s.point).addScaledVector(s.up, lift - sink);
      if (typeof scale === 'number') dummy.scale.setScalar(scale);
      else dummy.scale.copy(scale);
      alignQuat.setFromUnitVectors(worldUp, s.up);
      yawQuat.setFromAxisAngle(s.up, yaw);
      dummy.quaternion.copy(yawQuat).multiply(alignQuat);
      if (tiltX !== 0) dummy.rotateX(tiltX);
      if (tiltZ !== 0) dummy.rotateZ(tiltZ);
      if (pointDown) dummy.quaternion.multiply(flipQuat);
      dummy.updateMatrix();
      bucket.matrices.push(dummy.matrix.clone());
      if (collide) {
        bucket.placements.push({
          matrix: dummy.matrix.clone(),
          position: s.point.clone(),
          normal: s.normal.clone(),
          scale: typeof scale === 'number' ? scale : Math.max(scale.x, scale.z),
          yaw,
          grass: s.grass,
          slope: s.slope,
          radiation: s.radiation,
          wetness: s.wetness,
          height: s.height,
        });
      }
    };

    for (const cave of caves) {
      const random = mulberry32(cave.seed ^ 0x51ed270b);
      const approach = caveApproachAzimuth(cave);
      random(); // keep the stream in step with the shared helper's single roll
      const crystalBucket = crystalMaterialFor(cave);
      const glowBucket = glowMaterialFor(cave);

      // ---- rim arches + the entrance arch (plan §30)
      const rimCount = cave.size === 'small' ? 7 : cave.size === 'medium' ? 9 : 12;
      for (let i = 0; i < rimCount; i++) {
        const azimuth = (i / rimCount) * Math.PI * 2 + random() * 0.4;
        // Keep the approach path clear (~±0.5 rad) so the descent is always walkable.
        const delta = Math.abs(((azimuth - approach + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (delta < 0.5) continue;
        const s = surface.sample(dirInFootprint(cave, 0.82 + random() * 0.24, azimuth, dirScratch), sample);
        if (spawnClear && s.point.distanceToSquared(spawnClear.direction.clone().multiplyScalar(this.surface.radius)) < spawnClear.radius * spawnClear.radius) continue;
        const scale = 1.8 + random() * 2.6;
        pushProp(rim, s, random() * Math.PI * 2, new THREE.Vector3(scale * (0.8 + random() * 0.5), scale, scale * (0.8 + random() * 0.5)), scale * 0.46, (random() - 0.5) * 0.7, (random() - 0.5) * 0.7);
      }
      // Entrance pillars — the ARCH itself is the dome mouth below, these flank it and are
      // embedded deep so they can never read as floating blocks.
      for (const side of [-1, 1]) {
        const s = surface.sample(dirInFootprint(cave, 1.02, approach + side * 0.16, dirScratch), sample);
        const scale = 2.6 + random() * 0.8;
        pushProp(rim, s, random() * 0.3, new THREE.Vector3(scale * 0.7, scale * 1.45, scale * 0.7), scale * 0.5, side * 0.1, 0);
      }

      // ---- THE CAVE MOUTH (user ask 2026-10-06): a rock roof dome with a wedge opening facing
      // the approach azimuth. The dome's equator ring sits at the carved floor, i.e. BELOW the
      // basin walls, so the terrain swallows it around the rim: the visible shape is a big rock
      // hill whose dark mouth you walk into. The roof blocks the sun (real overhang) and carries
      // the stalactites; the ring is collidable except at the mouth.
      const chamber = caveChamberNode(cave);
      const centre = centreSample;
      surface.sample(chamber.dir, centre);
      const upAxis = centre.up.clone();
      const ax = dirInFootprint(cave, 1.0, approach, dirScratch).clone();
      ax.addScaledVector(upAxis, -ax.dot(upAxis)).normalize();
      const az = new THREE.Vector3().crossVectors(upAxis, ax).normalize();
      const spread = cave.radius * this.surface.radius;
      const height = cave.depth + 5;
      // Local +X points AWAY from the mouth (the geometry's wedge faces local −X).
      const xAxis = ax.clone().negate();
      const zAxis = new THREE.Vector3().crossVectors(xAxis, upAxis).normalize();
      basis.makeBasis(xAxis, upAxis, zAxis);
      roofQuat.setFromRotationMatrix(basis);
      const roofPos = centre.point.clone();
      dummy.position.copy(roofPos);
      dummy.quaternion.copy(roofQuat);
      dummy.scale.set(spread, height, spread);
      dummy.updateMatrix();
      roof.matrices.push(dummy.matrix.clone());
      // Collision ring: blocking rock everywhere except the mouth sector.
      const ringCount = 14;
      for (let i = 0; i < ringCount; i++) {
        const a = (i / ringCount) * Math.PI * 2;
        const delta = Math.abs(((a - approach + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (delta < 0.8) continue;
        const dir = dirInFootprint(cave, 0.98, a, dirScratch);
        const ringSample = surface.sample(dir, sample);
        dummy.position.copy(ringSample.point);
        dummy.quaternion.identity();
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        roof.placements.push({
          matrix: dummy.matrix.clone(),
          position: ringSample.point.clone(),
          normal: ringSample.normal.clone(),
          scale: spread * 0.42,
          yaw: a,
          grass: ringSample.grass,
          slope: ringSample.slope,
          radiation: ringSample.radiation,
          wetness: ringSample.wetness,
          height: ringSample.height,
        });
      }
      // Stalactites hang from the roof's interior surface (never floating: each is anchored to
      // the analytic dome shell).
      const spikeCount = cave.size === 'small' ? 8 : cave.size === 'medium' ? 12 : 16;
      for (let i = 0; i < spikeCount; i++) {
        const r = 0.18 + random() * 0.62;
        const a = random() * Math.PI * 2;
        const delta = Math.abs(((a - approach + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (delta < 0.55) continue; // keep the mouth clear
        const shell = height * Math.sqrt(Math.max(0, 1 - r * r));
        const world = roofPos
          .clone()
          .addScaledVector(ax, Math.cos(a) * r * spread)
          .addScaledVector(az, Math.sin(a) * r * spread)
          .addScaledVector(upAxis, shell - 0.5);
        const length = 1.1 + random() * 2.4;
        hangQuat.setFromUnitVectors(worldUp, upAxis);
        hangQuat.multiply(flipQuat);
        pushMatrix(stalactites, world, hangQuat, new THREE.Vector3(0.3 + random() * 0.3, length, 0.3 + random() * 0.3));
      }

      // ---- stalagmites on the floor
      const stubCount = cave.size === 'small' ? 7 : cave.size === 'medium' ? 10 : 13;
      for (let i = 0; i < stubCount; i++) {
        const azimuth = random() * Math.PI * 2;
        const radial = 0.15 + random() * 0.62;
        const delta = Math.abs(((azimuth - approach + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (delta < 0.35 && radial > 0.5) continue; // keep the ramp path
        const s = surface.sample(dirInFootprint(cave, radial, azimuth, dirScratch), sample);
        const height = 0.5 + random() * 1.9;
        pushProp(stalagmites, s, random() * Math.PI * 2, new THREE.Vector3(0.3 + random() * 0.34, height, 0.3 + random() * 0.34), 0.1, (random() - 0.5) * 0.2, (random() - 0.5) * 0.2);
      }

      // ---- crystal beds (emissive, per-type palette) + glow fans / veins
      const crystalCount = cave.size === 'small' ? 8 : cave.size === 'medium' ? 12 : 18;
      for (let i = 0; i < crystalCount; i++) {
        const azimuth = random() * Math.PI * 2;
        const radial = random() < 0.62 ? 0.55 + random() * 0.45 : random() * 0.4;
        const s = surface.sample(dirInFootprint(cave, radial, azimuth, dirScratch), sample);
        const scale = 0.5 + random() * 1.3;
        pushProp(crystalBucket, s, random() * Math.PI * 2, new THREE.Vector3(scale * (0.5 + random() * 0.4), scale * (0.8 + random() * 0.9), scale * (0.5 + random() * 0.4)), scale * 0.2, (random() - 0.5) * 1.1, (random() - 0.5) * 1.1);
      }
      const glowCount = cave.size === 'small' ? 7 : cave.size === 'medium' ? 10 : 14;
      for (let i = 0; i < glowCount; i++) {
        const azimuth = random() * Math.PI * 2;
        const radial = 0.3 + random() * 0.66;
        const s = surface.sample(dirInFootprint(cave, radial, azimuth, dirScratch), sample);
        const scale = 0.5 + random() * 0.9;
        pushProp(glowBucket, s, random() * Math.PI * 2, new THREE.Vector3(scale * (0.7 + random() * 0.5), scale * (0.4 + random() * 0.8), scale * 0.35), 0, (random() - 0.5) * 0.9, (random() - 0.5) * 0.9);
      }

      // ---- ruins (ANCIENT_RUINS / NECROPHAGE_NEST read as burying something)
      if (cave.type === 'ANCIENT_RUINS' || cave.type === 'NECROPHAGE_NEST') {
        const ruinCount = cave.size === 'large' ? 9 : 5;
        for (let i = 0; i < ruinCount; i++) {
          const azimuth = random() * Math.PI * 2;
          const radial = 0.2 + random() * 0.6;
          const s = surface.sample(dirInFootprint(cave, radial, azimuth, dirScratch), sample);
          const scale = 1.4 + random() * 2.6;
          pushProp(ruins, s, random() * Math.PI * 2, new THREE.Vector3(scale * (0.8 + random() * 0.7), 0.22 + random() * 0.2, scale * 0.9), scale * 0.5, (random() - 0.5) * 0.3, (random() - 0.5) * 0.3);
        }
        // A leaning beam across the chamber — the "something crashed here" line.
        const s = surface.sample(dirInFootprint(cave, 0.35 + random() * 0.3, random() * Math.PI * 2, dirScratch), sample);
        const scale = cave.size === 'large' ? 7 : 4.5;
        pushProp(ruins, s, random() * Math.PI * 2, new THREE.Vector3(scale, 0.5, 0.8), 0, 0.3, 0.25, 1.2 + random() * 1.6);
      }

      // ---- motes: drift inside the chamber (plan §46 — one Points cloud, GPU-animated by the
      // vertex cloud's own slow shader-less motion is not needed: static motes + fog read fine).
      const moteCount = cave.size === 'small' ? 34 : cave.size === 'medium' ? 46 : 64;
      const glowColor = new THREE.Color(cave.palette.glow);
      for (let i = 0; i < moteCount; i++) {
        const s = surface.sample(dirInFootprint(cave, random() * 0.8, random() * Math.PI * 2, dirScratch), sample);
        const height = 0.4 + random() * (cave.depth * 0.5);
        motePositions.push(s.point.x + s.up.x * height, s.point.y + s.up.y * height, s.point.z + s.up.z * height);
        const tint = 0.6 + random() * 0.4;
        moteColors.push(glowColor.r * tint, glowColor.g * tint, glowColor.b * tint);
      }
    }

    // ---- commit the buckets
    for (const bucket of this.buckets) {
      if (bucket.matrices.length === 0) continue;
      const mesh = new THREE.InstancedMesh(bucket.geometry, bucket.material, bucket.matrices.length);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.castShadow = bucket.castsShadow;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      for (let i = 0; i < bucket.matrices.length; i++) mesh.setMatrixAt(i, bucket.matrices[i]);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.name = bucket.key;
      this.group.add(mesh);
      if (obstacles && bucket.obstacle) {
        const config = bucket.obstacle;
        for (const placement of bucket.placements) {
          obstacles.add(placement, config.radius * placement.scale, config.height * placement.scale, config.steppable);
        }
      }
    }

    // ---- the ONE mote cloud
    this.moteCount = motePositions.length / 3;
    if (motePositions.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(motePositions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(moteColors, 3));
      const material = new THREE.PointsMaterial({
        size: 0.17,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.points = new THREE.Points(geometry, material);
      this.points.frustumCulled = false;
      this.points.name = 'caveMotes';
      this.group.add(this.points);
    }

    this.propCount = this.buckets.reduce((total, bucket) => total + bucket.matrices.length, 0);
  }

  private bucket(
    key: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    castsShadow: boolean,
    obstacle?: { radius: number; height: number; steppable: boolean },
  ): Bucket {
    const bucket: Bucket = { key, geometry, material, matrices: [], placements: [], castsShadow, obstacle };
    this.buckets.push(bucket);
    return bucket;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.group.traverse((object: any) => {
      if (object.isInstancedMesh || object.isPoints) {
        object.geometry.dispose();
        (object.material as THREE.Material | undefined)?.dispose();
      }
    });
    this.group.removeFromParent();
  }
}

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}
