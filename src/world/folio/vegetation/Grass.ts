// NECROFALL — Grass (plan §9, §10, §59, §60): Folio's grass architecture
// (folio-2025/sources/Game/World/Grass.js, MIT, Bruno Simon) adapted to the spherical planet,
// with NecroFall's grass zoning preserved.
//
// Folio's architecture, kept exactly:
//   • ONE geometry made of 3-vertex blades (tip + two base corners), no per-blade meshes;
//   • the blade SHAPE lives in the vertex shader (bladeShape uniform array + vertexIndex % 3);
//   • every blade rotates to face the camera;
//   • wind displacement in the vertex stage from the shared wind;
//   • colour straight out of the terrain palette so grass and ground read as one surface.
//
// Planet adaptations:
//   • blade bases carry their surface frame (position + terrain normal), so blades grow ALONG
//     the sphere's normal instead of world +Y (no floating, no clipping — plan §81);
//   • wind flows in the local TANGENT plane towards the shared wind direction;
//   • distance culling collapses blades far from the camera in the vertex shader (plan §88);
//   • placement is the deterministic zoning NecroFall already had: dense rings around the tower
//     zones grown once when the match is laid out, plus seeded wild meadows around the planet.
//
// Grass is ONE mesh and ONE draw call. Nothing about it updates on the CPU after it is built.
import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraPosition,
  cross,
  float,
  mix,
  normalize,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
  vertexIndex,
} from 'three/tsl';
import { clamp, Rand, tangentBasis } from '../../../utils/Utils';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { terrainAlbedoNode, TERRAIN_PALETTE } from '../terrain/NecroFallTerrainNode';
import { FOLIO } from '../FolioShaderGlobals';
import { packTerrainData } from '../terrain/NecroFallTerrainNode';
import type { TerrainSurface } from '../../TerrainSurface';

export interface GrassOptions {
  surface: TerrainSurface;
  seed: number;
  /** 0..1 blade-density multiplier (quality tier). */
  density: number;
  /** Metres beyond which blades are collapsed (plan §88: 40 m). */
  maxDistance: number;
  /** Tower zones: the dense rings. */
  towers: THREE.Vector3[];
  /** Seeded meadow patches (already computed by the caller). */
  meadows: THREE.Vector3[];
  moistureAt(x: number, y: number, z: number): number;
  corruptionAt(x: number, y: number, z: number): number;
  reliefMin: number;
  reliefMax: number;
  castShadows?: boolean;
}

/** Full-density blade budget (HIGH). Lower tiers scale it (plan §10). */
const BASE_BLADES = 26000;
/** Dense ring around each tower, in metres of arc. */
const TOWER_RING = 34;
/** Meadow patch size, in metres of arc. */
const MEADOW_RING = 26;

export class Grass {
  readonly mesh: THREE.Mesh;
  readonly material: MeshDefaultMaterial;
  /** LOD seam: max distance blades are drawn at (written by VegetationVisibility). */
  cullDistance!: { value: number };
  bladeCount = 0;

  private geometry: THREE.BufferGeometry | null = null;

  constructor(private readonly options: GrassOptions) {
    this.material = this.buildMaterial();
    this.rebuild(options.towers);

    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'folie-grass';
    this.mesh.frustumCulled = false; // instances span the planet; the shader culls by distance
    this.mesh.castShadow = options.castShadows ?? false;
    this.mesh.receiveShadow = true;
    this.applyGeometry(this.geometry!);
  }

  /** Grow the field: called once per match with the tower positions (plan §10 — never per frame). */
  rebuild(towers: THREE.Vector3[]): void {
    this.geometry?.dispose();
    this.geometry = this.buildGeometry(towers);
    if (this.mesh) this.applyGeometry(this.geometry);
  }

  private applyGeometry(geometry: THREE.BufferGeometry): void {
    this.mesh.geometry = geometry;
    this.mesh.count = this.bladeCount * 3;
  }

  // ------------------------------------------------------------------ placement (CPU, once)

