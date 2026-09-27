// NECROFALL — map pads: launch pads and blitz pads, scattered over the planet.
//
// Each pad is a real piece of hardware on the ground: an 8-sided base slab, a sunken deck, a lit rim
// and an inlaid emblem, with the floating tell above it (an up-arrow for a launch, an energy cube for
// a blitz). Placement is drawn from the MATCH SEED, so every peer builds the same pads in the same
// places without any network traffic. Only the local player can set one off (the trigger is part of
// local movement), and everything a pad does is either local motion (jump) or a networked event
// (the blitz ball broadcasts a flag and fires its exit blast through the ability event channel).
import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Planet } from '../world/Planet';
import type { Player } from '../player/Player';
import { CONFIG } from '../core/Config';
import { Rand, dirFromAngles, hashString, tangentBasis } from '../utils/Utils';

export type PadKind = 'jump' | 'blitz';

export const PAD_COLOUR: Record<PadKind, number> = {
  jump: 0x8ad8ff,
  blitz: 0xffc24d,
};

/** Everything on a pad that dims when it is spent. */
interface Pad {
  kind: PadKind;
  position: THREE.Vector3;
  up: THREE.Vector3;
  group: THREE.Group;
  /** Physical pad: slab, deck, rim, emblem. Never dims — it is hardware, not energy. */
  base: THREE.Mesh;
  deck: THREE.Mesh;
  rim: THREE.Mesh;
  rimMat: THREE.MeshBasicMaterial;
  emblem: THREE.Mesh;
  emblemMat: THREE.MeshBasicMaterial;
  /** Jump pads only: three rings that climb the pad, so "this bounces you up" is unmistakable. */
  liftRings: THREE.Mesh[];
  liftMat: THREE.MeshBasicMaterial | null;
  glow: THREE.Mesh;
  glowMat: THREE.MeshBasicMaterial;
  /** The floating marker: an up-arrow or an energy cube. */
  core: THREE.Group;
  coreMat: THREE.MeshBasicMaterial;
  /** Countdown readout shown while the pad is recharging. */
  label: THREE.Sprite;
  labelMat: THREE.SpriteMaterial;
  labelTex: THREE.CanvasTexture;
  labelCanvas: HTMLCanvasElement;
  labelText: string;
  /** Seconds until this pad may fire again. */
  cd: number;
  phase: number;
  /** Throttles for the marker's particle feed. */
  sparkT: number;
  ringT: number;
}

const _Y = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _from = new THREE.Vector3();
const _inward = new THREE.Vector3();
const _cube = new THREE.Vector3();
/** Neutral grey an energy part drops to while the pad recharges. */
const SPENT_COLOUR = 0x6a6478;

export class PadManager {
  private pads: Pad[] = [];
  /** Throttles the launch toast: a pad with no cooldown re-fires on every landing. */
  private announceT = 0;

  constructor(private game: Game) {}

  get count(): number {
    return this.pads.length;
  }

  /** Debug/testing hook: the pad list (kind + position). */
  list(): { kind: PadKind; position: THREE.Vector3; cd: number }[] {
    return this.pads.map(p => ({ kind: p.kind, position: p.position, cd: p.cd }));
  }

  clear(): void {
    for (const pad of this.pads) {
      this.game.scene.remove(pad.group);
      pad.base.geometry.dispose();
      pad.deck.geometry.dispose();
      pad.rim.geometry.dispose();
      pad.emblem.geometry.dispose();
      pad.glow.geometry.dispose();
      pad.core.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      (pad.base.material as THREE.Material).dispose();
      (pad.deck.material as THREE.Material).dispose();
      pad.rimMat.dispose();
      pad.emblemMat.dispose();
      pad.liftMat?.dispose();
      pad.glowMat.dispose();
      pad.coreMat.dispose();
      pad.labelTex.dispose();
      pad.labelMat.dispose();
    }
    this.pads.length = 0;
  }

