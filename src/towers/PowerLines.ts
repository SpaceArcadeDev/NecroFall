// NECROFALL — the power conduits: one grounded CABLE from every Beacon to the Nexus.
//
// Each Beacon feeds the Nexus shield, and the cable is the tell. It is laid ON the terrain — sampled
// from the analytic height field along the great circle between the two towers — so it follows every
// ridge and dip on the way instead of cutting a chord through the planet. It is RED while nobody
// holds that Beacon (it is feeding the seal for no colony) and turns the owning colony's colour the
// moment the Beacon is captured.
//
// The flow is REAL PARTICLES: a ring of energy dots runs along the cable from the beacon to the
// nexus, over a dark metal casing with a lit seam. That is what says "this tower is powering the
// shield", and unlike a shader gradient it reads as something physically travelling down a wire.
//
// Per line: one cable mesh + one Points cloud = two draw calls, four lines = eight.
import * as THREE from 'three';
import type { Planet } from '../world/Planet';
import { COLONIES } from '../core/Config';

/**
 * Nodes along one conduit — enough that it hugs the terrain with no visible polygon edges. The
 * ribbon is a chain of straight chords, and a chord between two surface points SAGS through a rise
 * (a convex ridge pokes up between them): measured, 72 nodes let the middle of a segment sink 0.38 m
 * BELOW the ground, which is the "cable going through the map" the player sees. Cost is trivial
 * (heightAtDir is analytic), so sample far denser than looks necessary.
 */
const NODES = 240;
/** Half-width of the cable (metres). Heavy laid conduit: reads as infrastructure, not a painted line. */
const HALF_WIDTH = 2.2;
/** How far above the terrain the cable floats — clear of the sag between nodes, and of z-fighting. */
const LIFT = 0.3;
/**
 * How far above the cable's own surface the energy dots ride. A few centimetres ONLY: they belong
 * INSIDE the wire, running along its spine — anything more reads as sparks floating over the top, and
 * exactly zero puts them coplanar with the ribbon where the depth test flickers.
 */
const FLOW_RIDE = 0.05;
/**
 * Energy dots per cable, how fast the stream travels (fractions of the line per second), and the
 * shape of each streak. The flow is deliberately SLOW — it is current moving through heavy cable, not
 * a bullet train — and every dot is small with a SHORT TAIL behind it, so the stream reads as sparks
 * of current running down the wire rather than a row of bulbs.
 */
const FLOW_COUNT = 10;
const FLOW_SPEED = 0.014;
/**
 * The profile of ONE streak, measured from its nose: `p` is how far along the tail the ring sits
 * (negative = ahead of the head, i.e. the nose), `w` its half-width against the head's, and `a` its
 * brightness. A narrow nose, a rounded bright head just behind it, a shoulder, then a point — that is
 * what makes the stream read as ROUND sparks of current with a short tail, not as flat chips.
 */
const TAIL_RINGS = [
  { p: -0.2, w: 0.0, a: 0.0 },
  { p: -0.07, w: 0.55, a: 0.8 },
  { p: 0.0, w: 0.95, a: 1.4 },
  { p: 0.24, w: 1.0, a: 1.0 },
  { p: 0.56, w: 0.6, a: 0.5 },
  { p: 1.0, w: 0.0, a: 0.0 },
];
/** Tail length as a fraction of the line (~2 m on a typical run) and the half-width at the head. */
const TAIL_LEN = 0.012;
const TAIL_HEAD_W = 0.28;
/** The colour of a conduit that is feeding the Nexus seal for nobody. */
const SEAL_COLOR = 0xff2d4a;
/** The same red as a CSS string — HUD ink for "no colony owns this yet". */
const SEAL_CSS = '#ff2d4a';
export { SEAL_COLOR, SEAL_CSS };

