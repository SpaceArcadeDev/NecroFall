// NECROFALL — input: keyboard/mouse (desktop) + virtual joystick / buttons / aim pad (mobile).
import * as THREE from 'three';
import type { GameCamera } from '../camera/GameCamera';
import type { Planet } from '../world/Planet';
import { IS_TOUCH } from '../core/Config';
import { clamp, nowSec } from '../utils/Utils';
import { Keybinds } from './Keybinds';

const _dir = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _up = new THREE.Vector3();

export class InputManager {
  enabled = true;
  readonly mobile = IS_TOUCH;

  moveX = 0;
  moveY = 0;
  aimDir = new THREE.Vector3(0, 0, 1);
  aimPoint = new THREE.Vector3();
  hasAim = false;
  /**
   * Which ability is currently being AIMED (held, not yet released). While a button is down the
   * ground marker for that ability is emphasised and the cast fires on release — the standard MOBA
   * "press, drag, let go" gesture. Keyboard Q / E cast instantly.
   */
  aimHold: 'skill' | 'ult' | null = null;
  /**
   * Physical-button latches, independent of `aimHold`. `aimHold` is deliberately cleared by a
   * window blur (a notification, a focus steal, a devtools click) — but the button is still DOWN
   * and its release must still cast. Without these, "hold right click to aim the ult, release…
   * nothing happens" was exactly the desktop bug that got reported.
   */
  private lmbDown = false;
  private rmbDown = false;

  private ndc = new THREE.Vector2(0, 0);
  private mouseSeen = false;
  private keys = new Set<string>();
  private qJump = false;
  private qDash = false;
  private qSkill = false;
  private qUlt = false;
  private qBeacon = false;

  private joyActive = false;
  private joyX = 0;
  private joyY = 0;
  private touchAimActive = false;
  private touchAimX = 0;
  private touchAimY = 0;

  private wheelAccum = 0;
  private qMenu = false;

  /**
   * When the player last gave a DIRECTIONAL or ACTION input — movement, a jump / dash / ability
   * press, a cast release — INCLUDING holding one (movement keys / the stick re-mark this every
   * frame, see `update`). Aim-only mouse movement deliberately does NOT count (on desktop the
   * cursor never stops), while arrow-key aiming, the touch aim pad and the virtual joystick do.
   */
  private lastActivityAt = nowSec();
  /**
   * Timestamp of the last FRESH input EDGE — a new key press, a queued action, a stick or aim
   * engage. Holding a direction does NOT re-mark this (that is the difference from
   * `lastActivityAt`). The RECALL channel reads this: a channel pressed mid-run must not die just
   * because the old run key is still held, but a NEW press during the channel must break it.
   */
  private lastEdgeAt = nowSec();

  private disposers: (() => void)[] = [];

