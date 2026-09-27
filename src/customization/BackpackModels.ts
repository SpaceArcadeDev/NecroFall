// NECROFALL — BACKPACK models. Origin = the pack mount on the player's back (the little box the
// factory body ships with, at y 1.15 / z −0.28 in body space). The body faces +Z, so a backpack
// extends into −Z and spreads across ±X; wings pivot at the shoulder blades and fan up and out.
import * as THREE from 'three';
import { AccessoryBuild, AccessoryDef } from './AccessoryTypes';
import { ball, box, cloth, cone, cyl, flat, glow, hangChain, slab, torus } from './AccessoryKit';
import { MoteEmitter, driftVelocity, shellSpawn } from './MoteEmitter';

/** Every flap/wave animation reads this: the owner writes its horizontal speed before `tick`. */
function hSpeedOf(g: THREE.Group): number {
  return typeof g.userData.hSpeed === 'number' ? (g.userData.hSpeed as number) : 0;
}

/**
 * A tapered feather silhouette pointing along local +Y from its root — a real leaf/feather shape
 * instead of a box, which is the whole difference between "stack of planks" and "wing".
 */
function featherMesh(len: number, width: number, mat: THREE.Material): THREE.Mesh {
  return slab(
    [
      [-width * 0.5, 0],
      [width * 0.55, len * 0.3],
      [width * 0.5, len * 0.78],
      [0, len],
      [-width * 0.45, len * 0.82],
      [-width * 0.55, len * 0.34],
    ],
    0.012, mat
  );
}

/** A bone cylinder between two points of the wing plane (local +Y aimed along the segment). */
function boneTo(
  parent: THREE.Object3D,
  x1: number, y1: number, x2: number, y2: number,
  r: number, mat: THREE.Material, z = 0
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const bone = cyl(r * 0.72, r, len, mat, 0, 0, 0, 6);
  bone.position.set((x1 + x2) / 2, (y1 + y2) / 2, z);
  bone.rotation.z = Math.atan2(dy, dx) - Math.PI / 2;
  parent.add(bone);
}

/** A small claw at a wing-bone tip, aimed along the bone. */
function clawAt(
  parent: THREE.Object3D,
  x1: number, y1: number, x2: number, y2: number,
  r: number, mat: THREE.Material, z = 0
): void {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const claw = cone(r, 0.075, mat, 0, 0, z, 5);
  claw.position.set(x2 + Math.cos(a) * 0.03, y2 + Math.sin(a) * 0.03, z);
  claw.rotation.z = a - Math.PI / 2;
  parent.add(claw);
}

// ---- 1. ANGEL WINGS — the open-wing silhouette, brightened up ------------------------------------
function angelWings(): AccessoryBuild {
  const g = new THREE.Group();
  // The feathers carry a warm emissive so they stay readable against dark terrain and night skies —
  // a plain white lambert wing disappears the moment it leaves the base lights.
  const primaryMat = flat(0xf8f3e6, 0xffe9c0, 0.2);
  const primaryMatB = flat(0xeadfc2, 0xffe0b0, 0.16);
  const secondaryMat = flat(0xefe5cd, 0xffdfae, 0.14);
  const covertMat = flat(0xe2d6b6, 0xffd9a0, 0.12);
  const boneMat = flat(0xe9dec2, 0xffe6b8, 0.15);
  const mkWing = (side: number): { root: THREE.Group; anim: (t: number) => void } => {
    const root = new THREE.Group();
    root.position.set(side * 0.1, 0.3, -0.22);
    root.rotation.z = side * -0.26;
    root.rotation.y = side * 0.2;
    const S = (x: number): number => side * x;
    // the leading edge holds itself UP as it reaches out — a wing that droops reads as a cape
    boneTo(root, 0, 0, S(0.3), 0.06, 0.04, boneMat);
    boneTo(root, S(0.3), 0.06, S(0.58), 0.18, 0.03, boneMat);
    const sway: { mesh: THREE.Mesh; base: number; ph: number }[] = [];
    // Feathers cascade from the arm: `phi` is the angle from straight-down, so the inner feathers
    // hang steeply and the outer ones sweep out — the classic open-wing fan.
    const hangFeather = (
      x: number, y: number, phi: number, len: number, width: number, mat: THREE.Material, z: number
    ): void => {
      const f = featherMesh(len, width, mat);
      f.position.set(S(x), y, z);
      f.rotation.z = side * (phi - Math.PI);
      root.add(f);
      sway.push({ mesh: f, base: f.rotation.z, ph: x * 9 + y * 6 });
    };
    // primaries: ten long flight feathers, biggest at the wing tip and shingled with a small z
    // offset so the row reads as overlapping feathers rather than one white sheet
    for (let i = 0; i < 10; i++) {
      const k = i / 9;
      hangFeather(0.08 + k * 0.5, 0.02 + k * 0.15, 0.45 + k * 0.85, 0.4 + k * 0.28, 0.085, i % 2 ? primaryMatB : primaryMat, i % 2 ? 0.008 : -0.008);
    }
    // secondaries: the middle row, filling the gap between the primaries and the shoulder
    for (let i = 0; i < 8; i++) {
      const k = i / 7;
      hangFeather(0.04 + k * 0.42, 0.01 + k * 0.11, 0.32 + k * 0.7, 0.3 + k * 0.2, 0.082, secondaryMat, 0.024);
    }
    // coverts: the small shoulder feathers that close the top of the wing
    for (let i = 0; i < 6; i++) {
      const k = i / 5;
      hangFeather(0.02 + k * 0.26, 0.0 + k * 0.06, 0.25 + k * 0.5, 0.17 + k * 0.11, 0.078, covertMat, 0.05);
    }
    return {
      root,
      anim: (t: number): void => {
        const flap = Math.sin(t * 1.4);
        root.rotation.z = side * (-0.26 + flap * 0.1);
        root.rotation.y = side * (0.2 + Math.sin(t * 1.4 + 0.5) * 0.06);
        // feathers lag a hair behind the flap, so the wing ripples instead of pivoting as a board
        for (const s of sway) s.mesh.rotation.z = s.base + Math.sin(t * 1.7 + s.ph) * 0.03;
      },
    };
  };
  const L = mkWing(-1);
  const R = mkWing(1);
  g.add(L.root, R.root);
  const motes = new MoteEmitter({
    count: 22, color: 0xfff3c8, size: 0.055, life: 2.2, rate: 3.5, opacity: 0.75,
    spawn: (out: THREE.Vector3) => out.set((Math.random() - 0.5) * 2.6, -0.1 + Math.random() * 0.7, -0.2 - Math.random() * 0.2),
    velocity: driftVelocity(new THREE.Vector3(0, -1, 0), 0.04, 0.14), gravity: -0.1, drag: 0.5,
  });
  g.add(motes.points);
  return {
    group: g,
    tick: (t, dt) => {
      L.anim(t);
      R.anim(t);
      motes.update(dt);
    },
    dispose: () => motes.dispose(),
  };
}

