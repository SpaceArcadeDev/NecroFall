/**
 * NECROFALL — spherical GPU grass (folio `World/Grass.js` architecture,
 * plan §14–§18).
 *
 * Folio's design is kept 1:1: ONE geometry, `subdivisions²` blades of three
 * vertices, blade shape + wind + camera-facing rotation entirely in the vertex
 * shader, colour straight from the terrain data. The adaptation is the
 * coordinate frame — blades live ON the sphere:
 *
 *   one blade = one DIRECTION; its base is direction · surfaceRadius(direction)
 *
 * THE WHOLE PLANET IS PLANTED AT BUILD TIME (plan §17): every blade's direction, its
 * patch-mask acceptance, its water cull and its size factor are baked once from the
 * planet-stable fields (the same noise sample the terrain's grass shadow reads) — and
 * NOTHING about the field changes at runtime as the player walks. No moving frame, no
 * wrap, no rim, no per-proximity streaming: the only per-frame inputs are the player's
 * parting push and the shared wind.
 */
import * as THREE from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  cross,
  dot,
  float,
  Fn,
  If,
  Loop,
  mix,
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
import type { TerrainNodeBundle } from './PlanetTerrainNodes';
import type { Wind } from './Wind';
import type { Noises } from './Noises';
import type { Puddles } from './Puddles';
import { mulberry32 } from '../../planet/PlanetSeed';
import {
  GRASS_ACCEPTANCE_POWER,
  GRASS_PATCH_EDGE_LOW,
  GRASS_PATCH_UV_SCALE,
  grassCoverage,
} from './GrassField';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';

/** `setTimeout`-based yield between planting chunks — rAF can be throttled in a background
 *  tab, a timeout still runs, so the field always finishes planting. */
const nextLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * ONE degenerate blade (zero size — buried at the planet's centre) carrying the EXACT attributes
 * the real field uses. The grass material compiles against this from the first frame, so the
 * chunked planting pass can swap the real geometry in without ever compiling an invalid shader.
 */
function createPlaceholderBlade(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  // A tiny valid point (never the origin — the shader normalizes it; a zero vector is NaN).
  // `bladeField` 0 collapses the blade to zero size, so nothing is ever rasterized.
  const point = [0.01, 0.01, 0.01];
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...point, ...point, ...point]), 3));
  geometry.setAttribute('bladeRandom', new THREE.BufferAttribute(new Float32Array(3), 1));
  geometry.setAttribute('bladeField', new THREE.BufferAttribute(new Float32Array(3), 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  return geometry;
}

export class Grass {
  readonly mesh: THREE.Mesh;

  /** Completes when the planet-wide planting pass has swapped its geometry in (see `plant`). */
  readonly ready: Promise<void>;

  private geometry: THREE.BufferGeometry;
  private material: MeshDefaultMaterial;
  /** Serialises planting passes: a quality change waits for the pass before it. */
  private plantChain: Promise<void> = Promise.resolve();
  /** Only the NEWEST planting pass may swap its geometry in (a stale one is disposed). */
  private plantToken = 0;

  private readonly uBladeWidth = uniform(0.24);
  /** Tall meadow blades (user ask: "grass needs to be taller" — raised again to chest-high). */
  private readonly uBladeHeight = uniform(1.35);
  private readonly uBladeRandomness = uniform(0.6);
  /** Wind sway amount — the lawn visibly ripples (raised twice per feedback: "add more sway"). */
  private readonly uSwayStrength = uniform(3.6);
  /** 0 in the air, 1 on the ground — the player only parts grass at ground level. */
  private readonly uGrassPush = uniform(1);
  /** Player world position (planet space) — the parting is centred EXACTLY here. */
  private readonly uPushCenter = uniform(new THREE.Vector3(1, 0, 0));

  private subdivisions: number;
  /** Actually planted blades (acceptance can close the loop a hair early). */
  private bladeTotal = 0;

  /** Scratch for the ground-level test in update(). */
  private readonly scratchDir = new THREE.Vector3();

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
    private readonly water: Puddles | undefined,
    private readonly uTime: any,
  ) {
    this.subdivisions = quality.grassSubdivisions();

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

    // Plant ASYNCHRONOUSLY, in chunks (see `plant`): the field is ~700k blades and one
    // synchronous pass froze the whole page for seconds — exactly when a match starts
    // (or while the class picker pre-loads the planet in the background). Until the pass
    // swaps the real field in, the mesh shows ONE degenerate blade carrying the SAME geometry
    // attributes — the material's shader pipeline needs all of them from the first render
    // (a bare BufferGeometry made it compile `normalize(0.0)` and go invalid on WebGPU).
    this.geometry = createPlaceholderBlade();
    this.material = this.createMaterial();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    // NO received dynamic shadows on blades: razor-thin triangles are the worst
    // case for shadow-map bias — the acne flips lit/dark patches ON the blades
    // as the shadow-follow camera moves with the player (the 'lighting angle
    // suddenly changes' flicker at distance). The baked root shade + the
    // terrain's own grass shadow underneath keep the grounded look.
    this.mesh.receiveShadow = false;
    this.mesh.name = 'grass';

    // NOTE: no ticker subscription — the world orchestrator calls `update(focus)` once per
    // frame at its own stage (PlanetRenderer.update).
    this.ready = this.requestPlant(this.subdivisions);

    quality.events.on('change', () => {
      const subs = this.quality.grassSubdivisions();
      if (subs !== this.subdivisions) void this.requestPlant(subs);
    });
  }

  /** Queue a planting pass; passes are chained so two can never interleave blade tables. */
  private requestPlant(subdivisions: number): Promise<void> {
    this.subdivisions = subdivisions;
    this.plantChain = this.plantChain.then(() => this.plant(subdivisions));
    return this.plantChain;
  }

  private async plant(subdivisions: number): Promise<void> {
    const token = ++this.plantToken;
    const geometry = await this.createGeometry(subdivisions);
    if (token !== this.plantToken) {
      geometry.dispose(); // a newer pass (or disposal) won — never swap a stale field in
      return;
    }
    const previous = this.mesh.geometry;
    this.mesh.geometry = geometry;
    this.geometry = geometry;
    if (previous !== geometry) previous.dispose();
  }

  /** CPU side: `subdivisions²` blades, 3 vertices each — the ONLY data (plan §14).
   *  The scatter loop YIELDS to the event loop every ~128k attempts, so the caller's
   *  loading screen (or the class picker, for the background pre-build) stays alive. */
  private async createGeometry(subdivisions: number): Promise<THREE.BufferGeometry> {
    const target = subdivisions * subdivisions;
    const sites = this.water?.sites ?? [];
    const radius = this.surface.radius;

    // ---- placement: the WHOLE planet's surface, planted ONCE at build. A candidate direction
    // is ACCEPTED by the planet-stable patch field (GrassField.ts — the very same noise sample
    // the terrain's grass shadow reads), then culled by the water basins and given its baked
    // size. Nothing here is ever re-run while the player walks.
    const posX = new Float32Array(target);
    const posY = new Float32Array(target);
    const posZ = new Float32Array(target);
    const randoms = new Float32Array(target);
    const fields = new Float32Array(target);

    const random = mulberry32(0x9e3779b9);
    let accepted = 0;
    const maxTries = target * 8;
    for (let tries = 0; tries < maxTries && accepted < target; tries++) {
      // Let the page breathe between chunks — a single 700k-blade pass froze it for seconds.
      if ((tries & 0x1ffff) === 0x1ffff) await nextLoop();
      // uniform direction on the sphere (area-correct)
      const z = random() * 2 - 1;
      const angle = random() * Math.PI * 2;
      const ring = Math.sqrt(Math.max(0, 1 - z * z));
      const dx = ring * Math.cos(angle);
      const dy = z;
      const dz = ring * Math.sin(angle);

      // patch acceptance — PATCHES ONLY: outside the patch band there is no blade at all
      // (bare ground stays bare), and inside it the coverage^power curve packs blades
      // shoulder to shoulder while the rim fades in under a metre. The mask is the SMOOTH
      // low-frequency field, so patches are BIG fields, not a scatter of small clumps.
      const patch = this.noises.samplePatch(dx * GRASS_PATCH_UV_SCALE, dz * GRASS_PATCH_UV_SCALE);
      if (patch < GRASS_PATCH_EDGE_LOW) continue; // bare ground — ZERO blades
      const coverage = grassCoverage(patch);
      if (random() > Math.pow(coverage, GRASS_ACCEPTANCE_POWER)) continue;

      // water — baked here, so the runtime field owns no slots and nothing pops near basins
      let suppression = 0;
      for (let s = 0; s < sites.length; s++) {
        const site = sites[s];
        const dot = dx * site.direction.x + dy * site.direction.y + dz * site.direction.z;
        if (dot <= site.shoreCos) continue;
        const t = Math.min(1, (dot - site.shoreCos) / (site.waterCos - site.shoreCos));
        const inside = t * t * (3 - 2 * t);
        if (inside > suppression) suppression = inside;
      }
      const waterFactor = 1 - suppression;
      if (waterFactor <= 0.02) continue; // fully submerged — never spent a blade

      // world-stable size noise (baked at build — the shader owns no noise reads)
      const sizeNoise = this.noises.sample(dx * radius * 0.0321, dz * radius * 0.0321);
      // inside a clump the blades run at (near) full size — the taper lives only in the rim
      const field = (0.6 + 0.4 * coverage) * waterFactor * (0.72 + 0.55 * sizeNoise);
      if (field <= 0.01) continue;

      // bake the blade's SURFACE POSITION (direction · terrain radius): the vertex shader
      // then needs no terrain read at all — this is what pays for the density raise
      this.scratchDir.set(dx, dy, dz);
      const surfaceRadius = this.surface.radiusAt(this.scratchDir);
      posX[accepted] = dx * surfaceRadius;
      posY[accepted] = dy * surfaceRadius;
      posZ[accepted] = dz * surfaceRadius;
      randoms[accepted] = random();
      fields[accepted] = field;
      accepted++;
    }
    this.bladeTotal = accepted;

    // 3 vertices per blade — tip / left base / right base, all sharing the blade's data.
    const positions = new Float32Array(accepted * 3 * 3);
    const randomness = new Float32Array(accepted * 3);
    const fieldAttr = new Float32Array(accepted * 3);
    let v = 0;
    for (let i = 0; i < accepted; i++) {
      const px = posX[i];
      const py = posY[i];
      const pz = posZ[i];
      for (let corner = 0; corner < 3; corner++) {
        positions[v * 3] = px;
        positions[v * 3 + 1] = py;
        positions[v * 3 + 2] = pz;
        randomness[v] = randoms[i];
        fieldAttr[v] = fields[i];
        v++;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('bladeRandom', new THREE.BufferAttribute(randomness, 1));
    geometry.setAttribute('bladeField', new THREE.BufferAttribute(fieldAttr, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius + 90);
    return geometry;
  }

  private createMaterial(): MeshDefaultMaterial {
    const nodes = this.nodes;
    const wind = this.wind;

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
      // THE VISIBLE GRADIENT (user ask: "more vibrant and more visible gradient"): the root
      // sits in a deep grounded shade and the tip is a bright SATURATED pop, so the ramp
      // reads blade by blade instead of blending into the terrain colour under it.
      // Saturation > 1 is applied as colour × 1.32 − luma × 0.32 (the mix() identity).
      colorNode: (() => {
        const base = nodes.colorNode(nodes.terrainNode(positionWorld));
        const ramp: any = mix(base.mul(0.42), base.mul(1.55), tipness);
        const luma: any = dot(ramp, vec3(0.2126, 0.7152, 0.0722));
        const vivid: any = ramp.mul(1.32).sub(vec3(luma, luma, luma).mul(0.32));
        return vivid.mul((bladeTint as any).mul(0.3).add(0.87));
      })(),
      normalNode: normalize(positionWorld) as any,
      // safety net for degenerate winding at grazing angles
      side: THREE.DoubleSide,
      // blades always shade with the surface radial — flipping it for backfaces painted half the
      // field into core shadow (black clumps) whenever the camera crossed the blade plane
      flipBackfaceNormal: false,
      hasWater: false,
      hasLightBounce: false,
      shadowNode: (() => {
        // THE FIXED SHADOW UNDER EVERY BLADE: the base of each blade sits in its own constant
        // shade — planet-stable and NOT keyed to the biome mask (which left blades on desert
        // planets ungrounded) — so the lawn grounds itself wherever it grows.
        return tipness.oneMinus().pow(1.35).mul(0.8) as any;
      })(),
      // GLOWING TIPS (user ask: "at dark parts of the map the grass is fully dark — make it a
      // gradient to bright lighter glowing tips", later "reduce the grass glow in dark areas"):
      // emission added AFTER lighting and scaled UP in shade, so the dark-side lawn keeps a soft
      // colour-led glow on every blade. Tuned twice by user feedback: the loud pass blew the lawn
      // out, the faint pass vanished entirely — strength 0.75 / clamp 0.65 is the visible middle.
      //
      // Two field fixes (2026-10-01, reported as tip "sparkles" + a black planet menu):
      //  • the falloff was `tipness.pow(2.2)` — `pow(0, 2.2)` evaluates to NaN on some
      //    WebGPU/D3D drivers; blade bases interpolate to exactly 0, so chunks of the lawn went
      //    NaN and the bloom blur smeared the NaN across the whole frame (black menu planet).
      //    A pow-free LINEAR rise has no such corner.
      //  • the old falloff also piled the whole glow into the last few centimetres of the tip,
      //    which read as sparkling dots once bloom kicked in. The glow rises smoothly from the
      //    root and stays well under the bloom threshold, so it reads as a gentle gradient of
      //    light (root dark → tip faintly lit) instead of glitter.
      glowNode: (() => {
        const base = nodes.colorNode(nodes.terrainNode(positionWorld));
        const ramp: any = mix(base.mul(0.42), base.mul(1.55), tipness);
        const luma: any = dot(ramp, vec3(0.2126, 0.7152, 0.0722));
        const vivid: any = ramp.mul(1.32).sub(vec3(luma, luma, luma).mul(0.32));
        const gradient: any = (tipness as any).mul(0.5).add((tipness as any).mul(tipness).mul(0.5));
        const vary: any = (bladeTint as any).mul(0.4).add(0.8);
        // COLOUR-LED glow: keeps the blade's own hue (the white-lifted pass bleached whole lawns —
        // user report 2026-10-01) and is tip-weighted (0 at the root → 1 at the tip), so the glow
        // reads as a lighter coloured tip, never as a washed-out carpet.
        return vivid.mul(0.75).mul(gradient).mul(vary).clamp(0, 0.65);
      })(),
      // The blades' own glow IS the tuned look; the reciprocal lawn glow (MeshDefaultMaterial)
      // exists to light the surfaces AROUND the grass — ground, rocks, trunks — so the blades
      // themselves opt out of receiving it.
      lawnGlow: false,
    });

    material.positionNode = Fn(() => {
      const randomVertex = attribute('bladeRandom') as any;
      const field = attribute('bladeField') as any;

      // ---- the blade's SURFACE POSITION is baked into the position attribute at build
      // (direction · terrain radius) — the vertex stage performs zero terrain reads, which
      // is what lets the field run at full patch density. `direction` is its unit radial.
      const basePosition: any = attribute('position') as any;
      const direction: any = normalize(basePosition);

      // ---- tangent frame at the blade
      const up = vec3(0, 1, 0);
      const reference: any = select(direction.y.abs().lessThan(0.95), up, vec3(1, 0, 0));
      const tangent: any = normalize(reference.cross(direction));
      const bitangent: any = direction.cross(tangent);

      // ---- blade shape (folio: tip / left / right). `field` is the BAKED size factor
      // (patch coverage × water × world-stable noise) — no term here can change while the
      // world runs, so blades never resize as the player moves.
      const bladeWidth = this.uBladeWidth.mul(field);
      const bladeHeight = this.uBladeHeight
        .mul(this.uBladeRandomness.mul(randomVertex).add(this.uBladeRandomness.oneMinus()))
        .mul(field);

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

      // ---- wind (ONE field for the whole world — plan §18), sampled from the blade's
      // WORLD position so the ripple is continuous and identical every run.
      const windOffset = wind.offsetNode(vec2(basePosition.x, basePosition.z)) as any;
      const tipness = isTip.select(float(1), float(0));
      const sway = windOffset.mul(tipness).mul(shapeUp).mul(this.uSwayStrength);

      // ---- the player PARTS the grass: blades within the walk radius bend
      // away from the player (tip vertices only), centred on their exact world
      // position. The clearing is deliberately WIDE (user ask: "increase the
      // radius to move more grass away from the player") and the trample trail
      // below holds the wake visible for seconds after the player has passed.
      const toPlayerWorld = basePosition.sub(this.uPushCenter);
      const horizontal = toPlayerWorld.sub(direction.mul((toPlayerWorld as any).dot(direction)));
      const playerDistance = (horizontal as any).length();
      const pushInfluence = smoothstep(0.2, 1.8, playerDistance).oneMinus();
      const pushDir = normalize(horizontal as any);
      const clearingBend = pushDir.mul(pushInfluence.mul(0.65));
      // ---- TRAMPLE TRAIL: recent player positions linger, so blades stay
      // pushed along the walked path — the visible wake behind a moving player
      // (user ask: a MORE visible trail). Samples hold their full push for ~4 s
      // and spring back over the next 3 s, so the grass under a stopped player
      // recovers slowly instead of snapping upright. The ring buffer carries
      // 96 m of history (96 slots × 1 m). It is BRANCHED: only blades within
      // ~2.4 m of the player run the loop — every other blade skips all reads.
      const trailBend = vec3(0, 0, 0).toVar();
      If(playerDistance.lessThan(2.4), () => {
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
          const influence = smoothstep(0.4, 2.0, trailDistance).oneMinus()
            .mul(smoothstep(4.0, 7.0, age).oneMinus())
            .mul(smoothstep(0.0, 0.3, age));
          accumulated.addAssign(
            normalize(horizontalTrail.add(vec3(0.0001, 0.0001, 0.0001)) as any).mul(influence),
          );
        });
        trailBend.assign(accumulated.mul(0.45));
      });

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

  /** Called every frame from the environment tick — only the player's parting moves now. */
  update(focusPlanetPosition?: THREE.Vector3): void {
    const focus = focusPlanetPosition ?? this.lastFocus;
    if (!focus) return;
    this.lastFocus = focus;

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

    // Parting only happens at ground level — the lawn is untouched mid-air.
    this.scratchDir.copy(focus).normalize();
    const height = Math.max(0, focus.length() - this.surface.radiusAt(this.scratchDir));
    this.uGrassPush.value = 1 - smoothstepCpu01(0.35, 1.1, height);
  }

  private lastFocus: THREE.Vector3 | null = null;

  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  dispose(): void {
    this.plantToken++; // any in-flight planting pass must not swap into a disposed mesh
    this.geometry.dispose();
    this.material.dispose();
    this.trailTexture.dispose();
  }

  get bladeCount(): number {
    return this.bladeTotal || this.subdivisions * this.subdivisions;
  }
}

/** Trample-trail ring buffer: recent player positions (xyz + drop time). 96 slots × 1 m ≈ 96 m
 *  of history — the ~7 s full fade at a sprint (13.5 m/s) fits inside the ring. */
const TRAIL_SLOTS = 96;
const TRAIL_TEXEL = 1 / TRAIL_SLOTS;
const TRAIL_DROP_STEP = 1.0; // metres between overlapping samples — one channel

/** CPU smoothstep (matches the shader semantics). */
function smoothstepCpu01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
