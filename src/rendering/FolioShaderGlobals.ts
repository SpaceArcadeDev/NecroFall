// NECROFALL — Folio 2025 environment state, expressed as shared TSL uniforms (plan §58).
//
// Folio's materials read one ambient "game" object (game.lighting / game.fog / game.wind /
// game.water / game.reveal). NecroFall keeps that exact architecture, but as this module: one
// singleton of uniform nodes every Folio material family reads by reference, so a single write
// per frame updates the whole world.
//
// The GLSL twin (`world/ShaderGlobals.ts`) stays for the remaining gameplay materials until they
// are ported; both are fed from the same Game state so the two halves can never disagree while
// the migration is in flight.
import * as THREE from 'three/webgpu';
import { uniform, color } from 'three/tsl';
import { Wind } from './Environment/Wind';
import { Fog } from './Environment/Fog';

/**
 * Shared light state. Folio's MeshDefaultMaterial shades with THIS, not with three lights —
 * the real DirectionalLight only exists to cast shadows.
 */
class FolioLighting {
  /** Unit vector the sun shines FROM (leaf→sun direction is the material's sample direction). */
  readonly direction = uniform(new THREE.Vector3(0.55, 0.5, 0.35).normalize());
  readonly color = uniform(color('#fff3dd'));
  readonly intensity = uniform(1.32);
  /**
   * Tint used for the shadowed side of a surface — Folio's signature COLOURED shadow (their day
   * preset #6d3fff, night #2f00db: shadows are saturated blue-violet, never dark grey).
   *
   * The old near-black #4a3f63 made every shade-side surface almost invisible: tree canopies
   * (leaf planes half face away from the sun at all times) read as if the trees had no leaves
   * at all — the user's "trees canopy missing" report (live review 2026-09-30).
   */
  readonly shadowColor = uniform(color('#5b4bc4'));
  /** Colour of the "light bounce" — ground/sky light smeared back onto undersides. */
  readonly bounceColor = uniform(color('#7f6a9e'));

  readonly coreShadowEdgeLow = uniform(-0.25);
  readonly coreShadowEdgeHigh = uniform(1);

  readonly lightBounceEdgeLow = uniform(-1);
  readonly lightBounceEdgeHigh = uniform(1);
  /** Depth of the bounce above the surface, in world units (planet-scaled). */
  readonly lightBounceDistance = uniform(2.2);
  readonly lightBounceMultiplier = uniform(0.9);

  /** Hemisphere fill (replaces three's HemisphereLight for Folio materials). */
  readonly skyColor = uniform(color('#9fc0f0'));
  readonly groundColor = uniform(color('#6a5a78'));
  /** Rim light tint NecroFall adds to silhouettes. */
  readonly rimColor = uniform(color('#c9b6ff'));
}

/** Water surface state shared between the material blend and the gameplay queries. */
class FolioWater {
  /** Surface elevation ABOVE the planet radius this match (metres along the radial). */
  readonly surfaceElevation = uniform(0);
  readonly surfaceThickness = uniform(0.06);
  readonly amplitude = uniform(0.35);
  /** 0 = dry world, 1 = full look; drives quality/rescue cuts. */
  readonly quality = uniform(1);
}

/** Planet-wide reveal (used by the match intro to wash the world in). */
class FolioReveal {
  /** Screen-independent world anchor: the direction of the reveal centre (unit). */
  readonly position = uniform(new THREE.Vector3(0, 1, 0));
  readonly distance = uniform(9999);
  readonly thickness = uniform(30);
  readonly color = uniform(color('#c9b6ff'));
  readonly intensity = uniform(1);
  active = false;
}

/** NecroFall flavour uniforms the terrain/foliage palette nodes read. */
class FolioNecro {
  /** Global corruption strength 0..1 (biome-driven, raised in battle-contaminated zones). */
  readonly intensity = uniform(0.5);
  readonly veinColor = uniform(color('#b06cff'));
  /** Battlefield centre direction — drives contamination around the contested towers. */
  readonly focusDirection = uniform(new THREE.Vector3(0, 1, 0));
}

/**
 * The current planet's relief band + waterline, shared like wind/lighting. Written once per
 * planet by `Planet`'s constructor. Grass blade bases, the terrain's shoreline wash and the
 * water washes all read THIS object — the module-level palette copies could split across the
 * dev server's module graph, leaving the grass buried at radius 0 (live bug 2026-09-30).
 */
class FolioTerrainBand {
  /** Radius band that height01 spans. */
  readonly reliefMin = uniform(0);
  readonly reliefMax = uniform(1);
  /** Waterline as height01 (everything below it is submerged); -1 = dry world. */
  readonly waterline01 = uniform(-1);
}

/**
 * The shared environment state. `update()` is called once per frame by FolioWorld; everything
 * else only ever writes uniforms.
 */
class FolioState {
  readonly time = uniform(0);
  readonly delta = uniform(0);
  readonly cameraPosition = uniform(new THREE.Vector3());
  readonly planetRadius = uniform(118);
  /** 0..3: how far the quality/rescue ladder has stripped the environment. */
  readonly qualityStep = uniform(0);
  /** 0..1: how much environmental animation may run (menus sleep at 0 — plan §106/§107). */
  readonly activity = uniform(1);

  readonly lighting = new FolioLighting();
  readonly fog = new Fog();
  readonly wind = new Wind();
  readonly water = new FolioWater();
  readonly reveal = new FolioReveal();
  readonly necro = new FolioNecro();
  readonly terrain = new FolioTerrainBand();

  /** Feed the per-frame state that is not gameplay-owned (time, camera, wind clock). */
  update(dt: number, cameraPos: THREE.Vector3): void {
    this.time.value += dt * this.activity.value;
    this.delta.value = dt;
    this.cameraPosition.value.copy(cameraPos);

    // Wind: folio's exact drive — a constant direction, and a local clock that advances with the
    // strength. No angle wander: the gust fronts travel along ONE axis.
    this.wind.advance(dt);
  }
}

/** The one shared instance. Materials import this; FolioWorld drives it. */
export const FOLIO = new FolioState();