// ---- 2. DEMON WINGS — a scalloped bat membrane over real finger bones ---------------------------
function demonWings(): AccessoryBuild {
  const g = new THREE.Group();
  const boneMat = flat(0x2c171e);
  const membraneMat = cloth(0x5c1420, 0x2a0508);
  const mkWing = (side: number): { root: THREE.Group; anim: (t: number) => void } => {
    const root = new THREE.Group();
    root.position.set(side * 0.09, 0.2, -0.18);
    root.rotation.z = side * -0.18;
    root.rotation.y = side * 0.3;
    const S = (x: number): number => side * x;
    // one membrane with a SCALLOPED trailing edge: it dips between the finger tips, which is what
    // makes a bat wing read as a wing and not as a red flag. WIDE on purpose — an open demon wing
    // should reach well past the shoulders.
    const membrane = slab(
      [
        [0, 0.02], [S(0.32), 0.1], [S(0.62), 0.02], [S(1.05), -0.3],
        [S(0.867), -0.253], [S(0.95), -0.5], [S(0.747), -0.357], [S(0.68), -0.62], [S(0.458), -0.364], [S(0.06), -0.52],
      ],
      0.018, membraneMat
    );
    root.add(membrane);
    // the skeleton lies INSIDE the membrane (radius > half thickness) so it reads from the front
    // AND from behind — the two angles the wing is actually seen from in a match
    boneTo(root, 0, 0.02, S(0.32), 0.1, 0.036, boneMat);
    boneTo(root, S(0.32), 0.1, S(0.62), 0.02, 0.028, boneMat);
    boneTo(root, S(0.62), 0.02, S(1.05), -0.3, 0.02, boneMat);
    boneTo(root, S(0.62), 0.02, S(0.95), -0.5, 0.018, boneMat);
    boneTo(root, S(0.62), 0.02, S(0.68), -0.62, 0.016, boneMat);
    // the thumb hook at the wrist
    boneTo(root, S(0.62), 0.02, S(0.69), 0.24, 0.014, boneMat);
    clawAt(root, S(0.62), 0.02, S(1.05), -0.3, 0.02, boneMat);
    clawAt(root, S(0.62), 0.02, S(0.95), -0.5, 0.018, boneMat);
    clawAt(root, S(0.62), 0.02, S(0.68), -0.62, 0.016, boneMat);
    clawAt(root, S(0.62), 0.02, S(0.69), 0.24, 0.014, boneMat);
    return {
      root,
      anim: (t: number): void => {
        const flap = Math.sin(t * 2.2);
        root.rotation.z = side * (-0.18 + flap * 0.24);
        root.rotation.y = side * (0.3 + flap * 0.12);
        // the membrane breathes a little against the frame
        membrane.rotation.x = Math.sin(t * 2.6) * 0.06;
      },
    };
  };
  const L = mkWing(-1);
  const R = mkWing(1);
  g.add(L.root, R.root);
  const embers = new MoteEmitter({
    count: 20, color: 0xff4a2a, size: 0.06, life: 1.4, rate: 3.5, opacity: 0.85,
    spawn: (out: THREE.Vector3) => out.set((Math.random() - 0.5) * 2.2, 0.0 + Math.random() * 0.6, -0.2 - Math.random() * 0.3),
    velocity: driftVelocity(new THREE.Vector3(0, 1, 0), 0.1, 0.35), gravity: 0.35, drag: 0.8,
  });
  g.add(embers.points);
  return {
    group: g,
    tick: (t, dt) => {
      L.anim(t);
      R.anim(t);
      embers.update(dt);
    },
    dispose: () => embers.dispose(),
  };
}

// ---- 3. VOID TENTACLES ---------------------------------------------------------------------------
function voidTentacles(): AccessoryBuild {
  const g = new THREE.Group();
  const fleshMat = flat(0x51247a);
  const tipMat = flat(0x7b3fd0, 0x2a0846, 0.5);
  const chains: { joints: THREE.Group[]; phase: number; base: THREE.Euler }[] = [];
  const roots: THREE.Group[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const chain = hangChain(4, 0.17, 0.05, 0.018, i % 2 === 0 ? fleshMat : tipMat, 6);
    const root = chain[0];
    root.position.set(Math.cos(a) * 0.16, 0.1 - (i % 2) * 0.14, -0.08 - Math.abs(Math.sin(a)) * 0.06);
    root.rotation.z = -Math.cos(a) * 0.55;
    root.rotation.x = 1.15 + Math.sin(a) * 0.3;   // swing the chain backwards away from the spine
    roots.push(root);
    g.add(root);
    chains.push({ joints: chain.slice(1), phase: i * 1.37, base: new THREE.Euler() });
  }
  const slime = new MoteEmitter({
    count: 16, color: 0xa64dff, size: 0.05, life: 1.5, rate: 2.5, opacity: 0.65,
    spawn: shellSpawn(0.24, -0.4, 0.7), velocity: driftVelocity(new THREE.Vector3(0, -1, 0), 0.03, 0.12), gravity: -0.25, drag: 0.6,
  });
  g.add(slime.points);
  return {
    group: g,
    tick: (t, dt) => {
      slime.update(dt);
      for (const c of chains) {
        for (let j = 0; j < c.joints.length; j++) {
          const w = Math.sin(t * (1.5 + j * 0.45) + c.phase + j * 0.8);
          c.joints[j].rotation.x = 0.22 + w * 0.3;
          c.joints[j].rotation.z = Math.cos(t * (1.1 + j * 0.3) + c.phase) * 0.22;
        }
      }
    },
    dispose: () => slime.dispose(),
  };
}

