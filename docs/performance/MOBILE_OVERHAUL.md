# Mobile Performance Overhaul — implementation record (2026-10-06)

This is the delivery record for the *NecroFall Mobile Performance Overhaul* plan (the 134-section
document). It maps every phase of the plan's own implementation order (§127) to what lives in the
repo today, states the deliberate deviations and why, and lists the exact commands that reproduce
the acceptance numbers on a phone.

The plan's architecture rule is kept everywhere: **do not make the world visually simpler** — move
work from "every frame × every object" to "once at build" and "only when visible".

---

## Phase status (§127)

| # | Phase | Status | Where |
| --- | --- | --- | --- |
| 1 | Profiler: fps / frame / JS / draw calls / triangles | **DONE** | `src/performance/PerformanceMonitor.ts` (`?debug=1`, `?stresstest`), `StatsOverlay` (`?stats`), plus the new §120 budget checklist `src/performance/PerfChecklist.ts` (`?perfcheck`) |
| 2 | Pixel-ratio cap | **DONE** | `src/performance/DeviceTier.ts` (plan §2 width ladder × §71 tier ceiling), `Quality.pixelRatioMax()`, `Game.baseDpr()` |
| 3 | Grass: sectorisation + LOD + frustum culling | **DONE** | `src/rendering/Environment/Grass.ts` (128 fixed sectors, horizon cull), `GrassLOD.ts` (distance LOD with hysteresis, `drawRange` decimation) |
| 4 | Terrain cache (height / normal / slope / biome / dirt) | **DONE (pre-existing)** | `src/planet/PlanetSurface.ts` + `PlanetGenerator` + `PlanetSurfaceData` baked maps — ONE source for grass, props, water, physics, shaders |
| 5 | Static decoration instancing | **DONE (pre-existing)** | `Rocks.ts` / `Spikes.ts` / `RadioactiveCrystals.ts` / `Trees.ts` / `Foliage.ts` (leaf-card canopies) — per-variant `InstancedMesh`, one shared material per variant |
| 6 | Collision LOD | **DONE (pre-existing, analytically cheaper)** | `src/rendering/Physics/PlanetCollider.ts` — collision IS the closed-form terrain function (`PlanetSurface.radiusAt`); no discretised mesh to LOD, and vegetation is never collidable (plan §29) |
| 7 | SwarmDirector | **DONE** | `src/enemies/SwarmDirector.ts` (tiers, hysteresis, id-bucketed strides, population target) wired into `Enemies.ts` |
| 8 | AI scheduler | **DONE (pre-existing + extended)** | throttled `decide()` (`thinkInterval`) + staggered update strides; the far band (>200 m) added this pass |
| 9 | Projectile pooling | **DONE (pre-existing)** | `src/combat/Combat.ts` — fixed pool, `setCap()` by graphics preset, one instanced draw |
| 10 | Particle pooling / budgets | **DONE (pre-existing)** | `src/effects/Effects.ts` + `BillboardParticles.ts` (instanced quads, `MAX_PARTICLES` allocated at ULTRA, `setCap()` per preset) |
| 11 | SpacetimeDB interest management | **DONE (by architecture)** | see "Networking deviations" below — per-scope subscriptions + per-match relay rows; no entity tables are replicated |
| 12 | Reduce row-mutation frequency | **DONE** | pose change-gate now on **both** transports (`Game.poseSignature`), 12 Hz authority snapshot, relay rows swept by the 10 Hz tick — rows scale with ticks, not entities |
| 13 | Network quantization | **DONE (pre-existing)** | `Player.toNet()` (cm pose, rounded hp/xp/timers), `EnemyManager.serialize()` (id/type/position@10 cm/hp/flags/gen) |
| 14 | Binary encoding | **Not necessary — documented deviation** | the official wire is a SpacetimeDB relay of string payloads (`match_msg`); base64 framing of binary would ADD ~33 % and the plan's own rule is "do not fight the replication protocol". Revisit only if snapshot bytes become the binding constraint |
| 15 | World-generation worker | **Deliberate deviation** | the bake is already row-chunked with yield-to-event-loop and runs behind the loading screen / is pre-built during Necotech select (`preloadMatchWorld`). A worker would ship a second three.js bundle to phones to parallelise a non-blocking task. See "Worker deviation" below |

Plan §117–§118 (GPU/CPU split) and §103–§107 (world generated from the match seed, never networked)
were already the architecture: every client derives terrain, grass, props, puddles and particles
from the authoritative seed.

---

## What this pass changed

### 1. Device tier + pixel-ratio ladder (`src/performance/DeviceTier.ts`)

* One place answers "how much render budget does this device get" from cores / deviceMemory /
  DPR / viewport, before the first frame is measured.
