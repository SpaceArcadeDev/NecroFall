import {
  BufferGeometry, Color, CylinderGeometry, DoubleSide, Float32BufferAttribute, Group,
  IcosahedronGeometry, InstancedMesh, Matrix4, MeshBasicNodeMaterial, Object3D,
  Quaternion, SphereGeometry, Vector3,
} from 'three/webgpu';
import { attribute, color, normalWorld, positionLocal, sin, smoothstep, uniform, vec3 } from 'three/tsl';
import type { PlanetStudy } from './definitions';

export const motionTime = uniform(0);

export function noise(x: number, y: number, z = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fraction = (value: number) => { const part = value - Math.floor(value); return part * part * (3 - 2 * part); };
  const blend = (first: number, second: number, amount: number) => first + (second - first) * amount;
  const hash = (dx: number, dy: number, dz: number) => {
    let value = Math.imul(ix + dx, 374761393) ^ Math.imul(iy + dy, 668265263) ^ Math.imul(iz + dz, 2147483647);
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
  };
  const fx = fraction(x), fy = fraction(y), fz = fraction(z);
  return blend(blend(blend(hash(0, 0, 0), hash(1, 0, 0), fx), blend(hash(0, 1, 0), hash(1, 1, 0), fx), fy),
    blend(blend(hash(0, 0, 1), hash(1, 0, 1), fx), blend(hash(0, 1, 1), hash(1, 1, 1), fx), fy), fz);
}

export function fbm(x: number, y: number, z = 0): number {
  return noise(x, y, z) * 0.57 + noise(x * 2.07, y * 2.07, z * 2.07) * 0.28 + noise(x * 4.13, y * 4.13, z * 4.13) * 0.1 + noise(x * 8.31, y * 8.31, z * 8.31) * 0.05;
}

export function heightAt(x: number, z: number, study: PlanetStudy, seed: number): number {
  const offset = seed % 7000;
  const hills = fbm(x * 0.017 + offset, z * 0.017, 2.3);
  const river = Math.sin(z * 0.018 + 0.6) * 23 - 22;
  const basin = Math.exp(-(((x - river) / (study.flora === 'coral' ? 55 : 25)) ** 2));
  const rear = Math.max(0, Math.min(1, (-z - 90) / 170));
  const ridge = Math.pow(noise(x * 0.024 + offset, z * 0.023), 1.8) * rear * (study.flora === 'crystal' ? 125 : 91);
  let height = 3 + hills * 21 - basin * 22 + ridge;
  if (study.flora === 'sail') height += Math.floor(hills * 7) * 2.3;
  return height - (x * x + z * z) * 0.000075;
}

export function toon(tint = '#ffffff', glow = false): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  const light = normalWorld.dot(vec3(-0.45, 0.82, 0.36));
  const bands = smoothstep(-0.2, -0.08, light).mul(0.25)
    .add(smoothstep(0.28, 0.4, light).mul(0.22))
    .add(smoothstep(0.7, 0.8, light).mul(0.16)).add(0.37);
  material.colorNode = glow ? color(tint).mul(1.18) : color(tint).mul(bands);
  return material;
}

