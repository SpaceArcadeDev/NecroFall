// NECROFALL — RECALL effect models (user ask 2026-09: a whole category of cosmetics that plays
// while you channel a recall and at both ends when it lands). Authored like every effect: origin
// on the ground, +Y up, animated purely from elapsed time, hero moment ≈ 1.17 s, gone by ~2.4 s.
import * as THREE from 'three';
import { AccessoryDef } from './AccessoryTypes';
import { MoteEmitter, driftVelocity, shellSpawn } from './MoteEmitter';
import {
  Composer, DotSet, TAU, fade, fxCol, fxCone, fxDisc, fxDots, fxGem, fxPane, fxRing, fxRod,
  fxShards, in3, matOf, out3, win,
} from './EffectKit';

/** Every recall effect is a 2.4 s one-shot — the runner disposes the build after this. */
const DUR = 2.4;

// ---- 1. MOONLIT GATE — a silver gate arches open above the sigil --------------------------------
function moonlitGate(): ReturnType<AccessoryDef['build']> {
  const fx = new Composer();
  const disc = fxDisc(1.5, 0x3a5480, 0.3);
  const ringA = fxRing(1.22, 0.045, 0x9fc8ff, 0.85);
  const ringB = fxRing(0.84, 0.028, 0xdfeaff, 0.8);
  const gate = fxRing(0.72, 0.075, 0xd8e8ff, 0.95);       // tilted to stand as an arch
  const dots = fxDots(12, 0xcfe4ff, 0.045);
  fx.add(disc, ringA, ringB, gate, dots.group);
  fx.tick((t) => {
    const a = fade(t, 0.05, 0.45, 1.75, 2.35);
    matOf(disc).opacity = 0.3 * a;
    matOf(ringA).opacity = 0.8 * a;
    matOf(ringB).opacity = 0.72 * a;
    matOf(dots.mat).opacity = 0.9 * a;
    ringA.rotation.z = 0.6 * t;
    ringB.rotation.z = -0.9 * t;
    // the gate lifts off the sigil and settles as an arch — the "door" of the effect
    const k = out3(win(t, 0.1, 1.1));
    gate.position.y = 0.25 + 1.05 * k;
    gate.rotation.x = -Math.PI / 2 + 0.35 + 1.05 * k;
    gate.scale.setScalar(0.75 + 0.45 * k);
    matOf(gate).opacity = 0.95 * fade(t, 0.1, 0.5, 1.7, 2.3);
    dots.dots.forEach((d, i) => {
      const ang = d.a0 + t * (0.7 + d.sp * 0.5) + i;
      const r = 1.35 - 0.35 * k;
      d.mesh.position.set(Math.cos(ang) * r, 0.1 + d.hf * 2.1 + 0.15 * Math.sin(t * 2.2 + i), Math.sin(ang) * r);
    });
  });
  return fx.build();
}

// ---- 2. EMBER CIRCLE — coals and flame lift you off the field -----------------------------------
function emberCircle(): ReturnType<AccessoryDef['build']> {
  const fx = new Composer();
  const disc = fxDisc(1.45, 0x6b2a12, 0.45);
  const ring = fxRing(1.15, 0.05, 0xff8a3d, 0.9);
  const flame = fxCone(0.85, 2.6, 0xff5a1a, 0.5);
  const embers = new MoteEmitter({
    count: 26, color: 0xffb03d, size: 0.07, life: 1.1, rate: 22, opacity: 0.95,
    spawn: (o) => shellSpawn(0.9, 0.15, 0.5)(o),
    velocity: driftVelocity(new THREE.Vector3(0, 1.4, 0), 0.5, 1.4),
    drag: 0.9, gravity: 0.4,
  });
  fx.add(disc, ring, flame, embers.points).onDispose(() => embers.dispose());
  fx.tick((t, dt) => {
    embers.update(dt);
    const a = fade(t, 0.05, 0.4, 1.7, 2.35);
    matOf(disc).opacity = 0.45 * a;
    matOf(ring).opacity = 0.9 * a * (1 + 0.15 * Math.sin(t * 9));
    const k = out3(win(t, 0.05, 1.3));
    flame.scale.set(0.7 + 0.5 * k, (0.35 + 0.75 * k) * (0.94 + 0.06 * Math.sin(t * 7)), 0.7 + 0.5 * k);
    matOf(flame).opacity = 0.5 * a * (0.8 + 0.2 * Math.sin(t * 11));
    ring.scale.setScalar(0.9 + 0.15 * Math.sin(t * 5));
  });
  return fx.build();
}

