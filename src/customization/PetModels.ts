// NECROFALL — PET models. Origin = the pet's feet on the ground (the follower system hovers the
// whole group; a `tick` only animates limbs, wings and faces). Pets face local +Z.
import * as THREE from 'three';
import { AccessoryBuild, AccessoryDef, PetMotion } from './AccessoryTypes';
import { ball, box, cloth, cone, cyl, flat, glow, slab, torus } from './AccessoryKit';
import { MoteEmitter, driftVelocity, shellSpawn } from './MoteEmitter';

/** Shared wing pair for the flying pets: pivots at the shoulders, flaps via `flap`. */
function wingPair(
  g: THREE.Group,
  mat: THREE.Material,
  opts: { x: number; y: number; z: number; span: number; height: number }
): (t: number, speed: number, amp: number) => void {
  const wings: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const root = new THREE.Group();
    root.position.set(side * opts.x, opts.y, opts.z);
    const wing = slab(
      [[0, 0], [side * opts.span, opts.height * 0.3], [side * opts.span * 1.15, -opts.height * 0.45], [0, -opts.height * 0.2]],
      0.014, mat
    );
    root.add(wing);
    g.add(root);
    wings.push(root);
  }
  return (t: number, speed: number, amp: number): void => {
    const flap = Math.sin(t * speed);
    wings[0].rotation.z = amp * flap;
    wings[1].rotation.z = -amp * flap;
  };
}

/** A four-legged walk cycle. Legs are single boxes swinging from hip pivots. */
function legs(
  g: THREE.Group,
  mat: THREE.Material,
  hips: { x: number; y: number; z: number },
  legLen: number
): (t: number, speed: number, amp: number) => void {
  const joints: { root: THREE.Group; phase: number }[] = [];
  const offsets: [number, number][] = [[-1, 1], [1, -1], [-1, -1], [1, 1]];
  for (let i = 0; i < 4; i++) {
    const [sx, sz] = offsets[i];
    const root = new THREE.Group();
    root.position.set(sx * hips.x, hips.y, sz * hips.z);
    const leg = box(0.05, legLen, 0.05, mat, 0, -legLen / 2, 0);
    root.add(leg);
    g.add(root);
    joints.push({ root, phase: i * Math.PI * 0.5 });
  }
  return (t: number, speed: number, amp: number): void => {
    for (const j of joints) {
      j.root.rotation.z = Math.sin(t * speed + j.phase) * amp;
    }
  };
}

// ---- 1. IMP --------------------------------------------------------------------------------------
function imp(): AccessoryBuild {
  const g = new THREE.Group();
  const skinMat = flat(0xa8342e);
  const hornMat = flat(0x3a1d18);
  g.add(ball(0.11, skinMat, 0, 0.16, 0, 8, 7));
  const head = new THREE.Group();
  head.position.set(0, 0.3, 0.02);
  head.add(ball(0.085, skinMat, 0, 0, 0, 8, 7));
  for (const sx of [-1, 1]) {
    const horn = cone(0.02, 0.09, hornMat, sx * 0.05, 0.07, 0, 5);
    horn.rotation.z = sx * -0.35;
    head.add(horn);
  }
  const eyeMat = glow(0xffd23d, 0.9);
  head.add(ball(0.017, eyeMat, -0.03, 0.015, 0.07, 5, 4), ball(0.017, eyeMat, 0.03, 0.015, 0.07, 5, 4));
  g.add(head);
  const wings = wingPair(g, cloth(0x5c1d24), { x: 0.07, y: 0.2, z: -0.04, span: 0.17, height: 0.12 });
  const tail = cyl(0.008, 0.018, 0.2, skinMat, 0, 0.12, -0.09, 5);
  tail.rotation.x = -2.2;
  g.add(tail);
  return {
    group: g,
    tick: (t, dt) => {
      wings(t, 16, 0.7);
      head.rotation.y = Math.sin(t * 1.7) * 0.4;
      tail.rotation.z = Math.sin(t * 5.2) * 0.35;
      void dt;
    },
  };
}