// ---- 4. BONE WINGS -------------------------------------------------------------------------------
function boneWings(): AccessoryBuild {
  const g = new THREE.Group();
  const boneMat = flat(0xcfc3a2);
  const webbingMat = cloth(0x6a6a52);
  const mkWing = (side: number): { root: THREE.Group; anim: (t: number) => void } => {
    const root = new THREE.Group();
    root.position.set(side * 0.1, 0.18, -0.12);
    root.rotation.z = side * -0.85;
    const humerus = cyl(0.03, 0.045, 0.34, boneMat, 0, 0.17, 0, 5);
    root.add(humerus);
    const elbow = new THREE.Group();
    elbow.position.y = 0.34;
    const forearm = cyl(0.02, 0.032, 0.3, boneMat, 0, 0.15, 0, 5);
    elbow.add(forearm);
    root.add(elbow);
    for (let i = 0; i < 3; i++) {
      const len = 0.5 - i * 0.08;
      const finger = cyl(0.012, 0.022, len, boneMat, 0, 0.05 + i * 0.09, -0.02, 5);
      finger.rotation.z = -side * (0.55 + i * 0.28);
      finger.position.set(side * 0.12 * (1 + i * 0.5), 0.3 + i * 0.07, -0.02);
      root.add(finger);
      const web = slab(
        [[0.02 * side, 0.06], [side * 0.16, 0.3], [side * 0.34, 0.2], [side * 0.22, -0.02]],
        0.012, webbingMat
      );
      web.position.set(side * (0.16 + i * 0.1), 0.26 + i * 0.08, -0.03);
      root.add(web);
    }
    return {
      root,
      anim: (t: number): void => {
        root.rotation.z = side * (-0.85 + Math.sin(t * 1.25) * 0.16);
        elbow.rotation.z = side * (Math.sin(t * 1.25 + 0.6) * 0.18);
      },
    };
  };
  const L = mkWing(-1);
  const R = mkWing(1);
  g.add(L.root, R.root);
  const dust = new MoteEmitter({
    count: 12, color: 0xd8cfa8, size: 0.05, life: 1.8, rate: 1.6, opacity: 0.55,
    spawn: shellSpawn(0.5, 0.5, 0.6), velocity: driftVelocity(new THREE.Vector3(0, -1, 0), 0.03, 0.1), gravity: -0.08, drag: 0.7,
  });
  g.add(dust.points);
  return {
    group: g,
    tick: (t, dt) => {
      L.anim(t);
      R.anim(t);
      dust.update(dt);
    },
    dispose: () => dust.dispose(),
  };
}

// ---- 5. JETPACK — exhaust scales with how fast the owner is running ------------------------------
function jetpack(): AccessoryBuild {
  const g = new THREE.Group();
  const tankMat = flat(0x6b7386);
  const darkMat = flat(0x2e3340);
  const orangeMat = flat(0xc4622a, 0xc4622a, 0.4);
  for (const sx of [-0.14, 0.14]) {
    const tank = cyl(0.085, 0.085, 0.42, tankMat, sx, 0.2, -0.02, 10);
    g.add(tank);
    g.add(cyl(0.088, 0.088, 0.05, darkMat, sx, 0.42, -0.02, 10));
    const nozzle = cyl(0.05, 0.085, 0.08, darkMat, sx, -0.04, -0.02, 8);
    g.add(nozzle);
    g.add(cone(0.05, 0.07, orangeMat, sx, -0.11, -0.02, 8));
  }
  g.add(box(0.44, 0.1, 0.16, darkMat, 0, 0.24, 0));
  const flame = new MoteEmitter({
    count: 30, color: 0xffa640, size: 0.11, life: 0.45, rate: 10, opacity: 0.95,
    spawn: (out: THREE.Vector3) => out.set(0.14 * (Math.random() < 0.5 ? -1 : 1), -0.16, -0.02),
    velocity: (out: THREE.Vector3) => {
      const s = hSpeedOf(g);
      const boost = 1 + Math.min(2.2, s * 0.25);
      return out.set((Math.random() - 0.5) * 0.14, -1.1 * boost * (0.7 + Math.random() * 0.6), (Math.random() - 0.5) * 0.14);
    },
    drag: 1.4, gravity: -0.6,
  });
  g.add(flame.points);
  const core = new MoteEmitter({
    count: 14, color: 0x8fd8ff, size: 0.06, life: 0.3, rate: 6, opacity: 0.9,
    spawn: (out: THREE.Vector3) => out.set(0.14 * (Math.random() < 0.5 ? -1 : 1), -0.14, -0.02),
    velocity: (out: THREE.Vector3) => out.set(0, -0.9 - Math.random() * 0.5, 0), drag: 2,
  });
  g.add(core.points);
  return {
    group: g,
    tick: (_t, dt) => {
      const boost = 0.35 + Math.min(1, hSpeedOf(g) / 7) * 0.95;
      flame.setRate(8 + boost * 26);
      core.setRate(4 + boost * 14);
      flame.setOpacity(0.55 + boost * 0.4);
      flame.update(dt);
      core.update(dt);
    },
    dispose: () => {
      flame.dispose();
      core.dispose();
    },
  };
}