// ---- 3. FROSTSTEP SIGIL — frost creeps in from a wheel of ice -----------------------------------
function froststepSigil(): ReturnType<AccessoryDef['build']> {
  const fx = new Composer();
  const disc = fxDisc(1.5, 0x2a5a70, 0.32);
  const ring = fxRing(1.2, 0.04, 0x9fe8ff, 0.85);
  const spokes = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const rod = fxRod(0.05, 1.05, 0.02, 0xbfefff, 0.6);
    rod.rotation.z = Math.PI / 2;
    rod.rotation.y = (i / 6) * TAU;
    rod.position.set(Math.cos((i / 6) * TAU) * 0.62, 0.03, Math.sin((i / 6) * TAU) * 0.62);
    spokes.add(rod);
  }
  const shards = fxShards(8, 0xd8f6ff, 0.11, 0.9);
  const mist = fxDots(10, 0xaef2ff, 0.06);
  fx.add(disc, ring, spokes, shards.group, mist.group);
  fx.tick((t) => {
    const a = fade(t, 0.05, 0.4, 1.7, 2.35);
    matOf(disc).opacity = 0.32 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(shards.mat).opacity = 0.9 * a;
    matOf(mist.mat).opacity = 0.7 * a;
    spokes.rotation.y = t * 0.7;
    // the ice crystals rise slowly, spinning — frozen growth, not a burst
    shards.shards.forEach((s, i) => {
      const k = out3(win(t, 0.15 + i * 0.05, 1.35 + i * 0.05));
      s.mesh.position.set(Math.cos(s.a0) * s.rf * 1.1, 0.12 + k * (1.5 + s.hf), Math.sin(s.a0) * s.rf * 1.1);
      s.mesh.rotation.set(s.spin.x * k, s.spin.y * k, s.spin.z * k);
    });
    mist.dots.forEach((d, i) => {
      d.mesh.position.set(Math.cos(d.a0 + t * 0.4) * 1.4, 0.08 + d.hf * 0.5, Math.sin(d.a0 + t * 0.4) * 1.4);
    });
  });
  return fx.build();
}

// ---- 4. STORM PORTAL — pylons of lightning fence the channel ------------------------------------
function stormPortal(): ReturnType<AccessoryDef['build']> {
  const fx = new Composer();
  const disc = fxDisc(1.45, 0x3a2a70, 0.35);
  const ringA = fxRing(1.18, 0.045, 0x9f7bff, 0.85);
  const ringB = fxRing(0.8, 0.03, 0xd9c9ff, 0.8);
  const pylons = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const rod = fxRod(0.06, 2.3, 0.06, 0xbfa8ff, 0.85);
    rod.position.set(Math.cos((i / 4) * TAU) * 1.05, 1.15, Math.sin((i / 4) * TAU) * 1.05);
    rod.rotation.y = (i / 4) * TAU;
    pylons.add(rod);
  }
  const dots = fxDots(10, 0xd9c9ff, 0.05);
  fx.add(disc, ringA, ringB, pylons, dots.group);
  fx.tick((t) => {
    const a = fade(t, 0.05, 0.4, 1.7, 2.35);
    matOf(disc).opacity = 0.35 * a;
    matOf(ringA).opacity = 0.85 * a;
    matOf(ringB).opacity = 0.75 * a;
    matOf(dots.mat).opacity = 0.9 * a;
    ringA.rotation.z = -t * 1.2;
    ringB.rotation.z = t * 1.7;
    // the pylons jitter like held lightning
    pylons.children.forEach((rod, i) => {
      const jx = Math.sin(t * 17 + i * 2.4) * 0.05;
      const jz = Math.cos(t * 19 + i * 1.7) * 0.05;
      rod.position.x = Math.cos((i / 4) * TAU) * 1.05 + jx;
      rod.position.z = Math.sin((i / 4) * TAU) * 1.05 + jz;
      rod.scale.y = 0.85 + 0.3 * Math.abs(Math.sin(t * 13 + i));
    });
    dots.dots.forEach((d, i) => {
      const ang = d.a0 + t * d.sp * 2.4;
      d.mesh.position.set(Math.cos(ang) * 1.35, 0.2 + (d.hf * 2.2 + t * 0.5) % 2.3, Math.sin(ang) * 1.35);
    });
  });
  return fx.build();
}

