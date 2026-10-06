// NECROFALL — TERRAIN GENERATOR (plan §11/§12/§24). The height-field pipeline, one function
// per geological PURPOSE instead of one noise stack (plan §11):
//
//   PlanetArchetype → continental mask → MOUNTAIN CHAINS → valleys → RIVERS → canyons →
//   craters/sinkholes → LANDMARK shapes
//
// Everything is analytic and allocation-free: `sample()` runs for terrain vertices, collision
// and raycasts, so it must stay within a few percent of the old 4-fbm field. The shared
// `wobble` field gives rivers their sinuosity and the crumpled detail its large-scale warping
// with ONE extra fbm call, and every feature early-outs cheaply (dot products, no trig except
// a sqrt per influenced sample).
import * as THREE from 'three';
import { fbm, smoothstep, clamp, Rand } from '../utils/Utils';
import { deriveArchetype, type PlanetArchetype } from './PlanetArchetypes';
import { generateLandmarks, type Landmark } from './LandmarkGenerator';
import { generateCaves, type PlanetCave } from './caves/CaveGenerator';

interface Belt {
  // great-circle normal + half width + power
  nx: number; ny: number; nz: number; w: number; p: number;
}

/** Landmark flattened for the hot loop. */
interface Site {
  nx: number; ny: number; nz: number;
  radius: number; // radians (small-angle)
  strength: number;
  shape: number; // 0 BOWL, 1 CRATER, 2 PEAK, 3 FLAT, 4 RIDGE
  color: number;
  moisture: number;
  landmark: Landmark;
}

const SHAPE_ID: Record<Landmark['shape'], number> = { BOWL: 0, CRATER: 1, PEAK: 2, FLAT: 3, RIDGE: 4 };

export class TerrainGenerator {
  readonly archetype: PlanetArchetype;
  readonly landmarks: Landmark[];
  /** Deterministic cave graph (plan §28) — carved into the SAME height field the player walks. */
  readonly caves: PlanetCave[];
  readonly radius: number;

  private readonly seed: number;
  private readonly chains: Belt[] = [];
  private readonly valleys: Belt[] = [];
  private readonly rivers: Belt[] = [];
  private readonly craters: Belt[] = [];
  private readonly sinkholes: Belt[] = [];
  private readonly sites: Site[] = [];
  /** Per-cave prefilters: cos(footprint radius) — the hot loop skips caves instantly. */
  private readonly caveCosReach: number[] = [];
  /** River influence is needed by the moisture field too — remember its last value per sample. */
  private lastRiverT = 0;
  private lastSiteT = 0;
  private lastSiteIdx = -1;
  /** Cave carve of the last `sample`/`caveDropAt` — depth below the local surface, metres. */
  lastCaveDrop = 0;
  lastCaveIdx = -1;
  lastCaveT = 1;

