// NECROFALL — the terrain material (plan §7): Folio's MeshDefaultMaterial + the planet's own
// terrain nodes. This is what replaces the old GLSL TERRAIN_FRAG — same visual identity
// (grain, slope rock, grass creeping over flat ground, damp basins, glowing veins, fog) expressed
// through the TSL architecture so it runs on the WebGPU renderer.
import { attribute } from 'three/tsl';
import { MeshDefaultMaterial } from './MeshDefaultMaterial';
import {
  terrainAlbedoNode,
  terrainDataNode,
  terrainEmissiveNode,
  vegetationDataNode,
} from '../Environment/PlanetTerrainNodes';
import { FOLIO } from '../FolioShaderGlobals';

/** The baked biome colour attribute ('color', vec3) Planet writes per vertex. */
const bakedColorNode = () => attribute('color', 'vec3') as any;

export class NecroTerrainMaterial extends MeshDefaultMaterial {
  constructor() {
    const data = terrainDataNode();
    const bakedColor = bakedColorNode();
    const vegetation = vegetationDataNode().div(1.6);

    const colorNode = terrainAlbedoNode(data, bakedColor, vegetation);
    const emissiveNode = terrainEmissiveNode(data, FOLIO.time);

    super({
      colorNode,
      emissiveNode,
      // The terrain manages its own waterline wash in the albedo (hasWater stays off), it is the
      // shadow RECEIVER for the world, and it keeps the light bounce so gullies pick up ground
      // colour from below the way Folio's terrain does.
      hasWater: false,
      hasReveal: true,
      hasCoreShadows: true,
      hasDropShadows: true,
      hasLightBounce: true,
    });

    this.name = 'NecroTerrainMaterial';
  }
}