const VERT = `
  attribute float aT;
  attribute float aSide;
  varying float vT;
  varying float vSide;
  void main() {
    vT = aT;
    vSide = aSide;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The cable itself: a dark metal casing with an energy seam down its spine. `vSide` is -1..1 across
 * the width, so the casing fades out at the rails and the seam stays bright in the middle.
 */
const FRAG = `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uPulse;
  varying float vT;
  varying float vSide;
  void main() {
    float band = abs(vSide);
    // the casing: solid over the middle three quarters, gone at the rails
    float casing = 1.0 - smoothstep(0.68, 1.0, band);
    // the energy seam running down the spine of the cable
    float seam = 1.0 - smoothstep(0.0, 0.34, band);
    // a slow ripple so a live cable never looks like a static stripe
    float flow = 0.5 + 0.5 * sin(vT * 30.0 - uTime * 9.0);
    float energy = (0.55 + 0.45 * flow) * uPulse;
    vec3 shell = uColor * (0.13 + 0.2 * energy);
    vec3 col = mix(shell, uColor * (1.1 + 0.8 * flow), seam);
    float a = casing * uOpacity * (0.5 + 0.5 * seam);
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  }
`;

/**
 * One conduit: the terrain-hugging cable, its colour, and the streak stream travelling down it.
 *
 * The streaks are a single additive `MeshBasicMaterial` with vertex colours (the taper is carried by
 * the colour, so one material renders eight streaks) rather than point sprites: a sprite can only be
 * a round dot, and the tail is the whole point.
 */
interface Line {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** The centre line of the cable, one point per node — where the energy dots ride. */
  path: Float32Array;
  tail: THREE.Mesh;
  tailGeo: THREE.BufferGeometry;
  tailMat: THREE.MeshBasicMaterial;
  tailPos: Float32Array;
  tailCol: Float32Array;
  /** Per-streak offset along the line, so the stream is evenly spaced. */
  pBase: Float32Array;
  /** Colour currently shown, eased toward the owner's colour so a capture is a sweep, not a pop. */
  color: THREE.Color;
  target: THREE.Color;
}

export class PowerLines {
  private group = new THREE.Group();
  private lines: Line[] = [];
  private time = 0;

  /**
   * Lays one conduit per Beacon, from the Beacon's foot to the Nexus. Called from TowerManager.init
   * with the towers already placed, so the endpoints are the real positions.
   *
   * The planet is a PARAMETER, not a constructor capture: Game rebuilds `Planet` for every match
   * (its own seed and battlefield centre), so a reference taken when the tower manager is created
   * belongs to the previous world — and the conduits would then follow the wrong terrain (measured:
   * the whole line 7-14 m off the ground).
   */
  build(scene: THREE.Scene, planet: Planet, beacons: THREE.Vector3[], nexus: THREE.Vector3): void {
    this.clear(scene);
    for (const beacon of beacons) this.lines.push(this.makeLine(planet, beacon, nexus));
    scene.add(this.group);
  }

  /**
   * Tears down the previous match's conduits, then — critically — EMPTIES the group itself.
   *
   * `this.lines` only ever holds the CURRENT match's cables, so tearing down from that list alone
   * left the previous match's meshes still parented to this same group. `build` then re-added the
   * group to the scene and the renderer re-uploaded those orphaned buffers (dispose() frees the GPU
   * resources, it does not un-forget the attributes), so a rematch drew an extra cable lying between
   * the OLD Beacon and the OLD Nexus. Their endpoints are measured 76-160 m from any live tower:
   * a line across the ground connecting nothing, which is exactly the stray a player spots.
   * Everything is disposed from the GROUP, so a leak can never accumulate again.
   */
  private clear(scene: THREE.Scene): void {
    scene.remove(this.group);
    for (const child of [...this.group.children]) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat?.dispose();
    }
    this.group.clear();
    this.lines.length = 0;
  }

  private makeLine(planet: Planet, beacon: THREE.Vector3, nexus: THREE.Vector3): Line {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(SEAL_COLOR) },
        uTime: { value: 0 },
        uOpacity: { value: 0.9 },
        uPulse: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const start = beacon.clone().normalize();
    const end = nexus.clone().normalize();
    const angle = Math.acos(THREE.MathUtils.clamp(start.dot(end), -1, 1));
    const axis = new THREE.Vector3().crossVectors(start, end);
    if (axis.lengthSq() < 1e-8) axis.crossVectors(start, new THREE.Vector3(0, 1, 0));
    axis.normalize();

    const count = NODES + 1;
    const pos = new Float32Array(count * 2 * 3);
    const tAttr = new Float32Array(count * 2);
    const sideAttr = new Float32Array(count * 2);
    const path = new Float32Array(count * 3);
    const idx: number[] = [];
    const dir = new THREE.Vector3();
    const side = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      const t = i / NODES;
      dir.copy(start).applyAxisAngle(axis, angle * t).normalize();
      // the lateral axis of the great circle: perpendicular to the path AND to the surface normal
      side.crossVectors(axis, dir).normalize();
      const h = planet.heightAtDir(dir.x, dir.y, dir.z) + LIFT;
      // the spine of the cable: what the energy dots ride, a hair above the ribbon so the depth test
      // cannot fight between two coplanar surfaces
      const hc = h + FLOW_RIDE;
      path[i * 3] = dir.x * hc;
      path[i * 3 + 1] = dir.y * hc;
      path[i * 3 + 2] = dir.z * hc;
      for (let k = 0; k < 2; k++) {
        const sign = k === 0 ? 1 : -1;
        const o = (i * 2 + k) * 3;
        // step sideways, then RE-PROJECT on to the terrain: a plain chord offset makes the outer rail
        // dip into an uphill slope (measured up to 0.4 m below the surface), so the rail would sink
        // out of sight on every rise. One extra height sample per vertex pins the whole ribbon at the
        // same constant lift.
        let vx = dir.x * h + side.x * HALF_WIDTH * sign;
        let vy = dir.y * h + side.y * HALF_WIDTH * sign;
        let vz = dir.z * h + side.z * HALF_WIDTH * sign;
        const len = Math.hypot(vx, vy, vz) || 1;
        const hv = planet.heightAtDir(vx / len, vy / len, vz / len) + LIFT;
        vx = (vx / len) * hv;
        vy = (vy / len) * hv;
        vz = (vz / len) * hv;
        pos[o] = vx;
        pos[o + 1] = vy;
        pos[o + 2] = vz;
        tAttr[i * 2 + k] = t;
        sideAttr[i * 2 + k] = sign;
      }
      if (i < NODES) {
        const a = i * 2;
        // both windings are pushed: the material is double sided, but keeping the quads consistent
        // means the ribbon never flickers on a slope that faces away from the camera
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aT', new THREE.BufferAttribute(tAttr, 1));
    geo.setAttribute('aSide', new THREE.BufferAttribute(sideAttr, 1));
    geo.setIndex(idx);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    this.group.add(mesh);

    // The stream: evenly spaced streaks riding the CENTRE of the wire (a spread across the cable
    // reads as sparks scattered over it instead of current in the cable). Each streak is a flat
    // ribbon of TAIL_STEPS rings, narrow and bright at the head, tapering to nothing at the tail;
    // the taper lives in the vertex COLOURS, so additive blending turns a black tail into empty space.
    const pBase = new Float32Array(FLOW_COUNT);
    for (let i = 0; i < FLOW_COUNT; i++) pBase[i] = i / FLOW_COUNT;
    const rings = TAIL_RINGS.length;
    const verts = FLOW_COUNT * rings * 2;
    const tailPos = new Float32Array(verts * 3);
    const tailCol = new Float32Array(verts * 3);
    const tailIdx: number[] = [];
    for (let k = 0; k < FLOW_COUNT; k++) {
      for (let j = 0; j < rings - 1; j++) {
        const a = (k * rings + j) * 2;
        tailIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const tailGeo = new THREE.BufferGeometry();
    tailGeo.setAttribute('position', new THREE.BufferAttribute(tailPos, 3));
    tailGeo.setAttribute('color', new THREE.BufferAttribute(tailCol, 3));
    tailGeo.setIndex(tailIdx);
    const tailMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const tail = new THREE.Mesh(tailGeo, tailMat);
    tail.frustumCulled = false;
    tail.renderOrder = 4;
    this.group.add(tail);

    return {
      mesh, mat, path,
      tail, tailGeo, tailMat, tailPos, tailCol,
      pBase,
      color: new THREE.Color(SEAL_COLOR), target: new THREE.Color(SEAL_COLOR),
    };
  }

  /**
   * Retints each cable for its Beacon's owner and runs the energy stream down it. `sealed` is the
   * Nexus seal — while it holds, every cable is visibly feeding it; once it collapses the flow drops
   * to a trickle, so a captured Beacon still glows in its colony's colour without pretending to power
   * something that is already down.
   */
  update(dt: number, owners: number[], sealed: boolean): void {
    this.time += dt;
    const flow = sealed ? 1 : 0.3;
    const opacity = sealed ? 0.92 : 0.55;
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i];
      const owner = owners[i] ?? -1;
      line.target.setHex(owner >= 0 ? COLONIES[owner].color : SEAL_COLOR);
      // ease so a capture sweeps the cable into the colony's colour instead of snapping
      line.color.lerp(line.target, Math.min(1, dt * 3.2));
      (line.mat.uniforms.uColor.value as THREE.Color).copy(line.color);
      line.mat.uniforms.uTime.value = this.time;
      line.mat.uniforms.uPulse.value = flow;
      line.mat.uniforms.uOpacity.value = opacity;

      // The stream: every streak rides the centre line of the cable, perpetually beacon -> nexus.
      // Each ring of a streak is sampled from the cable's own path, so the flow hugs the terrain
      // exactly like the wire it is running through, and the lateral axis is rebuilt per ring from
      // the local up and the path tangent so the ribbon stays flat on the cable.
      const path = line.path;
      const pos = line.tailPos;
      const col = line.tailCol;
      const rings = TAIL_RINGS.length;
      for (let k = 0; k < FLOW_COUNT; k++) {
        let t = (line.pBase[k] + this.time * FLOW_SPEED) % 1;
        if (t < 0) t += 1;
        for (let j = 0; j < rings; j++) {
          const ring = TAIL_RINGS[j];
          const raw = t - ring.p * TAIL_LEN;
          // a tail that would run off either end of the cable is simply invisible (the ring collapses
          // to the head, and its colour goes black — with additive blending that is nothing at all)
          const alive = raw >= 0 && raw <= 1;
          let tt = raw;
          if (tt < 0) tt = 0;
          else if (tt > 1) tt = 1;
          const f = tt * NODES;
          const n0 = Math.floor(f);
          const n1 = Math.min(NODES, n0 + 1);
          const fu = f - n0;
          const a = n0 * 3;
          const b = n1 * 3;
          const px = path[a] + (path[b] - path[a]) * fu;
          const py = path[a + 1] + (path[b + 1] - path[a + 1]) * fu;
          const pz = path[a + 2] + (path[b + 2] - path[a + 2]) * fu;
          // tangent of the segment -> the streak's own lateral axis on the cable
          let tx = path[b] - path[a];
          let ty = path[b + 1] - path[a + 1];
          let tz = path[b + 2] - path[a + 2];
          const tl = Math.hypot(tx, ty, tz) || 1;
          tx /= tl; ty /= tl; tz /= tl;
          const rl = Math.hypot(px, py, pz) || 1;
          const ux = px / rl, uy = py / rl, uz = pz / rl;
          // lateral = up x tangent, normalised (falls back to any perpendicular on a straight-up run)
          let lx = uy * tz - uz * ty;
          let ly = uz * tx - ux * tz;
          let lz = ux * ty - uy * tx;
          const ll = Math.hypot(lx, ly, lz) || 1;
          lx /= ll; ly /= ll; lz /= ll;
          const w = alive ? Math.max(0, TAIL_HEAD_W * ring.w) : 0;
          const o = (k * rings + j) * 6;
          pos[o] = px + lx * w;
          pos[o + 1] = py + ly * w;
          pos[o + 2] = pz + lz * w;
          pos[o + 3] = px - lx * w;
          pos[o + 4] = py - ly * w;
          pos[o + 5] = pz - lz * w;
          // the taper: white-hot at the head, fading to black down the tail (with additive blending
          // a black ring is empty space, which is what turns the taper into a rounded spark)
          const fade = alive ? ring.a * flow : 0;
          const white = 0.15 + 0.55 * Math.min(1, ring.a);
          const cr = line.color.r + (1 - line.color.r) * white;
          const cg = line.color.g + (1 - line.color.g) * white;
          const cb = line.color.b + (1 - line.color.b) * white;
          col[o] = cr * fade;
          col[o + 1] = cg * fade;
          col[o + 2] = cb * fade;
          // the outer rail of each ring is a touch dimmer, so the streak has soft sides
          col[o + 3] = cr * fade * 0.62;
          col[o + 4] = cg * fade * 0.62;
          col[o + 5] = cb * fade * 0.62;
        }
      }
      (line.tailGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (line.tailGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  /** Nothing to simulate when the world is gone — just stop the clock from running away. */
  reset(): void {
    this.time = 0;
    for (const line of this.lines) line.color.setHex(SEAL_COLOR);
  }
}
