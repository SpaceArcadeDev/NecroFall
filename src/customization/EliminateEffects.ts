// NECROFALL — ELIMINATED effect models (user ask 2026-09): one-shot cosmetics that play where a
// player is killed — the last thing the field remembers of them. Authored like every effect:
// origin on the ground, +Y up, animated purely from elapsed time, hero moment ≈ 1.17 s, gone by
// ~2.4 s.
import * as THREE from 'three';
import { AccessoryBuild, AccessoryDef } from './AccessoryTypes';
import { MoteEmitter, driftVelocity, shellSpawn } from './MoteEmitter';
import {
  Composer, TAU, fade, fxCol, fxCone, fxDisc, fxDome, fxDots, fxGem, fxPane, fxRing, fxRod,
  fxShards, in3, matOf, out3, outBack, pulse, win,
} from './EffectKit';

/** Every eliminated effect is a 2.4 s one-shot — the runner disposes the build after this. */
const DUR = 2.4;

// ---- 1. SOUL RELEASE — your soul slips free and drifts skyward -----------------------------------
function soulRelease(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.5, 0x1e4a38, 0.4);
  const ring = fxRing(1.15, 0.04, 0x9dffc4, 0.85);
  const shell = fxDome(0.9, 0x9dffc4, 0.25);
  const soul = new THREE.Group();
  const soulDots = fxDots(9, 0xe8fff2, 0.07);
  soul.add(soulDots.group);
  const wisp = new MoteEmitter({
    count: 20, color: 0xb8ffd8, size: 0.07, life: 1.5, rate: 12, opacity: 0.6,
    spawn: (o) => shellSpawn(0.35, 1.2, 0.5)(o),
    velocity: driftVelocity(new THREE.Vector3(0, 1.1, 0), 0.1, 0.5),
    drag: 0.35,
  });
  fx.add(disc, ring, shell, soul, wisp.points).onDispose(() => wisp.dispose());
  fx.tick((t, dt) => {
    wisp.update(dt);
    const a = fade(t, 0.03, 0.35, 1.7, 2.35);
    matOf(disc).opacity = 0.4 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(shell).opacity = 0.25 * a * (1 - win(t, 0.4, 1.2));
    matOf(soulDots.mat).opacity = 0.95 * a;
    // the soul: a knot of pale dots that rises and thins out as it climbs
    const rise = out3(win(t, 0.1, 1.5));
    soul.position.y = 0.6 + rise * 2.2;
    soul.scale.setScalar(1 + rise * 0.5);
    soul.rotation.y = t * 1.1;
    soulDots.dots.forEach((d, i) => {
      const ang = d.a0 + t * (1.2 + d.sp * 0.6);
      const r = 0.12 + d.rf * 0.3;
      d.mesh.position.set(Math.cos(ang) * r, d.hf * 0.7 + Math.sin(t * 2.5 + i) * 0.06, Math.sin(ang) * r);
    });
  });
  return fx.build();
}

// ---- 2. BLACK ROSE — black petals scatter where you fell -----------------------------------------
function blackRose(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.55, 0x2a0a12, 0.5);
  const ring = fxRing(1.18, 0.05, 0xff4d6b, 0.85);
  const core = fxGem(0.28, 0xff4d6b, 0.9);
  core.position.y = 0.5;
  const petals = new THREE.Group();
  const petalList: THREE.Mesh[] = [];
  for (let i = 0; i < 9; i++) {
    const petal = fxRod(0.34, 0.05, 0.2, 0x8a1030, 0.95);
    petals.add(petal);
    petalList.push(petal);
  }
  fx.add(disc, ring, core, petals);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.4, 1.7, 2.35);
    matOf(disc).opacity = 0.5 * a;
    matOf(ring).opacity = 0.85 * a;
    // the rose bursts: petals fly out, tumble, and drift down like burnt leaves
    petalList.forEach((petal, i) => {
      const base = (i / 9) * TAU + 0.2;
      const k = out3(win(t, 0.08 + (i % 3) * 0.06, 1.2));
      const r = 0.25 + k * (1.3 + (i % 3) * 0.22);
      const ang = base + k * 1.2;
      petal.position.set(Math.cos(ang) * r, 0.55 + k * (0.9 + (i % 2) * 0.5) - k * k * 1.1, Math.sin(ang) * r);
      petal.rotation.set(t * 2.2 + i, ang, t * 1.6 + i * 0.5);
      matOf(petal).opacity = 0.95 * a * (1 - k * 0.4);
    });
    const pop = win(t, 0.04, 0.3) * (1 - win(t, 0.6, 1.1));
    core.position.y = 0.45 + pop * 0.35;
    core.scale.setScalar(0.6 + pop * 0.9);
    core.rotation.y = t * 2.6;
    matOf(core).opacity = 0.9 * a * (1 - win(t, 0.7, 1.2));
  });
  return fx.build();
}

