/**
 * NECROFALL — basin water (folio `World/WaterSurface.js` port, plan §26–§30).
 *
 * WATER FILLS BASINS, not circles: every patch is placed on an analytic
 * depression found by probing spokes around a candidate direction, filled to a
 * flat water level below the rim, and conformed to the terrain (flat inside
 * the basin, hugging the ground at the shore).
 *
 * LEVELS ARE RENDERED-RELATIVE: the terrain mesh interpolates between coarse
 * grid vertices, so a small dip is shallower on screen than analytically. The
 * fill level is clamped above the RENDERED floor (`RenderedTerrain`) and the
 * depth/shore values follow the visible mesh — the waterline always sits where
 * the camera's ground meets the water, never buried inside unseen geometry.
 *
 * The surface itself ports folio's technique 1:1 — the water is a BLURRED
 * SCREEN MIRROR (viewportSharedTexture + hashBlur) with white foam details
 * (shore line + wind ripple rings), blended in only where the ground sits
 * under the water level (deep → pure mirror, shore → foam).
 *
 * TRAIL RIPPLES: folio's Trails system feeds a position data-texture into the
 * shader — the same pattern drives the walking wake here. While the player
 * wades, a ripple centre is dropped into a 16-slot data texture every 0.45 m;
 * the shader expands each into a travelling foam ring (radius = age × speed,
 * width grows, fades with age and reach).
 */
import * as THREE from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  color,
  exp,
  float,
  Fn,
  Loop,
  max,
  min,
  mix,
  positionWorld,
  screenUV,
  sin,
  smoothstep,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
  viewportSharedTexture,
} from 'three/tsl';
import { PlanetSurface, createSurfaceSample } from '../../planet/PlanetSurface';
import type { PlanetGenerator } from '../../planet/PlanetGenerator';
import { createRenderedRadiusAt, createTerrainIndices, TERRAIN_RES_X, TERRAIN_RES_Y, type RenderedRadiusAt } from '../../planet/RenderedTerrain';
import type { Noises } from './Noises';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';

const THETA_SEGMENTS = 44;
const RING_SEGMENTS = 7;
const RIM_RADII = [2.8, 4.0, 5.6, 7.5, 10];
const SPOKES = 8;
const MIN_RIM_DROP = 0.12; // metres — the centre must sit this far below its rim
const TARGET_SITES = 180;
const MAX_ATTEMPTS = 14000;
export const MAX_WATER_DEPTH = 0.35;

/** Walking-wake ring buffer: ripple centres kept as one RGBA float row. */
const TRAIL_SLOTS = 16;
const TRAIL_TEXEL = 1 / TRAIL_SLOTS;
const TRAIL_STEP = 0.65;
const RIPPLE_SPEED = 2.1;
const RIPPLE_WIDTH = 0.075;

export interface BasinSite {
  direction: THREE.Vector3;
  /** Patch radius in metres (the probed rim radius). */
  radius: number;
  /** Water surface as a RADIUS from the planet centre (flat locally). */
  waterLevel: number;
  /** dot(direction, siteDirection) threshold that counts as “inside the basin”. */
  reachCos: number;
  /** cos angular radius of the water footprint (grass suppression core). */
  waterCos: number;
  /** cos angular radius + 1.5 m soft edge (grass suppression falloff). */
  shoreCos: number;
  seed: number;
}

export class Puddles {
  readonly mesh: THREE.Mesh;
  readonly count: number;
  readonly sites: BasinSite[];
  private readonly waveStrength = uniform(1);
  private readonly shoreStrength = uniform(1);

  /** Exact sampler of the RENDERED terrain mesh (see RenderedTerrain.ts). */
  private readonly renderedRadiusAt: RenderedRadiusAt;

  /** Walking wake: ripple centres (xyz + birth time) fed to the shader. */
  private readonly trailTexture: THREE.DataTexture;
  private readonly trailData: Float32Array;
  /** Per-walker wake bookkeeping (player id → last dropped ripple centre). */
  private readonly trailState = new Map<string, { last: THREE.Vector3; started: boolean }>();
  private readonly trailScratch = new THREE.Vector3();
  private trailCursor = 0;

