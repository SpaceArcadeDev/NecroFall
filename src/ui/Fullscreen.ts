// NECROFALL — fullscreen, including the Apple devices where the API does not exist.
//
// Desktop browsers, Android and iPadOS expose the Element Fullscreen API, so fullscreen is a plain
// browser toggle there. iPhone Safari — and every other browser or in-app view on iOS, because they
// all run WebKit — has no Element Fullscreen API at all: `requestFullscreen` is simply undefined,
// which is why hiding the button there (the old behaviour) left the player with no way to reclaim
// the screen. The iPhone path is therefore two things instead:
//
//   * "immersive" mode: the document is made scrollable by exactly one pixel and then scrolled,
//     which is the only page-level lever that makes Safari collapse its address / tool bars.
//     Nothing else moves — the game lives in `position: fixed` layers (see `html.nf-immersive`
//     in styles.css) — and the mode is sticky until the player leaves it.
//   * a hint towards Share → "Add to Home Screen", the only place iOS hands a web app the real,
//     chrome-free screen (`apple-mobile-web-app-capable` in index.html turns that on).

/** How fullscreen currently looks, from the player's point of view. */
export type FullscreenMode = 'native' | 'immersive' | 'standalone' | 'none';

type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  /** The oldest Safari spelling (capital S), which also took a keyboard-input flag. */
  webkitRequestFullScreen?: (allowKeyboardInput?: number) => void;
};
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

/** The class that switches the document into the iOS immersive fallback (styles.css). */
const IMMERSIVE_CLASS = 'nf-immersive';
/** The immersive mode has no browser event of its own, so it announces itself. */
const FALLBACK_EVENT = 'necrofall:fullscreenchange';

const fsRoot = (): FsElement => document.documentElement as FsElement;
const fsDoc = (): FsDocument => document as FsDocument;

/** True when the Element Fullscreen API exists (it does not on iPhone or in iOS in-app browsers). */
export function hasNativeFullscreen(): boolean {
  const el = fsRoot();
  return (
    typeof el.requestFullscreen === 'function' ||
    typeof el.webkitRequestFullscreen === 'function' ||
    typeof el.webkitRequestFullScreen === 'function'
  );
}

/** True while the browser is showing an element fullscreen. */
export function isNativeFullscreen(): boolean {
  const d = fsDoc();
  return !!(d.fullscreenElement ?? d.webkitFullscreenElement);
}

/** iPhone / iPad / iPod. iPadOS masquerades as a Mac, so touch points are the tie-breaker. */
export function isAppleTouchDevice(): boolean {
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent || '')) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/** Launched from the home screen: iOS already gives us the whole screen there. */
export function isStandalone(): boolean {
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
  const mm = window.matchMedia ? window.matchMedia.bind(window) : null;
  return !!mm && (mm('(display-mode: standalone)').matches || mm('(display-mode: fullscreen)').matches);
}

/**
 * A browser that is really an app (WKWebView) — Stremio, Instagram, a QR-code scanner… Their user
 * agent has no `Safari/` token. MDN lists iOS WebViews as having no Fullscreen support at all.
 */
export function isIosWebView(): boolean {
  return isAppleTouchDevice() && !/Safari\//.test(navigator.userAgent || '');
}

/**
 * One short line telling the player *why* native fullscreen cannot work here, or null when it
 * should. Apple's cases are spelled out because "it just does nothing" is what they used to get.
 */
export function fullscreenUnavailableReason(): string | null {
  if (window.self !== window.top) return 'the page is embedded in a frame without allowfullscreen';
  if (isAppleTouchDevice() && !hasNativeFullscreen()) {
    return isIosWebView()
      ? 'in-app browsers on iOS (WebView) cannot go fullscreen — open the page in Safari'
      : 'iOS Safari has no fullscreen API';
  }
  if (
    !hasNativeFullscreen() &&
    !window.isSecureContext &&
    window.self === window.top &&
    !isAppleTouchDevice()
  ) {
    // Browsers drop the API entirely on an insecure origin; the same page on https/localhost works.
    return 'the Fullscreen API is only exposed over https:// (or localhost)';
  }
  return null;
}

/** The last refusal, verbatim: shown to the player so a report can name it. */
let lastError: string | null = null;
export function lastFullscreenError(): string | null {
  return lastError;
}

/** True while the iOS immersive fallback is on. */
export function isImmersive(): boolean {
  return document.documentElement.classList.contains(IMMERSIVE_CLASS);
}

/** What fullscreen looks like right now — the single value the UI renders from. */
export function fullscreenMode(): FullscreenMode {
  if (isNativeFullscreen()) return 'native';
  if (isImmersive()) return 'immersive';
  return isStandalone() ? 'standalone' : 'none';
}

/** Safari only collapses its bars once the document really scrolled — one pixel is enough. */
function nudgeScroll(): void {
  if (window.scrollY <= 0) window.scrollTo(0, 1);
}

function enterImmersive(): void {
  document.documentElement.classList.add(IMMERSIVE_CLASS);
  nudgeScroll();
  document.dispatchEvent(new Event(FALLBACK_EVENT));
}

function exitImmersive(): void {
  document.documentElement.classList.remove(IMMERSIVE_CLASS);
  window.scrollTo(0, 0);
  document.dispatchEvent(new Event(FALLBACK_EVENT));
}

