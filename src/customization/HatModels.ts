// NECROFALL — HAT models. Origin = the CENTRE of the player's head (the head box in
// player/Player.ts is 0.44³ centred at y 1.68 of the body), so a hat is positioned as if the head
// were a ball at (0,0,0) and the face looks down local +Z.
import * as THREE from 'three';
import { AccessoryBuild, AccessoryDef } from './AccessoryTypes';
import { ball, box, cloth, cone, cyl, flat, glow, hangChain, slab, torus } from './AccessoryKit';
import { MoteEmitter, driftVelocity, shellSpawn } from './MoteEmitter';

// ---- 1. PUMPKIN JACK — the whole head disappears inside a carved pumpkin -------------------------
function pumpkin(): AccessoryBuild {
  const g = new THREE.Group();
  const shellMat = flat(0xe06a1c);
  const shell = ball(0.37, shellMat, 0, 0.02, 0, 14, 12);
  shell.scale.set(1, 0.9, 1);
  g.add(shell);
  const ridgeMat = flat(0xba5314);
  for (let i = 0; i < 6; i++) {
    const ridge = torus(0.36, 0.018, ridgeMat, 14, 5);
    ridge.rotation.y = (i / 6) * Math.PI;
    ridge.scale.set(1, 0.9, 1);
    ridge.position.y = 0.02;
    g.add(ridge);
  }
  const stemMat = flat(0x5d431f);
  const stem = cyl(0.028, 0.055, 0.16, stemMat, 0.02, 0.36, 0, 6);
  stem.rotation.z = -0.24;
  g.add(stem);
  // ---- the carved face: a jagged grin and two lit eyes
  const faceMat = glow(0xffcf4d, 0.95);
  const mkEye = (x: number): THREE.Mesh => {
    const e = slab([[-0.075, -0.03], [0.075, -0.03], [0, 0.105]], 0.03, faceMat);
    e.position.set(x, 0.05, 0.31);
    e.rotation.z = x < 0 ? -0.12 : 0.12;
    return e;
  };
  g.add(mkEye(-0.135), mkEye(0.135));
  for (let i = 0; i < 4; i++) {
    const tooth = box(0.055, 0.05, 0.03, faceMat, -0.1 + i * 0.067, -0.13, 0.315);
    tooth.rotation.z = i % 2 === 0 ? 0.35 : -0.35;
    g.add(tooth);
  }
  const smoke = new MoteEmitter({
    count: 14, color: 0xffa53d, size: 0.05, life: 1.6, rate: 1.6, opacity: 0.75,
    spawn: shellSpawn(0.3, 0.34, 0.5), velocity: driftVelocity(new THREE.Vector3(0, 1, 0), 0.05, 0.16), gravity: 0.12, drag: 0.6,
  });
  g.add(smoke.points);
  return {
    group: g,
    tick: (t, dt) => {
      smoke.update(dt);
      faceMat.opacity = 0.78 + Math.sin(t * 2.3) * 0.16;
      g.position.y = 0.012 * Math.sin(t * 1.1);
      g.rotation.y = Math.sin(t * 0.4) * 0.06;
    },
    dispose: () => smoke.dispose(),
  };
}

