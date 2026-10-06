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
  max,
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
import {
  chooseGrassLod,
  grassLodBands,
  grassLodEnabled,
  grassLodVertexCount,
  GRASS_LOD_KEEP,
  type GrassLod,
  type GrassLodBand,
} from './GrassLOD';
import { MeshDefaultMaterial } from '../materials/MeshDefaultMaterial';
import { readSwitches } from '../DebugSwitches';
// Throttle-proof build yields — see utils/Yield.ts (a `setTimeout(0)` yield is clamped to 1 s+
// in an occluded tab and stretched this build from seconds to minutes behind the loading screen;
// rAF is paused outright there).
import { yieldToMain as nextLoop } from '../../utils/Yield';

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
  /**
   * The field is ONE shared material over a SMALL NUMBER of spatial sector meshes (plan §8/§39).
   * Planet-space placement is untouched — every blade keeps its exact baked position (nothing
   * moves with the player); the sector split only lets the camera's frustum cull the parts of
   * the planet behind it. A single planet-wide mesh can never be culled (its bounds always
   * intersect the view), so its vertex stage ran for EVERY blade every frame; with sectors only
   * the visible fraction is submitted.
   */
  readonly root = new THREE.Group();

  /** Completes when the planet-wide planting pass has swapped its real sector meshes in. */
  readonly ready: Promise<void>;

  private material: MeshDefaultMaterial;
  /** One degenerate blade carrying the real attributes until the first planting pass lands. */
  private placeholder!: THREE.Mesh;
  /** Serialises planting passes: a quality change waits for the pass before it. */
  private plantChain: Promise<void> = Promise.resolve();
  /** Only the NEWEST planting pass may swap its geometry in (a stale one is disposed). */
  private plantToken = 0;
  /** Per-sector draw records for the horizon cull + distance LOD in `update`. */
  private readonly sectorMeshes: {
    mesh: THREE.Mesh;
    center: THREE.Vector3;
    radius: number;
    blades: number;
    lod: GrassLod;
  }[] = [];
  private readonly camScratch = new THREE.Vector3();
  /** Cached LOD bands (rebuilt only when the quality level changes — never per frame). */
  private lodBands: readonly [GrassLodBand, GrassLodBand] = grassLodBands(0);
  private lodBandsLevel = -1;
  /** Blades the last LOD pass left in the draw lists (debug / perfcheck readout). */
  private drawnBladeTotal = 0;

  private readonly uBladeWidth = uniform(0.24);
  /** Tall meadow blades (user ask: "grass needs to be taller" — raised again to chest-high). */
  private readonly uBladeHeight = uniform(1.35);
  private readonly uBladeRandomness = uniform(0.6);
  /** Wind sway amount — the lawn visibly ripples (raised twice per feedback: "add more sway"). */
  private readonly uSwayStrength = uniform(3.6);
  /** 0 in the air, 1 on the ground — the LOCAL player only parts grass at ground level. */
  private readonly uGrassPush = uniform(1);
  /** Player world position (planet space) — the parting is centred EXACTLY here. */
  private readonly uPushCenter = uniform(new THREE.Vector3(1, 0, 0));

  /**
   * REMOTE WALKERS (user ask 2026-10-03): every other player's proxy position, one uniform pair
   * per slot. The shader runs the trail loop for blades near ANY walker, so other survivors'
   * wakes bent the lawn where THEY walked — without the grass shader becoming a planet-wide
   * N-loop (the walker tests live behind a "any remote walker active?" branch).
   */
  private static readonly MAX_REMOTE_WALKERS = 7;
  private readonly uWalkerPos: any[] = [];
  private readonly uWalkerOn: any[] = [];
  /** 1 while at least one remote walker is tracked — gates the per-blade walker tests. */
  private readonly uWalkersActive = uniform(0);
  /** Per-walker trail bookkeeping (player id → last dropped sample). */
  private readonly walkerTrail = new Map<string, { last: THREE.Vector3; started: boolean }>();

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

    // ---- remote-walker slots (positions + activity flags), driven by `update(focus, camera,
    // walkers)` once per frame; all inactive until the first roster of proxies arrives.
    for (let i = 0; i < Grass.MAX_REMOTE_WALKERS; i++) {
      this.uWalkerPos.push(uniform(new THREE.Vector3(0, 1, 0)));
      this.uWalkerOn.push(uniform(0));
    }

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
    // swaps the real field in, the root shows ONE degenerate blade carrying the SAME geometry
    // attributes — the material's shader pipeline needs all of them from the first render
    // (a bare BufferGeometry made it compile `normalize(0.0)` and go invalid on WebGPU).
    this.material = this.createMaterial();
    this.placeholder = new THREE.Mesh(createPlaceholderBlade(), this.material);
    this.placeholder.frustumCulled = false;
    // NO received dynamic shadows on blades: razor-thin triangles are the worst
    // case for shadow-map bias — the acne flips lit/dark patches ON the blades
    // as the shadow-follow camera moves with the player (the 'lighting angle
    // suddenly changes' flicker at distance). The baked root shade + the
    // terrain's own grass shadow underneath keep the grounded look.
    this.placeholder.receiveShadow = false;
    this.placeholder.matrixAutoUpdate = false;
    this.placeholder.updateMatrix();
    this.placeholder.name = 'grass_placeholder';
    this.root.name = 'grass';
    this.root.add(this.placeholder);

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
    const sectors = await this.createSectorGeometries(subdivisions);
    if (token !== this.plantToken) {
      for (const sector of sectors) sector.geometry.dispose(); // a newer pass (or disposal) won
      return;
    }
    for (const child of [...this.root.children]) {
      if (child === this.placeholder) continue;
      this.root.remove(child);
      (child as THREE.Mesh).geometry.dispose();
    }
    this.sectorMeshes.length = 0;
    for (const sector of sectors) {
      const mesh = new THREE.Mesh(sector.geometry, this.material);
      // Real bounds — computed from the sector's own blades and expanded for wind/push — plus
      // frustum culling: the whole point of the split (plan §8). Casting/receiving stay off:
      // blades are the one thing the shadow map must never re-render.
      mesh.frustumCulled = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = `grass_sector_${sector.id}`;
      this.root.add(mesh);
      const bounds = sector.geometry.boundingSphere;
      if (bounds) {
        this.sectorMeshes.push({
          mesh,
          center: bounds.center.clone(),
          radius: bounds.radius,
          blades: sector.geometry.getAttribute('position').count / 3,
          lod: 0,
        });
      }
    }
    if (this.placeholder.parent) this.root.remove(this.placeholder);
    if (grassStats()) {
      console.info('[grass]', {
        blades: this.bladeTotal,
        sectors: sectors.length,
        subdivisions,
        vertexCount: this.bladeTotal * 3,
        drawCallsMax: sectors.length,
      });
    }
  }

  /** CPU side: `subdivisions²` blades, 3 vertices each — the ONLY data (plan §14).
   *  The scatter loop YIELDS to the event loop every ~128k attempts, so the caller's
   *  loading screen (or the class picker, for the background pre-build) stays alive. */
  private async createSectorGeometries(
    subdivisions: number,
  ): Promise<{ id: number; geometry: THREE.BufferGeometry }[]> {
    const target = subdivisions * subdivisions;
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
    /** Spatial sector (lat band × lon band) per accepted blade — draw partitioning only. */
    const sectorOf = new Uint8Array(target);

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
      // shoulder to shoulder while the rim thins out across the wide, domain-warped band
      // (GrassField.ts) — no cut line, the lawn just frays away at its own irregular edge.
      const patch = this.noises.samplePatch(dx * GRASS_PATCH_UV_SCALE, dz * GRASS_PATCH_UV_SCALE);
      if (patch < GRASS_PATCH_EDGE_LOW) continue; // bare ground — ZERO blades
      const coverage = grassCoverage(patch);
      if (random() > Math.pow(coverage, GRASS_ACCEPTANCE_POWER)) continue;

      // water — THE VISIBLE WATERLINE (user ask): blades shrink as they approach the puddle and
      // stop right at the water. The depth is measured against the RENDERED terrain vs the
      // basin's water level — the very same intersection the puddle mesh shows — instead of the
      // old basin-RIM radius test, which killed the lawn in a bare circle metres wider than the
      // water itself. `WATER_TAPER` metres above the waterline the blade size eases from full
      // down to 20 %; at `WATER_EDGE_CUT` below it the blade is dropped.
      let waterFactor = 1;
      if (this.water && this.water.sites.length > 0) {
        this.scratchDir.set(dx, dy, dz);
        const depth = this.water.waterDepthAt(this.scratchDir);
        if (depth > WATER_EDGE_CUT) continue; // under the water film — the lawn stops
        if (depth > -WATER_TAPER) {
          const t = (depth + WATER_TAPER) / WATER_TAPER; // 0 = taper start → 1 = waterline
          const ease = t * t * (3 - 2 * t);
          waterFactor = 1 - 0.8 * ease;
        }
      }

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
      // Spatial sector (plan §8) — recorded here, where the direction is still in registers.
      // PURE INDEXING: the blade's planet-space position is untouched; only the DRAW is split.
      const latBand = Math.min(GRASS_SECTORS_LAT - 1, Math.floor(((dy + 1) * 0.5) * GRASS_SECTORS_LAT));
      const lonBand = Math.min(
        GRASS_SECTORS_LON - 1,
        Math.floor(((Math.atan2(dz, dx) + Math.PI) / (Math.PI * 2)) * GRASS_SECTORS_LON),
      );
      sectorOf[accepted] = latBand * GRASS_SECTORS_LON + lonBand;
      accepted++;
    }
    this.bladeTotal = accepted;

    // ---- bucket the accepted blades by sector in ONE pass (no O(sectors × blades) scan).
    const counts = new Uint32Array(GRASS_SECTORS);
    for (let i = 0; i < accepted; i++) counts[sectorOf[i]]++;
    const offsets = new Uint32Array(GRASS_SECTORS + 1);
    for (let s = 0; s < GRASS_SECTORS; s++) offsets[s + 1] = offsets[s] + counts[s];
    const cursors = offsets.slice();
    const order = new Int32Array(accepted); // blade indices, grouped by sector
    for (let i = 0; i < accepted; i++) order[cursors[sectorOf[i]]++] = i;

    // ---- one geometry per non-empty sector: 3 vertices per blade (tip / left base / right
    // base), all sharing the blade's data, plus REAL bounds (the old whole-planet sphere made
    // every frame submit every blade — the one thing this split exists to stop).
    const sectors: { id: number; geometry: THREE.BufferGeometry }[] = [];
    for (let s = 0; s < GRASS_SECTORS; s++) {
      const count = offsets[s + 1] - offsets[s];
      if (count === 0) continue;
      const positions = new Float32Array(count * 9);
      const randomness = new Float32Array(count * 3);
      const fieldAttr = new Float32Array(count * 3);
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      let v = 0;
      for (let k = offsets[s]; k < offsets[s + 1]; k++) {
        const i = order[k];
        const px = posX[i];
        const py = posY[i];
        const pz = posZ[i];
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (pz < minZ) minZ = pz;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
        if (pz > maxZ) maxZ = pz;
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
      // AABB centre + half diagonal + the wind/push margin: cheap, conservative, and small
      // enough that the frustum actually rejects the sectors behind the camera.
      const cx = (minX + maxX) * 0.5;
      const cy = (minY + maxY) * 0.5;
      const cz = (minZ + maxZ) * 0.5;
      const half = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.5;
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), half + GRASS_BOUNDS_MARGIN);
      sectors.push({ id: s, geometry });
      // Yield between sector fills so a background pre-build keeps the loading screen alive.
      if ((s & 3) === 3) await nextLoop();
    }
    return sectors;
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
    // THE PER-BLADE TERRAIN COLOUR — evaluated ONCE PER VERTEX and interpolated (plan §32:
    // "move repeated calculations out of fragment"). The blades used to re-read the terrain
    // (terrain tex + gradient palette + patch mask) TWICE PER FRAGMENT — once for the colour
    // ramp, once again for the glow — across one of the largest screen areas in the game. All
    // three vertices of a blade share its position, so the interpolated value is identical to
    // the old per-fragment sample, at a fraction of the cost.
    const bladeBase: any = varying(nodes.colorNode(nodes.terrainNode(attribute('position') as any)) as any);

    const material = new MeshDefaultMaterial({
      // THE VISIBLE GRADIENT (user ask: "more vibrant and more visible gradient"): the root
      // sits in a deep grounded shade and the tip is a bright SATURATED pop, so the ramp
      // reads blade by blade instead of blending into the terrain colour under it.
      // Saturation > 1 is applied as colour × 1.32 − luma × 0.32 (the mix() identity).
      colorNode: (() => {
        const ramp: any = mix(bladeBase.mul(0.42), bladeBase.mul(1.55), tipness);
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
        const ramp: any = mix(bladeBase.mul(0.42), bladeBase.mul(1.55), tipness);
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
      // 96 m of history (96 slots × 1 m). It is BRANCHED: only blades near a
      // walker run the loop — every other blade skips all reads.
      //
      // REMOTE WALKERS (user ask 2026-10-03): "near a walker" now means near the LOCAL player
      // OR any tracked remote player, so every survivor's wake bends the lawn where THEY
      // walked. The per-blade cost of the remote test is one radial distance per walker slot,
      // and the whole block sits behind `uWalkersActive` — in solo play the branch is inert.
      const nearAny = playerDistance.lessThan(2.4).select(float(1), float(0)).toVar();
      If((this.uWalkersActive as any).greaterThan(0.5), () => {
        for (let w = 0; w < Grass.MAX_REMOTE_WALKERS; w++) {
          const toWalker = basePosition.sub(this.uWalkerPos[w]);
          const horizontalWalker = (toWalker as any).sub(direction.mul((toWalker as any).dot(direction)));
          const walkerDistance = (horizontalWalker as any).length();
          const active = (this.uWalkerOn[w] as any).greaterThan(0.5);
          const nearWalker = active.select(walkerDistance.lessThan(2.4).select(float(1), float(0)), float(0));
          nearAny.assign(max(nearAny, nearWalker));
        }
      });
      const trailBend = vec3(0, 0, 0).toVar();
      If(nearAny.greaterThan(0.5), () => {
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

      // NOTE: the local player's clearing still fades out mid-air (`uGrassPush`); the TRAIL is
      // not gated by it (user ask 2026-10-03): a remote walker's wake must show regardless of
      // where the LOCAL player happens to be, and pressed grass under a jump keeps its wake.
      const pushBend = clearingBend.mul(this.uGrassPush).add(trailBend).mul(tipness);

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
   * Called every frame from the environment tick — the player's parting moves, plus per-sector
   * HORIZON CULLING (the same `dot(C, P) + r|P| > R²` test the terrain chunk split proved out):
   * the camera frustum alone still admits every far-side sector (it has no occlusion concept),
   * so the visible-cap test is what actually drops the planet behind the player. The engine's
   * own frustum culling runs on top of this for the sectors off to the sides.
   */
  update(
    focusPlanetPosition?: THREE.Vector3,
    camera?: THREE.Camera,
    walkers?: readonly { id: string; pos: THREE.Vector3 }[],
  ): void {
    const focus = focusPlanetPosition ?? this.lastFocus;
    if (!focus) return;
    this.lastFocus = focus;

    // ---- sector horizon culling + distance LOD (plan §9/§10): ONE pass, one distance test
    // per SECTOR (~32 a frame, never per blade), with hysteresis so a sector cannot oscillate
    // at a band edge. The LOD changes only how many of the sector's blades are drawn — their
    // transforms are baked and never move (plan §7).
    if (this.sectorMeshes.length > 0) {
      if (this.quality.level !== this.lodBandsLevel) {
        this.lodBandsLevel = this.quality.level;
        this.lodBands = grassLodBands(this.lodBandsLevel);
      }
      if (camera) {
        camera.getWorldPosition(this.camScratch);
        const camLen = this.camScratch.length();
        const horizon = this.surface.radius * this.surface.radius * 0.97;
        let drawn = 0;
        for (const sector of this.sectorMeshes) {
          const visible = sector.center.dot(this.camScratch) + sector.radius * camLen > horizon;
          sector.mesh.visible = visible;
          if (!visible) continue;
          const distance = Math.max(0, this.camScratch.distanceTo(sector.center) - sector.radius);
          const lod = grassLodEnabled() ? chooseGrassLod(distance, sector.lod, this.lodBands) : 0;
          if (lod !== sector.lod) {
            sector.lod = lod;
            sector.mesh.geometry.setDrawRange(0, grassLodVertexCount(sector.blades, lod));
          }
          drawn += Math.floor(sector.blades * GRASS_LOD_KEEP[lod]);
        }
        this.drawnBladeTotal = drawn;
      } else {
        for (const sector of this.sectorMeshes) sector.mesh.visible = true;
      }
    }

    // Parting centre = the player's exact world position.
    this.uPushCenter.value.copy(focus);

    // Drop a trample-trail sample every TRAIL_DROP_STEP metres of travel.
    if (!this.trailStarted || this.lastTrailPoint.distanceTo(focus) > TRAIL_DROP_STEP) {
      this.pushTrailSample(focus);
      this.lastTrailPoint.copy(focus);
      this.trailStarted = true;
    }

    // Parting only happens at ground level — the lawn is untouched mid-air.
    this.scratchDir.copy(focus).normalize();
    const height = Math.max(0, focus.length() - this.surface.radiusAt(this.scratchDir));
    this.uGrassPush.value = 1 - smoothstepCpu01(0.35, 1.1, height);

    // ---- REMOTE WALKERS (user ask 2026-10-03): the other players' proxy positions join the
    // same trail ring and are published to the shader (blades near them run the trail loop too).
    // Samples are only dropped while GROUNDED — trampling is a ground effect.
    let slot = 0;
    if (walkers) {
      for (const w of walkers) {
        if (slot >= Grass.MAX_REMOTE_WALKERS) break;
        this.uWalkerPos[slot].value.copy(w.pos);
        this.uWalkerOn[slot].value = 1;
        slot++;
        this.dropWalkerSample(w.id, w.pos);
      }
    }
    for (; slot < Grass.MAX_REMOTE_WALKERS; slot++) this.uWalkerOn[slot].value = 0;
    this.uWalkersActive.value = slot > 0 ? 1 : 0;
  }

  /** Append one trail sample (xyz + now) to the ring and re-upload the texture. */
  private pushTrailSample(pos: THREE.Vector3): void {
    const offset = (this.trailCursor % TRAIL_SLOTS) * 4;
    this.trailCursor++;
    this.trailData[offset] = pos.x;
    this.trailData[offset + 1] = pos.y;
    this.trailData[offset + 2] = pos.z;
    this.trailData[offset + 3] = this.uTime.value as number;
    this.trailTexture.needsUpdate = true;
  }

  /**
   * A remote walker's path sample. Same ~1 m step as the local player (a hair wider — the wake
   * only has to read as a trail), but GROUNDED ONLY: the parting is a ground effect, so a player
   * mid-jump or on a fortress deck leaves no print until they come back down.
   */
  private dropWalkerSample(id: string, pos: THREE.Vector3): void {
    let entry = this.walkerTrail.get(id);
    if (!entry) {
      if (this.walkerTrail.size > 24) this.walkerTrail.clear(); // pruned with the departing players
      entry = { last: new THREE.Vector3(), started: false };
      this.walkerTrail.set(id, entry);
    }
    this.scratchDir.copy(pos).normalize();
    const height = Math.max(0, pos.length() - this.surface.radiusAt(this.scratchDir));
    if (height > 1.1) {
      entry.started = false;
      return;
    }
    if (entry.started && entry.last.distanceTo(pos) < REMOTE_DROP_STEP) return;
    this.pushTrailSample(pos);
    entry.last.copy(pos);
    entry.started = true;
  }

  private lastFocus: THREE.Vector3 | null = null;

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  dispose(): void {
    this.plantToken++; // any in-flight planting pass must not swap into a disposed field
    for (const child of [...this.root.children]) {
      if (child !== this.placeholder) (child as THREE.Mesh).geometry.dispose();
    }
    this.root.clear();
    this.sectorMeshes.length = 0;
    this.placeholder.geometry.dispose();
    this.material.dispose();
    this.trailTexture.dispose();
  }

  get bladeCount(): number {
    return this.bladeTotal || this.subdivisions * this.subdivisions;
  }

  /** Blades the last frame's LOD pass left in the draw lists (debug / perfcheck readout). */
  get bladesDrawn(): number {
    return this.drawnBladeTotal;
  }
}

/** Trample-trail ring buffer: recent player positions (xyz + drop time). 96 slots × 1 m ≈ 96 m
 *  of history — the ~7 s full fade at a sprint (13.5 m/s) fits inside the ring. */
const TRAIL_SLOTS = 96;
const TRAIL_TEXEL = 1 / TRAIL_SLOTS;

/**
 * Spatial sectors (plan §8/§9/§39): lat bands × lon bands. 128 draws worst-case, but the horizon
 * + frustum tests keep the ~15-30 sectors the camera can actually see, so the vertex stage drops
 * from EVERY blade to the visible fraction. The split is indexing-only — no blade moves.
 *
 * 8 × 16 (was 4 × 8): the sector is also the LOD UNIT, and a 45°-wide patch carries a ~60 m
 * bounding radius on this planet — far coarser than “nearest blade” and it left most visible
 * sectors pinned to LOD0. At 22.5° a sector's bounds actually discriminate distance, which is
 * what the plan's “100-300 sector distance checks a frame” sizing assumes (§9).
 */
const GRASS_SECTORS_LAT = 8;
const GRASS_SECTORS_LON = 16;
const GRASS_SECTORS = GRASS_SECTORS_LAT * GRASS_SECTORS_LON;
/** Bounding-sphere margin (m) covering the maximum wind sway + player push a blade can receive. */
const GRASS_BOUNDS_MARGIN = 6;

/**
 * Shoreline taper (user ask): over the last `WATER_TAPER` metres above the water level blades
 * ease from full size down to 20 %, then stop `WATER_EDGE_CUT` under it. Measured against the
 * RENDERED terrain, so the stop line is exactly the puddle the camera shows.
 */
const WATER_TAPER = 2.0;
const WATER_EDGE_CUT = 0.045;

/** `?grassstats=1` — one line per planting pass (blades / sectors / verts / draw ceiling). */
function grassStats(): boolean {
  try {
    return readSwitches()['grassstats'] === '1';
  } catch {
    return false;
  }
}
const TRAIL_DROP_STEP = 1.0; // metres between overlapping samples — one channel
/** Remote walkers drop a sample every 1.2 m (same ring; a hair wider than the local player's). */
const REMOTE_DROP_STEP = 1.2;

/** CPU smoothstep (matches the shader semantics). */
function smoothstepCpu01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
