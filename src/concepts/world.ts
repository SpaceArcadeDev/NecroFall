import {
  AdditiveBlending, BackSide, BufferGeometry, CanvasTexture, Color, DoubleSide,
  Float32BufferAttribute, Fog, Group, Mesh, MeshBasicNodeMaterial, PlaneGeometry,
  Quaternion, RingGeometry, Scene, SphereGeometry, SRGBColorSpace, Vector3, type Camera,
} from 'three/webgpu';
import { cameraPosition, color, mix, normalWorld, positionLocal, positionWorld, sin, smoothstep, texture, vec3 } from 'three/tsl';
import { randomSource, type PlanetState, type PlanetStudy } from './definitions';
import { animateCreature, creature, explorer, type Creature } from './enemies';
import { Batches, fbm, heightAt, motionTime, noise, toon } from './procedural';
import type { BaseSurface } from './BaseGeology';

export type StudyView = 'surface' | 'orbit' | 'fauna';
export interface StudyWorld {
  scene: Scene;
  camera: Vector3;
  target: Vector3;
  minDistance: number;
  maxDistance: number;
  update: (time: number, camera?: Camera) => void;
  setState?: (state: PlanetState) => void;
  setEffects?: (enabled: boolean) => void;
  surface?: BaseSurface;
  dispose: () => void;
  creatures: Creature[];
}

function atmosphere(radius: number, tint: string): Mesh {
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
  material.colorNode = color(tint);
  material.opacityNode = normalWorld.dot(cameraPosition.sub(positionWorld).normalize()).abs().oneMinus().pow(3.5).mul(0.65);
  material.fog = false;
  return new Mesh(new SphereGeometry(radius * 1.028, 48, 32), material);
}

