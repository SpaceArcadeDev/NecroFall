// NECROFALL — Necrotech WEAPON MODELS, shared by the selection screen and the players themselves.
//
// One model per class, built from primitives to match what that class actually does: RAVAGER fires
// bolts, BREAKER punches with air fists, VOLT arcs, PYRE sprays, RIFT phases, FROST casts shards,
// VENOM lobs toxin, BULWARK slams a siege cannon, REAPER carves with a scythe, NOVA pulses and
// WHIPLASH lashes a chain. Everything is built pointing along +X, roughly centred on its own grip,
// so both consumers can place it with the same rules:
//   • the selection screen hangs the raw model on a slow turntable;
//   • `buildHeldWeapon` wraps it in a holder with the GRIP at the origin and the barrel along +Z,
//     scaled to a person's hands, ready to be mounted on a hand bone.
import * as THREE from 'three';
import { NecrotechDef } from './NecrotechData';

const METAL = 0x2c2a44;
const DARK = 0x191626;

interface WeaponMats {
  metal: THREE.MeshLambertMaterial;
  dark: THREE.MeshLambertMaterial;
  accent: THREE.MeshLambertMaterial;
  glow: THREE.MeshBasicMaterial;
}

function weaponMats(accentColor: number): WeaponMats {
  return {
    metal: new THREE.MeshLambertMaterial({ color: METAL, flatShading: true }),
    dark: new THREE.MeshLambertMaterial({ color: DARK, flatShading: true }),
    accent: new THREE.MeshLambertMaterial({
      color: accentColor, emissive: accentColor, emissiveIntensity: 0.6, flatShading: true,
    }),
    glow: new THREE.MeshBasicMaterial({
      color: accentColor, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
  };
}

const box = (m: THREE.Material, w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.Mesh => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
};
const cyl = (m: THREE.Material, r1: number, r2: number, len: number, x = 0, y = 0, z = 0, seg = 8): THREE.Mesh => {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, seg), m);
  mesh.position.set(x, y, z);
  return mesh;
};
const ringFx = (m: THREE.Material, r: number, tube: number, x = 0, y = 0, z = 0): THREE.Mesh => {
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 6, 24), m);
  mesh.position.set(x, y, z);
  return mesh;
};

/**
 * The class a loadout's weapon is shaped after. A fused name reads "RAVAGER·FROST" (or "✷" for a
 * super), and the FIRST segment is always the class the run started with — the chassis the model
 * follows while the tint tracks the live loadout.
 */
export function weaponClassOf(name: string): string {
  return (name.split(/[·✷]/)[0] || '').trim().toUpperCase();
}

/**
 * Builds the raw weapon model, pointing along +X. `accentColor` overrides the class colour — used
 * in a match so a mutated loadout keeps its fused colour while the shape stays its class.
 */