  /** Rebuilds the pads for a fresh match. Deterministic from `seed`. */
  build(planet: Planet, seed: number): void {
    this.clear();
    const rng = new Rand(hashString(`nf-pads-${seed}`));
    const kinds: PadKind[] = [];
    for (let i = 0; i < CONFIG.pads.jumpCount; i++) kinds.push('jump');
    for (let i = 0; i < CONFIG.pads.blitzCount; i++) kinds.push('blitz');
    const placed: THREE.Vector3[] = [];
    const minDot = Math.cos(CONFIG.pads.minSeparation / CONFIG.planetRadius);
    for (const kind of kinds) {
      // stay away from the poles: the camera rig is awkward there and the pads would be unreachable
      for (let attempt = 0; attempt < 30; attempt++) {
        const lat = rng.range(-58, 58);
        const lon = rng.range(0, 360);
        dirFromAngles(lat, lon, _dir).normalize();
        // keep the pads apart so every one of them is its own landmark on the map
        let tooClose = false;
        for (const d of placed) {
          if (d.dot(_dir) > minDot) { tooClose = true; break; }
        }
        if (tooClose && attempt < 29) continue;
        break;
      }
      const height = planet.heightAtDir(_dir.x, _dir.y, _dir.z) + 0.06;
      const pad = this.make(kind, _dir.clone().multiplyScalar(height));
      this.pads.push(pad);
      placed.push(_dir.clone());
      this.game.scene.add(pad.group);
    }
  }

