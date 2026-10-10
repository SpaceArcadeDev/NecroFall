import { BufferGeometry, CircleGeometry, DoubleSide, Float32BufferAttribute, Group, InstancedMesh, LatheGeometry, Matrix4, Mesh, MeshBasicNodeMaterial, Object3D, RingGeometry, SphereGeometry, Vector2, Vector3, type Material, type MeshStandardMaterial } from 'three/webgpu';
import { attribute, cameraWorldMatrix, color, mix, positionLocal, positionWorld, sin, smoothstep, texture, vec3, vec4 } from 'three/tsl';
import { BASE_FEATURES, floraGeometry, volumeMaterial } from '../../concepts/BaseFeatures';
import { particleTexture } from '../../concepts/EnvironmentWeather';
import { scatterPlacements } from '../../planet/Placement';
import { SurfaceMaterial } from '../materials/SurfaceMaterial';
import { BASE_ASSETS, BaseRocks, bakeRadialGeometry, normalisedAsset } from './BaseRocks';
import type { PlanetWorldDependencies } from './PlanetRenderer';
import { createRenderedRadiusAt } from '../../planet/RenderedTerrain';
import type { Puddles } from './Puddles';
import { PlanetHazards } from '../../planet/PlanetHazards';

export class BaseEcology {
  readonly group = new Group();
  readonly features: { id: string; name: string; kind: string; count: number; sites: number[][] }[] = [];
  mushroomCount = 0;
  readonly hazards: PlanetHazards;

  private constructor(radiusAt: (direction: Vector3) => number) {
    this.hazards = new PlanetHazards(radiusAt);
  }

  static async create(deps: PlanetWorldDependencies, rocks: BaseRocks, water: Puddles): Promise<BaseEcology> {
    const result = new BaseEcology(createRenderedRadiusAt(deps.generator));
    const art = deps.generator.archetype.art!;
    result.group.name = 'base-ecology';
    for (const [index, spec] of BASE_FEATURES[art.id].entries()) {
      if (!['flower', 'reed', 'fern', 'pod'].includes(spec.kind)) continue;
      const placements = scatterPlacements(deps.surface, deps.generator, { count: 135, salt: 9109 + index * 379,
        aboveWater: 0.1, maxSlope: 0.45, scaleMin: spec.size * 0.7, scaleMax: spec.size * 1.2, attemptsPerInstance: 30,
        excludeDirection: deps.spawnDirection, excludeRadius: 5,
        accept: sample => !rocks.blocked(sample.up.x, sample.up.y, sample.up.z) });
      const geometries = floraGeometry(spec);
      for (const part of ['body', 'accent'] as const) {
        const radiation = deps.nodes.terrainNode(positionWorld).a;
        const material = new SurfaceMaterial({
          colorNode: part === 'body' ? color(art.foliage).mul(0.75) : mix(color(art.foliageLight), color(art.infection), spec.kind === 'pod' ? 0.55 : 0.18),
          glowNode: part === 'accent' ? color(art.infection).mul(radiation.pow(2).mul(0.6).add(spec.kind === 'pod' ? 0.08 : 0.01)) : undefined,
          playerOcclusion: true, hasLightBounce: false,
        });
        material.positionNode = positionLocal.add(vec3(sin(deps.time.mul(0.8).add(positionLocal.x.mul(0.2))).mul(attribute('position', 'vec3').y.pow(2)).mul(0.025), 0, 0));
        const mesh = new InstancedMesh(geometries[part], material, placements.length);
        placements.forEach((placement, instance) => mesh.setMatrixAt(instance, placement.matrix));
        mesh.name = `${spec.id}:${part}`; mesh.receiveShadow = true; mesh.computeBoundingSphere(); result.group.add(mesh);
      }
      result.features.push({ id: spec.id, name: spec.name, kind: spec.kind, count: placements.length, sites: placements.map(placement => placement.position.toArray()) });
    }
    const mushrooms = await deps.loader.loadGLTF(BASE_ASSETS.mushroom);
    const placements = scatterPlacements(deps.surface, deps.generator, { count: art.flora === 'fungus' ? 120 : 35, salt: 5129,
      aboveWater: 0.15, maxSlope: 0.4, scaleMin: art.flora === 'fungus' ? 2.5 : 0.5, scaleMax: art.flora === 'fungus' ? 8 : 1.8,
      attemptsPerInstance: 24, excludeDirection: deps.spawnDirection, excludeRadius: 8,
      accept: sample => !rocks.blocked(sample.up.x, sample.up.y, sample.up.z) });
    for (const part of normalisedAsset(mushrooms.scene)) {
      const source = part.source as MeshStandardMaterial;
      const material = new SurfaceMaterial({
        colorNode: source.map ? mix(texture(source.map).rgb, color(art.foliage), 0.18) : color(art.foliage),
        glowNode: source.emissiveMap ? texture(source.emissiveMap).rgb.mul(color(art.infection)).mul(deps.nodes.terrainNode(positionWorld).a.mul(0.6).add(0.05)) : undefined,
        playerOcclusion: true, hasLightBounce: false, side: source.side,
      });
      const mesh = new InstancedMesh(part.geometry, material, placements.length);
      placements.forEach((placement, instance) => mesh.setMatrixAt(instance, placement.matrix));
      mesh.name = 'painted-mushrooms'; mesh.castShadow = art.flora === 'fungus'; mesh.receiveShadow = true; mesh.computeBoundingSphere(); result.group.add(mesh);
    }
    result.mushroomCount = placements.length;
    result.phenomena(deps, rocks, water);
    result.group.userData.features = result.features;
    return result;
  }