// ---- 6. SPORE BLOOM — one tall puffball that breathes spores over a crop of smaller caps ---------
function sporeBloom(): AccessoryBuild {
  const g = new THREE.Group();
  const stemMat = flat(0xc9c3a4);
  const capMat = flat(0x3f8a54, 0x1d5c33, 0.45);
  const capMat2 = flat(0x4f9a63, 0x256b3d, 0.4);
  const gillMat = glow(0x8dffb0, 0.4);

  // ---- the big bloom: a fat stalk, glowing gills and a cap that swells, then pops
  const big = new THREE.Group();
  big.position.set(0.03, 0, -0.14);
  big.rotation.z = -0.07;
  g.add(big);
  big.add(cyl(0.05, 0.08, 0.28, stemMat, 0, 0.14, 0, 8));
  const frill = torus(0.085, 0.024, stemMat, 10, 5);
  frill.rotation.x = Math.PI / 2;
  frill.position.y = 0.27;
  big.add(frill);
  big.add(cyl(0.135, 0.185, 0.06, gillMat, 0, 0.325, 0, 12));
  const capGroup = new THREE.Group();
  capGroup.position.y = 0.4;
  big.add(capGroup);
  const cap = ball(0.2, capMat, 0, 0, 0, 12, 8);
  cap.scale.set(1, 0.64, 1);
  capGroup.add(cap);
  const rim = torus(0.198, 0.012, glow(0x9dff9a, 0.5), 18, 5);
  rim.rotation.x = Math.PI / 2;
  capGroup.add(rim);
  // warts and glowing pores ride the dome (children of the cap group, so they swell with it)
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.35;
    const rr = 0.06 + (i % 3) * 0.05;
    const hh = Math.sqrt(Math.max(0, 1 - (rr / 0.2) ** 2)) * 0.12;
    capGroup.add(ball(0.026 + (i % 2) * 0.012, i % 3 === 2 ? glow(0x9dff9a, 0.6) : capMat2, Math.cos(a) * rr, hh, Math.sin(a) * rr, 6, 5));
  }

  // ---- the crop: a few tilted shrooms around the big one (all riding behind the back plane)
  const caps: THREE.Mesh[] = [];
  const shroom = (x: number, z: number, tilt: number, r: number, h: number, mat: THREE.Material): void => {
    const root = new THREE.Group();
    root.position.set(x, -0.02, z);
    root.rotation.z = tilt;
    root.add(cyl(0.028, 0.042, h, stemMat, 0, h / 2, 0, 7));
    root.add(cyl(r * 0.55, r * 0.9, 0.05, gillMat, 0, h + 0.02, 0, 10));
    const c = ball(r, mat, 0, h + 0.05 + r * 0.4, 0, 10, 7);
    c.scale.set(1, 0.62, 1);
    root.add(c);
    caps.push(c);
    g.add(root);
  };
  shroom(-0.19, -0.02, 0.38, 0.1, 0.15, capMat2);
  shroom(0.17, -0.08, -0.32, 0.115, 0.19, capMat2);
  shroom(0.0, -0.02, 0.08, 0.085, 0.11, capMat);
  shroom(-0.1, -0.17, -0.22, 0.06, 0.06, capMat);
  shroom(0.12, -0.2, 0.28, 0.05, 0.05, capMat2);

  const drift = new MoteEmitter({
    count: 18, color: 0x9dff9a, size: 0.05, life: 2.6, rate: 2.4, opacity: 0.55,
    spawn: shellSpawn(0.28, 0.28, 0.6), velocity: driftVelocity(new THREE.Vector3(0, 1, 0), 0.02, 0.1), drag: 0.35,
  });
  g.add(drift.points);
  // the burst pool lives INSIDE the big bloom so emitAt coordinates are cap-local
  const puff = new MoteEmitter({
    count: 14, color: 0xc8ffd0, size: 0.08, life: 1.1, opacity: 0.85,
    velocity: driftVelocity(new THREE.Vector3(0, 1, 0), 0.2, 0.6), drag: 0.8, gravity: -0.05,
  });
  big.add(puff.points);

  let lastCycle = 0;
  return {
    group: g,
    tick: (t, dt) => {
      drift.update(dt);
      puff.update(dt);
      // the cap swells over a 3.4 s cycle, then pops a cloud of spores and snaps back
      const CYCLE = 3.4;
      const cycle = t % CYCLE;
      if (cycle < lastCycle) {
        for (let i = 0; i < 14; i++) {
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(Math.random()) * 0.16;
          puff.emitAt(Math.cos(a) * rr, 0.42 + Math.random() * 0.08, Math.sin(a) * rr);
        }
      }
      lastCycle = cycle;
      const build = cycle / CYCLE;
      const pop = Math.max(0, 1 - cycle / 0.45);
      capGroup.scale.setScalar(1 + build * 0.05 + pop * 0.09);
      for (let i = 0; i < caps.length; i++) {
        const p = 1 + Math.sin(t * 1.3 + i * 1.7) * 0.04;
        caps[i].scale.set(p, 0.62 * p, p);
      }
    },
    dispose: () => {
      drift.dispose();
      puff.dispose();
    },
  };
}

// ---- 7. SPIDER POD — a brood sac that carries itself ---------------------------------------------
function spiderPod(): AccessoryBuild {
  const g = new THREE.Group();
  const chitin = flat(0x3d2d4d);
  const sacMat = flat(0x5c3b66, 0x2a1233, 0.35);
  const sac = ball(0.2, sacMat, 0, 0.1, -0.12, 10, 8);
  sac.scale.set(1, 1.25, 1);
  g.add(sac);
  g.add(box(0.3, 0.24, 0.16, chitin, 0, 0.02, -0.03));
  const legs: { hip: THREE.Group; knee: THREE.Group; side: number }[] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.16, 0.16 - i * 0.14, -0.1);
      hip.rotation.z = side * -0.9;
      hip.rotation.x = -0.3 + i * 0.5;
      const upper = cyl(0.02, 0.028, 0.26, chitin, 0, 0.13, 0, 6);
      hip.add(upper);
      const knee = new THREE.Group();
      knee.position.y = 0.26;
      knee.rotation.z = side * 1.7;
      const lower = cyl(0.012, 0.02, 0.3, chitin, 0, 0.15, 0, 6);
      knee.add(lower);
      const claw = cone(0.02, 0.07, chitin, 0, 0.32, 0, 5);
      knee.add(claw);
      hip.add(knee);
      g.add(hip);
      legs.push({ hip, knee, side });
    }
  }
  return {
    group: g,
    tick: (t) => {
      legs.forEach((l, i) => {
        const w = Math.sin(t * (2.2 + i * 0.35) + i * 1.7);
        l.hip.rotation.x = -0.3 + (i % 2) * 0.5 + w * 0.22;
        l.knee.rotation.z = l.side * (1.7 + w * 0.18);
      });
      sac.scale.y = 1.25 + Math.sin(t * 1.8) * 0.06;
    },
  };
}