  private make(kind: PadKind, position: THREE.Vector3): Pad {
    const color = PAD_COLOUR[kind];
    const up = position.clone().normalize();
    const r = CONFIG.pads.radius;
    const group = new THREE.Group();
    group.position.copy(position);
    group.quaternion.setFromUnitVectors(_Y, up);

    // ---- the physical pad: a solid 8-sided slab that sits ON the terrain
    const baseMat = new THREE.MeshLambertMaterial({
      color: 0x2b2440,
      emissive: color,
      emissiveIntensity: 0.1,
      flatShading: true,
    });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.05, 0.3, 8), baseMat);
    base.position.y = 0.06;
    base.renderOrder = 2;

    // recessed deck plate, a touch darker and inset so the slab reads as a raised rim
    const deckMat = new THREE.MeshLambertMaterial({ color: 0x151024, flatShading: true });
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.86, r * 0.86, 0.06, 8), deckMat);
    deck.position.y = 0.2;
    deck.renderOrder = 3;

    // lit rim: a torus around the top edge — the brightest part of the pad
    const rimGeo = new THREE.TorusGeometry(r * 0.94, 0.075, 6, 30);
    rimGeo.rotateX(Math.PI / 2);
    const rimMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.y = 0.36;
    rim.renderOrder = 4;

    // inlaid emblem on the deck: a launch triangle, or a square containment frame
    const emblemGeo = kind === 'jump'
      ? new THREE.ConeGeometry(r * 0.34, 0.03, 3)
      : new THREE.RingGeometry(r * 0.42, r * 0.6, 4);
    emblemGeo.rotateX(-Math.PI / 2);
    emblemGeo.rotateY(kind === 'jump' ? -Math.PI / 2 : Math.PI / 4);
    const emblemMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const emblem = new THREE.Mesh(emblemGeo, emblemMat);
    emblem.position.y = 0.25;
    emblem.renderOrder = 4;

    // ---- jump pads: three rings stacked up the pad, climbing like the arrow does
    const liftRings: THREE.Mesh[] = [];
    let liftMat: THREE.MeshBasicMaterial | null = null;
    if (kind === 'jump') {
      liftMat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const liftGeo = new THREE.TorusGeometry(r * 0.72, 0.05, 6, 26);
      liftGeo.rotateX(Math.PI / 2);
      for (let i = 0; i < 3; i++) {
        const ring = new THREE.Mesh(liftGeo, liftMat);
        ring.position.y = 0.4 + i * 0.55;
        ring.renderOrder = 5;
        liftRings.push(ring);
        group.add(ring);
      }
    }

    // four bolts around the rim — small hardware details that sell it as a device
    const boltGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.1, 6);
    const boltMat = new THREE.MeshLambertMaterial({ color: 0x4a4062, flatShading: true });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const bolt = new THREE.Mesh(boltGeo, boltMat);
      bolt.position.set(Math.cos(a) * r * 0.9, 0.34, Math.sin(a) * r * 0.9);
      group.add(bolt);
    }

    // ---- the energy tell that floats above it
    const coreMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const core = new THREE.Group();
    if (kind === 'jump') {
      // 4-sided head + square shaft: the edges make the slow spin readable
      const head = new THREE.Mesh(new THREE.ConeGeometry(r * 0.44, r * 0.5, 4), coreMat);
      head.position.y = r * 0.31;
      head.rotation.y = Math.PI * 0.25;
      const shaft = new THREE.Mesh(new THREE.BoxGeometry(r * 0.2, r * 0.66, r * 0.2), coreMat);
      shaft.position.y = -r * 0.28;
      core.add(head, shaft);
    } else {
      const cube = new THREE.Mesh(new THREE.BoxGeometry(r * 0.62, r * 0.62, r * 0.62), coreMat);
      core.add(cube);
    }
    core.position.y = 1.75;
    core.renderOrder = 5;

    const shellGeo = new THREE.SphereGeometry(r * 0.55, 12, 9);
    const glowMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glow = new THREE.Mesh(shellGeo, glowMat);
    glow.position.y = 1.75;
    glow.renderOrder = 5;

    // ---- recharge readout (canvas sprite, redrawn only when the second changes)
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 128;
    labelCanvas.height = 64;
    const labelTex = new THREE.CanvasTexture(labelCanvas);
    const labelMat = new THREE.SpriteMaterial({
      map: labelTex, transparent: true, depthWrite: false, depthTest: false,
    });
    const label = new THREE.Sprite(labelMat);
    label.scale.set(2.4, 1.2, 1);
    label.position.y = 3.3;
    label.renderOrder = 22;
    label.visible = false;

    group.add(base, deck, rim, emblem, glow, core, label);
    return {
      kind, position: position.clone(), up, group,
      base, deck, rim, rimMat, emblem, emblemMat, liftRings, liftMat,
      glow, glowMat, core, coreMat,
      label, labelMat, labelTex, labelCanvas, labelText: '\u0000',
      cd: 0, phase: Math.random() * 10, sparkT: Math.random() * 0.3, ringT: 0.6,
    };
  }

  update(dt: number): void {
    if (this.pads.length === 0) return;
    const g = this.game;
    const t = g.clock;
    if (this.announceT > 0) this.announceT -= dt;
    const p = g.localPlayer;
    const reach = CONFIG.pads.radius + 0.7;
    const reach2 = reach * reach;
    for (const pad of this.pads) {
      pad.phase += dt;
      if (pad.cd > 0) pad.cd = Math.max(0, pad.cd - dt);
      const ready = pad.cd <= 0;

      // idle animation: the marker bobs and turns, the rim breathes
      const bob = Math.sin(t * 2 + pad.phase);
      pad.core.position.y = 1.75 + bob * 0.22;
      pad.glow.position.y = 1.75 + bob * 0.22;
      if (pad.kind === 'jump') {
        pad.core.rotation.y += dt * 0.9;
        pad.core.scale.setScalar((ready ? 1 : 0.7) * (1 + 0.06 * Math.sin(t * 3.4 + pad.phase)));
        pad.core.scale.y *= 1 + 0.06 * Math.sin(t * 3.4 + pad.phase);
      } else {
        pad.core.rotation.y += dt * (ready ? 1.1 : 0.35);
        pad.core.rotation.x += dt * (ready ? 0.55 : 0.18);
        pad.core.scale.setScalar((ready ? 1 : 0.62) * (1 + 0.06 * Math.sin(t * 4 + pad.phase)));
      }

      // SPENT pads go grey, dark and still — unmistakably not usable
      const col = ready ? PAD_COLOUR[pad.kind] : SPENT_COLOUR;
      if (pad.liftMat) pad.liftMat.color.setHex(col);
      pad.rimMat.color.setHex(col);
      pad.emblemMat.color.setHex(col);
      pad.coreMat.color.setHex(col);
      pad.glowMat.color.setHex(col);
      pad.rimMat.opacity = ready ? 0.95 : 0.16;
      pad.emblemMat.opacity = ready ? 0.8 : 0.1;
      pad.coreMat.opacity = ready ? 0.9 : 0.2;
      pad.glowMat.opacity = ready
        ? 0.2 + (0.5 + 0.5 * Math.sin(t * 2.4 + pad.phase)) * 0.16
        : 0.03;

      // the lift rings climb the pad and fade at the top, restating that you go UP here
      if (pad.liftRings.length > 0 && pad.liftMat) {
        for (let i = 0; i < pad.liftRings.length; i++) {
          const cyc = (t * 0.62 + i / pad.liftRings.length + pad.phase * 0.05) % 1;
          const ring = pad.liftRings[i];
          ring.position.y = 0.35 + cyc * 2.25;
          ring.scale.setScalar(0.72 + cyc * 0.34);
          ring.rotation.y += dt * 0.7;
        }
        // one shared material: fade with the cycle of whichever ring is highest is too fiddly, so
        // the stack breathes as a unit and goes dark when the pad is spent
        pad.liftMat.opacity = ready ? 0.3 + 0.26 * Math.sin(t * 2.6 + pad.phase) : 0.05;
      }

      // countdown readout
      const secs = ready ? '' : `${Math.ceil(pad.cd)}s`;
      if (secs !== pad.labelText) {
        pad.labelText = secs;
        this.drawLabel(pad, secs);
      }
      pad.label.visible = !ready;

      // Blitz pads are fed by energy: particles stream in from a ring around the cube, plus a
      // periodic shock ring. A spent pad feeds nothing. Only near the local player, to stay cheap.
      if (pad.kind === 'blitz' && ready) {
        _cube.copy(pad.position).addScaledVector(pad.up, 1.75);
        const near = !p || p.position.distanceToSquared(pad.position) < 80 * 80;
        pad.sparkT -= dt;
        if (near && pad.sparkT <= 0) {
          pad.sparkT = 0.07;
          const ang = Math.random() * Math.PI * 2;
          const dist = CONFIG.pads.radius * (1.1 + Math.random() * 0.9);
          tangentBasis(pad.up, _t1, _t2);
          _from.copy(_cube)
            .addScaledVector(_t1, Math.cos(ang) * dist)
            .addScaledVector(_t2, Math.sin(ang) * dist)
            .addScaledVector(pad.up, (Math.random() - 0.5) * 1.6);
          _inward.copy(_cube).sub(_from).normalize();
          g.effects.burst(_from, PAD_COLOUR.blitz, {
            count: 2, speed: 8.5, life: 0.42, size: 0.42, gravity: 0, drag: 0.2,
            dir: _inward, jitter: 0.24,
          });
        }
        pad.ringT -= dt;
        if (near && pad.ringT <= 0) {
          pad.ringT = 1.25;
          g.effects.ring(_cube, pad.up, CONFIG.pads.radius * 0.6, PAD_COLOUR.blitz, 0.55, 3.4, 0.7);
          g.effects.burst(_cube, PAD_COLOUR.blitz, { count: 4, speed: 4, life: 0.35, size: 0.4, gravity: 0, drag: 2 });
        }
      }

      if (!ready || !p || !p.alive || !p.grounded || p.frozen) continue;
      if (p.position.distanceToSquared(pad.position) > reach2) continue;
      this.fire(pad, p);
    }
  }

  /** Paints the recharge countdown sprite. */
  private drawLabel(pad: Pad, text: string): void {
    const ctx = pad.labelCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, pad.labelCanvas.width, pad.labelCanvas.height);
    if (!text) {
      pad.labelTex.needsUpdate = true;
      return;
    }
    ctx.fillStyle = 'rgba(8, 5, 16, 0.78)';
    ctx.strokeStyle = 'rgba(255, 194, 77, 0.9)';
    ctx.lineWidth = 5;
    const w = 104, h = 46, x = (pad.labelCanvas.width - w) / 2, y = (pad.labelCanvas.height - h) / 2;
    const rad = 12;
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.arcTo(x + w, y, x + w, y + rad, rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
    ctx.lineTo(x + rad, y + h);
    ctx.arcTo(x, y + h, x, y + h - rad, rad);
    ctx.lineTo(x, y + rad);
    ctx.arcTo(x, y, x + rad, y, rad);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.font = '900 30px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffd88a';
    ctx.fillText(text, pad.labelCanvas.width / 2, pad.labelCanvas.height / 2 + 1);
    pad.labelTex.needsUpdate = true;
  }

  private fire(pad: Pad, p: Player): void {
    const g = this.game;
    const color = PAD_COLOUR[pad.kind];
    // the launch pad re-arms instantly (land on it and you bounce again); a blitz has to recharge
    pad.cd = pad.kind === 'jump' ? CONFIG.pads.jumpCooldown : CONFIG.pads.blitzCooldown;
    g.effects.ring(pad.position, pad.up, CONFIG.pads.radius, color, 0.5, 2.6, 0.95);
    g.effects.burst(pad.position, color, { count: 22, speed: 14, life: 0.6, size: 0.7, gravity: 4 });

    if (pad.kind === 'jump') {
      // height scales with v², so √mul × the release speed gives `jumpHeightMul` normal jumps of height
      p.launch(CONFIG.player.jumpSpeed * Math.sqrt(CONFIG.pads.jumpHeightMul));
      g.audio.sfx('jump', 1);
      if (this.announceT <= 0) {
        this.announceT = 2;
        g.ui.toast('JUMP PAD — LAUNCHED', 1500);
      }
    } else {
      p.startBlitz(CONFIG.pads.blitzTime);
      g.effects.burst(p.position, color, { count: 40, speed: 18, life: 0.7, size: 0.8, gravity: 0 });
      g.effects.ring(p.position, p.up, 1.4, 0xffe6a8, 0.6, 3.4, 1);
      g.audio.sfx('mutation', 0.8);
      g.ui.toast(`BLITZ — ${CONFIG.pads.blitzTime}s, GO GO GO`, 1800);
    }
  }
}
