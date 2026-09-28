// NECROFALL — SPAWN effect models (user ask 2026-09): one-shot cosmetics that play the moment a
// body enters the match (match start) and on every respawn. Authored like every effect: origin on
// the ground, +Y up, animated purely from elapsed time, hero moment ≈ 1.17 s, gone by ~2.4 s.
import * as THREE from 'three';
import { AccessoryBuild, AccessoryDef } from './AccessoryTypes';
import { MoteEmitter, driftVelocity, shellSpawn } from './MoteEmitter';
import {
  Composer, TAU, fade, fxCol, fxCone, fxDisc, fxDome, fxDots, fxGem, fxPane, fxRing, fxRod,
  fxShards, in3, matOf, out3, outBack, win,
} from './EffectKit';

/** Every spawn effect is a 2.4 s one-shot — the runner disposes the build after this. */
const DUR = 2.4;

// ---- 1. DAWN ASCENT — the dawn breaks at your feet as you arrive ---------------------------------
function dawnAscent(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.7, 0x6b4a12, 0.45);
  const ring = fxRing(1.3, 0.05, 0xffd76b, 0.9);
  const rays = new THREE.Group();
  for (let i = 0; i < 8; i++) {
    const rod = fxRod(0.08, 1.1, 0.03, 0xffe6a0, 0.7);
    rod.rotation.z = Math.PI / 2;
    rod.rotation.y = (i / 8) * TAU;
    rod.position.set(Math.cos((i / 8) * TAU) * 0.72, 0.05, Math.sin((i / 8) * TAU) * 0.72);
    rays.add(rod);
  }
  const pillar = fxCol(0.66, 3.4, 0xffc76b, 0.26);
  const sun = fxDisc(0.55, 0xffe9a8, 0.75);
  sun.rotation.x = -0.5;
  const dots = fxDots(10, 0xffd76b, 0.05);
  fx.add(disc, ring, rays, pillar, sun, dots.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.65, 2.35);
    matOf(disc).opacity = 0.45 * a;
    matOf(ring).opacity = 0.9 * a * (1 + 0.1 * Math.sin(t * 7));
    matOf(pillar).opacity = 0.26 * a;
    matOf(sun).opacity = 0.75 * a * (0.85 + 0.15 * Math.sin(t * 2.6));
    matOf(dots.mat).opacity = 0.9 * a;
    rays.rotation.y = t * 0.8;
    pillar.scale.set(0.7 + 0.3 * outBack(win(t, 0.05, 0.8)), 0.4 + 0.6 * outBack(win(t, 0.05, 0.8)), 0.7 + 0.3 * outBack(win(t, 0.05, 0.8)));
    sun.position.y = 0.6 + 1.5 * out3(win(t, 0.1, 1.3));
    dots.dots.forEach((d, i) => {
      const ang = d.a0 + t * 0.6;
      d.mesh.position.set(Math.cos(ang) * (0.9 + d.rf * 0.6), 0.2 + ((d.hf + t * 0.4) % 1) * 2.6, Math.sin(ang) * (0.9 + d.rf * 0.6));
    });
  });
  return fx.build();
}

// ---- 2. THUNDERBORN — you land with the storm already around you ---------------------------------
function thunderborn(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.6, 0x1a3a70, 0.4);
  const ring = fxRing(1.25, 0.045, 0x7fd0ff, 0.85);
  const bolt = fxRod(0.16, 4.4, 0.16, 0xeaf6ff, 0.0);
  bolt.position.y = 2.2;
  const cage = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const rod = fxRod(0.05, 2.6, 0.05, 0xbfe4ff, 0.6);
    rod.position.set(Math.cos((i / 5) * TAU) * 1.15, 1.3, Math.sin((i / 5) * TAU) * 1.15);
    cage.add(rod);
  }
  const dots = fxDots(10, 0xd8f0ff, 0.05);
  fx.add(disc, ring, bolt, cage, dots.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.3, 1.6, 2.35);
    matOf(disc).opacity = 0.4 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(dots.mat).opacity = 0.9 * a;
    // the main bolt strikes in hard flickers, then the storm settles
    const flash = win(t, 0.05, 0.2) * (1 - win(t, 0.5, 0.9)) * (Math.sin(t * 47) > -0.3 ? 1 : 0.15);
    matOf(bolt).opacity = 0.9 * flash;
    bolt.scale.x = 0.7 + Math.random() * 0.9;
    bolt.scale.z = bolt.scale.x;
    ring.rotation.z = t * 1.4;
    ring.scale.setScalar(1 + 0.1 * Math.sin(t * 9));
    cage.children.forEach((rod, i) => {
      rod.position.x = Math.cos((i / 5) * TAU) * 1.15 + Math.sin(t * 21 + i * 3) * 0.06;
      rod.position.z = Math.sin((i / 5) * TAU) * 1.15 + Math.cos(t * 17 + i * 2) * 0.06;
      matOf(rod).opacity = 0.6 * a * (Math.sin(t * 15 + i * 2.6) > -0.4 ? 1 : 0.3);
    });
    dots.dots.forEach((d, i) => {
      const ang = d.a0 + t * d.sp * 2.6;
      d.mesh.position.set(Math.cos(ang) * 1.4, 0.2 + ((d.hf + t * 0.6) % 1) * 2.4, Math.sin(ang) * 1.4);
    });
  });
  return fx.build();
}