// ---- 2. WISP -------------------------------------------------------------------------------------
function wisp(): AccessoryBuild {
  const g = new THREE.Group();
  const coreMat = glow(0x9de8ff, 0.95);
  const core = ball(0.09, coreMat, 0, 0.22, 0, 9, 8);
  g.add(core);
  const halo = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 1), glow(0x63c8ff, 0.3));
  halo.position.y = 0.22;
  g.add(halo);
  const tail = new MoteEmitter({
    count: 16, color: 0x9de8ff, size: 0.05, life: 1.3, rate: 5, opacity: 0.75,
    spawn: shellSpawn(0.05, 0.22, 0.6), velocity: driftVelocity(new THREE.Vector3(0, -0.4, 0), 0.03, 0.12), drag: 0.5,
  });
  g.add(tail.points);
  return {
    group: g,
    tick: (t, dt) => {
      tail.update(dt);
      core.scale.setScalar(0.9 + Math.sin(t * 6.2) * 0.12);
      coreMat.opacity = 0.75 + Math.sin(t * 4.4) * 0.2;
      halo.rotation.y = t * 1.4;
      halo.rotation.x = t * 0.9;
      halo.scale.setScalar(0.95 + Math.sin(t * 2.2) * 0.1);
    },
    dispose: () => tail.dispose(),
  };
}

// ---- 3. SKELETON PUP -----------------------------------------------------------------------------
function skeletonPup(): AccessoryBuild {
  const g = new THREE.Group();
  const boneMat = flat(0xd9d0b0);
  const body = cyl(0.055, 0.075, 0.24, boneMat, 0, 0.2, 0, 7);
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const head = new THREE.Group();
  head.position.set(0, 0.26, 0.16);
  head.add(ball(0.07, boneMat, 0, 0, 0, 8, 6));
  head.add(box(0.06, 0.05, 0.09, boneMat, 0, -0.03, 0.06));
  const eyeMat = glow(0x8dff9a, 0.85);
  head.add(ball(0.015, eyeMat, -0.025, 0.02, 0.06, 5, 4), ball(0.015, eyeMat, 0.025, 0.02, 0.06, 5, 4));
  g.add(head);
  const walk = legs(g, boneMat, { x: 0.06, y: 0.16, z: 0.08 }, 0.15);
  const tail = new THREE.Group();
  tail.position.set(0, 0.24, -0.11);
  const tailBone = cyl(0.008, 0.018, 0.14, boneMat, 0, 0.05, 0, 5);
  tail.add(tailBone);
  tail.rotation.x = 0.9;
  g.add(tail);
  return {
    group: g,
    tick: (t) => {
      const speed = 9;
      walk(t, speed, 0.5);
      tail.rotation.z = Math.sin(t * 11) * 0.6;
      head.rotation.y = Math.sin(t * 1.3) * 0.3;
    },
  };
}

// ---- 4. BAT --------------------------------------------------------------------------------------
function bat(): AccessoryBuild {
  const g = new THREE.Group();
  const furMat = flat(0x2b2338);
  g.add(ball(0.07, furMat, 0, 0.24, 0, 8, 6));
  const head = new THREE.Group();
  head.position.set(0, 0.32, 0.03);
  head.add(ball(0.055, furMat, 0, 0, 0, 7, 6));
  for (const sx of [-1, 1]) {
    const ear = cone(0.02, 0.07, furMat, sx * 0.03, 0.06, -0.01, 5);
    ear.rotation.z = sx * -0.2;
    head.add(ear);
  }
  const eyeMat = glow(0xffb03d, 0.9);
  head.add(ball(0.012, eyeMat, -0.02, 0.01, 0.045, 5, 4), ball(0.012, eyeMat, 0.02, 0.01, 0.045, 5, 4));
  g.add(head);
  const wings = wingPair(g, cloth(0x3a2c4d), { x: 0.05, y: 0.26, z: -0.01, span: 0.26, height: 0.16 });
  return {
    group: g,
    tick: (t) => {
      wings(t, 26, 0.95);
      g.rotation.z = Math.sin(t * 3.2) * 0.1;
      head.rotation.y = Math.sin(t * 4.1) * 0.5;
    },
  };
}

// ---- 5. SLIME ------------------------------------------------------------------------------------
function slime(): AccessoryBuild {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({
    color: 0x4fd07a, emissive: 0x1c6b3a, emissiveIntensity: 0.45, flatShading: true, transparent: true, opacity: 0.85,
  });
  const body = ball(0.13, bodyMat, 0, 0.11, 0, 10, 8);
  body.scale.set(1.15, 0.85, 1.15);
  g.add(body);
  const eyeMat = glow(0x0c2a16, 0.95);
  g.add(ball(0.02, eyeMat, -0.05, 0.16, 0.1, 5, 4), ball(0.02, eyeMat, 0.05, 0.16, 0.1, 5, 4));
  const blob = ball(0.045, bodyMat, 0.09, 0.04, 0.06, 6, 5);
  g.add(blob);
  return {
    group: g,
    tick: (t) => {
      const squish = 1 + Math.sin(t * 6) * 0.16;
      body.scale.set(1.15 / squish, 0.85 * squish, 1.15 / squish);
    },
  };
}

