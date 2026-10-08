import {
  BoxGeometry, BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute,
  Group, IcosahedronGeometry, Mesh, Quaternion, SphereGeometry, Vector3,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { randomSource, type PlanetStudy } from './definitions';
import { toon } from './procedural';

class Sculpture {
  private parts: BufferGeometry[] = [];

  shape(kind: 'shell' | 'bone' | 'spike' | 'box', position: number[], scale: number[], tint: string, rotation = new Quaternion()): void {
    const geometry = kind === 'shell' ? new IcosahedronGeometry(1, 2)
      : kind === 'bone' ? new CylinderGeometry(0.65, 1, 1, 8)
        : kind === 'box' ? new BoxGeometry(1, 1, 1) : new CylinderGeometry(0, 1, 1, 6);
    const plain = geometry.index ? geometry.toNonIndexed() : geometry;
    if (plain !== geometry) geometry.dispose();
    plain.deleteAttribute('uv');
    plain.scale(scale[0], scale[1], scale[2]);
    plain.applyQuaternion(rotation);
    plain.translate(position[0], position[1], position[2]);
    const shade = new Color(tint), colors = new Float32Array(plain.attributes.position.count * 3);
    for (let index = 0; index < colors.length; index += 3) shade.toArray(colors, index);
    plain.setAttribute('color', new Float32BufferAttribute(colors, 3));
    this.parts.push(plain);
  }

  link(start: number[], end: number[], width: number, tint: string, spike = false): void {
    const from = new Vector3(...start as [number, number, number]);
    const to = new Vector3(...end as [number, number, number]);
    const direction = to.clone().sub(from);
    this.shape(spike ? 'spike' : 'bone', from.add(to).multiplyScalar(0.5).toArray(), [width, direction.length(), width], tint,
      new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize()));
  }

  build(): Mesh {
    const geometry = mergeGeometries(this.parts, false);
    this.parts.forEach((part) => part.dispose());
    const material = toon();
    material.vertexColors = true;
    return new Mesh(geometry, material);
  }
}

export interface Creature {
  root: Group;
  limbs: Group[];
  originY: number;
  phase: number;
  kind: number;
}