// ---- 5. VERDANT REACH — vines curl up and carry you off ----------------------------------------
function verdantReach(): ReturnType<AccessoryDef['build']> {
  const fx = new Composer();
  const disc = fxDisc(1.45, 0x1e5a38, 0.4);
  const ring = fxRing(1.15, 0.045, 0x6dff9a, 0.85);
  const vines = fxDots(18, 0x9dffb8, 0.05);
  const leaves = fxShards(7, 0x2f9e5a, 0.12, 0.9);
  fx.add(disc, ring, vines.group, leaves.group);
  fx.tick((t) => {
    const a = fade(t, 0.05, 0.45, 1.7, 2.35);
    matOf(disc).opacity = 0.4 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(vines.mat).opacity = 0.95 * a;
    matOf(leaves.mat).opacity = 0.85 * a;
    // vines: dots wound up a slow helix that tightens as it rises
    vines.dots.forEach((d, i) => {
      const rise = (d.hf + t * (0.55 + d.sp * 0.35)) % 2.4;
      const ang = d.a0 + rise * 2.6;
      const r = 1.15 - rise * 0.22;
      d.mesh.position.set(Math.cos(ang) * r, 0.1 + rise, Math.sin(ang) * r);
    });
    leaves.shards.forEach((s, i) => {
      const k = out3(win(t, 0.3 + i * 0.08, 1.5 + i * 0.08));
      s.mesh.position.set(Math.cos(s.a0) * (0.7 + 0.5 * k), 0.15 + k * (1.3 + s.hf * 0.8), Math.sin(s.a0) * (0.7 + 0.5 * k));
      s.mesh.rotation.set(s.spin.x * 0.3 + k * 2, s.a0 + k * 3, s.spin.z * 0.3);
    });
  });
  return fx.build();
}

// ---- 6. VOID WELL — a violet well folds the ground and swallows the channel ---------------------
function voidWell(): ReturnType<AccessoryDef['build']> {
  const fx = new Composer();
  const disc = fxDisc(1.6, 0x2a0a4a, 0.5);
  const ringOut = fxRing(1.45, 0.04, 0xb44dff, 0.85);
  const ringIn = fxRing(0.9, 0.035, 0xe8b8ff, 0.8);
  const well = fxCol(0.75, 1.6, 0x5a1a9e, 0.32);
  const dots = fxDots(14, 0xd28aff, 0.05);
  fx.add(disc, ringOut, ringIn, well, dots.group);
  fx.tick((t) => {
    const a = fade(t, 0.05, 0.4, 1.7, 2.35);
    const pull = in3(win(t, 0.15, 1.5));          // everything gathers INWARD
    matOf(disc).opacity = 0.5 * a;
    matOf(ringOut).opacity = 0.85 * a;
    matOf(ringIn).opacity = 0.8 * a * (1 - 0.4 * pull);
    matOf(well).opacity = 0.32 * a;
    matOf(dots.mat).opacity = 0.95 * a;
    ringOut.scale.setScalar(1 - 0.35 * pull);
    ringOut.rotation.z = t * 0.8;
    ringIn.scale.setScalar(1 + 0.5 * pull);
    ringIn.rotation.z = -t * 1.4;
    well.scale.set(1 + 0.3 * pull, 1 - 0.4 * pull, 1 + 0.3 * pull);
    dots.dots.forEach((d, i) => {
      const r = 2.4 * (1 - pull) * d.rf + 0.15;
      const ang = d.a0 + t * (1.4 + d.sp) * (1 + pull);
      d.mesh.position.set(Math.cos(ang) * r, 0.15 + d.hf * 1.9 * (1 - 0.5 * pull), Math.sin(ang) * r);
    });
  });
  return fx.build();
}