// ---- 6. CRAWLING HAND ----------------------------------------------------------------------------
function crawlingHand(): AccessoryBuild {
  const g = new THREE.Group();
  const boneMat = flat(0xc9bf9d);
  const palm = box(0.16, 0.06, 0.2, boneMat, 0, 0.06, 0);
  g.add(palm);
  g.add(cyl(0.03, 0.04, 0.14, boneMat, 0, 0.08, -0.15, 6).rotateX(Math.PI / 2.2));
  const fingers: THREE.Group[] = [];
  for (let i = 0; i < 4; i++) {
    const root = new THREE.Group();
    root.position.set(-0.06 + i * 0.04, 0.04, 0.1);
    const seg = cyl(0.014, 0.018, 0.16, boneMat, 0, 0, 0.08, 5);
    seg.rotation.x = Math.PI / 2.4;
    seg.position.set(0, 0.03, 0.07);
    root.add(seg);
    g.add(root);
    fingers.push(root);
  }
  return {
    group: g,
    tick: (t) => {
      fingers.forEach((f, i) => {
        f.rotation.x = Math.sin(t * 7 + i * 1.4) * 0.45;
      });
      g.rotation.z = Math.sin(t * 3.5) * 0.12;
    },
  };
}

// ---- 7. RAVEN ------------------------------------------------------------------------------------
function raven(): AccessoryBuild {
  const g = new THREE.Group();
  const mat = flat(0x1c1a24);
  const body = ball(0.09, mat, 0, 0.2, -0.02, 9, 7);
  body.scale.set(1, 0.9, 1.4);
  g.add(body);
  const head = new THREE.Group();
  head.position.set(0, 0.28, 0.09);
  head.add(ball(0.05, mat, 0, 0, 0, 7, 6));
  head.add(cone(0.02, 0.08, flat(0x3a3120), 0, -0.005, 0.07, 5).rotateX(Math.PI / 2));
  const eyeMat = glow(0xd8d8ff, 0.8);
  head.add(ball(0.011, eyeMat, -0.024, 0.012, 0.035, 5, 4), ball(0.011, eyeMat, 0.024, 0.012, 0.035, 5, 4));
  g.add(head);
  const tail = box(0.06, 0.02, 0.16, mat, 0, 0.2, -0.18);
  tail.rotation.x = -0.25;
  g.add(tail);
  const wings = wingPair(g, mat, { x: 0.06, y: 0.24, z: -0.02, span: 0.22, height: 0.1 });
  const feet: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    const foot = box(0.03, 0.1, 0.03, flat(0x3a3120), sx * 0.04, 0.05, 0.02);
    g.add(foot);
    feet.push(foot);
  }
  return {
    group: g,
    tick: (t) => {
      const hop = Math.max(0, Math.sin(t * 4.2));
      wings(t, 12, 0.28 + hop * 0.5);
      head.rotation.x = -hop * 0.4;
      head.rotation.y = Math.sin(t * 2.6) * 0.5;
      void feet;
    },
  };
}

// ---- 8. SPIDERLING -------------------------------------------------------------------------------
function spiderling(): AccessoryBuild {
  const g = new THREE.Group();
  const mat = flat(0x2f2438);
  const abdomen = ball(0.09, flat(0x4a2a5c, 0x2a0a3a, 0.4), 0, 0.14, -0.06, 9, 7);
  abdomen.scale.set(1, 0.9, 1.2);
  g.add(abdomen);
  g.add(ball(0.055, mat, 0, 0.12, 0.07, 7, 6));
  const eyeMat = glow(0xff5a9d, 0.9);
  for (let i = 0; i < 4; i++) {
    g.add(ball(0.011, eyeMat, (i % 2 === 0 ? -1 : 1) * (i < 2 ? 0.018 : 0.036), 0.13, 0.115, 5, 4));
  }
  const legsArr: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const root = new THREE.Group();
      root.position.set(side * 0.05, 0.13, 0.06 - i * 0.045);
      // the leg rises from the hip... (Rz(−0.8) sends local +Y up and out)
      root.rotation.z = side * -0.8;
      const upper = cyl(0.008, 0.012, 0.16, mat, 0, 0.08, 0, 5);
      root.add(upper);
      // ...to a raised elbow just above the body, and the shin folds back DOWN to the ground.
      // The knee's rotation must OPPOSE the hip's: the same sign folds the leg up over the head.
      const knee = new THREE.Group();
      knee.position.y = 0.16;
      knee.rotation.z = side * -1.67;
      knee.add(cyl(0.006, 0.01, 0.19, mat, 0, 0.095, 0, 5));
      root.add(knee);
      g.add(root);
      legsArr.push(root);
    }
  }
  return {
    group: g,
    tick: (t) => {
      legsArr.forEach((l, i) => {
        l.rotation.x = Math.sin(t * 14 + i * 1.1) * 0.35;
      });
      abdomen.scale.y = 0.9 + Math.sin(t * 2.2) * 0.05;
    },
  };
}