// ---- 3. PHOENIX RISE — a firebird unfurls where you take the field -------------------------------
function phoenixRise(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.7, 0x6b2a08, 0.5);
  const ring = fxRing(1.28, 0.05, 0xff7a2d, 0.9);
  const body = fxCone(0.6, 2.9, 0xff9d3d, 0.45);
  const wings = new THREE.Group();
  const wingDots: { mesh: THREE.Mesh; side: number; lane: number }[] = [];
  const wingSet = fxDots(14, 0xffc46b, 0.06);
  wingSet.dots.forEach((d, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    const lane = Math.floor(i / 2);
    wingDots.push({ mesh: d.mesh, side, lane });
  });
  wings.add(wingSet.group);
  const embers = new MoteEmitter({
    count: 24, color: 0xffb03d, size: 0.08, life: 1.0, rate: 20, opacity: 0.9,
    spawn: (o) => shellSpawn(0.7, 0.6, 0.5)(o),
    velocity: driftVelocity(new THREE.Vector3(0, 1.6, 0), 0.8, 2.0),
    drag: 0.8,
  });
  fx.add(disc, ring, body, wings, embers.points).onDispose(() => embers.dispose());
  fx.tick((t, dt) => {
    embers.update(dt);
    const a = fade(t, 0.03, 0.35, 1.65, 2.35);
    matOf(disc).opacity = 0.5 * a;
    matOf(ring).opacity = 0.9 * a * (1 + 0.1 * Math.sin(t * 6));
    matOf(body).opacity = 0.45 * a * (0.85 + 0.15 * Math.sin(t * 9));
    matOf(wingSet.mat).opacity = 0.95 * a;
    const flap = outBack(win(t, 0.05, 0.9));
    body.scale.set(0.8 + 0.3 * Math.sin(t * 8), 0.5 + 0.6 * flap, 0.8 + 0.3 * Math.sin(t * 8));
    // the wings sweep out and up: a crescent of embers on each side of the flame body
    wingDots.forEach((w) => {
      const lane = w.lane / 6;
      const spread = 0.5 + flap * (1.4 + lane * 0.9);
      const ang = w.side * (0.25 + lane * 0.55) - Math.PI / 2 * w.side * 0;
      const x = w.side * spread * Math.cos(lane * 0.9);
      const y = 1.0 + lane * 1.3 + flap * (1.2 - lane * 0.5) + 0.12 * Math.sin(t * 6 + lane * 3);
      const z = Math.sin(ang) * 0.3;
      w.mesh.position.set(x, y, z);
    });
  });
  return fx.build();
}