// ---- 2. WARLOCK HAT — bent brimmed cone with faint arcane motes ----------------------------------
function warlock(): AccessoryBuild {
  const g = new THREE.Group();
  const feltMat = flat(0x3a2a63);
  const darkMat = flat(0x271b45);
  const brim = cyl(0.45, 0.47, 0.028, darkMat, 0, 0.13, 0, 12);
  g.add(brim);
  const band = cyl(0.3, 0.31, 0.09, darkMat, 0, 0.22, 0, 10);
  g.add(band);
  const lower = cone(0.3, 0.42, feltMat, 0, 0.42, 0, 10);
  g.add(lower);
  const upper = cone(0.17, 0.42, feltMat, 0.035, 0.82, -0.02, 9);
  upper.rotation.z = -0.16;
  g.add(upper);
  const tip = cone(0.06, 0.2, feltMat, 0.09, 1.04, -0.04, 7);
  tip.rotation.z = -0.5;
  g.add(tip);
  const buckle = box(0.1, 0.1, 0.03, flat(0x8a6a2e, 0x8a6a2e, 0.4), 0, 0.22, 0.3);
  g.add(buckle);
  const sparks = new MoteEmitter({
    count: 12, color: 0xb07aff, size: 0.045, life: 1.4, rate: 1.1, opacity: 0.8,
    spawn: shellSpawn(0.06, 1.12, 0.8), velocity: driftVelocity(new THREE.Vector3(0, 1, 0), 0.06, 0.2), gravity: 0.05, drag: 0.5,
  });
  g.add(sparks.points);
  return {
    group: g,
    tick: (t, dt) => {
      sparks.update(dt);
      g.rotation.z = 0.05 + Math.sin(t * 0.7) * 0.02;
      g.rotation.y = Math.sin(t * 0.31) * 0.08;
    },
    dispose: () => sparks.dispose(),
  };
}

// ---- 3. BONE CROWN — a circlet of little skulls --------------------------------------------------
function boneCrown(): AccessoryBuild {
  const g = new THREE.Group();
  // the head box tops out at local y 0.21, but the band (r 0.2) is NARROWER than the head, so at the
  // authored height the whole circlet sat inside the skull. Lift it to rest on the crown of the head.
  g.position.y = 0.07;
  const boneMat = flat(0xd8cfae);
  const ringMat = flat(0x8b7f63);
  const ring = torus(0.2, 0.026, ringMat, 14, 6);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.16;
  g.add(ring);
  const eyes: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i / 3) * Math.PI * 2;
    const skull = new THREE.Group();
    skull.position.set(Math.cos(a) * 0.2, 0.22, Math.sin(a) * 0.2);
    skull.rotation.y = -a + Math.PI / 2;
    skull.add(ball(0.062, boneMat, 0, 0.01, 0, 8, 6));
    skull.add(box(0.07, 0.05, 0.05, boneMat, 0, -0.05, 0.008));
    const eyeMat = glow(0x9dff6a, 0.9);
    eyes.push(eyeMat);
    skull.add(box(0.02, 0.02, 0.012, eyeMat, -0.024, 0.012, 0.052));
    skull.add(box(0.02, 0.02, 0.012, eyeMat, 0.024, 0.012, 0.052));
    g.add(skull);
  }
  return {
    group: g,
    tick: (t) => {
      for (let i = 0; i < eyes.length; i++) {
        eyes[i].opacity = 0.6 + Math.sin(t * 2.6 + i * 1.9) * 0.3;
      }
    },
  };
}

// ---- 4. IRON CROWN — spiked circlet with a watching gem ------------------------------------------
function ironCrown(): AccessoryBuild {
  const g = new THREE.Group();
  // same as the bone crown: the band is narrower than the head, so it must sit ON the head top
  g.position.y = 0.08;
  const ironMat = flat(0x5b5f70);
  const band = torus(0.2, 0.03, ironMat, 14, 6);
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.16;
  g.add(band);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const spike = cone(0.035, i % 2 === 0 ? 0.16 : 0.1, ironMat, Math.cos(a) * 0.2, 0.23, Math.sin(a) * 0.2, 5);
    spike.rotation.z = Math.cos(a) * 0.22;
    spike.rotation.x = -Math.sin(a) * 0.22;
    g.add(spike);
  }
  const gemMat = glow(0x63e6ff, 0.95);
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.062), gemMat);
  gem.position.set(0, 0.29, 0.02);
  g.add(gem);
  return {
    group: g,
    tick: (t) => {
      gemMat.opacity = 0.65 + Math.sin(t * 3.1) * 0.3;
      gem.rotation.y = t * 1.1;
    },
  };
}