export function buildWeaponModel(def: NecrotechDef, accentColor?: number): THREE.Group {
  const g = new THREE.Group();
  const { metal, dark, accent, glow } = weaponMats(accentColor ?? def.stats.color);
  switch (weaponClassOf(def.name)) {
    case 'RAVAGER': {
      // assault rifle: receiver, long barrel, magazine, stock and a sight
      g.add(box(metal, 0.72, 0.16, 0.14, 0.1, 0, 0));
      g.add(cyl(accent, 0.035, 0.04, 0.5, 0.72, 0.01, 0).rotateZ(-Math.PI / 2));
      g.add(box(dark, 0.12, 0.26, 0.1, 0.05, -0.18, 0));
      g.add(box(metal, 0.3, 0.13, 0.11, -0.42, -0.02, 0));
      g.add(box(dark, 0.26, 0.09, 0.1, -0.6, 0, 0));
      g.add(box(accent, 0.16, 0.08, 0.08, 0.06, 0.14, 0));
      g.add(ringFx(glow, 0.07, 0.02, 0.97, 0.01, 0).rotateY(Math.PI / 2));
      break;
    }
    case 'BREAKER': {
      // power gauntlet with a compressed-air ring punched forward
      g.add(box(metal, 0.5, 0.34, 0.4, -0.1, 0, 0));
      g.add(box(dark, 0.26, 0.42, 0.46, 0.22, 0, 0));
      for (let i = 0; i < 3; i++) g.add(box(accent, 0.16, 0.12, 0.14, 0.38, 0.1 - i * 0.12, 0));
      g.add(ringFx(glow, 0.34, 0.035, 0.86, 0, 0).rotateY(Math.PI / 2));
      g.add(ringFx(glow, 0.22, 0.03, 0.72, 0, 0).rotateY(Math.PI / 2));
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), glow);
      puff.position.set(1.12, 0, 0);
      g.add(puff);
      break;
    }
    case 'VOLT': {
      // arc projector: insulated shaft, three coil rings and a live electrode
      g.add(box(dark, 0.3, 0.14, 0.14, -0.55, -0.05, 0));
      g.add(cyl(metal, 0.07, 0.07, 0.6, -0.1, 0, 0).rotateZ(-Math.PI / 2));
      for (let i = 0; i < 3; i++) g.add(ringFx(accent, 0.14 - i * 0.015, 0.03, 0.06 + i * 0.2, 0, 0).rotateY(Math.PI / 2));
      g.add(cyl(metal, 0.03, 0.05, 0.24, 0.66, 0, 0).rotateZ(-Math.PI / 2));
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), accent);
      ball.position.set(0.86, 0, 0);
      const aura = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 10), glow);
      aura.position.copy(ball.position);
      g.add(ball, aura);
      break;
    }
    case 'PYRE': {
      // flamethrower: pressure tank under the spine, lance, flared nozzle and a pilot flame
      g.add(cyl(metal, 0.11, 0.11, 0.62, -0.12, -0.14, 0).rotateZ(-Math.PI / 2));
      g.add(cyl(dark, 0.06, 0.06, 0.3, -0.48, -0.14, 0).rotateZ(-Math.PI / 2));
      g.add(box(dark, 0.3, 0.12, 0.1, -0.42, 0.04, 0));
      g.add(cyl(accent, 0.04, 0.05, 0.7, 0.32, 0.02, 0).rotateZ(-Math.PI / 2));
      const flare = cyl(accent, 0.11, 0.05, 0.18, 0.76, 0.02, 0).rotateZ(-Math.PI / 2);
      g.add(flare);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.5, 10), glow);
      flame.position.set(1.15, 0.02, 0);
      flame.rotation.z = -Math.PI / 2;
      g.add(flame);
      break;
    }
    case 'RIFT': {
      // phase blade: grip, guard, two blade segments with a gap where the cut happens
      g.add(cyl(dark, 0.045, 0.05, 0.26, -0.5, 0, 0, 8).rotateZ(-Math.PI / 2));
      g.add(box(metal, 0.16, 0.22, 0.08, -0.32, 0, 0));
      g.add(box(accent, 0.14, 0.12, 0.12, -0.2, 0, 0));
      for (let i = 0; i < 2; i++) {
        const seg = box(accent, 0.42, 0.035, 0.06, i * 0.56 + 0.14, 0, 0);
        const edge = box(glow, 0.46, 0.09, 0.03, i * 0.56 + 0.14, 0, 0);
        g.add(seg, edge);
      }
      g.add(ringFx(glow, 0.16, 0.02, 0.84, 0, 0).rotateY(Math.PI / 2));
      break;
    }
    case 'FROST': {
      // cryo caster: emitter ring and a cluster of ice shards
      g.add(box(metal, 0.5, 0.16, 0.16, -0.16, 0, 0));
      g.add(box(dark, 0.2, 0.24, 0.12, -0.5, -0.1, 0));
      g.add(ringFx(accent, 0.16, 0.04, 0.18, 0, 0).rotateY(Math.PI / 2));
      for (let i = 0; i < 4; i++) {
        const shard = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.4, 5), accent);
        const a = (i / 4) * Math.PI * 2;
        shard.position.set(0.42 + Math.cos(a) * 0.12, Math.sin(a) * 0.12, Math.sin(a) * 0.1);
        shard.rotation.z = -Math.PI / 2 + Math.sin(a) * 0.35;
        shard.rotation.y = -a * 0.5;
        g.add(shard);
      }
      const chill = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), glow);
      chill.position.set(0.62, 0, 0);
      g.add(chill);
      break;
    }
    case 'VENOM': {
      // toxin launcher: flask, ribbed hose and a wide bell mouth
      const flask = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), dark);
      flask.position.set(-0.42, -0.05, 0);
      g.add(flask);
      g.add(cyl(metal, 0.05, 0.05, 0.36, -0.14, 0.02, 0).rotateZ(-Math.PI / 2));
      g.add(cyl(dark, 0.055, 0.055, 0.5, 0.2, -0.04, 0).rotateZ(-Math.PI / 2));
      for (let i = 0; i < 4; i++) g.add(ringFx(metal, 0.075, 0.02, -0.02 + i * 0.14, -0.04, 0).rotateY(Math.PI / 2));
      const bell = cyl(accent, 0.06, 0.19, 0.24, 0.58, -0.04, 0).rotateZ(-Math.PI / 2);
      g.add(bell);
      const drip = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 8), glow);
      drip.position.set(0.78, -0.04, 0);
      g.add(drip);
      break;
    }
    case 'BULWARK': {
      // siege cannon: fat barrel, reinforcement bands, muzzle brake and a stabilising stand
      g.add(cyl(metal, 0.16, 0.17, 0.86, 0.1, 0, 0).rotateZ(-Math.PI / 2));
      for (let i = 0; i < 3; i++) g.add(ringFx(accent, 0.18, 0.035, -0.12 + i * 0.24, 0, 0).rotateY(Math.PI / 2));
      g.add(cyl(dark, 0.19, 0.19, 0.2, 0.62, 0, 0).rotateZ(-Math.PI / 2));
      for (let i = 0; i < 3; i++) g.add(box(accent, 0.16, 0.05, 0.26, 0.7, 0, -0.1 + i * 0.1));
      g.add(box(dark, 0.24, 0.3, 0.3, -0.42, -0.04, 0));
      g.add(cyl(dark, 0.05, 0.05, 0.4, -0.5, -0.3, 0).rotateX(Math.PI / 2));
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 8), glow);
      core.position.set(0.9, 0, 0);
      g.add(core);
      break;
    }
    case 'REAPER': {
      // scythe: long shaft with a curved blade — the 240° sweep the class actually swings
      const shaft = cyl(dark, 0.045, 0.05, 1.5, 0, 0, 0, 8);
      shaft.rotation.z = Math.PI / 2;
      g.add(shaft);
      g.add(cyl(metal, 0.06, 0.06, 0.16, -0.6, 0, 0, 8).rotateZ(Math.PI / 2));
      g.add(box(accent, 0.18, 0.1, 0.12, 0.4, 0, 0));
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0.74, 0.05, 0),
        new THREE.Vector3(0.92, 0.34, 0),
        new THREE.Vector3(0.72, 0.62, 0),
        new THREE.Vector3(0.32, 0.66, 0),
      ]);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 18, 0.045, 5, false), metal));
      const edge = new THREE.Mesh(new THREE.TubeGeometry(curve, 18, 0.02, 4, false), glow);
      edge.position.set(0, 0, 0.055);
      g.add(edge);
      break;
    }
    case 'NOVA': {
      // pulse emitter: dish, focus rod and two containment rings ahead of it
      const dish = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), metal);
      dish.rotation.z = Math.PI / 2;
      dish.position.set(0.1, 0, 0);
      g.add(dish);
      g.add(cyl(accent, 0.06, 0.09, 0.3, 0.3, 0, 0).rotateZ(-Math.PI / 2));
      g.add(box(dark, 0.26, 0.14, 0.14, -0.3, 0, 0));
      g.add(cyl(dark, 0.05, 0.05, 0.2, -0.46, -0.14, 0, 8));
      g.add(ringFx(glow, 0.3, 0.03, 0.66, 0, 0).rotateY(Math.PI / 2));
      g.add(ringFx(glow, 0.44, 0.025, 0.94, 0, 0).rotateY(Math.PI / 2));
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), glow);
      core.position.set(0.46, 0, 0);
      g.add(core);
      break;
    }
    case 'WHIPLASH': {
      // chain whip: handle, drooping chain of links and a weighted tip
      g.add(cyl(dark, 0.06, 0.07, 0.44, -0.5, 0, 0, 8).rotateZ(-Math.PI / 2));
      g.add(box(accent, 0.12, 0.12, 0.12, -0.28, 0, 0));
      for (let i = 0; i < 9; i++) {
        const f = i / 8;
        const link = ringFx(i % 2 === 0 ? metal : dark, 0.075, 0.022, -0.18 + f * 0.95, 0.1 - f * f * 0.55, 0);
        link.rotation.y = (i % 2) * Math.PI / 2;
        g.add(link);
      }
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), accent);
      tip.position.set(0.83, -0.5, 0);
      g.add(tip);
      break;
    }
    default: {
      // an unknown class still gets a shaped emitter rather than an empty hand
      g.add(box(metal, 0.6, 0.16, 0.16, 0, 0, 0));
      g.add(cyl(accent, 0.05, 0.06, 0.4, 0.44, 0, 0).rotateZ(-Math.PI / 2));
      break;
    }
  }
  return g;
}