// ---- 3. SHATTERED GLASS — you leave the field as a burst of glass ---------------------------------
function shatteredGlass(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.5, 0x2a4a66, 0.4);
  const ring = fxRing(1.15, 0.035, 0xbfe9ff, 0.85);
  const pane = fxPane(1.4, 2.0, 0xdff2ff, 0.0);
  pane.position.y = 1.0;
  const shards = fxShards(14, 0xdff2ff, 0.15, 0.95);
  const sparks = fxDots(10, 0xffffff, 0.045);
  fx.add(disc, ring, pane, shards.group, sparks.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.7, 2.35);
    matOf(disc).opacity = 0.4 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(shards.mat).opacity = 0.95 * a;
    matOf(sparks.mat).opacity = 0.9 * a;
    // a pane of "glass" flashes for an instant, then the whole frame goes to pieces
    const flash = win(t, 0.05, 0.18) * (1 - win(t, 0.3, 0.6));
    matOf(pane).opacity = 0.4 * flash * a;
    pane.rotation.y = 0.35 + Math.sin(t * 3) * 0.1;
    shards.shards.forEach((s) => {
      const k = out3(win(t, 0.3, 1.4));
      const grav = k * k * 1.2;
      s.mesh.position.set(s.dir.x * k * 2.2, 1.0 + s.dir.y * k * 2.0 - grav, s.dir.z * k * 2.2);
      s.mesh.rotation.set(s.spin.x * k * 1.6, s.spin.y * k * 1.6, s.spin.z * k * 1.6);
      matOf(s.mesh).opacity = 0.95 * a;
    });
    sparks.dots.forEach((d) => {
      const k = out3(win(t, 0.32, 1.2));
      const ang = d.a0 + d.sp * 0.5;
      const r = 0.2 + k * (1.1 + d.rf * 0.8);
      d.mesh.position.set(Math.cos(ang) * r, 0.8 + k * (0.6 + d.hf) - k * k, Math.sin(ang) * r);
    });
  });
  return fx.build();
}

// ---- 4. ASH FALL — ash and embers carry you off the map ------------------------------------------
function ashFall(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.5, 0x3a2a1a, 0.42);
  const ring = fxRing(1.12, 0.04, 0xff7a2d, 0.75);
  // embers rise, ash falls — two emitters pointing opposite ways
  const embers = new MoteEmitter({
    count: 20, color: 0xff7a2d, size: 0.07, life: 1.1, rate: 14, opacity: 0.8,
    spawn: (o) => shellSpawn(0.5, 0.2, 0.5)(o),
    velocity: driftVelocity(new THREE.Vector3(0, 1.4, 0), 0.4, 1.2),
    drag: 0.8,
  });
  const ash = new MoteEmitter({
    count: 20, color: 0xb0a8a0, size: 0.06, life: 1.6, rate: 10, opacity: 0.5,
    spawn: (o) => shellSpawn(1.1, 2.2, 0.4)(o),
    velocity: driftVelocity(new THREE.Vector3(0, -0.5, 0), 0.1, 0.4),
    drag: 0.5,
  });
  const motes = fxDots(8, 0xffb08a, 0.05);
  fx.add(disc, ring, motes.group, embers.points, ash.points)
    .onDispose(() => { embers.dispose(); ash.dispose(); });
  fx.tick((t, dt) => {
    embers.update(dt);
    ash.update(dt);
    const a = fade(t, 0.03, 0.35, 1.7, 2.35);
    matOf(disc).opacity = 0.42 * a;
    matOf(ring).opacity = 0.75 * a * (0.9 + 0.1 * Math.sin(t * 5));
    matOf(motes.mat).opacity = 0.85 * a;
    ring.rotation.z = t * 0.3;
    ring.scale.setScalar(1 + 0.06 * Math.sin(t * 3.2));
    motes.dots.forEach((d) => {
      d.mesh.position.set(Math.cos(d.a0 + t * 0.3) * (0.6 + d.rf * 0.6), 0.2 + ((d.hf + t * 0.25) % 1) * 1.6, Math.sin(d.a0 + t * 0.3) * (0.6 + d.rf * 0.6));
    });
  });
  return fx.build();
}