// ---- 5. VIKING HELM — horned dome ---------------------------------------------------------------
function viking(): AccessoryBuild {
  const g = new THREE.Group();
  const steelMat = flat(0x707a8c);
  const trimMat = flat(0x9aa4b4);
  const dome = ball(0.27, steelMat, 0, 0.13, 0, 12, 8);
  dome.scale.set(1, 0.82, 1);
  g.add(dome);
  const band = cyl(0.275, 0.28, 0.08, trimMat, 0, 0.03, 0, 12);
  g.add(band);
  g.add(box(0.04, 0.24, 0.02, trimMat, 0, 0.16, 0.27));
  const hornMat = flat(0xd9cba6);
  const mkHorn = (side: number): THREE.Group => {
    const root = new THREE.Group();
    root.position.set(side * 0.25, 0.1, 0);
    root.rotation.z = side * -1.05;
    let parent: THREE.Object3D = root;
    for (let i = 0; i < 3; i++) {
      const j = new THREE.Group();
      j.position.y = i === 0 ? 0 : 0.13;
      j.rotation.z = side * (i === 0 ? -0.35 : 0.5);
      const seg = cyl(0.05 - i * 0.013, 0.058 - i * 0.013, 0.14, hornMat, 0, 0.07, 0, 6);
      j.add(seg);
      parent.add(j);
      parent = j;
    }
    return root;
  };
  g.add(mkHorn(-1), mkHorn(1));
  return { group: g };
}

// ---- 6. SKULL MASK — the head is gone; a skull looks out of the socket ---------------------------
function skullMask(): AccessoryBuild {
  const g = new THREE.Group();
  const boneMat = flat(0xd9d2b8);
  const dome = ball(0.31, boneMat, 0, 0.05, 0, 14, 10);
  dome.scale.set(0.98, 1.0, 1.02);
  g.add(dome);
  g.add(box(0.24, 0.14, 0.24, boneMat, 0, -0.2, 0.03));
  for (let i = 0; i < 4; i++) g.add(box(0.045, 0.05, 0.03, boneMat, -0.075 + i * 0.05, -0.265, 0.14));
  const socketMat = flat(0x100b18);
  const eyeMat = glow(0xff7a2f, 0.9);
  for (const sx of [-0.115, 0.115]) {
    const socket = box(0.11, 0.12, 0.06, socketMat, sx, 0.03, 0.26);
    g.add(socket);
    g.add(ball(0.026, eyeMat, sx, 0.03, 0.29, 6, 5));
  }
  const nose = slab([[-0.035, 0.05], [0.035, 0.05], [0, -0.03]], 0.03, socketMat);
  nose.position.set(0, -0.09, 0.3);
  g.add(nose);
  return {
    group: g,
    tick: (t) => {
      eyeMat.opacity = 0.62 + Math.sin(t * 3.7) * 0.28;
    },
  };
}

// ---- 7. DEMON HORNS — a pair of fluted horns and a burning rune ----------------------------------
function demonHorns(): AccessoryBuild {
  const g = new THREE.Group();
  const hornMat = flat(0x6e1f2a);
  const mkHorn = (side: number): THREE.Group => {
    const root = new THREE.Group();
    root.position.set(side * 0.2, 0.12, -0.02);
    root.rotation.z = side * -0.5;
    root.rotation.x = -0.25;
    let parent: THREE.Object3D = root;
    for (let i = 0; i < 3; i++) {
      const j = new THREE.Group();
      j.position.y = i === 0 ? 0 : 0.16;
      j.rotation.z = side * (i === 0 ? -0.3 : 0.42);
      j.rotation.x = -0.16;
      const seg = cyl(0.055 - i * 0.015, 0.065 - i * 0.015, 0.17, hornMat, 0, 0.085, 0, 6);
      j.add(seg);
      parent.add(j);
      parent = j;
    }
    return root;
  };
  g.add(mkHorn(-1), mkHorn(1));
  const runeMat = glow(0xff3d6e, 0.85);
  const rune = torus(0.085, 0.012, runeMat, 10, 5);
  rune.position.set(0, 0.09, 0.2);
  g.add(rune);
  const embers = new MoteEmitter({
    count: 16, color: 0xff5a3d, size: 0.05, life: 1.2, rate: 3, opacity: 0.85,
    spawn: shellSpawn(0.32, 0.55, 0.6), velocity: driftVelocity(new THREE.Vector3(0, 1, 0), 0.1, 0.3), gravity: 0.25, drag: 0.7,
  });
  g.add(embers.points);
  return {
    group: g,
    tick: (t, dt) => {
      embers.update(dt);
      runeMat.opacity = 0.55 + Math.sin(t * 2.2) * 0.3;
    },
    dispose: () => embers.dispose(),
  };
}

