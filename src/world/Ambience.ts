// NECROFALL — ambient atmosphere: drifting motes around the camera and twinkling glints on the
// ground. Both are single draw calls of GPU-animated points (no textures), and both are sized by the
// quality tier so the performance watchdog's particle budget still applies.
//
//   * Motes wrap around the camera inside a box, so they never pop: a mote that leaves the box is
//     teleported to the opposite face, which is invisible for a slow, tiny, semi-transparent speck.
//   * Glints are *static* points sitting just above the terrain around the arena (the same zones the
//     grass field uses) — rising spores and sparks that twinkle on their own phase. Static means no
//     popping, ever.
import * as THREE from 'three';
import { Rand } from '../utils/Utils';

/** Size of the mote box that follows the camera, in world units. */
const MOTE_BOX = 46;
/** How high sparks drift over the ground. */
const GLINT_LIFT = 1.6;

const MOTE_VERT = /* glsl */ `
  attribute float aSeed;
  attribute float aSize;
  uniform float uTime;
  uniform float uScale;
  varying float vAlpha;
  varying float vSeed;
  void main() {
    vec3 p = position;
    // slow drift + a gentle wobble, all on the GPU (the CPU only wraps the box)
    p.y += sin(uTime * (0.25 + aSeed * 0.4) + aSeed * 12.0) * 0.6;
    p.x += sin(uTime * 0.19 + aSeed * 7.0) * 0.5;
    p.z += cos(uTime * 0.23 + aSeed * 5.0) * 0.5;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vAlpha = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (0.6 + aSeed) + aSeed * 21.0));
    vSeed = aSeed;
    gl_PointSize = aSize * uScale * (300.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const MOTE_FRAG = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  varying float vAlpha;
  varying float vSeed;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float d = length(c);
    if (d > 1.0) discard;
    float soft = pow(1.0 - d, 2.2);
    vec3 col = mix(uColorA, uColorB, vSeed);
    gl_FragColor = vec4(col, soft * vAlpha * 0.5);
  }
`;

/** Four-pointed star glint, drawn procedurally from gl_PointCoord — no texture. */
const GLINT_VERT = /* glsl */ `
  attribute float aSeed;
  attribute float aSize;
  uniform float uTime;
  uniform float uScale;
  varying float vTwinkle;
  void main() {
    float t = sin(uTime * (0.9 + aSeed * 2.3) + aSeed * 40.0);
    vTwinkle = smoothstep(0.1, 1.0, t);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale * (330.0 / max(1.0, -mv.z)) * (0.55 + 0.45 * vTwinkle);
    gl_Position = projectionMatrix * mv;
  }
`;

const GLINT_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vTwinkle;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float body = 1.0 - smoothstep(0.0, 0.28, length(c));
    float arms = max(0.0, 1.0 - abs(c.x) * 13.0) + max(0.0, 1.0 - abs(c.y) * 13.0);
    float star = clamp(body + arms * (1.0 - length(c)), 0.0, 1.0);
    if (star <= 0.01) discard;
    gl_FragColor = vec4(uColor, star * vTwinkle * 0.7);
  }