* DPR cap = plan §2 ladder (`≥1800 px → 1.5`, `≥1200 px → 1.4`, else `1.25`) × §71 tier ceiling
  (high 1.5 / mid 1.4 / low 1.25). Desktop keeps its 2× allowance (the ladder targets phone
  thermals; the boot log prints the tier + cap: `[device] tier=high mobile=false … cap=1.25`).
* Boot quality level: desktop HIGH, mobile MEDIUM, low-end mobile LOW (§71). The existing adaptive
  ladder + heat watchdog keep ownership after boot.
* `Quality.pixelRatioMax()` and `Game.baseDpr()` now clamp through the same tier, so the folio
  renderer and the classic game ladder cannot disagree.

### 2. Grass sector LOD (`GrassLOD.ts` + `Grass.ts`)

* The field is still baked once, planet-wide, and never moves (§3/§7/§15 held).
* Sector grid raised 4×8 → **8×16 = 128** sectors (plan §9 sizes the work at "100–300 sector
  distance checks a frame"). Sector bounds are also the LOD unit, and a 45° patch carried a ~60 m
  bounding radius — too coarse for the LOD to discriminate. 22.5° patches do.
* One distance test per sector per frame (~128, never per blade) → per-sector LOD with
  **hysteresis** (§10): LOD1 (50 % of blades) from 28 m, LOD2 (25 %) from 62 m on the highest
  quality level; earlier bands (22/50 and 16/38) on the lower levels, where the vertex budget
  hurts most.
* Decimation is a **`geometry.setDrawRange()` prefix**: blades inside a sector were bucketed in
  acceptance order (uniform random directions), so a prefix is a spatially unbiased subset —
  transforms are untouched, nothing slides, nothing re-spawns, no per-blade test exists.
* `?grasslod=0` pins LOD0 for A/B measurement; `?grassstats=1` prints blades/sectors/verts.

Measured on the Dev World (desktop, 118 m planet):

| Metric | LOD off | LOD on |
| --- | --- | --- |
| Blades in visible sectors | 156,406 (full) | 119,316 drawn (**−24 %**) |
| Per-sector keep factors | 1.0 ×19 | 1.0 ×8, 0.5 ×10, 0.25 ×1 |
| Same-camera triangles (all visible sectors) | 1,360,893 | 1,346,391 |
| Screenshot A/B (same camera, LOD forced on/off) | — | visually identical |

The LOD only reaches the sectors whose *nearest* bound is already beyond the band; on this
planet's visible cap (~43 m at chase-camera height) that is exactly the outer band — blades there
are 20–45 px tall, so the density change is not readable, and the terrain's baked grass shadow
keeps the clump reading dense. Plan §11 (frustum + bounds, never player position) and §73 (the
watchdog may change LOD, never positions) are both held.

### 3. SwarmDirector (`src/enemies/SwarmDirector.ts`)

* Owns the two things that scale with enemy count — nothing else:
  * **Simulation tier** per enemy, one distance test per frame with hysteresis on the band edges:
    tier 0 full rate ≤ 78 m, tier 1 (½) ≤ 140 m, tier 2 (¼) ≤ 200 m, tier 3 (⅙) beyond.
    The caller (Bestiary.update) keeps the existing id-stagger (`frame % step === id % step`, §62)
    so a tier's cost never lands in one frame.
  * **Population target** (§64) — the shipped curve `14 + elapsed·0.17 + players·8` clamped to the
    preset/device cap, now centralized so one number answers "how many may exist".
* The bands KEEP the shipped 78 m / 140 m steps and add the far band: the plan's 20/45/80 m
  numbers presume a much shorter aggro radius than this match shipped with (aggro 110 m, spawn
  45–70 m, despawn 260 m), and halving the cadence of a creature the player is actively fighting
  would change the fight. Distant bodies still advance every update — never frozen (§32's "sleep"
  is expressed as a sixth-rate stride, which is the same CPU shape without a stalled horde).
* Counters (`director.stats()`) are exposed for the dev handle: `{ desired, alive, cap, tiers }`.

### 4. Perf checklist + swarm harness (§119–§122)

* `src/performance/PerfChecklist.ts` — `?perfcheck[=seconds]` samples **live-match frames only**
  ("do not optimize based on the main menu"), after a 3 s in-match warmup, and prints
  PASS/FAIL against the §121 budgets with the measured values on one copyable line.
* `src/performance/PerfHarness.ts` — `?swarm=N` keeps ~N Necrophages alive around the player
  (≤8 spawns/s, host-only, dev-gated), the plan's §120 load (100/200/400/800).
* Fixed a real counter bug found while wiring this: three's `info.render.calls` is **cumulative
  since boot**; the per-frame number is `render.drawCalls`. Both the `[perf]` log and the checklist
  now read `drawCalls` (`frameDrawCalls()`), and `Rendering.drawCalls` already did.

Budgets (§121/§122):

| Tier | draw calls | triangles | JS work | fps |
| --- | --- | --- | --- | --- |
| HIGH | < 150 | < 1.5 M | < 5 ms | ≥ 55 |
| MID | < 120 | < 1.0 M | < 6 ms | ≥ 45 |
| LOW | < 80 | < 600 k | < 7 ms | ≥ 30 |

Example run (headless desktop Chromium, 800×320, 52-enemy crowd — **not** a phone; the numbers are
here to show the harness works end-to-end, not as a device result):

```
[device]   tier=high mobile=false cores=12 mem=8GB dpr=1.25 view=800x320 cap=1.25
[perfcheck] FAIL — tier high, 219 frames over 20s —
   fps=10.9/≥ 55 FAIL · js work ms=29.45/< 5 FAIL ·
   draw calls=878/< 150 FAIL · triangles=1,474,304/< 1,500,000 PASS
```

Triangles pass; draw calls are the measured weak point (see "Next targets").

---

## How to reproduce (device acceptance)

```
http://<host>/?perfcheck=30&swarm=200&debug=true#/play   → FREEROAM/SURVIVAL, read the console
```

* `?perfcheck=30` — 30 s live-match budget check after a 3 s warm-up.
* `?swarm=200` — keep ~200 Necrophages alive around the player while sampling (§120).
* `?debug=true` — frame logging, dev handle `window.game` for console measurements
  (`game.enemies.director.stats()`, `game.rendering.renderer.info.render.drawCalls`,
  `game.envWorld.grass.bladesDrawn`).
* `?grasslod=0` — A/B the grass LOD; `?grassstats=1` — per-planting stats.
* `?stresstest=45` — one summary line (avg fps / 1 % low / peak) instead of rolling logs.

On a phone, open a live match with `?perfcheck=30` and read back the single `[perfcheck]` line.
High-end mobile should hit the HIGH row; mid-range the MID row; the LOW row is the 30 fps fallback.

---

## Deliberate deviations (with reasons)

1. **Grass LOD bands vs the plan's 18/35/70 m.** Those numbers assume shorter blades on a larger
   world. Here blades are 1.35 m tall and the chase camera's visible cap is ~43 m; at 18 m a blade
   is ~70 px tall, and halving the density there reads as a thinner lawn. Bands were placed where
   the density change is not readable (28 m / 62 m on HIGH, earlier on the lower tiers), trading a
   little saving for the plan's own "no visible LOD transitions" requirement.
2. **Enemy tiers banded at 78/140/200 m, no hard sleep.** See SwarmDirector above — behaviour of
   the fight is preserved, CPU work drops the same way.
3. **§64 population curve kept as shipped** and only centralized; the plan's `35 + players·25`
   would roughly double the crowd the game was balanced around.
4. **Binary encoding (§56/§57) not implemented.** The official wire is a SpacetimeDB relay whose
   payloads are strings (`match_msg`); base64-wrapping binary would add a third overhead while the
   plan explicitly says to exhaust state reduction first. Bandwidth is already bounded by the
   12 Hz snapshot + change-gated pose stream, and the reducer caps senders at 90 messages/s.
5. **World-generation worker (§108/§109) not implemented.** `PlanetSurfaceData.bake` is
   row-chunked and yields to the event loop behind a progress screen, and matches pre-build the
   world during Necotech select (`preloadMatchWorld`). A worker would duplicate the terrain math
   in a second module (the exact class of seed-divergence bug this repo has fixed twice) and ship
   a second three.js bundle to phones for no latency win. Revisit if the bake ever returns to the
   critical path.
6. **Desktop DPR kept at 2×.** The §2 ladder targets phone thermals; capping desktop to 1.5 would
   be a visible sharpness regression on monitors for no thermal reason.

## Next targets (measured, not yet done)

* **Draw calls (~850–880 in the harness scene vs a 150 budget).** Rendering is dominated by
  creature rigs: ~16 meshes per Necrophage (52 enemies ≈ 840 meshes). The plan's §74 instancing
  does not apply directly (each rig is procedurally unique); the candidates are (a) merging more
  static parts per rig, (b) a simplified distant body beyond ~45 m where a creature is 30–60 px
  tall, and (c) an `InstancedMesh` per genome part with per-instance matrices for same-genome
  crowds. Verify with `?perfcheck` + `?swarm=N` before/after.
* **Shadow-pass triangles** (~440 k of the 1.47 M) — visible in `?shadows=0` measurements; a
  shadow-distance cull for creatures would remove most of it.