// ---- 7. SUNBURST RETURN — golden rays announce the trip home ------------------------------------
function sunburstReturn(): ReturnType<AccessoryDef['build']> {
  const fx = new Composer();
  const disc = fxDisc(1.55, 0x8a5a12, 0.45);
  const ring = fxRing(1.18, 0.05, 0xffc23d, 0.9);
  const rays = new THREE.Group();
  for (let i = 0; i < 8; i++) {
    const rod = fxRod(0.07, 1.15, 0.03, 0xffe08a, 0.75);
    rod.rotation.z = Math.PI / 2;
    rod.rotation.y = (i / 8) * TAU;
    rod.position.set(Math.cos((i / 8) * TAU) * 0.68, 0.04, Math.sin((i / 8) * TAU) * 0.68);
    rays.add(rod);
  }
  const core = fxCone(0.55, 2.2, 0xffe9a8, 0.4);
  const dots = fxDots(10, 0xffd76b, 0.05);
  fx.add(disc, ring, rays, core, dots.group);
  fx.tick((t) => {
    const a = fade(t, 0.05, 0.4, 1.7, 2.35);
    matOf(disc).opacity = 0.45 * a;
    matOf(ring).opacity = 0.9 * a * (1 + 0.12 * Math.sin(t * 8));
    matOf(core).opacity = 0.4 * a * (0.85 + 0.15 * Math.sin(t * 12));
    matOf(dots.mat).opacity = 0.9 * a;
    rays.rotation.y = t * 1.1;
    rays.children.forEach((rod, i) => {
      rod.scale.x = 0.9 + 0.3 * Math.sin(t * 6 + i * 0.9);
    });
    core.scale.set(0.8 + 0.25 * Math.sin(t * 9), 1, 0.8 + 0.25 * Math.sin(t * 9));
    dots.dots.forEach((d, i) => {
      const ang = d.a0 + t * 1.6;
      d.mesh.position.set(Math.cos(ang) * (0.8 + d.rf * 0.6), 0.15 + ((d.hf + t * 0.3) % 1) * 2.2, Math.sin(ang) * (0.8 + d.rf * 0.6));
    });
  });
  return fx.build();
}

// ---- 8. TIDAL REFLUX — three tide rings wash you back to the deck -------------------------------
function tidalReflux(): ReturnType<AccessoryDef['build']> {
  const fx = new Composer();
  const disc = fxDisc(1.5, 0x1a4a70, 0.4);
  const rings = [fxRing(0.6, 0.04, 0x4db8ff, 0.0), fxRing(0.9, 0.035, 0x8fd7ff, 0.0), fxRing(1.2, 0.03, 0xbfe9ff, 0.0)];
  const drops = fxDots(11, 0xbfe9ff, 0.05);
  fx.add(disc, rings[0], rings[1], rings[2], drops.group);
  fx.tick((t) => {
    const a = fade(t, 0.05, 0.4, 1.7, 2.35);
    matOf(disc).opacity = 0.4 * a;
    matOf(drops.mat).opacity = 0.9 * a;
    rings.forEach((ring, i) => {
      const k = win(t, 0.1 + i * 0.22, 1.25 + i * 0.22);
      ring.scale.setScalar(0.4 + out3(k) * 1.5);
      matOf(ring).opacity = (1 - k) * 0.85 * a;
    });
    drops.dots.forEach((d, i) => {
      const ang = d.a0 + t * 0.5;
      const r = 0.5 + d.rf * 0.9;
      const hop = Math.abs(Math.sin(t * 3.2 + i * 1.3)) * 0.55;
      d.mesh.position.set(Math.cos(ang) * r, 0.15 + hop, Math.sin(ang) * r);
    });
  });
  return fx.build();
}