export function creature(study: PlanetStudy, seed: number, kind: number): Creature {
  const random = randomSource(seed + kind * 31);
  const root = new Group(), body = new Sculpture(), limbs: Group[] = [];
  const armor = study.armor, infection = study.infection;
  const plate = new Color(armor).lerp(new Color(study.rock), 0.5).getStyle();
  const edge = new Color(study.foliageLight).lerp(new Color(study.rock), 0.5).getStyle();
  const height = kind === 0 ? 1.3 : kind === 1 ? 2.5 : 3.3;
  const bulk = kind === 2 ? 1.6 : kind === 1 ? 0.95 : 1;
  const long = study.flora === 'sail' ? 1.6 : study.flora === 'coral' ? 1.25 : 1;
  body.shape('shell', [0, height, 0], [bulk, bulk * 0.7, bulk * 1.65 * long], armor);
  body.shape('shell', [0, height, -bulk * 1.2], [bulk * 0.7, bulk * 0.58, bulk * 0.65], armor);
  body.shape('shell', [0, height + 0.18, -bulk * 1.66], [bulk * 0.32, bulk * 0.3, bulk * 0.19], infection);
  for (let plateIndex = 0; plateIndex < 6; plateIndex++) {
    const depth = (plateIndex - 2) * bulk * 0.48;
    body.shape('shell', [0, height + bulk * 0.35, depth], [bulk * 1.03, bulk * 0.39, bulk * 0.4], plateIndex % 2 ? plate : armor);
    body.shape('shell', [0, height + bulk * 0.7, depth], [bulk * 0.18, bulk * 0.08, bulk * 0.28], infection);
    for (const side of [-1, 1]) {
      body.link([side * bulk * 0.67, height + 0.2, depth], [side * bulk * (1.3 + random() * 0.6), height + bulk * (1.1 + random() * 0.8), depth + 0.5], bulk * 0.23, edge, true);
    }
  }
  for (const side of [-1, 1]) {
    for (let eye = 0; eye < 3; eye++) {
      body.shape('shell', [side * bulk * (0.25 + eye * 0.17), height + bulk * 0.16, -bulk * (1.7 - eye * 0.1)], [0.085 * bulk, 0.07 * bulk, 0.07 * bulk], infection);
    }
    body.link([side * bulk * 0.45, height - 0.1, -bulk * 1.6], [side * bulk * 0.8, height - 0.4, -bulk * 2.25], bulk * 0.17, plate);
    body.link([side * bulk * 0.8, height - 0.4, -bulk * 2.25], [side * bulk * 0.25, height - 0.5, -bulk * 2.45], bulk * 0.14, edge, true);
  }
  const legCount = kind === 0 ? 3 : kind === 1 ? 2 : 4;
  for (const side of [-1, 1]) {
    for (let leg = 0; leg < legCount; leg++) {
      const segment = new Sculpture();
      const depth = (leg - (legCount - 1) / 2) * 1.03 * bulk;
      const reach = (kind === 1 ? 2.9 : kind === 2 ? 2.25 : 1.8) * bulk;
      const joint = [side * reach, height + (kind === 1 ? 0.6 : 0.15), depth + 0.4];
      const foot = [side * reach * 1.3, 0.03, depth - (leg % 2 ? -0.9 : 1)];
      segment.link([side * bulk * 0.6, height, depth], joint, bulk * 0.24, armor);
      segment.shape('shell', joint, [bulk * 0.35, bulk * 0.3, bulk * 0.38], plate);
      segment.link(joint, foot, bulk * 0.2, plate, true);
      segment.link([joint[0], joint[1] + 0.1, joint[2]], [joint[0] + side * 0.55, joint[1] + 0.6, joint[2] + 0.7], bulk * 0.14, edge, true);
      segment.shape('shell', [joint[0], joint[1] + 0.19, joint[2] - 0.2], [bulk * 0.13, bulk * 0.13, bulk * 0.21], infection);
      const limb = new Group();
      limb.add(segment.build());
      root.add(limb);
      limbs.push(limb);
    }
  }
  if (kind === 1) {
    body.shape('shell', [0, height + 0.75, -0.65], [0.67, 1.2, 0.6], plate);
    body.shape('shell', [0, height + 1.7, -0.85], [0.59, 0.4, 0.59], armor);
    body.shape('shell', [0, height + 1.73, -1.37], [0.38, 0.13, 0.1], infection);
    for (const side of [-1, 1]) {
      body.link([side * 0.6, height + 1.1, -0.7], [side * 1.8, height + 1.3, -2.3], 0.3, armor);
      body.link([side * 1.8, height + 1.3, -2.3], [side * 1.5, height - 1, -3.1], 0.3, edge, true);
      body.link([side * 0.4, height + 1.9, -0.8], [side * 0.6, height + 2.9, -0.55], 0.12, edge, true);
    }
  }
  if (study.flora === 'fungus') {
    for (let tendril = 0; tendril < 9; tendril++) {
      const angle = tendril / 9 * Math.PI * 2;
      const start = [Math.cos(angle) * bulk * 0.7, height + bulk * 0.6, Math.sin(angle) * bulk];
      const end = [Math.cos(angle) * bulk * 1.9, height + bulk * 2.1, Math.sin(angle) * bulk * 1.6];
      body.link(start, end, bulk * 0.11, edge);
      body.shape('shell', end, [bulk * 0.23, bulk * 0.35, bulk * 0.23], infection);
    }
  } else if (study.flora === 'coral') {
    for (const side of [-1, 1]) {
      for (let fin = 0; fin < 5; fin++) body.shape('spike', [side * bulk * (0.8 + fin * 0.2), height + 0.9, fin * 0.6 - 1], [bulk * 0.6, bulk * (1.8 + fin * 0.2), 0.14], edge,
        new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -side * 0.5));
    }
  } else if (study.flora === 'sail') {
    let previous = [0, height, bulk * 1.6];
    for (let segment = 0; segment < 7; segment++) {
      const angle = segment / 6 * Math.PI * 0.9;
      const next = [0, height + Math.sin(angle) * bulk * 3, bulk * 1.7 + Math.cos(angle) * bulk * 2];
      body.link(previous, next, bulk * (0.3 - segment * 0.025), plate);
      previous = next;
    }
    body.shape('spike', previous, [bulk * 0.25, bulk * 0.9, bulk * 0.25], infection);
  } else {
    for (let crystal = 0; crystal < (kind === 2 ? 14 : 6); crystal++) {
      body.shape('spike', [(random() - 0.5) * bulk * 1.4, height + bulk * (0.9 + random() * 0.6), (random() - 0.5) * bulk * 2.4],
        [bulk * 0.19, bulk * (0.8 + random() * 1.5), bulk * 0.24], crystal % 3 ? edge : infection,
        new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (random() - 0.5) * 0.6));
    }
  }
  if (kind === 2) {
    body.shape('shell', [0, height + bulk * 0.25, -bulk], [bulk * 1.1, bulk * 1.2, bulk * 0.8], plate);
    body.shape('shell', [0, height + bulk * 0.5, -bulk * 1.65], [bulk * 0.7, bulk * 0.8, bulk * 0.2], armor);
    body.shape('shell', [0, height + bulk * 0.45, -bulk * 1.85], [bulk * 0.35, bulk * 0.54, bulk * 0.12], infection);
    for (const side of [-1, 1]) {
      body.link([side * bulk * 0.6, height + bulk * 0.7, -bulk * 1.65], [side * bulk * 1.2, height + bulk * 1.7, -bulk * 2.2], bulk * 0.24, edge, true);
      for (let tooth = 0; tooth < 4; tooth++) body.link([side * bulk * 0.48, height + bulk * (0.6 - tooth * 0.19), -bulk * 1.82],
        [side * bulk * 0.12, height + bulk * (0.51 - tooth * 0.19), -bulk * 1.98], bulk * 0.08, edge, true);
    }
    body.shape('shell', [0, height + bulk * 0.9, 0], [bulk * 0.9, bulk * 0.8, bulk * 0.7], armor);
    body.shape('shell', [0, height + bulk, -bulk * 0.67], [bulk * 0.43, bulk * 0.5, bulk * 0.13], infection);
    for (let crown = 0; crown < 7; crown++) {
      const angle = crown / 7 * Math.PI * 2;
      body.link([Math.cos(angle) * bulk * 0.7, height + bulk * 1.1, Math.sin(angle) * bulk * 0.6],
        [Math.cos(angle) * bulk * 1.5, height + bulk * (2.2 + random() * 0.8), Math.sin(angle) * bulk * 1.1], bulk * 0.21, edge, true);
    }
  }
  root.add(body.build());
  return { root, limbs, originY: 0, phase: random() * Math.PI * 2, kind };
}