// ---- 8. PLAGUE DOCTOR — brimmed crown and a beaked mask ------------------------------------------
function plagueDoctor(): AccessoryBuild {
  const g = new THREE.Group();
  const hatMat = flat(0x37312b);
  const brim = cyl(0.44, 0.46, 0.03, hatMat, 0, 0.17, 0, 12);
  g.add(brim);
  const crown = cyl(0.2, 0.27, 0.24, hatMat, 0, 0.3, 0, 10);
  g.add(crown);
  const cap = cyl(0.16, 0.2, 0.06, hatMat, 0, 0.44, 0, 10);
  g.add(cap);
  const strap = cyl(0.272, 0.272, 0.045, flat(0x1f1a16), 0, 0.2, 0, 10);
  g.add(strap);
  const maskMat = flat(0x8b7a55);
  g.add(ball(0.24, maskMat, 0, -0.02, 0.06, 10, 8));
  const beak = cone(0.085, 0.34, maskMat, 0, -0.03, 0.36, 6);
  beak.rotation.x = Math.PI / 2.05;
  g.add(beak);
  const lensMat = glow(0x76ff9d, 0.85);
  for (const sx of [-0.1, 0.1]) {
    const rim = cyl(0.058, 0.058, 0.03, flat(0x4a4030), sx, 0.03, 0.27, 8);
    rim.rotation.x = Math.PI / 2;
    g.add(rim);
    const lens = ball(0.045, lensMat, sx, 0.03, 0.29, 8, 6);
    g.add(lens);
  }
  const haze = new MoteEmitter({
    count: 10, color: 0x8cffb0, size: 0.055, life: 1.8, rate: 1.4, opacity: 0.5,
    spawn: shellSpawn(0.03, 0, 0.4), velocity: driftVelocity(new THREE.Vector3(0, 0.4, 0.6), 0.05, 0.14), gravity: -0.06, drag: 0.8,
  });
  haze.points.position.set(0, -0.05, 0.52);
  g.add(haze.points);
  return {
    group: g,
    tick: (t, dt) => {
      haze.update(dt);
      lensMat.opacity = 0.6 + Math.sin(t * 2.7) * 0.25;
    },
    dispose: () => haze.dispose(),
  };
}

// ---- 9. HALO — a ring of light that never quite touches the head ---------------------------------
function halo(): AccessoryBuild {
  const g = new THREE.Group();
  const mat = glow(0xffe08a, 0.9);
  const ring = torus(0.24, 0.022, mat, 20, 6);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.52;
  g.add(ring);
  const motes = new MoteEmitter({
    count: 18, color: 0xffe9a8, size: 0.05, life: 1.6, rate: 4, opacity: 0.85,
    spawn: shellSpawn(0.24, 0.5, 0.15), velocity: driftVelocity(new THREE.Vector3(0, -1, 0), 0.03, 0.12), gravity: -0.12, drag: 0.5,
  });
  g.add(motes.points);
  return {
    group: g,
    tick: (t, dt) => {
      motes.update(dt);
      ring.position.y = 0.52 + Math.sin(t * 1.3) * 0.035;
      ring.rotation.z = t * 0.5;
      mat.opacity = 0.7 + Math.sin(t * 1.7) * 0.2;
    },
    dispose: () => motes.dispose(),
  };
}