  constructor(seed: number, radius: number, archetype?: PlanetArchetype, ring = 0, focusDir?: THREE.Vector3) {
    this.seed = seed >>> 0;
    this.radius = radius;
    this.archetype = archetype ?? deriveArchetype(seed, ring);
    const rng = new Rand((this.seed ^ 0x2545f491) >>> 0);
    const arch = this.archetype;

    // ---- mountain chains: belts along great circles (plan §12 — intentional, not noise)
    const chainCount = arch.mountainPower > 1.1 ? 4 : 3;
    for (let i = 0; i < chainCount; i++) {
      const b = this.randomGreatCircle(rng);
      // Belt power is clamped: 1.8× belts stacked with the ridge exponent produced the last
      // impossible faces in the 10k-seed sweep (plan §69 — fix the generator, not the map).
      this.chains.push({ ...b, w: rng.range(0.1, 0.22), p: Math.min(rng.range(0.6, 1.25) * arch.mountainPower, 1.45) });
    }
    // ---- broad valleys
    for (let i = 0; i < arch.valleyCount; i++) {
      const b = this.randomGreatCircle(rng);
      this.valleys.push({ ...b, w: rng.range(0.12, 0.26), p: arch.valleyDepth * rng.range(0.6, 1.15) });
    }
    // ---- rivers: same belt maths, much narrower, offset by the wobble field
    for (let i = 0; i < arch.riverCount; i++) {
      const b = this.randomGreatCircle(rng);
      this.rivers.push({ ...b, w: arch.riverWidth * rng.range(0.7, 1.35), p: arch.riverDepth * rng.range(0.6, 1.3) });
    }
    // ---- crater fields + sinkholes (depth capped so their walls stay walkable — plan §69)
    for (let i = 0; i < arch.craterCount; i++) {
      const b = this.randomGreatCircle(rng);
      this.craters.push({ ...b, w: rng.range(0.06, 0.14), p: Math.min(arch.craterDepth, 5) * rng.range(0.55, 1.2) });
    }
    for (let i = 0; i < arch.sinkholeCount; i++) {
      const b = this.randomGreatCircle(rng);
      this.sinkholes.push({ ...b, w: rng.range(0.05, 0.09), p: Math.min(arch.craterDepth * 0.7, 4.5) * rng.range(0.6, 1.1) });
    }

    // ---- landmarks (their shapes are carved here; BiomeGenerator blends their colour)
    this.landmarks = generateLandmarks(this.seed, focusDir);
    for (const lm of this.landmarks) {
      this.sites.push({
        nx: lm.dir.x, ny: lm.dir.y, nz: lm.dir.z,
        radius: lm.radius,
        strength: lm.strength,
        shape: SHAPE_ID[lm.shape],
        color: lm.color,
        moisture: lm.shape === 'BOWL' ? 0.6 * lm.strength : lm.type === 'FUNGAL_FOREST' ? 0.45 * lm.strength : 0,
        landmark: lm,
      });
    }

    // ---- caves (plan §28/§38): node graphs whose carve is folded into `sample()` below, so the
    // rendered ground, collision and every placement estimate agree by construction.
    this.caves = generateCaves(this.seed, radius, this.landmarks, this.archetype.biome, focusDir);
    for (const cave of this.caves) this.caveCosReach.push(Math.cos(Math.min(Math.PI, cave.radius + 0.03)));
  }

  /** A deterministic great-circle normal, biased toward the XZ plane so belts read as bands. */
  private randomGreatCircle(rng: Rand): Belt {
    const a = rng.range(0, Math.PI * 2);
    const tilt = rng.range(-0.6, 0.6);
    const nx = Math.cos(a) * Math.cos(tilt);
    const ny = Math.sin(tilt);
    const nz = Math.sin(a) * Math.cos(tilt);
    const l = Math.hypot(nx, ny, nz) || 1;
    return { nx: nx / l, ny: ny / l, nz: nz / l, w: 0.1, p: 1 };
  }

