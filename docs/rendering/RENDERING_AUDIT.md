# Rendering Audit (plan §2)

> Every rendering/environment concern in `src/` and its **single owner today**. Anything two
> systems used to own is listed under "Duplicates found & resolved". This file is the map for the
> production ↔ Dev World parity rule (§30/§60) and the WGSL port traps that were fixed.

## 1. Owners by category

| Category | Owner (today) | Plan name / notes |
| --- | --- | --- |
| CORE RENDERER | `src/rendering/Rendering.ts` — the ONE `WebGPURenderer` + `RenderPipeline` (scene pass → bloom → cheap DOF → `renderOutput`) | plan "RendererSystem" + "RenderPipeline" combined in one file; `?post=0` renders the raw scene |
| RENDER QUALITY | `src/rendering/Quality.ts` (levels 0/1/2: pixel ratio, grass density, shadow map, bloom mips, DOF) | plan "RenderQuality" |
| RENDER DEBUG | `src/rendering/DebugSwitches.ts` (URL flags, stats overlay) + `src/rendering/RenderDebug.ts` (material debug modes, baseline dump, foliage debug) | plan "RenderDebug" |
| VIEW / TIME / LOOP | `Viewport.ts`, `Time.ts`, `Ticker.ts` (ordered stages; render = 998, monitoring = 999) | plan §29 order |
| ENVIRONMENT | `Environment/Lighting.ts` (sun + shadow follow + classic fill) + `Environment/Fog.ts` (sky, distance fog, legacy fog mirror) + `WorldGlobals.ts` (the shared uniform context) | plan "EnvironmentSystem" + "FogSystem" + "MaterialContext" |
| MATERIALS | `materials/MeshDefaultMaterial.ts` (the ONE environment material), `Materials.ts` (factory), `MaterialRemapper.ts`, `PlanetPalette.ts`, `NecroChunks.ts` (gameplay TSL chunks) | plan §9/§41 |
| PLANET (CPU source of truth) | `src/planet/PlanetSurface.ts` (`sample/getNormal/frame/uvOfDirection/alignToSurface`), fed by `PlanetGenerator` + `PlanetSurfaceData` (baked maps) + `PlanetSeed` | plan "PlanetSurface" / "SurfaceFrame" (`PlanetSurface.stableTangent` + `alignToSurface`) |
| WORLD FACTORY | `Environment/PlanetWorld.ts` — `createPlanetWorld(config)` used by BOTH the Dev World and every match | plan §30 |
| WORLD ORCHESTRATOR | `Environment/PlanetRenderer.ts` — ordered build + `update(focus, camera)` + `applyVisibility` | plan "Planet" orchestration |
| TERRAIN | `Environment/PlanetTerrain.ts` + `Environment/PlanetTerrainNodes.ts` — ONE mesh, ONE material; normals = finite differences of the RENDERED field | plan "TerrainRenderer" |
| GRASS | `Environment/Grass.ts` + `Environment/GrassField.ts` — ONE static field: every blade's position, patch acceptance and size are BAKED at build over the whole planet (patch-only mask from the smooth `noises.patch` field — large packed clumps, zero blades on bare ground). Runtime = wind + player parting only | plan "GrassSystem" / "FoliageTile" (field model, not tile meshes) |
| TREES / BUSHES | `Environment/Trees.ts` (3 species, trunk `InstancedMesh` + `Foliage.ts` leaf-card canopies) | plan "TreeSystem"/"BushSystem" |
| ROCKS / SPIKES / CRYSTALS | `Environment/Rocks.ts`, `Spikes.ts`, `RadioactiveCrystals.ts` (shared `InstancedField` pattern) | plan "RockSystem"/props |
| WATER | `Environment/Puddles.ts` — basin films bent onto the water sphere + walk-wake | plan "PlanetWaterSurface" |
| ATMOSPHERE | `Environment/FloatingParticles.ts` (contamination motes), sky = `Fog.skyColor` background node | plan "PROPS"/sky |
| WIND | `Environment/Wind.ts` — ONE field; derived from the planet's noises inside `createPlanetWorld` | plan §18 |
| VISIBILITY / CULLING | CPU-side per system: trees/bushes/rocks/spikes/crystals fade-cull by distance; grass needs none — the field is static and every patch is dense everywhere | no tile streaming in this build (see §4) |
| PHYSICS SURFACE | `Physics/PlanetCollider.ts` + `Physics/PhysicsSurface.ts` (analytic, samples `PlanetSurface`) | plan §41 |
| GAMEPLAY VISUALS (TSL) | `towers/ShieldMaterial.ts`, `towers/PowerLines.ts`, `effects/Telegraphs.ts`, `effects/Effects.ts`, `effects/BillboardParticles.ts`, `enemies/EnemyModels.ts`, `customization/MoteEmitter.ts` | gameplay reads `NecroChunks` — its `NECRO_UNIFORMS` are synced from the folio `WorldGlobals` each frame (same sun, ambient and range fog as the world; `SHADER_GLOBALS` is only the pre-world fallback) |
| GAMEPLAY VISUALS (classic) | Lambert/Basic materials in `player/`, `towers/`, `world/Bases|Pads`, `effects/`, … — lit by the ONE classic fill owned by `Lighting` | §54: gameplay not rewritten; it consumes the environment owner |
| UI PREVIEW RENDERERS | `ui/ItemThumbs.ts`, `ui/SelectionPreview.ts` build their own tiny offscreen `WebGPURenderer`s | **Sanctioned exception** (§3): they never render the world and share no resources with the world renderer |

