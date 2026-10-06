# Three.js r186 Performance + Rendering Pass — implementation record (2026-10-06)

This is the delivery record for the *NecroFall — Three.js r186 Performance + Rendering Action
Plan* (the 50-phase document). It maps every phase to what lives in the repo today, states the
deliberate deviations and why, and lists the exact commands that reproduce the verification
numbers.

Two rules from the plan are kept everywhere:

* **do not move grass with the player** — the field stays baked, planet-wide, in planet space;
* **do not degrade the world to win fps** — work moves from "every frame × every object" to
  "once at build" and "only when visible", and every GPU path keeps a working fallback.

---

## Phase status

| # | Phase | Status | Where |
| --- | --- | --- | --- |
| 0.1 | Confirm/upgrade Three.js ≥ r186 | **DONE** | `package.json` — `three 0.186.1` (exact pin) + `@types/three 0.186.0`; single instance via the `three -> three/webgpu` vite alias |
| 0.2 | Renderer capability layer | **DONE** | `src/rendering/RendererCapabilities.ts` (webgpu / webgl2 / backend / compute / maxTextureSize / maxSamples / DPR / mobile / GPU tier / adapter enrichment + `[caps]` boot log) |
| 0.3 | Performance telemetry | **DONE** | `src/performance/PerformanceManager.ts` — `snapshot()` with frame/world/combat/network/server sections filled by pull-based providers |
| 1 | Planet lifetime / memory | **DONE** | `src/rendering/ResourceRegistry.ts`, `src/world/PlanetRoot.ts`, disposal added to `Materials` / `MaterialRemapper` / `PreRenderer` / `PlanetSurfaceData`; `PlanetRenderer.dispose()` order |
| 2 | Shared terrain field | **DONE (pre-existing)** | `src/planet/PlanetSurfaceData.ts` (typed arrays + baked `tex1`/`tex2`), `PlanetSurface`, consumed by terrain, grass, props, water, physics, shaders |
| 3 | Visual/collision split | **DONE (pre-existing, analytic)** | `src/rendering/Physics/PlanetCollider.ts` — collision is the closed-form terrain function; vegetation is never collidable |
| 4 | Grass architecture (sectors) | **DONE (pre-existing)** | `src/rendering/Environment/Grass.ts` — 128 planet-static sector meshes, one shared material, per-sector bounds, engine frustum culling + horizon cull |
| 5 | Grass LOD + hysteresis | **DONE + extended** | `GrassLOD.ts` (bands with enter/exit hysteresis, quality-tuned), `Grass.ts` per-sector keep |
| 6 | GPU grass (TSL wind) | **DONE (pre-existing)** | Grass material is a TSL node material: wind, sway, trample push, remote-walker trails are all shader-side; CPU only writes uniforms |
| 7 | Dithered LOD transitions | **DONE (this pass)** | `advanceGrassKeep` in `GrassLOD.ts` + per-sector `keep` in `Grass.ts`: the drawRange prefix walks over ~1.1 s (stable acceptance-order seed, no RNG, no per-blade distance test) |
| 8 | Grass frustum culling | **DONE (pre-existing)** | per-sector `frustumCulled = true`; the engine performs the frustum test — a manual `intersectsFrustum()` pass on top would be the same test twice |
| 9 | Instance all static decoration | **DONE (pre-existing)** | `Rocks` / `Spikes` / `RadioactiveCrystals` / `Bushes` / `Trees` / `Foliage` — one `InstancedMesh` (+ one shared material) per variant |
| 10 | Static world batching | **DONE (pre-existing)** | planet world = a small number of instanced draws (`draws 52` in the dev world with full decorations) |
| 11 | Terrain material → TSL | **DONE (pre-existing)** | `PlanetTerrainNodes.ts` + `PlanetSurfaceData.tex1/tex2` (R height/G grass/B wetness/A radiation, R rock/G biome/B puddle) sampled once per vertex where possible |
| 12 | GPU particles | **PARTIAL — documented deviation** | ambient motes are already fully shader-simulated (`FloatingParticles`), bursts are pooled instanced quads (`BillboardParticles`); no compute path yet — see "Compute deviations" |
| 13 | Particle pooling (WebGL fallback) | **DONE (pre-existing)** | `src/effects/Effects.ts` typed-array pool + `BillboardParticles` (zero-copy attributes, `setCount`, `setCap`); no allocation per spawn |
| 14 | GPU compute rollout | **DEFERRED** (order preserved: capability gate + `compileComputeAsync` plumbing are in place) | `RendererCapabilities.compute`, `PipelinePrecompiler.computeNodes` |
| 15 | Async pipeline compilation | **DONE** | `src/rendering/PipelinePrecompiler.ts` — `compileAsync`/`compileComputeAsync` with per-step timeout, try/catch, WebGPU-only compute, `?precompile=0` |
| 16 | GPU/CPU frame budget | **DONE** | `PerfChecklist` budgets (JS < 5/6/7 ms, draws, triangles, fps per device tier) + the game's adaptive ladder |
| 17 | Mobile pixel-ratio governor | **DONE (pre-existing + verified)** | `DeviceTier.dprCap()` ladder × `Quality.pixelRatioMax()` × `Game.updateRenderScale` (sustained windows, hysteresis, cooldown) |
| 18 | Thermal/performance governor | **DONE (pre-existing)** | rescue ladder (`Game.updateRescue`) reduces far particles → crowd → decorations → pixel ratio, with gradual restore and a floor on core visuals |
| 19 | Shadow optimization | **DONE (audited)** | caster list = tree trunks, remapped props, the sun; grass/foliage cards/rocks/spikes/crystals/puddles/particles are non-casters |
| 20 | Post-processing | **DONE (audited)** | chain is bloom + cheap DOF only — no GTAO/SSAO, so r186's GTAO retune does not apply; DOF off below the top level |
| 21 | Enemy simulation tiers | **DONE (pre-existing)** | `SwarmDirector` tiers 0–3 with hysteresis + id-staggered strides; `?enemytiers=0` A/B |
| 22 | Spatial hash | **DONE (pre-existing + A/B)** | `src/utils/SpatialHash.ts` → `Enemies.query()` (projectiles, novas, abilities, spread); `?spatialhash=0` linear-scan control |
| 23 | Target scan rate | **DONE (pre-existing)** | throttled `decide()` (`thinkInterval`) + staggered updates; movement continues between scans |
| 24 | Swarm director | **DONE (pre-existing)** | population target + tier budget (`director.stats()`), wired into `Enemies` |
| 25 | Distant swarm proxies | **DEFERRED** (plan's own "later optimisation"; profiling does not show swarm body cost as the bottleneck) |
| 26 | Projectile pool | **DONE (pre-existing)** | `src/combat/Combat.ts` fixed pool, `setCap()` per preset, one instanced draw |
| 27 | Network architecture | **DONE (kept)** | SpacetimeDB authoritative relay + P2P host authority; prediction/reconciliation, remote interpolation; terrain/grass/VFX client-only |
| 28 | SpacetimeDB interest management | **DEVIATION — architecture differs** | the official wire relays gameplay messages per match scope (`match_msg`), it does not replicate entity tables; there is no full-planet subscription to partition. See notes |
| 29 | Reduce row mutations | **DONE (pre-existing)** | change-gated pose (`poseSignature`), 12 Hz authority snapshot, 10 Hz server tick that also sweeps relay rows |
| 30 | Server AI scheduling | **DEVIATION — no server AI** | the server runs no per-enemy AI to bucket; enemy AI is host-client authoritative with tiered strides (Phase 21). The tick's per-player work is a bounded linear scan of live inputs |
| 31 | World generation worker | **DEVIATION (documented)** | generation is chunked + yielding and runs behind the loading screen/pre-build; a worker would ship a second three.js bundle to phones for a non-blocking task. See notes |
| 32 | Structure of generated data | **DONE (pre-existing)** | typed arrays throughout (`PlanetSurfaceData`, grass sector geometry, instance matrices/colours) |
| 33 | Texture optimization | **DONE (audited)** | KTX2/Basis + Draco loaders are wired (build emits the transcoders); baked planet data is 384×192; no 4K maps; atlas palette per world |
| 34 | Material sharing | **DONE (pre-existing + fixed)** | one material per variant, instance attributes for variation; the per-world remap cache is now disposed with the world |
| 35 | Animation optimization | **DONE (pre-existing)** | enemy animation rides the tier stride; distant vegetation animation is shader-side; invisible systems are not updated |
| 36 | Scene graph audit | **DONE (verified)** | dev world with full decorations: 52 draw calls, 57 geometries, 30 textures, 2,227 decoration instances in one group tree |
| 37 | Renderer state optimization | **DONE (pre-existing)** | `sortObjects = false` + explicit render order sorts; stable material/geometry groupings; instancing everywhere |
| 38 | Renderer adapter | **DONE** | `Rendering` is the one renderer owner (`forceWebGL` option, backend getter); `?backend=webgl\|webgpu` (and `VITE_RENDERER`) chooses; nothing else touches the renderer |
| 39 | Visual regression testing | **DONE (sample)** | dev-world screenshots on both backends this pass; grass decoration counts are byte-identical to the mobile-overhaul record (see below) |
| 40 | Performance scenarios | **DONE (this pass)** | `?bench=empty\|swarm50\|swarm100\|colonies\|boss\|vfx\|vegetation\|full` (`PerfHarness.ts`) maps TEST A–H onto real load hooks, including a genuine boss-body summon |
| 41 | S25 Ultra test | **OUT OF REACH HERE** | needs the device; the harness now reports scenario, 1 % low, peak frame, heap delta and telemetry so a device run is attributable — see "How to run a phone check" |
| 42 | Governor priority | **DONE (pre-existing)** | rescue order: far particles → crowd → decorations → pixel ratio; core visuals/near field never touched |
| 43 | Remove hot-loop allocations | **DONE (audited)** | module-scope scratch vectors across `Enemies`/`Effects`/`Combat`/`Game`; pools for enemies/projectiles/particles; typed arrays in every per-frame path |
| 44 | Render loop separation | **DONE (pre-existing)** | `update` → ticker stages (env 20, render 998) → `rendering.render`; rendering never mutates gameplay state |
| 45 | Fixed timestep | **DONE (server) / deliberate deviation (client)** | server tick is a fixed 10 Hz schedule; DevWorld physics uses a fixed-step advance; the match client keeps clamped variable dt because the host's client IS the authority for its own match |
| 46 | Compute rollout order | **DEFERRED** (capability gate + async compute compile in place; nothing compute-heavy shipped before CPU/GPU benchmarks) |
| 47 | Failure fallbacks | **DONE** | renderer adapter keeps the WebGL2 fallback alive end-to-end; capability probe reports `compute=false` on WebGL so GPU-only features gate off; precompiler never blocks the match |
| 48 | Development flags | **DONE** | build flags seed the URL vocabulary, URL wins: `VITE_RENDERER`, `VITE_GRASS_LOD`, `VITE_ENEMY_TIERS`, `VITE_SPATIAL_HASH`; runtime: `?backend`, `?grasslod=0`, `?spatialhash=0`, `?enemytiers=0`, `?precompile=0`, `?bench`, `?swarm`, `?perfcheck`, `?stats` |
| 49 | Debug overlay | **DONE** | `PerformanceManager.overlayLines()` feeds the existing `StatsOverlay` in both the game and the dev world (fps/frame/cpu/draws/triangles/geometry/canvas/grass sectors+blades/vegetation/enemy tiers/projectiles/particles/network/server tick) |
| 50 | Final target architecture | **HELD** | gameplay: SpacetimeDB + prediction; rendering: one adapter, WebGPU target with WebGL2 fallback; world: TerrainField → visual/collision → grass/decoration/particles (see diagram in the plan; no layer inverted) |

---

## What this pass changed

### 1. Three r186 is now the real version (`package.json`)

`three 0.183.2` → **`0.186.1`**, `@types/three 0.183.1` → **`0.186.0`**, both pinned exact. The
r186 APIs the plan lists now exist in the build: `Object3D.dispose()`, `intersectsFrustum()`,
`compileAsync()` / `compileComputeAsync()`. The upgrade is behaviour-neutral here: build and
ring-parity tests pass unchanged, and the live dev world renders identically on both backends.

### 2. Capability probe (`src/rendering/RendererCapabilities.ts`)

One synchronous probe (plus a best-effort async adapter description) answering
webgpu/webgl2/backend/compute/maxTextureSize/maxSamples/DPR/mobile/tier, logged once at boot:

```
[caps] backend=webgpu webgpuApi=yes webgl2=yes compute=yes maxTex=8192 samples=4 dpr=1.25 tier=high mobile=false
[caps] adapter amd gcn-5
```

On the WebGL fallback the same line reports `backend=webgl … compute=no` — every GPU-only
feature can therefore gate itself rather than guess.

### 3. Telemetry (`src/performance/PerformanceManager.ts`)

`PerformanceManager.snapshot()` returns the plan's sections. Sections are filled by **pull-based
providers** registered by their owners (world counters from `PlanetRenderer.counters()`, combat
from `SwarmDirector.stats()` / `combat.activeCount` / `effects.activeCount`, network from the new
split RX/TX meters plus a SpacetimeDB row-update meter at the cache's single choke point, server
from a timed host snapshot publish). Nothing is sampled unless the debug overlay or a
`?perfcheck` run asks. `StatsOverlay` renders the §49 layout in both worlds.

### 4. Planet lifetime (`ResourceRegistry`, `PlanetRoot`, new `dispose()`s)

`PlanetRenderer` now owns a registry; `createPlanetWorld` hands it the resources the world was
built from (baked `tex1/tex2`, the gradient lookup, the per-world material registry with every
GLB remap, the foliage SDF). Teardown order is systems → subtree (`PlanetRoot.dispose()` walks
with r186's `Object3D.dispose()` contract, skipping registry-shared resources and honouring
custom overrides) → registry. Before this pass those resources were leaked on every planet
replacement; `renderer.info.memory` growth across matches is the observable.

### 5. Grass LOD dissolve (Phases 5/7)

The sector band logic (hysteresis) is unchanged; what changed is that the keep fraction *walks*
to its target over `GRASS_LOD_FADE_SECONDS = 1.1 s`. Because blades are bucketed in
acceptance order, the drawRange prefix is a stable per-blade seed: the transition is exactly
`hash(seed) < keep` without a hash, without RNG, and without a per-blade test. Steady-state
counts are unchanged (dev world: `19/128 sectors · 119,316/1,292,391 blades`, the same numbers as
the mobile-overhaul record).

### 6. Async precompilation (Phase 15)

`precompilePipelines()` runs behind the loading screen on world attach. Every step is wrapped in
a timeout + try/catch; compute compilation only runs on a real WebGPU backend; `?precompile=0`
disables it. Verified live: WebGPU `{compiled: 1, failed: 0, ms: 470}`; WebGL
`{compiled: 1, failed: 0, ms: 2084}` — slower, as expected, and never blocking the boot.

### 7. Deterministic benchmarks + verdict (Phases 40/41)

`?bench=<name>` pins a named load for both runs of an A/B; `?perfcheck=<seconds>` now reports the
scenario, 1 % low fps, peak frame, heap delta and the full §49 telemetry line alongside the
existing budget table.

---

## Verification performed in this pass

| Check | Command / URL | Result |
| --- | --- | --- |
| Typecheck (r186 types) | `npx tsc --noEmit` | PASS |
| Production build | `npm run build` | PASS (366 modules, three 0.186.1) |
| Universe/ring parity test | `npm run test:universe` | PASS — `ring parity OK — 314721 grid points` |
| Live WebGPU boot (dev world) | `?devworld&stats&precompile=1` | `[render] backend: webgpu`; `[caps] … compute=yes maxTex=8192`; `[precompile] {compiled: 1, failed: 0, ms: 470}`; 52 draws · 1,391,978 tris · `19/128 sectors · 119,316/1,292,391 blades`; no page errors |
| Live WebGL2 fallback | `?devworld&stats&backend=webgl&precompile=1` | `[render] backend: webgl … chosen: WebGL compatibility`; `[caps] … compute=no`; same scene (52 draws · 1,391,978 tris · identical grass counts); no page errors |
| Telemetry/overlay | `?devworld&stats` | fps/frame/cpu/draws/triangles/geometry/canvas `1040x595 @1.25 · webgpu`/grass/vegetation/enemies/particles/network/server lines all populated |
| Visual sample | dev-world screenshots on both backends | world renders on both; no missing grass/terrain/props |

The S25 Ultra run (Phase 41) and any 30-minute sustained thermal run still need the device; the
harness now makes those runs attributable and comparable:

```
?devworld&stats&bench=vegetation           # visual/world load
<match>&bench=full&perfcheck=60&debug=1    # full match, 60 s verdict incl. 1 % low + heap delta
<match>&bench=full&perfcheck=60&grasslod=0&spatialhash=0&enemytiers=0   # A/B controls off
```

---

## Documented deviations (with reasons)

1. **GPU-compute particles (Phases 12/14/46).** The premise — "CPU only spawns/kills/configures,
   GPU simulates" — is already satisfied where it matters: ambient motes are entirely
   shader-simulated with zero per-frame CPU work (`FloatingParticles`), and combat bursts are a
   bounded, pooled, single-draw system whose per-spawn path allocates nothing
   (`Effects` + `BillboardParticles`). A compute rewrite would move a few hundred microseconds of
   CPU per frame while risking the combat VFX the plan forbids regressing, and r186 shipped with
   reported `compileAsync` compute/binding issues. The capability gate, the async compute
   compile plumbing and the fallback discipline are in place; **revisit when** a profile shows the
   particle update loop above ~1 ms/frame, or when >8k live particles are needed (raising the cap
   is otherwise the cheaper lever).

2. **World-generation worker (Phase 31).** There are no workers in the project, and generation is
   already non-blocking: the bake is row-chunked with event-loop yields (`PlanetSurfaceData.bake`)
   and runs behind the loading screen or as a background pre-build (`preloadMatchWorld`).
   A worker would ship a second copy of the three.js bundle to phones to parallelise a task that
   is not on the critical path or the frame budget. **Revisit when** a cold `npm run dev` mid-range
   phone profile shows the main-thread bake producing visible jank despite the yields.

3. **SpacetimeDB interest management (Phase 28).** The official transport relays per-match
   gameplay messages (`match_msg`) rather than replicating entity tables, and subscriptions are
   already per-scope; there is no whole-planet entity stream to partition into neighbour regions.
   Region IDs would add protocol surface without reducing bytes, which the mobile-overhaul record
   already measured as not the binding constraint. **Revisit when** snapshot bytes/second becomes
   the limiting factor (the new RX/TX meters make that measurable).

4. **Server AI scheduling (Phase 30).** The server does not run enemy AI — the host client is
   authoritative for the horde and already schedules it with tiered strides and per-id staggering
   (Phase 21). Bucketing would have to move the authority, which the plan's own §27 forbids.

5. **Fixed client timestep (Phase 45).** The authoritative server ticks at a fixed 10 Hz and the
   client predicts/reconciles; the host client's own simulation is the authority for its match, so
   forcing a fixed step there would change movement feel without a correctness gain. The dev world
   already runs fixed-step physics.

6. **GTAO (Phase 20).** The project never used GTAO; r186's GTAO behaviour change therefore has no
   code path to retune.

---

## Practical notes

* `?stats` / `?overlay` show the §49 telemetry overlay; `?debug=1` logs the rolling frame line;
  `?perfcheck=<seconds>` prints the budget verdict.
* `?backend=webgl` pins the fallback for A/B testing on a desktop; on a device without WebGPU the
  same adapter is chosen automatically and everything must still work — that is the invariant the
  fallback rows above verify.
* `?bench=` and the URL flags exist for isolation; the build flags (`VITE_*`) only seed their
  defaults, so a URL always wins.
* Budget accounting stays where it was (mobile plan §119–§122); this pass added the r186
  capability, telemetry, precompilation and memory-ownership layers underneath it.