// ---- 9. RUNE CASCADE — floating runes spiral up and take you with them --------------------------
function runeCascade(): ReturnType<AccessoryDef['build']> {
  const fx = new Composer();
  const disc = fxDisc(1.4, 0x1a4a55, 0.35);
  const ring = fxRing(1.12, 0.04, 0x7fe6ff, 0.85);
  const runes = new THREE.Group();
  const runeList: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const rune = fxRod(0.24, 0.32, 0.03, 0xd8f6ff, 0.9);
    runes.add(rune);
    runeList.push(rune);
  }
  const sparks = fxDots(9, 0x9fe8ff, 0.045);
  fx.add(disc, ring, runes, sparks.group);
  fx.tick((t) => {
    const a = fade(t, 0.05, 0.4, 1.7, 2.35);
    matOf(disc).opacity = 0.35 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(sparks.mat).opacity = 0.85 * a;
    ring.rotation.z = t * 0.5;
    runeList.forEach((rune, i) => {
      const base = (i / 5) * TAU;
      const rise = (t * (0.8 + i * 0.08)) % 2.4;
      const ang = base + rise * 1.5;
      const r = 0.95 - rise * 0.15;
      rune.position.set(Math.cos(ang) * r, 0.35 + rise, Math.sin(ang) * r);
      rune.rotation.y = -ang;
      rune.rotation.x = 0.15 * Math.sin(t * 3 + i);
      const glint = 0.7 + 0.3 * Math.sin(t * 5 + i * 2.1);
      rune.scale.setScalar(glint * (1 - rise / 2.7));
    });
    sparks.dots.forEach((d) => {
      const ang = d.a0 + t * d.sp * 1.4;
      d.mesh.position.set(Math.cos(ang) * 1.3, 0.1 + ((d.hf + t * 0.4) % 1) * 2.4, Math.sin(ang) * 1.3);
    });
  });
  return fx.build();
}

// ---- 10. HOLLOW BEACON — pale ghost-light marks the passage home --------------------------------
function hollowBeacon(): ReturnType<AccessoryDef['build']> {
  const fx = new Composer();
  const disc = fxDisc(1.45, 0x2a4a40, 0.35);
  const ring = fxRing(1.15, 0.04, 0x7fffc4, 0.8);
  const beamA = fxPane(0.55, 3.3, 0xd8ffe9, 0.5);
  const beamB = fxPane(0.55, 3.3, 0xd8ffe9, 0.5);
  beamA.rotation.y = 0.4;
  beamB.rotation.y = -0.9;
  const wisps = fxDots(12, 0xd8ffe9, 0.05);
  const mist = new MoteEmitter({
    count: 18, color: 0xa8ffd8, size: 0.08, life: 1.4, rate: 10, opacity: 0.55,
    spawn: (o) => shellSpawn(1, 0.2, 0.7)(o),
    velocity: driftVelocity(new THREE.Vector3(0, 1, 0), 0.1, 0.4),
    drag: 0.5,
  });
  fx.add(disc, ring, beamA, beamB, wisps.group, mist.points).onDispose(() => mist.dispose());
  fx.tick((t, dt) => {
    mist.update(dt);
    const a = fade(t, 0.05, 0.5, 1.75, 2.35);
    matOf(disc).opacity = 0.35 * a;
    matOf(ring).opacity = 0.8 * a;
    matOf(wisps.mat).opacity = 0.8 * a;
    matOf(beamA).opacity = 0.45 * a * (0.8 + 0.2 * Math.sin(t * 5.5));
    matOf(beamB).opacity = 0.45 * a * (0.8 + 0.2 * Math.sin(t * 4.3 + 2));
    beamA.rotation.y = 0.4 + t * 0.35;
    beamB.rotation.y = -0.9 - t * 0.28;
    beamA.position.y = 1.65 + 0.12 * Math.sin(t * 3.1);
    beamB.position.y = 1.65 + 0.12 * Math.sin(t * 2.7 + 1.5);
    wisps.dots.forEach((d, i) => {
      const ang = d.a0 + t * 0.6;
      d.mesh.position.set(Math.cos(ang) * (0.7 + d.rf * 0.7), 0.15 + ((d.hf + t * 0.35) % 1) * 2.6, Math.sin(ang) * (0.7 + d.rf * 0.7));
    });
  });
  return fx.build();
}

