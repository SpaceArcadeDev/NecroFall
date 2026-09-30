/**
 * NECROFALL — environment asset manifest (plan §47/§48).
 *
 * Runtime GLBs are the folio production assets (draco-compressed, palette
 * UV-mapped). No source asset is imported directly by gameplay code — the
 * ResourcesLoader is the only door.
 */
export const FOLIO_ROOT = '/environment/folio/';

export const ASSETS = {
  birchTree: `${FOLIO_ROOT}trees/birchTreesVisual.glb`,
  oakTree: `${FOLIO_ROOT}trees/oakTreesVisual.glb`,
  cherryTree: `${FOLIO_ROOT}trees/cherryTreesVisual.glb`,
} as const;

export type AssetKey = keyof typeof ASSETS;