// ---- 9. SKULL DRONE ------------------------------------------------------------------------------
function skullDrone(): AccessoryBuild {
  const g = new THREE.Group();
  const boneMat = flat(0xd8d0b4);
  const skull = ball(0.1, boneMat, 0, 0.24, 0, 9, 8);
  skull.scale.set(1, 1.05, 1.1);
  g.add(skull);
  g.add(box(0.11, 0.05, 0.09, boneMat, 0, 0.17, 0.03));
  const eyeMat = glow(0x63e6ff, 0.95);
  g.add(ball(0.022, eyeMat, -0.04, 0.25, 0.085, 6, 5), ball(0.022, eyeMat, 0.04, 0.25, 0.085, 6, 5));
  const ring = torus(0.17, 0.012, glow(0x63e6ff, 0.7), 16, 5);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.24;
  g.add(ring);
  return {
    group: g,
    tick: (t) => {
      ring.rotation.z = t * 2.4;
      ring.position.y = 0.24 + Math.sin(t * 2.8) * 0.03;
      eyeMat.opacity = 0.7 + Math.sin(t * 7) * 0.25;
    },
  };
}

// ---- 10. CAT -------------------------------------------------------------------------------------
function cat(): AccessoryBuild {
  const g = new THREE.Group();
  const furMat = flat(0x191622);
  const body = ball(0.08, furMat, 0, 0.18, -0.02, 9, 7);
  body.scale.set(1, 1, 1.5);
  g.add(body);
  const head = new THREE.Group();
  head.position.set(0, 0.26, 0.13);
  head.add(ball(0.06, furMat, 0, 0, 0, 8, 6));
  for (const sx of [-1, 1]) {
    const ear = cone(0.022, 0.06, furMat, sx * 0.035, 0.06, 0, 4);
    ear.rotation.z = sx * -0.25;
    head.add(ear);
  }
  const eyeMat = glow(0x9dff6a, 0.9);
  head.add(ball(0.013, eyeMat, -0.025, 0.012, 0.05, 5, 4), ball(0.013, eyeMat, 0.025, 0.012, 0.05, 5, 4));
  g.add(head);
  const walk = legs(g, furMat, { x: 0.05, y: 0.14, z: 0.07 }, 0.13);
  const tail = new THREE.Group();
  tail.position.set(0, 0.2, -0.12);
  const seg = cyl(0.008, 0.02, 0.3, furMat, 0, 0.12, 0, 5);
  tail.add(seg);
  tail.rotation.x = -0.6;
  g.add(tail);
  return {
    group: g,
    tick: (t) => {
      walk(t * 1.6, 7, 0.45);
      tail.rotation.z = Math.sin(t * 2.3) * 0.5;
      tail.rotation.x = -0.6 + Math.sin(t * 1.7) * 0.12;
      head.rotation.y = Math.sin(t * 0.9) * 0.5;
    },
  };
}

// ---- 11. PUMPKINLING -----------------------------------------------------------------------------
function pumpkinling(): AccessoryBuild {
  const g = new THREE.Group();
  const shellMat = flat(0xe06a1c);
  const body = ball(0.11, shellMat, 0, 0.13, 0, 10, 8);
  body.scale.set(1, 0.85, 1);
  g.add(body);
  g.add(cyl(0.012, 0.022, 0.07, flat(0x5d431f), 0.01, 0.22, 0, 5));
  const faceMat = glow(0xffcf4d, 0.9);
  g.add(box(0.03, 0.03, 0.015, faceMat, -0.04, 0.16, 0.1), box(0.03, 0.03, 0.015, faceMat, 0.04, 0.16, 0.1));
  for (let i = 0; i < 3; i++) {
    g.add(box(0.03, 0.02, 0.015, faceMat, -0.03 + i * 0.03, 0.09, 0.105));
  }
  const feet: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(sx * 0.045, 0.07, 0);
    hip.add(box(0.03, 0.09, 0.03, flat(0x3a2a14), 0, -0.045, 0));
    g.add(hip);
    feet.push(hip);
  }
  return {
    group: g,
    tick: (t) => {
      feet.forEach((f, i) => {
        f.rotation.z = Math.sin(t * 10 + i * Math.PI) * 0.6;
      });
      faceMat.opacity = 0.7 + Math.sin(t * 5) * 0.25;
    },
  };
}

