# Dev World Baseline — FROZEN (plan §1)

> **Status: FROZEN.** This is the golden reference for NECROFALL's rendering. The production
> world (classic/ranked matches) must reproduce these systems — see §60 of the rebuild plan and
> `RENDERING_AUDIT.md`. Do not tune this file's values without re-running the golden test (§31).

## Boot

| URL | World |
| --- | --- |
| `http://localhost:5173/#/world` | Dev World (standalone planet scene; no enemies) |
| `http://localhost:5173/#/world?planet=N` | same, planet index `N` of ring 0 at the default seed |
| `http://localhost:5173/?world=1` | full document load (use when only the hash changes) |
| `#/world?render=unlit` etc. | material debug modes (§33) |
| `#/world?renderBaseline=1` | prints + overlays this entire baseline |
| `#/world?foliageDebug=1` | live foliage / terrain-query counters |

Deterministic spawn: the dev world scans up to 800 surface samples for a **sunlit** (up·sun > 0.45),
**grassy** (grass > 0.3), **flat** (slope < 0.12) spot above the waterline, starting from
`(0.55, 0.52, 0.65)`. The same direction initialises the grass field frame.

## Frozen device / renderer (desktop default, `?renderBaseline=1` on 2026-10-01)

| Value | Setting |
| --- | --- |
| three | 0.183.2, single instance via the `three -> three/webgpu` vite alias |
| backend | `webgpu` (WebGL2 fallback only when `navigator.gpu` is missing) |
| renderer | ONE `WebGPURenderer` (`src/rendering/Rendering.ts`) |
| pixel ratio | quality-driven (level 0: ≤2, level 1: ≤1.5, level 2: ≤1.25) |
| tone mapping | **NoToneMapping** (matches folio-2025, which sets none) |
| output | `RenderPipeline`: scene pass → bloom (threshold 1 / strength 0.25 / smoothWidth 1) → cheap DOF (level 0 only), then `renderOutput` (sRGB) |
| clear/background | folio radial sky node (`Fog.skyColor`, #2b4f40 → #070d0b) |
| shadow map | 2048² (level 0) · ortho box ±46 m · bias −0.0004 · normalBias 0.06 · radius 2 |
| canvas | fullscreen, `antialias = pixelRatio < 2` |

## Frozen environment

| Value | Setting |
| --- | --- |
| sun | intensity `2.35`, colour `#fff8ec`, direction `(0.470, 0.806, 0.358)` (normalised) |
| shadow colour | `#3d2f63` (core shadow tint), core edges low `-0.2` → high `1` (ascending smoothstep!) |
| light bounce | edge −0.9 → 0.35, distance 2.4 m, multiplier 0.55, colour `#2f6b4f` |
| fog | near `34 m`, far `270 m`, colour `#1d3a30` · sky radial start 0.18 / end 1.05 |
| classic fill (legacy materials, game only) | hemisphere `#b9a6ff`/`#2a1d3d` @1.15 + rim `#7a5cff` @0.35 |
| legacy fog mirror (non-TSL materials only) | `FogExp2 #171029`, density 0.0012 |
| wind | ONE field from planet noises (`seed ^ 0x51ab`), constant direction `(sin,cos)(0.6π)`, timeFrequency 0.1, strength 1.0 |

## Frozen planet / terrain

| Value | Setting |
| --- | --- |
| default seed / planet | `3409486584` (`0:0:0:2`, SWAMP) — the terrain test planet |
| planet radius | `118 m` (`CONFIG.planetRadius`) |
| terrain mesh | ONE lat-long sphere, 320 × 160 segments, 1 draw, DoubleSide |
| terrain material | ONE `MeshDefaultMaterial`; albedo = height gradient × patch darkening (0.62 inside patch cores) |
| terrain normals | finite differences of the RENDERED height field (not the base sphere) |
| GPU data | `tex1` R height01 · G grass · B wetness · A radiation; `tex2` R rock · G biome · B puddle (384×192 RGBA8) |
| water line | `reliefMin + (reliefMax − reliefMin) × 0.24` |

## Frozen grass (default quality)

| Value | Setting |
| --- | --- |
| blades | 700² = 490,000 (level 0) / 510² / 390² |
| field reach | half-extent 70 m / 52 / 40 (visible-ground window around the player) |
| blade size | width `0.085 × (1 + 0.28·overflow)`, height `0.58 × …` |
| colour | the terrain's own colour at the blade + root→tip ramp ×0.62→×1.2 |
| shading | normal = surface radial, `flipBackfaceNormal: false`, no shadow casting/receiving |
| density | planet-stable patch noise (`perlin(dir.xz × 9)`) `smoothstep(0.32, 0.52)` → 0.22…1.0 size |
| rim | per-blade hash cull over the last 22 % of the half-extent (recycling at ~zero size) |
| parting | 0.15–1.25 m clearing + 18-slot trample trail (0.3–1.6 s), ground-level only |

## Frozen foliage counts (default quality, SWAMP)

trees 180 (birch 74 / oak 62 / cherry 44) · bushes 520 · rocks 550 · spikes 74 clusters
· crystals 48 · puddles 62 · motes 6000 · obstacles 1372. All via `PlanetSurface.sample()`
placement + the shared `MeshDefaultMaterial` lighting/fog.

## Verification

1. Boot `#/world?renderBaseline=1` → console prints the block above; overlay shows it.
2. `?render=unlit` → albedo only. `?render=normals` → smooth radial gradients (no hard black).
   `?render=biome|height|slope|fog` → smooth deterministic fields. `?render=core`/`dot` → lit
   field ≈ 0 / dot ≈ +0.9 at the spawn (sun-side).
3. The SAME seed in a production match must give the same terrain/grass/tree/rock/biome/lighting
   values — `tests/rendering/dev-world-baseline.json` is the machine-readable half (plan §31).
