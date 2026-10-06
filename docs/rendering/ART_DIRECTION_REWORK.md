# NecroFall — Visual + Performance Rework (art-direction plan): implementation record

This is the delivery record for the *NECROFALL — VISUAL + PERFORMANCE REWORK* plan (the 77-section
document, phases 1–9 in §72). It maps every phase checkbox to what lives in the repo today, states
the deliberate deviations and why, and lists the exact commands and captures that reproduce the
verification.

Two rules from the plan are kept everywhere:

* **do not solve visual quality with more objects** (§75) — the upgrade is materials + lighting +
  masks + atmosphere + silhouette + composition + VFX; geometry and CPU work stay controlled;
* **preserve the existing grass art style** (§8/§77) — the blade geometry, density character and
  world-space (never player-following) placement are untouched; grass changed only in *shading*.

---

## Phase 1 — ART FOUNDATION ✅

| Item | Where |
| --- | --- |
| `ArtDirection.ts` | [`src/rendering/ArtDirection.ts`](../../src/rendering/ArtDirection.ts) — the ONE tuning document (`terrain`, `cel`, `atmosphere`, `vegetation`, `radiation`, `outlines`, `lighting`) + `SKY_PALETTE` |
| global palette | the shipped `RADIOACTIVE_PALETTE` + the new `SKY_PALETTE`; the 80/15/5 rule is the emission-tier system (below) |
| cel-shaded terrain / grass / rocks / vegetation | ONE implementation: [`CelShading.ts`](../../src/rendering/materials/CelShading.ts) quantises the shared ramp inside [`MeshDefaultMaterial`](../../src/rendering/materials/MeshDefaultMaterial.ts) — the class every environment surface already shades through (terrain, grass, bushes, trees, rocks, spikes) |
| shared sun lighting | pre-existing [`Lighting.ts`](../../src/rendering/Environment/Lighting.ts); its intensity now reads `ART_DIRECTION.lighting.sunIntensity` |

Cel contract (plan §3): `dot(N, sun)` → `smoothstep(shipped shadow edges)` → quantised at
`0.25 / 0.6 / 0.82` with `softness 0.04` → 4 bands. Terrain additionally multiplies the lit part by
the `shadow → mid → light` ladder (`0.72 / 0.88 / 1.08`, plan §2). `?cel=0` restores the exact
pre-rework smooth ramp (A/B measured: 5.1 % of spawn-view pixels change between the two modes).

## Phase 2 — TERRAIN ✅

| Item | Where |
| --- | --- |
| TerrainField | the existing pair **is** the shared structure: [`PlanetSurfaceData.ts`](../../src/planet/PlanetSurfaceData.ts) holds the typed arrays (`heights`, `channels1`, `channels2`) and [`PlanetSurface.ts`](../../src/planet/PlanetSurface.ts) is the single CPU query API — grass, foliage, rocks, crystals, puddles, particles and physics all already sample it |
| height / slope / wetness / radiation / biome masks | `tex1` (R height01 · G grass · B wetness · A radiation) + `tex2` (R rock · G biome · B puddle), baked from the same estimates the CPU uses |
| terrain noise (large + medium + fine) | [`TerrainMaterial.ts`](../../src/rendering/materials/TerrainMaterial.ts) — patch (broad patches), perlin ×6 (colour breakup), perlin ×26 (material breakup) |
| elevation bands | five noise-blended bands (`0.16→0.30`, `0.40→0.58`, `0.60→0.76`, `0.78→0.90`) — never a bare horizontal line |
| slope-based materials (plan §7) | fragment-normal `slope = 1 − N·up`, rock exposure from `0.34 → 0.72` |
| biome transitions (plan §65) | the biome channel + corruption/moisture fields already blend continuously in `PlanetGenerator`; the material consumes them as a wash instead of a hard swap |

## Phase 3 — PLANET COMPOSITION ✅

