// NECROFALL — the game-mode registry (overhaul §3/§13/§56).
//
// ONE declaration of every format the PLAY menu can offer. The cards in
// `app/lobby/PlayPage.ts` render FROM this list, so a mode screen can never
// silently drop an action: the card renders every action in `actions`, and
// available ones run their handler while unavailable ones render disabled with
// a reason instead of vanishing.
import type { IconName } from '../icons';
import { ACTIONS, type MenuAction, sortedActions } from '../data/MenuActionRegistry';
import { getIcon } from '../icons';

export interface GameModeDefinition {
  id: 'classic' | 'rank' | 'speedrun' | 'survival' | 'custom' | 'freeroam';
  title: string;
  subtitle: string;
  /** The VERY short line printed under the card title (user ask 2026-10-03) — one breath. */
  blurb: string;
  /** Eyebrow chip: OFFICIAL / SOLO / INVITE / EXPLORE (§13). */
  tag: string;
  icon: IconName;
  /** Every action the mode's card must expose — rendered unconditionally. */
  actions: MenuAction[];
  /** Big-number slot in the card's top-right (“3v3v3”, “1”, “∞”, …). */
  players: string;
  official: boolean;
  /** The written-out primary call-to-action — kept for copy; the card's play button
   *  itself reads a uniform "GO" (user ask 2026-10-03). */
  cta: string;
  /** Accent used for the icon plate + CTA glow (matches the game's mode colour). */
  accent: string;
}

// Registry ORDER = the MODES grid order (user ask 2026-10-03): RANK leads the grid,
// CLASSIC goes second — the remaining cards keep their original order after them.
export const GAME_MODES: readonly GameModeDefinition[] = [
  {
    id: 'rank',
    title: 'RANK',
    subtitle: 'Climb the ladder — liberate planets in your rank ring.',
    blurb: 'Climb the ladder',
    tag: 'RANKED',
    icon: 'rank',
    actions: ['play'],
    players: 'LADDER',
    official: true,
    cta: 'ENTER MAP',
    accent: '#FF9B4A',
  },
  {
    id: 'classic',
    title: 'CLASSIC',
    subtitle: 'Create a lobby, invite survivors or join with a code — official server matches, 3v3v3.',
    blurb: 'Lobby up · 3v3v3',
    tag: 'OFFICIAL',
    icon: 'swords',
    actions: ['play'],
    players: '3v3v3',
    official: true,
    cta: 'OPEN LOBBY',
    accent: '#62E4E8',
  },
  {
    id: 'speedrun',
    title: 'SPEEDRUN',
    subtitle: 'A planet from your band, one clock — take the Nexus as fast as you can.',
    blurb: 'Race the clock',
    tag: 'SOLO',
    icon: 'stopwatch',
    actions: ['play'],
    players: '1',
    official: false,
    cta: 'START RUN',
    accent: '#67E6A5',
  },
  {
    id: 'survival',
    title: 'SURVIVAL',
    subtitle: 'Endless swarm, no Nexus. Enemies grow without mercy — survive the longest.',
    blurb: 'Outlast the swarm',
    tag: 'SOLO',
    icon: 'horde',
    actions: ['play'],
    players: '1',
    official: false,
    cta: 'START RUN',
    accent: '#C8FF43',
  },
  {
    id: 'custom',
    title: 'CUSTOM',
    subtitle: 'Lobby up with a code — P2P rules on the hybrid server. Everyone readies, the host starts.',
    blurb: 'Invite-only rules',
    tag: 'INVITE',
    icon: 'code',
    actions: ['play'],
    players: '9 MAX',
    official: false,
    cta: 'CREATE LOBBY',
    accent: '#62E4E8',
  },
  {
    id: 'freeroam',
    title: 'FREEROAM',
    subtitle: 'Roam a procedural world alone — no enemies, no clock, no setup.',
    blurb: 'Roam alone',
    tag: 'EXPLORE',
    icon: 'compass',
    actions: ['play'],
    players: '1',
    official: false,
    cta: 'START ROAM',
    accent: '#FF9B4A',
  },
];

/**
 * The card action row (§13): ALWAYS renders every declared action, in registry
 * priority order. A missing handler renders the button disabled with a reason —
 * never removed, so mobile and desktop keep the identical action set. The primary
 * action reads a uniform "GO" (user ask 2026-10-03).
 */
export function renderModeActions(
  mode: GameModeDefinition,
  handlers: Partial<Record<string, (() => void) | undefined>>,
  makeButton: (opts: {
    label: string;
    icon: string;
    tone: 'primary' | 'accent' | 'neutral' | 'danger';
    action?: MenuAction;
    disabled?: boolean;
    hint?: string;
    onClick?: () => void;
  }) => HTMLButtonElement
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'nf-mode-card__actions';
  for (const def of sortedActions(mode.actions)) {
    const handler = handlers[def.id];
    row.appendChild(
      makeButton({
        // ONE uniform label (user ask 2026-10-03): every mode's play button says GO.
        label: def.id === 'play' ? 'GO' : def.label,
        icon: def.icon,
        tone: def.id === 'play' ? 'primary' : def.tone,
        action: def.id,
        disabled: !handler,
        hint: !handler ? `${ACTIONS[def.id].label} is unavailable for ${mode.title}` : undefined,
        onClick: handler,
      })
    );
  }
  return row;
}

/** The mode card's icon plate (inline SVG from the shared icon map). */
export function modeIcon(mode: GameModeDefinition): string {
  return getIcon(mode.icon);
}