// ---- 5. SOUL EATER — a green maw takes what the field releases -----------------------------------
function soulEater(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.55, 0x1a3a12, 0.5);
  const ring = fxRing(1.2, 0.05, 0x7dff6b, 0.85);
  const maw = fxDome(0.75, 0x4da83d, 0.4);
  const souls = fxDots(14, 0xb8ff8a, 0.055);
  fx.add(disc, ring, maw, souls.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.7, 2.35);
    matOf(disc).opacity = 0.5 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(souls.mat).opacity = 0.95 * a;
    // souls spiral IN to the maw, which pulses hungrily, then a final swallow-flash
    const pull = in3(win(t, 0.1, 1.5));
    matOf(maw).opacity = 0.4 * a * (0.7 + 0.3 * Math.sin(t * 5.5)) * (1 - win(t, 1.5, 1.9));
    maw.scale.setScalar(0.6 + 0.4 * pull + 0.06 * Math.sin(t * 8));
    souls.dots.forEach((d, i) => {
      const r = 2.2 * (1 - pull) * d.rf + 0.2;
      const ang = d.a0 + t * (1.2 + d.sp) * (1 + pull * 1.5);
      d.mesh.position.set(Math.cos(ang) * r, 0.25 + d.hf * 1.8 * (1 - pull * 0.6), Math.sin(ang) * r);
    });
    const swallow = win(t, 1.45, 1.65) * (1 - win(t, 1.75, 2.1));
    matOf(ring).opacity = (0.85 + swallow * 0.6) * a;
    ring.scale.setScalar(1 + swallow * 0.4);
  });
  return fx.build();
}

// ---- 6. CRIMSON FEAST — a crimson mist marks the end of the hunt ---------------------------------
function crimsonFeast(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.55, 0x4a0a16, 0.5);
  const ringA = fxRing(1.1, 0.05, 0xd01a3d, 0.85);
  const ringB = fxRing(1.4, 0.03, 0xff6b8a, 0.6);
  const streaks = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const rod = fxRod(0.05, 1.7, 0.05, 0xff4d6b, 0.6);
    rod.rotation.z = Math.PI / 2 - 0.25 - i * 0.1;
    rod.rotation.y = (i / 4) * TAU + 0.6;
    rod.position.y = 0.35 - i * 0.07;
    streaks.add(rod);
  }
  const mist = new MoteEmitter({
    count: 26, color: 0xb01030, size: 0.16, life: 1.2, rate: 30, opacity: 0.42,
    spawn: (o) => shellSpawn(0.6, 0.2, 0.7)(o),
    velocity: driftVelocity(new THREE.Vector3(0, 0.25, 0), 1.2, 2.4),
    drag: 2.0,
  });
  const drops = fxDots(10, 0xff6b8a, 0.05);
  fx.add(disc, ringA, ringB, streaks, drops.group, mist.points).onDispose(() => mist.dispose());
  fx.tick((t, dt) => {
    mist.update(dt);
    const a = fade(t, 0.03, 0.4, 1.7, 2.35);
    matOf(disc).opacity = 0.5 * a;
    matOf(ringA).opacity = 0.85 * a * (1 + 0.12 * Math.sin(t * 7));
    matOf(ringB).opacity = 0.6 * a * (0.8 + 0.2 * Math.sin(t * 4 + 1));
    matOf(drops.mat).opacity = 0.85 * a;
    ringA.scale.setScalar(1 + 0.07 * Math.sin(t * 5));
    streaks.rotation.y = t * 1.4;
    streaks.children.forEach((rod, i) => {
      rod.scale.y = 0.6 + 0.4 * Math.sin(t * 6 + i * 1.3) + 0.3;
    });
    drops.dots.forEach((d) => {
      const k = out3(win(t, 0.1, 1.3));
      const ang = d.a0 + d.sp * 0.3;
      const r = 0.3 + k * (1.1 + d.rf * 0.7);
      d.mesh.position.set(Math.cos(ang) * r, 0.25 + Math.sin(Math.min(1, k) * Math.PI) * (0.4 + d.hf), Math.sin(ang) * r);
    });
  });
  return fx.build();
}

