// NECROFALL — the GRAPHICS settings page (settings ▸ GRAPHICS). Reworked
// 2026-09-29 for landscape phones (user report: "cut off, bad ui, not optimized
// for touch"): the five quality presets are BIG touch cards on one row, the
// frame-rate ceiling is a full-width segmented control, and the page fits the
// frame at 568x320 without scrolling. Reads and writes through the ShellContext,
// which forwards to the live Game instance — every change applies to the running
// world immediately and is persisted.
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
import { el } from '../ui/dom';
import { createPageHeader } from '../../ui/shell/PageHeader';

/** Bar count per preset — the at-a-glance "how much this device draws" ramp. */
const PRESET_BARS: Record<QualityPref, number> = { auto: 0, low: 1, medium: 2, high: 4, ultra: 5 };

export class GraphicsPage {
  readonly element: HTMLElement;
  private presetBtns = new Map<QualityPref, HTMLButtonElement>();
  private fpsBtns = new Map<FpsPref, HTMLButtonElement>();
  private qualityNote: HTMLElement;
  private fpsNote: HTMLElement;
  private nowChip: HTMLElement;

  constructor(private ctx: ShellContext) {
    this.element = el('div', 'nf-page nf-gfx-page');

    // ---- the shared page header (§2): same anchor + gradient as PLAY/PROFILE
    this.element.appendChild(
      createPageHeader({
        title: 'GRAPHICS',
        subtitle: 'How much of the planet this device draws — and how often.',
        onBack: () => this.ctx.goBack(),
      })
    );

    // ---- quality presets: five cards, one row (they wrap only on narrow portraits)
    const presetSec = el('section', 'nf-gfx-sec');
    const presetLabel = el('div', 'nf-gfx-label');
    presetLabel.appendChild(el('span', 'nf-gfx-label-t', 'QUALITY PRESET'));
    this.nowChip = el('span', 'nf-gfx-now', '');
    presetLabel.appendChild(this.nowChip);
    presetSec.appendChild(presetLabel);

    const grid = el('div', 'nf-gfx-grid');
    for (const pref of QUALITY_PREFS) {
      const card = el('button', 'nf-gfx-card') as HTMLButtonElement;
      card.type = 'button';
      const bars = el('span', `nf-gfx-bars${pref === 'auto' ? ' auto' : ''}`);
      for (let i = 0; i < 5; i++) bars.appendChild(el('i', i < PRESET_BARS[pref] ? 'lit' : ''));
      card.appendChild(bars);
      card.appendChild(el('span', 'nf-gfx-name', QUALITY_LABELS[pref]));
      card.appendChild(el('span', 'nf-gfx-desc', QUALITY_BLURBS[pref]));
      card.addEventListener('click', () => this.pickPreset(pref));
      grid.appendChild(card);
      this.presetBtns.set(pref, card);
    }
    presetSec.appendChild(grid);
    this.qualityNote = el('p', 'nf-gfx-note', '');
    presetSec.appendChild(this.qualityNote);
    this.element.appendChild(presetSec);

    // ---- frame-rate ceiling: one segmented row
    const fpsSec = el('section', 'nf-gfx-sec nf-gfx-sec-fps');
    fpsSec.appendChild(el('div', 'nf-gfx-label nf-gfx-label-t', 'MAX FPS'));
    const seg = el('div', 'nf-gfx-seg');
    for (const pref of FPS_PREFS) {
      const b = el('button', 'nf-gfx-seg-opt', FPS_LABELS[String(pref)]) as HTMLButtonElement;
      b.type = 'button';
      b.addEventListener('click', () => this.pickFps(pref));
      seg.appendChild(b);
      this.fpsBtns.set(pref, b);
    }
    fpsSec.appendChild(seg);
    this.fpsNote = el('p', 'nf-gfx-note', '');
    fpsSec.appendChild(this.fpsNote);
    this.element.appendChild(fpsSec);

    this.update();
  }

  /** Repaints both rows from the live preferences (called on open and every data tick). */
  update(): void {
    const q = this.ctx.currentGraphicsPref();
    for (const [pref, btn] of this.presetBtns) {
      const on = pref === q;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const resolved = resolveQuality(q);
    this.nowChip.textContent = q === 'auto' ? `RUNNING ${resolved.toUpperCase()}` : 'FORCED';
    this.qualityNote.textContent =
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