  constructor(private el: HTMLElement) {
    const on = <K extends keyof WindowEventMap>(target: Window | HTMLElement, type: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type as string, fn as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type as string, fn as EventListener));
    };

    on(window, 'keydown', (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      // Esc opens the pause menu even when gameplay input is disabled
      if (e.code === 'Escape') {
        e.preventDefault();
        this.qMenu = true;
        return;
      }
      if (!this.enabled) return;
      const code = e.code;
      const action = Keybinds.actionFor(code);
      if (action || code.startsWith('F') || code.startsWith('Arrow')) {
        e.preventDefault();
      }
      if (this.keys.has(code)) return;
      this.keys.add(code);
      this.markEdge();
      if (action === 'jump') this.qJump = true;
      else if (action === 'dash') this.qDash = true;
      else if (action === 'beacon') this.qBeacon = true;
      // the Skill and the Ultimate also cast from the keyboard (mouse: left = skill, right = ultimate)
      else if (action === 'skill') this.qSkill = true;
      else if (action === 'ult') this.qUlt = true;
      if (code === 'Escape') this.qMenu = true; // always available (pause menu)
    });
    on(window, 'keyup', (e: KeyboardEvent) => {
      this.keys.delete(e.code);
    });
    on(window, 'blur', () => this.keys.clear());

    on(
      el,
      'wheel',
      (e: WheelEvent) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.wheelAccum += e.deltaY > 0 ? 1 : -1;
      },
      { passive: false }
    );

    on(el, 'mousemove', (e: MouseEvent) => {
      this.mouseSeen = true;
      const w = window.innerWidth, h = window.innerHeight;
      this.ndc.set((e.clientX / w) * 2 - 1, -(e.clientY / h) * 2 + 1);
    });

    on(el, 'mousedown', (e: MouseEvent) => {
      if (!this.enabled) return;
      // press and hold to aim (the ground marker follows the cursor), release to cast
      if (e.button === 0) {
        this.lmbDown = true;
        this.aimHold = 'skill';
        this.markEdge();
      } else if (e.button === 2) {
        this.rmbDown = true;
        this.aimHold = 'ult';
        this.markEdge();
      }
      e.preventDefault();
    });
    on(window, 'mouseup', (e: MouseEvent) => {
      if (!this.enabled) {
        this.aimHold = null;
        this.lmbDown = this.rmbDown = false;
        return;
      }
      const held = this.aimHold;
      this.aimHold = null;
      // The RELEASE owns the cast: `aimHold` may have been wiped mid-hold (a blur, a focus steal),
      // so the button latches decide — not the aim bookkeeping.
      if (e.button === 0 && (held === 'skill' || this.lmbDown)) { this.qSkill = true; this.markEdge(); }
      else if (e.button === 2 && (held === 'ult' || this.rmbDown)) { this.qUlt = true; this.markEdge(); }
      if (e.button === 0) this.lmbDown = false;
      if (e.button === 2) this.rmbDown = false;
    });
    on(window, 'blur', () => {
      // The AIM TELL stops (we cannot know where the cursor is), but the button latches stay:
      // if the release still arrives, it must cast.
      this.aimHold = null;
    });
    on(window, 'contextmenu', (e: MouseEvent) => {
      if (this.enabled) e.preventDefault();
    });
    on(window, 'mousedown', (e: MouseEvent) => {
      // context menu suppression helper (keeps focus behaviour predictable)
      if (e.button === 2 && this.enabled) e.preventDefault();
    });
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    // The activity/edge clocks restart with control: a menu session never banks an old edge.
    if (v) this.markActivity();
    if (!v) {
      this.moveX = 0;
      this.moveY = 0;
      this.aimHold = null;
      // A menu eats the held buttons too: the next release must not cast into the world.
      this.lmbDown = this.rmbDown = false;
      this.keys.clear();
      this.qJump = this.qDash = this.qSkill = this.qUlt = this.qBeacon = false;
    }
  }

  /** Mobile: the skill / ult buttons report their drag as an aim hold. */
  setAiming(kind: 'skill' | 'ult' | null): void {
    this.aimHold = kind;
    if (kind) this.markEdge();
  }

  /** Marks a directional / action input that is HELD (see `lastActivityAt`). */
  markActivity(): void { this.lastActivityAt = nowSec(); }

  /** Marks a FRESH edge — a press, a queued action, a stick engage (see `lastEdgeAt`). */
  markEdge(): void { this.markActivity(); this.lastEdgeAt = this.lastActivityAt; }

  /** Seconds since the last directional or action input (holding counts — see `lastActivityAt`). */
  get idleFor(): number { return nowSec() - this.lastActivityAt; }

  /** The last fresh input edge's timestamp — the RECALL channel's cancel watch reads this. */
  get lastEdge(): number { return this.lastEdgeAt; }

  // ---- mobile plumbing -------------------------------------------------
  /** Whether the stick / aim pad was engaged on the previous call (edge detection). */
  private joyHot = false;
  private touchAimHot = false;
  setJoystick(x: number, y: number, active: boolean): void {
    this.joyX = x;
    this.joyY = y;
    this.joyActive = active;
    const hot = active && x * x + y * y > 0.02;
    if (hot) {
      if (!this.joyHot) this.markEdge();
      else this.markActivity();
    }
    this.joyHot = hot;
  }
  setTouchAim(x: number, y: number, active: boolean): void {
    this.touchAimX = x;
    this.touchAimY = y;
    this.touchAimActive = active;
    const hot = active && x * x + y * y > 0.02;
    if (hot) {
      if (!this.touchAimHot) this.markEdge();
      else this.markActivity();
    }
    this.touchAimHot = hot;
  }
  queueJump(): void { this.qJump = true; this.markEdge(); }
  queueDash(): void { this.qDash = true; this.markEdge(); }
  queueSkill(): void { this.qSkill = true; this.markEdge(); }
  queueUlt(): void { this.qUlt = true; this.markEdge(); }
  queueBeacon(): void { this.qBeacon = true; this.markEdge(); }

  // ---- consumed edges ---------------------------------------------------
  consumeJump(): boolean { const v = this.qJump; this.qJump = false; return v && this.enabled; }
  consumeDash(): boolean { const v = this.qDash; this.qDash = false; return v && this.enabled; }
  consumeSkill(): boolean { const v = this.qSkill; this.qSkill = false; return v && this.enabled; }
  consumeUlt(): boolean { const v = this.qUlt; this.qUlt = false; return v && this.enabled; }
  consumeBeacon(): boolean { const v = this.qBeacon; this.qBeacon = false; return v && this.enabled; }

  /** Mouse-wheel steps since the last call (positive = zoom out). */
  consumeWheel(): number {
    const v = this.wheelAccum;
    this.wheelAccum = 0;
    return this.enabled ? v : 0;
  }

  /** Esc — consumed even while gameplay input is disabled. */
  consumeMenu(): boolean {
    const v = this.qMenu;
    this.qMenu = false;
    return v;
  }

  clearQueued(): void {
    this.qMenu = false;
    this.wheelAccum = 0;
  }

  /**
   * Drops every queued gameplay action. A menu — or death — eats the input that was headed for the
   * world, so nothing the player pressed while the screen was theirs alone fires the moment the
   * picker closes or the respawn lands.
   */
  clearActions(): void {
    this.qJump = this.qDash = this.qSkill = this.qUlt = this.qBeacon = false;
    this.aimHold = null;
    this.lmbDown = this.rmbDown = false;
  }

  /**
   * Recomputed every frame by the game before player simulation.
   *
   * `aimReach` is the furthest a full touch drag places a blast — the local player's auto-attack
   * range, since every ability reach is a fraction of it and `resolveAim` clamps to it anyway.
   */
  update(cam: GameCamera, planet: Planet, playerPos: THREE.Vector3, aimReach = 0): void {
    if (!this.enabled) {
      this.moveX = 0;
      this.moveY = 0;
      return;
    }

    if (this.joyActive) {
      this.moveX = clamp(this.joyX, -1, 1);
      this.moveY = clamp(this.joyY, -1, 1);
    } else {
      let x = 0, y = 0;
      if (this.keys.has(Keybinds.get('right'))) x += 1;
      if (this.keys.has(Keybinds.get('left'))) x -= 1;
      if (this.keys.has(Keybinds.get('up'))) y += 1;
      if (this.keys.has(Keybinds.get('down'))) y -= 1;
      const len = Math.hypot(x, y);
      if (len > 1) {
        x /= len;
        y /= len;
      }
      this.moveX = x;
      this.moveY = y;
    }

    // Holding a direction is activity even when nothing was pressed this frame.
    if (this.moveX * this.moveX + this.moveY * this.moveY > 0.02) this.markActivity();

    // aim direction — arrow keys steer it directly (screen-up is forward), and take priority
    // over the pointer so the skill always goes where the arrows point.
    const up = _up.copy(playerPos).normalize();
    const arrowX = (this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('ArrowLeft') ? 1 : 0);
    const arrowY = (this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('ArrowDown') ? 1 : 0);
    if (arrowX !== 0 || arrowY !== 0) {
      cam.moveBasis(up, _f, _r);
      _dir.copy(_f).multiplyScalar(arrowY).addScaledVector(_r, arrowX);
      _dir.addScaledVector(up, -_dir.dot(up));
      if (_dir.lengthSq() > 1e-5) {
        this.aimDir.copy(_dir.normalize());
        this.aimPoint.copy(playerPos).addScaledVector(this.aimDir, 10);
        this.hasAim = true;
      }
    } else if (this.touchAimActive) {
      // The drag arrives as a UNIT direction scaled by how far it was dragged (0..1), so the
      // direction is exact at any magnitude and the magnitude is the reach. Reading only the
      // direction and then placing the point at a FIXED distance threw the magnitude away: every
      // circle ability landed at the same spot down the aim, and whenever that fixed distance was
      // past the ability's own range — which is most close-range circles — the blast clipped to the
      // far edge of the ring and could not be pulled in at all.
      const drag = Math.hypot(this.touchAimX, this.touchAimY);
      if (drag > 0.02) {
        cam.moveBasis(up, _f, _r);
        _dir.copy(_f).multiplyScalar(this.touchAimY).addScaledVector(_r, this.touchAimX);
        _dir.addScaledVector(up, -_dir.dot(up));
        if (_dir.lengthSq() > 1e-5) {
          this.aimDir.copy(_dir.normalize());
          // a full drag reaches the aiming ring; a shorter one places the blast nearer the caster
          const reach = aimReach > 0 ? aimReach : 10;
          this.aimPoint.copy(playerPos).addScaledVector(this.aimDir, Math.min(1, drag) * reach);
          this.hasAim = true;
        }
      }
    } else if (!this.mobile && this.mouseSeen) {
      const ray = cam.rayFromScreen(this.ndc.x, this.ndc.y);
      const hit = planet.raycast(ray.origin, ray.direction, 700);
      if (hit) {
        this.aimPoint.copy(hit);
        _dir.copy(hit).sub(playerPos);
        _dir.addScaledVector(up, -_dir.dot(up));
        if (_dir.lengthSq() > 0.16) {
          this.aimDir.copy(_dir.normalize());
          this.hasAim = true;
        }
      }
    }
  }
}
