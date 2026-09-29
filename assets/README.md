# NECROFALL — environment asset pipeline (rework plan §38-§41/§68/§69)

This folder is the home of every non-code environment asset, following the pipeline philosophy
borrowed from [Folio 2025](https://github.com/brunosimon/folio-2025) (used as an architectural
reference only — see `ATTRIBUTIONS.md` for provenance rules).

## Pipeline

    Blender (authoring, low-poly / stylised)
        ↓
    GLB export
        ↓
    gltf-transform (geometry optimisation: prune, dedup, weld, quantise)
        ↓
    texture compression (KTX2 / Basis via `toktx`, normal maps at half rate)
        ↓
    production GLB → loaded once by `AssetRegistry` → instanced by the world systems

Tooling: [gltf-transform](https://gltf-transform.dev) (`@gltf-transform/cli`) and
`toktx` (KTX-Software) — run them from the repository root, e.g.

    npx gltf-transform optimize assets/source/mytree.glb assets/environment/mytree.glb \
      --texture-compress ktx2 --simplify true

## Folder conventions

    assets/source/folio/     original downloads straight from Folio's repository (NEVER edited,
                             NEVER shipped directly — licence check first, see ATTRIBUTIONS.md)
    assets/environment/      converted, game-ready assets (what the game loads)
    assets/raw/              scratch: Blender files, reference photos, mood boards

## Current state

**No binary assets ship today.** Every environment object is generated procedurally in code
(`src/world/foliage/*`, `src/world/props/PropSystem.ts`, `src/world/water/*`). That is a
deliberate choice for this pass: procedural meshes are deterministic across clients, need no
download, and instantiate cleanly. The pipeline above is the path for authored replacements —
the `AssetRegistry` seam already gives them load-once, lazy-build semantics.

## Texture budgets (plan §41)

| Tier           | Max size | Use                                        |
| -------------- | -------- | ------------------------------------------ |
| mobile floor   | 256²     | masks, decals, particles                   |
| mobile default | 512²     | props, debris, small structures            |
| hero           | 1024²    | one or two hero assets per match (Nexus)   |
| justified only | 2048²+   | never for environment scatter              |

Rules:
- KTX2/Basis for everything uploaded with mip chains; PNG only for UI.
- One shared material set — reuse before you author (plan §42: materials are the draw-call lever,
  not polygon count).
- No `new MeshStandardMaterial()` per object; environment materials come from
  `src/world/rendering/EnvironmentMaterials.ts`.