function planetMap(study: PlanetStudy, seed: number): { surface: CanvasTexture; clouds: CanvasTexture } {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 384;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(canvas.width, canvas.height);
  const cloudCanvas = document.createElement('canvas');
  cloudCanvas.width = canvas.width;
  cloudCanvas.height = canvas.height;
  const cloudContext = cloudCanvas.getContext('2d')!;
  const cloudImage = cloudContext.createImageData(canvas.width, canvas.height);
  const ocean = new Color(study.water).multiplyScalar(0.58), ground = new Color(study.ground);
  const coast = new Color(study.highland), bloom = new Color(study.foliage), infected = new Color(study.infection);
  const tint = new Color();
  for (let row = 0; row < canvas.height; row++) {
    const latitude = row / (canvas.height - 1) * Math.PI;
    for (let column = 0; column < canvas.width; column++) {
      const longitude = column / (canvas.width - 1) * Math.PI * 2;
      const x = -Math.cos(longitude) * Math.sin(latitude), y = Math.cos(latitude), z = Math.sin(longitude) * Math.sin(latitude);
      const continent = fbm(x * 2.8 + seed % 611, y * 2.8, z * 2.8);
      const small = fbm(x * 35 + seed, y * 35, z * 35);
      const tendril = Math.abs(Math.sin(x * 13 + z * 11 + fbm(x * 7, y * 7, z * 7) * 15));
      tint.copy(continent < 0.49 ? ocean : ground);
      if (continent > 0.478 && continent < 0.512) tint.lerp(coast, Math.max(0, 1 - Math.abs(continent - 0.495) * 60) * 0.75);
      if (continent > 0.53) tint.lerp(bloom, Math.min(0.85, (continent - 0.53) * 6));
      if (continent > 0.5 && tendril < 0.11) tint.lerp(infected, 0.78);
      tint.multiplyScalar(0.7 + small * 0.6);
      if (Math.abs(y) > 0.9) tint.lerp(coast, (Math.abs(y) - 0.9) * 6);
      tint.convertLinearToSRGB();
      const index = (row * canvas.width + column) * 4;
      image.data[index] = Math.min(255, tint.r * 255);
      image.data[index + 1] = Math.min(255, tint.g * 255);
      image.data[index + 2] = Math.min(255, tint.b * 255);
      image.data[index + 3] = 255;
      const cloudNoise = fbm(x * 9 + seed, y * 16, z * 9) + noise(x * 32, y * 32, z * 32) * 0.07;
      const opacity = Math.min(0.72, Math.max(0, (cloudNoise - 0.59) * 4));
      cloudImage.data[index] = cloudImage.data[index + 1] = cloudImage.data[index + 2] = opacity * 255;
      cloudImage.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  cloudContext.putImageData(cloudImage, 0, 0);
  const map = new CanvasTexture(canvas);
  map.colorSpace = SRGBColorSpace;
  return { surface: map, clouds: new CanvasTexture(cloudCanvas) };
}

function planet(study: PlanetStudy, seed: number, radius: number, detail: number): Group {
  const root = new Group();
  const geometry = new SphereGeometry(radius, detail, Math.floor(detail * 0.65));
  const positions = geometry.attributes.position;
  const colors: number[] = [];
  const ocean = new Color(study.water).multiplyScalar(0.49), coast = new Color(study.highland);
  const ground = new Color(study.ground), growth = new Color(study.foliage), infected = new Color(study.infection);
  const tint = new Color();
  for (let index = 0; index < positions.count; index++) {
    const direction = new Vector3().fromBufferAttribute(positions, index).normalize();
    const continent = fbm(direction.x * 3.8 + seed % 611, direction.y * 3.8, direction.z * 3.8);
    const detailNoise = noise(direction.x * 38, direction.y * 38 + seed, direction.z * 38);
    const fracture = Math.abs(Math.sin(direction.x * 10 + direction.z * 13 + fbm(direction.x * 6, direction.y * 6, direction.z * 6) * 17));
    tint.copy(continent < 0.49 ? ocean : ground);
    if (continent > 0.49 && continent < 0.525) tint.lerp(coast, 0.6);
    if (continent > 0.55) tint.lerp(growth, Math.min(0.82, (continent - 0.55) * 4));
    if (continent > 0.50 && fracture < 0.15 && direction.x > -0.6) tint.lerp(infected, 0.85);
    if (Math.abs(direction.y) > 0.88) tint.lerp(new Color(study.highland), 0.5);
    tint.multiplyScalar(0.77 + detailNoise * 0.4);
    colors.push(tint.r, tint.g, tint.b);
    direction.multiplyScalar(radius * (1 + Math.max(0, continent - 0.49) * 0.032));
    positions.setXYZ(index, direction.x, direction.y, direction.z);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const material = toon();
  const maps = planetMap(study, seed);
  material.map = maps.surface;
  material.colorNode = texture(material.map).rgb.mul(smoothstep(-0.18, 0.48, normalWorld.dot(vec3(-0.45, 0.82, 0.36))).mul(0.7).add(0.3));
  material.fog = false;
  root.add(new Mesh(geometry, material), atmosphere(radius, '#85e9ff'));
  const cloudGeometry = new SphereGeometry(radius * 1.012, 64, 40);
  const clouds = toon('#f4fcff');
  clouds.map = maps.clouds;
  clouds.opacityNode = texture(maps.clouds).r;
  clouds.transparent = true;
  clouds.depthWrite = false;
  clouds.fog = false;
  root.add(new Mesh(cloudGeometry, clouds));
  const rings = new RingGeometry(radius * 1.35, radius * 1.93, 160, 8);
  const ringColors: number[] = [];
  const ringPositions = rings.attributes.position;
  const ringTint = new Color(study.highland).lerp(new Color('#c6d9e5'), 0.55);
  for (let index = 0; index < ringPositions.count; index++) {
    const distance = Math.hypot(ringPositions.getX(index), ringPositions.getY(index));
    const band = 0.3 + Math.sin(distance / radius * 220) * 0.17 + Math.sin(distance / radius * 78) * 0.14;
    ringColors.push(ringTint.r, ringTint.g, ringTint.b, band);
  }
  rings.setAttribute('color', new Float32BufferAttribute(ringColors, 4));
  const ringMaterial = toon('#ffffff', true);
  ringMaterial.colorNode = color(ringTint).mul(sin(positionLocal.length().mul(180 / radius)).mul(0.25).add(0.75));
  ringMaterial.opacityNode = sin(positionLocal.length().mul(380 / radius)).mul(0.16).add(0.3);
  ringMaterial.side = DoubleSide;
  ringMaterial.transparent = true;
  ringMaterial.depthWrite = false;
  ringMaterial.fog = false;
  const ring = new Mesh(rings, ringMaterial);
  ring.rotation.set(1.06, -0.18, -0.38);
  root.add(ring);
  return root;
}

function cloudTexture(seed: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const context = canvas.getContext('2d')!;
  const random = randomSource(seed);
  for (let puff = 0; puff < 48; puff++) {
    const x = 50 + random() * 400, y = 95 + random() * 70;
    const radius = 24 + random() * 49;
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(0.63, 'rgba(255,255,255,0.75)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function sky(scene: Scene, study: PlanetStudy, seed: number, orbital: boolean): void {
  const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false });
  material.colorNode = mix(color(orbital ? '#142c3d' : study.horizon), color(orbital ? '#020611' : study.sky),
    smoothstep(-0.08, 0.42, positionWorld.normalize().y));
  material.fog = false;
  scene.add(new Mesh(new SphereGeometry(850, 32, 16), material));
  const random = randomSource(seed + 451);
  if (!orbital) {
    const large = planet(study, seed + 345, 82, 96);
    large.position.set(-95, 148, -375);
    large.rotation.set(0.2, 1.1, -0.25);
    scene.add(large);
    const moon = new Mesh(new SphereGeometry(12, 24, 16), toon(study.foliageLight));
    moon.material.fog = false;
    moon.position.set(125, 146, -330);
    scene.add(moon);
    const texture = cloudTexture(seed);
    for (let index = 0; index < 17; index++) {
      const cloudMaterial = new MeshBasicNodeMaterial({ map: texture, transparent: true, depthWrite: false, opacity: study.flora === 'fungus' ? 0.25 : 0.84 });
      cloudMaterial.color.set(study.sun);
      cloudMaterial.fog = false;
      const cloud = new Mesh(new PlaneGeometry(90 + random() * 130, 42 + random() * 28), cloudMaterial);
      cloud.position.set((random() - 0.5) * 760, 42 + random() * 137, -300 - random() * 70);
      cloud.lookAt(30, 30, 95);
      scene.add(cloud);
    }
  }
  if (orbital || study.flora === 'fungus') {
    const stars = new Batches();
    for (let index = 0; index < 650; index++) {
      const direction = new Vector3(random() - 0.5, random() - 0.35, random() - 0.5).normalize().multiplyScalar(690);
      const size = 0.13 + random() * 0.55;
      stars.add('orb', direction, new Vector3(size, size, size), index % 4 ? '#b0d3e1' : '#e8c393', new Quaternion(), true);
    }
    const group = new Group();
    stars.finish(group);
    group.traverse((object) => { if (object instanceof Mesh) object.material.fog = false; });
    scene.add(group);
  }
}

function terrain(study: PlanetStudy, seed: number, mobile: boolean): Mesh {
  const resolution = mobile ? 104 : 172;
  const geometry = new PlaneGeometry(560, 560, resolution, resolution);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, 0, -105);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index++) positions.setY(index, heightAt(positions.getX(index), positions.getZ(index), study, seed));
  geometry.computeVertexNormals();
  const normals = geometry.attributes.normal, colors: number[] = [];
  const ground = new Color(study.ground), highland = new Color(study.highland), rock = new Color(study.rock);
  const tint = new Color();
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index), y = positions.getY(index), z = positions.getZ(index);
    const mottling = fbm(x * 0.085 + seed, z * 0.085);
    tint.copy(ground).lerp(highland, Math.max(0, (mottling - 0.32) * 1.3));
    tint.lerp(rock, Math.min(0.92, Math.max(0, (1 - normals.getY(index) - 0.06) * 2.8)));
    if (y < 2) tint.lerp(highland, 0.65);
    if (study.flora === 'crystal' && y > 25) tint.lerp(highland, Math.min(0.95, (y - 25) / 20));
    tint.multiplyScalar(0.92 + noise(x * 0.7, z * 0.7) * 0.15);
    colors.push(tint.r, tint.g, tint.b);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  const material = toon();
  material.vertexColors = true;
  return new Mesh(geometry, material);
}

