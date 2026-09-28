// NECROFALL — the GRAPHICS settings page (settings ▸ GRAPHICS). One screen with both display
// choices: the render preset (auto / low / medium / high / ultra) and the frame-rate ceiling
// (auto / 30 / 60 / 90 / 120). Reads and writes through the ShellContext, which forwards to the
// live Game instance — every change applies to the running world immediately and is persisted.
import {
  FPS_LABELS,
  FPS_PREFS,
  QUALITY_BLURBS,
  QUALITY_LABELS,
  QUALITY_PREFS,
  fpsBlurb,
  resolveQuality,
  type FpsPref,
  type QualityPref,
} from '../../core/Config';
import { ShellContext } from '../ShellContext';
import { button, el } from '../ui/dom';

export class GraphicsPage {
  readonly element: HTMLElement;
  private presetBtns = new Map<QualityPref, HTMLButtonElement>();
  private fpsBtns = new Map<FpsPref, HTMLButtonElement>();
  private deviceNote: HTMLElement;
  private fpsNote: HTMLElement;

  constructor(private ctx: ShellContext) {
    this.element = el('div', 'nf-page nf-gfx-page');
    this.element.appendChild(el('h1', 'nf-page-title', 'GRAPHICS'));
    this.element.appendChild(el('p', 'nf-page-sub', 'How much of the planet this device is asked to draw — and how often.'));

    // ---- the render preset: full-width rows, one per level, ACTIVE on the current one
    const presetSec = el('section', 'nf-gfx-section');
    presetSec.appendChild(el('h2', 'nf-section-title', 'QUALITY PRESET'));
    const list = el('div', 'nf-gfx-list');
    for (const pref of QUALITY_PREFS) {
      const row = el('button', 'nf-gfx-opt') as HTMLButtonElement;
      row.type = 'button';
      const main = el('div', 'nf-gfx-main');
      main.appendChild(el('span', 'nf-gfx-name', QUALITY_LABELS[pref]));
      main.appendChild(el('span', 'nf-gfx-desc', QUALITY_BLURBS[pref]));
      row.appendChild(main);
      const mark = el('span', 'nf-gfx-mark', 'ACTIVE');
      mark.setAttribute('aria-hidden', 'true');
      row.appendChild(mark);
      row.addEventListener('click', () => this.pickPreset(pref));
      list.appendChild(row);
      this.presetBtns.set(pref, row);
    }
    presetSec.appendChild(list);
    this.deviceNote = el('p', 'nf-muted nf-gfx-note', '');
    presetSec.appendChild(this.deviceNote);
    this.element.appendChild(presetSec);

    // ---- the frame-rate ceiling: chips, exactly the levels the pacing understands
    const fpsSec = el('section', 'nf-gfx-section');
    fpsSec.appendChild(el('h2', 'nf-section-title', 'MAX FPS'));
    const chips = el('div', 'nf-gfx-chips');
    for (const pref of FPS_PREFS) {
      const b = button(FPS_LABELS[String(pref)], 'nf-chip nf-fps-chip', () => this.pickFps(pref));
      chips.appendChild(b);
      this.fpsBtns.set(pref, b);
    }
    fpsSec.appendChild(chips);
    this.fpsNote = el('p', 'nf-muted nf-gfx-note', '');
    fpsSec.appendChild(this.fpsNote);
    this.element.appendChild(fpsSec);

    this.update();
  }

  /** Repaints both rows from the live preferences (called on open and on every data tick). */
  update(): void {
    const q = this.ctx.currentGraphicsPref();
    for (const [pref, btn] of this.presetBtns) {
      const on = pref === q;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const resolved = resolveQuality(q);
    this.deviceNote.textContent =
      q === 'auto'
        ? `AUTO probes this device — currently running ${resolved.toUpperCase()}.`
        : `Forcing ${QUALITY_LABELS[q]}. Terrain detail rebuilds with the next match; everything else changes right away.`;

    const f = this.ctx.currentFpsPref();
    for (const [pref, btn] of this.fpsBtns) {
      const on = pref === f;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    this.fpsNote.textContent = fpsBlurb(f);
  }

  private pickPreset(pref: QualityPref): void {
    this.ctx.setGraphicsPref(pref);
    this.update();
    this.ctx.toast(
      pref === 'auto'
        ? `GRAPHICS: AUTO — ${resolveQuality(pref).toUpperCase()} on this device`
        : `GRAPHICS: ${QUALITY_LABELS[pref]}`
    );
  }

  private pickFps(pref: FpsPref): void {
    this.ctx.setFpsPref(pref);
    this.update();
    this.ctx.toast(pref === 'auto' ? 'FRAME RATE: AUTO' : `FRAME RATE: MAX ${pref} FPS`);
  }
}
