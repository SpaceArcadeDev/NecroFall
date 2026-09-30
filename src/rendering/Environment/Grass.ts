/**
 * NECROFALL — spherical GPU grass (folio `World/Grass.js` architecture,
 * plan §14–§18/§68–§70).
 *
 * Folio's design is kept 1:1: ONE geometry, `subdivisions²` blades of three
 * vertices, blade shape + wind + camera-facing rotation entirely in the vertex
 * shader, density straight from the terrain data. The ONLY adaptation is the
 * coordinate frame — the flat X/Z field becomes a TANGENT PATCH on the sphere:
 *
 *   blade patch offset (x, z) → direction = normalize(centreDir + T·x + B·z)
 *
 * The frame re-bases onto the player as they walk (every blade is re-projected
 * EXACTLY, so the world stays pinned — no sliding), the wrap recycles blades
 * around the moving centre, and the rim fades to zero size so every recycle
 * happens invisibly (plan §68/§39).
 */
import * as THREE from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  color,
  float,
  Fn,
  max,
  mix,
  mod,
  normalize,
  positionWorld,
  select,
  smoothstep,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vertexIndex,
} from 'three/tsl';
import type { PlanetSurface } from '../../planet/PlanetSurface';
import type { Quality } from '../Quality';
import type { Ticker } from '../Ticker';
import type { TerrainNodeBundle } from './PlanetTerrainNodes';
import type { Wind } from './Wind';
import type { Noises } from './Noises';
import type { BasinSite, Puddles } from './Puddles';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';

export class Grass {
  readonly mesh: THREE.Mesh;

  private geometry: THREE.BufferGeometry;
  private material: MeshDefaultMaterial;

  private readonly uCenterDir = uniform(vec3(0, 1, 0));
  private readonly uTangent = uniform(vec3(1, 0, 0));
  private readonly uBitangent = uniform(vec3(0, 0, 1));
  private readonly uCenter2 = uniform(vec2(0, 0));
  private readonly uSize = uniform(80);
  private readonly uBladeWidth = uniform(0.075);
  private readonly uBladeHeight = uniform(0.5);
  private readonly uBladeRandomness = uniform(0.6);
  /** Wind sway amount — the lawn visibly ripples (raised per feedback). */
  private readonly uSwayStrength = uniform(2.5);
  /** 0 in the air, 1 on the ground — the player only parts grass at ground level. */
  private readonly uGrassPush = uniform(1);
  /** Player world position (planet space) — the parting is centred EXACTLY here. */
  private readonly uPushCenter = uniform(new THREE.Vector3(1, 0, 0));
  /** Smoothed run factor (0 idle → 1 sprint) — scales the directional trail. */
  private readonly uTrail = uniform(0);
  /** Smoothed motion direction (world, horizontal) — the trail sweeps this way. */
  private readonly uPlayerDir = uniform(new THREE.Vector3(0, 0, 1));

  private subdivisions: number;
  private halfExtent: number;

  /** Live water-suppression slots: up to 6 basins that can overlap the field. */
  private readonly waterSlots = Array.from({ length: 6 }, () => ({
    dir: uniform(new THREE.Vector3(0, 1, 0)),
    cos: uniform(new THREE.Vector2(2.0, 2.0001)), // (outer, inner) — inactive
  }));

  // CPU frame state (mirrors the three frame uniforms)
  private readonly frameDir = new THREE.Vector3(0, 1, 0);
  private readonly frameT = new THREE.Vector3(1, 0, 0);
  private readonly frameB = new THREE.Vector3(0, 0, 1);
  private readonly scratchDir = new THREE.Vector3();
  private readonly scratchOffset = new THREE.Vector3();
  private readonly scratchVelocity = new THREE.Vector3();
  private readonly prevFocus = new THREE.Vector3();
  private trailReady = false;

