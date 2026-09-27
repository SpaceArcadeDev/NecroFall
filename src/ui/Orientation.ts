// NECROFALL — mobile orientation gate + the auto-fullscreen window.
// The game is designed for a wide landscape view, so touch devices that are held in portrait get a
// blocking "rotate your device" panel, and we ask the browser to lock the screen to landscape
// (fullscreen + Screen Orientation API where it is available). Both requests are only legal from
// inside a user gesture, so the first tap is our one window — and on devices without the APIs
// (iPhone) the fullscreen half falls back to the immersive mode in ui/Fullscreen.ts, while the
// panel waits for the player to turn the phone, which lets the OS rotate.

import { IS_TOUCH } from '../core/Config';
import { enterFullscreen, fullscreenMode, onFullscreenChange } from './Fullscreen';

interface OrientationLike {
  type?: string;
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
}

/** Enough taps to survive a first request being refused, few enough never to feel naggy. */
const MAX_AUTO_ATTEMPTS = 3;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
};

export class OrientationGate {
  private panel: HTMLElement;
  private dismissed = false;
  private locked = false;
  private readonly media: MediaQueryList;
  /** Auto fullscreen bookkeeping: taps spent so far, and the hooks to take back off again. */
  private autoAttempts = 0;
  private autoHandler: (() => void) | null = null;
  private unwatchFullscreen: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.panel = el('div', 'rotate-gate hidden');
    const card = el('div', 'rotate-card');
    card.appendChild(el('div', 'rotate-icon', '&#128241;'));
    card.appendChild(el('div', 'rotate-title', 'ROTATE YOUR DEVICE'));
    card.appendChild(el('div', 'rotate-sub', 'NECROFALL is played in landscape — turn your phone sideways to continue.'));
    const btn = el('button', 'btn primary', 'GO LANDSCAPE');
    btn.addEventListener('click', () => {
      void this.requestLandscape();
    });
    card.appendChild(btn);
    const skip = el('button', 'btn small rotate-skip', 'PLAY IN PORTRAIT ANYWAY');
    skip.addEventListener('click', () => {
      this.dismissed = true;
      this.sync();
    });
    card.appendChild(skip);
    this.panel.appendChild(card);
    parent.appendChild(this.panel);

    this.media = window.matchMedia('(orientation: portrait)');
    const onChange = (): void => {
      if (!this.isPortrait()) this.dismissed = false;
      this.sync();
    };
    this.media.addEventListener?.('change', onChange);
    window.addEventListener('orientationchange', onChange);
    window.addEventListener('resize', onChange);
    document.addEventListener('visibilitychange', onChange);
    this.sync();
  }

  /** True when the game is usable (landscape, desktop, or the player dismissed the gate). */
  get blocked(): boolean {
    if (!IS_TOUCH || this.dismissed) return false;
    // Only phones/tablets are gated — a narrow touch laptop window should just keep playing.
    const mobileish = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
      || Math.min(screen.width, screen.height) < 500;
    return mobileish && this.isPortrait();
  }

  /**
   * Try to rotate the device for real: fullscreen first (on iPhone that is the immersive
   * fallback, since Safari has no Element Fullscreen API), then lock the orientation.
   */
  async requestLandscape(): Promise<void> {
    await enterFullscreen();
    const orientation = (screen as Screen & { orientation?: OrientationLike }).orientation;
    try {
      await orientation?.lock?.('landscape');
      this.locked = true;
    } catch {
      /* unsupported (iOS Safari) — the OS rotates when the device is turned */
    }
    this.sync();
  }

  private isPortrait(): boolean {
    if (this.media.matches) return true;
    // fall back to measuring, which also covers split-screen sizes
    return window.innerHeight > window.innerWidth * 1.02;
  }

  private sync(): void {
    this.panel.classList.toggle('hidden', !this.blocked);
    document.documentElement.classList.toggle('nf-portrait-blocked', this.blocked);
  }

  /**
   * Fullscreen and the orientation lock can only be requested from inside a user gesture, so the
   * first tap is our one legal window. It is retried on the next couple of taps because a refusal
   * used to end the whole thing (the reason "fullscreen never worked" on some devices), and the
   * arming stops for good as soon as any kind of fullscreen is on — never pull a player back into
   * fullscreen after they left it on purpose.
   */
  armAutoLock(): void {
    if (this.autoHandler) return;
    const attempt = (): void => {
      if (fullscreenMode() !== 'none') {
        this.disarmAutoLock();
        return;
      }
      this.autoAttempts += 1;
      if (this.autoAttempts > MAX_AUTO_ATTEMPTS) {
        this.disarmAutoLock();
        return;
      }
      void this.requestLandscape();
    };
    this.autoHandler = attempt;
    window.addEventListener('pointerdown', attempt);
    window.addEventListener('touchend', attempt);
    this.unwatchFullscreen = onFullscreenChange(mode => {
      if (mode !== 'none') this.disarmAutoLock();
    });
  }

  private disarmAutoLock(): void {
    if (this.autoHandler) {
      window.removeEventListener('pointerdown', this.autoHandler);
      window.removeEventListener('touchend', this.autoHandler);
      this.autoHandler = null;
    }
    this.unwatchFullscreen?.();
    this.unwatchFullscreen = null;
  }
}