// ---- 8. SOUL LANTERN -----------------------------------------------------------------------------
function soulLantern(): AccessoryBuild {
  const g = new THREE.Group();
  const ironMat = flat(0x35313c);
  const glassMat = glow(0x7dff9c, 0.28);
  g.add(box(0.03, 0.34, 0.03, ironMat, 0.12, 0.12, -0.18));
  const arm = box(0.24, 0.03, 0.03, ironMat, 0.02, 0.29, -0.18);
  g.add(arm);
  const lantern = new THREE.Group();
  lantern.position.set(-0.1, 0.05, -0.18);
  lantern.add(cyl(0.05, 0.02, 0.05, ironMat, 0, 0.19, 0, 6));
  lantern.add(box(0.15, 0.02, 0.15, ironMat, 0, 0.145, 0));
  const cage = new THREE.Group();
  for (const [x, z] of [[-0.07, -0.07], [0.07, -0.07], [-0.07, 0.07], [0.07, 0.07]]) {
    cage.add(box(0.012, 0.22, 0.012, ironMat, x, 0, z));
  }
  const glass = box(0.12, 0.2, 0.12, glassMat, 0, 0, 0);
  cage.add(glass);
  cage.position.y = 0.03;
  lantern.add(cage);
  lantern.add(box(0.15, 0.02, 0.15, ironMat, 0, -0.09, 0));
  const flameMat = glow(0x9dffa8, 0.95);
  const flame = ball(0.035, flameMat, 0, 0.02, 0, 6, 5);
  lantern.add(flame);
  const wisp = ball(0.022, glow(0xc8ffd2, 0.9), 0, 0.02, 0, 6, 5);
  lantern.add(wisp);
  g.add(lantern);
  const motes = new MoteEmitter({
    count: 16, color: 0x9dffb0, size: 0.055, life: 2.4, rate: 3, opacity: 0.65,
    spawn: shellSpawn(0.06, -0.06, 0.6), velocity: driftVelocity(new THREE.Vector3(0, 1, 0), 0.03, 0.1), drag: 0.4,
  });
  motes.points.position.set(-0.1, 0.05, -0.18);
  g.add(motes.points);
  return {
    group: g,
    tick: (t, dt) => {
      motes.update(dt);
      lantern.rotation.z = Math.sin(t * 1.6) * 0.14;
      lantern.rotation.x = Math.cos(t * 1.2) * 0.08;
      flame.scale.setScalar(0.85 + Math.sin(t * 9) * 0.12 + Math.sin(t * 23) * 0.06);
      flameMat.opacity = 0.75 + Math.sin(t * 13) * 0.2;
      const a = t * 1.8;
      wisp.position.set(Math.cos(a) * 0.045, 0.02 + Math.sin(a * 1.7) * 0.05, Math.sin(a) * 0.045);
    },
    dispose: () => motes.dispose(),
  };
}

// ---- 9. CRYSTAL CLUSTER --------------------------------------------------------------------------
function crystalCluster(): AccessoryBuild {
  const g = new THREE.Group();
  const shards: THREE.Mesh[] = [];
  const mats = [glow(0x64e8ff, 0.85), glow(0xc46bff, 0.85), glow(0x8fffe0, 0.8)];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const r = 0.1 + (i % 3) * 0.06;
    const geo = new THREE.OctahedronGeometry(0.07 + (i % 3) * 0.025);
    geo.scale(1, 2.1, 1);
    const shard = new THREE.Mesh(geo, mats[i % 3]);
    shard.position.set(Math.cos(a) * r, 0.05 + (i % 4) * 0.05, -0.1 - Math.sin(a) * 0.06);
    shard.rotation.set(Math.sin(a) * 0.5, 0, Math.cos(a) * 0.4);
    g.add(shard);
    shards.push(shard);
  }
  const shimmer = new MoteEmitter({
    count: 16, color: 0x9df2ff, size: 0.05, life: 1.6, rate: 3, opacity: 0.8,
    spawn: shellSpawn(0.2, 0.2, 0.6), velocity: driftVelocity(new THREE.Vector3(0, 0.6, 0), 0.05, 0.2), drag: 0.7,
  });
  g.add(shimmer.points);
  return {
    group: g,
    tick: (t, dt) => {
      shimmer.update(dt);
      for (let i = 0; i < shards.length; i++) {
        shards[i].rotation.y = t * (0.3 + i * 0.07);
        shards[i].position.y = 0.05 + (i % 4) * 0.05 + Math.sin(t * 1.1 + i) * 0.015;
      }
    },
    dispose: () => shimmer.dispose(),
  };
}

// ---- 10. WAR BANNER -------------------------------------------------------------------------------
function warBanner(): AccessoryBuild {
  const g = new THREE.Group();
  const poleMat = flat(0x4a4038);
  const pole = cyl(0.018, 0.022, 0.8, poleMat, 0.2, 0.25, -0.16, 6);
  g.add(pole);
  g.add(ball(0.03, flat(0xa8873f, 0xa8873f, 0.4), 0.2, 0.68, -0.16, 6, 5));
  const cross = cyl(0.014, 0.014, 0.34, poleMat, 0.36, 0.6, -0.16, 5);
  cross.rotation.z = Math.PI / 2;
  g.add(cross);
  const clothMat = cloth(0x53306d);
  const banner = slab(
    [[0, 0], [0.32, 0], [0.32, -0.5], [0.22, -0.42], [0.14, -0.52], [0.06, -0.44], [0, -0.52]],
    0.014, clothMat
  );
  const clothGroup = new THREE.Group();
  clothGroup.position.set(0.2, 0.58, -0.16);
  clothGroup.add(banner);
  const emblem = new THREE.Mesh(new THREE.CircleGeometry(0.075, 12), glow(0xc898ff, 0.75));
  emblem.position.set(0.16, -0.16, 0.012);
  clothGroup.add(emblem);
  g.add(clothGroup);
  return {
    group: g,
    tick: (t) => {
      const s = hSpeedOf(g);
      const flutter = 1 + Math.min(1.6, s * 0.2);
      clothGroup.rotation.y = Math.sin(t * 2.1) * 0.12 * flutter;
      clothGroup.rotation.z = Math.sin(t * 3.3) * 0.06 * flutter;
      clothGroup.rotation.x = -0.1 + Math.sin(t * 2.7) * 0.05 * flutter;
    },
  };
}