// ---- 11. MAGMA SHIFT — the ground cracks and molten light lifts you out -------------------------
function magmaShift(): ReturnType<AccessoryDef['build']> {
  const fx = new Composer();
  const disc = fxDisc(1.5, 0x4a1a08, 0.5);
  const ring = fxRing(1.18, 0.05, 0xff5a1a, 0.9);
  const cracks = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const rod = fxRod(0.07, 1.25, 0.02, 0xffb03d, 0.75);
    rod.rotation.z = Math.PI / 2;
    rod.rotation.y = (i / 5) * TAU + 0.4;
    rod.position.set(Math.cos((i / 5) * TAU + 0.4) * 0.7, 0.03, Math.sin((i / 5) * TAU + 0.4) * 0.7);
    cracks.add(rod);
  }
  const lava = fxDots(12, 0xffc46b, 0.05);
  const flame = fxCone(0.7, 2.4, 0xff6a1a, 0.4);
  fx.add(disc, ring, cracks, lava.group, flame);
  fx.tick((t) => {
    const a = fade(t, 0.05, 0.4, 1.7, 2.35);
    matOf(disc).opacity = 0.5 * a;
    matOf(ring).opacity = 0.9 * a * (1 + 0.12 * Math.sin(t * 7));
    matOf(lava.mat).opacity = 0.95 * a;
    matOf(flame).opacity = 0.4 * a * win(t, 0.5, 0.9) * (0.8 + 0.2 * Math.sin(t * 10));
    cracks.rotation.y = Math.sin(t * 0.8) * 0.06;
    flame.scale.set(0.8 + 0.3 * Math.sin(t * 8), 0.5 + 0.6 * out3(win(t, 0.45, 1.4)), 0.8 + 0.3 * Math.sin(t * 8));
    // lava globs bubble up from the cracks and sag back down
    lava.dots.forEach((d, i) => {
      const cycle = (t * (0.55 + d.sp * 0.3) + d.hf * 3) % 3;
      const hop = Math.sin(Math.min(1, cycle / 1.6) * Math.PI) * 0.9;
      const ang = d.a0;
      d.mesh.position.set(Math.cos(ang) * (0.5 + d.rf * 0.7), 0.08 + hop, Math.sin(ang) * (0.5 + d.rf * 0.7));
    });
  });
  return fx.build();
}

// ---- 12. ASTRAL TETHER — stars reel you in along silver lines -----------------------------------
function astralTether(): ReturnType<AccessoryDef['build']> {
  const fx = new Composer();
  const disc = fxDisc(1.5, 0x243a66, 0.35);
  const ring = fxRing(1.2, 0.035, 0x9fb8ff, 0.8);
  const star = fxGem(0.32, 0xffffff, 0.95);
  const tethers = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const rod = fxRod(0.025, 2.6, 0.025, 0x9fb8ff, 0.55);
    rod.rotation.z = Math.PI / 2;
    rod.rotation.y = (i / 6) * TAU + 0.3;
    rod.position.set(Math.cos((i / 6) * TAU + 0.3) * 1.3, 0.05, Math.sin((i / 6) * TAU + 0.3) * 1.3);
    tethers.add(rod);
  }
  const stars = fxDots(14, 0xd8e4ff, 0.04);
  fx.add(disc, ring, star, tethers, stars.group);
  fx.tick((t) => {
    const a = fade(t, 0.05, 0.45, 1.75, 2.35);
    const gather = in3(win(t, 0.15, 1.4));
    matOf(disc).opacity = 0.35 * a;
    matOf(ring).opacity = 0.8 * a;
    tethers.children.forEach((rod) => { matOf(rod).opacity = 0.55 * a; });
    matOf(stars.mat).opacity = 0.95 * a;
    star.position.y = 0.5 + 0.9 * out3(win(t, 0.1, 1.2));
    star.rotation.y = t * 2.2;
    star.scale.setScalar(0.7 + 0.5 * gather + 0.15 * Math.sin(t * 9));
    tethers.rotation.y = t * 0.5;
    stars.dots.forEach((d, i) => {
      // stars slide inward along their own angle and die at the star
      const slide = (d.hf + t * (0.5 + d.sp * 0.4)) % 1;
      const r = 3 * (1 - slide) + 0.1;
      const ang = d.a0 + slide * 0.8;
      d.mesh.position.set(Math.cos(ang) * r, 0.3 + (1 - slide) * 1.6, Math.sin(ang) * r);
    });
  });
  return fx.build();
}

