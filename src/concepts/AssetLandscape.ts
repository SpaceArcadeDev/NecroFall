import {
  DataTexture, LinearFilter, RedFormat,
  AdditiveBlending, CanvasTexture, Color, DoubleSide, Float32BufferAttribute,
  Group, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, PlaneGeometry,
  RepeatWrapping, RingGeometry, Scene, SphereGeometry, SRGBColorSpace, TextureLoader,
  Vector3,
} from 'three/webgpu';
import { attribute, cameraPosition, color, float, Fn, mix, normalWorld, positionLocal, positionWorld, screenUV, sin, smoothstep, texture, uniform, vec2, vec3, vec4, viewportSharedTexture } from 'three/tsl';
import { fbm, noise } from './procedural';
import { STUDIES, type PlanetStudy } from './definitions';
import { EnvironmentMaterial } from './EnvironmentStyle';
import { grassCoverage } from '../rendering/Environment/GrassField';

export function brineBasinDistance(positionX: number, positionZ: number, seed: number): number {
  return Math.hypot(positionX - (14 + (seed % 17 - 8) * 0.6), positionZ - (18 + (seed % 13 - 6) * 0.6));
}

export function landscapeHeight(positionX: number, positionZ: number, seed: number, study: PlanetStudy = STUDIES[0]): number {
  const offset = seed % 811;
  const broad = fbm(positionX * 0.013 + offset, positionZ * 0.013, 0.8);
  const detail = fbm(positionX * 0.075, positionZ * 0.075 + offset, 3.1);
  const river = -15 + Math.sin(positionZ * 0.025 + 0.3) * 12;
  const channel = Math.exp(-Math.pow((positionX - river) / 23, 2));
  const distance = Math.max(0, Math.min(1, (-positionZ - 55) / 150));
  const mountain = Math.pow(noise(positionX * 0.025 + offset, positionZ * 0.022), 1.5) * distance * 40;
  const curvature = (positionX * positionX + positionZ * positionZ) * 0.00014;
  if (study.landform === 'monsoon') {
    const tributary = Math.exp(-Math.pow((positionX + positionZ * 0.28 + Math.sin(positionZ * 0.06) * 8 - 22) / 11, 2));
    return 4 + broad * 26 + mountain * 0.9 - channel * 23 - tributary * 12 + detail * 1.8 - curvature;
  }
  if (study.landform === 'caldera') {
    const radius = Math.hypot(positionX * 0.8, (positionZ + 40) * 0.8);
    const rim = Math.exp(-Math.pow((radius - 61) / 17, 2)) * 42;
    return -5 + broad * 12 + rim + detail * 2 + mountain * 0.2 - curvature;
  }
  if (study.landform === 'saltern') {
    const flat = Math.floor((broad - 0.43) * 22) * 0.5 + detail * 0.35 + mountain * 0.16 - curvature * 0.35;
    const distance = brineBasinDistance(positionX, positionZ, seed);
    const blend = Math.max(0, Math.min(1, (14 - distance) / 5));
    const smooth = blend * blend * (3 - 2 * blend);
    return flat * (1 - smooth) + (-2.8 + distance * distance * 0.006) * smooth;
  }
  if (study.landform === 'faults') {
    const fault = Math.abs(Math.sin(positionX * 0.034 + positionZ * 0.015 + broad * 1.8));
    return 10 + broad * 32 + mountain * 0.8 - Math.exp(-fault * fault / 0.035) * 34 + detail - curvature;
  }
  if (study.landform === 'skylands') return 11 + Math.floor(broad * 8) * 5.5 + detail * 1.1 + mountain * 0.8 - channel * 25 - curvature;
  if (study.flora === 'coral') {
    const islands = fbm(positionX * 0.024 + offset, positionZ * 0.024, 7.7);
    return (islands - 0.48) * 68 + detail * 1.3 + mountain * 0.25 - curvature;
  }
  if (study.flora === 'sail') {
    const terrace = Math.floor(broad * 9) * 2.7;
    const dune = Math.sin(positionX * 0.042 + broad * 8) * 2.5;
    return 4 + terrace + dune + detail * 0.8 + mountain * 1.1 - channel * 8 - curvature;
  }
  if (study.flora === 'fungus') return (broad - 0.37) * 22 + detail * 1.8 - channel * 5 + mountain * 0.42 - curvature;
  if (study.flora === 'crystal') {
    const ridge = 1 - Math.abs(noise(positionX * 0.025 + offset, positionZ * 0.018) * 2 - 1);
    return 5 + broad * 15 + ridge * ridge * distance * 64 - channel * 22 + detail - curvature;
  }
  return 3 + broad * 18 + detail * 1.7 - channel * 17 + mountain - curvature;
}