  /**
   * THE height field (plan §11 pipeline). Returns terrain radius along a unit direction.
   * Allocation-free; callers pass unit vectors.
   */
  sample(x: number, y: number, z: number): number {
    const s = this.seed;
    const arch = this.archetype;
    // ---- continental mask (+ the archetype's land/sea bias)
    const cont = (fbm(x * 1.15 + 11.3, y * 1.15 + 4.7, z * 1.15 + 7.1, 4, s) - 0.5) * 2 + arch.continentBias;
    const plateau = smoothstep(0.12, 0.4, cont) * arch.plateauLift;

    // ---- shared wobble: warps the ridges and gives every river its sinuosity in ONE fbm
    const wob = fbm(x * 3.1 + 3.7, y * 3.1 + 8.2, z * 3.1 + 5.9, 2, s + 77) - 0.5;

    // ---- mountain chains: ridged noise concentrated on the chain belts
    let chainMask = 0;
    for (const c of this.chains) {
      const d = x * c.nx + y * c.ny + z * c.nz;
      const belt = Math.max(0, 1 - (d * d) / (c.w * c.w));
      chainMask = Math.max(chainMask, belt * c.p);
    }
    // Ridge field: 3 octaves at freq 1.9 (wider mountains). The QA sweep measured body-scale
    // slopes (plan §69): at freq 2.7 / 4 octaves the sharpened crests hit ~79° faces; widening
    // the field + capping amplitude keeps every face climbable while chains stay dramatic.
    // The seam multipliers are clamped so even VOLCANIC's 1.45× belts can't stack a wall.
    const ridges = 1 - Math.abs(fbm(x * 1.9 + 5.1 + wob * 1.2, y * 1.9 + 1.9, z * 1.9 + 3.3 + wob * 1.2, 3, s + 7) * 2 - 1);
    const chainBoost = 0.35 + Math.min(chainMask, 1.25) * 0.85;
    const landBoost = Math.min(0.18 + Math.max(0, cont) * 0.9, 1.15);
    // GIANT MOUNTAINS (user ask 2026-10-06): the concept sheet's dominant read is huge, sharp
    // ranges on the horizon. Amplitude raised 12.5 → 22 m and chain reinforcement ×5.5, with the
    // collision band widened to match (see the clamp below) so peaks stand ~half the planet
    // radius tall while the ramp slopes the player crosses stay within the traverse budget.
    const mountains =
      Math.pow(ridges, Math.min(arch.ridgeSharpness, 2.8)) * 22.0 * Math.min(arch.mountainPower, 1.2) * landBoost * chainBoost +
      chainMask * 5.5;

    // ---- hills + fine detail scaled by the archetype's roughness
    const hills = (fbm(x * 5.4 + 2.2, y * 5.4 + 9.4, z * 5.4 + 1.5, 3, s + 3) - 0.5) * 4.6 * arch.roughness;
    const detail = (fbm(x * 13.5 + 6.6, y * 13.5 + 2.4, z * 13.5 + 8.1, 2, s + 19) - 0.5) * 1.4 * arch.roughness;

    // ---- canyons along the plate seams + deep basins (wide seam + capped depth: the QA
    // sweep flagged narrow seam walls as unclimbable at body scale — plan §69)
    const seam = 1 - Math.min(1, Math.abs(cont) * 2.6);
    const canyon = -Math.pow(Math.max(0, seam), 2) * Math.min(arch.canyonDepth, 5.5);
    const basin = -Math.max(0, -cont) * 8.5;

    let h = cont * 5.4 + plateau + mountains + hills + detail + canyon + basin;

    // ---- broad valleys (deepened with the mountains so the silhouette alternates peak/valley)
    for (const v of this.valleys) {
      const d = x * v.nx + y * v.ny + z * v.nz;
      const band = Math.max(0, 1 - (d * d) / (v.w * v.w));
      h -= band * band * v.p * 1.6;
    }

    // ---- rivers (sinuous belts carved into the low ground)
    let riverT = 0;
    for (const r of this.rivers) {
      const d = x * r.nx + y * r.ny + z * r.nz + wob * r.w * 2.4;
      const band = Math.max(0, 1 - (d * d) / (r.w * r.w));
      h -= band * band * r.p;
      riverT = Math.max(riverT, band);
    }
    this.lastRiverT = riverT;

    // ---- craters (rim + bowl) and sinkholes (bowl)
    h += this.shapeField(x, y, z, this.craters, 1);
    h -= this.shapeField(x, y, z, this.sinkholes, 0);

    // ---- landmark shapes (plan §12/§14)
    let siteT = 0;
    let siteIdx = -1;
    for (let i = 0; i < this.sites.length; i++) {
      const st = this.sites[i];
      const d = x * st.nx + y * st.ny + z * st.nz;
      const chord2 = Math.max(0, 2 - 2 * d);
      const t2 = chord2 / (st.radius * st.radius);
      if (t2 >= 1) continue;
      const t = Math.sqrt(t2); // 0 centre → 1 rim
      const strength = st.strength;
      switch (st.shape) {
        case 0: // BOWL
          h -= (1 - t * t) * 6.5 * strength;
          break;
        case 1: { // CRATER: depressed floor + raised rim (rim width scaled so it stays walkable)
          h -= (1 - t * t) * 4.5 * strength;
          const rimW = Math.max(0.22, 2.6 / (st.radius * this.radius));
          h += Math.exp(-Math.pow((t - 0.86) / rimW, 2)) * 2.2 * strength;
          break;
        }
        case 2: // PEAK
          h += Math.max(0, 1 - t * t) * 9 * strength;
          break;
        case 3: // FLAT: pull toward the local average (levelled field)
          h *= 1 - 0.75 * (1 - t) * strength;
          break;
        case 4: // RIDGE: a wall across the site (wide enough to climb)
          h += Math.max(0, 1 - Math.abs(t - 0.5) * 1.8) * 6 * strength;
          break;
      }
      if (siteIdx < 0 || 1 - t > siteT) {
        siteT = 1 - t;
        siteIdx = i;
      }
    }
    this.lastSiteT = siteT;
    this.lastSiteIdx = siteIdx;

    // ---- CAVES (plan §24/§26/§28): carve the deterministic node graph into the SAME field the
    // rest of the pipeline samples. The stepped profile (three terraced walls + a flat chamber
    // floor) keeps every descent walkable; the anisotropic warp stops the basins reading as
    // perfect circles. `h` below the carve is what grass/vegetation estimates read too.
    h -= this.caveCarve(x, y, z, true);

    const out = this.radius + h;
    // Safety clamp: procedural QA (plan §69) requires the field inside the collision band. The
    // band widened with the giant-mountain rework (−34/+46 → −48/+64); `Player.safetyNet` and the
    // cave depth budget read the SAME constants.
    return clamp(out, this.radius - 48, this.radius + 64);
  }

