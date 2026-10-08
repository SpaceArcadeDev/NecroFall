# NECROFALL Base Planets

## Current ten-planet environment preview

Open `http://localhost:5190/base-planets.html` while the current preview server
is running. A fresh `npm run dev:base-planets` normally uses port 5188. The old
`concepts.html?assets=1` URL and concept commands remain compatibility aliases.
The profiles are now called **base planets**: reusable themes for seeded generation,
not ten fixed levels. `BASE_PLANETS` exports their palettes, terrain types and seeds;
`BASE_FEATURES` supplies their three feature recipes. Existing `STUDIES` imports
remain supported.

The original five environment palettes were approved by the user. Five additional
themes are now available, each with distinct landforms and a normal/radiated state.
The original normal palettes are preserved; Frostwound's water is now frozen.
The accepted enemy model, textures and rig remain unchanged.

| Planet | Landform / Surface | Ambient Effects | Radiation Accent |
| --- | --- | --- | --- |
| Cinderbloom | Rolling forest valley | Original-style floating lights | Lime grass tips and mineral veins |
| Glass Tide | Island shelves and blue shallows | Wind-driven rain and surface impact rings | Pink luminescence |
| Saffron Waste | Terraced badlands | Ground heat refraction and fine dust | Orange-red mineral seams |
| Mycelial Night | Fungal wetland | Tumbling filamented spores | Mint fungal/foliage glow |
| Frostwound | Glacial ridges and frozen water | Textured snowflakes | Crimson fractures within static ice |
| Verdant Tempest | Jade monsoon ravines and tributaries | Rain, impacts and drifting spores | Yellow-green leaf veins |
| Emberwake | Basalt caldera and lava basins | Rising embers and heat refraction | Green contamination against molten orange |
| Roseshard Basin | Terraced salt pans and rose brine | Slowly rotating salt flakes | Turquoise mineral glow |
| Stormglass Reach | Cobalt plateaus and deep faults | Rain, impacts and sparse electrical motes | Gold currents |
| Aether Garden | Elevated terraces and floating groves | Rotating petal particles | Pink foliage luminescence |

### Geological Assets and Traversal

Every base has giant rock spikes and glowing crystal clusters. Spikes use the
original five-sided `ConeGeometry(0.34, 2.4, 5)` shape, enlarged to landmark scale.
Each cluster shares a seeded random tilt, and the spikes stay rock-coloured in both
states. Crystals use the original `OctahedronGeometry(0.46, 0)` stretched by
`(0.5, 1.9, 0.5)` and raised by `0.75`, with the original cluster/shard scaling
ranges and independent random tilts. Their glow follows the base palette.

Mountains retain the authored cliff fronts and silhouettes the user preferred,
with sculpted mirrored backs and thick rounded sides. Ordinary boulders remain
a separate asset family. Flat caps were insufficient, and replacing the mountain
family with enlarged boulders lost its intended silhouette. Both mountain LODs
are complete volumes; source GLBs remain unchanged.

Ordinary boulder and mountain bases conform to the rendered terrain instead of
merely touching it at one point. Their upper forms are retained; static render
batches and per-rock collision ranges share the resulting vertex buffers. The
whole foot polygon of each tilted spike is buried into the terrain without
changing its shape, scale or cluster angle. Only Aether Garden has deliberately
floating outcrops (six); ordinary rocks on all other bases must be grounded.

`BaseSurface` queries the actual placed rock geometry and the exact rendered
terrain triangles. Vegetation is placed after geological footprints are known,
so ground grass and tree roots do not grow beneath those footprints. The preview
auto-steps obstacles up to 1.5 metres, permits slopes up to 45 degrees, and blocks
steep rock faces, crystals, spikes and lava. Spawn selection checks an area around
the body rather than only the centre point.

Use **Walk** with WASD or the touch arrows, and drag to look. **Orbit view** or
**Reset view** exits walking. This is a planar terrain-patch traversal preview,
not integration into the original spherical gameplay controller.

### Three Features per Base

