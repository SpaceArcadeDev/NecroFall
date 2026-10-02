// NECROFALL — the UI audio bus (overhaul §24/§25) + haptics (§26).
//
// ONE bus for every menu sound. The sounds are SYNTHESISED with WebAudio —
// short tactile ticks, no asset files, no `new Audio()` per click, no
// preloading. Like the friends notify chime (`app/ui/notifySound.ts`) the
// context is created lazily on the first trusted gesture, so autoplay policy
// can never wedge the menu.
//
// Tones (§25):
//   click    soft mechanical tick        (neutral buttons)
//   select   directional snap            (mode / card selection)
//   confirm  low + bright confirmation   (PLAY, READY)
//   back     short descending tick       (back chevrons)
//   error    short muted buzz            (danger / refusals)
//   map      tiny sci-fi pulse           (map select)
export type UISfxTone = 'neutral' | 'primary' | 'accent' | 'danger';

const STORAGE_KEY = 'nf.uisfx';

class UIAudioBus {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = true;

  constructor() {
    try {
      this.enabled = localStorage.getItem(STORAGE_KEY) !== 'off';
    } catch {
      this.enabled = true;
    }
  }

  /** First trusted gesture — safe to call on every pointerdown. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch {
      /* private mode — the preference just does not persist */
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** One synthesised blip. `slide` bends the frequency across the duration. */
  private blip(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; slide?: number; delay?: number } = {}): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + (opts.delay ?? 0);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = opts.type ?? 'triangle';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + opts.slide), t0 + dur);
    const peak = opts.gain ?? 0.55;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  play(id: 'click' | 'select' | 'confirm' | 'back' | 'error' | 'map'): void {
    switch (id) {
      case 'click':
        this.blip(2100, 0.045, { type: 'square', gain: 0.28 });
        break;
      case 'select':
        this.blip(880, 0.06, { type: 'triangle', gain: 0.4, slide: 260 });
        break;
      case 'confirm':
        this.blip(560, 0.07, { type: 'triangle', gain: 0.42 });
        this.blip(1050, 0.1, { type: 'sine', gain: 0.34, delay: 0.045, slide: 140 });
        break;
      case 'back':
        this.blip(620, 0.08, { type: 'triangle', gain: 0.35, slide: -260 });
        break;
      case 'error':
        this.blip(150, 0.12, { type: 'sawtooth', gain: 0.3, slide: -40 });
        break;
      case 'map':
        this.blip(1320, 0.05, { type: 'sine', gain: 0.32, slide: 420 });
        break;
    }
  }

  /** The tone→sound mapping every shell button uses (§25). */
  click(tone: UISfxTone = 'neutral'): void {
    if (tone === 'primary') this.play('confirm');
    else if (tone === 'danger') this.play('error');
    else if (tone === 'accent') this.play('select');
    else this.play('click');
  }

  /** Very sparing haptics (§26): press, ready, important confirm. Never hover. */
  haptic(kind: 'press' | 'ready' | 'confirm' = 'press'): void {
    if (!('vibrate' in navigator)) return;
    try {
      if (kind === 'ready') navigator.vibrate(12);
      else if (kind === 'confirm') navigator.vibrate([8, 18, 8]);
      else navigator.vibrate(7);
    } catch {
      /* refused — haptics are a bonus, never a dependency */
    }
  }
}

export const UIAudio = new UIAudioBus();

let installed = false;

/**
 * Install the global feedback pass: EVERY pressable element in the shell gets
 * the tick + haptic without touching each call site. `data-sfx` overrides the
 * tone (`data-sfx="none"` opts out; `data-sfx="confirm|back|error|select|map"`
 * picks the sound directly, "sweep"-style gestures excluded).
 */
export function installUIFeedback(): void {
  if (installed) return;
  installed = true;

  const pressable = 'button, a, [role="button"], input[type="submit"]';

  document.addEventListener(
    'pointerdown',
    (ev) => {
      UIAudio.unlock();
      if (ev.button !== 0 && ev.pointerType === 'mouse') return;
      const target = ev.target as Element | null;
      const node = target?.closest?.(pressable) as HTMLElement | null;
      if (!node) return;
      if (node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true') {
        UIAudio.play('error');
        return;
      }
      const sfx = node.dataset.sfx;
      if (sfx === 'none') return;
      if (sfx === 'confirm' || sfx === 'back' || sfx === 'error' || sfx === 'select' || sfx === 'map' || sfx === 'click') {
        UIAudio.play(sfx);
        UIAudio.haptic(sfx === 'confirm' ? 'ready' : 'press');
        return;
      }
      // Tonal defaults from the button's own classes.
      if (node.classList.contains('nf-btn--primary') || node.classList.contains('nf-bottom-play')) {
        UIAudio.click('primary');
        UIAudio.haptic('ready');
      } else if (node.classList.contains('nf-btn--danger') || node.classList.contains('nf-btn--ghost-danger')) {
        UIAudio.click('danger');
      } else if (node.classList.contains('nf-back') || node.classList.contains('nf-rail-drawer')) {
        UIAudio.play('back');
        UIAudio.haptic('press');
      } else {
        UIAudio.click('neutral');
        UIAudio.haptic('press');
      }
    },
    { capture: true, passive: true }
  );
}