// ---- 4. METEOR IMPACT — you crash down like a meteor and the dust knows it -----------------------
function meteorImpact(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.8, 0x5a3a22, 0.5);
  const ringA = fxRing(1.1, 0.055, 0xff9d4d, 0.9);
  const ringB = fxRing(1.5, 0.04, 0xffd0a0, 0.8);
  const rock = fxGem(0.5, 0x8a6a52, 0.85);
  rock.scale.set(1.1, 0.8, 1.1);
  const dust = fxDots(16, 0xb08a6b, 0.07);
  const grit = fxShards(8, 0x6b4a32, 0.13, 0.85);
  fx.add(disc, ringA, ringB, rock, dust.group, grit.group);
  fx.tick((t) => {
    const a = fade(t, 0.02, 0.3, 1.6, 2.35);
    matOf(disc).opacity = 0.5 * a;
    matOf(dust.mat).opacity = 0.8 * a;
    matOf(grit.mat).opacity = 0.85 * a;
    // the two shock rings rip out immediately, then breathe
    const kA = out3(win(t, 0.02, 0.55));
    const kB = out3(win(t, 0.08, 0.75));
    ringA.scale.setScalar(0.35 + kA * 1.5);
    ringB.scale.setScalar(0.25 + kB * 1.7);
    matOf(ringA).opacity = 0.9 * a * (1 - kA * 0.55);
    matOf(ringB).opacity = 0.8 * a * (1 - kB * 0.5);
    // the rock is only there for the first half second: it sinks and is gone
    const sink = win(t, 0.0, 0.5);
    rock.position.y = 1.6 * (1 - in3(sink)) + 0.3;
    rock.rotation.y = t * 2.4;
    matOf(rock).opacity = 0.85 * a * (1 - sink) * win(t, 0.02, 0.12);
    // dust rolls outward low, grit skips along the ground
    dust.dots.forEach((d, i) => {
      const k = out3(win(t, 0.05, 1.2));
      const r = 0.4 + k * (1.2 + d.rf * 1.1);
      const ang = d.a0 + d.sp * 0.4;
      d.mesh.position.set(Math.cos(ang) * r, 0.15 + d.hf * (1.6 - k * 1.1), Math.sin(ang) * r);
    });
    grit.shards.forEach((s) => {
      const k = out3(win(t, 0.05, 1.0));
      const r = 0.3 + k * (1.6 + s.rf);
      s.mesh.position.set(Math.cos(s.a0) * r, 0.15 + Math.sin(Math.min(1, k) * Math.PI) * (0.5 + s.hf), Math.sin(s.a0) * r);
      s.mesh.rotation.set(s.spin.x * k, s.spin.y * k, s.spin.z * k);
    });
  });
  return fx.build();
}

// ---- 5. SPIRIT BLOOM — spirit petals bloom open as you join the fight ----------------------------
function spiritBloom(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.55, 0x1e5a4a, 0.4);
  const ring = fxRing(1.2, 0.04, 0x7dffb0, 0.85);
  const petals = new THREE.Group();
  const petalList: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const petal = fxRod(0.5, 0.06, 0.16, 0xe8ffe8, 0.75);
    petal.position.set(Math.cos((i / 6) * TAU) * 0.55, 0.25, Math.sin((i / 6) * TAU) * 0.55);
    petal.rotation.y = -(i / 6) * TAU;
    petals.add(petal);
    petalList.push(petal);
  }
  const heart = fxGem(0.22, 0xd8ffe8, 0.95);
  const spores = fxDots(12, 0x9dffc4, 0.045);
  fx.add(disc, ring, petals, heart, spores.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.65, 2.35);
    matOf(disc).opacity = 0.4 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(spores.mat).opacity = 0.9 * a;
    // the petals open from a bud: tilt down and out, widening as the bloom completes
    const open = out3(win(t, 0.08, 1.0));
    petalList.forEach((petal, i) => {
      const ang = (i / 6) * TAU;
      const r = 0.35 + open * 0.85;
      petal.position.set(Math.cos(ang) * r, 0.2 + open * 0.55 + 0.06 * Math.sin(t * 3 + i), Math.sin(ang) * r);
      petal.rotation.z = -open * 0.9;
      petal.rotation.y = -ang + t * 0.15;
      matOf(petal).opacity = 0.75 * a * (0.7 + 0.3 * Math.sin(t * 4 + i));
    });
    heart.position.y = 0.4 + open * 0.7;
    heart.rotation.y = t * 1.6;
    heart.scale.setScalar(0.7 + 0.5 * open + 0.1 * Math.sin(t * 7));
    matOf(heart).opacity = 0.95 * a;
    spores.dots.forEach((d, i) => {
      const ang = d.a0 + t * d.sp * 0.8;
      d.mesh.position.set(Math.cos(ang) * (0.8 + d.rf * 0.8), 0.2 + ((d.hf + t * 0.35) % 1) * 2.2, Math.sin(ang) * (0.8 + d.rf * 0.8));
    });
  });
  return fx.build();
}

