/**
 * NECROFALL — debug URL switches (plan §90).
 *
 *   ?stats / ?renderstats   FPS / frame time / draw calls / triangles / memory
 *   ?wireframe              all MeshDefaultMaterial wireframe
 *   ?grass=0 | ?foliage=0 | ?water=0 | ?rocks=0 | ?spikes=0 | ?crystals=0 | ?particles=0
 *   ?shadows=0              sun shadow off
 *   ?dof=0                  cheap DOF off
 *   ?fog=0                  fog off
 *   ?quality=0|1|2          force a quality level
 *   ?seed=<n>               planet seed override
 *   ?ring=<n>               archetype ring override
 *   ?free                   start in free-fly camera
 *
 * Flags are read once from the URL (search + hash-query). A flag present
 * without a value counts as ON; `=0` turns it off.
 */

export interface SwitchBag {
  [name: string]: string;
}

export function readSwitches(): SwitchBag {
  const bag: SwitchBag = {};
  const consume = (query: string) => {
    const cleaned = query.replace(/^[?#]/, '');
    if (!cleaned) return;
    for (const part of cleaned.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      if (eq === -1) bag[decodeURIComponent(part)] = '1';
      else bag[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
    }
  };
  consume(window.location.search);
  const hash = window.location.hash;
  const q = hash.indexOf('?');
  if (q >= 0) consume(hash.slice(q));
  // Plan §33: `?render=fogoff|shadowsOff|grassOff|treesOff|postOff` are aliases of the classic
  // component switches, normalised HERE so every consumer (game + dev world) reads ONE vocabulary.
  const render = (bag['render'] ?? '').toLowerCase();
  const alias: Record<string, string> = {
    fogoff: 'fog',
    shadowsoff: 'shadows',
    grassoff: 'grass',
    treesoff: 'foliage',
    postoff: 'post',
  };
  const mapped = alias[render];
  if (mapped && bag[mapped] === undefined) bag[mapped] = '0';
  return bag;
}

export class DebugSwitches {
  readonly bag: SwitchBag;

  constructor(bag: SwitchBag = readSwitches()) {
    this.bag = bag;
  }

  /** ON unless explicitly set to 0/false/off. */
  enabled(name: string, fallback = true): boolean {
    const value = this.bag[name];
    if (value === undefined) return fallback;
    return value !== '0' && value.toLowerCase() !== 'false' && value.toLowerCase() !== 'off';
  }

  number(name: string, fallback: number): number {
    const value = this.bag[name];
    if (value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  get stats(): boolean {
    return this.enabled('renderstats', false) || this.enabled('stats', false);
  }

  get wireframe(): boolean {
    return this.enabled('wireframe', false);
  }

  get freeCamera(): boolean {
    return this.enabled('free', false);
  }
}

/** Tiny DOM overlay fed from `renderer.info` (plan §90). */
export class StatsOverlay {
  private readonly element: HTMLDivElement;
  private accum = 0;
  private frames = 0;
  private fps = 0;
  private lastMs = 0;
  private readonly extraLines = new Map<string, string>();

  constructor() {
    this.element = document.createElement('div');
    this.element.setAttribute('data-necrofall-stats', '');
    Object.assign(this.element.style, {
      position: 'fixed',
      top: '8px',
      left: '8px',
      zIndex: '50',
      padding: '6px 9px',
      background: 'rgba(6, 12, 9, 0.72)',
      color: '#b6ff54',
      font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      whiteSpace: 'pre',
      pointerEvents: 'none',
      borderRadius: '4px',
      letterSpacing: '0.02em',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.element);
  }

  set(line: string, value: string): void {
    this.extraLines.set(line, value);
  }

  update(delta: number, renderer: { info?: { render?: { drawCalls?: number; triangles?: number }; memory?: { geometries?: number; textures?: number } } }): void {
    this.accum += delta;
    this.frames++;
    if (this.accum >= 0.25) {
      this.fps = this.frames / this.accum;
      this.lastMs = (this.accum / this.frames) * 1000;
      this.accum = 0;
      this.frames = 0;

      const info = renderer.info;
      const lines = [
        `fps        ${this.fps.toFixed(0)} (${this.lastMs.toFixed(1)} ms)`,
        `draws      ${info?.render?.drawCalls ?? '?'}`,
        `triangles  ${(info?.render?.triangles ?? 0).toLocaleString()}`,
        `geometries ${info?.memory?.geometries ?? '?'}   textures ${info?.memory?.textures ?? '?'}`,
      ];
      for (const [label, value] of this.extraLines) lines.push(`${label.padEnd(10)} ${value}`);
      this.element.textContent = lines.join('\n');
    }
  }

  destroy(): void {
    this.element.remove();
  }
}
