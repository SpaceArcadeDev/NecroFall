// NECROFALL — pooled, allocation-free visual effects: particles, shockwave rings,
// ground circles, beams/tracers, floating damage numbers and screen shake.
import * as THREE from 'three';
import { MAX_PARTICLES, type QualitySettings } from '../core/Config';
import { clamp, lerp, tangentBasis } from '../utils/Utils';
import type { Planet } from '../world/Planet';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();
const _scaleV = new THREE.Vector3(1, 1, 1);
const _axisZ = new THREE.Vector3(0, 0, 1);
const _Y = new THREE.Vector3(0, 1, 0);
/** Bolt path scratch — 15 points, plus the three vectors a branch is walked through. */
const _boltPts = Array.from({ length: 15 }, () => new THREE.Vector3());
const _boltB1 = new THREE.Vector3();
const _boltB2 = new THREE.Vector3();
const _boltB3 = new THREE.Vector3();
/** Dedicated to the sweep emitters — beam()/burst() reuse _v.._v4 internally. */
const _swA = new THREE.Vector3();
const _swB = new THREE.Vector3();
const _swC = new THREE.Vector3();
const _swD = new THREE.Vector3();
const _swE = new THREE.Vector3();

/**
 * A spiky 3-D star: eight pyramids on the corners of a cube (the two interlocked tetrahedra), each
 * grown from a small core. Built once and shared by every star slot — 24 triangles, no textures.
 */
function buildStarGeometry(radius: number): THREE.BufferGeometry {
  const dirs = [
    [1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1],
    [-1, -1, -1], [-1, 1, 1], [1, -1, 1], [1, 1, -1],
  ];
  const positions: number[] = [];
  const core = 0.32;
  for (const d of dirs) {
    _v.set(d[0], d[1], d[2]).normalize();
    _v2.set(0, 1, 0);
    if (Math.abs(_v.dot(_v2)) > 0.94) _v2.set(1, 0, 0);
    _v2.crossVectors(_v, _v2).normalize();          // first axis around the spike
    _v3.crossVectors(_v, _v2).normalize();          // second
    for (let i = 0; i < 3; i++) {
      const a0 = (i / 3) * Math.PI * 2;
      const a1 = ((i + 1) / 3) * Math.PI * 2;
      // apex, then the two base corners of this face (all measured off the shared core ring)
      positions.push(_v.x * radius, _v.y * radius, _v.z * radius);
      for (const a of [a0, a1]) {
        positions.push(
          _v.x * core + _v2.x * Math.cos(a) * core + _v3.x * Math.sin(a) * core,
          _v.y * core + _v2.y * Math.cos(a) * core + _v3.y * Math.sin(a) * core,
          _v.z * core + _v2.z * Math.cos(a) * core + _v3.z * Math.sin(a) * core
        );
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}
/** Points along the whip's crescent slash ribbon — fine enough that one stroke reads as a smooth arc. */
const SLASH_STEPS = 26;
/** Strands a Judgement cage can raise in one cast, and the links each strand is made of. */
const CHAIN_STRANDS = 16;
const CHAIN_LINKS = 11;
/** Baked length of one chain strand; chains() scales it up to the requested height. */
const CHAIN_SPAN = 4.6;
/** Lean of the point capping each strand, so the spike follows the head of the chain. */
const TIP_TILT = Math.atan(1.5 / CHAIN_SPAN);
/** Local transform of each link along a strand (curving outward as it rises), baked once. */
const CHAIN_LINK_MATS: THREE.Matrix4[] = [];
/** Rings along a scythe lash, and vertices around each — a real chain, not a flat ribbon. The lash
 * spans up to the whole auto-attack ring, so it needs enough rings to stay a smooth curve. */
const LASH_SEGS = 30;
const LASH_RING = 5;
/** Reach of the Spinner's own arm; the lash profile is normalised against it so `range` = the tip. */
const LASH_REACH = 3.33;
/** Scratch for the lash guide curve, recomposed every frame (sweeps only — beam/burst reuse _v.._v4). */
const _lashCtr = Array.from({ length: LASH_SEGS + 1 }, () => new THREE.Vector3());
const _lashT = new THREE.Vector3();
const _lashN1 = new THREE.Vector3();
const _lashN2 = new THREE.Vector3();
/**
 * The Spinner's arm sampled into (reach, height) rings — the Scythe cuts with the very same blade.
 * Reach is normalised to 0..1 and stretches with the ability's range; HEIGHT IS NEVER SCALED, which
 * is what keeps the chain at body level however far the cut reaches.
 */
const LASH_PROFILE = ((): Float32Array => {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.24, 1.15, 0),
    new THREE.Vector3(1.11, 1.05, 0),
    new THREE.Vector3(2.02, 0.86, 0),
    new THREE.Vector3(2.79, 0.6, 0),
    new THREE.Vector3(LASH_REACH, 0.32, 0),
  ]);
  const out = new Float32Array((LASH_SEGS + 1) * 2);
  for (let i = 0; i <= LASH_SEGS; i++) {
    const p = curve.getPoint(i / LASH_SEGS);
    out[i * 2] = p.x / LASH_REACH;
    out[i * 2 + 1] = p.y;
  }
  return out;
})();
const _whiteColor = new THREE.Color(0xffffff);
/**
 * Scratch colour for the hot emitters. `burst` / `trail` are called thousands of times a second
 * (every hit spark, every status tell on every burning Necrophage), and `new THREE.Color(hex)`
 * per call was the single biggest source of garbage in the frame.
 */
const _col = new THREE.Color();
/** Scratch for the melee slash stroke (see `slash`). */
const _slashBright = new THREE.Color();
const _slashBody = new THREE.Color();

/** Inscribed radius of a regular hexagon as a fraction of its circumradius — `cos(30°)`. */
const HEX_APOTHEM = Math.cos(Math.PI / 6);

/**
 * Pins a world point on to the terrain, `lift` metres above it. The point is read as a DIRECTION
 * from the planet centre — which is exactly what it is on the inside of a sphere — so the result
 * follows the hillside rather than cutting through it. Without a planet (the menu) the point is
 * left alone.
 */
function place(p: THREE.Vector3, planet: Planet | null, lift: number): void {
  if (!planet) return;
  const len = Math.hypot(p.x, p.y, p.z);
  if (len < 1e-4) return;
  const h = planet.heightAtDir(p.x / len, p.y / len, p.z / len) + lift;
  p.multiplyScalar(h / len);
}
/** Scratch for the white-hot core of a flame particle. */
const _hotCol = new THREE.Color();

export interface BurstOpts {
  count?: number;
  speed?: number;
  life?: number;
  size?: number;
  up?: THREE.Vector3;
  spread?: number; // 0..1, bias along `up`
  /** Fire everything along this direction in a tight cone — streams, suctions, jets. */
  dir?: THREE.Vector3;
  /** Cone half-width of `dir` (0.22 ≈ a 12° stream). */
  jitter?: number;
  gravity?: number;
  drag?: number;
}

interface RingFX {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  max: number;
  r0: number;
  r1: number;
  a0: number;
  delay: number;
}

interface BeamFX {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  max: number;
  a0: number;
}

interface DmgNum {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  tex: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  life: number;
  max: number;
}

/** A persistent, animated event horizon: dark core + accretion rings that spiral inward. */
interface VortexFX {
  group: THREE.Group;
  core: THREE.Mesh;
  coreMat: THREE.MeshBasicMaterial;
  rings: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; speed: number; tilt: number }[];
  pos: THREE.Vector3;
  up: THREE.Vector3;
  radius: number;
  life: number;
  max: number;
  color: number;
  spin: number;
}

/**
 * A real lightning discharge: a jittered polyline from A to B with short offshoots, drawn as a bright
 * thin core inside a wider coloured glow. Rebuilt on every call, so no two bolts look alike.
 */
interface BoltFX {
  segs: { core: THREE.Mesh; glow: THREE.Mesh }[];
  coreMat: THREE.MeshBasicMaterial;
  glowMat: THREE.MeshBasicMaterial;
  life: number;
  max: number;
}

/**
 * A blade sweeping across an arc, laying its strokes down as it goes. NOTHING CALLS IT TODAY: the
 * Spinner whirls the model's own chain (Player.startWhipSpin) and the Scythe cuts with a lash
 * (lashSweep), but the state machine is kept for a future sustained whirl.
 */
interface SweepFX {
  pos: THREE.Vector3;
  up: THREE.Vector3;
  dir: THREE.Vector3;
  range: number;
  arc: number;
  color: number;
  dur: number;
  t: number;
  spin: number;
  steps: number;
  emitted: number;
  width: number;
  tail: number;
  /** How many times the arc repeats before the sweep ends (a sustained whirl). */
  repeat: number;
  /** Blade arms per rotation — 2 makes a whirl read as a real spin. */
  arms: number;
  /** Radians of bend along each stroke: a curved lash instead of a straight spoke. */
  curve: number;
  /** When set, the whirl rides the owner instead of a fixed point (Spinner follows the player). */
  livePos: THREE.Vector3 | null;
  liveUp: THREE.Vector3 | null;
}

/**
 * A crescent slash — the whip's auto-attack. One flat arc of light with a bright leading edge.
 */
interface SlashFX {
  mesh: THREE.Mesh;
  pos: Float32Array;
  col: Float32Array;
  mat: THREE.MeshBasicMaterial;
  life: number;
  max: number;
}

/**
 * The SCYTHE ARC: ONE chain lash — the blade the Spinner whirls — swung across an arc in a single
 * pass. It is a real 3-D tube rebuilt every frame from the model's own arm profile, so the cut reads
 * as a blade TRAVELLING across the arc instead of a fan of light appearing all at once, and the tail
 * trails behind the tip, which is what makes it whip rather than slide like a rigid rod.
 */
interface LashFX {
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  pos: Float32Array;
  col: Float32Array;
  mat: THREE.MeshBasicMaterial;
  body: THREE.Color;
  bright: THREE.Color;
  origin: THREE.Vector3;
  up: THREE.Vector3;
  dir: THREE.Vector3;
  /** Sweep angles relative to `dir` (radians, right-hand rule about `up`). */
  ang0: number;
  ang1: number;
  /** +1 when the blade runs to a LARGER angle about `up`, −1 the other way (the Spinner's way). */
  dirSign: number;
  /** Radians the tail trails the tip. */
  lag: number;
  range: number;
  width: number;
  life: number;
  max: number;
}

/**
 * A Judgement eruption: black chain spikes tearing out of the ground in crossing rings, each one
 * capped with a point. One InstancedMesh holds every link, another every point, so the whole burst is
 * two draw calls.
 */
interface ChainFX {
  inst: THREE.InstancedMesh;
  mat: THREE.MeshBasicMaterial;
  tipInst: THREE.InstancedMesh;
  tipMat: THREE.MeshBasicMaterial;
  pos: THREE.Vector3;
  up: THREE.Vector3;
  /** Outward heading of each strand, and the distance from the centre it stands at. */
  dirs: THREE.Vector3[];
  quats: THREE.Quaternion[];
  dists: Float64Array;
  /** Height of each strand as a fraction of the full height. */
  spans: Float64Array;
  radius: number;
  height: number;
  count: number;
  t: number;
  dur: number;
  active: boolean;
}

/** A body that flies from A to B — meteors, lobbed orbs, siege projectiles. */
interface OrbFX {
  mesh: THREE.Mesh;
  glow: THREE.Mesh;
  glowMat: THREE.MeshBasicMaterial;
  from: THREE.Vector3;
  to: THREE.Vector3;
  up: THREE.Vector3;
  radius: number;
  arc: number;
  t: number;
  dur: number;
  color: number;
  trailT: number;
  trailSize: number;
}

/**
 * A cluster of shards erupting out of the ground — Absolute Zero's ice mountain. Shards grow along
 * their own axis with a slight overshoot, then hold and fade, so the field reads as terrain that
 * burst upward rather than as another flat disc.
 */
interface EruptionFX {
  group: THREE.Group;
  shards: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; height: number; tilt: number; phase: number }[];
  up: THREE.Vector3;
  life: number;
  max: number;
}

/**
 * A stone tower thrusting up out of the ground and sinking back — Fortress Protocol's strongpoint.
 * One hexagonal drum, a lit collar at its foot and a spinning crown on top.
 */
interface PillarFX {
  group: THREE.Group;
  drum: THREE.Mesh;
  drumMat: THREE.MeshLambertMaterial;
  crown: THREE.Mesh;
  crownMat: THREE.MeshBasicMaterial;
  collar: THREE.Mesh;
  collarMat: THREE.MeshBasicMaterial;
  height: number;
  radius: number;
  life: number;
  max: number;
}

/**
 * A collapsing star: a spiky 3-D star that IMPLODES, then blows back out and fades. It is the whole
 * visual of Supernova — the burst it fires on the way out is a shockwave plus two particle shells, so
 * the ability reads as a star going off rather than as another ring on the ground.
 */
interface StarFX {
  group: THREE.Group;
  star: THREE.Mesh;
  starMat: THREE.MeshBasicMaterial;
  core: THREE.Mesh;
  coreMat: THREE.MeshBasicMaterial;
  up: THREE.Vector3;
  radius: number;
  color: number;
  life: number;
  max: number;
  fired: boolean;
}

/**
 * An expanding ground shockwave. The flat pulses are drawn with the ring pool (so they look exactly
 * like every other ground ring in the game) while this slot throws the debris front outward and
 * offsets the pulses behind it. Both STOP DEAD at `radius`: a wave may never be seen reaching
 * further than the area the ability actually covers.
 */