// ---- 11. HIVE NEST --------------------------------------------------------------------------------
function hiveNest(): AccessoryBuild {
  const g = new THREE.Group();
  const waxMat = flat(0xa8873f);
  const nest = new THREE.Group();
  nest.position.set(0.08, -0.02, -0.2);
  nest.rotation.z = 0.35;
  for (let i = 0; i < 4; i++) {
    const r = 0.13 - i * 0.028;
    nest.add(ball(r, waxMat, 0, 0.04 + i * 0.1, 0, 9, 7));
  }
  const hole = ball(0.05, flat(0x1d1608), 0, 0.12, 0.11, 7, 6);
  nest.add(hole);
  g.add(nest);
  const bees: { mesh: THREE.Group; phase: number; r: number; y: number; wings: THREE.Mesh[] }[] = [];
  for (let i = 0; i < 4; i++) {
    const bee = new THREE.Group();
    bee.add(ball(0.028, flat(0xe4b02a, 0xe4b02a, 0.3), 0, 0, 0, 6, 5));
    const wings: THREE.Mesh[] = [];
    for (const sx of [-1, 1]) {
      const wing = slab([[-0.015, 0], [0.055, 0.02], [0.02, 0.06]], 0.006, glow(0xd8ecff, 0.5));
      wing.position.set(sx * 0.02, 0.025, 0);
      wing.rotation.y = sx * 0.5;
      bee.add(wing);
      wings.push(wing);
    }
    g.add(bee);
    bees.push({ mesh: bee, phase: i * 1.9, r: 0.22 + (i % 2) * 0.1, y: 0.15 + (i % 3) * 0.14, wings });
  }
  return {
    group: g,
    tick: (t) => {
      for (const b of bees) {
        const a = t * (1 + (b.phase % 0.5)) + b.phase;
        b.mesh.position.set(Math.cos(a) * b.r, b.y + Math.sin(a * 2.3) * 0.05, -0.16 + Math.sin(a) * b.r * 0.7);
        b.mesh.rotation.y = -a + Math.PI / 2;
        const flap = Math.sin(t * 42 + b.phase) * 0.7;
        b.wings[0].rotation.z = flap;
        b.wings[1].rotation.z = -flap;
      }
    },
  };
}

// ---- 12. WRAITH SHROUD — a two-layer tattered grave-cloak with a fallen hood ---------------------
function wraithShroud(): AccessoryBuild {
  const g = new THREE.Group();
  const shroudMat = cloth(0x31254a, 0x0d2418);
  const underMat = cloth(0x1b1329, 0x0a1c14);
  const hemMat = glow(0x6bffa8, 0.45);

  // ---- the hood itself, fallen back behind the neck (the head slot is free for a real hat)
  const hood = ball(0.17, shroudMat, 0, 0.44, -0.06, 12, 9);
  hood.scale.set(1.05, 0.72, 0.55);
  g.add(hood);

  // ---- the cloak: two outer halves wrapped forward around the flanks, over a longer inner layer.
  // Both hang from the shoulders (one pivot each), so the whole thing sways like cloth on a peg.
  const outerPivot = new THREE.Group();
  outerPivot.position.set(0, 0.4, -0.01);
  const underPivot = new THREE.Group();
  underPivot.position.set(0, 0.4, 0.04);
  const under = slab(
    [[-0.33, 0], [0.33, 0], [0.4, -0.4], [0.36, -0.62], [0.24, -0.5], [0.12, -0.66], [0, -0.52],
     [-0.12, -0.68], [-0.24, -0.54], [-0.36, -0.64], [-0.4, -0.36]],
    0.02, underMat
  );
  underPivot.add(under);
  const halfProfile: [number, number][] = [
    [0, 0], [0.34, 0], [0.42, -0.3], [0.38, -0.46], [0.28, -0.34], [0.18, -0.49], [0.07, -0.36], [0, -0.42],
  ];
  const strips: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const half = new THREE.Group();
    half.rotation.y = -side * 0.2;   // the panel wraps forward around the flank
    half.add(slab(halfProfile.map(([x, y]) => [x * side, y] as [number, number]), 0.025, shroudMat));
    // glowing tatter tips ride their own half, so they follow the wrap
    for (const [x, y] of [[0.18, -0.49], [0.38, -0.46]]) {
      const tip = slab([[x * side - 0.035, y + 0.045], [x * side + 0.035, y + 0.045], [x * side, y - 0.055]], 0.03, hemMat);
      half.add(tip);
    }
    // strips hanging off the hem, drifting harder as the owner runs
    for (const x of side === 1 ? [0.03, 0.33] : [-0.29]) {
      const chain = hangChain(3, 0.13, 0.04, 0.012, shroudMat, 6);
      const root = chain[0];
      root.position.set(x, -0.34 - (Math.abs(x) > 0.3 ? 0.08 : 0), 0);
      root.rotation.x = 0.12;
      half.add(root);
      for (let j = 1; j < chain.length; j++) strips.push(chain[j]);
    }
    outerPivot.add(half);
  }
  g.add(underPivot, outerPivot);

  const mist = new MoteEmitter({
    count: 18, color: 0x7bffb2, size: 0.07, life: 2.4, rate: 3, opacity: 0.4,
    spawn: shellSpawn(0.45, -0.15, 0.6), velocity: driftVelocity(new THREE.Vector3(0, -1, 0), 0.02, 0.09), gravity: -0.12, drag: 0.4,
  });
  g.add(mist.points);

  return {
    group: g,
    tick: (t, dt) => {
      mist.update(dt);
      const flow = 1 + Math.min(1.6, hSpeedOf(g) * 0.18);   // sprinting makes the cloth billow
      outerPivot.rotation.x = 0.05 + Math.sin(t * 1.15) * 0.035 * flow;
      outerPivot.rotation.z = Math.sin(t * 0.85) * 0.03;
      underPivot.rotation.x = 0.03 + Math.sin(t * 1.15 + 0.9) * 0.05 * flow;
      underPivot.rotation.z = Math.sin(t * 0.85 + 0.7) * 0.04;
      hood.rotation.z = Math.sin(t * 0.9) * 0.04;
      for (let i = 0; i < strips.length; i++) {
        strips[i].rotation.z = Math.sin(t * 1.6 + i * 1.3) * 0.18 * flow;
        strips[i].rotation.x = Math.sin(t * 1.25 + i * 0.9) * 0.1;
      }
      hemMat.opacity = 0.34 + Math.sin(t * 1.7) * 0.12;
    },
    dispose: () => mist.dispose(),
  };
}