// ---- 7. STAR COLLAPSE — you fold inward like a dying star ----------------------------------------
function starCollapse(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.6, 0x1e2a5a, 0.45);
  const ring = fxRing(1.2, 0.04, 0x9fb8ff, 0.8);
  const star = fxGem(0.42, 0xffffff, 0.0);
  star.position.y = 1.0;
  const gather = fxDots(16, 0xd8e4ff, 0.05);
  const shock = fxRing(0.5, 0.05, 0xffffff, 0.0);
  fx.add(disc, ring, star, gather.group, shock);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.7, 2.35);
    matOf(disc).opacity = 0.45 * a;
    matOf(ring).opacity = 0.8 * a;
    matOf(gather.mat).opacity = 0.95 * a;
    // everything falls inward onto a point that cannot hold it
    const pull = in3(win(t, 0.1, 1.25));
    gather.dots.forEach((d, i) => {
      const r = 2.6 * (1 - pull) * d.rf + 0.12;
      const ang = d.a0 + t * (2 + d.sp * 2) * (0.4 + pull);
      d.mesh.position.set(Math.cos(ang) * r, 0.6 + d.hf * 1.6 * (1 - pull) + 0.4 * (1 - pull) + pull * 0.4, Math.sin(ang) * r);
    });
    // the star blinks bright at the pinch point…
    const core = win(t, 1.05, 1.35) * (1 - win(t, 1.45, 1.8));
    star.position.y = 1.0;
    star.rotation.y = t * 3;
    star.scale.setScalar(0.3 + core * 1.3);
    matOf(star).opacity = 0.95 * core * a;
    // …and the collapse answers with one shock ring
    const sk = out3(win(t, 1.25, 2.0));
    shock.scale.setScalar(0.4 + sk * 3.2);
    shock.position.y = 0.15;
    matOf(shock).opacity = (1 - sk) * 0.8 * a * win(t, 1.2, 1.35);
  });
  return fx.build();
}

// ---- 8. THUNDERFALL — the sky answers with one last strike ---------------------------------------
function thunderfall(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.6, 0x1a2a4a, 0.42);
  const ring = fxRing(1.2, 0.05, 0x7fb0ff, 0.85);
  const bolt = fxRod(0.18, 5.6, 0.18, 0xffffff, 0.0);
  bolt.position.y = 2.8;
  const fall = fxCone(0.8, 1.6, 0xbfd8ff, 0.0);
  const sparks = fxDots(10, 0xd8e4ff, 0.05);
  fx.add(disc, ring, bolt, fall, sparks.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.7, 2.35);
    matOf(disc).opacity = 0.42 * a;
    matOf(ring).opacity = 0.85 * a * (1 + 0.1 * Math.sin(t * 5));
    matOf(sparks.mat).opacity = 0.9 * a;
    // ONE strike lands at ~0.6 s, in stutter-flashes; everything else is aftermath
    const strike = win(t, 0.55, 0.62) * (1 - win(t, 0.85, 1.15));
    matOf(bolt).opacity = 0.95 * strike * (Math.sin(t * 53) > -0.5 ? 1 : 0.2);
    bolt.scale.x = 0.6 + Math.random() * 1.0;
    bolt.scale.z = bolt.scale.x;
    matOf(fall).opacity = 0.5 * strike * (1 - win(t, 0.75, 1.05));
    fall.scale.set(1 + 0.2 * Math.sin(t * 31), 0.6 + 0.4 * win(t, 0.5, 0.7), 1 + 0.2 * Math.sin(t * 29));
    // the strike throws a fast ring and sparks
    const sk = out3(win(t, 0.6, 1.3));
    ring.scale.setScalar(0.8 + sk * 0.9);
    sparks.dots.forEach((d) => {
      const k = out3(win(t, 0.62, 1.3));
      const ang = d.a0 + d.sp * 0.4;
      const r = 0.2 + k * (1.3 + d.rf * 0.8);
      d.mesh.position.set(Math.cos(ang) * r, 0.15 + Math.sin(Math.min(1, k) * Math.PI) * (0.6 + d.hf), Math.sin(ang) * r);
    });
  });
  return fx.build();
}