// ---- 13. HOWLING GALE — a gale spins you into the wind and away ---------------------------------
function howlingGale(): ReturnType<AccessoryDef['build']> {
  const fx = new Composer();
  const disc = fxDisc(1.45, 0x2a5a4a, 0.3);
  const ringA = fxRing(1.15, 0.035, 0x8fd7ff, 0.7);
  const ringB = fxRing(0.78, 0.03, 0xbfffe0, 0.75);
  const wisps = fxDots(16, 0xcfffe8, 0.045);
  const gust = new MoteEmitter({
    count: 20, color: 0xbfffe0, size: 0.07, life: 0.9, rate: 16, opacity: 0.6,
    spawn: (o) => shellSpawn(1.1, 0.45, 0.4)(o),
    velocity: driftVelocity(new THREE.Vector3(0, 0.35, 0), 1.6, 3.2),
    drag: 1.4,
  });
  fx.add(disc, ringA, ringB, wisps.group, gust.points).onDispose(() => gust.dispose());
  fx.tick((t, dt) => {
    gust.update(dt);
    const a = fade(t, 0.05, 0.4, 1.7, 2.35);
    matOf(disc).opacity = 0.3 * a;
    matOf(ringA).opacity = 0.7 * a;
    matOf(ringB).opacity = 0.75 * a;
    matOf(wisps.mat).opacity = 0.85 * a;
    ringA.rotation.z = t * 3.2;
    ringB.rotation.z = -t * 4.1;
    ringA.scale.setScalar(1 + 0.08 * Math.sin(t * 7));
    // the wisps sprint around the rim, drawn into a rising spiral
    wisps.dots.forEach((d, i) => {
      const ang = d.a0 + t * (2.6 + d.sp * 1.6);
      const rise = (d.hf + t * 0.5) % 1;
      const r = 1.3 - rise * 0.55;
      d.mesh.position.set(Math.cos(ang) * r, 0.15 + rise * 2.2, Math.sin(ang) * r);
    });
  });
  return fx.build();
}

// ---- 14. BLOOD MOON ASCENT — a crimson moon rises and carries you off ---------------------------
function bloodMoonAscent(): ReturnType<AccessoryDef['build']> {
  const fx = new Composer();
  const disc = fxDisc(1.55, 0x4a0a18, 0.5);
  const ring = fxRing(1.2, 0.05, 0xff2d55, 0.85);
  const moon = fxDisc(0.95, 0xff3355, 0.65);              // stood upright like a rising moon
  moon.rotation.x = -0.35;
  const dots = fxDots(12, 0xff6b8a, 0.05);
  fx.add(disc, ring, moon, dots.group);
  fx.tick((t) => {
    const a = fade(t, 0.05, 0.45, 1.75, 2.35);
    const rise = out3(win(t, 0.1, 1.5));
    matOf(disc).opacity = 0.5 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(moon).opacity = 0.65 * a * (0.85 + 0.15 * Math.sin(t * 3.4));
    matOf(dots.mat).opacity = 0.9 * a;
    ring.rotation.z = -t * 0.6;
    moon.position.y = 0.3 + rise * 1.9;
    moon.rotation.z = 0.12 * Math.sin(t * 1.7);
    moon.scale.setScalar(0.65 + 0.35 * rise);
    dots.dots.forEach((d, i) => {
      const ang = d.a0 + t * (0.5 + d.sp * 0.4);
      const r = 1.3 * d.rf + 0.25;
      d.mesh.position.set(Math.cos(ang) * r, 0.1 + ((d.hf + t * 0.35) % 1) * 2.4, Math.sin(ang) * r);
    });
  });
  return fx.build();
}