| Base | Feature One | Feature Two | Feature Three |
| --- | --- | --- | --- |
| Cinderbloom | Cinder lilies | Ember reeds | Pollen hollows |
| Glass Tide | Tide anemones | Ribbon kelp | Tidal gyres |
| Saffron Waste | Solar cups | Razor sedges | Dust devils |
| Mycelial Night | Lantern pods | Spore ferns | Spore hollows |
| Frostwound | Frost bells | Ice blades | Blizzard pockets |
| Verdant Tempest | Rain orchids | Giant ferns | Mist gullies |
| Emberwake | Lava vents | Ash flowers | Fumaroles |
| Roseshard Basin | Salt rosettes | Glass sedges | Brine gyres |
| Stormglass Reach | Storm lilies | Conductive reeds | Ion vortices |
| Aether Garden | Sky lotus | Suspended seedpods | Cloud ribbons |

Flora uses instanced, closed petal/leaf geometry with seeded placements and shader
wind. Mini-volcanoes have complete crater walls and visible molten pools. Gyres
cut the liquid surface and fit their upward-facing bowls above the bed. Local
mist uses an eight-step, depth-clipped volume shader; vortices and blizzards remain
visual region effects rather than fluid or weather-physics simulations.

Feature placement ranks seeded foreground candidates using the arrival camera's
projection, terrain visibility and rock occlusion. Several local weather pockets
are used instead of a single easily missed one. This presentation preview can
adapt placement to the quality tier and viewport; persist generated instance data
when integrating it into shared gameplay. Roseshard has a seeded brine basin in
the arrival area so its gyre has suitable, visible water. The basin is reserved
from rock intrusion.

Radiated grass now concentrates strong emission at the tips of a seeded subset
of blades, including the mobile population, instead of washing the entire patch.
**Focus blur** adds a slight screen-space falloff away from the centre, leaving
the centre sharp and the HTML interface unaffected. It is not physical depth of
field. Inspections disable it. The scene uses a single-sample depth-readable pass,
FXAA, and a half-resolution blur: sampling the original multisampled depth caused
a WebGPU validation error and blank frames.

**Normal / Radiated** changes material uniforms in the current scene. It does not
regenerate geometry, reseed placements, move the camera or restart animation.
Radiation affects grass tips, leaf edges/veins, terrain and rock seams, water/ice,
and the seeded orbital fissures and atmosphere. It uses emission, not a full-screen
color overlay or a bloom pass. State and the weather toggle are encoded in the URL;
capture filenames include state. The parasite-only view remains unchanged.

Weather uses one to three world-anchored mesh batches per surface biome, with lower
mobile counts and no per-particle CPU updates. Rain is gravity-aligned, wind-driven,
non-additive and faded near the camera, with timed impact rings. Heat samples the
scene texture through 7-11 metre upward-moving refraction ribbons above clear dry
ground, not orange sprite wisps. Some emitters are biased toward the foreground;
emitters remain world-anchored and are rejected beneath rock footprints.
Spore, snow, salt and petal particles use generated alpha textures and slow rotation.
This replaces the first weather pass, which the user rejected as visually crude.
Floating light motes retain their original appearance. Pause freezes all shader
clocks; reduced-motion preference starts paused. Weather is absent in orbit and
isolated asset inspections (the feature inspection retains its local effects).
These are bounded base-planet effects, not a fluid simulation
or a claim of AAA fidelity.

Use **Inspect** for Terrain, Grass patches, Water, Trees / flora, Rock formations,
Spikes / crystals, or Base features. Inspections allow full-angle orbiting and
remove distance fog and focus blur so they cannot hide geometry defects. Surface
restores the composed scene; Orbit shows the planet. Weather can also be disabled
to inspect the solid assets without local mist or particles. The **This base**
group in Inspect lists all three named features and frames the selected feature
directly. The selection is shareable through the `feature` URL parameter.

### Asset-by-asset reference review

| Asset | Reference cue | Implemented revision |
| --- | --- | --- |
| Terrain | Large, readable colored landforms rather than photographic grain | Explicit cel bands and colored shadows; rolling valley, island shelves, terraced badlands, wetlands, and glacial ridges use different height functions. |
| Grass | Dense irregular patches with fine, varied blades | Reuses the original GrassField coverage curve and acceptance power; shader-shaped, camera-facing bent blades, root-to-tip color and coherent wind, divided into cullable sectors. |
| Water | Clean cool colors, shallow/deep distinction and restrained surface detail | Adapts the original Puddles screen-compositing and foam approach with a cool depth palette, wet mask and broken ripple streaks. |
| Trees / flora | Substantial layered crowns with authored trunks | Reuses copies of the original oak/cherry/birch trunk and canopy-marker assets with the original crossed-card canopy technique. The fungal planet uses QumoDone's authored painted mushroom. |
| Rocks | Sculpted, complete volumes with deliberate light/shadow planes | Separate boulders and restored authored mountain fronts with complete backs, rounded sides and terrain-conforming bases; palette-driven cel lighting suppresses photographic grain. |
| Planets | Biome identity and parasitic coloration visible from orbit | Seeded continent, cloud and fissure maps use each study's palette with the cel material, atmosphere and ring layers. |

