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

export class Grass {
  readonly mesh: THREE.Mesh;

  private geometry: THREE.BufferGeometry;
  private material: MeshDefaultMaterial;

  private readonly uBladeWidth = uniform(0.19);
  private readonly uBladeHeight = uniform(0.78);
  private readonly uBladeRandomness = uniform(0.6);
  /** Wind sway amount — the lawn visibly ripples (raised per feedback). */
  private readonly uSwayStrength = uniform(2.5);
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

    this.geometry = this.createGeometry(this.subdivisions);
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

    quality.events.on('change', () => {
      const subs = this.quality.grassSubdivisions();
      if (subs !== this.subdivisions) {
        this.subdivisions = subs;
        this.geometry.dispose();
        this.geometry = this.createGeometry(subs);
        this.mesh.geometry = this.geometry;
      }
    });
  }

  /** CPU side: `subdivisions²` blades, 3 vertices each — the ONLY data (plan §14). */
  private createGeometry(subdivisions: number): THREE.BufferGeometry {
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
      // position. They spring straight back the moment the player has passed —
      // the INSTANT recovery reads as a natural walking trail, no lane.
      const toPlayerWorld = basePosition.sub(this.uPushCenter);
      const horizontal = toPlayerWorld.sub(direction.mul((toPlayerWorld as any).dot(direction)));
      const playerDistance = (horizontal as any).length();
      const pushInfluence = smoothstep(0.15, 1.25, playerDistance).oneMinus();
      const pushDir = normalize(horizontal as any);
      const clearingBend = pushDir.mul(pushInfluence.mul(0.55));
      // ---- TRAMPLE TRAIL: recent player positions linger, so blades stay
      // pushed along the walked path and spring back over ~1.7 s — the visible
      // trail behind a moving player. Standing still, only the clearing holds.
      // The 18-slot loop only ever matters within ~1.4 m of the player, so it is
      // BRANCHED: every other blade on the planet skips all 18 texture reads.
      const trailBend = vec3(0, 0, 0).toVar();
      If(playerDistance.lessThan(1.7), () => {
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
          const influence = smoothstep(0.3, 1.35, trailDistance).oneMinus()
            .mul(smoothstep(0.7, 1.6, age).oneMinus())
            .mul(smoothstep(0.0, 0.3, age));
          accumulated.addAssign(
            normalize(horizontalTrail.add(vec3(0.0001, 0.0001, 0.0001)) as any).mul(influence),
          );
        });
        trailBend.assign(accumulated.mul(0.38));
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
    this.geometry.dispose();
    this.material.dispose();
    this.trailTexture.dispose();
  }

  get bladeCount(): number {
    return this.bladeTotal || this.subdivisions * this.subdivisions;
  }
}

/** Trample-trail ring buffer: recent player positions (xyz + drop time). */
const TRAIL_SLOTS = 18;
const TRAIL_TEXEL = 1 / TRAIL_SLOTS;
const TRAIL_DROP_STEP = 0.85; // metres between overlapping samples — one channel

/** CPU smoothstep (matches the shader semantics). */
function smoothstepCpu01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
