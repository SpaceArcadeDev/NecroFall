// NECROFALL — small status chips (overhaul §13/§45).
export type NFBadgeTone = 'neutral' | 'acid' | 'cyan' | 'orange' | 'green' | 'red';

export function createNFBadge(label: string, tone: NFBadgeTone = 'neutral'): HTMLElement {
  const badge = document.createElement('span');
  badge.className = `nf-badge nf-badge--${tone}`;
  badge.textContent = label;
  return badge;
}

/** A quiet hairline divider with an optional centred label (§13). */
export function createNFDivider(label = ''): HTMLElement {
  const div = document.createElement('div');
  div.className = 'nf-divider';
  if (label) div.appendChild(Object.assign(document.createElement('span'), { className: 'nf-divider__label', textContent: label }));
  return div;
}