/**
 * Every spelling of "go fullscreen" we may have to try. An older Safari only has the prefixed ones,
 * and a newer one can still refuse the unprefixed call (iOS does not implement its options).
 */
function fullscreenAttempts(): { name: string; run: () => Promise<void> | void }[] {
  const el = fsRoot();
  const attempts: { name: string; run: () => Promise<void> | void }[] = [];
  if (typeof el.requestFullscreen === 'function') {
    attempts.push({ name: 'requestFullscreen({navigationUI})', run: () => el.requestFullscreen!({ navigationUI: 'hide' }) });
    attempts.push({ name: 'requestFullscreen()', run: () => el.requestFullscreen!() });
  }
  if (typeof el.webkitRequestFullscreen === 'function') {
    attempts.push({ name: 'webkitRequestFullscreen()', run: () => el.webkitRequestFullscreen!() });
  }
  if (typeof el.webkitRequestFullScreen === 'function') {
    const allowKeyboard = (Element as unknown as { ALLOW_KEYBOARD_INPUT?: number }).ALLOW_KEYBOARD_INPUT;
    attempts.push({ name: 'webkitRequestFullScreen()', run: () => el.webkitRequestFullScreen!(allowKeyboard) });
  }
  // Last resort for WebKit builds that only fullscreen a plain element: the body itself.
  const body = document.body as FsElement | null;
  if (body && el.requestFullscreen !== undefined) {
    attempts.push({ name: 'body.requestFullscreen()', run: () => body.requestFullscreen?.() });
  }
  if (body && typeof body.webkitRequestFullscreen === 'function') {
    attempts.push({ name: 'body.webkitRequestFullscreen()', run: () => body.webkitRequestFullscreen!() });
  }
  return attempts;
}

/**
 * Ask for real fullscreen, trying each API spelling until one takes. False means "still not in
 * fullscreen" and `lastFullscreenError()` carries the refusal of every spelling that was tried.
 */
async function requestNative(): Promise<boolean> {
  if (isNativeFullscreen()) return true;
  lastError = null;
  const attempts = fullscreenAttempts();
  for (const attempt of attempts) {
    try {
      await attempt.run();
      if (isNativeFullscreen()) return true;
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      lastError = `${attempt.name} → ${detail}`;
    }
  }
  if (!lastError) {
    lastError = attempts.length
      ? 'the browser ignored every fullscreen request (none was granted)'
      : 'this browser exposes no fullscreen API';
  }
  return isNativeFullscreen();
}

/**
 * Enter fullscreen: the native API where it exists, the immersive fallback everywhere else.
 *
 * The `hasNativeFullscreen()` gate is what keeps the iPhones sane: `requestFullscreen` is simply
 * *undefined* there, so there is nothing to try — without the gate the request path would walk an
 * empty attempt list every time and, worse, leave a refusal on record for an API the device never
 * had. One path or the other, never both, and never an exception.
 */
export async function enterFullscreen(): Promise<FullscreenMode> {
  if (isStandalone()) return 'standalone';
  if (hasNativeFullscreen() && (await requestNative())) return 'native';
  enterImmersive();
  return 'immersive';
}

/** Leave fullscreen, whichever of the two paths got us there. */
export async function exitFullscreen(): Promise<FullscreenMode> {
  const d = fsDoc();
  try {
    if (d.fullscreenElement ?? d.webkitFullscreenElement) {
      await (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
    }
  } catch {
    /* already out — the immersive half still has to be cleared */
  }
  exitImmersive();
  return fullscreenMode();
}

/** Flip fullscreen on or off. Never throws: the worst case is "the mode did not change". */
export async function toggleFullscreen(): Promise<FullscreenMode> {
  return fullscreenMode() === 'none' ? enterFullscreen() : exitFullscreen();
}

/**
 * Watch every source of change: the player can leave fullscreen with F11 or a gesture, the
 * home-screen mode can flip while the app is open, and our own immersive mode announces itself.
 * The callback also fires once immediately, so this doubles as "set up and stay in sync".
 */
export function onFullscreenChange(cb: (mode: FullscreenMode) => void): () => void {
  const fire = (): void => {
    // Safari restores its bars on a rotation, and the immersive mode then needs its nudge again.
    if (isImmersive()) nudgeScroll();
    cb(fullscreenMode());
  };
  // A refusal that never reaches us as a rejected promise (Safari) still has to be recorded.
  const onError = (e: Event): void => {
    const message = (e as Event & { message?: string }).message;
    lastError = message || lastError || 'the browser fired a fullscreenerror event';
    fire();
  };
  const targets: [EventTarget, string][] = [
    [document, 'fullscreenchange'],
    [document, 'webkitfullscreenchange'],
    [document, FALLBACK_EVENT],
    [window, 'orientationchange'],
  ];
  for (const query of ['(display-mode: standalone)', '(display-mode: fullscreen)']) {
    const media = window.matchMedia ? window.matchMedia(query) : null;
    if (media) targets.push([media, 'change']);
  }
  for (const [target, type] of targets) target.addEventListener(type, fire);
  document.addEventListener('fullscreenerror', onError);
  document.addEventListener('webkitfullscreenerror', onError);
  fire();
  return () => {
    for (const [target, type] of targets) target.removeEventListener(type, fire);
    document.removeEventListener('fullscreenerror', onError);
    document.removeEventListener('webkitfullscreenerror', onError);
  };
}