The individual assets and full scenes were compared visually against the supplied
concept references. Comparison captures are UI-free; neither these comparisons
nor the automated tests establish literal image equivalence or an AAA-quality
certification. Asset silhouettes and scene composition remain reviewable art
choices, especially the coastal and arid flora and the orbital presentation.

The original gameplay grass, water and tree files are not modified. The base-planet
renderer adapts their techniques and directly imports the pure GrassField helper.
Original tree GLBs are converted into separate copies with their source hashes.

Imported sources are cached separately in `.asset-sources/`; the user's original
Insectoid Monster Rig download remains in Downloads. Prepared assets and their
source/hash/modification records are in `src/concepts/assets/`. Required credits
are available through the preview's Asset Credits link and ATTRIBUTION.md.

Prepared asset cache (includes earlier source variants):

| Asset | Near Triangles | Far Triangles |
| --- | ---: | ---: |
| Adapted Jacaranda canopy | 59,929 | 5,965 |
| Eroded cliff | 10,000 | 2,599 |
| Authored grass tuft | 550 | 79 |
| Infection root source | 4,486 | 1,169 |
| Boulder | 3,735 | 1,281 |
| Adapted Insectoid / Pollen Reaver | 13,156 | 5,918 |
| Authored painted mushroom | 2,016 | 1,008 |

The live environment uses original tree bodies and generated leaf clusters,
patch grass, separate boulders, and completed authored cliff volumes. The earlier
Jacaranda canopy and isolated grass tufts remain only in the source cache. The
table describes source LODs, not runtime volume completion or total frame cost.

The creature retains its skin, original Prowl animation and a new crest morph.
Its pelvis is anchored in the inspection scene so source root motion does not
move it out of frame. Materials retain mapped detail with lit TSL color bands,
foliage light transmission approximation, and near-field directional shadows.
Placement streams are seeded per object class. Quality reduces density and LOD;
placement rejection also respects the geological footprints present at that tier.

```sh
node scripts/prepare-concept-assets.mjs --inspect
node --max-old-space-size=6144 scripts/prepare-concept-assets.mjs --build
node scripts/prepare-concept-assets.mjs --build-ground
node scripts/prepare-concept-assets.mjs --build-parasite
node scripts/prepare-concept-assets.mjs --build-project-trees
node scripts/prepare-concept-assets.mjs --build-mushroom
npm run check:concepts
npm run dev:base-planets
npm run test:base-planets
npm run test:base-planets -- --visibility
npm run build:base-planets
npm run test:assets
npm run test:states
npm run test:states -- --weather
npm run build:concepts
```

The parasite build requires the normal, authorized Sketchfab download staged at
`.asset-sources/insectoid/source.glb`; it never extracts protected viewer data.
Environment downloads use Poly Haven's public API with an identifying user-agent.

Before the base-planet expansion, the environment suite passed 121 desktop/mobile/landscape/fallback views: all ten
surfaces and orbits, isolated asset views, original-style grass presence,
different landforms, enemy animation regression, overflow, render budgets,
camera interaction, regeneration, saved choice, pause, and source credits.
Pixel checks hide the interface so UI text cannot make an empty canvas pass.
Reports/screenshots are in `.test-shots/concepts/asset-*`; the test also produces
seven asset comparison sheets in `.test-shots/environment-review/sheets/`.
The JSON report contains per-view draw and triangle counts including render
passes. These are not real-phone frame-time or thermal measurements.