| Item | Where |
| --- | --- |
| biome profiles | pre-existing [`PlanetBiomes.ts`](../../src/planet/PlanetBiomes.ts) (per-biome grass/bush/tree/rock/crystal/spike/radiation/wetness) |
| vegetation rules | `PlanetSurface.sample()` filters (slope, water, grass, radiation) already gate every scatter |
| clusters + landmark props | NEW [`Landmarks.ts`](../../src/rendering/Environment/Landmarks.ts): per-landmark compositions (crystal grove, dead forest / bone valley, toxic lake shards, ruined colony, Necrophage nest, fungal forest, floating rock field) — 104 props / 8 sites on the default planet |
| landmark generator | pre-existing [`LandmarkGenerator.ts`](../../src/world/LandmarkGenerator.ts) (carves the height field, blends biome colour, biases enemy ecology); the new layer gives each carved site its VISUAL composition (plan §16–§18) |
| hero landmarks | ONE major formation per planet (plan §18): giant shard cluster + energy beam, ruined colony tower, or jittered monolith — non-instanced so the selective outline can wrap it; the dev overlay reports it (`landmarks 104 props · hero COLONY_WRECK #3`) |
| radiation zones | pre-existing radiation mask/crystals/particles; terrain now darkens + tints + glows inside them (plan §4/§66) |

## Phase 4 — GRASS ✅ (geometry preserved)

* blade geometry, planet-wide static field, sector split, LOD bands + dithered fades, GPU wind
  deformation: pre-existing ([`Grass.ts`](../../src/rendering/Environment/Grass.ts),
  [`GrassLOD.ts`](../../src/rendering/Environment/GrassLOD.ts)) and untouched;
* cel shading arrives through the shared material (Phase 1);
* root→tip gradient, per-blade variation and the tip glow are the shipped tuned features; their
  constants now live in `ART_DIRECTION.vegetation` (saturation `1.32`, variation `±12 %`);
* never player-following: the field is baked at build; the only runtime inputs are the parting push
  and the shared wind.

## Phase 5 — ATMOSPHERE ✅

| Item | Where |
| --- | --- |
| horizon haze + distance colour compression (plan §19–§21/§60) | `TerrainMaterial` mixes toward `SKY_PALETTE.horizon` (desaturating first) over `hazeStart 50 → hazeEnd 140`, strength `0.45`; the shipped distance fog (34 → 270 m) still carries the far wall |
| atmospheric rim (plan §20) | grazing-angle Fresnel lift on terrain, `pow 2.2`, strength `0.28`, gated to 18–110 m (no neon outline) |
| sci-fi sky (plan §22) | NEW [`SkyDome.ts`](../../src/rendering/Environment/SkyDome.ts): one inverted sphere — horizon→zenith gradient, drifting cloud bands, orbital dust specks, a banded giant, a moon and a sun disc whose core alone feeds the bloom |
| subtle atmospheric particles | pre-existing [`FloatingParticles.ts`](../../src/rendering/Environment/FloatingParticles.ts) (planet-anchored, shader-animated) |

Ordering note: the renderer runs with `sortObjects = false`, so the dome is inserted **first** and
depth-tested (never depth-written) — the planet is always the hero regardless of draw order.

## Phase 6 — SCI-FI VFX ✅