interface WaveFX {
  pos: THREE.Vector3;
  up: THREE.Vector3;
  radius: number;
  color: number;
  dur: number;
  t: number;
  /** Ground pulses fired across the life, and how many have gone. */
  rings: number;
  fired: number;
  /** Debris particles per second along the front. */
  rate: number;
  acc: number;
  alpha: number;
  spin: number;
}

/**
 * RECALL column dimensions (metres): the open cylinder stands taller than a survivor, and wide
 * enough that the body is inside it, not wearing it.
 */
const RECALL_COL_H = 4.6;
const RECALL_COL_R = 1.75;

/**
 * A hexagonal energy curtain raised around a claimed patch of ground — Fortress Protocol's bastion
 * wall. Six flat panels that pulse and turn, collared top and bottom so the shape reads as built
 * rather than as a cylinder that happens to have corners.
 */
interface DomeFX {
  group: THREE.Group;
  wall: THREE.Mesh;
  wallMat: THREE.MeshBasicMaterial;
  collar: THREE.Mesh;
  collarMat: THREE.MeshBasicMaterial;
  radius: number;
  height: number;
  life: number;
  max: number;
}

export class Effects {
  /**
   * Gameplay→environment destruction seam (rework plan §24): every shockwave an ability, boss or
   * death emits notifies this hook. The game forwards it to the planet's environment, which
   * damages trees/crates inside the radius. Purely visual — no rigid-body simulation.
   */
  onWave: ((pos: THREE.Vector3, up: THREE.Vector3, radius: number) => void) | null = null;

  private scene: THREE.Scene;
  /** Buffer capacity — always the top preset, so the particle ceiling can move at runtime. */
  private max: number;
  /** Ceiling granted by the graphics preset. */
  private qCap: number;
  /** Watchdog trim, multiplied into the ceiling. */
  private budgetMul = 1;
  /** Effective particle ceiling — the watchdog and the graphics preset both feed this. */
  private pCap = 0;
  private pCount = 0;
  private pPos: Float32Array;
  private pVel: Float32Array;
  private pLife: Float32Array;
  private pMaxLife: Float32Array;
  private pSize: Float32Array;
  private pCol: Float32Array;
  private pAlpha: Float32Array;
  private pGrav: Float32Array;
  private pDrag: Float32Array;
  private points: THREE.Points;
  private geo: THREE.BufferGeometry;

  private rings: RingFX[] = [];
  private beams: BeamFX[] = [];
  private dmgNums: DmgNum[] = [];
  private vortices: VortexFX[] = [];
  private orbs: OrbFX[] = [];
  private eruptions: EruptionFX[] = [];
  private pillars: PillarFX[] = [];
  private waves: WaveFX[] = [];
  private stars: StarFX[] = [];
  private starIdx = 0;
  private domes: DomeFX[] = [];
  private bolts: BoltFX[] = [];
  private sweeps: SweepFX[] = [];
  private sweepIdx = 0;
  private chainCages: ChainFX[] = [];
  private chainIdx = 0;
  private slashes: SlashFX[] = [];
  private slashIdx = 0;
  private lashes: LashFX[] = [];
  private lashIdx = 0;
  private ringIdx = 0;
  /** Independent cursor for the 10 DISK slots (plan: ring() reads `rings[0..15]`, disk() reads
   *  `rings[16..25]`). They shared `ringIdx` before, which let disk() push the cursor past the
   *  pool: after enough disks in a row the next ring() read `rings[26+]` = undefined and threw
   *  "Cannot read properties of undefined (reading 'mesh')" INSIDE the frame loop (caught by the
   *  frame-error guard, so the ring silently vanished — reported live 2026-09-29). */
  private diskIdx = 0;
  private beamIdx = 0;
  private dmgIdx = 0;
  private vortexIdx = 0;
  private orbIdx = 0;
  private eruptionIdx = 0;
  private pillarIdx = 0;
  private boltIdx = 0;
  private waveIdx = 0;
  private domeIdx = 0;

  private shakeAmt = 0;
  private quality: QualitySettings;
  /**
   * RECALL channel column (user ask 2026-09-29): ONE live emitter, fed every frame by
   * `recallColumn` for as long as the ritual runs. `recallHeat` follows whether it was fed,
   * so a broken channel fades the whole effect out instead of cutting it.
   */
  private recallMesh!: THREE.Mesh;
  private recallMat!: THREE.MeshBasicMaterial;
  private recallBase!: THREE.Mesh;
  private recallBaseMat!: THREE.MeshBasicMaterial;
  /** The column's top/bottom collars — one shared material, two rings. */
  private recallCollarA!: THREE.Mesh;
  private recallCollarB!: THREE.Mesh;
  private recallCollarMat!: THREE.MeshBasicMaterial;
  private recallHeat = 0;
  private recallTime = 0;
  private recallCalled = false;
  private recallPulseT = 0;
  private recallPulseN = 0;
  private recallEmberT = 0;
  private recallStreakT = 0;
  private readonly recallPos = new THREE.Vector3();
  private readonly recallUp = new THREE.Vector3(0, 1, 0);
  private recallColor = 0x8fd7ff;
  /**
   * The planet ground effects are laid on. Optional: the menu and lobby build a scene with no
   * terrain, and a shape asked for before a match exists simply stays planar.
   */
  private planet: Planet | null = null;