The state suite rendered 74 views, checking actual pixel changes and exact normal
restoration at the same seed, camera and animation time. It checks weather on/off
pixel contributions and motion, static frozen water as time advances, material
inspection states, mobile layouts, reduced motion and forced WebGL. After the
weather redesign, the focused `--weather` slice passed 32 views for rain, refraction,
spores, snow and petals. Reports are `state-report.json` and
`state-report-weather.json` under `.test-shots/concepts/`. Mobile surface totals in
these checks were approximately 328k-468k triangles including render passes.

The base-planet suite adds 67 rendered views, original cone/octahedron proportion
checks, substantial mountain-volume checks, closed-edge audits, per-cluster spike
and per-shard crystal orientations, zero vegetation-footprint overlaps, three
placed features per profile, real keyboard/touch traversal, synthetic gentle-ramp
and steep-ledge checks, and a sharp-centre/blurred-edge pixel comparison. It captures
geology from front/rear and rock formations from front/rear/underside, with mobile
and forced WebGL coverage. The report is `.test-shots/concepts/base-report.json`.
The report includes per-view draw/triangle totals including render passes; these
are not physical-phone timings. Grounding checks include broad base attachment
and full tilted-spike foot contact, not only a single minimum-clearance point.

The visibility suite checks all thirty feature recipes in composed desktop and
mobile arrival views (60 actual on/off pixel contributions), plus 60 named feature
inspection views. It also isolates the desert heat-refraction layer from dust and
tornadoes to verify visible motion. Results are recorded in
`.test-shots/concepts/feature-visibility-report.json`. The tested default seeds
are not a guarantee that every feature is visible from every camera angle.

Current limitations: the additional five themes, radiated states and revised
weather remain art-review choices; the approved original normal palettes are the
baseline. Remaining creature families are intentionally deferred. The GLBs use
Meshopt and WebP (delivery compression), not KTX2 GPU texture compression.
Physical-phone profiling, GPU residency measurement, full spherical traversal,
and gameplay integration remain unverified. No AAA or exact reference match is
claimed. The original game renderer and its existing assets are untouched.

### Additional service checks

On the public terms reviewed during this pass, Sloyd Guest is personal-use and
Tripo Free is non-commercial. Meshy's current free plan does not allow model
downloads. 3D AI Studio advertises free starter credits and commercial rights,
but its account/export conditions have not been tested here. Rodin/Hyper3D was
reviewed as a possible future source, not used. No subscriptions, purchases,
credit-consuming generation jobs, or uploads of user assets were submitted.

## Earlier prototype and research history

**Status: the primitive-based prototype below was rejected for visual quality.**
Passing its functional tests did not establish reference fidelity. The asset-led
production proposal at the end of this document supersedes its art approach.

Five independent, seeded 3D art-direction prototypes. No existing terrain,
enemy models, materials, textures, world generators, or public assets are used.
The current game and its in-progress edits are not replaced.

## Compare

Run `npm run dev:concepts`, then open
`http://localhost:5188/concepts.html` (use the reported port if occupied).

| Concept | Environment | Parasite Direction |
| --- | --- | --- |
| Cinderbloom | Scarlet canopy, sulfur meadows, turquoise river | Thorn armor and luminous pollen cores |
| Glass Tide | Opaline water and branching coral forests | Calcified fins and exposed pink organs |
| Saffron Waste | Terraced badlands and succulent solar sails | Carapaces, scythes, and segmented stingers |
| Mycelial Night | Luminous mushroom canopy and blackwater | Spore tendrils and shared colony biology |
| Frostwound | Snowfields, glacial crystals, crimson fissures | Ice-grown armor and thawing red cores |

Each concept includes Surface, Orbit, and Parasites views. Drag or pinch to
inspect; Reset view restores the composition. Portrait screens inspect one
parasite at a time. The lineup contains a swarmer, hunter, and apex specimen.

Choose this concept remembers the direction locally in this browser. Seed,
planet, view, and quality are encoded in the URL. New seed generates another
variant; the numeric field accepts seeds from 0 through 4294967295. Capture
downloads the rendered scene without interface chrome. Hide UI retains a
Show UI control. Pause motion also freezes the TSL water and vegetation.

## Implementation

- Separate HTML entry, source directory, Vite config, typecheck, and build.
- Three.js r186 WebGPURenderer and TSL node materials, with WebGL 2 fallback.
- Procedural terrain, flora geometry, cloud/globe bitmap textures, and merged
  articulated creature meshes. No external image/model downloads.