## 2. Duplicates found & resolved

1. **Game scene double environment (fixed).** `Game.ts` used to add its own `THREE.FogExp2` +
   purple `HemisphereLight` + rim `DirectionalLight` next to the folio rig. Moved INTO the
   environment owners (`Fog` owns the legacy mirror, `Lighting` owns the classic fill) so exactly
   one system controls every light/fog in the scene. `MeshDefaultMaterial.fog = false` stops the
   scene mirror from double-fogging folio materials (they shade fog through `WorldGlobals.fog`).
2. **Wind seed divergence (fixed).** The game previously built a shared wind from a FIXED noise
   seed while the dev world derived it from the planet seed. `createPlanetWorld` now derives ONE
   wind from `seed ^ 0x51ab` for both worlds (§30/§31).
3. **Two lighting models (fixed).** Gameplay TSL materials shaded through `NecroChunks` reading the
   legacy purple `SHADER_GLOBALS` (its own sun that followed the player, purple ambient, exp²
   purple fog) while the world shaded with the folio rig — objects never matched the ground under
   them. `syncNecroChunks` now mirrors the folio environment (same sun direction/colour, warm
   ambient family, SAME range fog `smoothstep(near, far, d)` + fog colour). `SHADER_GLOBALS`
   remains only as the pre-world fallback.
4. **Two construction paths (fixed).** Dev world and match built the planet stack inline,
   duplicating (and drifting): seed handling, bake, node creation, globals, materials order.
   `createPlanetWorld` is now the single path.
5. **One terrain generator (kept).** `PlanetGenerator` (renderer side) wraps the SAME
   `TerrainGenerator`/`BiomeGenerator` the gameplay `Planet` facade uses; the rank-match bias
   (`focusDir`) flows through both (§48: no camera-relative sampling anywhere).

## 3. WGSL port traps found (GLSL idioms that are wrong on WebGPU)

1. **Reversed-edge `smoothstep` (the black-cluster root cause).** GLSL allows
   `smoothstep(edge0 > edge1, x)` as a falling edge; WGSL defines smoothstep only for **ascending**
   edges and Tint evaluated the reversed form to **1 for lit normals**. Every surface therefore
   rendered as if fully in core shadow — grass clumps went black, the whole field collapsed to
   shadow colour, water foam/shore bands inverted. Fixed at all 12 GPU call sites by rewriting to
   `smoothstep(low, high, x).oneMinus()`:
   `MeshDefaultMaterial` (core shadow), `Grass` (push + trample ×2), `Puddles` (wake fresh/reach,
   shore, wet ring), `BillboardParticles` (soft disc), `FloatingParticles` (circle),
   `ShieldMaterial` (bands ×2).
2. **`flipBackfaceNormal` for blade cards (fixed).** `DoubleSide` backface normal flipping is right
   for solid props but wrong for grass blades (a one-sided card): half the field flipped its
   radial normal into the core-shadow mix. The flip is now per-material (`false` for grass).
3. **Points/`gl_PointSize` do not exist in WGSL** — all particle systems use
   `effects/BillboardParticles.ts` (instanced quads). No `THREE.Points` in `src/`.
4. **`ShaderMaterial` must never come back** — no GLSL material remains in `src/`.
5. **Frame-stable shader inputs (the grass "popping while moving" lineage).** The first field was a
   tangent patch that re-based onto the player every ~17 m, rewriting every blade's frame-local
   coords — the height/wind/rim inputs therefore re-rolled the field per re-base. Those inputs were
   made world-stable, then the whole design was replaced: the field is now STATIC and
   PLANET-WIDE (every blade baked at build — nothing streams as the player moves, so no pop is
   possible by construction). Runtime per-blade inputs are wind (world position) + the player
   parting/trail only. The patch mask is the smooth single-octave `noises.patch` field so clumps
   read as large fields, never small fragmented islands.