  constructor(
    private readonly surface: PlanetSurface,
    private readonly nodes: TerrainNodeBundle,
    private quality: Quality,
    private readonly wind: Wind,
    private readonly noises: Noises,
    private readonly ticker: Ticker,
    initialDirection: THREE.Vector3,
    private readonly water?: Puddles,
  ) {
    this.subdivisions = quality.grassSubdivisions();
    this.halfExtent = quality.grassHalfExtent();
    this.uSize.value = this.halfExtent * 2;

    // Anchor the patch frame at the SPAWN before any data exists — the first
    // update must be a near-identity re-base, never a far-side projection.
    this.frameDir.copy(initialDirection).normalize();
    this.stableTangent(this.frameDir, this.frameT);
    this.frameB.crossVectors(this.frameDir, this.frameT);
    this.uCenterDir.value.copy(this.frameDir);
    this.uTangent.value.copy(this.frameT);
    this.uBitangent.value.copy(this.frameB);

    this.geometry = this.createGeometry(this.subdivisions, this.halfExtent);
    this.material = this.createMaterial();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'grass';

    ticker.on(11, () => this.update());

    quality.events.on('change', () => {
      const subs = this.quality.grassSubdivisions();
      const half = this.quality.grassHalfExtent();
      if (subs !== this.subdivisions || half !== this.halfExtent) {
        this.subdivisions = subs;
        this.halfExtent = half;
        this.uSize.value = half * 2;
        this.geometry.dispose();
        this.geometry = this.createGeometry(subs, half);
        this.mesh.geometry = this.geometry;
      }
      this.updateScale();
    });
    this.updateScale();
  }

  private updateScale(): void {
    // folio's surfaceOverflow ratio — bigger fields hold slightly larger blades
    // (clamped: the extended field must not grow reeds)
    const surface = Math.pow(this.halfExtent * 2, 2);
    const overflow = Math.min(1.1, Math.max(0, surface - 2000) / 2000);
    this.uBladeWidth.value = 0.045 * (1 + overflow * 0.28);
    this.uBladeHeight.value = 0.55 * (1 + overflow * 0.28);
  }

