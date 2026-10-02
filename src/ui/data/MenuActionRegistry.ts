// NECROFALL — ONE action registry (overhaul §3/§43).
//
// The rule that prevents "missing buttons in some game-mode menus":
// every screen DECLARES its supported actions once, here; the UI renders
// from the declaration and the dev audit (`src/ui/dev/UIAudit.ts`) fails
// loudly when a screen is missing one of its contract's actions.
//
// The layout changes per viewport — the ACTION SET never does.

export type MenuAction =
  | 'play'
  | 'rank'
  | 'casual'
  | 'solo'
  | 'custom'
  | 'freeroam'
  | 'queue'
  | 'invite'
  | 'ready'
  | 'cancel'
  | 'back'
  | 'profile'
  | 'friends'
  | 'galaxy'
  | 'map'
  | 'events'
  | 'lobby'
  | 'settings'
  | 'graphics'
  | 'controls'
  | 'howto'
  | 'fullscreen'
  | 'recenter'
  | 'filters'
  | 'select'
  | 'confirm'
  | 'more'
  | 'customize'
  | 'signout';

export type ActionTone = 'primary' | 'accent' | 'neutral' | 'danger';

export interface ActionDefinition {
  id: MenuAction;
  label: string;
  icon: string;
  priority: number;
  tone: ActionTone;
}

export const ACTIONS: Record<MenuAction, ActionDefinition> = {
  play: { id: 'play', label: 'PLAY', icon: 'play', priority: 100, tone: 'primary' },
  rank: { id: 'rank', label: 'RANKED', icon: 'rank', priority: 95, tone: 'accent' },
  casual: { id: 'casual', label: 'CASUAL', icon: 'swords', priority: 80, tone: 'neutral' },
  solo: { id: 'solo', label: 'SOLO', icon: 'stopwatch', priority: 70, tone: 'neutral' },
  custom: { id: 'custom', label: 'CUSTOM', icon: 'code', priority: 65, tone: 'neutral' },
  freeroam: { id: 'freeroam', label: 'FREEROAM', icon: 'compass', priority: 60, tone: 'neutral' },
  queue: { id: 'queue', label: 'FIND MATCH', icon: 'search', priority: 90, tone: 'primary' },
  invite: { id: 'invite', label: 'INVITE', icon: 'plus', priority: 75, tone: 'accent' },
  ready: { id: 'ready', label: 'READY', icon: 'check', priority: 100, tone: 'primary' },
  cancel: { id: 'cancel', label: 'CANCEL', icon: 'close', priority: 60, tone: 'danger' },
  back: { id: 'back', label: 'BACK', icon: 'arrow-left', priority: 1, tone: 'neutral' },
  profile: { id: 'profile', label: 'PROFILE', icon: 'user', priority: 20, tone: 'neutral' },
  friends: { id: 'friends', label: 'FRIENDS', icon: 'users', priority: 20, tone: 'neutral' },
  galaxy: { id: 'galaxy', label: 'GALAXY', icon: 'orbit', priority: 30, tone: 'neutral' },
  map: { id: 'map', label: 'MAP', icon: 'orbit', priority: 45, tone: 'neutral' },
  events: { id: 'events', label: 'EVENTS', icon: 'events', priority: 42, tone: 'neutral' },
  lobby: { id: 'lobby', label: 'RETURN TO LOBBY', icon: 'arrow-right', priority: 55, tone: 'primary' },
  settings: { id: 'settings', label: 'SETTINGS', icon: 'settings', priority: 10, tone: 'neutral' },
  graphics: { id: 'graphics', label: 'GRAPHICS', icon: 'star', priority: 9, tone: 'neutral' },
  controls: { id: 'controls', label: 'CONTROLS', icon: 'locate', priority: 8, tone: 'neutral' },
  howto: { id: 'howto', label: 'HOW TO PLAY', icon: 'help', priority: 7, tone: 'neutral' },
  fullscreen: { id: 'fullscreen', label: 'FULLSCREEN', icon: 'expand', priority: 6, tone: 'neutral' },
  recenter: { id: 'recenter', label: 'CENTER', icon: 'locate', priority: 5, tone: 'neutral' },
  filters: { id: 'filters', label: 'FILTERS', icon: 'filter', priority: 5, tone: 'neutral' },
  select: { id: 'select', label: 'SELECT', icon: 'search', priority: 50, tone: 'accent' },
  confirm: { id: 'confirm', label: 'CONFIRM', icon: 'check', priority: 100, tone: 'primary' },
  more: { id: 'more', label: 'MORE', icon: 'more', priority: 5, tone: 'neutral' },
  customize: { id: 'customize', label: 'CUSTOMIZE', icon: 'wand', priority: 15, tone: 'neutral' },
  signout: { id: 'signout', label: 'SIGN OUT', icon: 'door', priority: 1, tone: 'danger' },
};

/**
 * Every shell screen's REQUIRED action set (§43). Extend with the repo's REAL
 * features — a screen that renders fewer actions than its contract lists is a
 * bug, caught by the dev audit instead of a player.
 */
export const SCREEN_CONTRACTS = {
  /** #/home — the main menu. The bottom bar carries the four destinations
   *  (EVENTS · CUSTOMIZE · MAP · PLAY — user ask 2026-10-03), the avatar chip is
   *  PROFILE and the gear is SETTINGS. */
  main: ['events', 'customize', 'map', 'play', 'friends', 'profile', 'settings'],
  /** #/events — the live season + worlds-in-play board. */
  events: ['back'],
  /** #/play — the format menu: every mode card keeps its own enter action. */
  play: ['play', 'back'],
  /** #/solo/* — the run picker. */
  solo: ['play', 'back'],
  /** #/custom — the custom lobby setup. */
  custom: ['play', 'back'],
  /** #/rank — the intergalactic map chrome. */
  rank: ['back'],
  /** #/profile — the player card. */
  profile: ['back'],
} as const satisfies Record<string, readonly MenuAction[]>;

export type ContractScreen = keyof typeof SCREEN_CONTRACTS;

/** Actions of a screen, sorted by priority (highest first) — the render order. */
export function sortedActions(ids: readonly MenuAction[]): ActionDefinition[] {
  return [...ids].map((id) => ACTIONS[id]).sort((a, b) => b.priority - a.priority);
}