function flora(batches: Batches, study: PlanetStudy, seed: number, x: number, z: number, scale: number, random: () => number): void {
  const floor = heightAt(x, z, study, seed);
  if (floor < 1) return;
  const base = new Vector3(x, floor - 0.2, z);
  const height = (study.flora === 'fungus' ? 18 : 13) * scale;
  if (study.flora === 'crystal') {
    for (let shard = 0; shard < 6; shard++) {
      const angle = shard * 2.4;
      const shardHeight = height * (0.3 + random() * 0.8);
      const point = base.clone().add(new Vector3(Math.cos(angle) * scale * 2.2, shardHeight / 2, Math.sin(angle) * scale * 2.2));
      batches.add('crystal', point, new Vector3(scale * (1 + random()), shardHeight, scale * 1.2), shard % 3 ? study.foliage : study.foliageLight,
        new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.cos(angle) * 0.3));
    }
    return;
  }
  const trunk = study.flora === 'fungus' ? '#698da0' : study.rock;
  const lean = (random() - 0.5) * height * 0.4;
  const middle = base.clone().add(new Vector3(lean * 0.4, height * 0.55, 0));
  const top = base.clone().add(new Vector3(lean, height, 0));
  batches.branch(base, middle, scale * 0.95, trunk);
  batches.branch(middle, top, scale * 0.55, trunk);
  for (let root = 0; root < 5; root++) {
    const angle = root / 5 * Math.PI * 2;
    const end = new Vector3(x + Math.cos(angle) * scale * 3, 0, z + Math.sin(angle) * scale * 3);
    end.y = heightAt(end.x, end.z, study, seed);
    batches.branch(base.clone().add(new Vector3(0, scale * 2, 0)), end, scale * 0.5, trunk);
  }
  const spread = study.flora === 'canopy' ? 6 : study.flora === 'fungus' ? 7 : 3;
  for (let branch = 0; branch < (study.flora === 'coral' ? 9 : 5); branch++) {
    const angle = branch * 2.4 + random() * 0.4;
    const end = top.clone().add(new Vector3(Math.cos(angle) * spread * scale, (random() - 0.7) * height * 0.5, Math.sin(angle) * spread * scale));
    batches.branch(middle, end, scale * 0.3, trunk);
    if (study.flora === 'canopy') {
      for (let tuft = 0; tuft < 5; tuft++) {
        const angle = tuft * 2.4;
        const crown = scale * (2.6 + random());
        const offset = new Vector3(Math.cos(angle) * scale * 2.3, Math.sin(tuft * 1.7) * scale, Math.sin(angle) * scale * 2.3);
        batches.add('leaf', end.clone().add(offset), new Vector3(crown * 1.35, crown * 0.52, crown), tuft % 3 ? study.foliage : study.foliageLight);
      }
    } else if (study.flora === 'fungus') {
      const crown = (study.flora === 'fungus' ? 6.4 : 5.1) * scale * (0.75 + random() * 0.4);
      batches.add('crown', end, new Vector3(crown, crown * 0.8, crown), branch % 2 ? study.foliage : study.foliageLight);
      if (study.flora === 'fungus') {
        batches.add('crown', end.clone().add(new Vector3(0, -0.4 * scale, 0)), new Vector3(crown * 1.025, crown * 0.23, crown * 1.025), study.infection, new Quaternion(), true);
        for (let gill = 0; gill < 3; gill++) {
          const gillEnd = end.clone().add(new Vector3(Math.cos(gill * 2) * crown * 0.6, -scale * (2 + random() * 2), Math.sin(gill * 2) * crown * 0.6));
          batches.branch(end, gillEnd, scale * 0.05, study.infection, true);
        }
      }
    } else if (study.flora === 'coral') {
      for (let finger = 0; finger < 3; finger++) {
        const tip = end.clone().add(new Vector3((finger - 1) * scale * 2.6, scale * (2 + random() * 5), (random() - 0.5) * scale * 3));
        batches.branch(end, tip, scale * 0.43, branch % 2 ? study.foliage : study.foliageLight);
        batches.add('orb', tip, new Vector3(scale * 0.5, scale * 0.8, scale * 0.5), study.foliageLight);
      }
    } else {
      const orientation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.cos(angle) * 0.8);
      batches.add('crown', end, new Vector3(scale * 1.1, scale * 10, scale * 3), branch % 2 ? study.foliage : study.foliageLight, orientation);
    }
  }
}

