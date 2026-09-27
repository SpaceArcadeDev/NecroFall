// NECROFALL — Apple touch gesture notes + diagnostics. NOT the anti-zoom fix.
//
// iOS ignores `user-scalable=no` (it has since iOS 10), so the page can be zoomed by gestures even
// though index.html asks it not to. The important rule, straight out of the Pointer Events spec
// (§8, "Declaring direct manipulation behavior"):
//
//   "Viewport manipulations (panning and zooming) ... are intentionally NOT a default action of
//    pointer events, meaning that these behaviors cannot be suppressed by canceling a pointer
//    event. Authors must instead use `touch-action`."
//
// So the *fix* for accidental zoom is CSS `touch-action` — see the control hierarchy in styles.css
// (`#app`) and styles.mobile.css (`.mobile`, `.mbtn`, `.mbtn *`, `.joy`). WebKit intersects the
// values of the touched element and every ancestor, and only still disallows the double tap when
// the intersection contains `none` or `manipulation`; mixing the two produces an empty set and
// re-enables it. One value for the whole chain, `none` only on the joystick.
//
// What is left in this file is the part JS is actually good at:
//
//   * recording what a tap landed on, so the pause panel can name the cause of a stray zoom;
//   * cancelling Safari's pinch gestures (`gesturestart` / `gesturechange`) that begin OUTSIDE the
//     control cluster, so a two-finger pinch over the game view cannot zoom the page mid-fight.
//     A gesture that begins on the controls is left alone: a second finger there is normal play
//     (stick + button at the same time).
//
// REMOVED (2026-09): the `visualViewport` scale watcher and the viewport-meta rewrite it drove
// (`resetZoom`) plus the document-level two-finger `touchmove` cancel. Fighting a zoom that already
// happened meant Safari re-read the viewport meta and reset the layout mid-fight, and per the spec
// above it can never be the fix. A zoom that got through also used to be papered over, hiding a
// broken touch-action chain — the one thing a device report must be able to see. `touchDiagnostics()`
// still reports the live scale, so a stray zoom is visible instead of silently "handled".

import { IS_TOUCH } from '../core/Config';

let installed = false;

/** The mobile control cluster: the one place where a second finger is gameplay, not a gesture. */
function isGameControl(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.mobile');
}

/** What the touch layer saw — the pause panel prints this so a device report can name the cause. */
const diag = { maxScale: 1, target: '—', targetTouchAction: '—' };

/** Snapshot for the pause panel (see UI.refreshDiagnostics). */
export function touchDiagnostics(): {
  scale: number;
  maxScale: number;
  target: string;
  targetTouchAction: string;
} {
  const scale = window.visualViewport?.scale ?? 1;
  if (scale > diag.maxScale) diag.maxScale = scale;
  return {
    scale,
    maxScale: diag.maxScale,
    target: diag.target,
    targetTouchAction: diag.targetTouchAction,
  };
}

/** `.mbtn.skill` / `svg` style label for the diagnostics line. */
function describeTarget(target: EventTarget | null): string {
  if (!(target instanceof Element)) return '—';
  const cls =
    typeof target.className === 'string'
      ? target.className.trim().split(/\s+/).filter(Boolean)
      : [];
  const tag = target.tagName.toLowerCase();
  return cls.length ? `${tag}.${cls.join('.')}` : tag;
}

/**
 * Watch iOS touch gestures: record what taps hit and keep Safari's pinch out of the game view.
 * Idempotent, and a no-op on devices without touch input.
 */
export function installTouchGuards(): void {
  if (installed || !IS_TOUCH) return;
  installed = true;

  // ---- diagnostics ------------------------------------------------------
  // Recording only: the listener is passive and cancels nothing, so a tap still reaches the button
  // underneath (the cluster's own pointerdown / pointerup handlers) exactly as it did before.
  document.addEventListener(
    'touchend',
    (e: TouchEvent) => {
      // A tap ends only when every finger is up, so two-thumb play never records a partial one.
      if (e.touches.length !== 0) return;
      diag.target = describeTarget(e.target);
      if (e.target instanceof Element) diag.targetTouchAction = getComputedStyle(e.target).touchAction;
    },
    { passive: true }
  );

  // ---- pinch ------------------------------------------------------------
  // Safari-only pinch events (they also fire for trackpad pinch on an iPad with a keyboard).
  // Cancelled only when the gesture starts AWAY from the control cluster: two thumbs on the
  // controls are gameplay, and the CSS touch-action of those controls decides the rest.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(
      type,
      (e: Event) => {
        if (!isGameControl(e.target)) e.preventDefault();
      },
      { passive: false }
    );
  }
}