// ---- 10. TESLA COIL — a caged head with live current on top --------------------------------------
function tesla(): AccessoryBuild {
  const g = new THREE.Group();
  const metal = flat(0x4c5568);
  const ring1 = torus(0.235, 0.02, metal, 14, 6);
  ring1.rotation.x = Math.PI / 2;
  ring1.position.y = 0.2;
  const ring2 = ring1.clone();
  ring2.position.y = -0.16;
  g.add(ring1, ring2);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.add(cyl(0.012, 0.012, 0.36, metal, Math.cos(a) * 0.235, 0.02, Math.sin(a) * 0.235, 5));
  }
  for (let i = 0; i < 3; i++) g.add(cyl(0.09 - i * 0.02, 0.1 - i * 0.02, 0.05, metal, 0, 0.32 + i * 0.05, 0, 8));
  const orbMat = glow(0x64e8ff, 0.95);
  const orb = ball(0.075, orbMat, 0, 0.48, 0, 8, 6);
  g.add(orb);
  const arcs = new MoteEmitter({
    count: 20, color: 0x86f0ff, size: 0.05, life: 0.5, rate: 8, opacity: 1,
    spawn: shellSpawn(0.09, 0.48, 0.4), velocity: driftVelocity(new THREE.Vector3(0, 0, 0), 0.2, 0.7), drag: 1.6,
  });
  g.add(arcs.points);
  return {
    group: g,
    tick: (t, dt) => {
      arcs.update(dt);
      const p = 0.85 + Math.sin(t * 21) * 0.15;
      orb.scale.setScalar(p);
      orbMat.opacity = 0.65 + Math.sin(t * 16) * 0.3;
    },
    dispose: () => arcs.dispose(),
  };
}

// ---- 11. RAM SKULL — bone helm with curled horns -------------------------------------------------
function ramSkull(): AccessoryBuild {
  const g = new THREE.Group();
  const boneMat = flat(0xcfc6a6);
  const dome = ball(0.29, boneMat, 0, 0.08, 0, 12, 10);
  dome.scale.set(0.95, 0.95, 1);
  g.add(dome);
  g.add(box(0.2, 0.16, 0.2, boneMat, 0, -0.12, 0.16));
  const hornMat = flat(0xb7a67e);
  for (const side of [-1, 1]) {
    const horn = torus(0.15, 0.038, hornMat, 14, 7);
    horn.position.set(side * 0.24, 0.06, -0.02);
    horn.rotation.y = Math.PI / 2;
    horn.rotation.x = side * 0.4;
    g.add(horn);
    const tip = cone(0.04, 0.12, hornMat, side * 0.26, 0.2, -0.02, 6);
    tip.rotation.z = side * -0.7;
    g.add(tip);
  }
  const eyeMat = glow(0xffd45e, 0.8);
  for (const sx of [-0.1, 0.1]) {
    g.add(ball(0.024, eyeMat, sx, 0.06, 0.27, 6, 5));
  }
  return {
    group: g,
    tick: (t) => {
      eyeMat.opacity = 0.55 + Math.sin(t * 2.1) * 0.3;
    },
  };
}

// ---- 12. SANTA HAT (the colonies still celebrate) -------------------------------------------------
function santa(): AccessoryBuild {
  const g = new THREE.Group();
  // the white brim used to wrap the middle of the head; lift the whole hat so it sits on the top
  g.position.y = 0.1;
  const redMat = flat(0x9e1f2f);
  const whiteMat = flat(0xe8e2d8);
  const coneMesh = cone(0.29, 0.62, redMat, 0, 0.42, 0, 10);
  g.add(coneMesh);
  g.add(cyl(0.3, 0.3, 0.085, whiteMat, 0, 0.14, 0, 10));
  const pompom = ball(0.08, whiteMat, 0, 0.72, 0, 8, 7);
  g.add(pompom);
  return {
    group: g,
    tick: (t) => {
      const sway = Math.sin(t * 2.1) * 0.06;
      coneMesh.rotation.z = sway * 0.5;
      pompom.position.x = sway * 0.9;
      pompom.position.y = 0.72 - Math.abs(sway) * 0.1;
    },
  };
}