`;

export interface AmbiencePlanet {
  heightAtDir(x: number, y: number, z: number): number;
  readonly radius: number;
}

export interface Ambience {
  group: THREE.Group;
  /** Motes follow the camera; glints just twinkle on their own phase. */
  update(dt: number, cameraPos: THREE.Vector3, time: number): void;
  /** Watchdog hook: scales both point clouds down when frames get tight. */
  setBudget(mul: number): void;
  dispose(): void;
}

export function createAmbience(
  parent: THREE.Object3D,
  planet: AmbiencePlanet,
  seed: number,
  opts: { motes: number; glints: number; zones: THREE.Vector3[] }
): Ambience {
  const group = new THREE.Group();
  group.name = 'ambience';
  parent.add(group);
  const rng = new Rand((seed ^ 0x51a7e) >>> 0);

  const fullMotes = Math.max(0, Math.round(opts.motes));
  const fullGlints = Math.max(0, Math.round(opts.glints));

  // ---------------------------------------------------------------- motes
  const moteGeo = new THREE.BufferGeometry();
  const mPos = new Float32Array(Math.max(1, fullMotes) * 3);
  const mSeed = new Float32Array(Math.max(1, fullMotes));
  const mSize = new Float32Array(Math.max(1, fullMotes));
  for (let i = 0; i < fullMotes; i++) {
    mPos[i * 3] = rng.range(-MOTE_BOX / 2, MOTE_BOX / 2);
    mPos[i * 3 + 1] = rng.range(-MOTE_BOX / 2, MOTE_BOX / 2);
    mPos[i * 3 + 2] = rng.range(-MOTE_BOX / 2, MOTE_BOX / 2);
    mSeed[i] = rng.range(0, 1);
    mSize[i] = rng.range(0.5, 1.7);
  }
  moteGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
  moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(mSeed, 1));
  moteGeo.setAttribute('aSize', new THREE.BufferAttribute(mSize, 1));
  const moteMat = new THREE.ShaderMaterial({
    vertexShader: MOTE_VERT,
    fragmentShader: MOTE_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 1 },
      uColorA: { value: new THREE.Color(0xb9a6ff) },
      uColorB: { value: new THREE.Color(0x7ff0d0) },
    },
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.frustumCulled = false;
  motes.renderOrder = 6;
  motes.visible = fullMotes > 0;
  group.add(motes);

  // ---------------------------------------------------------------- glints
  const glintGeo = new THREE.BufferGeometry();
  const gPos = new Float32Array(Math.max(1, fullGlints) * 3);
  const gSeed = new Float32Array(Math.max(1, fullGlints));
  const gSize = new Float32Array(Math.max(1, fullGlints));
  let written = 0;
  const R = planet.radius;
  const t1 = new THREE.Vector3();
  const t2 = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const perZone = opts.zones.length > 0 ? Math.max(1, Math.ceil(fullGlints / opts.zones.length)) : 0;
  for (const zone of opts.zones) {
    centre.copy(zone).normalize();
    const ax = Math.abs(centre.x) < 0.9 ? 1 : 0;
    t1.set(ax, ax === 1 ? 0 : 1, 0).cross(centre).normalize();
    t2.copy(centre).cross(t1).normalize();
    for (let i = 0; i < perZone && written < fullGlints; i++) {
      const r = Math.sqrt(rng.range(0, 1)) * 40;
      const a = rng.range(0, Math.PI * 2);
      dir.copy(centre).multiplyScalar(R)
        .addScaledVector(t1, Math.cos(a) * r)
        .addScaledVector(t2, Math.sin(a) * r)
        .normalize();
      const h = planet.heightAtDir(dir.x, dir.y, dir.z) + GLINT_LIFT * rng.range(0.25, 1);
      gPos[written * 3] = dir.x * h;
      gPos[written * 3 + 1] = dir.y * h;
      gPos[written * 3 + 2] = dir.z * h;
      gSeed[written] = rng.range(0, 1);
      gSize[written] = rng.range(0.4, 1.5);
      written++;
    }
  }
  glintGeo.setAttribute('position', new THREE.BufferAttribute(gPos, 3));
  glintGeo.setAttribute('aSeed', new THREE.BufferAttribute(gSeed, 1));
  glintGeo.setAttribute('aSize', new THREE.BufferAttribute(gSize, 1));
  const glintMat = new THREE.ShaderMaterial({
    vertexShader: GLINT_VERT,
    fragmentShader: GLINT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: 1 },
      uColor: { value: new THREE.Color(0xffe6a8) },
    },
  });
  const glints = new THREE.Points(glintGeo, glintMat);
  glints.frustumCulled = false;
  glints.renderOrder = 6;
  glints.visible = written > 0;
  group.add(glints);

  const half = MOTE_BOX / 2;

  return {
    group,
    update(dt: number, cameraPos: THREE.Vector3, time: number): void {
      moteMat.uniforms.uTime.value = time;
      glintMat.uniforms.uTime.value = time;
      if (!motes.visible) return;
      // Wrap each mote into the box around the camera — the drift itself happens in the shader.
      for (let i = 0; i < fullMotes; i++) {
        let x = mPos[i * 3] - cameraPos.x;
        let y = mPos[i * 3 + 1] - cameraPos.y;
        let z = mPos[i * 3 + 2] - cameraPos.z;
        if (x > half) mPos[i * 3] -= MOTE_BOX; else if (x < -half) mPos[i * 3] += MOTE_BOX;
        if (y > half) mPos[i * 3 + 1] -= MOTE_BOX; else if (y < -half) mPos[i * 3 + 1] += MOTE_BOX;
        if (z > half) mPos[i * 3 + 2] -= MOTE_BOX; else if (z < -half) mPos[i * 3 + 2] += MOTE_BOX;
        void dt;
      }
      moteGeo.attributes.position.needsUpdate = true;
    },
    setBudget(mul: number): void {
      const m = Math.max(0, Math.min(1, mul));
      moteGeo.setDrawRange(0, Math.round(fullMotes * m));
      glintGeo.setDrawRange(0, Math.round(written * m));
      moteMat.uniforms.uScale.value = 1;
      glintMat.uniforms.uScale.value = 1;
    },
    dispose(): void {
      moteGeo.dispose();
      moteMat.dispose();
      glintGeo.dispose();
      glintMat.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
}