  constructor(
    private readonly surface: PlanetSurface,
    private readonly generator: PlanetGenerator,
    private readonly noises: Noises,
    private readonly timeUniform: any,
    spawnClear?: { direction: THREE.Vector3; radius: number },
    private readonly blocked?: (positionX: number, positionY: number, positionZ: number, clearance?: number) => boolean,
  ) {
    this.renderedRadiusAt = createRenderedRadiusAt(generator);
    const sites = this.findBasins(spawnClear).filter(site => !blocked?.(site.direction.x, site.direction.y, site.direction.z, site.radius));
    this.sites = sites;
    this.count = sites.length;

    // ------------------------------------------------------------- trail buffer
    this.trailData = new Float32Array(TRAIL_SLOTS * 4);
    for (let i = 0; i < TRAIL_SLOTS; i++) this.trailData[i * 4 + 3] = -1e3; // “long dead”
    this.trailTexture = new THREE.DataTexture(this.trailData, TRAIL_SLOTS, 1, THREE.RGBAFormat, THREE.FloatType);
    this.trailTexture.minFilter = THREE.NearestFilter;
    this.trailTexture.magFilter = THREE.NearestFilter;
    this.trailTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.trailTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.trailTexture.generateMipmaps = false;
    this.trailTexture.needsUpdate = true;

    // ---------------------------------------------------------------- geometry
    const positions: number[] = [];
    const depths: number[] = [];
    const rings: number[] = [];
    const seeds: number[] = [];
    const indices: number[] = [];
    let vertexBase = 0;

    const tangent = new THREE.Vector3();
    const bitangent = new THREE.Vector3();
    const direction = new THREE.Vector3();

    for (const site of sites) {
      PlanetSurface.stableTangent(site.direction, tangent);
      bitangent.crossVectors(site.direction, tangent);
      const theta = Math.tan(site.radius / this.surface.radius);

      for (let ring = 0; ring <= RING_SEGMENTS; ring++) {
        const r = ring / RING_SEGMENTS;
        const radius = Math.max(0.02, r) * theta;
        for (let segment = 0; segment <= THETA_SEGMENTS; segment++) {
          const angle = (segment / THETA_SEGMENTS) * Math.PI * 2;
          direction
            .copy(site.direction)
            .addScaledVector(tangent, Math.cos(angle) * radius)
            .addScaledVector(bitangent, Math.sin(angle) * radius)
            .normalize();

          const renderedRadius = this.renderedRadiusAt(direction);
          const depth = Math.min(MAX_WATER_DEPTH, site.waterLevel - renderedRadius);
          // flat water inside the basin; over the outer band it slopes down to
          // hug the VISIBLE ground so the shoreline sits exactly where the
          // camera's terrain meets the water
          const edgeDrop = smoothstepCpu(0.82, 1.0, r);
          const conformRadius = renderedRadius + 0.035;
          const surfaceRadius = depth > 0.02
            ? (renderedRadius + depth) * (1 - edgeDrop) + conformRadius * edgeDrop
            : conformRadius;

          positions.push(direction.x * surfaceRadius, direction.y * surfaceRadius, direction.z * surfaceRadius);
          depths.push(depth);
          rings.push(r);
          seeds.push(site.seed);
        }
      }

      const stride = THETA_SEGMENTS + 1;
      for (let ring = 0; ring < RING_SEGMENTS; ring++) {
        for (let segment = 0; segment < THETA_SEGMENTS; segment++) {
          const a = vertexBase + ring * stride + segment;
          const b = a + 1;
          const c = a + stride;
          const d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }
      vertexBase += (RING_SEGMENTS + 1) * stride;
    }

    const networkBase = vertexBase;
    const networkVertices = new Int32Array(TERRAIN_RES_X * (TERRAIN_RES_Y + 1)).fill(-1);
    let riverVertices = 0, seaVertices = 0;
    for (let row = 0; row <= TERRAIN_RES_Y; row++) for (let column = 0; column < TERRAIN_RES_X; column++) {
      const vertical = Math.cos(row / TERRAIN_RES_Y * Math.PI), radial = Math.sqrt(Math.max(0, 1 - vertical * vertical));
      const angle = (column / TERRAIN_RES_X - 0.5) * Math.PI * 2;
      direction.set(radial * Math.cos(angle), vertical, radial * Math.sin(angle));
      if (blocked?.(direction.x, direction.y, direction.z)) continue;
      const floor = this.renderedRadiusAt(direction), depth = this.networkDepthAt(direction, floor);
      const surfaceRadius = floor + Math.max(0.035, depth);
      networkVertices[row * TERRAIN_RES_X + column] = positions.length / 3;
      positions.push(direction.x * surfaceRadius, direction.y * surfaceRadius, direction.z * surfaceRadius);
      depths.push(depth); rings.push(0); seeds.push(0);
      if (depth > 0.02) {
        if (floor < this.generator.terrain.seaLevel) seaVertices++;
        else riverVertices++;
      }
    }
    const networkIndices = createTerrainIndices(TERRAIN_RES_X, TERRAIN_RES_Y);
    for (let triangle = 0; triangle < networkIndices.length; triangle += 3) {
      const first = networkVertices[networkIndices[triangle]], second = networkVertices[networkIndices[triangle + 1]], third = networkVertices[networkIndices[triangle + 2]];
      if (first >= 0 && second >= 0 && third >= 0 && Math.max(depths[first], depths[second], depths[third]) > -0.06) indices.push(first, second, third);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(depths), 1));
    geometry.setAttribute('aRing', new THREE.BufferAttribute(new Float32Array(rings), 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(seeds), 1));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    // ---------------------------------------------------------------- folio water
    const depth: any = varying(attribute('aDepth') as any);
    const ring: any = varying(attribute('aRing') as any);
    const seed: any = varying(attribute('aSeed') as any);
    void seed;

    // walking wake: expand every trail slot into a travelling ring (folio's
    // Trails pattern — a position data-texture sampled by the shader)
    const wake = Fn(() => {
      const total = float(0).toVar();
      Loop(TRAIL_SLOTS, ({ i }) => {
        const slotUv = vec2(float(i).add(0.5).mul(TRAIL_TEXEL), 0.5);
        const packed = texture(this.trailTexture as any, slotUv) as any;
        const toPoint = positionWorld.sub(packed.xyz);
        const distance = (toPoint as any).length();
        const age = this.timeUniform.sub(packed.w);

        const radius = age.mul(RIPPLE_SPEED);
        const width = age.mul(0.025).add(RIPPLE_WIDTH);
        const delta = distance.sub(radius);
        const band = exp(delta.mul(delta).div(width.mul(width)).negate());

        const fresh = smoothstep(0.0, 0.08, age).mul(smoothstep(0.8, 2.1, age).oneMinus());
        const reach = smoothstep(0.9, 2.6, distance).oneMinus();
        total.assign(max(total, band.mul(fresh).mul(reach)));
      });
      return min(total, 1.0) as any;
    })();

    // natural foam only — a FAINT waterline tint and barely-there wind bands.
    // (On gentle terrain a depth band spans many metres, so the only reliable
    // way to keep shores clean is low intensity.) The walking wake stays crisp.
    const waveDirectionA = vec3(0.82, 0.31, 0.48), waveDirectionB = vec3(-0.28, 0.87, 0.41);
    const phaseA = positionWorld.dot(waveDirectionA).mul(2.2).sub(timeUniform.mul(0.3));
    const phaseB = positionWorld.dot(waveDirectionB).mul(3.7).sub(timeUniform.mul(0.22));
    const slope = waveDirectionA.mul(phaseA.cos().mul(0.065)).add(waveDirectionB.mul(phaseB.cos().mul(0.035)));
    const up = positionWorld.normalize();
    const waveNormal = up.sub(slope.sub(up.mul(slope.dot(up)))).normalize();
    const viewDirection = cameraPosition.sub(positionWorld).normalize();
    const fresnel = waveNormal.dot(viewDirection).abs().oneMinus().pow(4);
    const alongCrest = positionWorld.dot(waveDirectionB).mul(1.25).add(phaseA.mul(0.5).sin().mul(1.4));
    const waveDetail = smoothstep(0.91, 0.99, phaseA.sin())
      .mul(smoothstep(0.15, 0.65, alongCrest.sin())).mul(smoothstep(0.035, 0.16, depth))
      .mul(0.48).mul(this.waveStrength);
    const shoreline = smoothstep(0.008, 0.07, depth).oneMinus()
      .mul(smoothstep(-0.035, 0.008, depth)).mul(0.8).mul(this.shoreStrength);
    const detailsMask = max(shoreline, waveDetail);
    const liquid = generator.archetype.art!.waterSurface === 'liquid';
    const waterColor = new THREE.Color(generator.archetype.art!.water);
    if (liquid) waterColor.lerp(new THREE.Color('#249fc4'), 0.6);

    const material = new MeshDefaultMaterial({
      // folio: the detail pass is the foam — soft seafoam, never milk-white
      colorNode: liquid ? color(waterColor) : mix(color(waterColor), color(generator.archetype.art!.horizon), 0.16),
      normalNode: up,
      glowNode: generator.archetype.art!.waterSurface === 'lava' ? color(generator.archetype.art!.infection).mul(0.65) : undefined,
      alphaNode: detailsMask,
      alphaTest: 0,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
      hasCoreShadows: liquid,
      hasDropShadows: true,
      hasLightBounce: false,
      hasFog: true,
    });

    // folio's output override: the surface shows the BLURRED SCREEN behind it
    // (the mirror) with smoothly blended foam; the walking wake rides on top as
    // thin bright rings; dry pixels vanish entirely.
    const baseOutput = (material as any).outputNode as any;
    (material as any).outputNode = Fn(() => {
      if (generator.archetype.art!.waterSurface !== 'liquid') {
        const wet = smoothstep(-0.06, 0.02, depth).mul(smoothstep(0.84, 1.0, ring).oneMinus());
        return vec4(baseOutput.rgb, wet);
      }
      const distortion = vec2(phaseA.cos(), phaseB.cos()).mul(smoothstep(0.02, 0.18, depth)).mul(0.0008);
      const transmitted = viewportSharedTexture(screenUV.add(distortion));
      const luminance = vec3(0.2126, 0.7152, 0.0722);
      const illumination = baseOutput.rgb.dot(luminance).div(color(waterColor).rgb.dot(luminance)).clamp(0.035, 1.2);
      const waterTint = mix(baseOutput.rgb, color(waterColor).mul(illumination), 0.75);
      const foamColor = color('#e0f3ee').mul(illumination);
      // contaminated tint over the screen mirror (radioactive puddle water)
      const mirrored = mix(transmitted.rgb, waterTint, smoothstep(0, 0.3, depth).mul(0.25).add(0.55));
      const wet = smoothstep(-0.06, 0.02, depth).mul(smoothstep(0.84, 1.0, ring).oneMinus());
      // smooth foam compositing (a hard >0.5 cut turned every mask edge into a
      // solid white patch — the over-foamed shores)
      const reflected = mix(mirrored, waterTint.mul(1.15), fresnel.mul(0.28));
      const foamed = mix(reflected, foamColor, detailsMask);
      // walking wake: crisp rings on top of the water, not foam blobs
      const rgb = mix(foamed, foamColor, (wake as any).mul(0.68));
      return vec4(rgb, wet.mul(0.94));
    })();

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'puddles';
    this.mesh.userData.surface = generator.archetype.art!.waterSurface;
    this.mesh.userData.maxDepth = MAX_WATER_DEPTH;
    this.mesh.userData.palette = `#${waterColor.getHexString()}`;
    this.mesh.userData.riverVertices = riverVertices;
    this.mesh.userData.seaVertices = seaVertices;
    this.mesh.userData.networkVertexStart = networkBase;
  }