export function landscapeGrassCoverage(positionX: number, positionZ: number, seed: number, study: PlanetStudy = STUDIES[0]): number {
  const warp = noise(positionX * 0.022 + seed % 157, positionZ * 0.022) * 1.3;
  const patch = noise(positionX * 0.045 + warp, positionZ * 0.045 + seed % 293);
  const reduction = study.landform === 'caldera' ? 0.33 : study.landform === 'saltern' ? 0.25 : study.flora === 'sail' ? 0.26 : study.flora === 'crystal' ? 0.18 : study.flora === 'coral' ? 0.05 : 0;
  return grassCoverage(patch - reduction);
}

export async function landscapeTerrain(seed: number, mobile: boolean, study: PlanetStudy = STUDIES[0]): Promise<Mesh> {
  const segments = mobile ? 128 : 196;
  const geometry = new PlaneGeometry(360, 380, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, 0, -95);
  const positions = geometry.attributes.position;
  const colors: number[] = [];
  const tint = new Color();
  for (let index = 0; index < positions.count; index++) {
    const positionX = positions.getX(index), positionZ = positions.getZ(index);
    const height = landscapeHeight(positionX, positionZ, seed, study);
    positions.setY(index, height);
    const mottling = fbm(positionX * 0.04 + seed, positionZ * 0.04);
    tint.set(study.ground).lerp(new Color(study.highland), Math.max(0, Math.min(1, (mottling - 0.3) * 2)));
    const coverage = landscapeGrassCoverage(positionX, positionZ, seed, study);
    tint.multiplyScalar(1 - coverage * 0.14);
    if (height < 2) tint.lerp(new Color(study.highland), 0.8);
    if (study.flora === 'crystal' && height > 22) tint.lerp(new Color('#eefaff'), Math.min(0.9, (height - 22) / 35));
    colors.push(tint.r, tint.g, tint.b);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const material = new EnvironmentMaterial({ study, base: attribute('color', 'vec3') });
  const terrain = new Mesh(geometry, material);
  terrain.receiveShadow = true;
  terrain.userData.heightAt = (positionX: number, positionZ: number) => {
    const gridX = Math.max(0, Math.min(segments - 0.00001, (positionX + 180) / 360 * segments));
    const gridZ = Math.max(0, Math.min(segments - 0.00001, (positionZ + 285) / 380 * segments));
    const column = Math.floor(gridX), row = Math.floor(gridZ), localX = gridX - column, localZ = gridZ - row;
    const offset = row * (segments + 1) + column;
    const topLeft = positions.getY(offset), topRight = positions.getY(offset + 1);
    const bottomLeft = positions.getY(offset + segments + 1), bottomRight = positions.getY(offset + segments + 2);
    return localX + localZ <= 1 ? topLeft + (topRight - topLeft) * localX + (bottomLeft - topLeft) * localZ
      : bottomRight + (bottomLeft - bottomRight) * (1 - localX) + (topRight - bottomRight) * (1 - localZ);
  };
  return terrain;
}

export function landscapeWater(seed: number, study: PlanetStudy = STUDIES[0], heightAt = (positionX: number, positionZ: number) => landscapeHeight(positionX, positionZ, seed, study)) {
  const clock = uniform(0);
  const cutouts = [uniform(new Vector3(10000, 10000, 0)), uniform(new Vector3(10000, 10000, 0))];
  const frozen = study.waterSurface === 'ice';
  const molten = study.waterSurface === 'lava';
  const geometry = new PlaneGeometry(359, 379, 112, 112);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, 0.4, -95);
  const positions = geometry.attributes.position, depths: number[] = [];
  for (let index = 0; index < positions.count; index++) {
    depths.push(0.4 - heightAt(positions.getX(index), positions.getZ(index)));
  }
  geometry.setAttribute('waterDepth', new Float32BufferAttribute(depths, 1));
  const depth = attribute('waterDepth', 'float');
  const shallow = new Color(study.water).lerp(new Color('#c8f0e3'), study.flora === 'crystal' ? 0.48 : 0.28);
  const deep = new Color(study.water).multiplyScalar(study.flora === 'fungus' ? 0.32 : 0.6);
  const body = mix(color(shallow), color(deep), smoothstep(0, 7, depth));
  const wave = frozen ? float(0) : sin(positionWorld.z.mul(0.74).add(sin(positionWorld.x.mul(0.12)).mul(1.5)).sub(clock.mul(0.65)));
  const shore = smoothstep(0.07, 0.6, depth).oneMinus().mul(0.5);
  const brokenStreaks = smoothstep(-0.1, 0.65, sin(positionWorld.x.mul(0.55).add(sin(positionWorld.z.mul(0.27))).add(clock.mul(0.14))));
  const ripples = smoothstep(0.965, 0.995, wave).mul(smoothstep(0.7, 2.5, depth)).mul(brokenStreaks).mul(0.15);
  const foam = shore.max(ripples);
  let wet = smoothstep(-0.05, 0.05, depth);
  for (const cutout of cutouts) wet = wet.mul(smoothstep(cutout.z.sub(0.2), cutout.z, positionWorld.xz.sub(cutout.xy).length()));
  const fractureWarpX = positionWorld.x.mul(0.18).fract().sub(0.5).abs().mul(3.2);
  const fractureWarpZ = positionWorld.z.mul(0.15).fract().sub(0.5).abs().mul(3.8);
  const fractures = smoothstep(0.993, 0.9995, sin(positionWorld.x.mul(0.39).add(positionWorld.z.mul(0.12)).add(fractureWarpZ)))
    .max(smoothstep(0.994, 0.9997, sin(positionWorld.z.mul(0.33).sub(positionWorld.x.mul(0.13)).add(fractureWarpX))));
  const frost = smoothstep(-0.65, 0.6, sin(positionWorld.x.mul(0.3).add(sin(positionWorld.z.mul(0.21)))).mul(sin(positionWorld.z.mul(0.43))));
  const ice = mix(color(study.water), color('#e2f4f5'), frost.mul(0.44).add(0.32).add(smoothstep(0, 5, depth).oneMinus().mul(0.18)));
  const iceSurface = mix(ice, color('#315d7b'), fractures.mul(0.7));
  const lavaFlow = smoothstep(-0.6, 0.8, sin(positionWorld.x.mul(0.24).add(sin(positionWorld.z.mul(0.16))).sub(clock.mul(0.15))));
  const lava = mix(color('#6b2431'), color('#ffbd48'), lavaFlow);
  const material = new EnvironmentMaterial({ study: { ...study, sun: '#ffffff' }, base: frozen ? iceSurface : molten ? lava : mix(body, color('#d7f3df'), foam), emission: molten ? color('#fa6d22').mul(lavaFlow).mul(0.3) : undefined, radiationMask: frozen ? fractures.mul(0.85).add(frost.mul(0.12)) : undefined, alpha: wet, alphaTest: 0.05, normal: vec3(0, 1, 0), shadows: false });
  const shaded = material.outputNode as ReturnType<typeof vec4>;
  if (!molten) material.outputNode = Fn(() => {
    const mirror = viewportSharedTexture(screenUV.add(vec2(0, wave.mul(0.0008))));
    return vec4(mix(shaded.rgb, mirror.rgb, frozen ? 0.16 : 0.06), wet);
  })();
  material.transparent = true;
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = 20;
  mesh.name = 'study-water';
  mesh.userData.surfaceType = frozen ? 'ice' : molten ? 'lava' : 'liquid';
  mesh.userData.flowing = !frozen;
  return { mesh, update(elapsed: number) { if (!frozen) clock.value = elapsed; }, setCutouts(holes: Vector3[]) { cutouts.forEach((cutout, index) => cutout.value.copy(holes[index] ?? new Vector3(10000, 10000, 0))); } };
}

