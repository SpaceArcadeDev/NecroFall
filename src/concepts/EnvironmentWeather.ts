import { AdditiveBlending, BufferGeometry, CanvasTexture, DoubleSide, Float32BufferAttribute, Group, Mesh, MeshBasicNodeMaterial, Vector3, type Camera } from 'three/webgpu';
import { attribute, cameraPosition, color, cos, mix, screenUV, sin, smoothstep, texture, uniform, vec2, vec3, vec4, viewportSharedTexture } from 'three/tsl';
import { landscapeGrassCoverage, landscapeHeight } from './AssetLandscape';
import { randomSource, type PlanetStudy } from './definitions';

interface RadialWeather {
  anchor: (random: () => number, dry: boolean) => Vector3 | null;
  radiation: any;
}

function weatherGeometry(study: PlanetStudy, seed: number, count: number, dry = false, heightAt?: (positionX: number, positionZ: number) => number, allowsGround?: (positionX: number, positionZ: number) => boolean, radial?: RadialWeather): BufferGeometry {
  const random = randomSource(seed);
  const positions: number[] = [], corners: number[] = [], variations: number[] = [];
  const quad = [[-1, -1], [1, -1], [-1, 1], [1, -1], [1, 1], [-1, 1]];
  for (let attempt = 0; attempt < count * 15 && variations.length < count * 6; attempt++) {
    if (radial) {
      const anchor = radial.anchor(random, dry);
      if (!anchor) continue;
      const variation = random();
      for (const corner of quad) { positions.push(anchor.x, anchor.y, anchor.z); corners.push(...corner); variations.push(variation); }
      continue;
    }
    const foreground = dry && variations.length < count * 6 * 0.35;
    const positionX = (random() - 0.5) * (foreground ? 90 : 240) + (foreground ? 10 : 0);
    const positionZ = foreground ? 45 - random() * 95 : 92 - random() * 285;
    const floor = heightAt ? heightAt(positionX, positionZ) : landscapeHeight(positionX, positionZ, study.seed, study);
    if (dry && (floor < 0.8 || landscapeGrassCoverage(positionX, positionZ, study.seed, study) > 0.65)) continue;
    if (dry && allowsGround && !allowsGround(positionX, positionZ)) continue;
    const variation = random();
    for (const corner of quad) {
      positions.push(positionX, Math.max(0.43, floor + 0.05), positionZ);
      corners.push(...corner);
      variations.push(variation);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('weatherCorner', new Float32BufferAttribute(corners, 2));
  geometry.setAttribute('weatherVariation', new Float32BufferAttribute(variations, 1));
  return geometry;
}

export function particleTexture(kind: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d')!;
  context.translate(64, 64);
  if (kind === 'snow' || kind === 'salt') {
    context.strokeStyle = '#ffffff';
    context.lineWidth = kind === 'snow' ? 3 : 5;
    for (let arm = 0; arm < (kind === 'snow' ? 6 : 4); arm++) {
      context.save();
      context.rotate(arm * Math.PI * 2 / (kind === 'snow' ? 6 : 4));
      context.beginPath();
      context.moveTo(0, 0); context.lineTo(0, -39);
      context.moveTo(-10, -30); context.lineTo(0, -21); context.lineTo(10, -30);
      context.stroke();
      context.restore();
    }
  } else {
    const random = randomSource(811);
    const glow = context.createRadialGradient(0, 0, 5, 0, 0, 53);
    glow.addColorStop(0, '#ffffffa0'); glow.addColorStop(0.45, '#ffffff45'); glow.addColorStop(1, '#ffffff00');
    context.fillStyle = glow;
    context.fillRect(-64, -64, 128, 128);
    context.fillStyle = '#ffffff';
    context.beginPath();
    if (kind === 'petals') {
      context.moveTo(-25, 30);
      context.bezierCurveTo(-48, -18, 12, -52, 34, -31);
      context.bezierCurveTo(40, 3, -1, 30, -25, 30);
    } else {
      for (let point = 0; point < 28; point++) {
        const angle = point * Math.PI * 2 / 28;
        const radius = 16 + random() * 7 + Math.cos(angle * 3) * 5;
        const positionX = Math.cos(angle) * radius, positionY = Math.sin(angle) * radius;
        if (!point) context.moveTo(positionX, positionY); else context.lineTo(positionX, positionY);
      }
    }
    context.closePath(); context.fill();
    context.strokeStyle = '#ffffffa0';
    context.lineWidth = 1.6;
    for (let filament = 0; filament < (kind === 'petals' ? 0 : 5); filament++) {
      context.save(); context.rotate(filament * 1.26);
      context.beginPath(); context.moveTo(0, -15); context.bezierCurveTo(17, -23, -15, -34, 8, -49); context.stroke();
      context.restore();
    }
  }
  return new CanvasTexture(canvas);
}

export class EnvironmentWeather {
  readonly group = new Group();
  readonly radiation = uniform(0);
  private readonly right = uniform(new Vector3(1, 0, 0));
  private readonly up = uniform(new Vector3(0, 1, 0));

  constructor(private readonly study: PlanetStudy, private readonly seed: number, mobile: boolean, private readonly clock: any, private readonly heightAt?: (positionX: number, positionZ: number) => number, private readonly allowsGround?: (positionX: number, positionZ: number) => boolean, private readonly radial?: RadialWeather) {
    const kind = study.weather ?? 'motes';
    this.group.name = 'study-weather';
    this.group.userData = { kind, count: 0, time: 0, layers: [], source: 'World-anchored shader weather' };
    if (kind === 'rain' || kind === 'charged') {
      this.rain(mobile ? 1500 : 3200);
      if (kind === 'charged') this.lights('charged', mobile ? 40 : 80);
      if (study.landform === 'monsoon') this.flecks('spores', mobile ? 160 : 320);
    } else if (kind === 'heat') {
      this.heat(mobile ? 50 : 95);
      this.flecks('dust', mobile ? 220 : 440);
    } else if (kind === 'motes' || kind === 'embers') {
      this.lights(kind, mobile ? 600 : 1200);
      if (kind === 'embers') this.heat(mobile ? 32 : 64);
    } else this.flecks(kind, mobile ? 600 : 1200);
  }

  private geometry(count: number, salt: number, dry = false): BufferGeometry {
    return weatherGeometry({ ...this.study, seed: this.seed }, this.seed + salt, this.radial ? count * 3 : count, dry, this.heightAt, this.allowsGround, this.radial);
  }

  private lift(height: any): any {
    return this.radial ? attribute('position', 'vec3').normalize().mul(height) : vec3(0, height, 0);
  }

  private tangent(offset: any): any {
    if (!this.radial) return offset;
    const up = attribute('position', 'vec3').normalize();
    return offset.sub(up.mul(offset.dot(up)));
  }

  private get exposure(): any { return this.radial?.radiation ?? this.radiation; }

  private add(kind: string, geometry: BufferGeometry, material: MeshBasicNodeMaterial, order = 30): void {
    const mesh = new Mesh(geometry, material);
    mesh.name = `weather-${kind}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    const count = geometry.attributes.position.count / 6;
    this.group.userData.count += count;
    this.group.userData.layers.push({ kind, count });
    this.group.add(mesh);
  }

  private rain(count: number): void {
    const geometry = this.geometry(count, 3203);
    const anchor = attribute('position', 'vec3');
    const corner = attribute('weatherCorner', 'vec2');
    const variation = attribute('weatherVariation', 'float');
    const phase = variation.add(this.clock.mul(0.42)).fract();
    const altitude = phase.oneMinus().mul(44);
    const gust = sin(this.clock.mul(0.18)).mul(0.8).add(3.2);
    const fall = this.lift(1).add(this.tangent(vec3(gust.mul(0.1), 0, 0.025)));
    const center = anchor.add(fall.mul(altitude));
    const distance = cameraPosition.sub(center).length();
    const nearFade = smoothstep(5, 14, distance);
    const farFade = smoothstep(100, 230, distance).oneMinus();
    const width = variation.mul(0.012).add(0.008);
    const length = variation.mul(0.32).add(0.2);
    const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, toneMapped: false, side: DoubleSide });
    material.positionNode = center.add(this.right.mul(corner.x.mul(width)))
      .add(fall.mul(corner.y.mul(length)));
    material.colorNode = mix(color('#cedde4'), color(this.study.infection), this.exposure.mul(0.08));
    const streak = smoothstep(0.08, 0.95, corner.x.abs()).oneMinus().mul(smoothstep(0.3, 1, corner.y.abs()).oneMinus());
    material.opacityNode = streak.mul(nearFade).mul(farFade).mul(0.38).mul(smoothstep(0, 0.025, phase)).mul(smoothstep(0, 0.015, phase.oneMinus()));
    this.add('rain', geometry, material);

    const impact = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, toneMapped: false, side: DoubleSide });
    const age = phase.mul(8).min(1);
    const radius = age.mul(0.32).add(0.025);
    impact.positionNode = anchor.add(this.tangent(vec3(corner.x.mul(radius), 0, corner.y.mul(radius)))).add(this.lift(0.025));
    impact.colorNode = color('#c3d6de');
    const ring = smoothstep(0.03, 0.14, corner.length().sub(0.72).abs()).oneMinus();
    impact.opacityNode = ring.mul(smoothstep(0, 0.012, phase)).mul(smoothstep(0.025, 0.12, phase).oneMinus()).mul(0.28);
    this.add('rain-impacts', geometry, impact, 29);
  }

  private heat(count: number): void {
    const anchor = attribute('position', 'vec3');
    const corner = attribute('weatherCorner', 'vec2');
    const variation = attribute('weatherVariation', 'float');
    const height = corner.y.add(1).mul(0.5);
    const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, toneMapped: false });
    const flow = height.mul(13).sub(this.clock.mul(2.2)).add(variation.mul(31));
    const sway = sin(height.mul(4).sub(this.clock.mul(0.25)).add(variation.mul(19))).mul(height).mul(0.8);
    material.positionNode = anchor.add(this.right.mul(corner.x.mul(variation.mul(1.2).add(1.6)).mul(height.mul(-0.45).add(1)).add(sway)))
      .add(this.lift(height.mul(variation.mul(4).add(7))));
    const envelope = smoothstep(0, 0.035, height).mul(smoothstep(0.45, 1, height).oneMinus())
      .mul(smoothstep(0.2, 1, corner.x.abs()).oneMinus());
    const distanceFade = smoothstep(8, 18, cameraPosition.sub(anchor).length()).mul(smoothstep(100, 230, cameraPosition.sub(anchor).length()).oneMinus());
    const ribbon = smoothstep(-0.6, 0.8, sin(corner.x.mul(9).add(sin(flow).mul(1.8))));
    const swirl = sin(corner.x.mul(4).add(sin(flow))).add(sin(flow.mul(1.7).add(corner.x.mul(7))).mul(0.35));
    const distortion = vec2(swirl.mul(0.0045), sin(flow).mul(0.00075)).mul(envelope).mul(distanceFade).mul(ribbon.mul(0.65).add(0.35));
    material.outputNode = vec4(viewportSharedTexture(screenUV.add(distortion)).rgb, envelope.mul(distanceFade).mul(0.72));
    this.add('heat-refraction', this.geometry(count, 4813, true), material, 25);
  }

  private flecks(kind: string, count: number): void {
    const anchor = attribute('position', 'vec3');
    const corner = attribute('weatherCorner', 'vec2');
    const variation = attribute('weatherVariation', 'float');
    const snow = kind === 'snow', dust = kind === 'dust';
    const phase = variation.add(this.clock.mul(snow ? 0.047 : dust ? 0.028 : 0.009)).fract();
    const altitude = (snow ? phase.oneMinus() : phase).mul(dust ? 5 : 32).add(0.4);
    const drift = vec3(sin(this.clock.mul(0.24).add(variation.mul(57))).mul(snow ? 3 : 2.2),
      sin(this.clock.mul(0.48).add(variation.mul(23))).mul(snow ? 0.2 : 0.5), sin(this.clock.mul(0.19).add(variation.mul(31))).mul(1.8));
    const center = anchor.add(this.lift(altitude)).add(this.tangent(drift));
    const angle = variation.mul(37).add(this.clock.mul(snow ? 0.5 : 0.32));
    const size = variation.mul(snow ? 0.11 : 0.23).add(dust ? 0.045 : 0.12);
    const horizontal = corner.x.mul(cos(angle)).sub(corner.y.mul(sin(angle)));
    const vertical = corner.x.mul(sin(angle)).add(corner.y.mul(cos(angle)));
    const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false, toneMapped: false });
    material.positionNode = center.add(this.right.mul(horizontal.mul(size))).add(this.up.mul(vertical.mul(size)));
    const map = particleTexture(dust ? 'salt' : kind);
    material.map = map;
    const tint = snow ? '#eff8ff' : dust ? this.study.highland : this.study.foliageLight;
    material.colorNode = mix(color(tint), color(this.study.infection), this.exposure.mul(snow || dust ? 0.15 : 0.5)).mul(this.exposure.mul(dust ? 0 : 0.3).add(1));
    const fade = smoothstep(0, 0.08, phase).mul(smoothstep(0, 0.12, phase.oneMinus()));
    const distance = cameraPosition.sub(center).length();
    material.opacityNode = texture(map, corner.mul(0.5).add(0.5)).a.mul(fade).mul(smoothstep(2, 7, distance))
      .mul(smoothstep(90, 210, distance).oneMinus()).mul(dust ? 0.25 : 0.8);
    this.add(kind, this.geometry(count, 5257), material);
  }

  private lights(kind: string, count: number): void {
    const { study, clock } = this;
    const anchor = attribute('position', 'vec3');
    const corner = attribute('weatherCorner', 'vec2');
    const variation = attribute('weatherVariation', 'float');
    const speed = kind === 'embers' ? 0.04 : 0.012;
    const phase = variation.add(clock.mul(speed)).fract();
    const altitude = phase.mul(40).add(0.4);
    const drift = sin(clock.mul(0.7).add(variation.mul(57))).mul(2.2);
    const width = variation.mul(0.16).add(0.1);
    const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false, toneMapped: false });
    material.positionNode = anchor.add(this.lift(altitude)).add(this.tangent(vec3(drift, 0, sin(clock.mul(0.4).add(variation.mul(31))).mul(1.2))))
      .add(this.right.mul(corner.x.mul(width))).add(this.up.mul(corner.y.mul(width)));
    const tint = kind === 'embers' ? '#ffbb72' : study.infection;
    material.colorNode = mix(color(tint), color(study.infection), this.exposure.mul(0.7)).mul(this.exposure.mul(0.7).add(0.8));
    const shape = smoothstep(0.15, 1, corner.length()).oneMinus();
    const fade = smoothstep(0, 0.12, phase).mul(smoothstep(0, 0.12, phase.oneMinus()));
    const pulse = kind === 'charged' ? smoothstep(0.85, 1, sin(clock.mul(1.1).add(variation.mul(91)))).mul(0.7)
      : sin(clock.mul(0.9).add(variation.mul(31))).mul(0.15).add(0.65);
    material.opacityNode = shape.mul(fade).mul(pulse);
    this.add(kind, this.geometry(count, 3203), material);
  }

  update(elapsed: number, camera?: Camera): void {
    this.group.userData.time = elapsed;
    if (!camera) return;
    this.right.value.setFromMatrixColumn(camera.matrixWorld, 0);
    this.up.value.setFromMatrixColumn(camera.matrixWorld, 1);
  }
}