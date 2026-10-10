import { AdditiveBlending, BackSide, BufferGeometry, Color, DataTexture, Float32BufferAttribute, Group, LinearFilter, MathUtils, Mesh, MeshBasicNodeMaterial, Points, PointsMaterial, RepeatWrapping, RGBAFormat, SphereGeometry, SRGBColorSpace, Vector3, type Camera } from 'three/webgpu';
import { color, mix, normalWorld, positionLocal, texture, uniform, uv, vec2 } from 'three/tsl';
import { PlanetGenerator } from '../../planet/PlanetGenerator';
import { makePlanetSpec } from '../../planet/PlanetSeed';
import type { PlanetSystem, SystemBody } from '../../planet/PlanetSystem';
import { fbm, Rand } from '../../utils/Utils';
import type { BasePlanet } from '../../concepts/definitions';
import { daylightAt, twilightAt, TWILIGHT_COLOR } from './Daylight';

function planetMap(body: SystemBody): DataTexture {
  const generator = new PlanetGenerator(makePlanetSpec(body.descriptor.seed, body.descriptor.ring, body.radius));
  const art = generator.archetype.art!;
  const width = 128, height = 64;
  const radii = new Float32Array(width * height), directions: Vector3[] = [];
  let low = Infinity, high = -Infinity;
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const latitude = row / (height - 1) * Math.PI, longitude = (column / (width - 1) - 0.5) * Math.PI * 2;
    const direction = new Vector3(Math.sin(latitude) * Math.cos(longitude), Math.cos(latitude), Math.sin(latitude) * Math.sin(longitude));
    const value = generator.radiusAt(direction.x, direction.y, direction.z);
    directions.push(direction); radii[row * width + column] = value;
    low = Math.min(low, value); high = Math.max(high, value);
  }
  const waterLevel = low + (high - low) * 0.24;
  const pixels = new Uint8Array(width * height * 4);
  const shade = new Color(), ground = new Color(art.ground), peak = new Color(art.highland), water = new Color(art.water), foliage = new Color(art.foliage);
  for (let index = 0; index < radii.length; index++) {
    const direction = directions[index], radius = radii[index];
    if (radius < waterLevel && fbm(direction.x * 28, direction.y * 28, direction.z * 28, 2, generator.seed + 88) > 0.72) shade.copy(water).lerp(new Color('#e0f1f3'), art.waterSurface === 'ice' ? 0.65 : 0);
    else shade.copy(ground).lerp(peak, MathUtils.clamp((radius - waterLevel) / Math.max(1, high - waterLevel), 0, 1) * 0.7)
      .lerp(foliage, Math.max(0, fbm(direction.x * 7, direction.y * 7, direction.z * 7, 2, generator.seed) - 0.5));
    const cloud = Math.max(0, fbm(direction.x * 9, direction.y * 9, direction.z * 9, 2, generator.seed + 37) - 0.64) * 3;
    shade.lerp(new Color('#f1f6ed'), Math.min(0.7, cloud));
    shade.convertLinearToSRGB();
    pixels[index * 4] = shade.r * 255; pixels[index * 4 + 1] = shade.g * 255; pixels[index * 4 + 2] = shade.b * 255;
    pixels[index * 4 + 3] = generator.radiationEstimate(direction.x, direction.y, direction.z, radius - generator.radius, waterLevel) * 255;
  }
  const map = new DataTexture(pixels, width, height, RGBAFormat);
  map.colorSpace = SRGBColorSpace; map.minFilter = map.magFilter = LinearFilter; map.needsUpdate = true;
  return map;
}

export class SystemSky {
  readonly mesh = new Group();
  private readonly up = uniform(new Vector3(0, 1, 0));
  private readonly day = uniform(1);
  private readonly atmosphere: Mesh;
  private readonly stars: Points<BufferGeometry, PointsMaterial>;
  private readonly twilight = uniform(0);
  private readonly bodies: { mesh: Mesh; position: Vector3; radius: number }[] = [];
  private readonly relative = new Vector3();

