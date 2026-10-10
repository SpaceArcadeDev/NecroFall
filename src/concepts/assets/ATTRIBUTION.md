# NECROFALL Game and Base Planets Asset Credits

## Stylized Mushrooms

- Original author: QumoDone
- Source: https://sketchfab.com/3d-models/stylized-mushrooms-9d22e02ce2a548959b1c4c4c1d546842
- License: Creative Commons Attribution 4.0 International
- License link: https://creativecommons.org/licenses/by/4.0/
- Modified for NECROFALL: selected hero mesh, normalized presentation scale,
  texture/geometry optimization, spherical placement and biome-specific cel shading.
- Original painted color and emissive detail are retained. No endorsement implied.

## Existing Project Trees

The original oak, cherry and birch trunk/canopy-marker assets are reused from
the game's public/environment/folio/trees directory at the user's request.
Their original applicable license and attribution remain in effect; no CC0
or other new license is asserted for these existing assets.

## Insectoid Monster Rig

- Original author: DM-913 / SuperKapoo913
- Source: https://sketchfab.com/3d-models/insectoid-monster-rig-01323e4b2563430f9da85cd255b6e176
- Author: https://sketchfab.com/SuperKapoo913
- License: Creative Commons Attribution 4.0 International
- License link: https://creativecommons.org/licenses/by/4.0/
- Modified for NECROFALL: chitin and membrane texture repaint, radiated crest
  morph target, normalized presentation scale, optimized runtime variants,
  in-place animation and Mega Necrophage gameplay presentation.
- The original author does not endorse or sponsor NECROFALL.

## Crawler Base Model

- Source: the project owner's Tripo-generated crawler GLB
  (`src/enemies/base_models/crawler.glb`; raw source and hashes are recorded in
  `.asset-sources/crawler/source.glb` and `crawler.json`).
- Modified for NECROFALL: base colour repainted into the game's violet-chitin /
  venom-gland palette, welded and simplified to the mobile triangle budget,
  textures resized to WebP, yaw/scale normalization baked in, meshopt
  compression, and a skeleton + skin weights derived from the geometry at load
  (`src/enemies/imported/AutoRig.ts`) because the source ships without a rig.
  Shaded through the game's cell-shaded creature material and presented as the
  Beacon Guardians and crawler-species Necrophages.

## Poly Haven Environment Sources

All the following asset files are CC0 1.0. Source geometry and textures have
been adapted, recolored, and optimized for the game and Base Planets gallery.
Cliffs and boulders also use completed backs and spherical terrain conformation.

- Jacaranda Tree: Rico Cilliers, Rob Tuytel. https://polyhaven.com/a/jacaranda_tree
- Namaqualand Cliff 02: Dario Barresi, Rico Cilliers. https://polyhaven.com/a/namaqualand_cliff_02
- Grass Medium 01: Rico Cilliers, Rob Tuytel. https://polyhaven.com/a/grass_medium_01
- Root Cluster 01: Jenelle van Heerden, Rico Cilliers. https://polyhaven.com/a/root_cluster_01
- Boulder 01: Rico Cilliers. https://polyhaven.com/a/boulder_01
- Aerial Grass Rock: Rob Tuytel. https://polyhaven.com/a/aerial_grass_rock
- License: https://creativecommons.org/publicdomain/zero/1.0/
- Provider license information: https://polyhaven.com/license

These credits apply to the adapted source assets, not to the whole game.
Raw sources and provenance records are kept separately in .asset-sources.