export function paintedSky(seed: number, study: PlanetStudy = STUDIES[0]): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(1024, 512);
  const zenith = new Color(study.sky), horizon = new Color(study.horizon), ground = new Color(study.ground).multiplyScalar(0.55);
  const tint = new Color();
  for (let row = 0; row < 512; row++) {
    const latitude = row / 511 * Math.PI;
    for (let column = 0; column < 1024; column++) {
      const longitude = column / 1023 * Math.PI * 2;
      const height = Math.cos(latitude);
      if (height < 0) tint.copy(horizon).lerp(ground, Math.min(1, -height * 2));
      else {
        tint.copy(horizon).lerp(zenith, Math.min(1, height * 4.5 + 0.16));
        const positionX = Math.cos(longitude) * Math.sin(latitude), positionZ = Math.sin(longitude) * Math.sin(latitude);
        const cloud = fbm(positionX * 7 + seed % 53, height * 14, positionZ * 7);
        const fine = noise(positionX * 28, height * 36, positionZ * 28);
        const mass = Math.max(0, Math.min(1, (cloud + fine * 0.06 - 0.61) * 10));
        const shadow = new Color(study.horizon).lerp(new Color(study.sun), fine * 0.7 + 0.25);
        tint.lerp(shadow, mass * Math.min(1, height * 14));
      }
      tint.convertLinearToSRGB();
      const offset = (row * 1024 + column) * 4;
      image.data[offset] = tint.r * 255;
      image.data[offset + 1] = tint.g * 255;
      image.data[offset + 2] = tint.b * 255;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export function celestialPlanet(seed: number, radius: number, study: PlanetStudy = STUDIES[0]): Group {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(1024, 512);
  const infectionMask = new Uint8Array(1024 * 512);
  const tint = new Color();
  for (let row = 0; row < 512; row++) for (let column = 0; column < 1024; column++) {
    const latitude = row / 511 * Math.PI, longitude = column / 1023 * Math.PI * 2;
    const positionX = Math.sin(latitude) * Math.cos(longitude), positionY = Math.cos(latitude), positionZ = Math.sin(latitude) * Math.sin(longitude);
    const continent = fbm(positionX * 3.3 + seed % 101, positionY * 3.3, positionZ * 3.3);
    const detail = fbm(positionX * 45, positionY * 45, positionZ * 45);
    tint.set(continent > 0.5 ? study.ground : study.water);
    if (continent <= 0.5 && study.waterSurface === 'ice') tint.lerp(new Color('#d5edf6'), 0.7);
    if (continent > 0.56) tint.lerp(new Color(study.foliage), Math.min(1, (continent - 0.56) * 6));
    if (continent > 0.487 && continent < 0.51) tint.lerp(new Color(study.highland), 0.5);
    tint.multiplyScalar(0.88 + Math.floor(detail * 5) * 0.04);
    const clouds = fbm(positionX * 9 + 153, positionY * 18, positionZ * 9);
    tint.lerp(new Color('#e6f0df'), Math.max(0, Math.min(0.75, (clouds - 0.63) * 5)));
    const fissure = Math.abs(Math.sin(positionX * 15 + positionZ * 13 + fbm(positionX * 8, positionY * 8, positionZ * 8) * 16));
    infectionMask[row * 1024 + column] = continent > 0.52 ? Math.max(0, 1 - fissure / 0.14) * 255 : 0;
    if (continent > 0.52 && fissure < 0.055) tint.lerp(new Color(study.infection), 0.7);
    tint.convertLinearToSRGB();
    const offset = (row * 1024 + column) * 4;
    image.data[offset] = tint.r * 255;
    image.data[offset + 1] = tint.g * 255;
    image.data[offset + 2] = tint.b * 255;
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  const map = new CanvasTexture(canvas);
  map.colorSpace = SRGBColorSpace;
  const emissionMap = new DataTexture(infectionMask, 1024, 512, RedFormat);
  emissionMap.flipY = true;
  emissionMap.minFilter = emissionMap.magFilter = LinearFilter;
  emissionMap.needsUpdate = true;
  const material = new EnvironmentMaterial({ study, base: texture(map).rgb, radiationMask: texture(emissionMap).r.mul(1.2).add(0.05), fog: false, shadows: false });
  material.emissiveMap = emissionMap;
  material.map = map;
  const root = new Group();
  root.add(new Mesh(new SphereGeometry(radius, 96, 64), material));
  const atmosphere = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
  atmosphere.colorNode = mix(color(study.sky), color(study.infection), material.radiation.mul(0.7)).mul(1.5);
  atmosphere.opacityNode = normalWorld.dot(cameraPosition.sub(positionWorld).normalize()).abs().oneMinus().pow(3).mul(material.radiation.mul(0.25).add(0.33));
  atmosphere.fog = false;
  root.add(new Mesh(new SphereGeometry(radius * 1.023, 64, 48), atmosphere));
  const ringMaterial = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
  ringMaterial.colorNode = color('#bfd7ca');
  ringMaterial.opacityNode = sin(positionLocal.length().mul(65 / radius)).mul(0.13).add(0.3);
  ringMaterial.fog = false;
  const ring = new Mesh(new RingGeometry(radius * 1.32, radius * 1.9, 180), ringMaterial);
  ring.rotation.set(1.16, 0.3, -0.35);
  root.add(ring);
  return root;
}