// ---- 12. EYE -------------------------------------------------------------------------------------
function eyePet(): AccessoryBuild {
  const g = new THREE.Group();
  const scleraMat = flat(0xf0e8d6);
  const sclera = ball(0.1, scleraMat, 0, 0.26, 0, 10, 8);
  g.add(sclera);
  const iris = ball(0.05, flat(0x3fb6d8, 0x1a4a6e, 0.5), 0, 0.26, 0.07, 9, 7);
  g.add(iris);
  const pupilMat = glow(0x0a1a2a, 0.95);
  const pupil = ball(0.022, pupilMat, 0, 0.26, 0.105, 7, 6);
  g.add(pupil);
  const wings = wingPair(g, glow(0xd8e8ff, 0.4), { x: 0.06, y: 0.3, z: -0.05, span: 0.15, height: 0.1 });
  return {
    group: g,
    tick: (t) => {
      wings(t, 20, 0.7);
      const look = Math.sin(t * 1.1);
      iris.position.x = look * 0.03;
      pupil.position.x = look * 0.03;
      const blink = Math.max(0, Math.sin(t * 0.8) - 0.96) / 0.04;
      sclera.scale.y = iris.scale.y = pupil.scale.y = 1 - blink * 0.85;
      void pupilMat;
    },
  };
}

// ---- 13. PUPPY — small, warm, and delighted to see you -------------------------------------------
function puppy(): AccessoryBuild {
  // The FOLLOWER owns `group.position` (it is the pet's world placement). Everything the puppy's
  // animation wants to move must therefore live in an inner group — writing to the root's position
  // would fight the follower every frame and drop the pet at the planet's origin.
  const g = new THREE.Group();
  const bob = new THREE.Group();
  g.add(bob);
  const furMat = flat(0x9a6a44);
  const creamMat = flat(0xe9d9bd);
  const noseMat = flat(0x241a14);
  const body = ball(0.085, furMat, 0, 0.17, -0.02, 9, 7);
  body.scale.set(1, 0.95, 1.5);
  bob.add(body);
  const chest = ball(0.06, creamMat, 0, 0.13, 0.045, 8, 6);
  chest.scale.set(0.9, 0.8, 0.7);
  bob.add(chest);
  const head = new THREE.Group();
  head.position.set(0, 0.27, 0.12);
  head.add(ball(0.075, furMat, 0, 0, 0, 9, 7));
  const muzzle = ball(0.045, creamMat, 0, -0.025, 0.055, 7, 5);
  muzzle.scale.set(1, 0.85, 0.95);
  head.add(muzzle);
  head.add(ball(0.017, noseMat, 0, -0.005, 0.098, 6, 5));
  const tongueMat = flat(0xe07a8a);
  const tongue = box(0.026, 0.022, 0.035, tongueMat, 0, -0.058, 0.08);
  head.add(tongue);
  // big glossy puppy eyes with a sparkle in each
  for (const sx of [-1, 1]) {
    head.add(ball(0.021, noseMat, sx * 0.036, 0.028, 0.052, 8, 6));
    head.add(ball(0.007, glow(0xffffff, 0.9), sx * 0.036 + 0.008, 0.038, 0.068, 5, 4));
  }
  // floppy ears, hanging down both sides of the face
  const earMat = cloth(0x6f482c);
  const ears: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const ear = slab(
      [[0, 0], [side * 0.05, -0.012], [side * 0.062, -0.085], [side * 0.026, -0.105], [side * -0.004, -0.06]],
      0.014, earMat
    );
    ear.position.set(side * 0.062, 0.035, -0.005);
    head.add(ear);
    ears.push(ear);
  }
  bob.add(head);
  // stumpy legs with cream paws, and a tail that never stops moving
  const legJoints: { root: THREE.Group; phase: number }[] = [];
  const offsets: [number, number][] = [[-1, 1], [1, -1], [-1, -1], [1, 1]];
  for (let i = 0; i < 4; i++) {
    const [sx, sz] = offsets[i];
    const root = new THREE.Group();
    root.position.set(sx * 0.055, 0.11, sz * 0.09);
    root.add(box(0.046, 0.1, 0.046, furMat, 0, -0.05, 0));
    const paw = ball(0.031, creamMat, 0, -0.102, 0.012, 7, 5);
    paw.scale.set(1, 0.72, 1.25);
    root.add(paw);
    bob.add(root);
    legJoints.push({ root, phase: i * Math.PI * 0.5 });
  }
  const tail = new THREE.Group();
  tail.position.set(0, 0.21, -0.16);
  const tailBone = cyl(0.012, 0.022, 0.14, furMat, 0, 0.06, 0, 5);
  const tailTip = ball(0.028, creamMat, 0, 0.14, 0, 6, 5);
  tail.add(tailBone, tailTip);
  tail.rotation.x = -0.7;
  bob.add(tail);
  return {
    group: g,
    tick: (t) => {
      for (const l of legJoints) l.root.rotation.z = Math.sin(t * 11 + l.phase) * 0.55;
      // an eager, fast wag plus a bounce in the step
      tail.rotation.z = Math.sin(t * 13) * 0.75;
      tail.rotation.x = -0.7 + Math.sin(t * 6.5) * 0.12;
      bob.position.y = Math.abs(Math.sin(t * 5.5)) * 0.012;
      head.rotation.y = Math.sin(t * 1.6) * 0.35;
      head.rotation.z = Math.sin(t * 2.3) * 0.06;
      for (let i = 0; i < ears.length; i++) {
        ears[i].rotation.x = Math.sin(t * 6 + i) * 0.12;
      }
      tongue.scale.setScalar(0.9 + Math.abs(Math.sin(t * 5)) * 0.25);
    },
  };
}