// ---- 9. BONE STORM — bones scatter from the breaking point ---------------------------------------
function boneStorm(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.5, 0x3a3424, 0.45);
  const ring = fxRing(1.15, 0.04, 0xe8e0c8, 0.8);
  const bones = fxShards(12, 0xe8e0c8, 0.17, 0.95);
  bones.mat.color.setHex(0xe8e0c8);
  const dust = fxDots(10, 0x8a7f63, 0.06);
  fx.add(disc, ring, bones.group, dust.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.7, 2.35);
    matOf(disc).opacity = 0.45 * a;
    matOf(ring).opacity = 0.8 * a;
    matOf(bones.mat).opacity = 0.95 * a;
    matOf(dust.mat).opacity = 0.7 * a;
    // bones tumble out and drop, spinning like a broken puppet cut loose
    bones.shards.forEach((s) => {
      const k = out3(win(t, 0.08, 1.25));
      const grav = k * k * 1.6;
      s.mesh.position.set(s.dir.x * k * 2.0, 0.9 + s.dir.y * k * 1.9 - grav + s.hf * 0.3, s.dir.z * k * 2.0);
      s.mesh.rotation.set(s.spin.x * k * 2, s.spin.y * k * 2, s.spin.z * k * 2);
    });
    dust.dots.forEach((d) => {
      const k = out3(win(t, 0.1, 1.3));
      const ang = d.a0 + d.sp * 0.3;
      const r = 0.3 + k * (1.2 + d.rf * 0.7);
      d.mesh.position.set(Math.cos(ang) * r, 0.15 + d.hf * 0.7 * (1 - k * 0.3), Math.sin(ang) * r);
    });
  });
  return fx.build();
}

// ---- 10. VOID GRIP — dark tendrils drag your last spark under ------------------------------------
function voidGrip(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.6, 0x12042a, 0.6);
  const ring = fxRing(1.15, 0.05, 0x6b2dff, 0.8);
  const tendrils = new THREE.Group();
  const arms: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const arm = fxRod(0.14, 2.2, 0.14, 0x3a0a6b, 0.95);
    const ang = (i / 4) * TAU + 0.5;
    arm.position.set(Math.cos(ang) * 1.05, 1.1, Math.sin(ang) * 1.05);
    arm.rotation.z = 0.5;
    arm.rotation.y = -ang;
    tendrils.add(arm);
    arms.push(arm);
  }
  const spark = fxGem(0.24, 0xb44dff, 0.9);
  spark.position.y = 0.9;
  const motes = fxDots(9, 0x9a6bff, 0.05);
  fx.add(disc, ring, tendrils, spark, motes.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.4, 1.7, 2.35);
    matOf(disc).opacity = 0.6 * a;
    matOf(ring).opacity = 0.8 * a;
    matOf(motes.mat).opacity = 0.85 * a;
    // tendrils rise, hesitate, then snap inward over the spark
    const rise = out3(win(t, 0.05, 0.9));
    const snap = in3(win(t, 0.95, 1.45));
    arms.forEach((arm, i) => {
      const ang = (i / 4) * TAU + 0.5;
      const r = 1.05 - snap * 0.75;
      arm.position.set(Math.cos(ang) * r, 0.6 + rise * 0.7 + Math.sin(t * 2.4 + i) * 0.08, Math.sin(ang) * r);
      arm.rotation.z = 0.5 - snap * 1.1;
      arm.scale.y = 0.6 + rise * 0.5;
      matOf(arm).opacity = 0.95 * a * (0.85 + 0.15 * Math.sin(t * 6 + i * 1.8));
    });
    const dim = win(t, 0.95, 1.5);
    spark.position.y = 0.9 - dim * 0.5;
    spark.rotation.y = t * 2.4;
    spark.scale.setScalar((0.7 + 0.3 * Math.sin(t * 6)) * (1 - dim * 0.7));
    matOf(spark).opacity = 0.9 * a * (1 - dim * 0.8);
    motes.dots.forEach((d) => {
      const k = win(t, 0.9, 1.6);
      const ang = d.a0 + t * (1 + d.sp) * (0.5 + k);
      const r = (1.6 * d.rf + 0.3) * (1 - k);
      d.mesh.position.set(Math.cos(ang) * r, 0.9 + d.hf * 1.4 - k * 0.6, Math.sin(ang) * r);
    });
  });
  return fx.build();
}

