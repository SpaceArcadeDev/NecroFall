// NECROFALL — tiny DOM helpers for the account shell (no framework; the game
// itself is vanilla DOM, and the shell matches it).
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text = ''
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

export function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, label) as HTMLButtonElement;
  b.type = 'button';
  b.addEventListener('click', (ev) => {
    ev.preventDefault();
    onClick();
  });
  return b;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** `@handle` display with a graceful fallback. */
export function handleOf(name: string): string {
  return name ? `@${name}` : '@unknown';
}

/** Short hex for display (never expose raw internal ids beyond this). */
export function shortHex(hex: string): string {
  return hex ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : '—';
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

/** Big integer currency → "1,234". */
export function formatCurrency(value: bigint | number | undefined): string {
  const n = typeof value === 'bigint' ? Number(value) : value ?? 0;
  return n.toLocaleString('en-US');
}