// ---- 6. NEON GRID — a neon grid snaps you on to the battlefield ----------------------------------
function neonGrid(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.6, 0x0a4a5a, 0.4);
  const bars = new THREE.Group();
  const barList: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const bar = fxRod(0.06, 3.0, 0.06, i % 2 === 0 ? 0x4dfff0 : 0xff4df0, 0.8);
    bar.position.set(Math.cos((i / 6) * TAU) * 1.05, 1.0, Math.sin((i / 6) * TAU) * 1.05);
    bars.add(bar);
    barList.push(bar);
  }
  const frame = fxRing(1.05, 0.035, 0x9ffff0, 0.0);
  const dots = fxDots(10, 0x9ffff0, 0.05);
  fx.add(disc, frame, bars, dots.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.6, 2.35);
    matOf(disc).opacity = 0.4 * a;
    matOf(dots.mat).opacity = 0.9 * a;
    const up = outBack(win(t, 0.05, 0.8));
    barList.forEach((bar, i) => {
      const glitchY = Math.sin(t * (11 + i * 2) + i) * 0.08;
      bar.position.y = 0.2 + up * 0.9 + glitchY;
      bar.scale.y = 0.3 + up * 0.7 + 0.08 * Math.sin(t * 6 + i * 1.4);
      matOf(bar).opacity = 0.8 * a * (Math.sin(t * 9 + i * 2.1) > -0.5 ? 1 : 0.45);
    });
    frame.position.y = 0.1 + up * 0.9;
    frame.rotation.z = t * 0.6;
    matOf(frame).opacity = 0.7 * a;
    frame.scale.setScalar(0.6 + up * 0.45);
    dots.dots.forEach((d, i) => {
      const ang = d.a0 + t * d.sp * 2.2;
      d.mesh.position.set(Math.cos(ang) * 1.3, 0.25 + ((d.hf + t * 0.5) % 1) * 2.3, Math.sin(ang) * 1.3);
    });
  });
  return fx.build();
}

// ---- 7. FROZEN MOMENT — frost gathers, then bursts — you step out --------------------------------
function frozenMoment(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.6, 0x2a5a70, 0.42);
  const ring = fxRing(1.22, 0.04, 0xaef2ff, 0.85);
  const crystal = fxGem(0.65, 0xdff6ff, 0.85);
  crystal.position.y = 0.85;
  const shards = fxShards(10, 0xaef2ff, 0.13, 0.9);
  const mist = fxDots(10, 0xd8f6ff, 0.055);
  fx.add(disc, ring, crystal, shards.group, mist.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.65, 2.35);
    matOf(disc).opacity = 0.42 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(shards.mat).opacity = 0.9 * a;
    matOf(mist.mat).opacity = 0.75 * a;
    // grow a crystal, freeze-frame, then shatter it outward
    const grow = out3(win(t, 0.03, 0.8));
    const crack = win(t, 0.85, 1.5);
    crystal.position.y = 0.4 + grow * 0.75;
    crystal.scale.setScalar(grow * (1 - crack) * 1.1);
    crystal.rotation.y = t * 0.9;
    matOf(crystal).opacity = 0.85 * a * (1 - crack);
    shards.shards.forEach((s) => {
      const k = out3(crack) * (0.5 + s.rf * 0.5);
      s.mesh.position.set(s.dir.x * k * 2.4, 0.7 + s.dir.y * k * 2.2 - k * 0.5, s.dir.z * k * 2.4);
      s.mesh.rotation.set(s.spin.x * k * 2, s.spin.y * k * 2, s.spin.z * k * 2);
    });
    mist.dots.forEach((d) => {
      d.mesh.position.set(Math.cos(d.a0 + t * 0.4) * (1.1 + d.rf * 0.4), 0.1 + d.hf * 0.5, Math.sin(d.a0 + t * 0.4) * (1.1 + d.rf * 0.4));
    });
  });
  return fx.build();
}