// ---- 11. GOLDEN CROWN — a crown falls and scatters into gold -------------------------------------
function goldenCrown(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.55, 0x6b5212, 0.5);
  const ring = fxRing(1.2, 0.045, 0xffd23d, 0.85);
  const crown = new THREE.Group();
  const crownRing = fxRing(0.45, 0.06, 0xffd23d, 0.9);
  crownRing.rotation.x = Math.PI / 2;
  crownRing.position.y = 0.1;
  crown.add(crownRing);
  const tips: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const tip = fxRod(0.07, 0.36, 0.07, 0xfff2b8, 0.95);
    const ang = (i / 5) * TAU;
    tip.position.set(Math.cos(ang) * 0.45, 0.28, Math.sin(ang) * 0.45);
    crown.add(tip);
    tips.push(tip);
  }
  crown.position.y = 1.3;
  const coins = fxDots(14, 0xffe08a, 0.055);
  fx.add(disc, ring, crown, coins.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.4, 1.7, 2.35);
    matOf(disc).opacity = 0.5 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(coins.mat).opacity = 0.95 * a;
    // the crown descends, hovers for the hero beat, then blows apart into coin sparks
    const desc = out3(win(t, 0.05, 0.85));
    const fall = win(t, 1.1, 1.6);
    crown.position.y = 1.9 - desc * 0.6 - fall * 1.2;
    crown.rotation.y = t * 1.4;
    crown.scale.setScalar((0.7 + 0.4 * desc) * (1 - fall * 0.6));
    crown.children.forEach((part) => { matOf(part).opacity = (1 - fall) * a * 0.9; });
    coins.dots.forEach((d, i) => {
      const k = out3(win(t, 1.15, 1.9));
      const grav = k * k * 1.8;
      const ang = d.a0 + i;
      const r = k * (1.2 + d.rf * 0.9);
      d.mesh.position.set(Math.cos(ang) * r, 1.1 + k * (1.1 + d.hf * 0.8) - grav + 0.2, Math.sin(ang) * r);
    });
  });
  return fx.build();
}

// ---- 12. FROST SHATTER — you freeze, crack, and shatter away -------------------------------------
function frostShatter(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.55, 0x2a5a70, 0.45);
  const ring = fxRing(1.18, 0.04, 0xaef2ff, 0.85);
  const shell = fxDome(1.05, 0xcff2ff, 0.4);
  const shards = fxShards(12, 0xdff6ff, 0.14, 0.95);
  const mist = fxDots(10, 0xd8f6ff, 0.055);
  fx.add(disc, ring, shell, shards.group, mist.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.7, 2.35);
    matOf(disc).opacity = 0.45 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(shards.mat).opacity = 0.95 * a;
    matOf(mist.mat).opacity = 0.75 * a;
    // a shell of ice slams over the body, holds, and bursts
    const freeze = out3(win(t, 0.03, 0.35));
    const burst = win(t, 0.95, 1.5);
    shell.scale.setScalar(freeze * (1 - burst * 0.5));
    matOf(shell).opacity = 0.4 * a * (1 - win(t, 0.85, 1.35));
    shards.shards.forEach((s) => {
      const k = out3(burst);
      s.mesh.position.set(s.dir.x * k * 2.3, 0.9 + s.dir.y * k * 2.1 - k * k * 1.0, s.dir.z * k * 2.3);
      s.mesh.rotation.set(s.spin.x * k * 1.8, s.spin.y * k * 1.8, s.spin.z * k * 1.8);
    });
    mist.dots.forEach((d) => {
      const ang = d.a0 + t * 0.35;
      d.mesh.position.set(Math.cos(ang) * (1.1 + d.rf * 0.4), 0.15 + d.hf * 0.6, Math.sin(ang) * (1.1 + d.rf * 0.4));
    });
  });
  return fx.build();
}