// ---- 13. ASSASSIN HOOD — white cowl with a sharp folded peak over the face -----------------------
// The head is a 0.44 box whose corners reach r ≈ 0.31, so the cloth shell stays outside a r 0.385
// ellipsoid (any tighter and the box pokes out of the back). The face opening is a PHI cut in the
// cowl; in front of it a flat, steeply sloped panel is folded down over the brow. Its two lower
// edges meet in a SHARP V — that point is what makes the hood an assassin cowl and not a dome.
function assassinHood(): AccessoryBuild {
  const g = new THREE.Group();
  const clothMat = cloth(0xefeade);      // white robe cloth
  const linerMat = cloth(0x3a3344);      // dark lining: the opening edge reads as folded cloth
  const shellR = 0.385;
  const open = 0.95;      // half-width of the face window around local +Z (radians)
  const capEnd = 1.15;    // solid crown ends here: the window top (~y 0.17) stays above the visor
  const hemEnd = 2.32;    // hemline, draping around the shoulders

  // cowl: an open-front sphere sector (phi window centred on +Z). The cowl is 6 mm smaller than
  // the crown cap it tucks under, so the two pieces meet without z-fighting or a crack.
  const cowl = (r: number, openPhi: number, hem: number, mat: THREE.Material): THREE.Mesh => {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(r, 20, 12, Math.PI / 2 + openPhi, Math.PI * 2 - openPhi * 2, capEnd, hem - capEnd),
      mat
    );
    mesh.position.set(0, 0.01, -0.005);
    mesh.scale.set(1, 1.05, 1.02);
    return mesh;
  };
  const crownCap = (r: number, mat: THREE.Material): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 9, 0, Math.PI * 2, 0, capEnd + 0.06), mat);
    mesh.position.set(0, 0.01, -0.005);
    mesh.scale.set(1, 1.05, 1.02);
    return mesh;
  };
  g.add(crownCap(shellR, clothMat), cowl(shellR - 0.006, open, hemEnd, clothMat));
  // the lining sits 3.5 cm inside with a slightly narrower window, so the opening edge reads as
  // real cloth thickness instead of a paper cut
  g.add(crownCap(shellR - 0.035, linerMat), cowl(shellR - 0.041, open - 0.04, hemEnd - 0.06, linerMat));

  // ---- the peak: a flat panel folded down the brow. Its plane is z = 0.60 − 1.5·y (steep enough
  // that it hangs 4–7 cm clear of the cloth), so its lower edges meet in a sharp V at
  // (0, 0.12, 0.42) — a point above the visor, exactly where the opening should peak.
  // Local slab y = 1.8 × world y, because the tilt stretches the vertical axis by 1/|cos|.
  const peak = slab([[-0.2, 0.36], [0, 0.216], [0.2, 0.36], [0.17, 0.504], [-0.17, 0.504]], 0.03, clothMat);
  peak.rotation.x = -0.983;
  peak.position.set(0, 0, 0.6);
  g.add(peak);

  // ---- two cloth strips beside the cheeks; they hang short (above shoulder and pack) and snap back
  const tails: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const chain = hangChain(2, 0.1, 0.05, 0.028, clothMat, 6);
    const root = chain[0];
    root.position.set(side * 0.245, -0.02, -0.13);
    root.rotation.z = side * 0.15;
    root.rotation.x = 0.55;
    g.add(root);
    for (let j = 1; j < chain.length; j++) tails.push(chain[j]);
  }

  const mist = new MoteEmitter({
    count: 14, color: 0x8a6cff, size: 0.07, life: 2.2, rate: 1.4, opacity: 0.3,
    spawn: shellSpawn(0.3, -0.16, 0.5), velocity: driftVelocity(new THREE.Vector3(0, -1, 0), 0.02, 0.09), gravity: -0.08, drag: 0.4,
  });
  g.add(mist.points);

  return {
    group: g,
    tick: (t, dt) => {
      mist.update(dt);
      g.rotation.y = Math.sin(t * 0.45) * 0.12;   // slow scan under the cowl
      g.rotation.z = Math.sin(t * 0.85) * 0.02;
      for (let i = 0; i < tails.length; i++) {
        tails[i].rotation.z = Math.sin(t * 1.5 + i * 1.1) * 0.16;
        tails[i].rotation.x = Math.sin(t * 1.2 + i * 0.8) * 0.1;
      }
    },
    dispose: () => mist.dispose(),
  };
}