| Item | Where |
| --- | --- |
| emissive material (plan §25) | NEW [`EmissiveMaterial.ts`](../../src/rendering/materials/EmissiveMaterial.ts): `colour × intensity × bloomTier × (1 + sin(t·speed)·amount)`, facet shading, uv/height gradients |
| controlled bloom (plan §26) | the tier scale (high 1.0 / medium 0.62 / low 0.3) rides the shipped threshold `0.9` bloom: Nexus-class hot cores bloom, crystals bloom, environment accents stay under the threshold |
| crystals | [`RadioactiveCrystals.ts`](../../src/rendering/Environment/RadioactiveCrystals.ts) now builds through the shared emissive factory (same tuned output, one source of truth) |
| radiation particles / Nexus beam / Beacon states / boss rage / ability VFX | pre-existing systems (`FloatingParticles`, `Towers.ts` beam core + halo + ward ring, `Enemies.ts` rage particles + `bossrage` event, `Effects.ts` ability effects); the rework adds the planet-level identity they sit in |
| selective outlines (plan §59) | NEW [`OutlineMaterial.ts`](../../src/rendering/materials/OutlineMaterial.ts) — inverted hull, applied to the hero formation; see deviations for gameplay entities |
| radioactive ground glow | `TerrainMaterial` glow term from the radiation mask, tinted by the noise field (§4/§66) |

## Phase 7 — PERFORMANCE ✅ (with two documented deviations)

Pre-existing and verified: instancing everywhere ([`Rocks`](../../src/rendering/Environment/Rocks.ts),
`Trees`, `Bushes`, `Spikes`, `RadioactiveCrystals`, new `Landmarks`), shared materials
([`Materials.ts`](../../src/rendering/materials/Materials.ts) registry), particle pooling, disposal
registry ([`ResourceRegistry.ts`](../../src/rendering/ResourceRegistry.ts) + r186
`Object3D.dispose`), hot-loop scratch objects, mobile DPR ladder
(`PERF.dprLadder` in `Game.updateRenderScale`) and the thermal watchdog
([`Quality.monitor`](../../src/rendering/Quality.ts)).

Measured on the dev world, same spawn framing, quality 0, 1280×720:

| | cel + sky + landmarks OFF | ON |
| --- | --- | --- |
| fps | 48–54 | 50–52 |
| draws | 47 | 79 |
| triangles | 1,343,691 | 1,349,787 |

The whole overhaul costs +32 draw calls and +0.4 % triangles with no measurable frame-time change
(the emissive/low-poly props are cheap; the sky, terrain noise and cel are shader work on
already-existing passes). `?cel=0`, `?sky=0`, `?landmarks=0` isolate each layer for A/B on-device.

**Deviations:**

* **worker planet generation (plan §41) not landed.** The bake already yields to the event loop
  behind the loading screen and the deterministic generators are shared with matchmaking; moving
  them into a worker changes the world-build critical path for a load-time win only. The
  `DebugSwitches` vocabulary keeps the rule "a build flag is added with its consumer", so no
  `VITE_WORLD_WORKER` flag exists yet.
* **GPU-compute particles (plan §37) not landed.** The shipped fields are already GPU-animated
  billboard systems with zero per-frame CPU particle work; a compute rewrite would add a WebGPU-only
  path (the WebGL fallback would need the current one anyway) without a measured frame win.

## Phase 8 — GAMEPLAY PERFORMANCE ✅ (pre-existing)

[`SpatialHash`](../../src/utils/SpatialHash.ts), [`SwarmDirector`](../../src/enemies/SwarmDirector.ts)
(id-staggered hysteretic simulation tiers + population target), projectile pooling and the server
tick scheduling shipped in the r186 pass and are unchanged.

## Phase 9 — NETWORK ✅ (pre-existing)

[`RenderState`](../../src/game/RenderState.ts) is the render/network boundary, remote players
interpolate through `Player.ts`'s buffer driven by [`ClockSync`](../../src/networking/ClockSync.ts),
and the SpacetimeDB layer subscribes scoped queries only
([`subscriptions.ts`](../../src/app/spacetimedb/subscriptions.ts) — never the whole universe).
The overlay now reports the host clock's arrival spread as the interpolation-delay readout.