// ---- 14. MOTH ------------------------------------------------------------------------------------
function mothPet(): AccessoryBuild {
  const g = new THREE.Group();
  const fuzzMat = flat(0x8a7458);
  const body = cyl(0.03, 0.04, 0.16, fuzzMat, 0, 0.26, 0, 7);
  g.add(body);
  g.add(ball(0.045, fuzzMat, 0, 0.36, 0.01, 7, 6));
  const eyeMat = glow(0xffef9d, 0.85);
  g.add(ball(0.012, eyeMat, -0.02, 0.36, 0.045, 5, 4), ball(0.012, eyeMat, 0.02, 0.36, 0.045, 5, 4));
  for (const side of [-1, 1]) {
    const antenna = cyl(0.004, 0.006, 0.1, fuzzMat, side * 0.015, 0.42, 0.04, 4);
    antenna.rotation.z = side * -0.5;
    g.add(antenna);
    const upper = ball(0.008, eyeMat, side * 0.04, 0.46, 0.05, 5, 4);
    g.add(upper);
  }
  const wings = wingPair(g, cloth(0x9a7a4a, 0x3a2608), { x: 0.03, y: 0.3, z: 0.02, span: 0.24, height: 0.2 });
  const dust = new MoteEmitter({
    count: 14, color: 0xffe9a8, size: 0.04, life: 1.6, rate: 4, opacity: 0.6,
    spawn: shellSpawn(0.12, 0.28, 0.6), velocity: driftVelocity(new THREE.Vector3(0, -0.6, 0), 0.02, 0.08), drag: 0.5,
  });
  g.add(dust.points);
  return {
    group: g,
    tick: (t, dt) => {
      wings(t, 24, 1.0);
      dust.update(dt);
    },
    dispose: () => dust.dispose(),
  };
}