export function animateCreature(rig: Creature, time: number): void {
  rig.root.position.y = rig.originY + Math.sin(time * 1.2 + rig.phase) * 0.09;
  rig.limbs.forEach((limb, index) => { limb.rotation.z = Math.sin(time * 1.5 + index * 1.8 + rig.phase) * 0.022; });
}

export function explorer(): Group {
  const model = new Sculpture();
  const suit = '#243d46', armor = '#d99043', edge = '#72949a';
  model.shape('shell', [0, 1.65, 0], [0.45, 0.65, 0.27], suit);
  model.shape('box', [0, 1.85, 0.12], [0.67, 0.56, 0.37], armor);
  model.shape('shell', [0, 2.48, -0.02], [0.34, 0.39, 0.34], edge);
  model.shape('shell', [0, 2.49, -0.2], [0.29, 0.22, 0.18], '#102934');
  model.shape('box', [0, 1.85, 0.4], [0.67, 0.83, 0.34], suit);
  model.shape('shell', [0, 1.9, 0.62], [0.22, 0.27, 0.07], '#43dfe2');
  model.shape('shell', [0, 1.9, 0.67], [0.14, 0.19, 0.045], '#122e3b');
  for (const side of [-1, 1]) {
    model.link([side * 0.23, 1.23, 0], [side * 0.28, 0.65, side * 0.07], 0.16, suit);
    model.shape('shell', [side * 0.28, 0.65, side * 0.07 - 0.1], [0.17, 0.19, 0.1], armor);
    model.link([side * 0.28, 0.58, side * 0.07], [side * 0.34, 0.16, -side * 0.12], 0.14, edge);
    model.shape('box', [side * 0.34, 0.12, -side * 0.12 - 0.06], [0.3, 0.19, 0.48], suit);
    model.shape('shell', [side * 0.49, 2.01, 0], [0.27, 0.23, 0.3], armor);
    model.link([side * 0.49, 1.96, 0], [side * 0.65, 1.53, -0.05], 0.13, suit);
    model.link([side * 0.65, 1.53, -0.05], [side * 0.53, 1.31, -0.45], 0.13, edge);
    model.shape('box', [side * 0.35, 1.86, 0.43], [0.15, 0.62, 0.25], armor);
  }
  model.shape('box', [0.54, 1.4, -0.72], [0.16, 0.2, 0.93], suit);
  model.link([0.32, 2.11, 0.45], [0.32, 2.95, 0.45], 0.023, edge);
  const root = new Group();
  root.add(model.build());
  return root;
}