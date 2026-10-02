// NECROFALL — the DEV HUD (overhaul §39).
//
// A tiny always-on-top chip (dev builds only, `?debug` / `?uidebug`) showing
// the numbers the mobile test matrix cares about: viewport, orientation, safe
// areas, document overflow, clipped elements, missing contracted actions and
// unknown action ids. It hides itself whenever the game owns the screen
// (shell hidden) and never intercepts input.
import { hudSnapshot } from './UIAudit';

export function installDebugHud(): void {
  if (!import.meta.env.DEV) return;
  const params = new URLSearchParams(window.location.search);
  if (!params.has('uidebug') && !params.has('debug')) return;

  const chip = document.createElement('div');
  chip.className = 'nf-debug-hud';
  chip.setAttribute('aria-hidden', 'true');
  chip.title = 'Dev HUD — viewport / overflow / clipped / missing actions (§39)';
  document.body.appendChild(chip);

  let timer = 0;
  const render = (): void => {
    timer = 0;
    try {
      const shell = document.querySelector('.nf-shell');
      const visible = Boolean(shell && !shell.classList.contains('hidden'));
      if (!visible) {
        chip.style.display = 'none';
        return;
      }
      chip.style.display = '';
      const s = hudSnapshot();
      chip.textContent = `${s.w}×${s.h} ${s.orientation} · safe ${Math.round(s.safeTop)}/${Math.round(s.safeBottom)} · over ${s.overflowX}/${s.overflowY} · clipped ${s.clipped} · missing ${s.missing} · unknown ${s.unknown}`;
      const bad = s.overflowX > 0 || s.overflowY > 0 || s.clipped > 0 || s.missing > 0 || s.unknown > 0;
      chip.classList.toggle('is-bad', bad);
    } catch {
      // A dev tool must never wedge the app: surface the failure in the chip.
      chip.textContent = 'dev hud error';
    }
  };
  // setTimeout, NOT requestAnimationFrame: the integrated test browser can
  // freeze rAF (see the repo memory), and the HUD must still tick there.
  const schedule = (): void => {
    if (!timer) timer = window.setTimeout(render, 120);
  };

  window.addEventListener('resize', schedule);
  window.addEventListener('nf:ui:navigate', schedule);
  window.setInterval(schedule, 1500);
  schedule();
}