// ---- 15. MINI GOLEM ------------------------------------------------------------------------------
function golem(): AccessoryBuild {
  const g = new THREE.Group();
  const stoneMat = flat(0x6a655c);
  const mossMat = flat(0x4a6a42);
  const coreMat = glow(0xffb347, 0.85);
  const torso = box(0.18, 0.16, 0.13, stoneMat, 0, 0.24, 0);
  g.add(torso);
  g.add(box(0.2, 0.05, 0.15, mossMat, 0, 0.31, 0));
  const core = ball(0.035, coreMat, 0, 0.24, 0.07, 6, 5);
  g.add(core);
  const head = new THREE.Group();
  head.position.set(0, 0.36, 0.01);
  head.add(box(0.13, 0.11, 0.11, stoneMat, 0, 0, 0));
  head.add(box(0.028, 0.018, 0.01, coreMat, -0.032, 0.005, 0.058));
  head.add(box(0.028, 0.018, 0.01, coreMat, 0.032, 0.005, 0.058));
  g.add(head);
  const arms: THREE.Group[] = [];
  const legsArr: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(sx * 0.115, 0.29, 0);
    arm.add(box(0.06, 0.14, 0.06, stoneMat, 0, -0.07, 0));
    g.add(arm);
    arms.push(arm);
    const leg = new THREE.Group();
    leg.position.set(sx * 0.055, 0.16, 0);
    leg.add(box(0.06, 0.15, 0.07, stoneMat, 0, -0.075, 0));
    g.add(leg);
    legsArr.push(leg);
  }
  return {
    group: g,
    tick: (t) => {
      arms.forEach((a, i) => {
        a.rotation.x = Math.sin(t * 5 + i * Math.PI) * 0.5;
      });
      legsArr.forEach((l, i) => {
        l.rotation.x = Math.sin(t * 5 + i * Math.PI) * 0.55;
      });
      head.rotation.y = Math.sin(t * 0.8) * 0.25;
      coreMat.opacity = 0.65 + Math.sin(t * 3.1) * 0.3;
    },
  };
}

// ---- 16. GHOST -----------------------------------------------------------------------------------
/** The classic sheet ghost: a rounded dome flowing into a flared skirt, a wavy beaded hem, and a
 *  simple face (two oval eyes, a small wailing mouth) that blinks now and then. */
function ghost(): AccessoryBuild {
  const g = new THREE.Group();
  const sheetMat = new THREE.MeshLambertMaterial({
    color: 0xeef2ff, emissive: 0x8fa8e8, emissiveIntensity: 0.32, flatShading: true, transparent: true, opacity: 0.78,
  });
  const faceMat = new THREE.MeshBasicMaterial({ color: 0x241a3e });
  // sway + breathing live on an inner rig: a tick must never write the ROOT (PetController owns its
  // position as the world placement, see the puppy bounce)
  const rig = new THREE.Group();
  g.add(rig);

  // The whole sheet is ONE lathe profile — bottom disc, straight flaring skirt, dome — so there is
  // no seam where a skirt cylinder would meet a sphere (that junction read as a hood collar).
  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0, 0.02),
    new THREE.Vector2(0.19, 0.02),
    new THREE.Vector2(0.16, 0.315),
  ];
  for (let p = 75; p >= 0; p -= 15) {
    const phi = (p * Math.PI) / 180;
    profile.push(new THREE.Vector2(0.16 * Math.sin(phi), 0.315 + 0.1888 * Math.cos(phi)));
  }
  rig.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 12), sheetMat));
  // the wavy hem: small flat beads strung along the skirt's bottom edge, bobbing out of phase, so
  // the lowest points of the silhouette dip in and out between the bumps
  const hem: THREE.Mesh[] = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const bead = ball(0.034, sheetMat, Math.cos(a) * 0.172, 0.028, Math.sin(a) * 0.172, 8, 6);
    bead.scale.set(1, 0.6, 1);
    rig.add(bead);
    hem.push(bead);
  }
  // face: two oval eyes and a small "boo" mouth, dark and unlit so they stay crisp on the sheet
  const eyes: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    const eye = ball(0.027, faceMat, sx * 0.05, 0.385, 0.136, 10, 8);
    eye.scale.set(0.85, 1.3, 0.62);
    rig.add(eye);
    eyes.push(eye);
  }
  const mouth = ball(0.02, faceMat, 0, 0.313, 0.158, 8, 6);
  mouth.scale.set(1, 1.2, 0.6);
  rig.add(mouth);
  return {
    group: g,
    tick: (t, dt) => {
      rig.rotation.z = Math.sin(t * 1.6) * 0.07;
      rig.rotation.x = Math.sin(t * 1.25 + 1.2) * 0.045;
      const breathe = Math.sin(t * 2.3);
      rig.scale.set(1 - breathe * 0.02, 1 + breathe * 0.035, 1 - breathe * 0.02);
      for (let i = 0; i < hem.length; i++) {
        hem[i].position.y = 0.028 + Math.sin(t * 3.2 + i * 0.9) * 0.01;
      }
      // a short blink every few seconds — the eyes squash shut, then pop back. The phase is picked
      // so a blink never fires around t≈1.17 s: ItemThumbs poses every model at exactly that time
      // for the catalog chip, and a mid-blink capture read as a broken wink.
      const blink = 1 - 0.85 * Math.pow(Math.max(0, Math.sin(t * 1.35 + 2)), 32);
      for (const eye of eyes) eye.scale.y = 1.3 * blink;
      void dt;
    },
  };
}