/** How big a held weapon is, relative to the display model (built for a 1.8 m show stand). */
const HELD_SCALE = 0.58;

/**
 * Wraps a weapon for a HAND: the holder's origin is the grip, its +Z is the muzzle direction, and
 * the whole thing is scaled to a ~2 m character. Mount the returned holder on a hand and it sits
 * right — every class model is measured, not hand-tuned, so a new one lines up automatically.
 * `holder.userData.tipZ` is how far the muzzle ends up in front of the grip.
 */
export function buildHeldWeapon(def: NecrotechDef, accentColor?: number): THREE.Group {
  const model = buildWeaponModel(def, accentColor);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const centre = bounds.getCenter(new THREE.Vector3());
  // the grip sits a third of the way along the weapon: behind a rifle's receiver, mid-shaft on a
  // scythe, inside a gauntlet — right for every shape without a per-class table to drift out of date
  const gripX = bounds.min.x + size.x * 0.3;
  const scale = HELD_SCALE;
  // point +X down the holder's +Z, then bring the grip point on to the origin. Three composes
  // T·R·S, so the translation that lands the grip at the origin is R(S(grip)) negated.
  model.rotation.y = -Math.PI / 2;
  model.scale.setScalar(scale);
  model.position.set(centre.z * scale, -centre.y * scale, -gripX * scale);
  const holder = new THREE.Group();
  holder.name = 'weapon';
  holder.add(model);
  holder.userData.tipZ = (bounds.max.x - gripX) * scale;
  return holder;
}