// ---- 14. TOP HAT — absurd, formal, perfect --------------------------------------------------------
function topHat(): AccessoryBuild {
  const g = new THREE.Group();
  // brim on the head top, not sunk to eye level
  g.position.y = 0.075;
  const feltMat = flat(0x16121e);
  const brim = cyl(0.41, 0.41, 0.025, feltMat, 0, 0.15, 0, 14);
  const tube = cyl(0.225, 0.24, 0.5, feltMat, 0, 0.42, 0, 12);
  const lid = cyl(0.23, 0.23, 0.02, feltMat, 0, 0.66, 0, 12);
  g.add(brim, tube, lid);
  const band = cyl(0.245, 0.245, 0.07, flat(0x4b2740), 0, 0.21, 0, 12);
  g.add(band);
  const buckle = box(0.09, 0.07, 0.02, flat(0xa8873f, 0xa8873f, 0.35), 0, 0.21, 0.24);
  g.add(buckle);
  const glint = new MoteEmitter({
    count: 6, color: 0xfff2c0, size: 0.045, life: 0.7, rate: 0.5, opacity: 0.9,
    spawn: shellSpawn(0.24, 0.6, 0.9), velocity: driftVelocity(new THREE.Vector3(0, 0.4, 0), 0.05, 0.15), drag: 1,
  });
  g.add(glint.points);
  return {
    group: g,
    tick: (t, dt) => {
      glint.update(dt);
      g.rotation.y = Math.sin(t * 0.23) * 0.05;
    },
    dispose: () => glint.dispose(),
  };
}

// ---- 15. BRAZIER CROWN — the king who burns ------------------------------------------------------
function brazierCrown(): AccessoryBuild {
  const g = new THREE.Group();
  // the band is narrower than the head — the brazier must sit ON the head top or it is swallowed
  g.position.y = 0.1;
  const ironMat = flat(0x3c3640);
  const band = torus(0.21, 0.028, ironMat, 14, 6);
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.14;
  g.add(band);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    g.add(cyl(0.014, 0.014, 0.2, ironMat, Math.cos(a) * 0.2, 0.24, Math.sin(a) * 0.2, 5));
  }
  const bowl = cyl(0.17, 0.09, 0.09, ironMat, 0, 0.36, 0, 10);
  g.add(bowl);
  const coalMat = glow(0xff8a2e, 0.95);
  const coals = [ball(0.035, coalMat, -0.06, 0.39, 0.02, 6, 5), ball(0.045, coalMat, 0.04, 0.4, -0.03, 6, 5), ball(0.03, coalMat, 0.02, 0.41, 0.06, 6, 5)];
  g.add(...coals);
  const flames = new MoteEmitter({
    count: 26, color: 0xff8c2a, size: 0.07, life: 0.8, rate: 14, opacity: 0.95,
    spawn: shellSpawn(0.1, 0.42, 0.5), velocity: driftVelocity(new THREE.Vector3(0, 1, 0), 0.25, 0.6), gravity: 0.5, drag: 1.4,
  });
  g.add(flames.points);
  return {
    group: g,
    tick: (t, dt) => {
      flames.update(dt);
      const flick = 0.75 + Math.sin(t * 17) * 0.12 + Math.sin(t * 7.3) * 0.08;
      coalMat.opacity = flick;
      for (const c of coals) c.scale.setScalar(0.9 + flick * 0.2);
    },
    dispose: () => flames.dispose(),
  };
}