  /**
   * Depth (metres) the cave system carves below the local surface at a direction — the ONE cave
   * query everything reads (shader mask bake, underground state, safety net, props). Returns 0
   * outside every cave footprint. Allocation-free.
   */
  caveDropAt(x: number, y: number, z: number): number {
    return this.caveCarve(x, y, z, true);
  }

  /**
   * The carve itself. `record` writes the `lastCave*` state (hot path does; pure probes may skip
   * it). Only caves whose footprint prefilter passes are examined — at most a couple of nodes
   * run the terrace profile per sample.
   */
  private caveCarve(x: number, y: number, z: number, record: boolean): number {
    const caves = this.caves;
    if (caves.length === 0) return 0;
    let best = 0;
    let bestIdx = -1;
    let bestT = 1;
    for (let ci = 0; ci < caves.length; ci++) {
      const cave = caves[ci];
      if (x * cave.dir.x + y * cave.dir.y + z * cave.dir.z < this.caveCosReach[ci]) continue;
      const nodes = cave.nodes;
      for (let ni = 0; ni < nodes.length; ni++) {
        const node = nodes[ni];
        const d = x * node.dir.x + y * node.dir.y + z * node.dir.z;
        const chord2 = 2 - 2 * d;
        if (chord2 >= node.radius * node.radius) continue;
        // t = normalised radial distance 0 centre → 1 rim, warped ±11 % + a rim harmonic so the
        // chamber is never a circle (plan §58 imperfection).
        let t = Math.sqrt(Math.max(0, chord2)) / node.radius;
        t *= 1 + 0.11 * (x * node.axis.x + y * node.axis.y + z * node.axis.z);
        t += 0.04 * (x * node.axis2.x + y * node.axis2.y + z * node.axis2.z);
        if (t >= 1 || t < 0) continue;
        // Terraced descent: lip → wall → wall → floor (three smoothstep ledges).
        const w =
          smoothstep(1.0, 0.8, t) * 0.24 +
          smoothstep(0.82, 0.56, t) * 0.3 +
          smoothstep(0.6, 0.3, t) * 0.46;
        const drop = node.depth * Math.min(1, w);
        if (drop > best) {
          best = drop;
          bestIdx = ci;
          bestT = t;
        }
      }
    }
    if (record) {
      this.lastCaveDrop = best;
      this.lastCaveIdx = bestIdx;
      this.lastCaveT = bestT;
    }
    return best;
  }