// ---- 8. ROYAL DESCENT — a golden column lowers you onto the deck ---------------------------------
function royalDescent(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.65, 0x6b5212, 0.45);
  const ring = fxRing(1.25, 0.05, 0xffd23d, 0.9);
  const column = fxCol(0.72, 3.2, 0xffd23d, 0.3);
  const spikes = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const spike = fxRod(0.09, 0.5, 0.09, 0xfff2b8, 0.85);
    spike.position.set(Math.cos((i / 6) * TAU + 0.3) * 1.15, 0.52, Math.sin((i / 6) * TAU + 0.3) * 1.15);
    spikes.add(spike);
  }
  const dust = fxDots(12, 0xffe08a, 0.05);
  fx.add(disc, ring, column, spikes, dust.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.65, 2.35);
    matOf(disc).opacity = 0.45 * a;
    matOf(ring).opacity = 0.9 * a * (1 + 0.1 * Math.sin(t * 6));
    matOf(column).opacity = 0.3 * a;
    matOf(dust.mat).opacity = 0.9 * a;
    // the column arrives FROM above, settling on the deck with the crown of spikes
    const land = out3(win(t, 0.05, 0.85));
    column.position.y = 2.6 * (1 - land);
    column.scale.set(0.8 + 0.2 * land, 0.5 + 0.5 * land, 0.8 + 0.2 * land);
    spikes.rotation.y = t * 0.7;
    spikes.children.forEach((spike, i) => {
      spike.position.y = 0.52 + 0.3 * land + 0.05 * Math.sin(t * 5 + i);
      spike.scale.setScalar(0.4 + 0.6 * land);
    });
    dust.dots.forEach((d, i) => {
      const ang = d.a0 + t * 0.5;
      d.mesh.position.set(Math.cos(ang) * (0.9 + d.rf * 0.7), 0.15 + ((d.hf + t * 0.35) % 1) * 2.4, Math.sin(ang) * (0.9 + d.rf * 0.7));
    });
  });
  return fx.build();
}

// ---- 9. SHADOW STEP — you slip out of a shadow that should not be here ---------------------------
function shadowStep(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.6, 0x1e0a3a, 0.55);
  const ring = fxRing(1.2, 0.045, 0x9a6bff, 0.85);
  const shade = fxPane(1.5, 2.4, 0x6b3dff, 0.0);
  const smoke = new MoteEmitter({
    count: 24, color: 0x6b3dff, size: 0.11, life: 1.3, rate: 22, opacity: 0.5,
    spawn: (o) => shellSpawn(1.0, 0.25, 0.6)(o),
    velocity: driftVelocity(new THREE.Vector3(0, 0.7, 0), 0.4, 1.3),
    drag: 1.1,
  });
  const dots = fxDots(10, 0xbfa8ff, 0.05);
  fx.add(disc, ring, shade, smoke.points, dots.group).onDispose(() => smoke.dispose());
  fx.tick((t, dt) => {
    smoke.update(dt);
    const a = fade(t, 0.03, 0.4, 1.65, 2.35);
    matOf(disc).opacity = 0.55 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(dots.mat).opacity = 0.85 * a;
    // the shade itself: a dark pane that snaps in for a heartbeat and is gone
    const snap = win(t, 0.08, 0.22) * (1 - win(t, 0.5, 0.85));
    matOf(shade).opacity = 0.5 * snap;
    shade.rotation.y = 0.5 + Math.sin(t * 2.2) * 0.2;
    ring.rotation.z = -t * 0.9;
    dots.dots.forEach((d, i) => {
      const ang = d.a0 + t * d.sp * 1.5;
      d.mesh.position.set(Math.cos(ang) * (1 + d.rf * 0.5), 0.2 + ((d.hf + t * 0.4) % 1) * 2.2, Math.sin(ang) * (1 + d.rf * 0.5));
    });
  });
  return fx.build();
}

// ---- 10. TIDAL SURGE — a wave surges up and sets you down ----------------------------------------
function tidalSurge(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.65, 0x1a4a70, 0.45);
  const ring = fxRing(1.25, 0.05, 0x3da8ff, 0.85);
  const dome = fxDome(1.3, 0x4db8ff, 0.4);
  const foam = fxDots(14, 0xbfe9ff, 0.06);
  fx.add(disc, ring, dome, foam.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.65, 2.35);
    matOf(disc).opacity = 0.45 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(foam.mat).opacity = 0.9 * a;
    // the dome swells out of the ground, holds the body, then runs off
    const swell = outBack(win(t, 0.03, 0.8));
    const drain = win(t, 1.0, 1.7);
    dome.scale.setScalar(0.25 + swell * 0.95 + drain * 0.25);
    matOf(dome).opacity = 0.4 * a * (1 - drain * 0.7);
    ring.scale.setScalar(0.8 + swell * 0.3);
    foam.dots.forEach((d, i) => {
      const k = out3(win(t, 0.1 + d.hf * 0.3, 1.1 + d.hf * 0.3));
      const ang = d.a0 + d.sp * 0.3;
      const r = 0.4 + k * (1.4 + d.rf * 0.8);
      d.mesh.position.set(Math.cos(ang) * r, 0.15 + Math.sin(Math.min(1, k) * Math.PI) * (0.7 + d.hf), Math.sin(ang) * r);
    });
  });
  return fx.build();
}

