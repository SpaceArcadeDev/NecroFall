// NECROFALL — UI motion helpers (overhaul §22/§23/§36).
//
// The CSS owns every keyframe (tokens.css / nf-shell.css); this module only
// tags elements and staggers delays so the JS call sites stay declarative.
// Everything is transform/opacity based and respects prefers-reduced-motion
// (the CSS media query zeroes the durations globally — see tokens.css).

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

/** Mark a freshly-rendered screen so the entrance animation plays once. */
export function screenIn(el: HTMLElement, cls = 'nf-screen'): HTMLElement {
  el.classList.add(cls);
  return el;
}

/**
 * Stagger a group's children (§36): each direct child gets `--nf-i`, and the
 * `.nf-stagger > *` CSS rule turns that into an animation delay. Capped so a
 * long list never waits seconds to finish appearing.
 */
export function stagger(host: HTMLElement, step = 55, max = 6): void {
  host.classList.add('nf-stagger');
  let i = 0;
  for (const child of Array.from(host.children) as HTMLElement[]) {
    child.style.setProperty('--nf-i', String(Math.min(i, max)));
    i += 1;
  }
  void step;
}

/** Replay a one-shot animation class (remove → reflow → add → self-clean). */
export function flash(el: HTMLElement, cls = 'nf-flash'): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  const done = (ev: AnimationEvent): void => {
    if (ev.target !== el) return;
    el.classList.remove(cls);
    el.removeEventListener('animationend', done);
  };
  el.addEventListener('animationend', done);
}

/** The primary-CTA state beat: a small replayable pulse (§23). */
export function pulse(el: HTMLElement): void {
  if (prefersReducedMotion()) return;
  flash(el, 'nf-pulse');
}

/** Smooth-scroll a horizontal strip so a chosen card centres itself. */
export function centerInStrip(strip: HTMLElement, card: HTMLElement): void {
  const left = card.offsetLeft - (strip.clientWidth - card.clientWidth) / 2;
  const max = strip.scrollWidth - strip.clientWidth;
  strip.scrollTo({
    left: Math.max(0, Math.min(max, left)),
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  });
}