// ---- 16. OVERSEER EYE — the big boss's little cousin ----------------------------------------------
function overseerEye(): AccessoryBuild {
  const g = new THREE.Group();
  const scleraMat = flat(0xf2ead8);
  const sclera = ball(0.17, scleraMat, 0, 0.55, 0, 12, 10);
  g.add(sclera);
  const iris = ball(0.082, flat(0x7a3fd6, 0x7a3fd6, 0.6), 0, 0.55, 0.115, 10, 8);
  g.add(iris);
  const pupilMat = glow(0x2a103f, 0.9);
  const pupil = ball(0.036, pupilMat, 0, 0.55, 0.175, 8, 6);
  g.add(pupil);
  const lashMat = flat(0x3a2a55);
  const lashes = hangChain(2, 0.09, 0.014, 0.006, lashMat, 5);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const chain = hangChain(2, 0.09, 0.015, 0.007, lashMat, 5);
    chain[0].position.set(Math.cos(a) * 0.14, 0.42, Math.sin(a) * 0.14);
    chain[0].rotation.z = -Math.cos(a) * 0.5;
    chain[0].rotation.x = Math.sin(a) * 0.5;
    g.add(chain[0]);
  }
  lashes[0].position.set(0, 0.4, 0);
  g.add(lashes[0]);
  const motes = new MoteEmitter({
    count: 10, color: 0xc79bff, size: 0.045, life: 1.6, rate: 1.2, opacity: 0.6,
    spawn: shellSpawn(0.2, 0.55, 0.5), velocity: driftVelocity(new THREE.Vector3(0, 0, 0), 0.03, 0.12), drag: 0.4,
  });
  g.add(motes.points);
  return {
    group: g,
    tick: (t, dt) => {
      motes.update(dt);
      const look = Math.sin(t * 0.6);
      iris.position.x = look * 0.05;
      iris.position.z = 0.115 - Math.abs(look) * 0.02;
      pupil.position.x = look * 0.05;
      g.position.y = 0.03 * Math.sin(t * 1.4);
      const blink = Math.max(0, Math.sin(t * 0.9) - 0.965) / 0.035;
      sclera.scale.y = iris.scale.y = pupil.scale.y = 1 - blink * 0.85;
      g.rotation.y = Math.sin(t * 0.4) * 0.12;
    },
    dispose: () => motes.dispose(),
  };
}

export const HATS: AccessoryDef[] = [
  { id: 'pumpkin', name: 'PUMPKIN JACK', desc: 'A carved pumpkin worn whole over the head, lit from inside.', build: pumpkin },
  { id: 'warlock', name: 'WARLOCK HAT', desc: 'A bent, brimmed hat that leaks arcane fall-out.', build: warlock },
  { id: 'bone-crown', name: 'BONE CROWN', desc: 'Three tiny skulls watch what you watch.', build: boneCrown },
  { id: 'iron-crown', name: 'IRON CROWN', desc: 'Spiked iron and a humming power gem.', build: ironCrown },
  { id: 'viking', name: 'VIKING HELM', desc: 'Horned steel dome. Nothing subtle about it.', build: viking },
  { id: 'skull-mask', name: 'SKULL MASK', desc: 'The whole head becomes bare bone. Embers in the sockets.', build: skullMask },
  { id: 'demon-horns', name: 'DEMON HORNS', desc: 'Fluted horns and a burning rune on the brow.', build: demonHorns },
  { id: 'plague-doctor', name: 'PLAGUE DOCTOR', desc: 'Wide brim, long beak, green-tinted glass.', build: plagueDoctor },
  { id: 'halo', name: 'HALO', desc: 'A ring of serene light that hovers and drips sparks.', build: halo },
  { id: 'tesla-coil', name: 'TESLA CROWN', desc: 'A caged head with live current crackling above it.', build: tesla },
  { id: 'ram-skull', name: 'RAM SKULL', desc: 'Old bone and curled horns, eyes still burning.', build: ramSkull },
  { id: 'santa', name: 'SANTA HAT', desc: 'The Necrophages took the holiday. We kept the hat.', build: santa },
  { id: 'hood', name: 'ASSASSIN HOOD', desc: 'A shadowed cowl that leaves your face bare.', build: assassinHood },
  { id: 'top-hat', name: 'TOP HAT', desc: 'Formal wear for the end of the world.', build: topHat },
  { id: 'brazier', name: 'BRAZIER CROWN', desc: 'A burning crown. You are the light of the colony.', build: brazierCrown },
  { id: 'overseer-eye', name: 'OVERSEER EYE', desc: 'A hovering eyeball that blinks, drifts and stares.', build: overseerEye },
];