// ---- 11. STARFALL — star streaks fall ahead of you, spelling arrival -----------------------------
function starfall(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.6, 0x243a66, 0.4);
  const ring = fxRing(1.2, 0.04, 0x9fb8ff, 0.85);
  const streaks = new THREE.Group();
  const streakList: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const streak = fxRod(0.06, 1.0, 0.06, 0xfff0b8, 0.9);
    const ang = (i / 5) * TAU + 0.4;
    streakList.push(streak);
    streaks.add(streak);
    streak.userData.ang = ang;
  }
  const burst = fxGem(0.4, 0xffffff, 0.9);
  burst.position.y = 0.7;
  const sparks = fxDots(12, 0xfff0b8, 0.05);
  fx.add(disc, ring, streaks, burst, sparks.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.65, 2.35);
    matOf(disc).opacity = 0.4 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(sparks.mat).opacity = 0.9 * a;
    // five streaks plunge in one after another and die at the deck
    streakList.forEach((streak, i) => {
      const ang = streak.userData.ang as number;
      const k = win(t, 0.06 + i * 0.1, 0.6 + i * 0.1);
      const fall = out3(k);
      const r = 1.15 - fall * 0.5;
      streak.position.set(Math.cos(ang) * r, 4.2 * (1 - fall) + 0.25, Math.sin(ang) * r);
      streak.rotation.z = 0.12 * (1 - fall);
      matOf(streak).opacity = 0.9 * a * (1 - win(t, 0.55 + i * 0.1, 0.75 + i * 0.1));
    });
    const glow = win(t, 0.45, 0.9) * (1 - win(t, 1.5, 2.0));
    burst.position.y = 0.5 + glow * 0.6;
    burst.rotation.y = t * 2;
    burst.scale.setScalar(0.4 + glow * 0.9 + 0.1 * Math.sin(t * 6));
    matOf(burst).opacity = 0.9 * glow * a;
    sparks.dots.forEach((d, i) => {
      const k = out3(win(t, 0.5, 1.3));
      const ang = d.a0 + d.sp * 0.4;
      const r = 0.2 + k * (0.9 + d.rf * 0.8);
      d.mesh.position.set(Math.cos(ang) * r, 0.4 + k * (0.7 + d.hf * 0.7), Math.sin(ang) * r);
    });
  });
  return fx.build();
}

// ---- 12. SPORE BURST — spores puff out from wherever you land ------------------------------------
function sporeBurst(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.55, 0x1e5a44, 0.4);
  const ring = fxRing(1.18, 0.04, 0x8fffb0, 0.8);
  const caps: THREE.Mesh[] = [];
  const capGroup = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const cap = fxDisc(0.22, 0xc8ffe0, 0.6);
    cap.rotation.x = -0.5;
    cap.position.set(Math.cos((i / 4) * TAU + 0.5) * 0.9, 0.5, Math.sin((i / 4) * TAU + 0.5) * 0.9);
    capGroup.add(cap);
    caps.push(cap);
  }
  const spores = fxDots(16, 0x9dffc4, 0.055);
  const puff = new MoteEmitter({
    count: 20, color: 0x7dffb0, size: 0.07, life: 1.2, rate: 14, opacity: 0.6,
    spawn: (o) => shellSpawn(0.7, 0.4, 0.5)(o),
    velocity: driftVelocity(new THREE.Vector3(0, 0.8, 0), 0.6, 1.6),
    drag: 1.0,
  });
  fx.add(disc, ring, capGroup, spores.group, puff.points).onDispose(() => puff.dispose());
  fx.tick((t, dt) => {
    puff.update(dt);
    const a = fade(t, 0.03, 0.35, 1.65, 2.35);
    matOf(disc).opacity = 0.4 * a;
    matOf(ring).opacity = 0.8 * a;
    matOf(spores.mat).opacity = 0.9 * a;
    // the spores puff outward and hover, caps bob in the cloud
    spores.dots.forEach((d, i) => {
      const k = out3(win(t, 0.05, 1.2));
      const ang = d.a0 + t * d.sp * 0.5;
      const r = 0.3 + k * (1.3 + d.rf * 0.9);
      d.mesh.position.set(Math.cos(ang) * r, 0.2 + d.hf * (0.9 + k * 0.9) + 0.06 * Math.sin(t * 3 + i), Math.sin(ang) * r);
    });
    caps.forEach((cap, i) => {
      cap.position.y = 0.5 + 0.25 * Math.sin(t * 2.4 + i * 1.7);
      cap.rotation.z = Math.sin(t * 1.8 + i) * 0.3;
    });
  });
  return fx.build();
}