// ---- 13. PYRE BLOOM — your pyre blooms into one final flower -------------------------------------
function pyreBloom(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.6, 0x6b2a08, 0.5);
  const ring = fxRing(1.2, 0.05, 0xff7a2d, 0.9);
  const petals = new THREE.Group();
  const petalList: THREE.Mesh[] = [];
  for (let i = 0; i < 8; i++) {
    const petal = fxRod(0.44, 0.06, 0.18, 0xffb03d, 0.9);
    petal.position.y = 0.5;
    petals.add(petal);
    petalList.push(petal);
  }
  const core = fxCone(0.4, 2.2, 0xffd23d, 0.5);
  const embers = new MoteEmitter({
    count: 22, color: 0xff9d3d, size: 0.07, life: 1.0, rate: 18, opacity: 0.85,
    spawn: (o) => shellSpawn(0.5, 0.7, 0.5)(o),
    velocity: driftVelocity(new THREE.Vector3(0, 1.3, 0), 0.5, 1.6),
    drag: 0.9,
  });
  fx.add(disc, ring, petals, core, embers.points).onDispose(() => embers.dispose());
  fx.tick((t, dt) => {
    embers.update(dt);
    const a = fade(t, 0.03, 0.4, 1.7, 2.35);
    matOf(disc).opacity = 0.5 * a;
    matOf(ring).opacity = 0.9 * a * (1 + 0.1 * Math.sin(t * 6));
    matOf(core).opacity = 0.5 * a * (0.8 + 0.2 * Math.sin(t * 9));
    // flame petals open low and wide, a cone of fire feeding them from the centre
    const open = out3(win(t, 0.08, 1.05));
    petalList.forEach((petal, i) => {
      const ang = (i / 8) * TAU;
      const r = 0.25 + open * 0.9;
      petal.position.set(Math.cos(ang) * r, 0.35 + open * 0.3 + 0.06 * Math.sin(t * 4 + i), Math.sin(ang) * r);
      petal.rotation.z = -open * 0.7;
      petal.rotation.y = -ang + t * 0.2;
      matOf(petal).opacity = 0.9 * a * (0.75 + 0.25 * Math.sin(t * 5 + i * 1.4));
    });
    core.scale.set(0.7 + 0.3 * Math.sin(t * 8), 0.4 + 0.7 * open, 0.7 + 0.3 * Math.sin(t * 8));
  });
  return fx.build();
}

// ---- 14. HOLLOW TOLL — a hollow bell rings out your last breath ----------------------------------
function hollowToll(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.55, 0x1a4a4a, 0.45);
  const ring = fxRing(1.18, 0.045, 0x4dc4c4, 0.8);
  const bell = fxDome(0.85, 0x7fe0d8, 0.35);
  const bellRing = fxRing(0.85, 0.03, 0xbfefe9, 0.7);
  bellRing.position.y = 0.35;
  const waves = [fxRing(0.9, 0.03, 0xbfefe9, 0.0), fxRing(1.15, 0.026, 0x7fe0d8, 0.0), fxRing(1.4, 0.022, 0x4dc4c4, 0.0)];
  const motes = fxDots(9, 0xbfefe9, 0.05);
  fx.add(disc, ring, bell, bellRing, waves[0], waves[1], waves[2], motes.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.4, 1.7, 2.35);
    matOf(disc).opacity = 0.45 * a;
    matOf(ring).opacity = 0.8 * a;
    matOf(motes.mat).opacity = 0.8 * a;
    // the toll: the bell throbs at 1.0 s and 1.7 s, and sound rings run out across the ground
    const toll = Math.max(pulse(win(t, 0.95, 1.35)), 0.6 * pulse(win(t, 1.65, 2.0)));
    bell.scale.setScalar(1 + toll * 0.25);
    matOf(bell).opacity = 0.35 * a * (0.7 + 0.5 * toll);
    matOf(bellRing).opacity = 0.7 * a * (0.8 + 0.4 * toll);
    bellRing.scale.setScalar(1 + toll * 0.15);
    waves.forEach((w, i) => {
      const k = win(t, 0.95 + i * 0.18, 1.9 + i * 0.18);
      w.scale.setScalar(0.6 + out3(k) * 1.7);
      matOf(w).opacity = (1 - k) * 0.7 * a * win(t, 0.9, 1.0);
    });
    motes.dots.forEach((d) => {
      const ang = d.a0 + t * d.sp * 0.6;
      d.mesh.position.set(Math.cos(ang) * (0.9 + d.rf * 0.6), 0.15 + ((d.hf + t * 0.25) % 1) * 1.9, Math.sin(ang) * (0.9 + d.rf * 0.6));
    });
  });
  return fx.build();
}

