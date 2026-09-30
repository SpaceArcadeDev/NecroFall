# Third-party notices

NECROFALL vendors source code and art assets from third parties. The notices below
cover everything distributed inside this repository (source trees, `public/`, `assets/`).

---

## Folio 2025 — rendering architecture & environment assets

- **Source:** https://github.com/brunosimon/folio-2025
- **Author:** Bruno Simon
- **License:** MIT

The Folio-style rendering stack under `src/rendering/**` is a TypeScript port of
Folio 2025's `sources/Game/**` modules (renderer, materials, quality, passes,
resource loading, ticker, wind/fog/lighting, world systems). The low-poly
environment assets served from `public/environment/folio/**` (trees, bushes,
flowers, scenery, foliage SDF and palette textures) are reused Folio assets.

The upstream license text is kept verbatim at `assets/folio-2025-LICENSE.md`.

---

## three.js

- **Source:** https://github.com/mrdoob/three.js
- **License:** MIT

The game renders through `three/webgpu` + TSL (`three/tsl`) and reuses three's
MIT-licensed addons (GLTFLoader, DRACOLoader, KTX2Loader, BloomNode, and the
WebGPU renderer). The Draco decoder and Basis Universal transcoder served from
`public/environment/folio/` are the copies distributed with three.js
(Draco: Apache License 2.0 · Basis Universal: Apache License 2.0).

## Rapier (@dimforge/rapier3d)

- **Source:** https://github.com/dimforge/rapier
- **License:** Apache License 2.0

Physics simulation (planets, colliders, character and projectile dynamics) runs
on Rapier's WebAssembly build via `@dimforge/rapier3d`.

