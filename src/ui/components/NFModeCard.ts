// NECROFALL — the mode card (overhaul §13/§37/§56).
//
// Rendered FROM the game-mode registry: eyebrow + player count, icon plate,
// title, description and ONE action row that always renders every action the
// mode declares. The whole card stays tappable as a shortcut for the primary
// action, while the explicit labelled button remains the audited control
// (`data-action`), so "the mode screen lost its button" cannot happen again.
import type { GameModeDefinition } from '../data/GameModeRegistry';
import { modeIcon, renderModeActions } from '../data/GameModeRegistry';
import { createNFButton } from './NFButton';

export interface NFModeCardOptions {
  mode: GameModeDefinition;
  /** One handler per declared action; a missing handler renders disabled with a reason. */
  handlers: Partial<Record<string, (() => void) | undefined>>;
  picked?: boolean;
}

export function createNFModeCard(options: NFModeCardOptions): HTMLElement {
  const { mode, handlers } = options;
  const card = document.createElement('article');
  card.className = ['nf-mode-card', options.picked ? 'is-picked' : ''].filter(Boolean).join(' ');
  card.dataset.mode = mode.id;
  card.style.setProperty('--mode-accent', mode.accent);

  const top = document.createElement('div');
  top.className = 'nf-mode-card__top';
  const eyebrow = document.createElement('span');
  eyebrow.className = 'nf-mode-card__eyebrow';
  eyebrow.textContent = mode.tag;
  const players = document.createElement('span');
  players.className = 'nf-mode-card__players';
  players.textContent = mode.players;
  top.append(eyebrow, players);
  card.appendChild(top);

  const plate = document.createElement('div');
  plate.className = 'nf-mode-card__plate';
  plate.innerHTML = modeIcon(mode);
  card.appendChild(plate);

  const title = document.createElement('h2');
  title.className = 'nf-mode-card__title';
  title.textContent = mode.title;
  card.appendChild(title);

  const desc = document.createElement('p');
  desc.className = 'nf-mode-card__desc';
  desc.textContent = mode.subtitle;
  card.appendChild(desc);

  const actions = renderModeActions(mode, handlers, (opts) =>
    createNFButton({
      label: opts.label,
      icon: opts.icon,
      tone: opts.tone,
      action: opts.action,
      disabled: opts.disabled,
      hint: opts.hint,
      extraClass: 'nf-mode-card__action',
      onClick: opts.onClick,
    })
  );
  card.appendChild(actions);

  // Whole-card press = the primary action; explicit buttons still win when hit.
  const primary = handlers.play ?? handlers[mode.actions[0]];
  if (primary) {
    card.classList.add('is-enabled');
    card.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('button')) return;
      primary();
    });
    card.addEventListener('keydown', (ev) => {
      const k = ev as KeyboardEvent;
      if ((k.key === 'Enter' || k.key === ' ') && !k.repeat) {
        ev.preventDefault();
        primary();
      }
    });
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
  }
  return card;
}