The plan's rate checks resolve to the shipped server design (all pre-existing, unchanged here):
`TICK_INTERVAL_US = 100_000n` — a **10 Hz authoritative simulation** whose frame the relay carries
at **12 Hz snapshots + ≤20 Hz player poses**, with a fixed-window mutation budget
(`MSG_MAX_PER_WINDOW = 140`, `MSG_EVENT_RESERVE = 60`) that keeps one-shot gameplay events from
being starved by state streams (see `spacetimedb/src/game/relay.ts`). Visual effects are never
networked — every client renders grass, terrain, particles and VFX locally (plan §51).

---

## Deliberate deviations (summary)

1. **Sun intensity `2.35`** kept in `ART_DIRECTION.lighting.sunIntensity` (the plan's `2.0` assumed a
   new lighting rig; re-exposing the shipped, tuned rig would darken every surface for no gain).
2. **Outlines apply to the hero formation only.** Gameplay entities are individual procedural meshes
   created/recycled by gameplay systems; a hull child per creature would break their transform
   discipline and add noise the plan explicitly warns against (§59). The hull factory is in place for
   whichever entity later needs a menu-level identity.
3. **`?view=` capture aid is dev-world only** (free camera + landmark index) — it exists so the
   plan §70 visual regression capture is deterministic and steerless.
4. **S25-Ultra 10/20/30-minute matrix (plan §71) is a device test**, not reproducible from this
   repository; the governors it targets (DPR ladder, quality watchdog, thermal hysteresis) shipped
   earlier and are untouched.
5. **Phase 8 / Phase 9 are pre-existing deliveries** (spatial hash, swarm tiers, pooling, relay
   budget, scoped subscriptions) — this pass verified and documented them rather than rewriting
   working systems, exactly as the plan's own priority order (§76 items 18–19) ranks them.

## Switches (plan §69/§90)

| Switch | Effect |
| --- | --- |
| `?cel=0` | pre-rework smooth lighting ramp (A/B) |
| `?sky=0` | sci-fi sky dome off |
| `?landmarks=0` | landmark props + hero formation off |
| `?outlines=0` | selective outlines off |
| `?render=celoff\|skyoff\|landmarksoff` | the same via the `render=` alias vocabulary |
| `?seed=<n>` `?ring=<n>` | deterministic planet selection (plan §70) |
| `?free&view=<i>&viewAlt=<m>` | dev-world capture: hover beside landmark `i` (plan §70) |
| `?stats` / `?foliageDebug` | overlay with fps, frame, draws, triangles, grass sectors/blades, landmarks + hero, quality level, live DPR, interpolation spread |

## Verification (2026-10-06)

```
npm run typecheck          # tsc --noEmit — clean
npm run build              # tsc --noEmit && vite build
npm run test:universe      # deterministic universe/ring parity suite
```

Captured from the dev world (WebGPU backend, seed 3409486584, quality 0, 1280×720) — the
deterministic visual-regression set for this rework:

| Capture | URL |
| --- | --- |
| spawn, full stack | `#/world` |
| spawn, cel A/B | `#/world?cel=0` |
| terrain only (material check) | `#/world?grass=0&foliage=0&rocks=0&spikes=0&crystals=0&particles=0&landmarks=0` |
| landmark composition | `#/world?free&view=0&viewAlt=45` |
| hero landmark (colony tower) | `#/world?free&view=3&viewAlt=26` |
| A/B landmarks off | `#/world?free&view=3&viewAlt=45&landmarks=0` |

Files: `docs/rendering/artdirection-*.png`. Compare after any rendering change (plan §70) — the art
direction must never silently degrade.

### Bugs found and fixed during verification

* sky dome drawn last (the renderer disables object sorting) covering the world with its
  `depthTest = false` — now inserted first and depth-tested, never depth-written;
* `pow(0, 2.2)` NaN in the terrain atmosphere rim — the project's known WebGPU/D3D hazard (see
  `Grass.ts`); guarded with `max(1e-4)` (the bloom blur had smeared the NaN over the whole frame);
* crystal prop base offset — geometry lifted by `height·radius`, not `2·height·radius`, so every
  instanced shard is anchored by its own ground contact (plan §28).