/** Movement presets — a floaty wisp drifts, a pup sprints. `hop` pets arc instead of gliding. */
const ground = (speed: number, roamMin = 1.2, roamMax = 3.4): PetMotion => ({
  hover: 0.14, speed, accel: 9, roamMin, roamMax, lingerMin: 0.8, lingerMax: 2.6, bob: 0.05, bobRate: 3.2,
});
const hop = (speed: number): PetMotion => ({
  hover: 0.1, speed, accel: 11, roamMin: 1.1, roamMax: 3.0, lingerMin: 0.9, lingerMax: 2.4, bob: 0.16, bobRate: 2.6, hop: true,
});
const flyer = (speed: number, hover: number): PetMotion => ({
  hover, speed, accel: 6, roamMin: 1.3, roamMax: 3.4, lingerMin: 1.4, lingerMax: 3.6, bob: 0.1, bobRate: 1.8,
});

// Scales are NOT guesses: each pet was measured (raw bounds) and scaled so the whole silhouette —
// the LARGER of height / 0.8×length / 0.8×wingspan — lands in the same ~0.7–0.95 m band beside a
// 1.9 m player. Judging by height alone made wide flyers (bat, moth) tiny and tall quadrupedals
// (cat, puppy) oversized. The puppy sits at the top of the band on purpose: it reads as a dog.
export const PETS: AccessoryDef[] = [
  { id: 'imp', name: 'IMP', desc: 'A hopping little demon that flaps after you.', build: imp, motion: hop(3.4), scale: 1.7 },
  { id: 'wisp', name: 'WISP', desc: 'A drifting light that leaves a trail.', build: wisp, motion: flyer(2.6, 1.0), scale: 2.2 },
  { id: 'skeleton-pup', name: 'SKELETON PUP', desc: 'Bones and loyalty. It will keep up.', build: skeletonPup, motion: ground(4.4), scale: 2.25 },
  { id: 'bat', name: 'BAT', desc: 'Erratic flight, excellent hearing (probably).', build: bat, motion: flyer(4.6, 1.3), scale: 1.35 },
  { id: 'slime', name: 'SLIME', desc: 'Bounces along, squishing all the way.', build: slime, motion: hop(3.0), scale: 2.9 },
  { id: 'crawling-hand', name: 'CRAWLING HAND', desc: 'A hand that walks on its fingers.', build: crawlingHand, motion: ground(2.4), scale: 1.9 },
  { id: 'raven', name: 'RAVEN', desc: 'Hops after you and glares at everything.', build: raven, motion: hop(3.6), scale: 1.5 },
  { id: 'spiderling', name: 'SPIDERLING', desc: 'Eight legs, no patience.', build: spiderling, motion: ground(4.8, 1.0, 3.2), scale: 1.6 },
  { id: 'skull-drone', name: 'SKULL DRONE', desc: 'A hovering skull on a spinning ring.', build: skullDrone, motion: flyer(3.6, 1.15), scale: 2.5 },
  { id: 'cat', name: 'BLACK CAT', desc: 'Walks its own line, always near.', build: cat, motion: ground(3.8), scale: 1.75 },
  { id: 'pumpkinling', name: 'PUMPKINLING', desc: 'A tiny pumpkin that runs on little legs.', build: pumpkinling, motion: hop(3.2), scale: 2.6 },
  { id: 'eye', name: 'WATCHER', desc: 'A blinking eye that flies on moth wings.', build: eyePet, motion: flyer(2.4, 1.25), scale: 1.95 },
  { id: 'puppy', name: 'PUPPY', desc: 'Warm, wiggly and utterly convinced you are the best thing ever.', build: puppy, motion: ground(4.2, 1.0, 3.2), scale: 2.1 },
  { id: 'moth', name: 'GLOW MOTH', desc: 'Flutters close and sheds golden dust.', build: mothPet, motion: flyer(2.8, 0.95), scale: 1.55 },
  { id: 'golem', name: 'MINI GOLEM', desc: 'Heavy steps, steady watch.', build: golem, motion: ground(2.2, 1.4, 3.0), scale: 1.8 },
  { id: 'ghost', name: 'GHOST', desc: 'A small haunting. Does nothing but follow.', build: ghost, motion: flyer(2.6, 1.45), scale: 1.7 },
];