// ---- 13. GEODE BLOOM — a geode of crystals grows to announce you ---------------------------------
function geodeBloom(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.55, 0x3a1a5a, 0.45);
  const ring = fxRing(1.2, 0.045, 0xd86bff, 0.85);
  const gems = new THREE.Group();
  const gemList: THREE.Mesh[] = [];
  for (let i = 0; i < 7; i++) {
    const gem = fxGem(0.2 + (i % 3) * 0.07, i % 2 === 0 ? 0xd86bff : 0x9a6bff, 0.9);
    const ang = (i / 7) * TAU + 0.3;
    const r = 0.35 + (i % 2) * 0.45;
    gem.position.set(Math.cos(ang) * r, 0.1, Math.sin(ang) * r);
    gem.rotation.y = ang;
    gem.userData.h = 0.5 + (i % 3) * 0.45;
    gems.add(gem);
    gemList.push(gem);
  }
  const dust = fxDots(10, 0xd8a8ff, 0.045);
  fx.add(disc, ring, gems, dust.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.65, 2.35);
    matOf(disc).opacity = 0.45 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(dust.mat).opacity = 0.85 * a;
    ring.rotation.z = t * 0.4;
    // the crystals push up out of the ground, one after another, pulsing as they settle
    gemList.forEach((gem, i) => {
      const k = outBack(win(t, 0.06 + i * 0.07, 0.75 + i * 0.07));
      const h = gem.userData.h as number;
      gem.scale.set(1, Math.max(0.05, k), 1);
      gem.position.y = k * h;
      gem.rotation.z = 0.12 * Math.sin(t * 3 + i);
      matOf(gem).opacity = 0.9 * a * (0.75 + 0.25 * Math.sin(t * 4 + i * 1.3));
    });
    dust.dots.forEach((d, i) => {
      const ang = d.a0 + t * d.sp * 0.7;
      d.mesh.position.set(Math.cos(ang) * (0.7 + d.rf * 0.9), 0.15 + ((d.hf + t * 0.3) % 1) * 2.0, Math.sin(ang) * (0.7 + d.rf * 0.9));
    });
  });
  return fx.build();
}

// ---- 14. WILD CHARGE — a cage of lightning cracks around your spawn ------------------------------
function wildCharge(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.6, 0x5a5212, 0.42);
  const ring = fxRing(1.22, 0.045, 0xffe14d, 0.85);
  const cage = new THREE.Group();
  const rods: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const rod = fxRod(0.05, 2.8, 0.05, 0xfff3a0, 0.85);
    rod.position.set(Math.cos((i / 6) * TAU) * 1.1, 1.4, Math.sin((i / 6) * TAU) * 1.1);
    rod.rotation.z = 0.14 * (i % 2 === 0 ? 1 : -1);
    cage.add(rod);
    rods.push(rod);
  }
  const core = fxGem(0.3, 0xffffff, 0.9);
  core.position.y = 1.1;
  const dots = fxDots(10, 0xffe98a, 0.05);
  fx.add(disc, ring, cage, core, dots.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.65, 2.35);
    matOf(disc).opacity = 0.42 * a;
    matOf(ring).opacity = 0.85 * a * (Math.sin(t * 31) > -0.3 ? 1 : 0.4);
    matOf(dots.mat).opacity = 0.9 * a;
    rods.forEach((rod, i) => {
      rod.position.x = Math.cos((i / 6) * TAU) * 1.1 + Math.sin(t * (19 + i)) * 0.05;
      rod.position.z = Math.sin((i / 6) * TAU) * 1.1 + Math.cos(t * (17 + i * 2)) * 0.05;
      rod.scale.y = 0.75 + 0.35 * Math.abs(Math.sin(t * 11 + i * 1.1));
      matOf(rod).opacity = 0.85 * a * (Math.sin(t * 13 + i * 2.4) > -0.4 ? 1 : 0.35);
    });
    core.rotation.y = t * 3.2;
    core.scale.setScalar(0.8 + 0.25 * Math.sin(t * 8) + 0.3 * win(t, 0.05, 0.8));
    matOf(core).opacity = 0.9 * a;
    dots.dots.forEach((d, i) => {
      const ang = d.a0 + t * d.sp * 3;
      d.mesh.position.set(Math.cos(ang) * 1.35, 0.3 + ((d.hf + t * 0.7) % 1) * 2.2, Math.sin(ang) * 1.35);
    });
  });
  return fx.build();
}