  /** The cave owning the last carve (or null) — for underground state + cave-aware shading. */
  lastCave(): PlanetCave | null {
    return this.lastCaveIdx >= 0 ? this.caves[this.lastCaveIdx] : null;
  }

  /** Aggregated crater/sinkhole contribution; `rim` adds the raised ring (slope-limited). */
  private shapeField(x: number, y: number, z: number, belts: Belt[], rim: number): number {
    let sum = 0;
    for (const b of belts) {
      const d = x * b.nx + y * b.ny + z * b.nz;
      const chord2 = Math.max(0, 2 - 2 * d);
      const t2 = chord2 / (b.w * b.w);
      if (t2 >= 1) continue;
      const t = Math.sqrt(t2);
      const bowl = (1 - t * t) * b.p;
      const rimW = Math.max(0.22, 2.6 / (b.w * this.radius));
      const ring = rim > 0 ? Math.exp(-Math.pow((t - 0.86) / rimW, 2)) * b.p * 0.4 : 0;
      sum += ring - bowl;
    }
    return sum;
  }

  /** Surface moisture (rivers and lake sites feed the biome classifier — plan §13). */
  moistureAt(x: number, y: number, z: number): number {
    const m = fbm(x * 4.3 + 1.7, y * 4.3 + 6.1, z * 4.3 + 2.9, 2, this.seed + 91) - 0.5;
    const river = this.lastRiverT > 0 ? this.lastRiverT : this.riverTAt(x, y, z);
    const site = this.lastSiteIdx >= 0 && this.lastSiteT > 0.5 ? this.sites[this.lastSiteIdx].moisture : 0;
    return clamp(this.archetype.climate.moisture + river * 0.5 + site + m * 0.4, 0, 1);
  }

  /** River band value at a direction (recomputed when sampling moisture on its own). */
  riverTAt(x: number, y: number, z: number): number {
    const wob = fbm(x * 3.1 + 3.7, y * 3.1 + 8.2, z * 3.1 + 5.9, 2, this.seed + 77) - 0.5;
    let best = 0;
    for (const r of this.rivers) {
      const d = x * r.nx + y * r.ny + z * r.nz + wob * r.w * 2.4;
      const band = Math.max(0, 1 - (d * d) / (r.w * r.w));
      best = Math.max(best, band);
    }
    return best;
  }

  /** Surface temperature: latitude-driven with a slow drift (plan §13 input). */
  temperatureAt(x: number, y: number, z: number): number {
    const lat = 1 - Math.abs(y);
    const drift = fbm(x * 2.2 + 9.1, y * 2.2 + 3.3, z * 2.2 + 7.7, 2, this.seed + 47) - 0.5;
    return clamp(0.12 + this.archetype.climate.temperature * 0.52 + lat * 0.5 + drift * 0.14, 0, 1);
  }

  /** Necrotic corruption: the archetype's base plus vein fields (plan §13 input). */
  corruptionAt(x: number, y: number, z: number): number {
    const vein = smoothstep(0.52, 0.9, fbm(x * 2.4 + 4.4, y * 2.4 + 1.1, z * 2.4 + 8.6, 2, this.seed + 131)) * this.archetype.veinStrength;
    return clamp(this.archetype.climate.corruption * 0.7 + vein * 0.55, 0, 1);
  }

  /** The site influence of the last `sample` call (0 = none) + its landmark. */
  lastSite(): { t: number; landmark: Landmark | null } {
    return { t: this.lastSiteT, landmark: this.lastSiteIdx >= 0 ? this.landmarks[this.lastSiteIdx] : null };
  }
}