## 4. Deliberate deviations from the plan's file layout

The plan (§53) proposes `src/world/planet/…`, `src/world/foliage/…`, `src/rendering/*.ts` names.
The living code uses `src/rendering/Environment/…`, `src/planet/…` — the same ownership with
different paths. Renaming the tree would churn every import for zero behavioural gain; the
mapping above is the contract. Behavioural deviations:

* **Terrain LOD (§37/§38):** the planet is ONE 320×160 mesh (1 draw, ~61 k verts) — a single
  shell IS the simplified far-LOD. Per-tile spherical LOD is only worth it if the base resolution
  rises; `frustumCulled = false` on the planet mesh means horizon tests are unnecessary for a
  closed sphere (backfaces are shaded via DoubleSide instead). Revisit when terrain detail grows.
* **Foliage tiles (§14):** grass is folio's continuous field (subdivisions² blades, ONE draw)
  but it is NOT a camera-following window: the field is baked over the entire planet at build
  (patch-only acceptance from the shared smooth patch mask; blades suppressed in water basins at
  bake time). Trees/bushes/rocks ARE per-instance `InstancedMesh` with CPU distance culling. The
  blade's surface position is baked into the geometry, so the vertex stage reads no terrain.
* **Post pipeline (§25):** `?post=0` renders raw; bloom raised per playtest (threshold 0.85,
  strength 0.55 — keys on emissives; shields/rays push their colours past 1), DOF keeps folio's
  cheap level-0 form.

## 5. Debug tooling (plan §10/§33) — all in `RenderDebug.ts`

```
?render=normal|unlit|normals|lighting|shadow|dot|core|dir|terrain|biome|slope|height|fog
?materialDebug=<same>          alias
?render=fogoff|shadowsOff|grassOff|treesOff|postOff   component aliases
?post=0 ?fog=0 ?shadows=0 ?grass=0 ?foliage=0 ?rocks=0 ?spikes=0 ?crystals=0 ?water=0 ?particles=0
?wireframe ?quality=0|1|2 ?renderBaseline=1 ?foliageDebug=1 ?stats
```

`shadow` renders `(R=core, G=drop, B=root-shade)`; `dot` shows raw `dot(normal, sun)`;
`dir` shows the fragment direction — together they localise any future shading regression in one
page load. All modes work identically in the Dev World and in a production match.

## 6. Performance rules in force (§34)

* Nothing is created/destroyed per frame — materials/geometries are per-build; visibility flips
  booleans; `PlanetRenderer.update` only moves uniforms.
* Per-frame update paths are allocation-free (Lighting/`Wind`/`Puddles`/`FloatingParticles`
  scratch vectors; Grass runs no per-frame pass at all beyond the parting uniforms + trail ring).
* Grass instance budget: 1.44 M blades (level 0 — patch-only placement; cores run above
  35 blades/m² so the ribbons overlap and the gaps close; quality ladder 840²/560² = 706 k/314 k)
  rendered as ONE draw; the 18-slot trample loop is BRANCHED to blades within 1.7 m of the
  player. Trees/bushes/rocks are instanced; terrain is 1 draw.
* Camera rig: fixed 40° elevation (`atan(CONFIG.camera.height / CONFIG.camera.distance)` ⇒ the
  focus→camera line sits at exactly 40°); the heading is parallel-transported, the pitch never
  changes in play.
* Shadow budget (§36): terrain receives; trees/rocks cast+receive; grass neither casts nor
  receives; particles never shadow.

## 7. Color management audit (§26)

| Texture | Space | Why |
| --- | --- | --- |
| `tex1` / `tex2` (baked planet maps, DataTexture) | `NoColorSpace` (default) | data channels (height/grass/wetness/radiation), never displayed raw |
| terrain gradient ramp (`createTerrainGradient`) | `SRGBColorSpace` | it IS artwork |
| palette atlas (`createPaletteAtlas`) | `SRGBColorSpace` | artwork rows |
| foliage SDF (`PreRenderer.createFoliageSDF`) | `NoColorSpace` (CanvasTexture default) | alpha mask, nearest, no mipmaps |
| GLB textures (folios tree kits) | set by `GLTFLoader` per slot (sRGB base colour, linear data) | not overridden anywhere |

## 8. Coordinates & precision (§48/§49)

All terrain noise samples the **planet-local unit direction** (or the planet-local position, which
normalises to it) — never camera-relative, never chunk-relative coordinates. The world is
planet-local end to end (centre at origin, radius ≈ 118 m), so no floating-origin rebase is
required at the current scale; the gameplay `Planet` facade and the renderer share these
coordinates exactly.
