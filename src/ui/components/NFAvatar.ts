// NECROFALL — the ONE player identity avatar (overhaul §10).
//
// Used by the main menu top bar, the MORE sheet, the profile quick card and
// any future line-up. Never re-created per screen: a soft state ring, an
// initial fallback, a colony-tinted edge — no giant neon glow.
export type NFAvatarSize = 'sm' | 'md' | 'lg' | 'xl';
export type NFAvatarStatus = 'online' | 'away' | 'offline' | 'in-match';

export interface NFAvatarOptions {
  name: string;
  imageUrl?: string;
  /** Colony accent (css colour) — draws the ring + edge strip. */
  colony?: string;
  status?: NFAvatarStatus;
  size?: NFAvatarSize;
  /** Tiny corner badge (level / rank). */
  badge?: string;
}

export function createNFAvatar(options: NFAvatarOptions): HTMLElement {
  const el = document.createElement('span');
  el.className = `nf-avatar nf-avatar--${options.size ?? 'md'}`;
  if (options.colony) el.style.setProperty('--nf-avatar-accent', options.colony);

  const initial = (options.name || '?').trim().slice(0, 1).toUpperCase() || '?';
  if (options.imageUrl) {
    const img = document.createElement('img');
    img.className = 'nf-avatar__img';
    img.src = options.imageUrl;
    img.alt = '';
    img.draggable = false;
    img.addEventListener('error', () => {
      img.remove();
      el.classList.add('nf-avatar--initial');
      el.appendChild(Object.assign(document.createElement('span'), { className: 'nf-avatar__initial', textContent: initial }));
    });
    el.appendChild(img);
  } else {
    el.classList.add('nf-avatar--initial');
    const span = document.createElement('span');
    span.className = 'nf-avatar__initial';
    span.textContent = initial;
    el.appendChild(span);
  }

  if (options.status) {
    const dot = document.createElement('span');
    dot.className = `nf-avatar__status is-${options.status}`;
    el.appendChild(dot);
  }
  if (options.badge) {
    const badge = document.createElement('span');
    badge.className = 'nf-avatar__badge';
    badge.textContent = options.badge;
    el.appendChild(badge);
  }
  return el;
}