// ---- 13. TESLA ARRAY -----------------------------------------------------------------------------
function teslaArray(): AccessoryBuild {
  const g = new THREE.Group();
  const plateMat = flat(0x2f3440);
  const rodMat = flat(0x596174);
  g.add(box(0.36, 0.4, 0.1, plateMat, 0, 0.06, -0.06));
  const orbs: THREE.Mesh[] = [];
  const mats: THREE.MeshBasicMaterial[] = [];
  for (const sx of [-0.16, 0.16]) {
    g.add(cyl(0.02, 0.02, 0.34, rodMat, sx, 0.36, -0.08, 6));
    for (let i = 0; i < 3; i++) {
      const ring = torus(0.045 - i * 0.008, 0.008, rodMat, 10, 5);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(sx, 0.26 + i * 0.09, -0.08);
      g.add(ring);
    }
    const mat = glow(0x6ee2ff, 0.95);
    mats.push(mat);
    const orb = ball(0.05, mat, sx, 0.56, -0.08, 8, 6);
    g.add(orb);
    orbs.push(orb);
  }
  const arcs = new MoteEmitter({
    count: 22, color: 0x9df0ff, size: 0.05, life: 0.4, rate: 16, opacity: 1,
    spawn: (out: THREE.Vector3) => out.set(-0.16 + Math.random() * 0.32, 0.56 + (Math.random() - 0.5) * 0.1, -0.08),
    velocity: driftVelocity(new THREE.Vector3(0, 0, 0), 0.2, 0.8), drag: 2,
  });
  g.add(arcs.points);
  return {
    group: g,
    tick: (t, dt) => {
      arcs.update(dt);
      for (let i = 0; i < orbs.length; i++) {
        const p = 0.9 + Math.sin(t * 14 + i * 2.1) * 0.12;
        orbs[i].scale.setScalar(p);
        mats[i].opacity = 0.7 + Math.sin(t * 11 + i) * 0.25;
      }
    },
    dispose: () => arcs.dispose(),
  };
}

// ---- 14. SURVIVOR KIT ----------------------------------------------------------------------------
function survivorKit(): AccessoryBuild {
  const g = new THREE.Group();
  const canvasMat = flat(0x5a5140);
  const strapMat = flat(0x342e24);
  g.add(box(0.36, 0.44, 0.2, canvasMat, 0, 0.08, -0.1));
  g.add(box(0.3, 0.1, 0.06, strapMat, 0, 0.2, -0.2));
  g.add(box(0.06, 0.44, 0.06, strapMat, -0.14, 0.08, 0.0));
  g.add(box(0.06, 0.44, 0.06, strapMat, 0.14, 0.08, 0.0));
  const roll = cyl(0.07, 0.07, 0.4, flat(0x3f3a2c), 0, 0.34, -0.12, 8);
  roll.rotation.z = Math.PI / 2;
  g.add(roll);
  const potMat = flat(0x4a4a52);
  const pot = new THREE.Group();
  pot.position.set(0.2, -0.04, -0.12);
  pot.add(cyl(0.05, 0.06, 0.08, potMat, 0, 0, 0, 8));
  const handle = torus(0.05, 0.008, potMat, 8, 5);
  handle.rotation.y = Math.PI / 2;
  handle.position.y = 0.05;
  pot.add(handle);
  g.add(pot);
  g.add(box(0.1, 0.02, 0.14, flat(0x8a7a3f, 0x8a7a3f, 0.3), 0, 0.3, -0.1));
  return {
    group: g,
    tick: (t) => {
      const s = hSpeedOf(g);
      const swing = 0.15 * (1 + Math.min(1.4, s * 0.12));
      pot.rotation.z = Math.sin(t * 4.1) * swing;
      pot.rotation.x = Math.cos(t * 3.4) * swing * 0.6;
    },
  };
}