// ---- 15. GLITCH WARP — reality stutters and you jump the frame ----------------------------------
function glitchWarp(): ReturnType<AccessoryDef['build']> {
  const fx = new Composer();
  const disc = fxDisc(1.45, 0x0a5a4a, 0.35);
  const ringA = fxRing(1.12, 0.04, 0x4dffd2, 0.85);
  const ringB = fxRing(0.82, 0.03, 0xff4df0, 0.8);
  const blocks: THREE.Mesh[] = [];
  const blockGroup = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const b = fxRod(0.2 + Math.random() * 0.2, 0.24, 0.04, i % 2 === 0 ? 0x4dffd2 : 0xff4df0, 0.85);
    b.position.set((Math.random() - 0.5) * 2.2, 0.4 + Math.random() * 1.8, (Math.random() - 0.5) * 2.2);
    blockGroup.add(b);
    blocks.push(b);
  }
  const dots = fxDots(12, 0x9ffff0, 0.05);
  fx.add(disc, ringA, ringB, blockGroup, dots.group);
  fx.tick((t) => {
    const a = fade(t, 0.05, 0.4, 1.7, 2.35);
    matOf(disc).opacity = 0.35 * a;
    matOf(ringA).opacity = 0.85 * a;
    matOf(ringB).opacity = 0.8 * a;
    matOf(dots.mat).opacity = 0.9 * a;
    // rings stutter: position snaps on a fast square-ish wave
    const snapA = Math.sin(t * 23) > 0 ? 0.06 : 0;
    const snapB = Math.sin(t * 31 + 2) > 0 ? 0.06 : 0;
    ringA.position.set(snapA, 0, snapB);
    ringB.position.set(-snapB, 0, snapA);
    ringA.rotation.z = t * 0.9;
    ringB.rotation.z = -t * 1.3;
    blocks.forEach((b, i) => {
      const blink = Math.sin(t * (14 + i * 3) + i * 2.2) > -0.2;
      b.visible = blink;
      b.scale.setScalar(0.7 + 0.4 * Math.abs(Math.sin(t * 9 + i)));
      b.rotation.y = t * (2 + i * 0.5);
    });
    dots.dots.forEach((d, i) => {
      const ang = d.a0 + t * d.sp * 3;
      d.mesh.position.set(Math.cos(ang) * (1.25 - (t % 0.4) * 0.5), 0.2 + d.hf * 2.1, Math.sin(ang) * (1.25 - (t % 0.4) * 0.5));
    });
  });
  return fx.build();
}

export const RECALL_EFFECTS: AccessoryDef[] = [
  { id: 'recall-moonlit-gate', name: 'MOONLIT GATE', desc: 'A silver gate arches open for the trip home.', build: moonlitGate, duration: DUR },
  { id: 'recall-ember-circle', name: 'EMBER CIRCLE', desc: 'Coals and flame lift you off the field.', build: emberCircle, duration: DUR },
  { id: 'recall-froststep-sigil', name: 'FROSTSTEP SIGIL', desc: 'Frost creeps in from a wheel of ice.', build: froststepSigil, duration: DUR },
  { id: 'recall-storm-portal', name: 'STORM PORTAL', desc: 'Pylons of lightning fence in the channel.', build: stormPortal, duration: DUR },
  { id: 'recall-verdant-reach', name: 'VERDANT REACH', desc: 'Vines curl up and carry you away.', build: verdantReach, duration: DUR },
  { id: 'recall-void-well', name: 'VOID WELL', desc: 'A violet well folds the ground and swallows you out.', build: voidWell, duration: DUR },
  { id: 'recall-sunburst-return', name: 'SUNBURST RETURN', desc: 'Golden rays announce your return to base.', build: sunburstReturn, duration: DUR },
  { id: 'recall-tidal-reflux', name: 'TIDAL REFLUX', desc: 'Three tide rings wash you back to the deck.', build: tidalReflux, duration: DUR },
  { id: 'recall-rune-cascade', name: 'RUNE CASCADE', desc: 'Floating runes spiral up and take you with them.', build: runeCascade, duration: DUR },
  { id: 'recall-hollow-beacon', name: 'HOLLOW BEACON', desc: 'Pale ghost-light marks the passage home.', build: hollowBeacon, duration: DUR },
  { id: 'recall-magma-shift', name: 'MAGMA SHIFT', desc: 'The ground cracks and molten light lifts you out.', build: magmaShift, duration: DUR },
  { id: 'recall-astral-tether', name: 'ASTRAL TETHER', desc: 'Stars reel you in along silver lines.', build: astralTether, duration: DUR },
  { id: 'recall-howling-gale', name: 'HOWLING GALE', desc: 'A gale spins you into the wind and away.', build: howlingGale, duration: DUR },
  { id: 'recall-blood-moon-ascent', name: 'BLOOD MOON ASCENT', desc: 'A crimson moon rises and carries you off.', build: bloodMoonAscent, duration: DUR },
  { id: 'recall-glitch-warp', name: 'GLITCH WARP', desc: 'Reality stutters and you jump the frame.', build: glitchWarp, duration: DUR },
];