  /** CPU side: `subdivisions²` blades, 3 vertices each — the ONLY data (plan §14). */
  private createGeometry(subdivisions: number, halfExtent: number): THREE.BufferGeometry {
    const count = subdivisions * subdivisions;
    const half = halfExtent;

    // ---- distribution: dense core + steep power-law falloff. The core fraction
    // is shared with the shader's rim fade so size and density taper TOGETHER:
    // a blade appearing at the field boundary (world-anchored recycling) is a
    // couple of pixels tall — there is no visible pop while walking.
    const denseRadius = half * DENSE_FRACTION;
    const falloff = 5;

    const offsets = new Float32Array(count * 3 * 2);
    const positions = new Float32Array(count * 3 * 3);
    const randomness = new Float32Array(count * 3);

    // deterministic scatter (same field every run)
    let seed = 0x9e3779b9;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    let v = 0;
    for (let i = 0; i < count; i++) {
      // uniform-area disc sample, rejection-shaped into the core profile
      let x = 0;
      let z = 0;
      for (let guard = 0; guard < 128; guard++) {
        const ux = random() * 2 - 1;
        const uz = random() * 2 - 1;
        const u = ux * ux + uz * uz;
        if (u > 1 || u < 1e-8) continue;
        const r = Math.sqrt(u) * half;
        if (r > denseRadius && random() > Math.pow(denseRadius / r, falloff)) continue;
        const stretch = r / Math.sqrt(u);
        x = ux * stretch;
        z = uz * stretch;
        break;
      }

      for (let corner = 0; corner < 3; corner++) {
        const index = v++;
        offsets[index * 2] = x;
        offsets[index * 2 + 1] = z;
        // a valid vec3 position so the pipeline stays happy — replaced in the shader
        positions[index * 3] = x;
        positions[index * 3 + 1] = 0;
        positions[index * 3 + 2] = z;
        randomness[index] = random();
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('bladeOffset', new THREE.BufferAttribute(offsets, 2));
    geometry.setAttribute('bladeRandom', new THREE.BufferAttribute(randomness, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), half * 1.6);
    return geometry;
  }

  private createMaterial(): MeshDefaultMaterial {
    const surface = this.surface;
    const nodes = this.nodes;
    const wind = this.wind;
    const inverseRadius = 1 / surface.radius;

    const vertexLoop = vertexIndex.toFloat().mod(3);
    const isTip = vertexLoop.lessThan(0.5);
    // base vertices: vertex 1 = -width (screen-left), vertex 2 = +width
    // (screen-right) — CCW as seen from the camera so the FRONT face is lit.
    const isRightBase = vertexLoop.greaterThan(1.5);
    // Fragment-side tipness as a VARYING (folio's trick): the vertex index
    // interpolates 0→1→2 across the blade, giving a smooth tip→base gradient
    // for the colour ramp and the root shadow.
    const tipness = varying(vertexLoop.oneMinus().clamp(0, 1));
    // per-blade brightness variation (the reference world's tufts are not uniform)
    const bladeTint = varying(attribute('bladeRandom') as any);

    const material = new MeshDefaultMaterial({
      // folio's visible vertical gradient: dark root → bright tip, all in the
      // terrain's own colour under this blade
      colorNode: (() => {
        const base = nodes.colorNode(nodes.terrainNode(positionWorld));
        const ramp = mix(base.mul(0.62), base.mul(1.2), tipness);
        return ramp.mul((bladeTint as any).mul(0.28).add(0.88));
      })(),
      normalNode: normalize(positionWorld) as any,
      // safety net for degenerate winding at grazing angles
      side: THREE.DoubleSide,
      hasWater: false,
      hasLightBounce: false,
      shadowNode: (() => {
        // root shadow like folio: the base of every blade sits in shade
        const terrainData = nodes.terrainNode(positionWorld);
        return tipness.oneMinus().mul(terrainData.y.mul(0.55)) as any;
      })(),
    });

    material.positionNode = Fn(() => {
      const offset = attribute('bladeOffset') as any; // vec2 patch coords
      const randomVertex = attribute('bladeRandom') as any;

      // ---- wrap around the moving centre (folio's infinite scroll, sphere edition)
      const halfSize = this.uSize.mul(0.5);
      const loopX = mod(offset.x.sub(this.uCenter2.x).add(halfSize), this.uSize).sub(halfSize).add(this.uCenter2.x);
      const loopZ = mod(offset.y.sub(this.uCenter2.y).add(halfSize), this.uSize).sub(halfSize).add(this.uCenter2.y);
      const patch = vec2(loopX, loopZ);

      // ---- rim fade — recycling happens at zero size (no popping, no hard edge).
      // Fade starts where the CPU density falloff starts (DENSE_FRACTION),
      // ending far out; appearing blades are sub-pixel there.
      const rimDistance = patch.sub(this.uCenter2).length().div(halfSize);
      const rimFade = smoothstep(DENSE_FRACTION, 1.0, rimDistance).oneMinus();

      // ---- sphere mapping: patch coords (metres) → direction on the planet.
      // Gnomonic scale: a patch offset of x metres is x/R in centre-dir units.
      const patchScaled = patch.mul(inverseRadius);
      const direction: any = normalize(
        this.uCenterDir.add(this.uTangent.mul(patchScaled.x)).add(this.uBitangent.mul(patchScaled.y)) as any,
      );

      // ---- terrain data at the blade's own location (the ONE source, plan §17)
      const terrainData = nodes.terrainNode(direction);
      const grass = terrainData.y;
      // soft gate: thin the lawn gradually instead of punching holes — tuned
      // to the terrain's own grass colouring so green ground is ALWAYS grassed
      const density = smoothstep(0.08, 0.24, grass).mul(rimFade).mul(this.waterSuppression(direction).oneMinus());

      // ---- surface position
      const surfaceRadius = nodes.heightMeters(terrainData.x).add(float(surface.radius));
      const basePosition = direction.mul(surfaceRadius);

      // ---- tangent frame at the blade
      const up = vec3(0, 1, 0);
      const reference: any = select(direction.y.abs().lessThan(0.95), up, vec3(1, 0, 0));
      const tangent: any = normalize(reference.cross(direction));
      const bitangent: any = direction.cross(tangent);

      // ---- blade shape (folio: tip / left / right)
      const bladeWidth = this.uBladeWidth.mul(density);
      const bladeHeight = this.uBladeHeight
        .mul(this.uBladeRandomness.mul(randomVertex).add(this.uBladeRandomness.oneMinus()))
        .mul(texture(this.noises.perlin, patch.mul(0.0321)).r.add(0.5))
        .mul(density);

      const sideX = select(isRightBase, bladeWidth, bladeWidth.negate()) as any;
      const shapeX = isTip.select(float(0), sideX);
      const shapeUp = isTip.select(bladeHeight, float(0));

      // ---- camera-facing rotation in the tangent plane: the blade's WIDTH axis
      // must be PERPENDICULAR to the view direction so the quad faces the eye
      const toCamera = cameraPosition.sub(basePosition);
      const sideAxis = bitangent
        .mul(toCamera.dot(tangent))
        .sub(tangent.mul(toCamera.dot(bitangent)))
        .add(bitangent.mul(0.0001));
      const facing = normalize(sideAxis as any);

      // ---- wind (ONE field for the whole world — plan §18)
      const windOffset = wind.offsetNode(patch) as any;
      const tipness = isTip.select(float(1), float(0));
      const sway = windOffset.mul(tipness).mul(shapeUp).mul(this.uSwayStrength);

      // ---- the player PARTS the grass: a standing clearing under the feet PLUS
      // a DIRECTIONAL trail — blades lean along the motion in a swept streak
      // behind the player and relax back the moment the run slows (when the
      // player stops, only the grass below them is moved, the trail vanishes).
      const toPlayerWorld = basePosition.sub(this.uPushCenter);
      const horizontal = toPlayerWorld.sub(direction.mul((toPlayerWorld as any).dot(direction)));
      const playerDistance = (horizontal as any).length();
      const pushInfluence = smoothstep(1.25, 0.15, playerDistance);
      const pushDir = normalize(horizontal as any);
      const clearingBend = pushDir.mul(pushInfluence.mul(0.55));

      const behind = (horizontal as any).dot(this.uPlayerDir); // + = ahead of motion
      const lateralVec = horizontal.sub(this.uPlayerDir.mul(behind));
      const lateralDistance = (lateralVec as any).length();
      const trailLength = this.uTrail.mul(5.2).add(0.9);
      const behindMask = smoothstep(trailLength.add(0.6), trailLength.sub(0.2), behind.negate());
      const frontMask = smoothstep(0.85, 0.15, behind);
      const lateralMask = smoothstep(1.25, 0.6, lateralDistance);
      const trailInfluence = max(behindMask, frontMask).mul(lateralMask).mul(this.uTrail);
      const lateralDir = normalize(lateralVec.add(vec3(0.0001, 0.0001, 0.0001)) as any);
      const trailBend = this.uPlayerDir
        .mul(trailInfluence.mul(0.5))
        .add(lateralDir.mul(trailInfluence.mul(0.22)));

      const pushBend = clearingBend.add(trailBend).mul(tipness).mul(this.uGrassPush);

      const vertexPosition = basePosition
        .add(facing.mul(shapeX))
        .add(direction.mul(shapeUp))
        .add(facing.mul(sway.x))
        .add(bitangent.mul(sway.y))
        .add(pushBend);

      return vertexPosition;
    })() as any;

    return material;
  }

  /**
   * Blades collapse to zero size inside nearby water basins (1 = suppressed).
   * Six angular slots — the update() finds the closest basins whose footprint
   * can touch the field, so no texture bake or per-basin loop is needed.
   */
  private waterSuppression(directionNode: any): any {
    let suppression: any = null;
    for (const slot of this.waterSlots) {
      const dot = directionNode.dot(slot.dir);
      const inside = smoothstep(slot.cos.x, slot.cos.y, dot);
      suppression = suppression ? max(suppression, inside) : inside;
    }
    return suppression ?? float(0);
  }

  /** Feed the up-to-6 basins that can overlap the grass field into the shader. */
  private updateWaterSlots(): void {
    const water = this.water;
    if (!water || water.sites.length === 0) return;
    const radius = this.surface.radius;
    const focus = this.scratchDir; // unit focus direction (set in update())

    const candidates: { dot: number; site: BasinSite }[] = [];
    for (const site of water.sites) {
      const dot = focus.dot(site.direction);
      const reach = Math.min(Math.PI, (site.radius + this.halfExtent + 2) / radius);
      if (dot < Math.cos(reach)) continue;
      candidates.push({ dot, site });
    }
    candidates.sort((a, b) => b.dot - a.dot);

    for (let i = 0; i < this.waterSlots.length; i++) {
      const slot = this.waterSlots[i];
      const candidate = candidates[i];
      if (candidate) {
        const dir = candidate.site.direction;
        slot.dir.value.set(dir.x, dir.y, dir.z);
        slot.cos.value.set(candidate.site.shoreCos, candidate.site.waterCos);
      } else {
        slot.cos.value.set(2.0, 2.0001); // inactive
      }
    }
  }

  /** Called every frame from the environment tick — the field follows the player (plan §39/§68). */
  update(focusPlanetPosition?: THREE.Vector3): void {
    const focus = focusPlanetPosition ?? this.lastFocus;
    if (!focus) return;
    this.lastFocus = focus;
    this.scratchDir.copy(focus).normalize();

    // Re-base the frame when the player walks away from its centre — every
    // blade is re-projected EXACTLY so the world stays pinned (no sliding).
    const alignment = this.scratchDir.dot(this.frameDir);
    if (alignment < 0.99) {
      this.rebase(this.scratchDir);
    }

    // The player's own patch coordinates drive the wrap.
    const patchCoords = this.patchCoordsOf(this.scratchDir, this.scratchOffset);
    this.uCenter2.value.set(patchCoords.x, patchCoords.y);

    // Parting centre = the player's exact world position.
    this.uPushCenter.value.copy(focus);

    // Directional trail: smoothed run factor + motion direction. Ramps in fast
    // when running, relaxes slower on release — no trail survives a stop.
    if (this.trailReady) {
      const dt = Math.max(0.001, this.ticker.delta);
      this.scratchVelocity.subVectors(focus, this.prevFocus).divideScalar(dt);
      this.scratchVelocity.addScaledVector(this.scratchDir, -this.scratchVelocity.dot(this.scratchDir));
      const speed = this.scratchVelocity.length();
      const target = Math.min(1, speed / 7);
      const rate = target > this.uTrail.value ? 14 : 5;
      this.uTrail.value += (target - this.uTrail.value) * (1 - Math.exp(-dt * rate));
      if (speed > 0.4) {
        const blend = 1 - Math.exp(-dt * 10);
        const d = this.uPlayerDir.value;
        d.set(
          d.x + (this.scratchVelocity.x / speed - d.x) * blend,
          d.y + (this.scratchVelocity.y / speed - d.y) * blend,
          d.z + (this.scratchVelocity.z / speed - d.z) * blend,
        ).normalize();
      }
    }
    this.prevFocus.copy(focus);
    this.trailReady = true;

    // Keep the water-suppression slots pointed at the basins near the field.
    this.updateWaterSlots();

    // Parting only happens at ground level — the lawn is untouched mid-air.
    const height = Math.max(0, focus.length() - this.surface.radiusAt(this.scratchDir));
    this.uGrassPush.value = 1 - smoothstepCpu01(0.35, 1.1, height);
  }

  private lastFocus: THREE.Vector3 | null = null;

  /** Exact gnomonic projection of a direction into the CURRENT frame (metres). */
  private patchCoordsOf(direction: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const denom = Math.max(0.2, direction.dot(this.frameDir));
    out.copy(direction).divideScalar(denom).sub(this.frameDir).multiplyScalar(this.surface.radius);
    return out;
  }

  private rebase(newDir: THREE.Vector3): void {
    const newT = new THREE.Vector3();
    const newB = new THREE.Vector3();
    this.stableTangent(newDir, newT);
    newB.crossVectors(newDir, newT);

    // Re-project every blade: world direction stays identical, coordinates change.
    const offsets = this.geometry.getAttribute('bladeOffset') as THREE.BufferAttribute;
    const array = offsets.array as Float32Array;
    const world = new THREE.Vector3();
    const local = new THREE.Vector3();

    for (let i = 0; i < array.length; i += 2) {
      world
        .copy(this.frameDir)
        .addScaledVector(this.frameT, array[i] * (1 / this.surface.radius))
        .addScaledVector(this.frameB, array[i + 1] * (1 / this.surface.radius))
        .normalize();
      const denom = world.dot(newDir);
      if (denom < 0.25) continue; // unreachable in normal operation — never explode an offset
      local.copy(world).divideScalar(denom).sub(newDir);
      array[i] = local.dot(newT) * this.surface.radius;
      array[i + 1] = local.dot(newB) * this.surface.radius;
    }
    offsets.needsUpdate = true;

    this.frameDir.copy(newDir);
    this.frameT.copy(newT);
    this.frameB.copy(newB);
    this.uCenterDir.value.set(newDir.x, newDir.y, newDir.z);
    this.uTangent.value.set(newT.x, newT.y, newT.z);
    this.uBitangent.value.set(newB.x, newB.y, newB.z);
  }

  /** Pole-safe tangent (plan §70). */
  private stableTangent(normal: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const reference = Math.abs(normal.y) < 0.95 ? UP : SIDE;
    return out.crossVectors(reference, normal).normalize();
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  get bladeCount(): number {
    return this.subdivisions * this.subdivisions;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);

/** Field fraction that keeps full density; the rest tapers (CPU + shader share it). */
const DENSE_FRACTION = 0.34;

/** CPU smoothstep (matches the shader semantics). */
function smoothstepCpu01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