// ---- 15. GRAVEKEEPER — a tombstone strapped to the back ------------------------------------------
function tombstone(): AccessoryBuild {
  const g = new THREE.Group();
  const stoneMat = flat(0x6e6b72);
  const stone = slab(
    [[-0.19, -0.3], [0.19, -0.3], [0.19, 0.14], [0.13, 0.26], [0, 0.31], [-0.13, 0.26], [-0.19, 0.14]],
    0.09, stoneMat
  );
  stone.position.set(0, 0.1, -0.12);
  stone.rotation.x = -0.06;
  g.add(stone);
  g.add(box(0.34, 0.05, 0.12, flat(0x55525a), 0, -0.2, -0.12));
  const mossMat = flat(0x46603a);
  g.add(box(0.12, 0.05, 0.02, mossMat, -0.08, 0.2, -0.075));
  g.add(box(0.08, 0.04, 0.02, mossMat, 0.1, 0.05, -0.075));
  g.add(box(0.05, 0.03, 0.02, mossMat, 0.02, 0.3, -0.075));
  const runeMat = glow(0x8dffa0, 0.7);
  g.add(box(0.02, 0.16, 0.01, runeMat, 0, 0.06, -0.073));
  g.add(box(0.1, 0.02, 0.01, runeMat, 0, 0.1, -0.073));
  const haze = new MoteEmitter({
    count: 14, color: 0x8dffa0, size: 0.07, life: 2.2, rate: 2, opacity: 0.4,
    spawn: shellSpawn(0.22, -0.1, 0.6), velocity: driftVelocity(new THREE.Vector3(0, -1, 0), 0.02, 0.08), gravity: -0.1, drag: 0.5,
  });
  g.add(haze.points);
  return {
    group: g,
    tick: (t, dt) => {
      haze.update(dt);
      runeMat.opacity = 0.5 + Math.sin(t * 1.9) * 0.25;
      stone.rotation.x = -0.06 + Math.sin(t * 0.9) * 0.012;
    },
    dispose: () => haze.dispose(),
  };
}

// ---- 16. MOTH WINGS ------------------------------------------------------------------------------
function mothWings(): AccessoryBuild {
  const g = new THREE.Group();
  const wingMat = cloth(0x7a5a3a, 0x2a1808);
  const spotMat = glow(0xffd98a, 0.6);
  const mk = (side: number): { root: THREE.Group; anim: (t: number) => void } => {
    const root = new THREE.Group();
    root.position.set(side * 0.1, 0.2, -0.12);
    root.rotation.z = side * -0.35;
    const upper = slab(
      [[0, 0], [side * 0.42, 0.34], [side * 0.78, 0.26], [side * 0.62, -0.06], [side * 0.16, -0.14]],
      0.018, wingMat
    );
    root.add(upper);
    const lower = slab(
      [[side * 0.1, -0.08], [side * 0.56, -0.14], [side * 0.42, -0.42], [side * 0.14, -0.3]],
      0.016, wingMat
    );
    root.add(lower);
    const spot = new THREE.Mesh(new THREE.CircleGeometry(0.07, 10), spotMat);
    spot.position.set(side * 0.34, 0.1, 0.012);
    spot.rotation.y = side * 0.3;
    root.add(spot);
    const spotLower = new THREE.Mesh(new THREE.CircleGeometry(0.045, 9), spotMat);
    spotLower.position.set(side * 0.3, -0.22, 0.012);
    spotLower.rotation.y = side * 0.3;
    root.add(spotLower);
    return {
      root,
      anim: (t: number): void => {
        const flap = Math.sin(t * 3.4);
        root.rotation.z = side * (-0.35 + flap * 0.22);
        root.rotation.y = side * (0.18 + flap * 0.1);
      },
    };
  };
  const L = mk(-1);
  const R = mk(1);
  g.add(L.root, R.root);
  const dust = new MoteEmitter({
    count: 16, color: 0xffd98a, size: 0.045, life: 2.4, rate: 3, opacity: 0.55,
    spawn: shellSpawn(0.5, 0.15, 0.7), velocity: driftVelocity(new THREE.Vector3(0, -1, 0), 0.02, 0.09), gravity: -0.06, drag: 0.5,
  });
  g.add(dust.points);
  return {
    group: g,
    tick: (t, dt) => {
      L.anim(t);
      R.anim(t);
      dust.update(dt);
    },
    dispose: () => dust.dispose(),
  };
}

export const BACKPACKS: AccessoryDef[] = [
  { id: 'angel-wings', name: 'ANGEL WINGS', desc: 'Feathered wings that beat slowly and shed warm light.', build: angelWings, scale: 1.35 },
  { id: 'demon-wings', name: 'DEMON WINGS', desc: 'Bat wings and embers. They flap when you move.', build: demonWings, scale: 1.35 },
  { id: 'void-tentacles', name: 'VOID TENTACLES', desc: 'Six writhing tentacles that drip something purple.', build: voidTentacles, scale: 1.45 },
  { id: 'bone-wings', name: 'BONE WINGS', desc: 'Skeletal wings with a flag of old skin between the fingers.', build: boneWings, scale: 1.5 },
  { id: 'jetpack', name: 'JETPACK', desc: 'Twin thrusters. The flames roar when you run.', build: jetpack },
  { id: 'spore-bloom', name: 'SPORE BLOOM', desc: 'A fat glow-cap that breathes out clouds of spores.', build: sporeBloom },
  { id: 'spider-pod', name: 'SPIDER POD', desc: 'A brood sac that walks on eight twitching legs.', build: spiderPod },
  { id: 'soul-lantern', name: 'SOUL LANTERN', desc: 'A caged soul-light that swings as you walk.', build: soulLantern },
  { id: 'crystals', name: 'CRYSTAL CLUSTER', desc: 'Living shards that spin and shimmer.', build: crystalCluster },
  { id: 'war-banner', name: 'WAR BANNER', desc: 'A pole banner that flutters harder the faster you run.', build: warBanner },
  { id: 'hive', name: 'HIVE NEST', desc: 'You carry the swarm. Four of them orbit your back.', build: hiveNest },
  { id: 'wraith-shroud', name: 'WRAITH SHROUD', desc: 'A two-layer grave-cloak with a fallen hood, drifting in green mist.', build: wraithShroud, scale: 1.3 },
  { id: 'tesla-array', name: 'TESLA ARRAY', desc: 'Coils on your back arcing to each other.', build: teslaArray },
  { id: 'survivor-kit', name: 'SURVIVOR KIT', desc: 'Bedroll, pouches and a pot that clanks as you move.', build: survivorKit },
  { id: 'tombstone', name: 'GRAVEKEEPER', desc: 'A mossy headstone carried for someone who fell.', build: tombstone },
  { id: 'moth-wings', name: 'MOTH WINGS', desc: 'Big patterned wings and a trail of golden dust.', build: mothWings, scale: 1.55 },
];