function scatter(scene: Scene, study: PlanetStudy, seed: number, mobile: boolean): void {
  const random = randomSource(seed);
  const batches = new Batches();
  const ground = new Color(study.ground), light = new Color(study.highland);
  for (let index = 0; index < (mobile ? 115 : 195); index++) {
    const x = (random() - 0.5) * 420, z = 92 - random() * 400;
    if (x > -55 && x < 110 && z > -140) continue;
    flora(batches, study, seed, x, z, 0.45 + random() * 0.95, random);
  }
  flora(batches, study, seed, -67, 13, 2.5, random);
  flora(batches, study, seed, 110, 14, 2, random);
  for (let index = 0; index < (mobile ? 6500 : 15000); index++) {
    const x = (random() - 0.5) * 330, z = 118 - random() * 360;
    const height = heightAt(x, z, study, seed);
    if (height < 1.4) continue;
    const scale = 0.6 + random() * 1.4;
    const tint = ground.clone().lerp(light, random() * 0.85).multiplyScalar(1.15);
    const orientation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), random() * 6.28);
    batches.add('grass', new Vector3(x, height, z), new Vector3(scale, scale, scale), tint, orientation);
    if (index % 15 === 0) {
      batches.add('orb', new Vector3(x, height + scale * 0.55, z), new Vector3(scale * 0.33, scale * 0.48, scale * 0.33), study.foliageLight);
    }
  }
  for (let index = 0; index < (mobile ? 170 : 320); index++) {
    const x = (random() - 0.5) * 430, z = 120 - random() * 440;
    const height = heightAt(x, z, study, seed);
    const scale = 0.6 + random() ** 3 * 8;
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0.3, 1, 0).normalize(), random() * 6.28);
    batches.add('rock', new Vector3(x, height, z), new Vector3(scale, scale * (0.6 + random()), scale * 0.9), study.rock, rotation);
    if (index % 4 === 0 && height > 1) {
      for (let shard = 0; shard < 4; shard++) {
        const size = 0.6 + random() * 2;
        batches.add('crystal', new Vector3(x + random() * 3, height + size, z + random() * 3), new Vector3(size * 0.34, size * 3, size * 0.3), study.infection,
          new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (random() - 0.5) * 0.8), true);
      }
    }
  }
  for (let index = 0; index < 22; index++) {
    const x = (random() - 0.5) * 440, z = -170 - random() * 110;
    const floor = heightAt(x, z, study, seed);
    const height = 12 + random() * 35;
    const width = 7 + random() * 14;
    batches.add('mesa', new Vector3(x, floor + height * 0.5, z), new Vector3(width, height, width * 0.7), study.rock);
    batches.add('rock', new Vector3(x, floor + height, z), new Vector3(width * 0.8, height * 0.1, width * 0.6), study.highland);
  }
  for (let index = 0; index < 12; index++) {
    const x = (random() - 0.5) * 420, z = -160 - random() * 160;
    const altitude = 64 + random() * 68, width = 3 + random() * 9;
    batches.add('rock', new Vector3(x, altitude, z), new Vector3(width, width * 1.4, width * 0.8), study.rock);
    batches.add('crown', new Vector3(x, altitude + width * 0.85, z), new Vector3(width, width * 0.4, width), study.ground);
  }
  const monolithX = 27, monolithZ = -184, floor = heightAt(monolithX, monolithZ, study, seed);
  for (let tower = 0; tower < 7; tower++) {
    const angle = tower * 2.4, height = tower === 0 ? 79 : 23 + random() * 35;
    const x = monolithX + Math.cos(angle) * tower * 2.4, z = monolithZ + Math.sin(angle) * tower * 2.4;
    batches.add('crystal', new Vector3(x, floor + height / 2, z), new Vector3(2.6, height, 2.4), study.armor);
  }
  batches.branch(new Vector3(monolithX, floor + 65, monolithZ), new Vector3(monolithX, 300, monolithZ), 0.2, study.infection, true);
  const root = new Group();
  batches.finish(root);
  scene.add(root);
}