  constructor(readonly system: PlanetSystem, private readonly art: BasePlanet, private readonly radius: number, clock: any = uniform(0)) {
    this.mesh.name = 'system-sky';
    const air = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false, toneMapped: false });
    const horizon = positionLocal.normalize().dot(this.up).abs().smoothstep(0, 0.65);
    const width = 256, height = 128, pixels = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
      const polar = row / (height - 1) * Math.PI, angle = column / (width - 1) * Math.PI * 2;
      const direction = new Vector3(Math.sin(polar) * Math.cos(angle), Math.cos(polar), Math.sin(polar) * Math.sin(angle));
      const broad = fbm(direction.x * 3.7, direction.y * 7.5, direction.z * 3.7, 4, system.descriptor.seed + 211);
      const detail = fbm(direction.x * 18, direction.y * 18, direction.z * 18, 2, system.descriptor.seed + 491);
      const value = MathUtils.clamp((broad * 0.8 + detail * 0.2) * 255, 0, 255), offset = (row * width + column) * 4;
      pixels.set([value, value, value, 255], offset);
    }
    const clouds = new DataTexture(pixels, width, height, RGBAFormat); clouds.wrapS = RepeatWrapping;
    clouds.minFilter = clouds.magFilter = LinearFilter; clouds.needsUpdate = true; air.map = clouds;
    const cloud = texture(clouds, uv().add(vec2(clock.mul(0.0007), 0))).r.smoothstep(0.48, 0.68);
    const towardSun = positionLocal.normalize().dot(uniform(system.sunDirection)).max(0);
    const sunset = horizon.oneMinus().mul(this.twilight);
    const horizonColor = mix(color('#bd7893'), color(TWILIGHT_COLOR), towardSun.sqrt());
    const daySky = mix(color(art.horizon), color(art.sky), horizon);
    const sky = mix(mix(color('#02040c'), daySky, this.day), horizonColor, sunset.mul(0.82));
    const cloudColor = mix(mix(color(art.rock).mul(0.025), color(art.horizon).mul(0.95), this.day),
      mix(color('#bd7893'), color('#ffd19a'), towardSun), this.twilight.mul(0.8));
    const sunTint = mix(color(system.sunColor), color(TWILIGHT_COLOR), this.twilight.mul(0.9));
    air.colorNode = mix(sky, cloudColor, cloud.mul(0.58))
      .add(sunTint.mul(towardSun.pow(12)).mul(this.twilight).mul(0.28));
    this.atmosphere = new Mesh(new SphereGeometry(1450, 32, 16), air);
    this.mesh.add(this.atmosphere);
    const random = new Rand(system.descriptor.seed ^ 0x918ac31), starPositions: number[] = [], starColors: number[] = [];
    const tint = new Color();
    for (let star = 0; star < 2400; star++) {
      const axisY = random.next() * 2 - 1, angle = random.next() * Math.PI * 2, radial = Math.sqrt(1 - axisY * axisY);
      starPositions.push(radial * Math.cos(angle), axisY, radial * Math.sin(angle));
      tint.set(['#e5f0ff', '#fff0cf', '#b8dded'][star % 3]).multiplyScalar(0.6 + random.next() * 0.4);
      starColors.push(tint.r, tint.g, tint.b);
    }
    const stars = new BufferGeometry(); stars.setAttribute('position', new Float32BufferAttribute(starPositions, 3)); stars.setAttribute('color', new Float32BufferAttribute(starColors, 3));
    this.stars = new Points(stars, new PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
    this.stars.name = 'system-stars'; this.stars.frustumCulled = false; this.mesh.add(this.stars);
    const neighbours = system.bodies.filter(body => body !== system.active)
      .sort((first, second) => first.position.distanceToSquared(system.active.position) - second.position.distanceToSquared(system.active.position)).slice(0, 4);
    for (const body of neighbours) {
      const map = planetMap(body), sample = texture(map);
      const towardSun = system.sunPosition.clone().sub(body.position).normalize();
      const material = new MeshBasicNodeMaterial({ depthWrite: true, fog: false, toneMapped: false });
      const illumination = normalWorld.dot(uniform(towardSun)).smoothstep(-0.08, 0.8).mul(4).floor().div(4);
      const palette = new PlanetGenerator(makePlanetSpec(body.descriptor.seed, body.descriptor.ring, body.radius)).archetype.art!;
      material.colorNode = sample.rgb.mul(illumination.mul(0.94).add(0.035)).add(color(palette.infection).mul(sample.a.mul(sample.a)).mul(illumination.oneMinus()).mul(0.25));
      material.map = map;
      const globe = new Mesh(new SphereGeometry(1, 48, 32), material);
      globe.name = `system-planet:${body.descriptor.key}`;
      this.mesh.add(globe); this.bodies.push({ mesh: globe, position: body.position, radius: body.radius });
    }
    const sunMaterial = new MeshBasicNodeMaterial({ color: system.sunColor, fog: false, toneMapped: false, depthWrite: true });
    sunMaterial.colorNode = sunTint.mul(mix(2.5, 1.15, this.twilight));
    const sun = new Mesh(new SphereGeometry(1, 40, 24), sunMaterial); sun.name = 'system-sun'; this.mesh.add(sun);
    this.bodies.push({ mesh: sun, position: system.sunPosition, radius: system.sunRadius });
    const haloMaterial = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false, toneMapped: false });
    haloMaterial.colorNode = sunTint.mul(mix(0.5, 0.85, this.twilight));
    haloMaterial.opacityNode = normalWorld.dot(uniform(system.sunDirection)).abs().oneMinus().pow(3).mul(0.2);
    const halo = new Mesh(new SphereGeometry(1, 32, 24), haloMaterial); this.mesh.add(halo);
    this.bodies.push({ mesh: halo, position: system.sunPosition, radius: system.sunRadius * 1.08 });
    this.mesh.userData.system = { name: system.descriptor.name, activeSeed: system.active.descriptor.seed,
      neighbours: neighbours.map(body => ({ seed: body.descriptor.seed, key: body.descriptor.key, name: body.descriptor.name })), sunDirection: system.sunDirection.toArray() };
  }

  update(focus: Vector3, camera?: Camera): void {
    this.up.value.copy(focus).normalize();
    const observer = camera?.position ?? focus;
    const far = (camera as any)?.far ?? 1800;
    const skyDistance = Math.min(1000, far * 0.72);
    const elevation = this.up.value.dot(this.system.sunDirection);
    const atmosphere = 1 - MathUtils.smoothstep(observer.length(), this.radius * 1.35, this.radius * 3);
    this.day.value = daylightAt(elevation) * atmosphere;
    this.twilight.value = twilightAt(elevation) * atmosphere;
    this.stars.material.opacity = 1 - MathUtils.smoothstep(this.day.value, 0.02, 0.48);
    this.stars.position.copy(observer); this.stars.scale.setScalar(skyDistance * 1.1); this.stars.updateMatrix();
    this.atmosphere.position.copy(observer); this.atmosphere.scale.setScalar(Math.min(1400, far * 0.95) / 1450); this.atmosphere.updateMatrix();
    for (const body of this.bodies) {
      this.relative.copy(body.position).sub(this.system.active.position).sub(observer);
      const distance = Math.max(body.radius * 2, this.relative.length());
      body.mesh.position.copy(observer).addScaledVector(this.relative, skyDistance / distance);
      body.mesh.scale.setScalar(body.radius * skyDistance / distance); body.mesh.updateMatrix();
    }
  }

  setVisible(visible: boolean): void { this.mesh.visible = visible; }
  dispose(): void {
    this.stars.geometry.dispose(); this.stars.material.dispose();
    this.mesh.traverse(object => { if (object instanceof Mesh) { object.geometry.dispose(); const material = object.material as MeshBasicNodeMaterial; material.map?.dispose(); material.dispose(); } });
    this.mesh.clear();
  }
}