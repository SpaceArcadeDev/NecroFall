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
  cross,
  float,
  Fn,
  Loop,
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

  /** Trample-trail data texture (xyz = world pos, w = drop time). */
  private readonly trailTexture: THREE.DataTexture;
  private readonly trailData: Float32Array;
  private readonly lastTrailPoint = new THREE.Vector3();
  private trailCursor = 0;
  private trailStarted = false;

  constructor(
    private readonly surface: PlanetSurface,
    private readonly nodes: TerrainNodeBundle,
    private quality: Quality,
    private readonly wind: Wind,
    private readonly noises: Noises,
    private readonly ticker: Ticker,
    initialDirection: THREE.Vector3,
    private readonly water: Puddles | undefined,
    private readonly uTime: any,
  ) {
    this.subdivisions = quality.grassSubdivisions();
    this.halfExtent = quality.grassHalfExtent();
    this.uSize.value = this.halfExtent * 2;

    // ---- trample-trail buffer (blades stay parted where the player walked)
    this.trailData = new Float32Array(TRAIL_SLOTS * 4);
    for (let i = 0; i < TRAIL_SLOTS; i++) this.trailData[i * 4 + 3] = -1e3; // “long dead”
    this.trailTexture = new THREE.DataTexture(this.trailData, TRAIL_SLOTS, 1, THREE.RGBAFormat, THREE.FloatType);
    this.trailTexture.minFilter = THREE.NearestFilter;
    this.trailTexture.magFilter = THREE.NearestFilter;
    this.trailTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.trailTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.trailTexture.generateMipmaps = false;
    this.trailTexture.needsUpdate = true;

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
    // NO received dynamic shadows on blades: razor-thin triangles are the worst
    // case for shadow-map bias — the acne flips lit/dark patches ON the blades
    // as the shadow-follow camera moves with the player (the 'lighting angle
    // suddenly changes' flicker at distance). The root-shade gradient + the
    // terrain's own shadows underneath keep the grounded look.
    this.mesh.receiveShadow = false;
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
    // (clamped). Proportions matched to folio's actual uniform values:
    // blades are CHUNKY — ~0.19 m wide, ~0.78 m tall — so they overlap into
    // a continuous lawn instead of reading as separate slivers.
    const surface = Math.pow(this.halfExtent * 2, 2);
    const overflow = Math.min(1.1, Math.max(0, surface - 2000) / 2000);
    this.uBladeWidth.value = 0.085 * (1 + overflow * 0.28);
    this.uBladeHeight.value = 0.58 * (1 + overflow * 0.28);
  }

  /** CPU side: `subdivisions²` blades, 3 vertices each — the ONLY data (plan §14). */
  private createGeometry(subdivisions: number, halfExtent: number): THREE.BufferGeometry {
    const count = subdivisions * subdivisions;
    const half = halfExtent;

    // ---- distribution: dense core + power-law falloff. The core fraction
    // is shared with the shader's rim fade so size and density taper TOGETHER:
    // a blade appearing at the field boundary (world-anchored recycling) is a
    // couple of pixels tall — there is no visible pop while walking.
    const denseRadius = half * DENSE_FRACTION;
    // Gentle falloff (2.5): grass stays plentiful well past the horizon instead
    // of collapsing into stubble a few metres out from the player.
    const falloff = 2.5;

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
        // root shadow like folio: the base of every blade sits in shade — this
        // is what visually "plants" the lawn and reads as contact shadow
        const terrainData = nodes.terrainNode(positionWorld);
        return tipness.oneMinus().mul(terrainData.y.mul(0.75)) as any;
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
      // Blades keep FULL SIZE through the density falloff and only shrink in the
      // last 18% of the field, so the mid-distance lawn never reads as stubble.
      const rimDistance = patch.sub(this.uCenter2).length().div(halfSize);
      const rimFade = smoothstep(0.82, 1.0, rimDistance).oneMinus();

      // ---- sphere mapping: patch coords (metres) → direction on the planet.
      // Gnomonic scale: a patch offset of x metres is x/R in centre-dir units.
      const patchScaled = patch.mul(inverseRadius);
      const direction: any = normalize(
        this.uCenterDir.add(this.uTangent.mul(patchScaled.x)).add(this.uBitangent.mul(patchScaled.y)) as any,
      );

      // ---- terrain data at the blade's own location (the ONE source, plan §17)
      const terrainData = nodes.terrainNode(direction);
      // PATCHES EVERYWHERE: the lawn is grouped purely by the planet-stable
      // patch noise (sampled on the blade's world direction — never frame-local
      // coords, which shift on re-base). The biome grass mask no longer
      // suppresses blades — ANY patch on the planet grows a full, tightly
      // packed clump exactly like the spawn area; only bare gaps stay empty.
      const patchNoise = texture(this.noises.perlin, direction.xz.mul(9.0)).r;
      const patchFactor = smoothstep(0.32, 0.52, patchNoise);
      const visibility = rimFade.mul(this.waterSuppression(direction).oneMinus());
      // Outside the patches a sparse baseline remains (small random tufts), so
      // bare zones still have some grass — but the dark soil shading in the
      // terrain keys on the patch CORE only (full-blade zone), so it can never
      // show through partial-size blades. Strong mid-band floor keeps the
      // clump edges packed too.
      const sizeScale = patchFactor.pow(0.6).mul(0.78).add(0.22).mul(visibility);

      // ---- surface position
      const surfaceRadius = nodes.heightMeters(terrainData.x).add(float(surface.radius));
      const basePosition = direction.mul(surfaceRadius);

      // ---- tangent frame at the blade
      const up = vec3(0, 1, 0);
      const reference: any = select(direction.y.abs().lessThan(0.95), up, vec3(1, 0, 0));
      const tangent: any = normalize(reference.cross(direction));
      const bitangent: any = direction.cross(tangent);

      // ---- blade shape (folio: tip / left / right)
      const bladeWidth = this.uBladeWidth.mul(sizeScale);
      const bladeHeight = this.uBladeHeight
        .mul(this.uBladeRandomness.mul(randomVertex).add(this.uBladeRandomness.oneMinus()))
        .mul(texture(this.noises.perlin, patch.mul(0.0321)).r.add(0.5))
        .mul(sizeScale);

      const sideX = select(isRightBase, bladeWidth, bladeWidth.negate()) as any;
      const shapeX = isTip.select(float(0), sideX);
      const shapeUp = isTip.select(bladeHeight, float(0));

      // ---- camera-facing rotation in the tangent plane: the blade's WIDTH axis
      // must be PERPENDICULAR to the view direction so the quad faces the eye.
      // FIXED: single continuous expression cross(surfaceNormal, toCamera) —
      // mathematically identical to the old B·(toCam·T) − T·(toCam·B) form but
      // with NO epsilon term. The old form normalized a near-zero vector inside
      // a thin degenerate band, so its sign FLIPPED there and individual blades
      // snapped to new orientations as the camera moved — the flickering /
      // 'lighting angle suddenly changes' wave. The cross only vanishes when
      // the camera looks exactly along a blade's radial, which the chase camera
      // never does.
      const toCamera = cameraPosition.sub(basePosition);
      const facing = normalize(cross(direction, toCamera as any) as any);

      // ---- wind (ONE field for the whole world — plan §18)
      const windOffset = wind.offsetNode(patch) as any;
      const tipness = isTip.select(float(1), float(0));
      const sway = windOffset.mul(tipness).mul(shapeUp).mul(this.uSwayStrength);

      // ---- the player PARTS the grass: blades within the walk radius bend
      // away from the player (tip vertices only), centred on their exact world
      // position. They spring straight back the moment the player has passed —
      // the INSTANT recovery reads as a natural walking trail, no lane.
      const toPlayerWorld = basePosition.sub(this.uPushCenter);
      const horizontal = toPlayerWorld.sub(direction.mul((toPlayerWorld as any).dot(direction)));
      const playerDistance = (horizontal as any).length();
      const pushInfluence = smoothstep(1.25, 0.15, playerDistance);
      const pushDir = normalize(horizontal as any);
      const clearingBend = pushDir.mul(pushInfluence.mul(0.55));
      // ---- TRAMPLE TRAIL: recent player positions linger, so blades stay
      // pushed along the walked path and spring back over ~1.7 s — the visible
      // trail behind a moving player. Standing still, only the clearing holds.
      const trailBend = (() => {
        const accumulated = vec3(0, 0, 0).toVar();
        Loop(TRAIL_SLOTS, ({ i }) => {
          const slotUv = vec2(float(i).add(0.5).mul(TRAIL_TEXEL), 0.5);
          const packed = texture(this.trailTexture as any, slotUv) as any;
          const age = this.uTime.sub(packed.w);
          const toTrail = basePosition.sub(packed.xyz);
          const horizontalTrail = toTrail.sub(direction.mul((toTrail as any).dot(direction)));
          const trailDistance = (horizontalTrail as any).length();
          // Ramp IN over 0.3 s as well as out: a sample landing must never
          // snap blades to a new angle — that was the moving flicker/pop.
          const influence = smoothstep(1.35, 0.3, trailDistance)
            .mul(smoothstep(1.6, 0.7, age))
            .mul(smoothstep(0.0, 0.3, age));
          accumulated.addAssign(
            normalize(horizontalTrail.add(vec3(0.0001, 0.0001, 0.0001)) as any).mul(influence),
          );
        });
        return accumulated.mul(0.38);
      })();

      const pushBend = clearingBend.add(trailBend).mul(tipness).mul(this.uGrassPush);

      const vertexPosition = basePosition
        .add(facing.mul(shapeX))
        .add(direction.mul(shapeUp))
        // Sway rides the blade's WORLD-STABLE tangent frame (a pure function of
        // the blade's own direction) — never the camera-facing axis. Displacing
        // along `facing` made every blade's wobble direction rotate with the
        // camera as the player moved: the whole carpet churned = flicker at
        // distance. World-anchored sway = folio's fixed-axis wind, no churn.
        .add(tangent.mul(sway.x))
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

    // Drop a trample-trail sample every TRAIL_DROP_STEP metres of travel.
    if (!this.trailStarted || this.lastTrailPoint.distanceTo(focus) > TRAIL_DROP_STEP) {
      const offset = (this.trailCursor % TRAIL_SLOTS) * 4;
      this.trailCursor++;
      this.trailData[offset] = focus.x;
      this.trailData[offset + 1] = focus.y;
      this.trailData[offset + 2] = focus.z;
      this.trailData[offset + 3] = this.uTime.value as number;
      this.trailTexture.needsUpdate = true;
      this.lastTrailPoint.copy(focus);
      this.trailStarted = true;
    }

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
    this.trailTexture.dispose();
  }

  get bladeCount(): number {
    return this.subdivisions * this.subdivisions;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);

/** Field fraction that keeps full density; the rest tapers (CPU + shader share it). */
const DENSE_FRACTION = 0.5;

/** Trample-trail ring buffer: recent player positions (xyz + drop time). */
const TRAIL_SLOTS = 18;
const TRAIL_TEXEL = 1 / TRAIL_SLOTS;
const TRAIL_DROP_STEP = 0.85; // metres between overlapping samples — one channel

/** CPU smoothstep (matches the shader semantics). */
function smoothstepCpu01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
