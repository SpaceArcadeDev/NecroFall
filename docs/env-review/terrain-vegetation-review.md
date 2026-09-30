# Terrain & Vegetation Review — folio-2025 port (2026-09-30)

Self-test review of the grass / trees / water work against the folio-2025 source
(`https://github.com/brunosimon/folio-2025`, local clone `.folio-ref`), run in the **dev world**
(no enemies, frozen clock, unlimited time) on both the user's planet (VOLCANIC) and the lush
JUNGLE planet.

## How to reproduce the test world

Boot the game, open the console, and run:

```js
const pg = await import('/src/rankmap/procedural/PlanetGenerator.ts');
const seeds = await import('/src/rankmap/procedural/SeedHash.ts');
// planet key: 0=VOLCANIC 1=DEAD 2=OCEANIC 3=FUNGAL 4=DESERT 5=JUNGLE · coords 0:0:0:<key>
const planet = pg.planetAt(seeds.DEFAULT_UNIVERSE_SEED, 0, 0, 0, 5);
nfShell.startSoloRun('survival', planet, { dev: true });
// pick a class (VOLT card), then:
nfShell.hideShell(true);
```

Dev mode = no enemy spawns, no match clock, invulnerability — terrain/vegetation can be
inspected forever. Use the debug handle `window.necrofall` (`g.folioWorld`, `g.planet`,
`g.localPlayer`, `g.cam.camera`) to teleport the player/camera and to `g.planet.aimSunAt(dir)`
when shooting screenshots (a real match aims the sun at the tower ring automatically).

## Follow-up pass — the "grass/lighting look off, light flickers, things pop" report

Second live review (user screenshot: icy planet, grass as dark hatching, lighting mismatch).
Root causes found and fixed:

### A. Grass didn't wear the ground's colour
The blades shaded with `terrainAlbedoNode(..., TERRAIN_PALETTE.grass, ...)` — a **hard-coded
green** — while the actual ground can be any palette (icy blue, volcanic red…). folio's grass
uses the terrain's OWN colorNode, so blades always read as the ground. Our blades stood out as
a differently-coloured hatch layer — the "doesn't look like the source repo".
Fix: the grass bakes a third texture — the ground colour per direction via the **same
`BiomeGenerator.colorAt`** the terrain mesh bakes its vertices with — and shades with
`terrainAlbedoNode(data, groundColor, vegetation)` (`Grass.ts` + `FolioWorld.growGrass`).

### B. The grass popped because the frame re-base was inexact
`shiftFrame` (the tangent-frame re-base that runs when the view travels ~52 m) decoded each
blade's new offset with `atan2(dot(dir,t1), dot(dir,anchor)) · R` — a small-angle
approximation of the shader's cap mapping (`dir = anchor·cosθ + û·sinθ`). At 70–90 m offsets
that is a ~13 % error — **far blades jumped metres on every re-base**, reading as the field
"yanking/popping" while walking. Fix: the exact inverse (`acos` decomposition), byte-identical
to the shader's forward mapping.

### C. Folio lighting: shadows didn't match the shading
The three `DirectionalLight` (shadow map) shone from a **fixed** offset `(1, 0.85, 0.6)`, while
every folio material shades with the per-planet sun (`SHADER_GLOBALS.uSunDir`). Cast shadows
fell on a different side than the lighting — "the lighting looks off". Fix (`Game.ts`): the
light now rides `SHADER_GLOBALS.uSunDir` (same direction the materials shade with).

### D. Flicker while moving = shadow-map crawl (+ a drifting sun)
The shadow ortho box follows the player and was re-rasterised every frame — sub-texel motion
shimmers over every receiver. Fix (`Game.ts`): the focus is snapped to the shadow **texel
grid** before the light is placed. Also removed the old ±0.16 rad sun drift (`Planet.update`) —
the sun is now rock-steady within a match (the drift kept rotating every lit face and shadow,
reading as "the light keeps changing").

### E. Tree leaves popping in = hard instance culls
The per-instance CPU cull wrote zero-scale matrices in one step at the cull distance — and the
performance-rescue levels (`lodFor`) *change that distance* mid-match (×0.82/×0.62/×0.45), so
canopies popped on every rescue step. Fix (`Foliage.ts`): a **soft fade band** — instances
shrink smoothly to zero over the last 22 % of the cull distance (quantised state, no per-frame
writes). Distance changes and rescue changes both fade instead of popping.