function water(study: PlanetStudy): Mesh {
  const material = new MeshBasicNodeMaterial();
  const waves = sin(positionWorld.x.mul(0.65).add(positionWorld.z.mul(0.22)).add(motionTime.mul(0.8)))
    .mul(sin(positionWorld.z.mul(1.1).sub(motionTime.mul(0.45))));
  material.colorNode = mix(color(study.water).mul(0.73), color(study.water).mul(1.18), waves.mul(0.5).add(0.5))
    .add(smoothstep(0.91, 0.99, waves).mul(vec3(0.18, 0.27, 0.25)));
  const mesh = new Mesh(new PlaneGeometry(559, 559), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, 0.3, -105);
  return mesh;
}

function disposeScene(scene: Scene): void {
  const geometries = new Set<BufferGeometry>(), materials = new Set<MeshBasicNodeMaterial>(), textures = new Set<CanvasTexture>();
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      if (material.map) textures.add(material.map);
    }
    if ('dispose' in object && typeof object.dispose === 'function') object.dispose();
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
  scene.clear();
}

export function buildWorld(study: PlanetStudy, seed: number, view: StudyView, mobile: boolean, focusCreature = -1): StudyWorld {
  const scene = new Scene(), creatures: Creature[] = [];
  let camera: Vector3, target: Vector3, minDistance: number, maxDistance: number;
  let globe: Group | undefined;
  sky(scene, study, seed, view !== 'surface');
  if (view === 'surface') {
    scene.fog = new Fog(study.horizon, 180, 580);
    scene.add(terrain(study, seed, mobile), water(study));
    scatter(scene, study, seed, mobile);
    camera = new Vector3(47, 29, 103);
    target = new Vector3(-18, 26, -100);
    minDistance = 80;
    maxDistance = 320;
    const scout = explorer();
    scout.scale.setScalar(2.6);
    scout.position.set(54, Math.max(1, heightAt(54, 39, study, seed)), 39);
    scout.rotation.y = -0.3;
    scene.add(scout);
    for (let index = 0; index < 4; index++) {
      const kind = index === 3 ? 2 : index % 2;
      const rig = creature(study, seed + index * 81, kind);
      const x = index === 3 ? -27 : 4 + index * 12;
      const z = index === 3 ? -99 : 32 - index * 25;
      rig.root.position.set(x, Math.max(1, heightAt(x, z, study, seed)), z);
      rig.originY = rig.root.position.y;
      rig.root.scale.setScalar(index === 3 ? 3.7 : 1.15);
      rig.root.rotation.y = index === 3 ? 0.2 : -0.7;
      creatures.push(rig);
      scene.add(rig.root);
    }
  } else if (view === 'orbit') {
    globe = planet(study, seed, 12, mobile ? 96 : 160);
    globe.rotation.z = 0.17;
    scene.add(globe);
    camera = new Vector3(26, 13, 33);
    target = new Vector3(0, 0, 0);
    minDistance = 25;
    maxDistance = 75;
    const debris = new Batches(), random = randomSource(seed);
    for (let index = 0; index < 75; index++) {
      const angle = random() * Math.PI * 2, radius = 20 + random() * 5;
      const size = 0.06 + random() * 0.22;
      debris.add('rock', new Vector3(Math.cos(angle) * radius, Math.sin(angle) * 3, Math.sin(angle) * radius), new Vector3(size, size * 1.7, size), study.rock);
    }
    const debrisGroup = new Group();
    debris.finish(debrisGroup);
    scene.add(debrisGroup);
    const moon = new Mesh(new SphereGeometry(1.8, 24, 16), toon(study.rock));
    moon.position.set(-22, 7, -12);
    scene.add(moon);
  } else {
    scene.fog = new Fog('#152a34', 48, 130);
    camera = new Vector3(0, 14, 55);
    target = new Vector3(0, 4, 0);
    minDistance = 23;
    maxDistance = 80;
    const floor = new Mesh(new PlaneGeometry(200, 200), toon('#182e35'));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.1;
    scene.add(floor);
    const batches = new Batches();
    for (let index = 0; index < 3; index++) {
      if (focusCreature !== -1 && focusCreature !== index) continue;
      const displayX = focusCreature !== -1 ? 0 : (index - 1) * 15;
      const rig = creature(study, seed, index);
      rig.root.position.set(displayX, 0.05, 0);
      rig.root.rotation.y = Math.PI + 0.25;
      rig.root.scale.setScalar(index === 2 ? 1.55 : 1.5);
      rig.originY = 0.05;
      creatures.push(rig);
      scene.add(rig.root);
      const material = toon(study.infection, true);
      material.side = DoubleSide;
      const ring = new Mesh(new RingGeometry(index === 2 ? 7.5 : 5.4, index === 2 ? 7.54 : 5.44, 96), material);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(displayX, 0.015, 0);
      scene.add(ring);
      batches.add('orb', new Vector3(displayX, 0, 0), new Vector3(index === 2 ? 6.5 : 4.5, 0.025, index === 2 ? 5 : 3.7), '#081b22');
    }
    const group = new Group();
    batches.finish(group);
    scene.add(group);
  }
  return {
    scene, camera, target, minDistance, maxDistance, creatures,
    update(elapsed) {
      motionTime.value = elapsed;
      if (globe) globe.rotation.y = elapsed * 0.018;
      creatures.forEach((rig) => animateCreature(rig, elapsed));
    },
    dispose() { disposeScene(scene); },
  };
}