// ---- 15. SYSTEM FAILURE — your signal fails, in red and static -----------------------------------
function systemFailure(): AccessoryBuild {
  const fx = new Composer();
  const disc = fxDisc(1.55, 0x4a0a1a, 0.5);
  const ring = fxRing(1.16, 0.045, 0xff4d6b, 0.85);
  const scan = fxPane(1.6, 2.4, 0xff6b8a, 0.0);
  scan.position.y = 1.1;
  const blocks: THREE.Mesh[] = [];
  const blockGroup = new THREE.Group();
  for (let i = 0; i < 8; i++) {
    const b = fxRod(0.16 + Math.random() * 0.24, 0.16, 0.03, i % 2 === 0 ? 0xff4d6b : 0x4dfff0, 0.9);
    b.position.set((Math.random() - 0.5) * 2.0, 0.3 + Math.random() * 2.0, (Math.random() - 0.5) * 2.0);
    blockGroup.add(b);
    blocks.push(b);
  }
  const motes = fxDots(10, 0xff8aa0, 0.05);
  fx.add(disc, ring, scan, blockGroup, motes.group);
  fx.tick((t) => {
    const a = fade(t, 0.03, 0.35, 1.7, 2.35);
    matOf(disc).opacity = 0.5 * a;
    matOf(ring).opacity = 0.85 * a;
    matOf(motes.mat).opacity = 0.9 * a;
    // a scanline sweeps the body once while error blocks strobe out of sync
    const sweep = win(t, 0.15, 1.1);
    scan.position.y = 2.2 - sweep * 2.0;
    matOf(scan).opacity = 0.35 * a * win(t, 0.1, 0.25) * (1 - win(t, 0.9, 1.2));
    blocks.forEach((b, i) => {
      const blink = Math.sin(t * (16 + i * 4) + i * 2.7) > 0.1;
      b.visible = blink;
      b.position.x += Math.sin(t * (5 + i)) * 0.01;
      b.rotation.y = t * (3 + i * 0.6);
      b.scale.setScalar(0.7 + 0.5 * Math.abs(Math.sin(t * 8 + i * 1.9)));
    });
    ring.rotation.z = -t * 1.1;
    ring.scale.setScalar(1 + 0.05 * Math.sin(t * 17));
    motes.dots.forEach((d) => {
      const ang = d.a0 + t * d.sp * 1.8;
      d.mesh.position.set(Math.cos(ang) * (1.1 + d.rf * 0.5), 0.2 + ((d.hf + t * 0.45) % 1) * 2.2, Math.sin(ang) * (1.1 + d.rf * 0.5));
    });
  });
  return fx.build();
}

export const ELIMINATE_EFFECTS: AccessoryDef[] = [
  { id: 'elim-soul-release', name: 'SOUL RELEASE', desc: 'Your soul slips free and drifts skyward.', build: soulRelease, duration: DUR },
  { id: 'elim-black-rose', name: 'BLACK ROSE', desc: 'Black petals scatter where you fell.', build: blackRose, duration: DUR },
  { id: 'elim-shattered-glass', name: 'SHATTERED GLASS', desc: 'You leave the field as a burst of glass.', build: shatteredGlass, duration: DUR },
  { id: 'elim-ash-fall', name: 'ASH FALL', desc: 'Ash and embers carry you off the map.', build: ashFall, duration: DUR },
  { id: 'elim-soul-eater', name: 'SOUL EATER', desc: 'A green maw takes what the field releases.', build: soulEater, duration: DUR },
  { id: 'elim-crimson-feast', name: 'CRIMSON FEAST', desc: 'A crimson mist marks the end of the hunt.', build: crimsonFeast, duration: DUR },
  { id: 'elim-star-collapse', name: 'STAR COLLAPSE', desc: 'You fold inward like a dying star.', build: starCollapse, duration: DUR },
  { id: 'elim-thunderfall', name: 'THUNDERFALL', desc: 'The sky answers with one last strike.', build: thunderfall, duration: DUR },
  { id: 'elim-bone-storm', name: 'BONE STORM', desc: 'Bones scatter from the breaking point.', build: boneStorm, duration: DUR },
  { id: 'elim-void-grip', name: 'VOID GRIP', desc: 'Dark tendrils drag your last spark under.', build: voidGrip, duration: DUR },
  { id: 'elim-golden-crown', name: 'GOLDEN CROWN', desc: 'A crown falls and scatters into gold.', build: goldenCrown, duration: DUR },
  { id: 'elim-frost-shatter', name: 'FROST SHATTER', desc: 'You freeze, crack, and shatter away.', build: frostShatter, duration: DUR },
  { id: 'elim-pyre-bloom', name: 'PYRE BLOOM', desc: 'Your pyre blooms into one final flower.', build: pyreBloom, duration: DUR },
  { id: 'elim-hollow-toll', name: 'HOLLOW TOLL', desc: 'A hollow bell rings out your last breath.', build: hollowToll, duration: DUR },
  { id: 'elim-system-failure', name: 'SYSTEM FAILURE', desc: 'Your signal fails — in red and static.', build: systemFailure, duration: DUR },
];