// ---- 15. ECHO WAVE — echo rings ripple off you as you step in ------------------------------------
function echoWave(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.55, 0x1a4a55, 0.38);
  const base = fxRing(1.15, 0.04, 0x7fe6ff, 0.8);
  const waves = [fxRing(0.7, 0.03, 0x7fe6ff, 0.0), fxRing(0.95, 0.026, 0xbfefff, 0.0), fxRing(1.2, 0.022, 0x7fe6ff, 0.0)];
  const dots = fxDots(10, 0xbfefff, 0.05);
  fx.add(disc, base, waves[0], waves[1], waves[2], dots.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.65, 2.35);
    matOf(disc).opacity = 0.38 * a;
    matOf(base).opacity = 0.8 * a;
    matOf(dots.mat).opacity = 0.85 * a;
    base.rotation.z = t * 0.5;
    // three rings ripple UP away from the body, one after another
    waves.forEach((w, i) => {
      const k = win(t, 0.1 + i * 0.25, 1.3 + i * 0.25);
      w.position.y = k * (1.6 + i * 0.4);
      w.scale.setScalar(0.5 + k * 1.3);
      matOf(w).opacity = (1 - k) * 0.75 * a;
    });
    dots.dots.forEach((d, i) => {
      const ang = d.a0 + t * d.sp * 0.9;
      d.mesh.position.set(Math.cos(ang) * (0.9 + d.rf * 0.7), 0.15 + ((d.hf + t * 0.4) % 1) * 2.3, Math.sin(ang) * (0.9 + d.rf * 0.7));
    });
  });
  return fx.build();
}

export const SPAWN_EFFECTS: AccessoryDef[] = [
  { id: 'spawn-dawn-ascent', name: 'DAWN ASCENT', desc: 'The dawn breaks at your feet as you arrive.', build: dawnAscent, duration: DUR },
  { id: 'spawn-thunderborn', name: 'THUNDERBORN', desc: 'You land with the storm already around you.', build: thunderborn, duration: DUR },
  { id: 'spawn-phoenix-rise', name: 'PHOENIX RISE', desc: 'A firebird unfurls where you take the field.', build: phoenixRise, duration: DUR },
  { id: 'spawn-meteor-impact', name: 'METEOR IMPACT', desc: 'You crash down like a meteor and the dust knows it.', build: meteorImpact, duration: DUR },
  { id: 'spawn-spirit-bloom', name: 'SPIRIT BLOOM', desc: 'Spirit petals bloom open as you join the fight.', build: spiritBloom, duration: DUR },
  { id: 'spawn-neon-grid', name: 'NEON GRID', desc: 'A neon grid snaps you on to the battlefield.', build: neonGrid, duration: DUR },
  { id: 'spawn-frozen-moment', name: 'FROZEN MOMENT', desc: 'Frost gathers, then bursts — you step out.', build: frozenMoment, duration: DUR },
  { id: 'spawn-royal-descent', name: 'ROYAL DESCENT', desc: 'A golden column lowers you onto the deck.', build: royalDescent, duration: DUR },
  { id: 'spawn-shadow-step', name: 'SHADOW STEP', desc: 'You slip out of a shadow that should not be here.', build: shadowStep, duration: DUR },
  { id: 'spawn-tidal-surge', name: 'TIDAL SURGE', desc: 'A wave surges up and sets you down.', build: tidalSurge, duration: DUR },
  { id: 'spawn-starfall', name: 'STARFALL', desc: 'Star streaks fall ahead of you, spelling arrival.', build: starfall, duration: DUR },
  { id: 'spawn-spore-burst', name: 'SPORE BURST', desc: 'Spores puff out from wherever you land.', build: sporeBurst, duration: DUR },
  { id: 'spawn-geode-bloom', name: 'GEODE BLOOM', desc: 'A geode of crystals grows to announce you.', build: geodeBloom, duration: DUR },
  { id: 'spawn-wild-charge', name: 'WILD CHARGE', desc: 'A cage of lightning cracks around your spawn.', build: wildCharge, duration: DUR },
  { id: 'spawn-echo-wave', name: 'ECHO WAVE', desc: 'Echo rings ripple off you as you step in.', build: echoWave, duration: DUR },
];