- Instanced repeated vegetation, crystals, rocks, coral, and distant debris.
- Stepped directional shading; no expensive shadow maps or postprocessing.
- Mobile tier lowers terrain subdivision and scatter counts and caps DPR at 1.
  High tier caps DPR at 1.5. Adaptive selects the tier by viewport/input device.
- Background animation/rendering pauses; the initial scene still compiles.
- Scene switches dispose geometries, materials, textures, and instance buffers.
- A read-only `window.necrofallStudies.snapshot` exposes rendering diagnostics.

## Validation

```sh
npm run check:concepts
npm run build:concepts
npm run test:concepts
```

The build outputs `dist-concepts/concepts.html` and its own JS/CSS assets. It
does not copy the game's public directory. This is a separate artifact from
the game's normal build and deployment.

The Playwright runner starts and stops its own Vite server. On Windows it uses
installed Edge. Other platforms need Playwright Chromium installed; set
`BROWSER_CHANNEL` to override the browser. Screenshots and the JSON report are
written under the ignored `.test-shots/concepts/` directory.

The 27-view suite covers all 15 desktop combinations, five mobile surfaces,
portrait specimen/orbit views, landscape views, and forced WebGL fallback.
It checks nonblank canvas pixels, text overflow, draw/triangle budgets, seeded
repeatability, seed zero, regeneration, camera interaction, persisted choice,
motion pause, PNG capture, and browser console errors.

Observed mobile surface budgets in emulated Edge: 48-51 draw calls and roughly
168k-491k triangles. These are geometry measurements, not certified phone FPS.

## Scope

These are selectable visual prototypes, not finished AAA assets or a verified
90% match to the supplied reference illustrations. The surface is a composed
local terrain patch; the orbital globe is a separate procedural visualization,
not a seamless traversal of the same height field. Creature motion is an idle
study, not combat AI. Multiplayer, MOBA mechanics, collision, streaming, real
phone thermal behavior, and full swarm performance are intentionally outside
this isolated comparison. The selected direction still needs production asset
refinement and measured integration into the actual gameplay renderer.

## Asset-led production proposal: 2026-10-08

This section records research and a proposed production sequence, not completed
asset imports or an approved implementation. No game/runtime code was changed
during this research pass. The existing game remains untouched.

### Diagnosis and target

The rejected prototype used repeated primitive silhouettes, mostly unlit
directional color bands, insufficient material detail and contact lighting,
and similar compositions across all five worlds. More polygons or brighter
colors would not fix those underlying problems.

The supplied references suggest painterly, stylized PBR: authored organic
silhouettes, detailed rock and bark surfaces, coherent leaf masses, soft
colored shadows, atmospheric depth, expressive creature anatomy, and carefully
composed lighting. Preserve that detail rather than flattening it with a
hard toon ramp. No Man's Sky is an art-direction reference, not an asset source.

An exact match to the illustrations is not established by the available assets
or by browser tests. Artistic approval requires side-by-side review with the
reference at comparable camera framing. No automatic percentage is meaningful.

### Researched source shortlist

Licenses and listing metadata were checked on 2026-10-08. Triangle counts below
are source/listing counts, not promised optimized runtime counts. Source files
have not been downloaded, unpacked, or validated in Blender/Three.js.