  constructor(scene: THREE.Scene, quality: QualitySettings) {
    this.scene = scene;
    this.quality = quality;
    // Allocated at the top preset so `setCap` can raise the ceiling later without reallocating.
    this.max = MAX_PARTICLES;
    this.qCap = clamp(quality.particles, 0, this.max);
    this.recomputeCap();

    this.pPos = new Float32Array(this.max * 3);
    this.pVel = new Float32Array(this.max * 3);
    this.pLife = new Float32Array(this.max);
    this.pMaxLife = new Float32Array(this.max);
    this.pSize = new Float32Array(this.max);
    this.pCol = new Float32Array(this.max * 3);
    this.pAlpha = new Float32Array(this.max);
    this.pGrav = new Float32Array(this.max);
    this.pDrag = new Float32Array(this.max);

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.max * 3), 3));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(this.max * 3), 3));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(this.max), 1));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(this.max), 1));
    this.geo.setDrawRange(0, 0);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vColor = aColor; vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (420.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float d = dot(c, c);
          if (d > 1.0) discard;
          gl_FragColor = vec4(vColor, vAlpha * (1.0 - d));
        }`,
    });

    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);

    // eruption pool: two clusters, each a ring of tapered shards grown from a shared unit cone
    const shardGeo = new THREE.ConeGeometry(1, 1, 5, 1);
    shardGeo.translate(0, 0.5, 0);   // grows upward from its base
    for (let i = 0; i < 2; i++) {
      const group = new THREE.Group();
      group.visible = false;
      group.renderOrder = 4;
      const shards: EruptionFX['shards'] = [];
      for (let s = 0; s < 15; s++) {
        const mat = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const mesh = new THREE.Mesh(shardGeo, mat);
        group.add(mesh);
        shards.push({ mesh, mat, height: 1, tilt: 0, phase: 0 });
      }
      scene.add(group);
      this.eruptions.push({ group, shards, up: new THREE.Vector3(0, 1, 0), life: 0, max: 1 });
    }

    // pillar pool: two erupting towers
    const drumGeo = new THREE.CylinderGeometry(1, 1.12, 1, 6, 1);
    drumGeo.translate(0, 0.5, 0);   // stands ON its base
    const crownGeo = new THREE.OctahedronGeometry(0.5, 0);
    const collarGeo = new THREE.RingGeometry(0.84, 1.06, 26);
    collarGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 2; i++) {
      const group = new THREE.Group();
      group.visible = false;
      const drumMat = new THREE.MeshLambertMaterial({ color: 0x6b6a7c });
      const drum = new THREE.Mesh(drumGeo, drumMat);
      const crownMat = new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const crown = new THREE.Mesh(crownGeo, crownMat);
      const collarMat = new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide,
      });
      const collar = new THREE.Mesh(collarGeo, collarMat);
      group.add(drum, crown, collar);
      scene.add(group);
      this.pillars.push({ group, drum, drumMat, crown, crownMat, collar, collarMat, height: 5, radius: 1, life: 0, max: 1 });
    }

    // shockwave pool: four independent ground fronts, each just a timing state machine over the
    // ring pool and the particle buffer
    for (let i = 0; i < 4; i++) {
      this.waves.push({
        pos: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0),
        radius: 4, color: 0xffffff, dur: 0.6, t: 99,
        rings: 3, fired: 0, rate: 30, acc: 0, alpha: 0.85, spin: 0,
      });
    }

    // collapsing star pool: two 3-D starbursts (eight spikes off a small core) with a glowing heart
    const starGeo = buildStarGeometry(1);
    const starCoreGeo = new THREE.IcosahedronGeometry(1, 1);
    for (let i = 0; i < 2; i++) {
      const group = new THREE.Group();
      group.visible = false;
      const starMat = new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const star = new THREE.Mesh(starGeo, starMat);
      star.renderOrder = 5;
      const coreMat = new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const core = new THREE.Mesh(starCoreGeo, coreMat);
      core.renderOrder = 6;
      group.add(star, core);
      scene.add(group);
      this.stars.push({
        group, star, starMat, core, coreMat,
        up: new THREE.Vector3(0, 1, 0), radius: 6, color: 0xffffff, life: 0, max: 1, fired: false,
      });
    }

    // bastion dome pool: two hexagonal energy curtains
    const wallGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    wallGeo.translate(0, 0.5, 0);          // stands ON its base, like the pillar's drum
    const wallCollarGeo = new THREE.RingGeometry(0.94, 1.06, 6);
    wallCollarGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 2; i++) {
      const group = new THREE.Group();
      group.visible = false;
      const wallMat = new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const wall = new THREE.Mesh(wallGeo, wallMat);
      wall.renderOrder = 4;
      const collarMat = new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const collar = new THREE.Mesh(wallCollarGeo, collarMat);
      collar.renderOrder = 5;
      group.add(wall, collar);
      scene.add(group);
      this.domes.push({ group, wall, wallMat, collar, collarMat, radius: 6, height: 3, life: 0, max: 1 });
    }

    // bolt pool: FOURTEEN discharges of up to 16 segments each (path + branches), core + glow per
    // segment. It used to be three, which was exactly one Volt lance (main arc + two chain hops) — so
    // the moment a second cast, a storm strike or a busy fight claimed a slot, a LIVE bolt was
    // overwritten and the ability appeared to do nothing. Meshes are built once and hidden, so the
    // extra slots cost nothing per frame.
    const boltGeo = new THREE.CylinderGeometry(1, 1, 1, 5, 1);
    boltGeo.translate(0, 0.5, 0);
    for (let i = 0; i < 14; i++) {
      const coreMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const glowMat = new THREE.MeshBasicMaterial({
        color: 0x7fd4ff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const segs: BoltFX['segs'] = [];
      for (let s = 0; s < 16; s++) {
        const core = new THREE.Mesh(boltGeo, coreMat);
        const glow = new THREE.Mesh(boltGeo, glowMat);
        core.visible = false;
        glow.visible = false;
        glow.renderOrder = 5;
        core.renderOrder = 6;
        scene.add(core, glow);
        segs.push({ core, glow });
      }
      this.bolts.push({ segs, coreMat, glowMat, life: 0, max: 1 });
    }

    // sweep slots: four independent swings, each just a state machine over the beam pool
    for (let i = 0; i < 4; i++) {
      this.sweeps.push({
        pos: new THREE.Vector3(), up: new THREE.Vector3(), dir: new THREE.Vector3(),
        range: 8, arc: Math.PI, color: 0xffffff, dur: 0.25, t: 0, spin: 1, steps: 9, emitted: 0, width: 0.3, tail: 2,
        repeat: 1, arms: 1, curve: 0, livePos: null, liveUp: null,
      });
    }

    // chain spikes: black links as instanced toruses, each strand tipped with a point
    const linkGeo = new THREE.TorusGeometry(0.26, 0.078, 4, 8);
    // the cone that caps a strand — the chain ends in a spike, not a bare link
    const tipGeo = new THREE.ConeGeometry(0.4, 1.5, 6);
    tipGeo.rotateZ(TIP_TILT);
    tipGeo.translate(-0.6, CHAIN_SPAN + 0.6, -0.13);
    for (let i = 0; i < CHAIN_LINKS; i++) {
      const t = (i + 0.5) / CHAIN_LINKS;
      const y = t * CHAIN_SPAN;
      // nearly upright, with the head of the chain curling in over the zone like a claw; the links
      // follow the curve, taper toward the point, and every other one is rolled 90° to interlock
      const bow = -0.5 * t * t * t;
      const sway = 0.16 * Math.sin(t * Math.PI * 1.35);
      const m = new THREE.Matrix4().makeTranslation(bow, y, sway);
      m.multiply(_m4.makeRotationZ(Math.atan((1.5 * t * t) / CHAIN_SPAN)));
      if (i % 2 === 1) m.multiply(_m4.makeRotationY(Math.PI / 2));
      const taper = 1 - 0.42 * t * t;
      m.multiply(_m4.makeScale(taper, taper, taper));
      CHAIN_LINK_MATS.push(m);
    }
    const chainDark = new THREE.Color(0x06060a);
    const chainLit = new THREE.Color(0x413a55);
    const chainTip = new THREE.Color(0x2c2540);
    const linkTint = new THREE.Color();
    for (let slot = 0; slot < 2; slot++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: true,
      });
      const inst = new THREE.InstancedMesh(linkGeo, mat, CHAIN_STRANDS * CHAIN_LINKS);
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      inst.frustumCulled = false;
      inst.visible = false;
      // links glow faintly at the base (where the ground tears open) and go black as they climb
      for (let s = 0; s < CHAIN_STRANDS; s++) {
        for (let i = 0; i < CHAIN_LINKS; i++) {
          linkTint.copy(chainLit).lerp(chainDark, i / (CHAIN_LINKS - 1)).lerp(chainDark, s * 0.03);
          inst.setColorAt(s * CHAIN_LINKS + i, linkTint);
        }
      }
      const tipMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: true,
      });
      const tipInst = new THREE.InstancedMesh(tipGeo, tipMat, CHAIN_STRANDS);
      tipInst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      tipInst.frustumCulled = false;
      tipInst.visible = false;
      for (let s = 0; s < CHAIN_STRANDS; s++) tipInst.setColorAt(s, chainTip);
      this.scene.add(inst, tipInst);
      this.chainCages.push({
        inst, mat,
        tipInst, tipMat,
        pos: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0),
        dirs: Array.from({ length: CHAIN_STRANDS }, () => new THREE.Vector3()),
        quats: Array.from({ length: CHAIN_STRANDS }, () => new THREE.Quaternion()),
        dists: new Float64Array(CHAIN_STRANDS),
        spans: new Float64Array(CHAIN_STRANDS),
        radius: 4, height: 6, count: 0, t: 0, dur: 1, active: false,
      });
    }

    // slash pool: twelve crescent ribbons, rebuilt in place (28 verts each, no allocation at
    // runtime). Twelve because ONE whip swing draws up to eight crescents in the same frame (see
    // Player.updateAutoAttack / MAX_LASHES) while the Scythe may hold four of its own.
    for (let i = 0; i < 12; i++) {
      const steps = SLASH_STEPS;
      const pos = new Float32Array(steps * 2 * 3);
      const col = new Float32Array(steps * 2 * 3);
      const idx: number[] = [];
      for (let s = 0; s < steps - 1; s++) {
        const a = s * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(idx);
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      this.slashes.push({ mesh, pos, col, mat, life: 0, max: 1 });
    }

    // lash pool: three chain blades, each rebuilt in place every frame (see lashSweep)
    const lashTris: number[] = [];
    for (let s = 0; s < LASH_SEGS; s++) {
      for (let k = 0; k < LASH_RING; k++) {
        const a = s * LASH_RING + k;
        const b = s * LASH_RING + ((k + 1) % LASH_RING);
        const c = (s + 1) * LASH_RING + k;
        const d = (s + 1) * LASH_RING + ((k + 1) % LASH_RING);
        lashTris.push(a, c, b, b, c, d);
      }
    }
    for (let i = 0; i < 3; i++) {
      const pos = new Float32Array((LASH_SEGS + 1) * LASH_RING * 3);
      const col = new Float32Array((LASH_SEGS + 1) * LASH_RING * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(lashTris);
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;   // the rings are written in world space
      mesh.visible = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      this.lashes.push({
        mesh, geo, pos, col, mat,
        body: new THREE.Color(0xffffff), bright: new THREE.Color(0xffffff),
        origin: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), dir: new THREE.Vector3(0, 0, 1),
        ang0: 0, ang1: 0, dirSign: 1, lag: 0.4, range: 8, width: 0.12, life: 0, max: 1,
      });
    }

    // ring / disk pool
    const ringGeo = new THREE.RingGeometry(0.86, 1, 40);
    ringGeo.rotateX(-Math.PI / 2);
    const diskGeo = new THREE.CircleGeometry(1, 32);
    diskGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 26; i++) {
      const isDisk = i >= 16;
      const m = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      });
      const mesh = new THREE.Mesh(isDisk ? diskGeo : ringGeo, m);
      mesh.visible = false;
      mesh.renderOrder = 4;
      scene.add(mesh);
      this.rings.push({ mesh, mat: m, life: 0, max: 1, r0: 1, r1: 1, a0: 1, delay: 0 });
    }

    // vortex pool: a normal-blended dark core punches a hole through the additive layers, with
    // tilted accretion rings swirling around it.
    const coreGeo = new THREE.SphereGeometry(0.62, 14, 10);
    const accGeo = new THREE.RingGeometry(0.72, 1, 40);
    accGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 3; i++) {
      const group = new THREE.Group();
      const coreMat = new THREE.MeshBasicMaterial({
        color: 0x06030d,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const core = new THREE.Mesh(coreGeo, coreMat);
      core.renderOrder = 6;
      group.add(core);
      const rings: VortexFX['rings'] = [];
      for (let k = 0; k < 3; k++) {
        const mat = new THREE.MeshBasicMaterial({
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          opacity: 0,
        });
        const mesh = new THREE.Mesh(accGeo, mat);
        mesh.rotation.set(0.5 * k - 0.4, 0, 0.9 * k);
        mesh.renderOrder = 5;
        group.add(mesh);
        rings.push({ mesh, mat, speed: 1.6 + k * 0.9, tilt: 0.5 * k });
      }
      group.visible = false;
      scene.add(group);
      this.vortices.push({
        group, core, coreMat, rings,
        pos: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0),
        radius: 6, life: 0, max: 1, color: 0xc94dff, spin: 0,
      });
    }

    // flying bodies: a lit core plus an additive glow shell
    const orbGeo = new THREE.SphereGeometry(1, 14, 10);
    const glowGeo = new THREE.SphereGeometry(1.5, 12, 9);
    for (let i = 0; i < 6; i++) {
      const mesh = new THREE.Mesh(orbGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      mesh.renderOrder = 5;
      mesh.visible = false;
      const glowMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.5,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const glow = new THREE.Mesh(glowGeo, glowMat);
      glow.renderOrder = 5;
      glow.visible = false;
      scene.add(mesh, glow);
      this.orbs.push({
        mesh, glow, glowMat,
        from: new THREE.Vector3(), to: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0),
        radius: 1, arc: 0, t: 0, dur: 0, color: 0xffffff, trailT: 0, trailSize: 0.6,
      });
    }

    // beam pool
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 7, 1, true);
    for (let i = 0; i < 48; i++) {
      const m = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      });
      const mesh = new THREE.Mesh(beamGeo, m);
      mesh.visible = false;
      mesh.renderOrder = 4;
      scene.add(mesh);
      this.beams.push({ mesh, mat: m, life: 0, max: 1, a0: 1 });
    }

    // RECALL column: one open cylinder around the caster plus the ground ring at its base — the
    // streaks themselves are ordinary particles sprinted up its wall (see `recallColumn`).
    const recallGeo = new THREE.CylinderGeometry(1, 1, 1, 26, 1, true);
    recallGeo.translate(0, 0.5, 0);   // stands ON its base
    this.recallMat = new THREE.MeshBasicMaterial({
      color: 0x9fdcff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.recallMesh = new THREE.Mesh(recallGeo, this.recallMat);
    this.recallMesh.visible = false;
    this.recallMesh.renderOrder = 4;
    this.recallMesh.frustumCulled = false;
    scene.add(this.recallMesh);
    const recallBaseGeo = new THREE.RingGeometry(0.82, 1, 40);
    recallBaseGeo.rotateX(-Math.PI / 2);
    this.recallBaseMat = new THREE.MeshBasicMaterial({
      color: 0x9fdcff, transparent: true, opacity: 0, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.recallBase = new THREE.Mesh(recallBaseGeo, this.recallBaseMat);
    this.recallBase.visible = false;
    this.recallBase.renderOrder = 4;
    this.recallBase.frustumCulled = false;
    scene.add(this.recallBase);
    // top and bottom collars: flat rings on the tube's ends, so the column reads as BUILT (the
    // Fortress Protocol curtain's own language) instead of a cylinder-shaped fog
    const recallCollarGeo = new THREE.RingGeometry(0.9, 1.06, 40);
    recallCollarGeo.rotateX(-Math.PI / 2);
    this.recallCollarMat = new THREE.MeshBasicMaterial({
      color: 0x9fdcff, transparent: true, opacity: 0, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.recallCollarA = new THREE.Mesh(recallCollarGeo, this.recallCollarMat);
    this.recallCollarB = new THREE.Mesh(recallCollarGeo, this.recallCollarMat);
    for (const collar of [this.recallCollarA, this.recallCollarB]) {
      collar.visible = false;
      collar.renderOrder = 4;
      collar.frustumCulled = false;
      scene.add(collar);
    }

    // damage numbers
    if (quality.damageNumbers) {
      for (let i = 0; i < 22; i++) {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 80;
        const tex = new THREE.CanvasTexture(canvas);
        const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
        const sprite = new THREE.Sprite(m);
        sprite.visible = false;
        sprite.renderOrder = 20;
        sprite.scale.set(3, 1.5, 1);
        scene.add(sprite);
        this.dmgNums.push({ sprite, mat: m, tex, canvas, life: 0, max: 1 });
      }
    }
  }

  // ------------------------------------------------------------ particles

  /** Scales the number of live particles the effects system is allowed to keep (watchdog hook). */
  setBudget(mul: number): void {
    this.budgetMul = mul;
    this.recomputeCap();
  }

  /** Graphics-preset hook: the ceiling a full-budget frame is allowed to reach. */
  setCap(cap: number): void {
    this.qCap = clamp(cap, 0, this.max);
    this.recomputeCap();
  }

  private recomputeCap(): void {
    this.pCap = Math.max(48, Math.round(this.qCap * this.budgetMul));
    if (this.pCount > this.pCap) this.pCount = this.pCap;
  }

  /** Live particle count (F1 diagnostics). */
  get activeCount(): number {
    return this.pCount;
  }

  /** The ceiling the budget currently allows (F1 diagnostics). */
  get cap(): number {
    return this.pCap;
  }
  private spawnParticle(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size: number,
    r: number, g: number, b: number,
    gravity: number, drag: number
  ): void {
    if (this.pCount >= this.pCap) return;
    const i = this.pCount++;
    const i3 = i * 3;
    this.pPos[i3] = x; this.pPos[i3 + 1] = y; this.pPos[i3 + 2] = z;
    this.pVel[i3] = vx; this.pVel[i3 + 1] = vy; this.pVel[i3 + 2] = vz;
    this.pLife[i] = life; this.pMaxLife[i] = life;
    this.pSize[i] = size;
    this.pCol[i3] = r; this.pCol[i3 + 1] = g; this.pCol[i3 + 2] = b;
    this.pAlpha[i] = 1;
    this.pGrav[i] = gravity; this.pDrag[i] = drag;
  }

  burst(pos: THREE.Vector3, color: number, opts: BurstOpts = {}): void {
    const c = _col.setHex(color);
    const n = opts.count ?? 14;
    const speed = opts.speed ?? 9;
    const life = opts.life ?? 0.5;
    const size = opts.size ?? 0.55;
    const spread = opts.spread ?? 0;
    const grav = opts.gravity ?? 12;
    const drag = opts.drag ?? 2.2;
    const up = opts.up;
    const dir = opts.dir;
    const jitter = opts.jitter ?? 0.22;
    for (let i = 0; i < n; i++) {
      _v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (_v.lengthSq() < 1e-4) _v.set(0, 1, 0);
      _v.normalize();
      if (dir) _v.multiplyScalar(jitter).add(dir).normalize();
      else if (up && spread > 0) _v.addScaledVector(up, spread * Math.random() * 2).normalize();
      const s = speed * (0.5 + Math.random() * 0.7);
      this.spawnParticle(
        pos.x, pos.y, pos.z,
        _v.x * s, _v.y * s, _v.z * s,
        life * (0.65 + Math.random() * 0.6), size * (0.6 + Math.random() * 0.8),
        c.r, c.g, c.b, grav, drag
      );
    }
  }

  /**
   * Internal burst that reads plain arguments — the hot wrappers below use it so that a hit spark
   * or a blood splash does not allocate an option object either.
   */
  private burstArgs(
    pos: THREE.Vector3, color: number,
    n: number, speed: number, life: number, size: number, grav: number, drag: number
  ): void {
    const c = _col.setHex(color);
    for (let i = 0; i < n; i++) {
      _v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (_v.lengthSq() < 1e-4) _v.set(0, 1, 0);
      _v.normalize();
      const s = speed * (0.5 + Math.random() * 0.7);
      this.spawnParticle(
        pos.x, pos.y, pos.z,
        _v.x * s, _v.y * s, _v.z * s,
        life * (0.65 + Math.random() * 0.6), size * (0.6 + Math.random() * 0.8),
        c.r, c.g, c.b, grav, drag
      );
    }
  }

  /**
   * A body ON FIRE: flames thrown up off a ring of points over the creature's whole upper half, with
   * a white-hot core, buoyant lift (negative gravity — see `update`) and a hard flicker.
   *
   * Emitting from the BODY rather than from one spot at the crown is the whole point: a single
   * emitter at the top of the silhouette is swallowed by the creature's own mesh, which is why a
   * burning Necrophage used to read as a glowing ball with no fire on it. Count and size scale with
   * the body, so a boss wreathed in flame is unmistakable from across the field.
   */
  flameBody(
    centre: THREE.Vector3,
    up: THREE.Vector3,
    radius: number,
    color: number,
    opts: { count?: number; speed?: number; life?: number; size?: number; lift?: number; hot?: number } = {}
  ): void {
    const n = Math.max(1, Math.round(opts.count ?? 8));
    const speed = opts.speed ?? 3;
    const life = opts.life ?? 0.7;
    const size = opts.size ?? 0.35;
    const lift = opts.lift ?? -3.4;
    const hotShare = opts.hot ?? 0.55;
    const c = _col.setHex(color);
    const hot = _hotCol.setHex(color).lerp(_whiteColor, 0.72);
    tangentBasis(up, _v, _v2);
    for (let i = 0; i < n; i++) {
      // a random point on the upper half of the body: off the whole silhouette, not the crown
      const a = Math.random() * Math.PI * 2;
      const rr = radius * (0.3 + Math.random() * 0.9);
      const hh = radius * (0.2 + Math.random() * 1.1);
      _v3.copy(centre)
        .addScaledVector(up, hh)
        .addScaledVector(_v, Math.cos(a) * rr)
        .addScaledVector(_v2, Math.sin(a) * rr);
      // straight up with a little outward flare and enough jitter to flicker
      _v4.copy(up).multiplyScalar(0.8 + Math.random() * 0.7)
        .addScaledVector(_v, (Math.random() - 0.5) * 0.6)
        .addScaledVector(_v2, (Math.random() - 0.5) * 0.6)
        .normalize()
        .multiplyScalar(speed * (0.6 + Math.random() * 0.8));
      const isHot = Math.random() < hotShare;
      this.spawnParticle(
        _v3.x, _v3.y, _v3.z, _v4.x, _v4.y, _v4.z,
        life * (0.6 + Math.random() * 0.7),
        size * (0.5 + Math.random() * 0.95),
        isHot ? hot.r : c.r, isHot ? hot.g : c.g, isHot ? hot.b : c.b,
        lift, 2.4
      );
    }
  }

  hitSpark(pos: THREE.Vector3, color: number, count = 7): void {
    this.burstArgs(pos, color, count, 7, 0.3, 0.4, 4, 4);
  }

  trail(pos: THREE.Vector3, color: number, size = 0.4, life = 0.22): void {
    const c = _col.setHex(color);
    this.spawnParticle(pos.x, pos.y, pos.z, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, life, size, c.r, c.g, c.b, 0, 1.5);
  }

  blood(pos: THREE.Vector3, color: number): void {
    this.burstArgs(pos, color, 10, 6, 0.45, 0.45, 26, 1.6);
  }

  // ------------------------------------------------------------ rings/disks

  ring(pos: THREE.Vector3, up: THREE.Vector3, radius: number, color: number, life = 0.5, expand = 1.6, alpha = 0.85, delay = 0): void {
    const fx = this.rings[this.ringIdx];
    this.ringIdx = (this.ringIdx + 1) % 16; // first 16 slots are rings
    fx.mesh.visible = false;
    fx.life = life;
    fx.max = life;
    fx.r0 = radius;
    fx.r1 = radius * expand;
    fx.a0 = alpha;
    fx.delay = delay;
    fx.mat.color.setHex(color);
    fx.mat.opacity = 0;
    this.orientFlat(fx.mesh, pos, up);
  }

  disk(pos: THREE.Vector3, up: THREE.Vector3, radius: number, color: number, life = 0.6, grow = 1.1, alpha = 0.35, delay = 0): void {
    const fx = this.rings[16 + this.diskIdx];
    this.diskIdx = (this.diskIdx + 1) % 10; // the last 10 slots are disks
    fx.mesh.visible = false;
    fx.life = life;
    fx.max = life;
    fx.r0 = radius;
    fx.r1 = radius * grow;
    fx.a0 = alpha;
    fx.delay = delay;
    fx.mat.color.setHex(color);
    fx.mat.opacity = 0;
    this.orientFlat(fx.mesh, pos, up);
  }

  private orientFlat(mesh: THREE.Mesh, pos: THREE.Vector3, up: THREE.Vector3): void {
    _v.copy(pos);
    _v2.copy(up).normalize();
    _q.setFromUnitVectors(_Y, _v2);
    mesh.quaternion.copy(_q);
    mesh.position.copy(_v).addScaledVector(_v2, 0.12);
  }

  /**
   * RECALL — the channel column (user ask 2026-09-29). An open energy cylinder stands around the
   * body while the ritual runs, STREAKS sprint up its wall, and the base breathes a ground ring
   * with a halo of embers. Call it EVERY FRAME while the channel lives, with the frame's `dt`:
   * the column fades in and holds, and it fades back out on its own within ~0.3 s of the calls
   * stopping — a broken channel dies with the effect instead of snapping off.
   */
  recallColumn(pos: THREE.Vector3, up: THREE.Vector3, color: number, dt: number): void {
    this.recallCalled = true;
    this.recallPos.copy(pos);
    this.recallUp.copy(up).normalize();
    this.recallColor = color;
    const heat = this.recallHeat;
    if (heat <= 0.02) return;

    // ---- STREAKS: particles sprinting up the cylinder's wall, from its whole height. Fed at a
    // constant rate (~120/s) regardless of frame rate — a fast machine draws the same ritual.
    tangentBasis(this.recallUp, _v, _v2);
    const c = _col.setHex(color).lerp(_whiteColor, 0.34);
    const n = clamp(Math.round((dt / 0.016) * 2 * (0.35 + 0.65 * heat)), 1, 6);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const ca = Math.cos(a) * RECALL_COL_R * (0.8 + Math.random() * 0.32);
      const sa = Math.sin(a) * RECALL_COL_R * (0.8 + Math.random() * 0.32);
      const h = Math.random() * RECALL_COL_H;
      const sp = 9 + Math.random() * 8;
      // mostly up, a little sideways kick and a soft inward pull so the wall reads as spinning
      const jx = (Math.random() - 0.5) * 3.4;
      const jy = (Math.random() - 0.5) * 3.4;
      const ex = _v.x * ca + _v2.x * sa;
      const ey = _v.y * ca + _v2.y * sa;
      const ez = _v.z * ca + _v2.z * sa;
      this.spawnParticle(
        this.recallPos.x + ex + this.recallUp.x * h,
        this.recallPos.y + ey + this.recallUp.y * h,
        this.recallPos.z + ez + this.recallUp.z * h,
        ex * -1.1 + _v.x * jx + _v2.x * jy + this.recallUp.x * sp,
        ey * -1.1 + _v.y * jx + _v2.y * jy + this.recallUp.y * sp,
        ez * -1.1 + _v.z * jx + _v2.z * jy + this.recallUp.z * sp,
        0.26 + Math.random() * 0.24,
        (0.2 + Math.random() * 0.16) * (0.6 + 0.4 * heat),
        c.r, c.g, c.b, 0, 0.5
      );
    }

    // ---- base embers: low sparks skimming outward across the ground, lifting as they cool
    this.recallEmberT -= dt;
    while (this.recallEmberT <= 0) {
      this.recallEmberT += 0.05;
      const a = Math.random() * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const r0 = RECALL_COL_R * (0.7 + Math.random() * 0.5);
      const out = 2.2 + Math.random() * 2.6;
      this.spawnParticle(
        this.recallPos.x + _v.x * ca * r0 + _v2.x * sa * r0,
        this.recallPos.y + _v.y * ca * r0 + _v2.y * sa * r0,
        this.recallPos.z + _v.z * ca * r0 + _v2.z * sa * r0,
        _v.x * ca * out + _v2.x * sa * out + this.recallUp.x * (1 + Math.random() * 2.4),
        _v.y * ca * out + _v2.y * sa * out + this.recallUp.y * (1 + Math.random() * 2.4),
        _v.z * ca * out + _v2.z * sa * out + this.recallUp.z * (1 + Math.random() * 2.4),
        0.34 + Math.random() * 0.22,
        0.22 + Math.random() * 0.2,
        c.r, c.g, c.b, -3.6, 1.6
      );
    }

    // ---- COMET STREAKS: short beams racing up the wall. The particle streaks above read as
    // sparks; these read as SPEED — the "streaking" half of the user's ask.
    this.recallStreakT -= dt;
    if (this.recallStreakT <= 0 && heat > 0.25) {
      this.recallStreakT = 0.035;
      const a = Math.random() * Math.PI * 2;
      const ca = Math.cos(a) * RECALL_COL_R * 0.99;
      const sa = Math.sin(a) * RECALL_COL_R * 0.99;
      const h = Math.random() * (RECALL_COL_H - 1.7);
      _v3.copy(this.recallPos).addScaledVector(_v, ca).addScaledVector(_v2, sa).addScaledVector(this.recallUp, h);
      _v4.copy(_v3).addScaledVector(this.recallUp, 1.3 + Math.random() * 1.5);
      this.beam(_v3, _v4, color, 0.05 + Math.random() * 0.05, 0.11 + Math.random() * 0.08, 0.8);
    }
  }

  /**
   * The column's steady half: heat (fed or not-fed), the cylinder/base-ring transforms, and the
   * ground pulse beat. Runs from `update` every frame so the fade-out finishes even after the
   * last `recallColumn` call.
   */
  private updateRecallColumn(dt: number): void {
    this.recallTime += dt;
    this.recallHeat = this.recallCalled
      ? Math.min(1, this.recallHeat + dt * 5)
      : Math.max(0, this.recallHeat - dt * 3.4);
    this.recallCalled = false;
    const heat = this.recallHeat;
    const on = heat > 0.01;
    if (this.recallMesh.visible !== on) {
      this.recallMesh.visible = on;
      this.recallBase.visible = on;
      this.recallCollarA.visible = on;
      this.recallCollarB.visible = on;
    }
    if (!on) return;
    _v.copy(this.recallUp);
    this.recallMesh.position.copy(this.recallPos);
    this.recallMesh.quaternion.setFromUnitVectors(_Y, _v);
    const swell = 0.86 + 0.14 * heat;
    const colH = RECALL_COL_H * (0.55 + 0.45 * heat);
    this.recallMesh.scale.set(RECALL_COL_R * swell, colH, RECALL_COL_R * swell);
    this.recallMat.color.setHex(this.recallColor).lerp(_whiteColor, 0.16);
    this.recallMat.opacity = heat * (0.19 + 0.06 * Math.sin(this.recallTime * 8.5));
    this.recallBase.position.copy(this.recallPos).addScaledVector(_v, 0.14);
    this.recallBase.quaternion.setFromUnitVectors(_Y, _v);
    const pulse = 0.5 + 0.5 * Math.sin(this.recallTime * 3.2);
    this.recallBase.scale.setScalar(RECALL_COL_R * (0.9 + 0.1 * pulse));
    this.recallBaseMat.color.setHex(this.recallColor).lerp(_whiteColor, 0.3 * pulse);
    this.recallBaseMat.opacity = heat * (0.28 + 0.2 * pulse);
    // collars: one hugging the base, one riding the tube's top, both beating with the wall
    const collarScale = RECALL_COL_R * (0.97 + 0.05 * pulse);
    this.recallCollarA.position.copy(this.recallPos).addScaledVector(_v, 0.2);
    this.recallCollarB.position.copy(this.recallPos).addScaledVector(_v, colH - 0.08);
    for (const collar of [this.recallCollarA, this.recallCollarB]) {
      collar.quaternion.setFromUnitVectors(_Y, _v);
      collar.scale.setScalar(collarScale);
    }
    this.recallCollarMat.color.setHex(this.recallColor).lerp(_whiteColor, 0.35 * pulse);
    this.recallCollarMat.opacity = heat * (0.42 + 0.22 * pulse);
    // a flat ground pulse on its own beat, alternating a sharp ring and a soft disc
    this.recallPulseT -= dt;
    if (this.recallPulseT <= 0 && heat > 0.35) {
      this.recallPulseT = 0.46;
      if (this.recallPulseN++ % 2 === 0) {
        this.ring(this.recallPos, this.recallUp, RECALL_COL_R * 0.7, this.recallColor, 0.5, 1.5, 0.55 * heat);
      } else {
        this.disk(this.recallPos, this.recallUp, RECALL_COL_R * 0.95, this.recallColor, 0.5, 1.2, 0.26 * heat);
      }
    }
  }

  // ------------------------------------------------------------ beams

  beam(a: THREE.Vector3, b: THREE.Vector3, color: number, width = 0.35, life = 0.14, alpha = 0.9): void {
    const fx = this.beams[this.beamIdx];
    this.beamIdx = (this.beamIdx + 1) % this.beams.length;
    _v.copy(b).sub(a);
    const len = _v.length();
    if (len < 0.001) return;
    _v.multiplyScalar(1 / len);
    fx.mesh.position.copy(a).addScaledVector(_v, len * 0.5);
    fx.mesh.quaternion.setFromUnitVectors(_Y, _v);
    fx.mesh.scale.set(width, len, width);
    fx.mesh.visible = true;
    fx.mat.color.setHex(color);
    fx.mat.opacity = alpha;
    fx.life = life;
    fx.max = life;
    fx.a0 = alpha;
  }

  tracer(a: THREE.Vector3, b: THREE.Vector3, color: number, width = 0.14): void {
    this.beam(a, b, color, width, 0.09, 0.75);
  }

  // ------------------------------------------------------------ vortex / flying bodies

  /**
   * Opens a black hole at `centre` for `dur` seconds: a dark core, accretion rings spiralling in,
   * and debris dragged toward the middle. Purely visual — damage is the caller's business.
   */
  vortex(centre: THREE.Vector3, up: THREE.Vector3, radius: number, color: number, dur: number): void {
    const fx = this.vortices[this.vortexIdx];
    this.vortexIdx = (this.vortexIdx + 1) % this.vortices.length;
    fx.pos.copy(centre);
    fx.up.copy(up).normalize();
    fx.radius = radius;
    fx.life = dur;
    fx.max = dur;
    fx.color = color;
    fx.spin = 0;
    fx.group.visible = true;
    fx.group.position.copy(centre).addScaledVector(fx.up, 0.1);
    fx.group.quaternion.setFromUnitVectors(_Y, fx.up);
    fx.core.scale.setScalar(radius * 0.42);
    (fx.coreMat as THREE.MeshBasicMaterial).color.setHex(0x06030d);
    (fx.coreMat as THREE.MeshBasicMaterial).opacity = 0.92;
    for (const r of fx.rings) r.mat.color.setHex(color);
  }

  /**
   * Flies a body from `from` to `to` over `dur` seconds. `arc` bows the path outward along
   * `up` (0 = straight line). Trailing particles make the flight readable from any angle.
   */
  orb(
    from: THREE.Vector3,
    to: THREE.Vector3,
    radius: number,
    color: number,
    dur: number,
    opts: { arc?: number; up?: THREE.Vector3; trail?: number } = {}
  ): void {
    const fx = this.orbs[this.orbIdx];
    this.orbIdx = (this.orbIdx + 1) % this.orbs.length;
    fx.from.copy(from);
    fx.to.copy(to);
    fx.up.copy(opts.up ?? _Y).normalize();
    fx.radius = radius;
    fx.arc = opts.arc ?? 0;
    fx.t = 0;
    fx.dur = Math.max(0.05, dur);
    fx.color = color;
    fx.trailT = 0;
    fx.trailSize = opts.trail ?? radius * 0.5;
    (fx.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    fx.glowMat.color.setHex(color);
    fx.mesh.scale.setScalar(radius);
    fx.glow.scale.setScalar(radius);
    fx.mesh.visible = true;
    fx.glow.visible = true;
    fx.mesh.position.copy(from);
    fx.glow.position.copy(from);
  }

  /** Dash impulse: shock ring, backward speed lines and a burst of sparks. */
  dashBurst(pos: THREE.Vector3, up: THREE.Vector3, dir: THREE.Vector3, color: number): void {
    this.ring(pos, up, 1.0, color, 0.3, 2.1, 0.75);
    this.burst(pos, color, { count: 20, speed: 11, life: 0.32, size: 0.5, gravity: 0, drag: 3.4 });
    _v2.copy(dir).cross(up).normalize();
    for (let i = 0; i < 5; i++) {
      const off = (i - 2) * 0.55;
      _v.copy(pos).addScaledVector(_v2, off).addScaledVector(up, 0.4 + Math.random() * 0.9);
      const a = _v.clone();
      const b = _v.clone().addScaledVector(dir, -3.4 - Math.random() * 1.8);
      this.beam(b, a, color, 0.085, 0.17, 0.7);
    }
  }

  /**
   * Erupts a field of shards out of the ground at `pos` — ice for Absolute Zero, spines for anything
   * else that wants a broken landscape. `height` is the tallest spike; the ring tapers outward so it
   * reads as a mountain rather than a fence. Purely visual, damage is the caller's business.
   */
  eruption(pos: THREE.Vector3, up: THREE.Vector3, radius: number, color: number, dur: number, height = 3): void {
    const fx = this.eruptions[this.eruptionIdx];
    this.eruptionIdx = (this.eruptionIdx + 1) % this.eruptions.length;
    fx.up.copy(up).normalize();
    fx.life = dur;
    fx.max = dur;
    fx.group.visible = true;
    fx.group.position.copy(pos);
    fx.group.quaternion.setFromUnitVectors(_Y, fx.up);

    // 1 crown spike, then rings of shards that get shorter and wider as they spread
    for (let i = 0; i < fx.shards.length; i++) {
      const s = fx.shards[i];
      let ang = Math.random() * Math.PI * 2;
      let dist = 0;
      let h = height;
      let wide = radius * 0.2;
      let tilt = 0;
      if (i === 0) {
        h = height * 1.35;
        wide = radius * 0.27;
        tilt = (Math.random() - 0.5) * 0.1;
      } else {
        const ring = i <= 4 ? 1 : i <= 10 ? 2 : 3;
        const idxInRing = ring === 1 ? i - 1 : ring === 2 ? i - 5 : i - 11;
        const perRing = ring === 1 ? 4 : ring === 2 ? 6 : 4;
        ang = (idxInRing / perRing) * Math.PI * 2 + ring * 0.7;
        dist = radius * (ring === 1 ? 0.32 : ring === 2 ? 0.58 : 0.85) * (0.88 + Math.random() * 0.24);
        h = height * (ring === 1 ? 0.78 : ring === 2 ? 0.5 : 0.3) * (0.7 + Math.random() * 0.6);
        wide = radius * (ring === 1 ? 0.17 : ring === 2 ? 0.14 : 0.11);
        tilt = 0.18 + ring * 0.16;
      }
      _v.set(Math.cos(ang) * dist, 0, Math.sin(ang) * dist);
      s.mesh.position.copy(_v);
      // lean the outer shards outward from the middle so the cluster fans open
      if (dist > 0.001) {
        _v.multiplyScalar(1 / dist);
        s.mesh.quaternion.setFromUnitVectors(_Y, _v2.copy(_Y).addScaledVector(_v, tilt).normalize());
      } else {
        s.mesh.quaternion.setFromUnitVectors(_Y, _v2.set(0, 1, 0));
      }
      s.mesh.scale.set(wide, 0.01, wide);
      s.height = h;
      s.phase = Math.random() * 0.5;
      s.mat.color.setHex(color);
      s.mat.opacity = 0.8;
      s.mesh.visible = true;
    }
  }

  /**
   * Erupts a stone tower at `pos` for `dur` seconds: it bursts out of the ground, stands while the
   * fortress holds, then sinks back. Purely visual — damage and blocking are the caller's business.
   */
  pillar(pos: THREE.Vector3, up: THREE.Vector3, radius: number, height: number, dur: number, color: number): void {
    const fx = this.pillars[this.pillarIdx];
    this.pillarIdx = (this.pillarIdx + 1) % this.pillars.length;
    fx.radius = radius;
    fx.height = height;
    fx.life = dur;
    fx.max = dur;
    fx.group.visible = true;
    fx.group.position.copy(pos);
    fx.group.quaternion.setFromUnitVectors(_Y, up.clone().normalize());
    fx.drum.scale.set(radius, 0.01, radius);
    fx.crown.scale.setScalar(radius * 0.62);
    fx.crown.position.y = 0.1;
    fx.collar.scale.setScalar(radius * 1.5);
    fx.collar.position.y = 0.07;
    fx.crownMat.color.setHex(color);
    fx.collarMat.color.setHex(color);
  }

  /**
   * Fires an expanding ground shockwave out to exactly `radius` — never past it. `rings` flat pulses
   * cascade out of the centre (pooled ground rings, so they match every other ground circle in the
   * game) while a front of debris is thrown off the edge of the wave as it passes, which is what
   * makes it read as a WAVE travelling across the ground rather than a circle fading in.
   */
  wave(
    pos: THREE.Vector3,
    up: THREE.Vector3,
    radius: number,
    color: number,
    opts: { dur?: number; rings?: number; debris?: number; alpha?: number } = {}
  ): void {
    const fx = this.waves[this.waveIdx];
    this.waveIdx = (this.waveIdx + 1) % this.waves.length;
    fx.pos.copy(pos);
    fx.up.copy(up).normalize();
    fx.radius = Math.max(0.5, radius);
    fx.color = color;
    fx.dur = Math.max(0.16, opts.dur ?? 0.62);
    fx.alpha = opts.alpha ?? 0.85;
    fx.rings = Math.max(1, Math.round(opts.rings ?? 3));
    fx.rate = opts.debris ?? 34;
    fx.fired = 0;
    fx.acc = 0;
    fx.t = 0;
    fx.spin = Math.random() * Math.PI * 2;
    // The environment reacts to genuine explosions only (small waves are cosmetic sparks).
    if (this.onWave && fx.radius >= 2.2) this.onWave(pos, up, fx.radius);
  }

  /**
   * THE STAR: a spiky 3-D star that hangs over the ground, IMPLODES for the first ~45% of `dur`
   * (shrinking and spinning faster while its heart brightens), then blows back out — firing a
   * shockwave and two shells of debris at the instant it goes off — and fades as it expands.
   *
   * The caller should land the damage on the burst rather than on the cast: see Supernova, which
   * schedules its AoE for `dur * 0.45`.
   */
  supernovaStar(pos: THREE.Vector3, up: THREE.Vector3, radius: number, color: number, dur: number): void {
    const fx = this.stars[this.starIdx];
    this.starIdx = (this.starIdx + 1) % this.stars.length;
    fx.radius = Math.max(0.6, radius);
    fx.color = color;
    fx.max = Math.max(0.3, dur);
    fx.life = fx.max;
    fx.fired = false;
    fx.up.copy(up).normalize();
    fx.group.visible = true;
    fx.group.position.copy(pos).addScaledVector(fx.up, fx.radius * 0.38);
    fx.group.quaternion.setFromUnitVectors(_Y, fx.up);
    fx.group.rotation.y = 0;
    fx.starMat.color.setHex(color);
    fx.coreMat.color.setHex(0xffd9a0);
    fx.starMat.opacity = 0.8;
    fx.coreMat.opacity = 0.35;
  }

  /**
   * Raises a hexagonal energy curtain around a patch of ground for `dur` seconds — the wall that
   * turns Fortress Protocol's claimed ground into a strongpoint. It thrusts up, turns, pulses while
   * it holds, then retracts. Purely visual.
   */
  dome(pos: THREE.Vector3, up: THREE.Vector3, radius: number, color: number, dur: number, opts: { height?: number } = {}): void {
    const fx = this.domes[this.domeIdx];
    this.domeIdx = (this.domeIdx + 1) % this.domes.length;
    // The curtain is a HEXAGON, and a hexagon scaled to `radius` has its flat sides at only 0.866 of
    // that — so the wall cut INSIDE the area it was supposed to enclose and the claimed ground
    // spilled out past its own edge. Scaling by the reciprocal puts the flat sides exactly on the
    // radius and lets the six corners stand a little proud of it: the field is inside its walls.
    const wallR = radius / HEX_APOTHEM;
    fx.radius = wallR;
    fx.height = opts.height ?? Math.max(1.6, radius * 0.5);
    fx.life = dur;
    fx.max = dur;
    fx.group.visible = true;
    fx.group.position.copy(pos);
    fx.group.quaternion.setFromUnitVectors(_Y, up.clone().normalize());
    fx.wall.scale.set(wallR, 0.01, wallR);
    fx.collar.scale.setScalar(wallR);
    fx.collar.position.y = 0.05;
    fx.wallMat.color.setHex(color);
    fx.collarMat.color.setHex(color);
  }

  /**
   * Fires a lightning bolt from `a` to `b`: a jittered polyline with random offshoots, flashed for
   * `life` seconds. This is what the Volt kit uses instead of a straight beam — a beam reads as an
   * energy lance, a bolt reads as electricity.
   */
  bolt(
    a: THREE.Vector3,
    b: THREE.Vector3,
    color: number,
    opts: { width?: number; life?: number; jitter?: number; segments?: number; branches?: number } = {}
  ): void {
    const fx = this.bolts[this.boltIdx];
    this.boltIdx = (this.boltIdx + 1) % this.bolts.length;
    _v.copy(b).sub(a);
    const len = _v.length();
    if (len < 0.05) return;
    _v.multiplyScalar(1 / len);
    // two perpendicular axes to throw the zigzag along
    _v2.set(0, 1, 0);
    if (Math.abs(_v.dot(_v2)) > 0.94) _v2.set(1, 0, 0);
    _v2.crossVectors(_v, _v2).normalize();
    _v3.crossVectors(_v, _v2).normalize();

    const segs = Math.round(clamp(opts.segments ?? 9, 3, 14));
    const jit = (opts.jitter ?? 0.18) * len;
    const width = opts.width ?? 0.45;
    const life = opts.life ?? 0.25;
    fx.life = life;
    fx.max = life;
    fx.coreMat.color.setHex(color).lerp(_whiteColor, 0.62);
    fx.glowMat.color.setHex(color);

    // the path: straight line plus a belly-shaped random offset, so the tips stay welded to a and b
    const pts = _boltPts;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const bulge = Math.sin(Math.PI * t);
      pts[i]
        .copy(a)
        .addScaledVector(_v, len * t)
        .addScaledVector(_v2, (Math.random() * 2 - 1) * jit * bulge)
        .addScaledVector(_v3, (Math.random() * 2 - 1) * jit * bulge);
    }
    let slot = 0;
    const place = (from: THREE.Vector3, to: THREE.Vector3, w: number): void => {
      if (slot >= fx.segs.length) return;
      const s = fx.segs[slot++];
      _v4.copy(to).sub(from);
      const l = _v4.length();
      if (l < 0.01) {
        s.core.visible = false;
        s.glow.visible = false;
        return;
      }
      _v4.multiplyScalar(1 / l);
      s.core.visible = true;
      s.glow.visible = true;
      s.core.position.copy(from);
      s.glow.position.copy(from);
      s.core.quaternion.setFromUnitVectors(_Y, _v4);
      s.glow.quaternion.copy(s.core.quaternion);
      s.core.scale.set(w * 0.42, l, w * 0.42);
      s.glow.scale.set(w, l, w);
    };
    for (let i = 0; i < segs; i++) {
      // thicker toward the middle of the arc, thin at both ends
      place(pts[i], pts[i + 1], width * (0.5 + 0.8 * Math.sin((Math.PI * (i + 0.5)) / segs)));
    }
    // offshoots: what makes it read as a discharge and not a rod
    const branches = Math.round(clamp(opts.branches ?? 2, 0, 5));
    for (let k = 0; k < branches; k++) {
      const i = 1 + Math.floor(Math.random() * Math.max(1, segs - 2));
      const from = pts[Math.min(i, segs - 1)];
      _v4.copy(pts[Math.min(i + 1, segs)]).sub(from);
      const dl = Math.max(0.05, _v4.length());
      _v4.multiplyScalar(1 / dl);
      _v2.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      _v3.copy(_v4).addScaledVector(_v2, 0.9).normalize();
      const bl = dl * (1.5 + Math.random() * 2.4);
      _boltB1.copy(from);
      _boltB2.copy(from).addScaledVector(_v3, bl * 0.5).addScaledVector(_v2, bl * 0.28);
      _boltB3.copy(from).addScaledVector(_v3, bl);
      place(_boltB1, _boltB2, width * 0.55);
      place(_boltB2, _boltB3, width * 0.34);
    }
    for (let i = slot; i < fx.segs.length; i++) {
      fx.segs[i].core.visible = false;
      fx.segs[i].glow.visible = false;
    }
  }

  /**
   * Swings a blade across `arc` radians around `dir`, from one edge to the other over `dur` seconds.
   * `spin` = +1 sweeps right-to-left, −1 sweeps left-to-right; `steps` sets how many blade strokes are
   * laid down along the way (each with a short comet tail). Currently uncalled (see SweepFX).
   */
  sweep(
    pos: THREE.Vector3,
    up: THREE.Vector3,
    dir: THREE.Vector3,
    range: number,
    arc: number,
    color: number,
    opts: {
      dur?: number; spin?: number; steps?: number; width?: number; tail?: number;
      /** Repeat the arc this many times without a gap — a sustained whirl. */
      repeat?: number;
      /** Blade arms per rotation (2 = two whips opposite each other). */
      arms?: number;
      /** Radians of bend along each stroke, so the lash curves instead of shooting straight out. */
      curve?: number;
      /** Ride a live position/up every frame instead of a frozen point (the whirl follows its owner). */
      live?: { pos: THREE.Vector3; up: THREE.Vector3 };
    } = {}
  ): void {
    const fx = this.sweeps[this.sweepIdx];
    this.sweepIdx = (this.sweepIdx + 1) % this.sweeps.length;
    fx.pos.copy(pos);
    fx.up.copy(up).normalize();
    fx.dir.copy(dir).normalize();
    fx.range = range;
    fx.arc = arc;
    fx.color = color;
    fx.dur = Math.max(0.06, opts.dur ?? 0.25);
    fx.t = 0;
    fx.spin = opts.spin ?? 1;
    fx.steps = Math.max(2, Math.round(opts.steps ?? 9));
    fx.emitted = 0;
    fx.width = opts.width ?? 0.3;
    fx.tail = opts.tail ?? 2;
    fx.repeat = Math.max(1, Math.round(opts.repeat ?? 1));
    fx.arms = Math.max(1, Math.round(opts.arms ?? 1));
    fx.curve = opts.curve ?? 0;
    fx.livePos = opts.live ? opts.live.pos : null;
    fx.liveUp = opts.live ? opts.live.up : null;
  }

  /**
   * The planet that ground effects are projected on to. Re-set every match — the planet is rebuilt
   * each time, so a stale reference would lay shapes out along the last one's hills.
   */
  setPlanet(planet: Planet | null): void {
    this.planet = planet;
  }

  /**
   * A crescent slash across `arc` radians of `dir`: a bright leading edge fading back along the swing.
   * This is the whip's auto-attack — deliberately a single flat arc of light, NOT the Scythe's chain
   * lash or the Spinner's whirl, so the moves never read as the same thing.
   */
  slashArc(
    pos: THREE.Vector3,
    up: THREE.Vector3,
    dir: THREE.Vector3,
    range: number,
    arc: number,
    color: number,
    opts: { dur?: number; spin?: number; inner?: number; lift?: number } = {}
  ): void {
    const fx = this.slashes[this.slashIdx];
    this.slashIdx = (this.slashIdx + 1) % this.slashes.length;
    const upN = _swA.copy(up).normalize();
    const dirN = _swB.copy(dir).normalize();
    const spin = opts.spin ?? 1;
    const inner = opts.inner ?? 0.58;
    // `lift` is the height the cut passes at ABOVE THE GROUND, not a fixed offset from the caster.
    // The crescent used to be planar — laid in the plane through the caster square to `up` — which
    // works on a flat plain and nowhere else: NecroFall's terrain swings ±30 m, so over one auto
    // attack range (20-30 m) the first hill simply swallows the blade and the swing reads as
    // nothing. Every vertex is projected on to the terrain at this height instead, so the arc runs
    // along the ground the strike actually crosses. The whip rides it at chest height (1.15 m) — a
    // ground-hugging ribbon was invisible in any grass or on any bump.
    const lift = Math.max(0.14, opts.lift ?? 0);
    const planet = this.planet;
    const ox = pos.x;
    const oy = pos.y;
    const oz = pos.z;
    const steps = SLASH_STEPS;
    const bright = _slashBright.setHex(color).lerp(_whiteColor, 0.35);
    const body = _slashBody.setHex(color);
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      // the leading edge is at t = 0, so the arc fades away behind the swing
      const ang = spin * (0.5 - t) * arc;
      _swD.copy(dirN).applyAxisAngle(upN, ang).normalize();
      // OPAQUE head -> TRANSPARENT tail (user ask 2026-09-30): the leading 15% of the swing holds
      // at full strength and the rest runs out faster than before, so the ribbon reads as a SLASH
      // instead of a soft wash of light.
      const fade = t < 0.15 ? 1 : Math.pow((1 - t) / 0.85, 1.5);
      const rIn = range * inner;
      const rOut = range * (inner + (1 - inner) * (0.55 + 0.45 * fade));
      const p = i * 6;
      // inner edge — walked out along the swing, then pinned to the surface
      _swE.set(ox + _swD.x * rIn, oy + _swD.y * rIn, oz + _swD.z * rIn);
      place(_swE, planet, lift);
      fx.pos[p] = _swE.x;
      fx.pos[p + 1] = _swE.y;
      fx.pos[p + 2] = _swE.z;
      // outer edge
      _swE.set(ox + _swD.x * rOut, oy + _swD.y * rOut, oz + _swD.z * rOut);
      place(_swE, planet, lift);
      fx.pos[p + 3] = _swE.x;
      fx.pos[p + 4] = _swE.y;
      fx.pos[p + 5] = _swE.z;
      // inner edge = near-solid ink, outer edge = a third of it; both run out toward the tail
      fx.col[p] = bright.r * fade;
      fx.col[p + 1] = bright.g * fade;
      fx.col[p + 2] = bright.b * fade;
      fx.col[p + 3] = body.r * fade * 0.35;
      fx.col[p + 4] = body.g * fade * 0.35;
      fx.col[p + 5] = body.b * fade * 0.35;
    }
    const gpos = fx.mesh.geometry.attributes.position as THREE.BufferAttribute;
    const gcol = fx.mesh.geometry.attributes.color as THREE.BufferAttribute;
    (gpos.array as Float32Array).set(fx.pos);
    (gcol.array as Float32Array).set(fx.col);
    gpos.needsUpdate = true;
    gcol.needsUpdate = true;
    fx.mat.opacity = 1;
    fx.mat.color.setHex(0xffffff);
    fx.mesh.position.set(0, 0, 0);
    fx.mesh.visible = true;
    fx.life = Math.max(0.06, opts.dur ?? 0.2);
    fx.max = fx.life;
    // a flare at the leading tip sells the crack — at the blade's own height, so it reads as the tip
    // of the cut rather than as sparks lying on the floor
    _swD.copy(dirN).applyAxisAngle(upN, spin * arc * 0.5).normalize();
    _swB.set(ox, oy, oz).addScaledVector(_swD, range * 0.92);
    place(_swB, planet, lift);
    this.burst(_swB, color, { count: 6, speed: 7, life: 0.22, size: 0.5, gravity: 0 });
  }

  /**
   * One whip arm at `angle`, drawn as a short CURVED lash: the chain bends as it travels out, so it
   * reads as a whip rather than a spoke.
   */  private sweepArm(fx: SweepFX, angle: number): void {
    const origin = fx.livePos ?? fx.pos;
    const axis = fx.liveUp ?? fx.up;
    const segs = fx.curve !== 0 ? 3 : 1;
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      const bend0 = fx.curve * (t0 - 0.5) * fx.spin;
      const bend1 = fx.curve * (t1 - 0.5) * fx.spin;
      _swD.copy(fx.dir).applyAxisAngle(axis, angle + bend0).normalize();
      _swA.copy(origin).addScaledVector(axis, 1.15).addScaledVector(_swD, fx.range * t0);
      _swD.copy(fx.dir).applyAxisAngle(axis, angle + bend1).normalize();
      _swB.copy(origin).addScaledVector(axis, 1.15).addScaledVector(_swD, fx.range * t1);
      const w = fx.width * (1 - t0 * 0.5);
      this.beam(_swA, _swB, fx.color, w, 0.13, 0.95 - t0 * 0.35);
    }
  }

  /**
   * The SCYTHE ARC: ONE chain lash — the same curved blade the Spinner whirls — cut across `arc`
   * radians of `dir` in a single pass. `spin: −1` (the default) runs it the OPPOSITE way round from
   * the Spinner's whirl, so the two moves read as mirror images: one sustained spin, one hard cut.
   * The blade is a real tube laid along the model's arm profile, so `range` stretches its reach
   * outward without ever lifting it off the player's body height.
   */
  lashSweep(
    pos: THREE.Vector3,
    up: THREE.Vector3,
    dir: THREE.Vector3,
    range: number,
    arc: number,
    color: number,
    opts: { dur?: number; spin?: number; lag?: number; width?: number } = {}
  ): void {
    const fx = this.lashes[this.lashIdx];
    this.lashIdx = (this.lashIdx + 1) % this.lashes.length;
    fx.origin.copy(pos);
    fx.up.copy(up).normalize();
    fx.dir.copy(dir).normalize();
    fx.range = range;
    // as thick as the whirl's own arm at the same reach, so it is visibly the same chain
    fx.width = opts.width ?? 0.055 * clamp(range / 3.2, 0.6, 3);
    // ang0 -> ang1: the Spinner drives its arms to a DECREASING angle about `up`, so spin −1
    // (the Scythe's default) cuts from the left edge of the arc through to the right one
    const spin = opts.spin ?? -1;
    fx.ang0 = spin * arc * 0.5;
    fx.ang1 = -spin * arc * 0.5;
    fx.dirSign = fx.ang1 > fx.ang0 ? 1 : -1;
    fx.lag = opts.lag ?? 0.4;
    fx.life = Math.max(0.08, opts.dur ?? 0.34);
    fx.max = fx.life;
    fx.body.setHex(color);
    fx.bright.setHex(color).lerp(_whiteColor, 0.5);
    // colours hold for the whole cut: dim at the handle, white-hot out at the point of the blade
    for (let i = 0; i <= LASH_SEGS; i++) {
      const t = i / LASH_SEGS;
      const k = 0.3 + 0.7 * t;
      const r = fx.body.r + (fx.bright.r - fx.body.r) * t;
      const g = fx.body.g + (fx.bright.g - fx.body.g) * t;
      const b = fx.body.b + (fx.bright.b - fx.body.b) * t;
      for (let v = 0; v < LASH_RING; v++) {
        const o = (i * LASH_RING + v) * 3;
        fx.col[o] = r * k;
        fx.col[o + 1] = g * k;
        fx.col[o + 2] = b * k;
      }
    }
    (fx.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    fx.mat.opacity = 0;
    fx.mesh.visible = true;
    this.writeLash(fx, fx.ang0, range * 0.6);
  }

  /** Lays the lash tube along the arm profile at `head` radians off `dir`, out to `reach` metres. */
  private writeLash(fx: LashFX, head: number, reach: number): void {
    // 1) the guide curve: the whirl's own arm, stretched radially, its height untouched
    for (let i = 0; i <= LASH_SEGS; i++) {
      const t = i / LASH_SEGS;
      _lashT.copy(fx.dir).applyAxisAngle(fx.up, head - fx.dirSign * fx.lag * t).normalize();
      _lashCtr[i].copy(fx.origin)
        .addScaledVector(_lashT, LASH_PROFILE[i * 2] * reach)
        .addScaledVector(fx.up, LASH_PROFILE[i * 2 + 1]);
    }
    // 2) a tube around it, so the chain has real thickness from every camera angle
    const arr = fx.pos;
    for (let i = 0; i <= LASH_SEGS; i++) {
      const c = _lashCtr[i];
      _lashT.copy(_lashCtr[Math.min(i + 1, LASH_SEGS)]).sub(_lashCtr[Math.max(i - 1, 0)]);
      if (_lashT.lengthSq() < 1e-8) _lashT.copy(fx.up).cross(fx.dir);
      _lashT.normalize();
      _lashN1.crossVectors(_lashT, fx.up);
      // the segment runs straight up: any perpendicular will do, it only sets the seam
      if (_lashN1.lengthSq() < 1e-6) _lashN1.set(0, 0, 1);
      _lashN1.normalize();
      _lashN2.crossVectors(_lashT, _lashN1);
      for (let k = 0; k < LASH_RING; k++) {
        const a = (k / LASH_RING) * Math.PI * 2;
        const ca = Math.cos(a) * fx.width;
        const sa = Math.sin(a) * fx.width;
        const o = (i * LASH_RING + k) * 3;
        arr[o] = c.x + _lashN1.x * ca + _lashN2.x * sa;
        arr[o + 1] = c.y + _lashN1.y * ca + _lashN2.y * sa;
        arr[o + 2] = c.z + _lashN1.z * ca + _lashN2.z * sa;
      }
    }
    (fx.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Walks each live lash across its arc, throwing sparks off the point of the blade. */
  private updateLashes(dt: number): void {
    for (const fx of this.lashes) {
      if (fx.life <= 0) continue;
      fx.life -= dt;
      const p = clamp(1 - fx.life / fx.max, 0, 1);
      if (fx.life <= 0) {
        fx.mesh.visible = false;
        continue;
      }
      // out fast and easing off through the far end — a cut, not a metronome
      const eased = Math.pow(p, 0.7);
      // it whips open over the first frames, then holds the full reach for the rest of the swing
      const reach = fx.range * (0.62 + 0.38 * Math.min(1, p / 0.16));
      this.writeLash(fx, fx.ang0 + (fx.ang1 - fx.ang0) * eased, reach);
      fx.mat.opacity = Math.min(1, p / 0.1) * Math.min(1, (1 - p) / 0.4) * 0.95;
      if (Math.random() < dt * 50) {
        const tip = _lashCtr[LASH_SEGS];
        this.spawnParticle(
          tip.x, tip.y, tip.z, 0, 0, 0, 0.3, fx.width * 1.6,
          fx.bright.r, fx.bright.g, fx.bright.b, 0, 1.5
        );
      }
    }
  }

  /** Advances every live sweep, emitting blades as the edge crosses each step of the arc. */
  private updateSweeps(dt: number): void {
    for (const fx of this.sweeps) {
      if (fx.t >= fx.dur && fx.repeat <= 0) continue;
      fx.t += dt;
      // a sustained whirl restarts seamlessly, so the chain never stops moving
      while (fx.t >= fx.dur && fx.repeat > 0) {
        fx.t -= fx.dur;
        fx.emitted = 0;
        if (fx.liveUp && fx.livePos) fx.up.copy(fx.liveUp);
        fx.repeat--;
      }
      if (fx.t >= fx.dur) continue;
      const p = clamp(fx.t / fx.dur, 0, 1);
      const want = Math.min(fx.steps, Math.ceil(p * fx.steps));
      while (fx.emitted < want) {
        const q = fx.emitted / (fx.steps - 1);
        // right-to-left by default: start at +arc/2 and finish at −arc/2
        const angle = fx.spin * (0.5 - q) * fx.arc;
        for (let arm = 0; arm < fx.arms; arm++) {
          this.sweepArm(fx, angle + (arm * Math.PI * 2) / fx.arms);
        }
        if (fx.emitted % 2 === 0) {
          _swA.copy(fx.livePos ?? fx.pos).addScaledVector(fx.liveUp ?? fx.up, 1.15).addScaledVector(
            _swB.copy(fx.dir).applyAxisAngle(fx.liveUp ?? fx.up, angle).normalize(), fx.range * 0.85
          );
          this.burst(_swA, 0xffffff, { count: 3, speed: 6, life: 0.25, size: fx.width * 1.1, gravity: 0 });
        }
        fx.emitted++;
      }
    }
  }

  /**
   * Slams a cage of BLACK CHAINS out of the ground around `centre`: `count` strands standing on a ring
   * of `radius`, each leaning outward a little, rising in sequence and sinking back into the
   * ground at the end of their life. Used by Judgement.
   */
  chains(
    centre: THREE.Vector3,
    up: THREE.Vector3,
    radius: number,
    opts: { dur?: number; height?: number; count?: number; layout?: 'ring' | 'spikes' } = {}
  ): void {
    const fx = this.chainCages[this.chainIdx];
    this.chainIdx = (this.chainIdx + 1) % this.chainCages.length;
    fx.pos.copy(centre);
    fx.up.copy(up).normalize();
    fx.radius = radius;
    fx.height = opts.height ?? 6.5;
    fx.count = Math.max(3, Math.min(CHAIN_STRANDS, Math.round(opts.count ?? 12)));
    fx.dur = Math.max(0.4, opts.dur ?? 3);
    fx.t = 0;
    fx.active = true;
    fx.mat.opacity = 1;
    fx.tipMat.opacity = 1;
    fx.inst.visible = true;
    fx.tipInst.visible = true;
    fx.inst.count = fx.count * CHAIN_LINKS;
    fx.tipInst.count = fx.count;
    // a tangent basis; every strand's local +X points outward, its local +Y along the surface normal
    _swA.set(1, 0, 0).sub(_swB.copy(fx.up).multiplyScalar(fx.up.x));
    if (_swA.lengthSq() < 1e-4) _swA.set(0, 0, 1).sub(_swB.copy(fx.up).multiplyScalar(fx.up.z));
    _swA.normalize();
    _swB.copy(fx.up).cross(_swA).normalize();
    const spikes = opts.layout === 'spikes';
    for (let i = 0; i < fx.count; i++) {
      let a = (i / fx.count) * Math.PI * 2;
      let dist = fx.radius * 0.86;
      let span = 1;
      let tilt = 0.03;
      if (spikes) {
        // the cross-spike eruption: 1 crown, then three rings that stand shorter and lean further
        // out the wider they spread, so the cluster fans open instead of forming a fence
        const ring = i === 0 ? 0 : i <= 4 ? 1 : i <= 10 ? 2 : 3;
        const idxInRing = ring === 1 ? i - 1 : ring === 2 ? i - 5 : i - 11;
        const perRing = ring === 1 ? 4 : ring === 2 ? 6 : 4;
        a = (idxInRing / perRing) * Math.PI * 2 + ring * 0.7;
        dist = ring === 0 ? 0 : fx.radius * (ring === 1 ? 0.32 : ring === 2 ? 0.58 : 0.85) * (0.88 + Math.random() * 0.24);
        span = ring === 0 ? 1.35 : ring === 1 ? 0.78 : ring === 2 ? 0.5 : 0.3;
        if (ring > 0) span *= 0.7 + Math.random() * 0.6;
        tilt = ring === 0 ? 0 : 0.18 + ring * 0.16;
      }
      const dir = fx.dirs[i];
      dir.copy(_swA).multiplyScalar(Math.cos(a)).addScaledVector(_swB, Math.sin(a));
      fx.dists[i] = dist;
      fx.spans[i] = span;
      _m4.makeBasis(_swC.copy(dir), fx.up, _swD.copy(dir).cross(fx.up).normalize());
      fx.quats[i].setFromRotationMatrix(_m4);
      fx.quats[i].multiply(_q2.setFromAxisAngle(_axisZ, tilt));
    }
    this.updateChains(0);
  }

  /** Grows, holds and sinks each live chain eruption. */
  private updateChains(dt: number): void {
    for (const fx of this.chainCages) {
      if (!fx.active) continue;
      fx.t += dt;
      if (fx.t >= fx.dur) {
        fx.active = false;
        fx.inst.visible = false;
        fx.tipInst.visible = false;
        continue;
      }
      const outro = Math.min(1, (fx.dur - fx.t) / 0.55);
      fx.mat.opacity = Math.min(1, outro * 1.6);
      fx.tipMat.opacity = Math.min(1, outro * 1.6);
      for (let i = 0; i < fx.count; i++) {
        // cascading eruption: every strand bursts out a beat after the one before it
        const grow = clamp((fx.t - i * 0.04) / 0.24, 0, 1);
        const rise = grow * grow * (3 - 2 * grow);
        const strandH = fx.height * fx.spans[i];
        const sink = (1 - rise + (1 - outro) * rise) * strandH;
        _swA.copy(fx.pos).addScaledVector(fx.dirs[i], fx.dists[i]);
        _swA.addScaledVector(fx.up, -0.3 - sink);
        const scale = strandH / CHAIN_SPAN;
        _scaleV.set(scale, scale, scale);
        _m4.compose(_swA, fx.quats[i], _scaleV);
        for (let l = 0; l < CHAIN_LINKS; l++) {
          _m4b.multiplyMatrices(_m4, CHAIN_LINK_MATS[l]);
          fx.inst.setMatrixAt(i * CHAIN_LINKS + l, _m4b);
        }
        // the point rides the top of the strand on the same matrix
        fx.tipInst.setMatrixAt(i, _m4);
      }
      fx.inst.instanceMatrix.needsUpdate = true;
      fx.tipInst.instanceMatrix.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------ damage numbers

  damageNumber(pos: THREE.Vector3, text: string, color: number, scale = 1): void {
    if (this.dmgNums.length === 0) return;
    const dn = this.dmgNums[this.dmgIdx];
    this.dmgIdx = (this.dmgIdx + 1) % this.dmgNums.length;
    const ctx = dn.canvas.getContext('2d');
    if (!ctx) return;
    const c = _col.setHex(color);
    const css = `#${c.getHexString()}`;
    ctx.clearRect(0, 0, dn.canvas.width, dn.canvas.height);
    ctx.font = '900 46px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, 80, 42);
    ctx.fillStyle = css;
    ctx.fillText(text, 80, 42);
    dn.tex.needsUpdate = true;
    dn.sprite.position.copy(pos);
    dn.sprite.visible = true;
    dn.sprite.scale.set(2.1 * scale, 1.05 * scale, 1);
    dn.mat.opacity = 1;
    dn.life = 0.8;
    dn.max = 0.8;
  }

  // ------------------------------------------------------------ shake

  shake(amount: number): void {
    this.shakeAmt = Math.min(1.6, this.shakeAmt + amount);
  }

  consumeShake(): number {
    return this.shakeAmt;
  }

  // ------------------------------------------------------------ update

  update(dt: number): void {
    // particles
    let i = 0;
    while (i < this.pCount) {
      this.pLife[i] -= dt;
      if (this.pLife[i] <= 0) {
        const last = --this.pCount;
        if (i !== last) {
          const i3 = i * 3, l3 = last * 3;
          this.pPos[i3] = this.pPos[l3]; this.pPos[i3 + 1] = this.pPos[l3 + 1]; this.pPos[i3 + 2] = this.pPos[l3 + 2];
          this.pVel[i3] = this.pVel[l3]; this.pVel[i3 + 1] = this.pVel[l3 + 1]; this.pVel[i3 + 2] = this.pVel[l3 + 2];
          this.pLife[i] = this.pLife[last]; this.pMaxLife[i] = this.pMaxLife[last];
          this.pSize[i] = this.pSize[last];
          this.pCol[i3] = this.pCol[l3]; this.pCol[i3 + 1] = this.pCol[l3 + 1]; this.pCol[i3 + 2] = this.pCol[l3 + 2];
          this.pGrav[i] = this.pGrav[last]; this.pDrag[i] = this.pDrag[last];
        }
        continue;
      }
      const i3 = i * 3;
      const g = this.pGrav[i];
      if (g !== 0) {
        _v.set(this.pPos[i3], this.pPos[i3 + 1], this.pPos[i3 + 2]);
        const len = Math.max(0.001, _v.length());
        _v.multiplyScalar(1 / len);
        // positive gravity pulls TOWARD the surface, negative LIFTS off it — which is what every
        // `gravity: -x` call site (flames, aura motes, rising smoke) always meant to happen
        this.pVel[i3] -= _v.x * g * dt;
        this.pVel[i3 + 1] -= _v.y * g * dt;
        this.pVel[i3 + 2] -= _v.z * g * dt;
      }
      const drag = Math.max(0, 1 - this.pDrag[i] * dt);
      this.pVel[i3] *= drag; this.pVel[i3 + 1] *= drag; this.pVel[i3 + 2] *= drag;
      this.pPos[i3] += this.pVel[i3] * dt;
      this.pPos[i3 + 1] += this.pVel[i3 + 1] * dt;
      this.pPos[i3 + 2] += this.pVel[i3 + 2] * dt;
      this.pAlpha[i] = clamp(this.pLife[i] / this.pMaxLife[i], 0, 1);
      i++;
    }

    const gpos = this.geo.attributes.position as THREE.BufferAttribute;
    const gcol = this.geo.attributes.aColor as THREE.BufferAttribute;
    const gsize = this.geo.attributes.aSize as THREE.BufferAttribute;
    const galpha = this.geo.attributes.aAlpha as THREE.BufferAttribute;
    // Upload only the live prefix: the buffers are sized for the top preset but a low-preset frame
    // holds a few hundred particles, and copying the whole capacity every frame was pure waste.
    const n = this.pCount;
    (gpos.array as Float32Array).set(this.pPos.subarray(0, n * 3));
    (gcol.array as Float32Array).set(this.pCol.subarray(0, n * 3));
    (gsize.array as Float32Array).set(this.pSize.subarray(0, n));
    (galpha.array as Float32Array).set(this.pAlpha.subarray(0, n));
    gpos.needsUpdate = true; gcol.needsUpdate = true; gsize.needsUpdate = true; galpha.needsUpdate = true;
    this.geo.setDrawRange(0, n);

    // rings & disks
    for (const fx of this.rings) {
      if (fx.delay > 0) {
        fx.delay -= dt;
        continue;
      }
      if (fx.life <= 0) {
        if (fx.mesh.visible) fx.mesh.visible = false;
        continue;
      }
      fx.life -= dt;
      const t = clamp(1 - fx.life / fx.max, 0, 1);
      const eased = 1 - Math.pow(1 - t, 2.4);
      const r = lerp(fx.r0, fx.r1, eased);
      fx.mesh.scale.set(r, 1, r);
      fx.mesh.visible = fx.life > 0;
      fx.mat.opacity = fx.a0 * (1 - t);
    }

    // beams
    for (const fx of this.beams) {
      if (fx.life <= 0) continue;
      fx.life -= dt;
      const t = clamp(1 - fx.life / fx.max, 0, 1);
      fx.mat.opacity = fx.a0 * (1 - t);
      if (fx.life <= 0) fx.mesh.visible = false;
    }

    // damage numbers
    for (const dn of this.dmgNums) {
      if (dn.life <= 0) continue;
      dn.life -= dt;
      const t = clamp(1 - dn.life / dn.max, 0, 1);
      _v.copy(dn.sprite.position);
      const len = Math.max(0.001, _v.length());
      _v.multiplyScalar(1 / len);
      dn.sprite.position.addScaledVector(_v, dt * 2.4);
      dn.mat.opacity = 1 - t * t;
      if (dn.life <= 0) dn.sprite.visible = false;
    }

    // slashes: a flat crescent that flashes and fades
    for (const fx of this.slashes) {
      if (fx.life <= 0) continue;
      fx.life -= dt;
      const k = clamp(fx.life / fx.max, 0, 1);
      fx.mat.opacity = k * k * 0.95;
      if (fx.life <= 0) fx.mesh.visible = false;
    }

    // sweeps: the blade walks its arc, laying strokes down as it goes
    this.updateSweeps(dt);
    // lash cuts: the scythe's chain blade walks its own arc
    this.updateLashes(dt);
    // chain cages: rise, hold, sink back into the ground
    this.updateChains(dt);

    // bolts: flash hard and vanish
    for (const fx of this.bolts) {
      if (fx.life <= 0) continue;
      fx.life -= dt;
      const k = clamp(fx.life / fx.max, 0, 1);
      const sharp = k * k;
      fx.glowMat.opacity = 0.8 * sharp;
      fx.coreMat.opacity = sharp;
      if (fx.life <= 0) {
        for (const s of fx.segs) {
          s.core.visible = false;
          s.glow.visible = false;
        }
      }
    }

    // pillars: burst up fast, stand, then sink back into the ground
    for (const fx of this.pillars) {
      if (fx.life <= 0) continue;
      fx.life -= dt;
      const t = clamp(1 - fx.life / fx.max, 0, 1);
      if (fx.life <= 0) {
        fx.group.visible = false;
        continue;
      }
      let grow: number;
      if (t < 0.12) grow = Math.min(1.06, t / 0.12);        // the thrust
      else if (t > 0.88) grow = Math.max(0, 1 - (t - 0.88) / 0.12);  // the retract
      else grow = 1;
      fx.drum.scale.set(fx.radius, Math.max(0.01, fx.height * grow), fx.radius);
      fx.crown.position.y = fx.height * grow + 0.06;
      fx.crown.rotation.y += dt * 1.1;
      fx.crownMat.opacity = 0.55 + 0.3 * Math.sin(t * 22);
      fx.collarMat.opacity = 0.4 + 0.22 * Math.sin(t * 17);
    }

    // bastion domes: the curtain thrusts up, turns, pulses, then retracts into the ground
    for (const fx of this.domes) {
      if (fx.life <= 0) continue;
      fx.life -= dt;
      const t = clamp(1 - fx.life / fx.max, 0, 1);
      if (fx.life <= 0) {
        fx.group.visible = false;
        continue;
      }
      const rise = t < 0.1 ? Math.min(1.05, t / 0.1) : t > 0.86 ? Math.max(0, 1 - (t - 0.86) / 0.14) : 1;
      fx.wall.scale.set(fx.radius, Math.max(0.01, fx.height * rise), fx.radius);
      fx.collar.position.y = fx.height * rise;
      fx.wall.rotation.y += dt * 0.22;
      fx.collar.rotation.y = fx.wall.rotation.y;
      const beat = 0.5 + 0.5 * Math.sin(t * 16);
      fx.wallMat.opacity = (0.12 + 0.1 * beat) * rise;
      fx.collarMat.opacity = (0.34 + 0.24 * beat) * rise;
    }

    // ground shockwaves: the flat pulses come out of the ring pool, the front throws the debris
    for (const fx of this.waves) {
      if (fx.t >= fx.dur) continue;
      fx.t += dt;
      const p = clamp(fx.t / fx.dur, 0, 1);
      const gone = fx.t >= fx.dur;
      // each pulse leaves the centre on its own beat and grows to EXACTLY `radius` by the end
      const gap = (fx.dur * 0.45) / fx.rings;
      while (fx.fired < fx.rings && fx.t >= fx.fired * gap) {
        const i = fx.fired++;
        const base = fx.radius * 0.12;
        const life = Math.max(0.2, fx.dur - i * gap * 0.5);
        this.ring(fx.pos, fx.up, base, i === 0 ? 0xffffff : fx.color, life, fx.radius / base, fx.alpha * (1 - i * 0.2), i * gap * 0.5);
      }
      if (!gone) {
        // debris thrown off the front: a full ring of particles that walks outward with the wave
        const eased = 1 - Math.pow(1 - p, 2.1);
        const r = Math.max(0.05, fx.radius * eased);
        fx.acc += fx.rate * dt;
        const c = _col.setHex(fx.color);
        tangentBasis(fx.up, _v, _v2);
        while (fx.acc >= 1) {
          fx.acc -= 1;
          const a = fx.spin + fx.acc * 2.399 + Math.random() * 0.6;
          _v3.copy(fx.pos)
            .addScaledVector(_v, Math.cos(a) * r)
            .addScaledVector(_v2, Math.sin(a) * r)
            .addScaledVector(fx.up, 0.12 + Math.random() * 0.3);
          _v4.copy(_v3).sub(fx.pos).normalize().multiplyScalar(4 + Math.random() * 4.5);
          this.spawnParticle(
            _v3.x, _v3.y, _v3.z, _v4.x, _v4.y, _v4.z + Math.random() * 2.4,
            0.32 + Math.random() * 0.2, 0.42,
            c.r, c.g, c.b, 2.4, 2.1
          );
        }
      }
    }

    // collapsing stars: implode, fire the burst, blow back out and fade
    for (const fx of this.stars) {
      if (fx.life <= 0) continue;
      fx.life -= dt;
      const t = clamp(1 - fx.life / fx.max, 0, 1);
      const gone = fx.life <= 0;
      const BURST = 0.45;
      if (t < BURST) {
        // IMPLODE: shrink hard, spin up, and let the heart get brighter as the pressure builds
        const k = t / BURST;
        const s = lerp(0.34, 0.1, k * k);
        fx.star.scale.setScalar(fx.radius * s);
        fx.core.scale.setScalar(fx.radius * s * 0.45);
        fx.group.rotation.y += dt * (1.4 + k * 7);
        fx.starMat.opacity = 0.8;
        fx.coreMat.opacity = 0.25 + k * 0.4;
      } else if (!gone) {
        // GO OFF: snap outward, then keep drifting out as the light fades
        const k = clamp((t - BURST) / (1 - BURST), 0, 1);
        const s = 0.1 + Math.pow(k, 0.35) * 1.25;
        fx.star.scale.setScalar(fx.radius * s);
        fx.core.scale.setScalar(fx.radius * s * 0.45);
        fx.group.rotation.y += dt * 2.2;
        fx.starMat.opacity = 0.9 * (1 - k);
        fx.coreMat.opacity = 0.65 * (1 - k);
      }
      if (!fx.fired && t >= BURST) {
        fx.fired = true;
        // THE BURST: a shockwave out to exactly the ability's radius, a white flash ring, and two
        // shells of debris (the star's own matter, plus heavier molten rock thrown off it)
        this.wave(fx.group.position, fx.up, fx.radius, fx.color, { dur: 0.85, rings: 4, debris: 46, alpha: 0.95 });
        this.ring(fx.group.position, fx.up, 1.2, 0xffffff, 0.42, fx.radius * 3.4, 1);
        this.burst(fx.group.position, fx.color, { count: 90, speed: 26, life: 0.95, size: 1.0, gravity: 8 });
        this.burst(fx.group.position, 0xffd27a, {
          count: 44, speed: 15, life: 1.05, size: 0.85, up: fx.up, spread: 0.9, gravity: 11, drag: 1.2,
        });
      }
      if (gone) {
        fx.life = 0;
        fx.group.visible = false;
      }
    }

    // vortexes: rings spiral inward, debris falls toward the horizon
    if (this.vortices.length > 0) this.updateVortices(dt);

    // recall column: heat follows the feeds, transforms and fade-out live here
    this.updateRecallColumn(dt);

    // eruptions: shards thrust up out of the ground, then hold and fade
    for (const fx of this.eruptions) {      if (fx.life <= 0) continue;
      fx.life -= dt;
      const t = clamp(1 - fx.life / fx.max, 0, 1);
      if (fx.life <= 0) {
        fx.group.visible = false;
        continue;
      }
      // the thrust: a hard 22% of the life erupting, with a little overshoot as it settles
      const rise = t < 0.22 ? Math.min(1.06, t / 0.22) : 1 + 0.06 * Math.max(0, 1 - (t - 0.22) * 9);
      const fade = t > 0.62 ? 1 - (t - 0.62) / 0.38 : 1;
      for (const s of fx.shards) {
        const local = clamp((rise - s.phase * 0.12) / (1 - s.phase * 0.12), 0, 1.1);
        s.mesh.scale.set(1, s.height * local, 1);
        s.mat.opacity = (0.34 + 0.5 * (1 - local)) * fade;
      }
    }

    // flying bodies: interpolate, bow the arc, trail sparks
    if (this.orbs.length > 0) this.updateOrbs(dt);

    // shake decay
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 3.2);
    if (this.shakeAmt < 0.005) this.shakeAmt = 0;
  }

  private updateVortices(dt: number): void {
    for (const fx of this.vortices) {
      if (fx.life <= 0) continue;
      fx.life -= dt;
      const t = clamp(1 - fx.life / fx.max, 0, 1);
      const alive = fx.life > 0;
      fx.group.visible = alive;
      if (!alive) continue;
      fx.spin += dt;
      // the horizon starts tight and swells — then swallows itself at the end
      const swell = 0.35 + 0.65 * Math.min(1, t * 2.6);
      const collapse = t > 0.86 ? 1 - (t - 0.86) / 0.14 : 1;
      const r = fx.radius * swell * collapse;
      (fx.coreMat as THREE.MeshBasicMaterial).opacity = 0.92 * collapse;
      fx.core.scale.setScalar(Math.max(0.05, fx.radius * 0.42 * swell * collapse));
      for (let i = 0; i < fx.rings.length; i++) {
        const ring = fx.rings[i];
        const spin = fx.spin * ring.speed;
        // rings shrink toward the core, then reset outward: a continuous inward spiral
        const phase = (t * 2.2 + i / fx.rings.length) % 1;
        const rr = r * (1.05 - phase * 0.85);
        ring.mesh.scale.set(rr, 1, rr);
        ring.mesh.rotation.set(0.5 * i - 0.4, spin, 0.9 * i + spin * 0.6);
        ring.mat.opacity = 0.75 * collapse * (0.35 + phase * 0.65);
      }
      // debris drawn in from the rim
      if (Math.random() < dt * 34) {
        tangentBasis(fx.up, _v, _v2);
        const a = Math.random() * Math.PI * 2;
        const rr = r * (1.1 + Math.random() * 0.5);
        _v3.copy(fx.pos).addScaledVector(_v, Math.cos(a) * rr).addScaledVector(_v2, Math.sin(a) * rr);
        _v4.copy(fx.pos).sub(_v3).normalize().multiplyScalar(9 + Math.random() * 7);
        const c = _col.setHex(fx.color);
        this.spawnParticle(_v3.x, _v3.y, _v3.z, _v4.x, _v4.y, _v4.z, 0.42, 0.5, c.r, c.g, c.b, 0, 0.4);
      }
    }
  }

  private updateOrbs(dt: number): void {
    for (const fx of this.orbs) {
      if (fx.dur <= 0 || !fx.mesh.visible) continue;
      fx.t += dt;
      const u = clamp(fx.t / fx.dur, 0, 1);
      _v.copy(fx.from).lerp(fx.to, u).addScaledVector(fx.up, fx.arc * Math.sin(Math.PI * u));
      fx.mesh.position.copy(_v);
      fx.glow.position.copy(_v);
      fx.trailT -= dt;
      if (fx.trailT <= 0) {
        fx.trailT = 0.026;
        const c = _col.setHex(fx.color);
        for (let i = 0; i < 2; i++) {
          this.spawnParticle(
            _v.x + (Math.random() - 0.5) * fx.radius, _v.y + (Math.random() - 0.5) * fx.radius,
            _v.z + (Math.random() - 0.5) * fx.radius,
            (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3,
            0.34, fx.trailSize, c.r, c.g, c.b, 0, 1.2
          );
        }
      }
      if (u >= 1) {
        fx.mesh.visible = false;
        fx.glow.visible = false;
        fx.dur = 0;
      }
    }
  }

  reset(): void {
    this.pCount = 0;
    this.shakeAmt = 0;
    this.recallHeat = 0;
    this.recallCalled = false;
    this.recallMesh.visible = false;
    this.recallBase.visible = false;
    this.recallCollarA.visible = false;
    this.recallCollarB.visible = false;
    for (const fx of this.rings) {
      fx.life = 0;
      fx.mesh.visible = false;
    }
    for (const fx of this.beams) {
      fx.life = 0;
      fx.mesh.visible = false;
    }
    for (const dn of this.dmgNums) {
      dn.life = 0;
      dn.sprite.visible = false;
    }
    for (const fx of this.vortices) {
      fx.life = 0;
      fx.group.visible = false;
    }
    for (const fx of this.domes) {
      fx.life = 0;
      fx.group.visible = false;
    }
    for (const fx of this.waves) fx.t = fx.dur;
    for (const fx of this.stars) {
      fx.life = 0;
      fx.group.visible = false;
      fx.fired = false;
    }
    for (const fx of this.pillars) {
      fx.life = 0;
      fx.group.visible = false;
    }
    for (const fx of this.orbs) {
      fx.dur = 0;
      fx.mesh.visible = false;
      fx.glow.visible = false;
    }
    this.geo.setDrawRange(0, 0);
  }
}