  private phenomena(deps: PlanetWorldDependencies, rocks: BaseRocks, water: Puddles): void {
    const art = deps.generator.archetype.art!, radiusAt = createRenderedRadiusAt(deps.generator);
    const recipes = [...BASE_FEATURES[art.id], ...(art.id === 'saffron-waste'
      ? [{ id: 'quicksand', name: 'Quicksand', kind: 'quicksand' as const, size: 1.8, shape: 0 }] : [])];
    for (const [index, spec] of recipes.entries()) {
      if (['flower', 'reed', 'fern', 'pod'].includes(spec.kind)) continue;
      const aquatic = spec.kind === 'whirlpool';
      const size = spec.size * (spec.kind === 'vortex' ? 1.8 : spec.kind === 'quicksand' ? 1 : 1.35);
      const placements = aquatic ? water.sites.slice(0, 4).map(site => {
        const sample = deps.surface.sample(site.direction), transform = new Object3D();
        const scale = Math.min(size, site.radius * 0.85 / 5);
        deps.surface.alignToSurface(transform, sample, 0, scale); transform.updateMatrix();
        return { matrix: transform.matrix.clone(), position: sample.point.clone(), normal: sample.normal.clone(), scale,
          yaw: 0, grass: sample.grass, slope: sample.slope, radiation: sample.radiation, wetness: sample.wetness, height: sample.height };
      }) : scatterPlacements(deps.surface, deps.generator, { count: 7, salt: 11009 + index * 379,
        aboveWater: aquatic ? -1000 : 0.2, maxSlope: spec.kind === 'quicksand' ? 0.22 : 0.45, scaleMin: size, scaleMax: size,
        attemptsPerInstance: 400, excludeDirection: deps.spawnDirection, excludeRadius: 14 + size * 5,
        accept: sample => !rocks.blocked(sample.up.x, sample.up.y, sample.up.z) && water.waterDepthAt(sample.up) < 0.02 });
      this.features.push({ id: spec.id, name: spec.name, kind: spec.kind, count: placements.length, sites: placements.map(placement => placement.position.toArray()) });
      for (const placement of placements) {
        const frame = placement.matrix.clone();
        const up = placement.position.clone().normalize();
        frame.setPosition(up.clone().multiplyScalar(aquatic ? water.surfaceRadiusAt(up) + 0.04 : radiusAt(up)));
        if (spec.kind === 'quicksand' || spec.kind === 'vortex' || spec.kind === 'whirlpool' || spec.kind === 'blizzard') {
          this.hazards.add(spec.kind, up.clone().multiplyScalar(radiusAt(up)),
            placement.scale * (spec.kind === 'blizzard' ? 10 : 5), spec.kind === 'vortex' ? placement.scale * 16 : spec.kind === 'blizzard' ? placement.scale * 12 : 1.1);
        }
        if (spec.kind === 'quicksand' || spec.kind === 'vortex') {
          const geometry = new RingGeometry(0, 5, 64, 16).rotateX(-Math.PI / 2);
          const patchPosition = attribute('patchPosition', 'vec3');
          const material = new SurfaceMaterial({
            colorNode: mix(color(art.ground).mul(0.48), color(art.highland),
              sin(patchPosition.xz.length().mul(5).sub(deps.time.mul(1.2))).mul(0.16).add(0.35)),
            alphaNode: smoothstep(3.5, 5, patchPosition.xz.length()).oneMinus().mul(spec.kind === 'vortex' ? 0.5 : 0.92),
            transparent: true, depthWrite: false, hasLightBounce: false, side: DoubleSide,
          });
          const local = geometry.attributes.position;
          geometry.setAttribute('patchPosition', local.clone());
          for (let vertex = 0; vertex < local.count; vertex++) {
            const point = new Vector3().fromBufferAttribute(local, vertex).applyMatrix4(frame).normalize();
            point.multiplyScalar(radiusAt(point) + 0.1); local.setXYZ(vertex, point.x, point.y, point.z);
          }
          geometry.computeVertexNormals(); geometry.computeBoundingSphere();
          const patch = new Mesh(geometry, material);
          patch.name = `${spec.id}:ground`; this.group.add(patch);
          if (spec.kind === 'quicksand') continue;
        }
        if (spec.kind === 'volcano') {
          const profile = [[0, 0], [4.8, 0], [3.7, 0.7], [2.5, 2.6], [1.9, 2.9], [1.45, 1.4], [0, 1.4]].map(([radius, height]) => new Vector2(radius, height));
          const source = new LatheGeometry(profile, 14);
          const geometry = bakeRadialGeometry(source, { ...placement, matrix: frame }, radiusAt); source.dispose();
          const rock = new Mesh(geometry, new SurfaceMaterial({ colorNode: color(art.rock), playerOcclusion: true }));
          rock.name = spec.id; rock.castShadow = true; rock.receiveShadow = true; this.group.add(rock);
          const lava = new Mesh(new CircleGeometry(1.7, 32).rotateX(-Math.PI / 2).translate(0, 2.52, 0),
            new SurfaceMaterial({ colorNode: mix(color('#992b2c'), color('#ffbf46'), sin(positionWorld.x.mul(2).add(deps.time)).mul(0.5).add(0.5)), glowNode: color('#ff832b').mul(0.5), hasLightBounce: false }));
          lava.matrix.copy(frame); lava.matrixAutoUpdate = false; lava.name = `${spec.id}:lava`; this.group.add(lava);
        } else if (aquatic) {
          const profile = [[5, 0.04], [3, 0.025], [1.5, 0.01], [0.4, 0], [0, 0]].map(([radius, height]) => new Vector2(radius, height));
          const material = new SurfaceMaterial({ colorNode: mix(color(art.water).mul(0.55), color(art.horizon), smoothstep(0.7, 0.98, sin(positionLocal.x.atan(positionLocal.z).mul(4).add(positionLocal.xz.length().mul(3)).sub(deps.time.mul(1.7))))), hasLightBounce: false });
          const mesh = new Mesh(new LatheGeometry(profile, 64), material);
          mesh.matrix.copy(frame); mesh.matrixAutoUpdate = false; mesh.name = spec.id; this.group.add(mesh);
        } else if (spec.kind === 'vortex') {
          const profile = Array.from({ length: 18 }, (_, level) => new Vector2(1.2 + (level / 17) ** 1.5 * 3.7, level / 17 * 16));
          const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide, fog: false, toneMapped: false });
          const height = attribute('position', 'vec3').y.div(16);
          const swirl = sin(positionLocal.x.atan(positionLocal.z).mul(7).sub(height.mul(28)).add(deps.time.mul(2.4)));
          material.colorNode = mix(color(art.rock), color(art.landform === 'faults' ? art.infection : art.highland), 0.35);
          material.opacityNode = smoothstep(-0.4, 0.9, swirl).mul(0.6).add(0.12).mul(smoothstep(0, 0.06, height)).mul(smoothstep(0.75, 1, height).oneMinus()).mul(0.8);
          material.positionNode = positionLocal.add(vec3(sin(height.mul(5).add(deps.time.mul(0.25))).mul(height).mul(1.5), 0, 0));
          const mesh = new Mesh(new LatheGeometry(profile, 36), material); mesh.matrix.copy(frame); mesh.matrixAutoUpdate = false; mesh.name = spec.id; this.group.add(mesh);
        } else {
          const size = new Vector3(13, spec.id === 'fumaroles' ? 6 : 2.8, 9);
          const volumeFrame = frame.clone().multiply(new Matrix4().makeTranslation(0, size.y * 0.7, 0)).scale(size);
          const material = volumeMaterial(art, new Vector3(), size, deps.time, volumeFrame.clone().invert());
          const cloud = new Mesh(new SphereGeometry(1, 24, 12), material);
          cloud.matrix.copy(volumeFrame); cloud.matrixAutoUpdate = false; cloud.name = spec.id; this.group.add(cloud);
          if (spec.kind === 'blizzard') {
            const random = deps.generator.rand(12001 + index), positions: number[] = [], corners: number[] = [], phases: number[] = [];
            for (let flake = 0; flake < 240; flake++) {
              const point = new Vector3((random() - 0.5) * 20, 0, (random() - 0.5) * 16).applyMatrix4(frame).normalize();
              point.multiplyScalar(radiusAt(point) + 0.1); const phase = random();
              for (const corner of [[-1, -1], [1, -1], [-1, 1], [1, -1], [1, 1], [-1, 1]]) { positions.push(point.x, point.y, point.z); corners.push(...corner); phases.push(phase); }
            }
            const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(positions, 3)); geometry.setAttribute('corner', new Float32BufferAttribute(corners, 2)); geometry.setAttribute('phase', new Float32BufferAttribute(phases, 1));
            const map = particleTexture('snow'), snowMaterial = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, toneMapped: false });
            const phase = attribute('phase', 'float').add(deps.time.mul(0.22)).fract(), corner = attribute('corner', 'vec2');
            snowMaterial.map = map; snowMaterial.colorNode = color('#e8f5ff');
            snowMaterial.positionNode = positionLocal.add(positionLocal.normalize().mul(phase.oneMinus().mul(13))).add(cameraWorldMatrix.mul(vec4(corner.x.mul(0.14), corner.y.mul(0.14), 0, 0)).xyz);
            snowMaterial.opacityNode = texture(map, corner.mul(0.5).add(0.5)).a.mul(smoothstep(0, 0.1, phase)).mul(smoothstep(0, 0.1, phase.oneMinus())).mul(0.65);
            const snow = new Mesh(geometry, snowMaterial); snow.name = `${spec.id}:snow`; snow.frustumCulled = false; this.group.add(snow);
          }
        }
      }
    }
  }

  setVisible(visible: boolean): void { this.group.visible = visible; }
  dispose(): void {
    this.group.traverse(object => {
      if (!(object instanceof Mesh)) return;
      object.geometry.dispose(); (object.material as Material).dispose();
      if (object instanceof InstancedMesh) object.dispose();
    });
    this.group.clear();
  }
}