Evidence: `after-05-dead-thirdperson.png` (DEAD planet, third-person: blades now carry the
ground's icy tone — no dark hatch layer; canopies visible; shot taken with the game's own
camera).

## Round 3 — "match folio's grass implementation" (patches · gradient · wave · bushes)

User report: *"grass should have visible gradient, closer packed, in patches not full all over,
maybe slightly bigger, missing the wavy animation like folio; bushes floating in the air."*
Compared blade-by-blade against `.folio-ref` (`World/Grass.js`, `World/Wind.js`,
`World/Bushes.js`, `Materials/MeshDefaultMaterial.js`) and re-derived every law:

### A. "In patches, not full all over" — the density channel carves the lawn
Folio's lawn is NOT uniform: their terrain data's density channel gates blade SIZE and — below
the threshold — **visibility**: `hidden = step(g − 0.4, 0.1)` lifts the blade 100 m off the
surface (culled by geometry, crisp patch edges). Ours had a `×0.85 + 0.15` floor — blades
existed everywhere, reading as a carpet. Fix:
- `src/world/folio/terrain/VegetationPatches.ts` (new): a seeded fbm carved with
  `smoothstep(0.38 → 0.62)` into ≈14 m lawn blobs over bare ground.
- The carve multiplies the vegetation channel in BOTH bakers — the terrain's `aVeg` attribute
  (`TerrainVisual.bake`) and the grass data texture (`Grass.bakeTerrainTextures`) — so blades,
  the ground's grass wash (`terrainAlbedoNode`, floor removed) and colours agree exactly.