| Source | Verified listing | Proposed use and remaining work |
| --- | --- | --- |
| [Jacaranda Tree, Rico Cilliers / Rob Tuytel](https://polyhaven.com/a/jacaranda_tree) | CC0; about 312k tris; LODs and bark/leaf maps listed | Branching and canopy foundation. Reshape canopy, recolor leaf atlas, author alien leaf silhouettes, retain bark detail, derive near/mid/far LODs. |
| [Namaqualand Cliff 02, Dario Barresi / Rico Cilliers](https://polyhaven.com/a/namaqualand_cliff_02) | CC0; about 364k tris; LODs and PBR maps listed | Eroded cliff modules and readable rock strata. Derive optimized modules and integrate into terrain instead of isolated cylinders. |
| [Grass Medium 01, Rico Cilliers / Rob Tuytel](https://polyhaven.com/a/grass_medium_01) | CC0; full listing about 2M tris; LODs, alpha, normal and roughness maps | Source for tuft/atlas extraction, not an entire scene to ship. Cluster instances, control alpha overdraw, and add vertex-weighted wind. |
| [Root Cluster 01, Jenelle van Heerden / Rico Cilliers](https://polyhaven.com/a/root_cluster_01) | CC0; about 225k tris; PBR maps | Ground integration and an organic surface-detail source for infection roots. Needs remeshing/baking, not simply neon recoloring. |
| [Quiver Tree 02, Dario Barresi / Rico Cilliers](https://polyhaven.com/a/quiver_tree_02) | CC0; about 154k tris; LODs listed | Arid-biome trunk and succulent structure; adapt silhouette and atlas before use. |
| [Stylized mushrooms, QumoDone](https://sketchfab.com/3d-models/stylized-mushrooms-9d22e02ce2a548959b1c4c4c1d546842) | CC Attribution; 12,057 tris in search metadata | Secondary fungal vegetation and painted-material study. The preview is not an approved giant canopy asset; scaling alone will not make it one. |
| [Insectoid Monster Rig, DM-913](https://sketchfab.com/3d-models/insectoid-monster-rig-01323e4b2563430f9da85cd255b6e176) | CC BY 4.0; 13,156 tris; 2 materials; 1 animation | Candidate hunter anatomy. Inspect rig/UVs, alter head and armor, repaint, and add missing combat locomotion/action clips. |
| [Spiderthing take 3, Rasmus](https://sketchfab.com/3d-models/spiderthing-take-3-10bb4cf49d304d64afd2b829666f6caf) | CC BY 4.0; 67,972 tris; 5 materials; 2 animations | Candidate heavy parasite source. Requires stronger art adaptation, material consolidation, and deformation-safe LODs. |
| [Alien, DJMaesen](https://sketchfab.com/3d-models/alien-4028043549f64b40a14b6b12392663a7) | CC BY 4.0; 8,144 tris; 1 material; 1 animation | Alternate lean predator source. The viewer identifies its animation as an idle test, not a complete combat set. |

The source previews for Jacaranda, QumoDone's mushrooms, Insectoid Monster Rig,
Spiderthing and DJMaesen's Alien were visually reviewed. They are raw source
candidates, not proof of finished NECROFALL quality.

The checked Sketchfab Download action opens a login prompt. Import requires
normal authenticated download by the user; no credentials should be shared in
chat, and viewer extraction must not be used to bypass download access.

[Poly Haven's license](https://polyhaven.com/license) permits commercial use,
modification and redistribution of its CC0 asset files. Its website preview
renders are not covered by that asset license and must not become game assets.
[ambientCG](https://docs.ambientcg.com/license/) is another verified CC0 source
for terrain materials. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
requires credit, a license link, and identification of modifications. Preserve
author/source/license records and inspect actual downloaded license files.
Listing metadata is not an independent warranty of third-party rights.

Exclude franchise extractions/fan models, noncommercial licenses, no-derivatives
licenses, and ambiguous uploads. Free Standard licenses need separate review;
they are not interchangeable with CC0 or CC BY.

### Five directions to retain

1. **Cinderbloom:** broad red alien canopies, warm meadows, eroded rock shelves,
   and chitinous predators whose infection grows into the ecosystem.
2. **Glass Tide:** shallow opaline coastlines, fan-coral silhouettes, mineral
   shelves, and shelled aquatic parasites. Hero coral and creature sources
   remain unapproved; do not fill the gap with cylinder branches.
3. **Saffron Waste:** wind-eroded arches, sediment layers, sparse succulent
   groves, and plated ambush predators. A custom arch and adapted leaf kit are
   required beyond the shortlisted natural source models.
4. **Mycelial Night:** ribbed fungal trunks, layered gills, restrained luminous
   tissue, wet ground and spore-bearing parasites. Hero fungal canopy topology
   and a cohesive enemy set remain modeling tasks.
5. **Frostwound:** fractured ice shelves, readable glacial crevasses, translucent
   accents and exposed crimson infection. Hero ice/creature assets remain
   unapproved; material tinting alone is not a distinct concept.

Each direction must differ in terrain morphology, vegetation silhouette,
material response, atmosphere and enemy anatomy, not just palette or seed.

### Production sequence and approval gates

1. Agree on a representative reference composition and source-asset contact
   sheet. Keep all five directions in scope, but establish the quality standard
   with one scene before extending the pipeline to the other four.
2. Import a small candidate set into an isolated staging directory. Inspect
   scale, UVs, normals, texture content, material slots, topology, skeleton,
   deformation and animation clips; record licenses and file hashes.
3. Adapt approved sources in Blender: shape and silhouette changes, authored
   infected tissue, material repainting, high-to-low normal/AO baking, and
   deformation-safe LODs. Reject assets that cannot meet the art target instead
   of hiding them behind bloom or distance fog.
4. Build a reference-quality scene with one hero tree, supporting vegetation,
   a cliff/ground transition, water, one detailed enemy and a celestial backdrop.
   Match camera, scale, lighting and foreground/midground/background density.
5. Review in-engine close-ups and the full frame against the references and the
   original game's quality floor. Only an accepted visual result clears this
   gate. Functional tests and polygon counts do not substitute for approval.
6. Apply the accepted pipeline to all five directions, with separate asset and
   anatomy sets. Then integrate the chosen direction into gameplay and validate
   camera transitions, traversal, combat readability and swarm performance.

### Rendering and procedural generation

- Use Three.js WebGPURenderer with lit TSL MeshStandardNodeMaterial, retaining
  base-color, normal, roughness and AO maps. Add art-directed hue variation,
  leaf transmission and infection emission without discarding surface detail.
- Build terrain from broad geological forms, erosion/strata information and
  slope/height-aware material blending. Blend authored cliff modules into the
  terrain. Use the same spherical coordinates/seed for ground and orbital views.
- Use atmospheric scattering, terrain contact lighting, a controlled sun and
  restrained color grading. Establish quality without heavy postprocessing.
- Water needs depth coloration, shoreline foam, coherent normal flow and sky
  reflections. Mobile uses bounded-cost approximations; costly scene reflection
  and volumetric passes are optional high-tier features, not baseline promises.
- Procedural worlds may use authored assets: seed placement, clusters, biomes,
  size/proportion ranges, approved morph targets, and infection masks. Arbitrary
  scaling or primitive assembly is not the creature-generation strategy.
- Export GLB with baked maps, packed ORM, LODs and reduced material slots.
  Use KTX2/Basis for GPU texture compression and Meshopt or Draco for geometry.
  Geometry compression reduces delivery size, not the rendered triangle count.

### Proposed mobile acceptance criteria

These are starting targets to validate, not measurements or guarantees:

- Sustained 30 FPS on an agreed real midrange Android and iPhone; test frame-time
  percentiles and thermal behavior over ten minutes, not a single FPS label.
- Initial envelope: 250k-500k visible triangles, fewer than 150 draw calls, and
  approximately 128 MiB resident textures. Adjust based on measured bottlenecks.
- Prefer 1K shared atlases and selected 2K hero maps; stream biome cells and keep
  the initial playable download around 20 MB or less where feasible.
- Use screen-size LODs, chunked instancing, bounded alpha coverage, frustum and
  planet-horizon culling. Avoid thousands of separately updated skinned meshes;
  evaluate shared animation/VAT for distant swarms after measuring the workload.
- Stress the actual gameplay enemy count, effects, UI and network simulation.
  Empty vistas and emulated mobile viewports cannot certify shipping performance.
- Check WebGPU and WebGL fallback, context loss/recovery, texture residency,
  loading stalls, silhouette preservation and LOD popping on physical devices.

### Technical references checked

- [Three.js MeshStandardNodeMaterial](https://threejs.org/docs/pages/MeshStandardNodeMaterial.html): lit PBR with TSL overrides and environment support.
- [Three.js KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html): hardware-dependent Basis transcoding; detect support before loading textures.
- [glTF Transform CLI](https://gltf-transform.dev/cli): inspect, simplify, deduplicate, texture compression and animation optimization; defaults require asset-specific review.
- [Blender 4.5 glTF export](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html): PBR image maps, baking, skinning, shape keys and animation; arbitrary Blender shader graphs are not portable runtime materials.

### Remaining limitations

No researched free pack supplies all five worlds and exact bespoke enemy
silhouettes from the references. Several hero assets still need further source
selection or custom sculpting/texturing/rigging. Exact visual equivalence and
real-phone performance cannot be promised from a plan. The next authorized
implementation should be the source-asset and single-scene quality gate, not
another five-world primitive generator.