  private buildGeometry(towers: THREE.Vector3[]): THREE.BufferGeometry {
    const surface = this.options.surface;
    const rand = new Rand((this.options.seed ^ 0x6a55) >>> 0);

    const budget = Math.round(BASE_BLADES * clamp(this.options.density, 0.05, 1.6));
    const zones: Array<{ dir: THREE.Vector3; ring: number; weight: number }> = [];
    for (const tower of towers) zones.push({ dir: tower.clone().normalize(), ring: TOWER_RING / surface.radius, weight: 2.2 });
    for (const meadow of this.options.meadows) zones.push({ dir: meadow.clone().normalize(), ring: MEADOW_RING / surface.radius, weight: 1 });
    if (zones.length === 0) return this.emptyGeometry();

    const totalWeight = zones.reduce((sum, z) => sum + z.weight, 0);

    const count = budget;
    const base = new Float32Array(count * 3 * 3);
    const up = new Float32Array(count * 3 * 3);
    const data = new Float32Array(count * 3 * 4);
    const veg = new Float32Array(count * 3);
    const randoms = new Float32Array(count * 3 * 2);
    const position = new Float32Array(count * 3 * 3); // three needs a `position` attribute

    const dir = new THREE.Vector3();
    const height01Span = Math.max(1e-3, this.options.reliefMax - this.options.reliefMin);

    let blade = 0;
    let guard = 0;
    while (blade < count && guard++ < count * 6) {
      // weighted zone pick
      let pick = rand.next() * totalWeight;
      let zone = zones[0];
      for (const z of zones) {
        pick -= z.weight;
        if (pick <= 0) {
          zone = z;
          break;
        }
      }

      // uniform point in the zone cap
      tangentBasis(zone.dir, _t1, _t2);
      const angle = rand.range(0, Math.PI * 2);
      const radius = Math.sqrt(rand.next()) * zone.ring;
      dir
        .copy(zone.dir)
        .multiplyScalar(Math.cos(radius))
        .addScaledVector(_t1, Math.cos(angle) * Math.sin(radius))
        .addScaledVector(_t2, Math.sin(angle) * Math.sin(radius))
        .normalize();

      const h = surface.heightAtDir(dir.x, dir.y, dir.z);
      const slope = surface.slopeAtDir(dir.x, dir.y, dir.z);
      const water = surface.waterAtDir(dir.x, dir.y, dir.z);
      if (water > 0.05) continue;
      if (slope > 0.5 && !rand.chance(0.25)) continue;

      surface.normalAtDir(dir.x, dir.y, dir.z, _normal);
      const surfacePos = _probe.copy(dir).multiplyScalar(h - 0.02);
      const height01 = clamp((h - this.options.reliefMin) / height01Span, 0, 1);
      const terrain = packTerrainData(
        slope,
        height01,
        this.options.moistureAt(dir.x, dir.y, dir.z),
        this.options.corruptionAt(dir.x, dir.y, dir.z),
      );
      const vegetation = surface.vegetationAtDir(dir.x, dir.y, dir.z);
      // Sparse ground still gets SOME grass; bare rock and corruption thin it.
      if (rand.next() > clamp(vegetation / 1.6 + 0.15, 0.05, 1)) continue;

      const heightRandom = rand.range(0.55, 1.25);
      const phase = rand.next();

      for (let v = 0; v < 3; v++) {
        const i = (blade * 3 + v) * 3;
        base[i] = surfacePos.x;
        base[i + 1] = surfacePos.y;
        base[i + 2] = surfacePos.z;
        position[i] = surfacePos.x;
        position[i + 1] = surfacePos.y;
        position[i + 2] = surfacePos.z;
        up[i] = _normal.x;
        up[i + 1] = _normal.y;
        up[i + 2] = _normal.z;

        const di = (blade * 3 + v) * 4;
        data[di] = terrain[0];
        data[di + 1] = terrain[1];
        data[di + 2] = terrain[2];
        data[di + 3] = terrain[3];

        veg[blade * 3 + v] = vegetation;

        const ri = (blade * 3 + v) * 2;
        randoms[ri] = heightRandom;
        randoms[ri + 1] = phase;
      }
      blade++;
    }

    this.bladeCount = blade;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position.subarray(0, blade * 9), 3));
    geometry.setAttribute('aBase', new THREE.BufferAttribute(base.subarray(0, blade * 9), 3));
    geometry.setAttribute('aUp', new THREE.BufferAttribute(up.subarray(0, blade * 9), 3));
    geometry.setAttribute('aTerrain', new THREE.BufferAttribute(data.subarray(0, blade * 12), 4));
    geometry.setAttribute('aVeg', new THREE.BufferAttribute(veg.subarray(0, blade * 3), 1));
    geometry.setAttribute('aRand', new THREE.BufferAttribute(randoms.subarray(0, blade * 6), 2));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), surface.radius * 2);
    return geometry;
  }

  private emptyGeometry(): THREE.BufferGeometry {
    this.bladeCount = 0;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    geometry.setAttribute('aBase', new THREE.BufferAttribute(new Float32Array(9), 3));
    geometry.setAttribute('aUp', new THREE.BufferAttribute(new Float32Array(9), 3));
    geometry.setAttribute('aTerrain', new THREE.BufferAttribute(new Float32Array(12), 4));
    geometry.setAttribute('aVeg', new THREE.BufferAttribute(new Float32Array(3), 1));
    geometry.setAttribute('aRand', new THREE.BufferAttribute(new Float32Array(6), 2));
    return geometry;
  }

  // ------------------------------------------------------------------ material (TSL)

  private buildMaterial(): MeshDefaultMaterial {
    const bladeWidth = uniform(0.085);
    const bladeHeight = uniform(0.72);
    this.cullDistance = uniform(this.options.maxDistance);
    const maxDistance = this.cullDistance as unknown as ReturnType<typeof uniform>;

    // Attribute nodes are created once and shared by both shader stages.
    const aBase = attribute('aBase', 'vec3') as any;
    const aUp = attribute('aUp', 'vec3') as any;
    const aTerrain = attribute('aTerrain', 'vec4') as any;
    const aVeg = (attribute('aVeg', 'float') as any).div(1.6);
    const aRand = attribute('aRand', 'vec2') as any;

    const bladeShape = uniformArray([
      0, 1, // tip
      1, 0, // left
      -1, 0, // right
    ]);

    const tipness = varying(vertexIndex.toFloat().mod(3).step(0.5).oneMinus());

    const material = new MeshDefaultMaterial({
      colorNode: Fn(() => {
        const baseColor = terrainAlbedoNode(aTerrain, TERRAIN_PALETTE.mid, aVeg);
        // Root → tip gradient keeps blades readable without a texture.
        return mix(baseColor.mul(0.7), baseColor.mul(1.18), tipness);
      })(),
      hasWater: false,
      hasLightBounce: false,
      alphaTest: 0,
      shadowSide: THREE.DoubleSide,
    });

    // --- vertex construction: Folio's blade shape, spherical frame, camera-facing, wind.
    material.positionNode = Fn(() => {
      const corner = vertexIndex.toFloat().mod(3);
      const isBase = corner.step(0.5); // 1 on the two base corners
      const shapeX = (bladeShape.element(corner.mul(2)) as any);
      const shapeY = (bladeShape.element(corner.mul(2).add(1)) as any);

      // Height: random per blade, thinned by rock/corruption through the baked attributes.
      const height = bladeHeight
        .mul(aRand.x)
        .mul(aVeg.mul(0.5).add(0.6))
        .mul(aTerrain.w.oneMinus().mul(0.4).add(0.6));

      // Camera-facing right vector in the blade's tangent plane.
      const toCamera = (cameraPosition as any).sub(aBase);
      const right = normalize(cross(aUp, toCamera));

      const width = bladeWidth.mul(isBase);

      let vertex: any = aBase.add(aUp.mul(shapeY.mul(height))).add(right.mul(shapeX.mul(width)));

      // Wind: flow along the surface tangent towards the shared wind direction.
      const windWorld = vec3(FOLIO.wind.direction.x, float(0), FOLIO.wind.direction.y);
      const windTangent = normalize(windWorld.sub(aUp.mul(windWorld.dot(aUp))).add(right.mul(1e-4)));
      const gust = FOLIO.wind.offset(aBase.xy).length().mul(0.5).add(FOLIO.wind.strength.mul(0.5));
      const sway = gust.mul(tipness).mul(height).mul(1.6);
      // A slow per-blade phase so the field ripples instead of moving as one sheet.
      const ripple = FOLIO.wind.localTime.mul(1.6).add(aRand.y.mul(6.2831)).sin().mul(0.35).add(0.65);
      vertex = vertex.add(windTangent.mul(sway).mul(ripple));

      // Distance culling: blades past the grass horizon are pushed off the planet entirely.
      const distance = aBase.sub(cameraPosition as any).length();
      const hidden = distance.step(maxDistance);
      vertex = vertex.add(aUp.mul(hidden.mul(9999)));

      return vertex;
    })();

    return material;
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _probe = new THREE.Vector3();