- The grass vertex stage now reads: `g = patchedVeg × (0.2 + 0.8·flatness)` → blade width AND
  height `×g`, root-shadow strength `×g`, and `g < 0.45…0.5 ⇒ hidden` (folio's trick).

### B. "Visible gradient" — it is the SHADOW term, not a colour ramp
A colour root→tip ramp experiment blew the field to neon from above (a 1.6–1.8× tip over a
whole hillside). Folio truth (`MeshDefaultMaterial`): the gradient is
`shadowNode = (1 − tipness) × g` (linear `tipness = step(vertexIndex % 3, 0.5)` — tip 1, base 0)
— roots mix towards the violet shadow colour, tips stay lit. Restored exactly; the colour ramp
was removed (`Grass.ts` colorNode is now folio's plain `terrainAlbedoNode(...)` call).

### B2. "Dark green spikes" — folio's grass colour is BRIGHT olive, not green
folio's `Terrain.js`: `grassColor = uniform(color('#b8b62e'))` — the density channel mixes the
ground towards that bright olive-yellow. Ours was a mid-green `#5f9a58` wash, so lit blades
rendered dark green and the shadow term turned them almost black — "dark green spikes".
`TERRAIN_PALETTE.grass` is now folio's exact `#b8b62e`, which both the ground wash and every
blade wear.

### C. "Missing the wavy animation" — folio's exact drive, near the top of their range
Wind is folio's `offsetNode(worldPos.xz) × tipness × height × 2` with their two scrolling noise
octaves (`FolioShaderGlobals.FolioWind`, verified against `Wind.js`). Strength 0.95 (inside
folio's live weather range `remapClamp(wind, 0, 1, 0.1, 1)`) and timeFrequency 0.12 — A/B
frames 1.6 s apart show the field leaning and gust fronts travelling.

### D. "Closer packed / slightly bigger" — folio's own count-vs-size architecture
Folio keeps `subdivisions = 280` and lets blade SIZE absorb field growth. Ours: 480² = 230k
blades over a 56 m field ≈ **23 blades/m²** (≈38/m² inside the patch blobs — folio's packed
lawn), blades at 0.062/0.42 base (≈0.21 m wide × 0.76 m tall at the overflow clamp). The 700²
first pass (490k blades) matched the look but cratered to 35 fps and the 512² step bought only
+12% vertex cost for no extra read — 480²/56 m lands ~47 fps top-down (was 70 at 480²/85 m
before any of this round's coverage increases).

### E. Bushes floated 5–8 m — the reference GLB stores folio's ISLAND placements
`bushesReferences.glb`'s children carry folio's own island positions ((22.68, 1.34, 24.4)…).
Composing their matrices with our placement matrices teleported every bush. Fix (`Bushes.ts`):
take only each child's SCALE for variation, instance at OUR placement, lift 0.5 × scale along
the radial. Verified live: bush centre 116.11 vs ground 115.81 = **+0.30 m** (was +8.3 m).

### F. Dev-world DX (user ask): no picker, spawn on the grass
`startSoloRun(..., { dev: true })` now skips the SELECT NECROTECH screen entirely (default
starter, one call from the console boots the world) and drops the player on the open surface
at a fixed reproducible spot instead of the fortress deck (`Game.ts` — `devSpawnDir`).

Evidence: `rework-09-patches.png` (top-down: discrete lawn blobs over bare ground),
`rework-15-devspawn-top.png` (the auto-spawn gameplay view: dense patchy lawns),
`rework-16/17-ground-a|b.png` (close-up gradient + wind A/B), `rework-13/14-final-a|b.png`
(wind A/B), `ref-folio-site.png` (the live folio site for comparison).

## Evidence

| Screenshot | What it shows |
| --- | --- |
| `before-01-ground-volcanic.png` | Before: VOLCANIC plain — canopy visible, but **no grass anywhere** on the field. |
| `after-01-grass-volcanic.png` | After: VOLCANIC — dense blade carpet around the player, rooted, wind-lit. |
| `after-02-grass-jungle.png` | After: JUNGLE — the carpet reaches the horizon; no bare edge, no visible recycling line. |
| `after-03-trees-jungle.png` | After: JUNGLE — trees with **full blue-green dappled canopies** + folio's coloured shadow on the grass. |
| `after-04-water-volcanic.png` | After: VOLCANIC — the basin water surface renders (foam ring, ripple sparkles) with the blade carpet and canopied trees around it. |
| `after-05-dead-thirdperson.png` | After (follow-up pass): DEAD planet in the game's own third-person camera — blades blend with the icy ground, canopies visible, no dark hatch layer. |

## Root causes found (all fixed)

### 1. Grass floats above the ground (up to 4.4 m measured)
The baked terrain-data textures are **equirectangular with latitude-linear rows**, but the grass
vertex stage sampled v = `dir.y * 0.5 + 0.5` (sine-spaced). Every blade read the terrain data of
a **different latitude** than the ground it stood on — measured height error −2.8…−4.4 m; with the
correct sampling (`v = asin(dir.y)/π + 0.5`) the error is 0.00 m.
Fix: `src/world/folio/vegetation/Grass.ts` — `asin`-based v (documented at the site).

### 2. Grass pops in / changes while moving
The old per-frame “re-anchor” **re-scattered** the blade positions whenever the view moved ~15 m —
90 % of the field inside the view jumped to new spots each time. folio never touches its blade
positions after `setGeometry`; the per-frame update only sets `center.value` and the **vertex
shader wraps the field around the view** (`mod(position − centre + half, size) − half`).
Fix: folio's exact wrap in the shader; the CPU now only *re-bases the tangent frame* (pure
coordinate shift — every blade keeps its world position). No re-scatter exists anymore.

### 3. Grass only existed in a 36 m radius (hard bare edge inside the view)
The field half-extent was clamped to 36 m while the third-person view sees 100+ m. The wrap
recycled blades *inside the visible ground* → “pops in as I move” + a visible field edge.
Fix: the field reach now follows the quality setting (95 m half-extent at high — the full visible
ground), with the blade count raised to keep folio-like density (420² = 176 400 blades at high).
Blade width/height keep the tuned folio scale (the overflow formula is clamped, not unbounded).

### 4. Trees have no canopy (user: “canopy missing or floating in air”)
Two stacked causes:
- **Mipmap averaging of the foliage SDF.** folio loads its foliage SDF with
  `NearestFilter` **and no mipmaps** (`Game.js` resources list). Ours used default mipmapped
  linear: beyond a few metres every leaf plane sampled an averaged mip of the soft leaf blobs
  (mean ≈ 0.35), and the alpha chain (`sample − 0.3`, discard `< 0.1`) then erased **every**
  leaf pixel — trees rendered as bare trunks. Fix: `FolioResources.loadTexture` now uses
  folio's exact filtering (`NearestFilter`, no mipmaps) — `src/world/folio/FolioResources.ts`.
- **Near-black shadow tint.** folio's shadowed side is a *saturated colour* (day `#6d3fff`,
  night `#2f00db` — their signature coloured shadows). Ours was near-black `#4a3f63`, so every
  canopy plane facing away from the sun (half of every cluster, always) rendered black — also
  reading as “no canopy”. Fix: `FOLIO.lighting.shadowColor` → `#5b4bc4`
  (`src/world/folio/FolioShaderGlobals.ts`).

Also softened the canopy corruption wash (`0.45` → `0.22` in `Foliage.ts`): on corrupt worlds
every crown was tinted the vein's teal, which read as odd blue balls. folio's own canopy is
`mix(colorA, colorB, lighting)` only; the wash is a NecroFall art addition and now stays subtle.

### 5. No water anywhere (user: “no water found”)
The water patch mesh was rendering (right position, right radius) but **every fragment was
transparent**: the local depth map was a `RedFormat` float texture and it sampled as zeros.
History: float32 red needs WebGPU's `float32-filterable` feature (silently zeroed without it);
half-float red *also* sampled zeros in the live pipeline (verified by swapping in a plain
material — the patch appeared instantly, proving the geometry and the depth build were fine).
Fix: the depth map is now **8-bit encoded** (`min(depth, 10) / 10 × 255`, `RedFormat +
UnsignedByteType`) and the shader decodes with `× 10` — an 8-bit channel filters on every
backend, and the water's depth ramp only needs ~0.04 m precision.
Fix file: `src/world/folio/environment/WaterSurface.ts`.

### 6. Rocks floating on slopes (previous pass, kept)
Per-kind sink in `VegetationGenerator.frameFor` (SLAB × 0.42, CRYSTAL × 0.28, others × 0.22 of
scale) — slabs/crystals now sit in the ground on steep terrain.

## folio-2025 source references (the ground truth for this port)

- `sources/Game/World/Grass.js` — field = `subdivisions²` blades, static positions; per-frame
  `center.value.set(view…)`; vertex wrap `mod(position − center + half, size) − half`;
  `hidden = step(terrainData.g − 0.4, 0.1)` (blades vanish on barren ground); wind =
  `offset(worldXZ) × tipness × height × 2`; blade shape = 3-vertex triangle from `vertexIndex`;
  camera-facing rotation via `atan2(worldZ − camZ, worldX − camX) − π/2`; **no distance cull**.
- `sources/Game/World/Foliage.js` — ONE merged 80-plane cluster geometry; alpha = SDF sample
  minus `threshold = 0.3`; see-through fade around the player; references = per-(tree × leaf
  mesh) matrices.
- `sources/Game/World/Trees.js` — `finalMatrix = leaves.matrix.premultiply(treeReference.matrixWorld)`
  (the exact composition we use).
- `sources/Game/Game.js` — foliage SDF loaded with `NearestFilter` + no mipmaps (the fix above).
- `sources/Game/Materials/MeshDefaultMaterial.js` — `alphaTest = 0.1`, shadow mix into
  `shadowColor`, core shadow `smoothstep(-0.25, 1, N·L)`.

## Known remaining notes (not blockers)

- `THREE.GLTFLoader: Couldn't load texture blob:…` console warnings appear on every load for a
  set of GLB-embedded textures (trunk bark, kit props). The tree/foliage system does not depend
  on them (canopies use the external SDF; trunks render the kit material), and everything
  renders correctly — but the warnings should be investigated when the asset pipeline is next
  touched (likely the compressed GLB export).
- At 80+ m a canopy cluster (≈1.6 m, folio's real cluster size) is only a few pixels — trees read
  as silhouettes at long range, same as folio at distance. Not a bug; could be improved later
  with larger reference scales or an impostor pass.
- High quality now grows 176 400 blades (420²). The performance rescue system (DPR + budgets)
  applies as usual; drop the quality tier to scale the field down (density multiplies the
  subdivisions).

## Files changed in this pass

- `src/world/folio/vegetation/Grass.ts` — asin-v, folio wrap, no re-scatter (pure frame rebase),
  full-reach field, clamped blade-size overflow, folio-local uniforms.
- `src/world/folio/FolioResources.ts` — folio-exact SDF sampling (Nearest, no mipmaps).
- `src/world/folio/FolioShaderGlobals.ts` — folio-style coloured shadow tint.
- `src/world/folio/vegetation/Foliage.ts` — softer corruption wash.
- `src/world/vegetation/VegetationGenerator.ts` — per-kind rock sink (slabs/crystals on slopes).
- `src/world/folio/environment/WaterSurface.ts` — 8-bit encoded depth map (water renders again).

## Round 4 — no grass in a classic game · "dark green spikes" · grey cone groups (2026-09-30)

User report: a classic match on a DESERT planet showed **no grass at all**; the grass read as dark
green spikes with no folio-like colour/gradient; the environment "spikes" (rock formations) should
be grey cones in groups like the pre-rework world, not coloured pyramids.

- **Why the desert had no grass**: the vegetation channel was the RAW `plantDensityAt` product
  (desert ≈ 0.16–0.30) — every blade sat below folio's `g` gate and the ground wash was invisible.
  The channel is now the lawn law in `VegetationPatches`: `patch carve × (0.5 + 0.5 × clamp(raw /
  planetPeak))` — folio's authored on/off density semantics, so EVERY archetype grows a real lawn
  in its blobs (baked identically into the terrain `aVeg` and the grass data texture).
- **Grass colour = folio's law exactly** (`Terrain.js`: `mix(baseColor, grassColor, g)`): full
  strength, no ×0.85 damping, no altitude gate; blades wear the same function evaluated at their
  own data (`terrain.colorNode(terrainData)`), so lawn and blades are one surface. The root→tip
  gradient stays folio's shadow term (`(1 − tipness) × g` → the violet shadow colour).
- **Blade law**: folio's `0.1 / 0.6 × (1 + overflow × 0.5)` proportions (the overflow term is
  capped at the island's own 0..0.4 range — our field is 2.2× theirs, and their unclamped formula
  would grow 2.2 m blades); folio's wind exactly (constant `0.6π` direction, `timeFrequency 0.1` —
  the old wandering angle is gone).
- **Spikes**: `SPIKE` placements are now CLUSTERS of 2–5 tall grey cones (0x8c8aa0, no corruption
  wash, lifted proud of the ground, 0.5–2.3 m between members) — the pre-rework "jagged peaks",
  not single coloured pyramids.

Evidence: `grass-01-desert.png` (grass on a desert classic planet), `grass-02-jungle-lawn.png`
(the folio lawn), `spikes-01-cluster.png` (grey cone groups).

## Round 5 — floating grass · rim pops · wind · crystals · missing water (2026-09-30)

User report: grasses **floating in mid air** ("need to zoom out to see"), grass **appearing and
disappearing while moving** instead of staying fixed on the terrain, the waves should be **more
prominent**, the **purple glowing crystals** should be back (not "pyramids"), and **water was
missing** where it should be.

- **Floating grass = folio's `hidden × 100` lift.** Density-culled blades were lifted 100 m up the
  radial and left to the camera cull — on a planet whose horizon is a few dozen metres away those
  lifted blades render as a halo of grass in the sky. Fixed: culled blades now SHRINK to zero
  (`densityMask`) — a degenerate point on the ground, no lift (verified from 45 m up: no floaters,
  `grass-03-no-floaters.png`).
- **"Appearing/disappearing as I move" = the field-rim recycling.** Measured with a live walk:
  no blade closer than 45 m to the view centre ever changes its world spot (world-pinning is
  exact); the pops are blades RECYCLED at ±56 m, visible down slopes. Fixed with a radial fade:
  blades shrink to zero over 72→90 % of the half-extent, so every wrap jump happens at zero size
  (invisible). No other motion artefacts.
- **Wind**: strength 0.95→1.0 (folio's storm end), `timeFrequency` 0.1→0.15, grass sway ×2→×2.75
  (grass-only amplification on folio's formula, per the user's "more prominent"). A/B frames 1.6 s
  apart show the lean travel (`wind-01/02`).
- **Crystals** (user: "can have back the purple glowing crystals, i dont want pyramids"): the glow
  rode the PLANET's vein colour (green on JUNGLE, orange on DESERT) and the shards were wide —
  they read as flat coloured pyramids. Now: fixed purple glow `#9a6bff`, slender tall shards
  (scale 0.7–1.6 × stretch 2.0–2.6), rooted — the pre-rework crystal read.
- **Missing water — two bugs:**
  1. `hasWater` was a 256-probe lottery over the sphere. The user's classic DESERT planet has a
     real sea (1.4 % of the surface, up to 6.35 m deep) that the probes missed → `hasWater=false`
     → NO water surface rendered anywhere on the planet. Now analytic: `waterLevel − reliefMin`
     (the waterline is derived from reliefMin, so this is the deepest possible water). The local
     per-patch test still decides where the surface shows.
  2. The shoreline FOAM mask was inverted (`.oneMinus()` on `smoothstep(0.28, 0.02, depth)`), so
     every DEEP fragment got 55 % of the pale `#e8f6f2` foam colour — whole seas rendered sand-pale
     and camouflaged as beach. Fixed: foam = the shallow band only (`water-01-classic-shore.png` —
     deep water reads dark blue with a proper shore ring).