export function canopyGeometry(): BufferGeometry {
  const positions: number[] = [], colors: number[] = [], indices: number[] = [];
  const rings = 7, segments = 16;
  for (let ring = 0; ring <= rings; ring++) {
    const radius = Math.sin(ring / rings * Math.PI);
    const height = Math.cos(ring / rings * Math.PI) * (ring < 5 ? 0.36 : 0.17);
    for (let segment = 0; segment <= segments; segment++) {
      const angle = segment / segments * Math.PI * 2;
      const irregularity = 1 + Math.sin(angle * 7 + ring * 0.9) * 0.075 + Math.cos(angle * 11) * 0.045;
      positions.push(Math.cos(angle) * radius * irregularity, height, Math.sin(angle) * radius * irregularity);
      const value = ring < 4 ? 0.87 + Math.sin(angle * 8 + ring * 3) * 0.12 : 0.6;
      colors.push(value, value, value);
      if (ring < rings && segment < segments) {
        const index = ring * (segments + 1) + segment;
        indices.push(index, index + segments + 1, index + 1, index + 1, index + segments + 1, index + segments + 2);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export function grassGeometry(): BufferGeometry {
  const positions: number[] = [], colors: number[] = [];
  for (let blade = 0; blade < 7; blade++) {
    const angle = blade * 2.39996;
    const centerX = Math.cos(angle) * 0.31, centerZ = Math.sin(angle) * 0.31;
    const width = 0.10, height = 0.55 + blade % 3 * 0.2;
    positions.push(centerX - width, 0, centerZ, centerX + width, 0, centerZ, centerX + Math.cos(angle) * 0.3, height, centerZ + Math.sin(angle) * 0.3);
    colors.push(0.4, 0.48, 0.35, 0.4, 0.48, 0.35, 1, 1, 0.86);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function rockGeometry(): BufferGeometry {
  const geometry = new IcosahedronGeometry(1, 1);
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index), y = positions.getY(index), z = positions.getZ(index);
    const bulge = 0.83 + noise(x * 3 + 12, y * 2, z * 3) * 0.38;
    positions.setXYZ(index, x * bulge, y * bulge, z * bulge);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function foliageGeometry(): BufferGeometry {
  const geometry = new IcosahedronGeometry(1, 1);
  const positions = geometry.attributes.position;
  const colors: number[] = [];
  for (let index = 0; index < positions.count; index++) {
    const x = positions.getX(index), y = positions.getY(index), z = positions.getZ(index);
    const tuft = 0.8 + noise(x * 6 + 71, y * 6, z * 6) * 0.35;
    positions.setXYZ(index, x * tuft, y * tuft, z * tuft);
    const shade = 0.65 + noise(x * 12, y * 12, z * 12) * 0.35;
    colors.push(shade, shade, shade);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export class Batches {
  private batches = new Map<string, { geometry: BufferGeometry; material: MeshBasicNodeMaterial; matrices: Matrix4[]; colors: Color[] }>();
  private transform = new Object3D();
  readonly geometry = {
    rock: rockGeometry(), crown: canopyGeometry(), grass: grassGeometry(), leaf: foliageGeometry(),
    mesa: new CylinderGeometry(0.8, 1, 1, 7, 3),
    trunk: new CylinderGeometry(0.58, 1, 1, 7), crystal: new CylinderGeometry(0, 1, 1, 5),
    orb: new SphereGeometry(1, 8, 5),
  };
  readonly matte = toon();
  readonly luminous = toon('#ffffff', true);
  readonly grassMaterial = toon();

  constructor() {
    this.matte.vertexColors = true;
    this.luminous.vertexColors = true;
    this.grassMaterial.vertexColors = true;
    this.grassMaterial.side = DoubleSide;
    this.grassMaterial.positionNode = positionLocal.add(vec3(sin(motionTime.mul(1.4).add(positionLocal.x.mul(0.05))).mul(attribute('position', 'vec3').y.pow(2)).mul(0.1), 0, 0));
  }

  add(kind: keyof Batches['geometry'], position: Vector3, scale: Vector3, tint: string | Color, rotation = new Quaternion(), glow = false): void {
    const key = `${kind}:${glow}`;
    let batch = this.batches.get(key);
    if (!batch) {
      batch = { geometry: this.geometry[kind], material: kind === 'grass' ? this.grassMaterial : glow ? this.luminous : this.matte, matrices: [], colors: [] };
      this.batches.set(key, batch);
    }
    this.transform.position.copy(position);
    this.transform.scale.copy(scale);
    this.transform.quaternion.copy(rotation);
    this.transform.updateMatrix();
    batch.matrices.push(this.transform.matrix.clone());
    batch.colors.push(new Color(tint));
  }

  branch(start: Vector3, end: Vector3, radius: number, tint: string, glow = false): void {
    const direction = end.clone().sub(start);
    this.add('trunk', start.clone().add(end).multiplyScalar(0.5), new Vector3(radius, direction.length(), radius), tint,
      new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize()), glow);
  }

  finish(parent: Group): void {
    for (const batch of this.batches.values()) {
      const mesh = new InstancedMesh(batch.geometry, batch.material, batch.matrices.length);
      batch.matrices.forEach((matrix, index) => { mesh.setMatrixAt(index, matrix); mesh.setColorAt(index, batch.colors[index]); });
      mesh.computeBoundingSphere();
      parent.add(mesh);
    }
  }
}