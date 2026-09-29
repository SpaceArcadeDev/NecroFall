# NECROFALL — asset attributions & provenance

## Environment rework (2026-09): procedural, original work

Every environment asset currently in the game — trees, rocks, crystals, crates, wreckage,
reeds, water surface, weather particles — is **generated procedurally in code** in this
repository. No third-party models, textures or audio are bundled with this work.

## References consulted (no assets copied)

### Folio 2025 — https://github.com/brunosimon/folio-2025

Folio (MIT, © Bruno Simon) is used as a **technical/architectural reference** for this rework:
its separation of terrain / foliage / water / weather / physics / quality systems, its
instancing strategy and its asset-pipeline philosophy informed the design of
`src/world/**`. **No Folio source files or static assets have been copied into this
repository.**

If Folio assets are ever imported into `assets/source/folio/`, each file must be checked
individually before conversion — the repository being MIT does not automatically cover every
third-party resource referenced by its sources. Any imported asset must record here:

    <file> — <author> — <licence> — <source URL> — <modifications made>

and the converted output must live in `assets/environment/` (never edited in place).

### Stylised grass field technique

`src/world/Vegetation.ts` and the grass shaders implement (originally) the layered stylised
grass approach popularised by Christian Ortiz's MIT-licensed
[`cortiz2894/stylized-components`](https://github.com/cortiz2894/stylized-components)
(clumped instancing, per-blade variation, a shared wind). The implementation here is original
code written for NecroFall.

### Three.js

[MIT](https://github.com/mrdoob/three.js/blob/dev/LICENSE) — `mergeGeometries` from
`three/examples/jsm/utils/BufferGeometryUtils.js` is used for procedural mesh assembly.
