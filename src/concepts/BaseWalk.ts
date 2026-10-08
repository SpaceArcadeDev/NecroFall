import { Euler, Vector3, type PerspectiveCamera } from 'three/webgpu';
import type { BaseSurface } from './BaseGeology';

export class BaseWalk {
  active = false;
  readonly position = new Vector3();
  private surface?: BaseSurface;
  private readonly keys = new Set<string>();
  private readonly abort = new AbortController();
  private readonly camera: PerspectiveCamera;
  private readonly canvas: HTMLCanvasElement;
  private yaw = 0;
  private pitch = 0;
  private dragging: number | null = null;
  private pointerX = 0;
  private pointerY = 0;

  constructor(camera: PerspectiveCamera, canvas: HTMLCanvasElement, controls: HTMLElement) {
    this.camera = camera; this.canvas = canvas;
    const options = { signal: this.abort.signal };
    window.addEventListener('keydown', event => {
      if (!this.active || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(event.code)) { this.keys.add(event.code); event.preventDefault(); }
    }, options);
    window.addEventListener('keyup', event => this.keys.delete(event.code), options);
    window.addEventListener('blur', () => this.keys.clear(), options);
    canvas.addEventListener('pointerdown', event => {
      if (!this.active) return;
      this.dragging = event.pointerId; this.pointerX = event.clientX; this.pointerY = event.clientY;
      canvas.setPointerCapture(event.pointerId); canvas.focus();
    }, options);
    canvas.addEventListener('pointermove', event => {
      if (!this.active || this.dragging !== event.pointerId) return;
      this.yaw -= (event.clientX - this.pointerX) * 0.004;
      this.pitch = Math.max(-1.25, Math.min(1.25, this.pitch - (event.clientY - this.pointerY) * 0.004));
      this.pointerX = event.clientX; this.pointerY = event.clientY;
    }, options);
    canvas.addEventListener('pointerup', () => { this.dragging = null; }, options);
    canvas.addEventListener('pointercancel', () => { this.dragging = null; }, options);
    controls.querySelectorAll<HTMLButtonElement>('[data-move]').forEach(button => {
      button.addEventListener('pointerdown', event => { this.keys.add(button.dataset.move!); button.setPointerCapture(event.pointerId); event.preventDefault(); }, options);
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(event, () => this.keys.delete(button.dataset.move!), options);
    });
  }

  setSurface(surface?: BaseSurface): void { this.surface = surface; this.setActive(this.active); }

  setActive(value: boolean): void {
    this.active = value && !!this.surface;
    this.keys.clear(); this.dragging = null;
    if (!this.active) return;
    this.position.copy(this.surface!.spawn());
    const rotation = new Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = rotation.y; this.pitch = Math.max(-0.35, Math.min(0.35, rotation.x));
    this.canvas.focus(); this.update(0);
  }

  update(delta: number): void {
    if (!this.active || !this.surface) return;
    const forward = Number(this.keys.has('KeyW') || this.keys.has('ArrowUp')) - Number(this.keys.has('KeyS') || this.keys.has('ArrowDown'));
    const sideways = Number(this.keys.has('KeyD') || this.keys.has('ArrowRight')) - Number(this.keys.has('KeyA') || this.keys.has('ArrowLeft'));
    const magnitude = Math.max(1, Math.hypot(forward, sideways));
    const distance = Math.min(delta, 0.05) * 6 / magnitude;
    if (forward || sideways) {
      const next = this.surface.step(this.position, (-Math.sin(this.yaw) * forward + Math.cos(this.yaw) * sideways) * distance,
        (-Math.cos(this.yaw) * forward - Math.sin(this.yaw) * sideways) * distance);
      this.position.copy(next);
    }
    this.camera.position.copy(this.position).add(new Vector3(0, 1.65, 0));
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  dispose(): void { this.abort.abort(); }
}