  /**
   * Analytic basin search: a candidate is a basin when EVERY spoke at a rim
   * radius sits at least MIN_RIM_DROP above the centre — i.e. the terrain
   * actually holds water there. Sites keep a minimum separation.
   */
  private findBasins(spawnClear?: { direction: THREE.Vector3; radius: number }): BasinSite[] {
    const sites: BasinSite[] = [];
    const random = this.generator.rand(88);
    const sample = createSurfaceSample();
    const direction = new THREE.Vector3();
    const probe = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const bitangent = new THREE.Vector3();

    for (let attempt = 0; attempt < MAX_ATTEMPTS && sites.length < TARGET_SITES; attempt++) {
      // deterministic direction
      const z = random() * 2 - 1;
      const a = random() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      direction.set(r * Math.cos(a), z, r * Math.sin(a));

      if (spawnClear && direction.dot(spawnClear.direction) > Math.cos(spawnClear.radius / this.surface.radius)) {
        continue;
      }

      this.surface.sample(direction, sample);
      if (sample.slope > 0.34) continue;
      if (sample.wetness < 0.22 && sample.radiation < 0.4) continue; // humid or contaminated ground only
      if (this.networkDepthAt(direction, this.renderedRadiusAt(direction)) > -0.12) continue;

      const centreRadius = sample.radius;
      let found: { radius: number; rimMin: number } | null = null;

      PlanetSurface.stableTangent(direction, tangent);
      bitangent.crossVectors(direction, tangent);

      for (const rimRadius of RIM_RADII) {
        const theta = rimRadius / this.surface.radius;
        let rimMin = Infinity;
        for (let s = 0; s < SPOKES; s++) {
          const angle = (s / SPOKES) * Math.PI * 2;
          probe
            .copy(direction)
            .addScaledVector(tangent, Math.cos(angle) * theta)
            .addScaledVector(bitangent, Math.sin(angle) * theta)
            .normalize();
          const height = this.generator.radiusAt(probe.x, probe.y, probe.z);
          if (height < rimMin) rimMin = height;
        }
        // keep growing: the LARGEST viable rim wins, so the pool fills the
        // whole depression instead of a film around its lowest point
        if (rimMin - centreRadius > MIN_RIM_DROP) {
          found = { radius: rimRadius, rimMin };
        }
      }
      if (!found) continue;

      // minimum separation
      let tooClose = false;
      for (const other of sites) {
        const separation = (found.radius + other.radius + 0.6) / this.surface.radius;
        if (other.direction.dot(direction) > Math.cos(separation)) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const drop = found.rimMin - centreRadius;
      // fill to 85% of the drop: a real pool, its waterline just below the
      // lowest rim point; never beneath the visible mesh floor
      const fill = Math.min(drop * 0.85, MAX_WATER_DEPTH);
      const renderedCentre = this.renderedRadiusAt(direction);
      const waterLevel = Math.min(renderedCentre + MAX_WATER_DEPTH, Math.max(centreRadius + Math.max(0.2, fill), renderedCentre + 0.15));
      sites.push({
        direction: direction.clone(),
        radius: found.radius,
        waterLevel,
        reachCos: Math.cos((found.radius * 1.25) / this.surface.radius),
        waterCos: Math.cos(found.radius / this.surface.radius),
        shoreCos: Math.cos((found.radius + 1.5) / this.surface.radius),
        seed: random(),
      });
    }

    // rebuild probe basis lazily inside the loop above (stable tangent per candidate)
    return sites;
  }

  /**
   * Signed water depth along a surface direction, measured against the RENDERED terrain (the
   * same sampler the water surface conforms to). Positive = below the water film. Returns
   * `-Infinity` when the direction is outside every basin's reach.
   *
   * The grass field uses this to SHRINK blades toward the visible shoreline and stop them at
   * the water (user ask): the old cull compared against the basin RIM radius (`shoreCos`), which
   * painted a bare circle metres larger than the puddle itself. Measuring the actual waterline
   * means the lawn now walks right down to the water and tapers out there.
   */
  private networkDepthAt(direction: THREE.Vector3, floor: number): number {
    const seaLevel = this.generator.terrain.seaLevel;
    if (floor < seaLevel) return Math.min(MAX_WATER_DEPTH, seaLevel - floor);
    const river = this.generator.terrain.riverTAt(direction.x, direction.y, direction.z);
    const streamDepth = Math.min((river - 0.72) * 0.85, (floor - seaLevel) * 0.5)
      - smoothstepCpu(seaLevel + 8, seaLevel + 18, floor);
    return Math.min(MAX_WATER_DEPTH, Math.max(seaLevel - floor, streamDepth));
  }

  waterDepthAt(direction: THREE.Vector3): number {
    if (this.blocked?.(direction.x, direction.y, direction.z)) return 0;
    const floor = this.renderedRadiusAt(direction);
    const networkDepth = this.networkDepthAt(direction, floor);
    let best: BasinSite | null = null;
    let bestDot = -2;
    for (const site of this.sites) {
      const dot =
        direction.x * site.direction.x + direction.y * site.direction.y + direction.z * site.direction.z;
      if (dot <= site.waterCos) continue;
      if (dot > bestDot) {
        bestDot = dot;
        best = site;
      }
    }
    if (!best) return networkDepth;
    const edge = Math.acos(Math.min(1, bestDot)) * this.surface.radius / best.radius;
    const basinDepth = Math.min(MAX_WATER_DEPTH, best.waterLevel - floor) * (1 - smoothstepCpu(0.82, 1, edge));
    return Math.max(networkDepth, basinDepth);
  }

  surfaceRadiusAt(direction: THREE.Vector3): number {
    return this.renderedRadiusAt(direction) + Math.max(0, this.waterDepthAt(direction));
  }

  /**
   * Walking wake: while a walker wades through a basin (feet under the water
   * level), drop a ripple centre every TRAIL_STEP metres; the shader expands
   * each slot into a travelling ring. The LOCAL player and every REMOTE player
   * share the ring (user ask 2026-10-03 — other survivors' water ripples were
   * invisible because only the local player ever fed it).
   */
  trackTrail(focusPoint: THREE.Vector3): void {
    this.trackTrailFor('local', focusPoint);
  }

  /** A remote player's proxy position — same wake rules as the local player. */
  trackWalkerTrail(id: string, point: THREE.Vector3): void {
    this.trackTrailFor(id, point);
  }

  private trackTrailFor(id: string, focusPoint: THREE.Vector3): void {
    if (this.generator.archetype.art!.waterSurface !== 'liquid') return;
    let state = this.trailState.get(id);
    if (!state) {
      if (this.trailState.size > 24) this.trailState.clear(); // stale seats fall away with the roster
      state = { last: new THREE.Vector3(), started: false };
      this.trailState.set(id, state);
    }
    const direction = this.trailScratch.copy(focusPoint).normalize();

    const playerRadius = focusPoint.length();
    const wadingDepth = this.waterDepthAt(direction);
    if (wadingDepth <= 0.045 || playerRadius > this.renderedRadiusAt(direction) + 0.75) {
      state.started = false;
      return;
    }

    const point = direction.multiplyScalar(this.surfaceRadiusAt(direction));
    if (state.started && state.last.distanceTo(point) < TRAIL_STEP) return;

    const offset = (this.trailCursor % TRAIL_SLOTS) * 4;
    this.trailCursor++;
    this.trailData[offset] = point.x;
    this.trailData[offset + 1] = point.y;
    this.trailData[offset + 2] = point.z;
    this.trailData[offset + 3] = this.timeUniform.value as number;
    this.trailTexture.needsUpdate = true;

    state.last.copy(point);
    state.started = true;
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.trailTexture.dispose();
  }
}

/** CPU smoothstep (matches the shader semantics). */
function smoothstepCpu(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
