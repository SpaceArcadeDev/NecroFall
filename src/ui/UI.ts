// NECROFALL — DOM UI: main menu, lobby, selection phases, HUD, minimap,
// level-up / pickup modals, results screens, debug overlay and mobile controls.
import type { InputManager } from '../input/InputManager';
import { COLONIES, CONFIG, IS_TOUCH, BEACON_LETTERS, beaconName } from '../core/Config';
import { NECROTECHS } from '../necrotech/NecrotechData';
import { iconFor, MUTATION_ICON, NECROTECH_ICONS } from '../necrotech/NecrotechIcons';
import { abilityIcon, crownIcon, statusIcon } from '../necrotech/AbilityIcons';
import { BEACON_ICON, NEXUS_ICON } from './TowerIcons';
import {
  AUTO_ATTACK_ICON,
  BOSS_ICON,
  CAPTURE_ICON,
  LEVEL_ICON,
  NECROTECH_ICON,
  OVERDRIVE_ICON,
  WIN_ICON,
} from './HowToIcons';
import { OrientationGate } from './Orientation';
import { LobbyAvatarInfo, SelectionPreview } from './SelectionPreview';
import { itemThumb } from './ItemThumbs';
import {
  fullscreenMode,
  fullscreenUnavailableReason,
  isAppleTouchDevice,
  isStandalone,
  lastFullscreenError,
  onFullscreenChange,
  toggleFullscreen,
} from './Fullscreen';
import { installTouchGuards, touchDiagnostics } from './TouchGuard';
import { formatTime } from '../utils/Utils';
import { CATEGORY_LABELS, CATEGORY_ORDER, defAt, defsOf } from '../customization/AccessoryCatalog';
import { AccessoryCategory, AccessorySelection } from '../customization/AccessoryTypes';
import type { PerkTier } from '../necromutation/Perks';
import { loadSelection } from '../customization/CustomizationStore';
import {
  QUALITY_BLURBS,
  QUALITY_LABELS,
  QUALITY_PREFS,
  loadQualityPref,
  resolveQuality,
  type QualityName,
  type QualityPref,
} from '../core/Config';

export type ScreenName = 'menu' | 'howto' | 'controls' | 'play' | 'lobby' | 'colony' | 'necrotech' | 'customize' | 'game' | 'results';

export interface UICallbacks {
  createLobby(name: string): void;
  joinLobby(code: string, name: string): void;
  startMatch(): void;
  /** Host only: removes one player from the lobby. */
  kickPlayer(id: string): void;
  leaveRoom(): void;
  returnToMenu(): void;
  perkPick(index: number): void;
  pickupChoice(choice: 'keep' | 'swap' | 'mutate'): void;
  toggleReady(): void;
  resume(): void;
  leaveMatch(): void;
  /** The HUD settings cog — opens the same panel Esc does. */
  openMenu(): void;
  /**
   * Closes the Esc panel unconditionally. Deliberately NOT `resume()`: that one toggles, and the
   * tap-anywhere-dismiss gesture must never be able to toggle a closing panel back open.
   */
  closeMenu(): void;
  /** The player picked a graphics level on the main menu. */
  setGraphics(pref: QualityPref): void;
  /** The customize screen changed the outfit (Game stores it, persists it and re-dresses the player). */
  setAccessories(sel: AccessorySelection): void;
}

export interface HudData {
  remaining: number;
  matchTime: number;
  hp: number;
  maxHp: number;
  level: number;
  xp: number;
  xpNeed: number;
  skillName: string;
  skillDesc: string;
  skillCd: number;
  skillMax: number;
  ultName: string;
  ultDesc: string;
  ultCd: number;
  ultMax: number;
  dashCharges: number;
  dashMax: number;
  dashRecharge: number;
  dashRechargeNeed: number;
  /** Leaps left, ground leap included (double jump is part of the base kit). */
  jumpsLeft: number;
  jumpsMax: number;
  /** How many bodies ONE auto-attack event engages at once (grows with the level). */
  autoTargets: number;
  /** True while the local player is inside one of their own shielded Beacons. */
  beaconReady: boolean;
  colonyIdx: number;
  necrotechName: string;
  necrotechColor: string;
  /** The class passive (both parents' for a mutation) — shown under the ultimate in the Esc panel. */
  passiveName: string;
  passiveDesc: string;
  mutated: number;
  /** How many Necrotechs are active, and the hard cap on them (always 3). */
  mutationCount: number;
  mutationLimit: number;
  /** Colour of the loadout's headline mutation. */
  mutationColor: string;
  /** The loadout's headline mutation: its own name, the source classes (2, or 3 for a triple), tags and description. */
  mutationName: string;
  mutationSources: string;
  mutationDesc: string;
  mutationTags: string;
  mutationRarity: string;
  buffs: { text: string; cls: string }[];
  prompt: string;
  promptKey: string;
  conn: string;
  /** Room code of the running match (empty offline) — shown in the Esc menu so friends can join. */
  roomCode: string;
  towers: {
    kind: string;
    owner: number;
    state: string;
    capture: number;
    captureColony: number;
    shieldUp: boolean;
    /** Seconds left on a captured Beacon's ward (0 = no countdown). */
    shieldT: number;
    /** 0..1 of the ward's life left, drawn as a decreasing ring in the tracker (0 = no countdown). */
    shieldFrac: number;
    bossAlive: boolean;
  }[];
  counts: number[];
  zone: { label: string; progress: number; colony: number } | null;
  /** Perks picked so far — shown in the Esc panel. */
  perks: { name: string; desc: string }[];
  /** Colony objectives shown top-right, under the tower tracker. */
  tasks: { label: string; progress: string; done: boolean }[];
}

/** One coloured run inside a global banner (see `UI.bannerParts`). */
export interface BannerPart {
  text: string;
  /** CSS colour for this run. Omitted = the banner's own white. */
  color?: string;
}

export interface MiniData {
  /** Local player position + tangent frame — the radar is centred on it. */
  origin: { x: number; y: number; z: number };
  fwd: { x: number; y: number; z: number };
  right: { x: number; y: number; z: number };
  range: number;
  players: { x: number; y: number; z: number; colony: number; isLocal: boolean; alive: boolean }[];
  towers: {
    x: number; y: number; z: number; /** Tower index: 0-3 = Beacon A-D, 4 = the Nexus. */
    idx: number;
    owner: number; kind: string; state: string;
    /** A ward is up (a guarded Beacon, a captured Beacon's reprieve, the sealed Nexus). */
    shieldUp: boolean;
    /** 0..1 of the ward's life left — drawn as a circular progress ring around the landmark. */
    shieldFrac: number;
    /** True while a live Warden is keeping the ward up (so there is no countdown to show). */
    guarded: boolean;
    /** 0..1 of a capture in flight (0 = nobody is taking it). */
    capture: number;
    /** Colony pushing that capture, -1 when none. */
    captureColony: number;
  }[];
  enemies: { x: number; y: number; z: number; boss: boolean }[];
}

/** One floating health plate drawn in screen space above a creature or player (MOBA style). */
export interface BossPlate {
  /** Unique DOM key (enemies use `e<id>`, players `p<id>`). */
  key: string;
  x: number;
  y: number;
  visible: boolean;
  /** boss = named warden/overseer, mini = apex/elite, player = colony survivor, base = fortress,
   *  ward = a tower's shield (no health to lose, so it is drawn hatched). */
  kind: 'boss' | 'mini' | 'player' | 'base' | 'ward';
  name: string;
  hp: number;
  maxHp: number;
  color: string;
  /** Ward plates only: what the shield is waiting on ("DEFEAT THE BEACON GUARDIAN", …). */
  caption?: string;
  /** Players only. */
  level: number;
  xpFrac: number;
  dashCharges: number;
  dashMax: number;
  /** 0..1 progress of the dash charge currently recharging. */
  dashFrac: number;
  /** True for the local player's own plate. */
  self: boolean;
  /** Players only: Necrotic Ward charge, drawn as a light-blue overlay on the health bar. */
  shield?: number;
  shieldMax?: number;
  /** Bosses only: STUN left and its pool, so every client draws the same stun bar. */
  stun?: number;
  stunMax?: number;
  /** Bosses only: the enraged phase's world-readable state (red tag on the plate). */
  enraged?: boolean;
  /** Bosses only: the boss is STUNNED right now — the punish window. */
  stunned?: boolean;
  /** Players only: buffs / debuffs drawn as icons above the name row. */
  statuses?: {
    key: string;
    label: string;
    desc: string;
    kind: 'buff' | 'debuff';
    icon: string;
    remain: number;
    total: number;
    stacks: number;
    timed: boolean;
  }[];
}

/** One floating tower plate: how far a colony has pushed a capture, and what is left. */export interface TowerPlate {
  /** Unique DOM key (`t<idx>`). */
  idx: number;
  x: number;
  y: number;
  visible: boolean;
  /** `BEACON 1` / `NEXUS`. */
  label: string;
  /** Name of the colony doing the capturing. */
  colonyName: string;
  /** Colony colour of the capturing side. */
  color: string;
  /** 0..1 capture progress. */
  frac: number;
  /** Seconds left before the tower flips. */
  remain: number;
}

export interface ResultsData {
  victory: boolean;
  winnerColony: number | null;
  tiles: { label: string; owner: number }[];
  stats: { k: string; v: string }[];
  reason?: string;
  /** Big outcome facts shown as tiles under the title. */
  hero?: { label: string; value: string; accent?: string }[];
  /** One entry per colony, for the standings bars. */
  standings?: { name: string; color: string; towers: number }[];
  /** Match length, shown under the title. */
  matchTime?: string;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, label);
  b.addEventListener('click', () => onClick());
  return b;
}

/** `0xRRGGBB` → an `rgba()` string, for the per-card accent variables (`--col`, `--a15`, …). */
function colA(hex: number, alpha: number): string {
  return `rgba(${(hex >> 16) & 255}, ${(hex >> 8) & 255}, ${hex & 255}, ${alpha})`;
}

/** Paints a selection card in ITS colony / class colour: the rail, crest and hover glow all read it. */
function tintCard(card: HTMLElement, hex: number, css: string): void {
  card.style.setProperty('--col', css);
  card.style.setProperty('--a15', colA(hex, 0.15));
  card.style.setProperty('--a35', colA(hex, 0.35));
  card.style.setProperty('--a55', colA(hex, 0.55));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------------------------
// Diff-gated DOM helpers. The HUD is rebuilt every frame, but almost nothing in it changes every
// frame (the clock ticks once a second, cooldowns tick ten times). Writing a style or a text node
// costs a style recalculation even when the value is identical, so every hot write goes through
// these: reading the current value back is cheap, invalidating the layout is not.
function setText(node: HTMLElement | null, v: string): void {
  if (node && node.textContent !== v) node.textContent = v;
}

function setStyle(
  node: HTMLElement | null,
  prop: 'width' | 'color' | 'background' | 'borderColor' | 'transform',
  v: string
): void {
  if (node && node.style[prop] !== v) node.style[prop] = v;
}

/** CSS custom properties (the conic-gradient cooldown masks) need the property API. */
function setVar(node: HTMLElement | null, name: string, v: string): void {
  if (node && node.style.getPropertyValue(name) !== v) node.style.setProperty(name, v);
}

/** Class writes only when the class actually changes. */
function setClass(node: HTMLElement | null, name: string, on: boolean): void {
  if (node && node.classList.contains(name) !== on) node.classList.toggle(name, on);
}

/** Linear blend between two #rrggbb colours, returned as a CSS colour. */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const k = clamp01(t);
  const r = Math.round((((pa >> 16) & 255) * (1 - k)) + (((pb >> 16) & 255) * k));
  const g = Math.round((((pa >> 8) & 255) * (1 - k)) + (((pb >> 8) & 255) * k));
  const bl = Math.round(((pa & 255) * (1 - k)) + ((pb & 255) * k));
  return `rgb(${r}, ${g}, ${bl})`;
}

/**
 * Player health colour: green while healthy, sliding through orange into red as it depletes.
 * Returns the two gradient stops so the bar reads exactly like the enemy bars.
 */
function playerHpGradient(frac: number): [string, string] {
  const f = clamp01(frac);
  if (f >= 0.55) {
    const t = (f - 0.55) / 0.45;            // 0 = orange-ish, 1 = healthy green
    return [mixHex('#e8b53a', '#2fbf6a', t), mixHex('#ffd98a', '#8dffb0', t)];
  }
  const t = f / 0.55;                       // 0 = critical red, 1 = orange
  return [mixHex('#d81f38', '#e8b53a', t), mixHex('#ff6a5c', '#ffd98a', t)];
}

/**
 * Colony fortress plates: a dark slab crossed with grey diagonals. Deliberately not a health
 * gradient — a base has no health to lose, and the plate should say so at a glance.
 */
const BASE_HATCH = 'repeating-linear-gradient(45deg, #767683 0 4px, #2b2b34 4px 9px)';

/**
 * Tower ward plates: the same idea in the shield's own colours — red crossed with dark grey
 * diagonals. A ward is not something you shoot down, it is something you have to UNLOCK (kill the
 * Warden, or liberate the Beacons), so it must never read as a depletable health bar.
 */
const WARD_HATCH = 'repeating-linear-gradient(45deg, #ff2d4a 0 5px, #2b2b34 5px 10px)';
/**
 * The same hatch in any colour — a captured Beacon's ward flies its colony's banner, so the plate is
 * hatched in the owner's colour rather than always red. Cached: the string is rebuilt only when the
 * colour actually changes, never per frame.
 */
const wardHatchCache = new Map<string, string>();
function wardHatch(color: string): string {
  const hit = wardHatchCache.get(color);
  if (hit) return hit;
  const hatch = `repeating-linear-gradient(45deg, ${color} 0 5px, #2b2b34 5px 10px)`;
  wardHatchCache.set(color, hatch);
  return hatch;
}
/** The ward ring's colour while nobody owns the tower (a Warden's ward, the sealed Nexus). */
const WARD_RED = '#ff2d4a';

/** Small action-button glyphs (jump / dash / Beacon) for the desktop rail. */
const ICON_JUMP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>';
// Dash: the arrow leads and its two speed lines TRAIL it. They used to sit past the arrowhead, which
// read as exhaust firing forwards — they belong behind the tail.
const ICON_DASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M8 12h7"/><path d="M12 7l5 5-5 5"/><path d="M3 9h3"/><path d="M3 15h3"/></svg>';
// COLONY OVERDRIVE: a bolt with the Beacon's energy converging on it from both sides.
const ICON_BEACON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M13.6 2.6 7.8 12.2h3.6l-1.2 8.9 6.2-10.6h-3.6z" fill="currentColor" stroke="none"/>' +
  '<path d="M5.2 8.6 3.6 12l1.6 3.4"/><path d="M18.8 8.6 20.4 12l-1.6 3.4"/></svg>';

/** CLASSIC — crossed swords: the plain, unranked fight for the planet. */
const ICON_SWORDS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/>' +
  '<path d="M13 19l6-6"/>' +
  '<path d="M16 16l4 4"/>' +
  '<path d="M19 21l2-2"/>' +
  '<path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/>' +
  '<path d="M5 14l4 4"/>' +
  '<path d="M7 17l-3 3"/>' +
  '<path d="M3 19l2 2"/></svg>';

/** RANK — a pyramid ladder: the climb up the standings, rungs and all. */
const ICON_LADDER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 3.4 20.2 20.6H3.8z"/>' +
  '<path d="M9 9.8h6"/>' +
  '<path d="M7.4 13.4h9.2"/>' +
  '<path d="M5.7 17h12.6"/></svg>';

/** CUSTOMIZE category glyphs — one per slot, so the three tabs read before the words do. */
const ICON_HAT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M7.4 15V9.6a4.6 4.6 0 0 1 9.2 0V15"/>' +
  '<path d="M4 15h16"/></svg>';
const ICON_PACK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="5" y="8.6" width="14" height="11.4" rx="3.6"/>' +
  '<path d="M9 8.6V7.2a3 3 0 0 1 6 0v1.4"/>' +
  '<path d="M9.6 14h4.8"/></svg>';
const ICON_PAW =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="15.4" r="3.1"/>' +
  '<circle cx="7.1" cy="11.9" r="1.75"/>' +
  '<circle cx="10.1" cy="8.9" r="1.75"/>' +
  '<circle cx="13.9" cy="8.9" r="1.75"/>' +
  '<circle cx="16.9" cy="11.9" r="1.75"/></svg>';

/** RANDOMIZE — the classic crossed-arrow shuffle, worn with no button pot. */
const ICON_SHUFFLE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M16 3h5v5"/>' +
  '<path d="M4 20 21 3"/>' +
  '<path d="M21 16v5h-5"/>' +
  '<path d="m15 15 6 6"/>' +
  '<path d="m4 4 5 5"/></svg>';

/** Maps each customize category to its tab glyph. */
function accTabIcon(cat: AccessoryCategory): string {
  switch (cat) {
    case 'hat': return ICON_HAT;
    case 'backpack': return ICON_PACK;
    case 'pet': return ICON_PAW;
  }
}

/**
 * The chevron every sub-screen's back button wears. One glyph, one corner (top-left, where the eye
 * goes for "leave"), one size: the way out of a screen should not be something to learn twice.
 */
const ICON_BACK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M15 5l-7 7 7 7"/></svg>';

/** The close glyph for the Esc panel's own header button. */
const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">' +
  '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';

/** FULLSCREEN — the four corner brackets opening outward (swapped for the closing pair in fullscreen). */
const ICON_EXPAND =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/></svg>';
const ICON_COLLAPSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M9 4v5H4"/><path d="M15 4v5h5"/><path d="M9 20v-5H4"/><path d="M15 20v-5h5"/></svg>';

/** LEAVE MATCH — an arrow walking out of the door. */
const ICON_EXIT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M13.5 4.5h-7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h7"/>' +
  '<path d="M16.5 8.5 20 12l-3.5 3.5"/><path d="M20 12H9.5"/></svg>';

/** LOBBY — copy: two stacked cards, the universal "duplicate" mark. */
const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="9" y="9" width="11.5" height="11.5" rx="2.4"/>' +
  '<path d="M15 5.8V5.2A2.2 2.2 0 0 0 12.8 3H5.2A2.2 2.2 0 0 0 3 5.2v7.6A2.2 2.2 0 0 0 5.2 15h.6"/></svg>';
/** LOBBY — share: the three-node link. Opens the OS share sheet; falls back to copying the link. */
const ICON_SHARE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="6" cy="12" r="2.7"/><circle cx="17.4" cy="5.7" r="2.7"/><circle cx="17.4" cy="18.3" r="2.7"/>' +
  '<path d="m8.4 10.7 6.6-3.7"/><path d="m8.4 13.3 6.6 3.7"/></svg>';

export class UI {
  private root = el('div', '');
  private screens = new Map<ScreenName, HTMLElement>();
  private hud = el('div', 'hud hidden');
  private mobile = el('div', 'mobile hidden');
  private current: ScreenName = 'menu';
  private cbs: UICallbacks;
  private name = 'Survivor';
  private input: InputManager | null = null;
  /** Mobile landscape gate — blocks play while a phone is held upright. */
  readonly orientation: OrientationGate;

  // HUD refs
  private timerVal!: HTMLElement;
  private taskList!: HTMLElement;
  private timerRail!: HTMLElement;
  private towerWidget: { el: HTMLElement; glyph: HTMLElement; ring: HTMLElement; status: HTMLElement; fill: HTMLElement }[] = [];
  private bossPlates = new Map<string, {
    el: HTMLElement;
    name: HTMLElement;
    fill: HTMLElement;
    xpFill: HTMLElement | null;
    lvl: HTMLElement | null;
    dashes: { el: HTMLElement; fill: HTMLElement }[];
    statusRow: HTMLElement | null;
    crown: HTMLElement | null;
    /** Ward plates only: the caption under the bar ("DEFEAT THE BEACON GUARDIAN", …). */
    cap: HTMLElement | null;
    shieldWrap: HTMLElement | null;
    shieldFill: HTMLElement | null;
    /** Boss plates only: the stun bar (a second bar under health) and the ENRAGED / STUNNED tags. */
    stunWrap: HTMLElement | null;
    stunFill: HTMLElement | null;
    rage: HTMLElement | null;
    stunTag: HTMLElement | null;
    statusSig: string;
    /** Quantised health the cached gradient was built for (see the player plate). */
    hpQ: number;
    statusIcons: { el: HTMLElement; ring: HTMLElement; count: HTMLElement; label: string; desc: string }[];
  }>();
  private statusTip: HTMLElement | null = null;
  private statusTipT = 0;
  /** The ability description overlay (hover on desktop, long-press on touch). */
  private abTip: HTMLElement | null = null;
  private abTipSig = '';
  /** Graphics level row on the main menu. */
  private graphicsOpts = new Map<QualityPref, HTMLElement>();
  private graphicsNote: HTMLElement | null = null;
  private graphicsPref: QualityPref = 'auto';
  /** Objective rows are built once and then diffed (they used to be re-parsed from HTML per frame). */
  private taskRows: { row: HTMLElement; mark: HTMLElement; label: HTMLElement; prog: HTMLElement }[] = [];
  private taskSig = '';
  private buffSig = '';
  /** Radar redraw gate (see `drawMinimap`). */
  private mapLast = -1e9;
  /** Latest ability text, refreshed by the HUD each frame so a tip can be built on demand. */
  private abInfo = { skill: { name: '', desc: '', cd: 0, cdMax: 0 }, ult: { name: '', desc: '', cd: 0, cdMax: 0 } };
  /** Desktop jump / dash charge counters, and the Beacon ability button (shown while usable). */
  private jumpCount: HTMLElement | null = null;
  private dashCount: HTMLElement | null = null;
  private beaconBtn: HTMLElement | null = null;
  private bossLayer!: HTMLElement;
  private towerPlates = new Map<number, { el: HTMLElement; nm: HTMLElement; pct: HTMLElement; fill: HTMLElement; cd: HTMLElement }>();
  private minimap!: HTMLCanvasElement;
  private ntTag!: HTMLElement;
  /** The mutation chip: it carries the mutation's NAME (the cap lives in its tooltip). */
  private mutTag!: HTMLElement;
  /** Fields the mutation chip's tooltip reads — refreshed by `updateHud`. */
  private mutTipLabel = '';
  private mutTipDesc = '';
  /** Non-blocking "NEW MUTATION" reveal card. */
  private mutateBox!: HTMLElement;
  /** The persistent bottom-centre chips (mutation name + Necrotech combination). They step aside
   *  while the reveal card stands in their spot and rise back in from below when it ends. */
  private pillsRow!: HTMLElement;
  private buffTags!: HTMLElement;
  private skillBtn!: HTMLElement;
  private ultBtn!: HTMLElement;
  private skillName!: HTMLElement;
  private ultName!: HTMLElement;
  /** The headline label on each ability button (the ability's own name). */
  private skillKey!: HTMLElement;
  private ultKey!: HTMLElement;
  private skillMask!: HTMLElement;
  private ultMask!: HTMLElement;
  private skillCdTxt!: HTMLElement;
  private ultCdTxt!: HTMLElement;
  private skillAccent!: HTMLElement;
  private ultAccent!: HTMLElement;
  private skillIcon!: HTMLElement;
  private ultIcon!: HTMLElement;
  private zoneBar!: HTMLElement;
  private zoneLabel!: HTMLElement;
  private zoneFill!: HTMLElement;
  private toastBox!: HTMLElement;
  private bannerBox!: HTMLElement;
  private promptBox!: HTMLElement;
  private promptCap!: HTMLElement;
  private promptText!: HTMLElement;
  private connBox!: HTMLElement;
  private killfeed!: HTMLElement;
  private debugBox!: HTMLElement;
  // mobile control readouts
  private mSkillCd: HTMLElement | null = null;
  private mUltCd: HTMLElement | null = null;
  private mDashCount: HTMLElement | null = null;
  private mJumpCount: HTMLElement | null = null;
  private mSkillBtn: HTMLElement | null = null;
  private mUltBtn: HTMLElement | null = null;
  private mJumpBtn: HTMLElement | null = null;
  private mBeaconBtn: HTMLElement | null = null;
  private mSkillIco: HTMLElement | null = null;
  private mUltIco: HTMLElement | null = null;
  private mSkillName: HTMLElement | null = null;
  private mUltName: HTMLElement | null = null;

  // modal refs
  private levelUpModal!: HTMLElement;
  private levelUpPerks!: HTMLElement;
  private levelUpTimer!: HTMLElement;
  private perkButtons: HTMLElement[] = [];
  private pickupModal!: HTMLElement;
  private pickupCols!: HTMLElement;
  private pickupTimer!: HTMLElement;
  private pickupMutateNote!: HTMLElement;
  private respawnModal!: HTMLElement;
  private respawnKiller!: HTMLElement;
  private respawnTimer!: HTMLElement;
  private pauseModal!: HTMLElement;
  private pauseStats!: HTMLElement;
  private pausePerks!: HTMLElement;
  private pauseAbilities!: HTMLElement;
  private pauseRoomCode!: HTMLElement;
  private pauseRoomHint!: HTMLElement;
  /** Structural signature of the Esc panel: it is rebuilt ONLY when this changes. */
  private pauseSig = '';
  /** The `[data-w]` value slots inside the built panel (hp, cooldowns, …), patched per frame. */
  private pauseVals: HTMLElement[] = [];
  private fsBtn: HTMLButtonElement | null = null;
  /** Why fullscreen is unavailable here, shown under the pause-menu button when there is a reason. */
  private fsHint: HTMLElement | null = null;
  /** Touch-only diagnostic block at the bottom of the pause panel (see refreshDiagnostics). */
  private diag: HTMLElement | null = null;

  // lobby refs
  private lobbyCode!: HTMLElement;
  /** The avatar rail: one live 3D figure per seat, standing above the seat cards. */
  // (see also the necrotech detail overlay fields further down)
  private lobbyRail!: HTMLElement;
  private lobbySeats!: HTMLElement;
  private lobbyLineup!: HTMLElement;
  private lobbyTrack!: HTMLElement;
  private lobbyTrackInner!: HTMLElement;
  private lobbyHint!: HTMLElement;
  private lobbyStart!: HTMLButtonElement;
  private lobbyReady!: HTMLButtonElement;
  /** The roster last pushed to the rail (kept so re-opening the screen rebuilds it at once). */
  private lobbyAvatars: LobbyAvatarInfo[] = [];
  private playStatus!: HTMLElement;
  private joinInput!: HTMLInputElement;
  private playNameInput!: HTMLInputElement;
  /** PLAY screen: which format is being set up (RANK is locked and never enters). */
  private playMode: 'classic' | null = null;
  private playScreen!: HTMLElement;
  private playEnter!: HTMLElement;
  private classicCard!: HTMLElement;
  /** Status/room feedback shown under the format cards while the entry is still folded away. */
  private playNote!: HTMLElement;
  /** Set once the squircle renders have been generated (they cost a first-time render pass). */
  private accThumbsReady = false;

  // selection refs
  private colonyCards: { card: HTMLElement; count: HTMLElement }[] = [];
  private colonyTimer!: HTMLElement;
  private colonySub!: HTMLElement;
  private ntCards: HTMLElement[] = [];
  private ntTimer!: HTMLElement;
  private ntSub!: HTMLElement;
  private ntScreen!: HTMLElement;
  /**
   * The necrotech DETAIL overlay (see `openNtExpand`): a child of the screen, anchored above the
   * card it belongs to. Only one exists at a time — `ntExpandIdx` is which card owns it (-1 none).
   */
  private ntExpand: HTMLElement | null = null;
  private ntExpandIdx = -1;
  private ntExpandTimer = 0;
  /** Live 3D preview shared by the two selection screens (see ui/SelectionPreview.ts). */
  private preview: SelectionPreview | null = null;
  /** True while the ACCOUNT SHELL owns the preview (its home screen stages a character). */
  private shellBorrowedPreview = false;
  private colonyPreviewBox!: HTMLElement;
  private ntPreviewBox!: HTMLElement;
  private customizePreviewBox!: HTMLElement;
  /** Customize screen state: the worn outfit and the open category. */
  private accSel: AccessorySelection = loadSelection();
  private accTab: AccessoryCategory = 'hat';
  private accTabs = new Map<AccessoryCategory, HTMLButtonElement>();
  private accStrip!: HTMLElement;
  private accCaption!: HTMLElement;
  /** Which card the pointer is over, and which one this player has actually picked. */
  private colonyHover = -1;
  private colonyPick = -1;
  private ntHover = -1;
  private ntPick = -1;

  // results refs (rebuilt on show)
  private resultsScreen: HTMLElement | null = null;
  private debugVisible = false;

  constructor(cbs: UICallbacks) {
    this.cbs = cbs;
    // Kill iOS double-tap / pinch zoom before any of the HUD exists (see ui/TouchGuard.ts).
    installTouchGuards();
    this.root.id = 'ui';
    document.body.appendChild(this.root);
    const saved = localStorage.getItem('necrofall.name');
    if (saved) this.name = saved;
    // One shared gate (see OrientationGate.shared): it lives on <body> so the account shell's
    // `#ui { display: none }` cannot take the rotate/fullscreen prompt away from phones.
    this.orientation = OrientationGate.shared();
    this.buildMenu();
    this.buildHowTo();
    this.buildControls();
    this.buildPlay();
    this.buildLobby();
    this.buildColonySelect();
    this.buildNecrotechSelect();
    this.buildCustomize();
    this.buildHud();
    this.buildModals();
    this.buildMobile();
    this.show('menu');
  }

  /**
   * Account shell takeover (src/app/AppShell.ts): hide the ENTIRE in-game UI layer while the
   * account shell owns the screen. The 3D world keeps rendering behind it, so the shell menus
   * sit on the live planet exactly like the in-game menu always has.
   */
  setShellMode(on: boolean): void {
    this.root.style.display = on ? 'none' : '';
  }

  /**
   * Optional observer (the account shell): notified synchronously AFTER every screen
   * switch, so the shell can take the screen back the instant a game screen hands it
   * to the game menu (no flash of the old P2P menu in between).
   */
  onScreenChange: ((name: ScreenName) => void) | null = null;

  /**
   * Account shell: stage this player's avatar on the shell's home screen using the SAME lobby
   * line-up preview the in-game lobby uses — one avatar, the player's own outfit, its idle, its pet.
   */
  showShellAvatar(host: HTMLElement, colony: number, accWire: string): void {
    this.shellBorrowedPreview = true;
    if (!this.preview) this.preview = new SelectionPreview();
    this.preview.setMode('lobby', host);
    this.preview.setLobbyAvatars([{ id: 'shell-me', colony, ready: true, me: true, acc: accWire }]);
    this.preview.setFocus(0);
  }

  /** Account shell: park the avatar stage again (another screen claimed the preview). */
  hideShellAvatar(): void {
    this.shellBorrowedPreview = false;
    this.preview?.setMode(null, null);
  }

  /**
   * Account shell: stage a party line-up (up to 3 figures) on the OFFICIAL lobby —
   * the exact lobby rail the in-game P2P lobby draws: same preview, same seats, every
   * member's own outfit.
   */
  showShellParty(host: HTMLElement, members: { id: string; colony: number; ready: boolean; me: boolean; acc: string }[]): void {
    this.shellBorrowedPreview = true;
    if (!this.preview) this.preview = new SelectionPreview();
    this.preview.setMode('lobby', host);
    this.preview.setLobbyAvatars(members);
    this.preview.setFocus(0);
  }

  // ------------------------------------------------------------ helpers

  get playerName(): string {
    return this.name;
  }

  private rememberName(n: string): void {
    this.name = n.trim().slice(0, 16) || 'Survivor';
    localStorage.setItem('necrofall.name', this.name);
  }

  private nameRowSync(): void {
    if (this.playNameInput && this.playNameInput.value !== this.name) this.playNameInput.value = this.name;
  }

  show(name: ScreenName): void {
    // Leaving PLAY forgets the format: coming back always starts at the CLASSIC / RANK choice, so
    // the classic entry (name, create, join) can never sit there already open from last time.
    if (name === 'play' && this.current !== 'play') this.resetPlayMode();
    this.current = name;
    this.nameRowSync();
    for (const [key, screen] of this.screens) {
      screen.classList.toggle('hidden', key !== name);
    }
    this.syncPreview(name);
    // a necrotech detail overlay must not survive into another screen (its anchor is gone)
    if (name !== 'necrotech') this.closeNtExpand();
    this.hud.classList.toggle('hidden', name !== 'game');
    // world plates belong to the match only — never over menus or selection screens
    this.bossLayer.classList.toggle('hidden', name !== 'game');
    this.mobile.classList.toggle('hidden', name !== 'game' || !IS_TOUCH);
    if (name !== 'game') {
      this.updateBossPlates([]);
      // in-match overlays must not survive into menus
      this.hideRespawn();
      this.hideLevelUp();
      this.hidePickup();
      this.hidePauseMenu();
    }
    this.onScreenChange?.(name);
  }

  get currentScreen(): ScreenName {
    return this.current;
  }

  /**
   * Moves the 3D preview into whichever selection screen is open (or parks it). The SAME canvas is
   * re-mounted, so the whole menu costs one extra WebGL context and nothing while a match runs.
   */
  private syncPreview(name: ScreenName): void {
    // The account shell has borrowed the preview to stage the player's character on its home
    // screen. The game's own screens are hidden underneath it — leave the canvas where it is.
    if (this.shellBorrowedPreview) return;
    if (name === 'lobby') {
      if (!this.preview) this.preview = new SelectionPreview();
      this.preview.setMode('lobby', this.lobbyRail);
      this.refreshLobbyAvatars();
      return;
    }
    if (name === 'customize') {
      if (!this.preview) this.preview = new SelectionPreview();
      this.preview.setMode('customize', this.customizePreviewBox);
      // first visit: build the squircle renders now (a few tens of ms on one category), so the
      // app itself never pays for them at boot
      if (!this.accThumbsReady) {
        this.accThumbsReady = true;
        this.renderAccStrip();
      }
      this.refreshCustomizePreview();
      return;
    }
    if (name !== 'colony' && name !== 'necrotech') {
      this.preview?.setMode(null, null);
      return;
    }
    if (!this.preview) this.preview = new SelectionPreview();
    if (name === 'colony') {
      this.preview.setMode('colony', this.colonyPreviewBox);
      this.preview.setSelected(this.colonyPick);
      this.preview.setFocus(this.colonyHover >= 0 ? this.colonyHover : Math.max(0, this.colonyPick));
    } else {
      this.preview.setMode('necrotech', this.ntPreviewBox, NECROTECHS);
      this.preview.showWeapon(this.ntHover >= 0 ? this.ntHover : Math.max(0, this.ntPick));
    }
  }

  private reg(name: ScreenName, screen: HTMLElement): void {
    screen.classList.add('hidden');
    this.screens.set(name, screen);
    this.root.appendChild(screen);
  }

  /**
   * The one back affordance every sub-screen shares: a chevron pinned to the TOP-LEFT corner at
   * thumb size — the corner the eye reads as "leave". `side` still exists for the rare screen that
   * needs it on the other edge, but every current caller uses the default.
   */
  private addBack(screen: HTMLElement, label: string, onBack: () => void, side: 'right' | 'left' = 'left'): void {
    const b = el('button', side === 'left' ? 'screen-back at-left' : 'screen-back') as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = ICON_BACK;
    b.addEventListener('click', () => onBack());
    screen.appendChild(b);
    // Screens that carry the chevron reserve a band for it (see `.screen.has-back` in the CSS), so
    // the panel never starts underneath the button on a short viewport.
    screen.classList.add('has-back');
  }

  /**
   * Makes a horizontal strip (the class list, the lobby roster) DRAGGABLE — with a finger and with
   * a mouse — and answers a wheel too (anywhere on `wheelHost`, default the strip itself, so the
   * gaps between cards and the screen around them still scroll). The pan drives `scrollLeft` by
   * hand once the gesture reads horizontal, so the list sweeps under the pointer on every engine,
   * and a sweep can never end as a tap/click on whatever card it stopped over (the click is
   * swallowed after a drag). `skip` ignores drags that start inside another drag surface — the
   * lobby's turntable rail owns its own gesture. A flick keeps gliding on TOUCH only; a mouse
   * release stops dead (a desktop list that keeps rolling after the button comes up feels broken).
   */
  private attachDragScroll(strip: HTMLElement, skip?: string, wheelHost?: HTMLElement): void {
    let id = -1;
    let kind: 'touch' | 'mouse' | null = null;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let axis: 'undecided' | 'x' | 'y' = 'undecided';
    let moved = false;
    let vel = 0;
    let lastX = 0;
    let lastT = 0;
    let raf = 0;
    const stopFling = (): void => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const fling = (): void => {
      // a touch flick coasts: capped and decaying fast, so it never reads as "it keeps scrolling"
      vel = Math.max(-1.4, Math.min(1.4, vel));
      if (Math.abs(vel) < 0.06) return;
      const step = (): void => {
        strip.scrollLeft -= vel * 16;
        vel *= 0.9;
        raf = Math.abs(vel) > 0.06 ? requestAnimationFrame(step) : 0;
      };
      raf = requestAnimationFrame(step);
    };
    const start = (x: number, y: number, from: 'touch' | 'mouse'): void => {
      stopFling();
      // a NEW gesture starts clean: a previous sweep that never produced a click (a flick, a drop
      // outside the window) must not swallow this press's click
      delete strip.dataset.dragged;
      kind = from;
      startX = lastX = x;
      startY = y;
      startLeft = strip.scrollLeft;
      axis = 'undecided';
      moved = false;
      vel = 0;
      lastT = performance.now();
    };
    /** Reads the gesture axis; true once it is a horizontal pan AND the strip can actually move. */
    const panning = (x: number, y: number): boolean => {
      const dx = x - startX;
      const dy = y - startY;
      if (axis === 'undecided' && (Math.abs(dx) > 7 || Math.abs(dy) > 7)) {
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      }
      return axis === 'x' && strip.scrollWidth > strip.clientWidth + 1;
    };
    const panTo = (x: number): void => {
      strip.scrollLeft = startLeft - (x - startX);
      const now = performance.now();
      if (now > lastT) vel = (x - lastX) / (now - lastT);
      lastX = x;
      lastT = now;
    };
    const end = (): void => {
      strip.classList.remove('dragging');
      if (moved) {
        strip.dataset.dragged = '1';
        // A coast only makes sense right after a REAL flick. If the pointer rested before the
        // release (no moves lately), its old velocity is stale — gliding away from a stopped
        // finger is the "it drifts on after I let go" case, so stop dead instead.
        if (kind === 'touch' && performance.now() - lastT <= 90) fling();
      }
      id = -1;
      kind = null;
      axis = 'undecided';
      moved = false;
    };
    // ---- touch: the pan is applied by hand (the native pan is cancelled once it reads horizontal)
    strip.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) return;
      if (skip && (e.target as Element | null)?.closest(skip)) return;
      id = e.touches[0].identifier;
      start(e.touches[0].clientX, e.touches[0].clientY, 'touch');
    }, { passive: true });
    strip.addEventListener('touchmove', e => {
      if (id < 0 || e.touches.length !== 1 || e.touches[0].identifier !== id) return;
      const t = e.touches[0];
      if (!panning(t.clientX, t.clientY)) return;
      e.preventDefault();               // this drag sweeps the strip, never pans the page
      moved = true;
      panTo(t.clientX);
    }, { passive: false });
    strip.addEventListener('touchend', end, { passive: true });
    strip.addEventListener('touchcancel', end, { passive: true });
    // ---- mouse: click-drag sweeps the strip on desktop too (the list LOOKS grabbable; make it be)
    strip.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      if (skip && (e.target as Element | null)?.closest(skip)) return;
      start(e.clientX, e.clientY, 'mouse');
      // NOTE: pointer capture is taken in pointermove, ONCE the gesture reads as a drag. Capturing
      // here would retarget the click that follows a plain press to the strip, and a card could
      // never be selected with a mouse again.
    });
    strip.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      // A swipe exists ONLY while the press owns it. Without the primary button down there is no
      // gesture — a plain hover used to re-pan the strip with stale start coordinates, which read
      // as "it keeps dragging after I release". If the button vanished without a pointerup (a
      // release outside the window swallowed the up), end the latched gesture instead.
      if ((e.buttons & 1) === 0) {
        if (kind === 'mouse') end();
        return;
      }
      if (kind !== 'mouse') return;
      if (!panning(e.clientX, e.clientY)) return;
      if (!moved) {
        moved = true;
        strip.classList.add('dragging');
        try {
          strip.setPointerCapture(e.pointerId);
        } catch {
          /* capture is best-effort (older engines) — dragging still works without it */
        }
      }
      e.preventDefault();
      panTo(e.clientX);
    });
    const mouseEnd = (e: PointerEvent): void => {
      if (e.pointerType !== 'mouse') return;
      try {
        strip.releasePointerCapture(e.pointerId);
      } catch {
        /* released with the pointer already gone */
      }
      end();
    };
    strip.addEventListener('pointerup', mouseEnd);
    strip.addEventListener('pointercancel', mouseEnd);
    // ---- wheel: a vertical wheel over a sideways-only strip scrolls the strip (desktop habit).
    // It listens on the WHEEL HOST (the whole screen where one is given), so hovering a gap
    // between the cards — or the air around the list — scrolls it just the same.
    (wheelHost ?? strip).addEventListener('wheel', e => {
      if (strip.scrollWidth <= strip.clientWidth + 1) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      e.preventDefault();
      stopFling();
      strip.scrollLeft += d;
    }, { passive: false });
    // swallow the click a sweep would otherwise land on the card it stopped over
    strip.addEventListener('click', e => {
      if (!strip.dataset.dragged) return;
      delete strip.dataset.dragged;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }

  // ------------------------------------------------------------ menus

  private buildMenu(): void {
    const s = el('div', 'screen');
    s.appendChild(el('div', 'menu-title', 'NECROFALL'));
    s.appendChild(el('div', 'menu-sub', 'Dive \u2022 Liberate \u2022 Dominate'));
    // `menu-main`: on a short viewport (a landscape phone) this column becomes a 2x2 grid with the
    // graphics row spanning both cells — the four entries fit above the fold instead of pushing the
    // title off the top of the screen (see the `max-height` block in styles.css).
    const col = el('div', 'menu-col menu-main');
    col.appendChild(button('PLAY', 'btn primary', () => this.show('play')));
    col.appendChild(button('CUSTOMIZE', 'btn', () => this.show('customize')));
    col.appendChild(button('HOW TO PLAY', 'btn', () => this.show('howto')));
    col.appendChild(button('CONTROLS', 'btn', () => this.show('controls')));

    // ---- graphics level: the choice is remembered and applied the moment it is made
    const row = el('div', 'graphics-row');
    row.appendChild(el('div', 'graphics-label', 'GRAPHICS'));
    const opts = el('div', 'graphics-opts');
    for (const pref of QUALITY_PREFS) {
      const b = button(QUALITY_LABELS[pref], 'opt', () => this.cbs.setGraphics(pref));
      b.title = QUALITY_BLURBS[pref];
      opts.appendChild(b);
      this.graphicsOpts.set(pref, b);
    }
    row.appendChild(opts);
    this.graphicsNote = el('div', 'graphics-note', '');
    row.appendChild(this.graphicsNote);
    col.appendChild(row);

    s.appendChild(col);
    const foot = el('div', 'muted menu-foot', '');
    foot.style.marginTop = '26px';
    foot.style.fontSize = '11px';
    foot.style.letterSpacing = '0.2em';
    foot.textContent = 'P2P MULTIPLAYER • 3 COLONIES • 5 TOWERS';
    s.appendChild(foot);
    this.reg('menu', s);
    // Reflect whatever is already saved, before the player touches anything.
    const saved = loadQualityPref();
    this.setGraphicsPref(saved, resolveQuality(saved));
  }

  /** Highlights the active graphics level and explains what it does on this device. */
  setGraphicsPref(pref: QualityPref, resolved: QualityName): void {
    this.graphicsPref = pref;
    for (const [key, btn] of this.graphicsOpts) btn.classList.toggle('active', key === pref);
    if (!this.graphicsNote) return;
    this.graphicsNote.textContent = pref === 'auto'
      ? `${QUALITY_BLURBS.auto} This device runs ${resolved.toUpperCase()}.`
      : QUALITY_BLURBS[pref] + (pref === 'high' ? ' Smoothing applies after a reload.' : '');
  }

  /** Necrotech idx for the current loadout, or -1 for a fusion (mutated) loadout. */
  private necrotechIconIdx(nameStr: string): number {
    const at = NECROTECHS.findIndex(nt => nt.name === nameStr);
    return at;
  }

  /** One icon + title + single-line explanation card used by the HOW TO PLAY screen. */
  private howtoCard(icon: string, title: string, desc: string, wide = false): HTMLElement {
    const card = el('div', wide ? 'howto-card wide' : 'howto-card');
    card.appendChild(el('div', 'howto-ico', icon));
    const txt = el('div', 'howto-txt');
    txt.appendChild(el('div', 'howto-t', title));
    txt.appendChild(el('div', 'howto-d', desc));
    card.appendChild(txt);
    return card;
  }

  private buildHowTo(): void {
    const s = el('div', 'screen');
    const panel = el('div', 'panel');
    panel.appendChild(el('div', 'panel-title', 'HOW TO PLAY'));
    panel.appendChild(el(
      'p',
      'howto-lede',
      'Capture all four Beacon Towers to break the Nexus shield, then take the Nexus. Whoever controls the Nexus owns the planet.'
    ));

    const grid = el('div', 'howto-grid');
    grid.appendChild(this.howtoCard(WIN_ICON, 'Win the match', 'Control the Nexus when the 10:00 Necrorad expires — or take it first. If nobody takes it, the Necrophages keep the planet.'));
    grid.appendChild(this.howtoCard(BEACON_ICON, 'All 4 Beacons are the key', 'Every Beacon in any colony\u2019s hands breaks the Nexus seal \u2014 no majority needed.'));
    grid.appendChild(this.howtoCard(CAPTURE_ICON, 'Capture', 'Stand in the ring. The colony with the most players inside takes the tower.'));
    grid.appendChild(this.howtoCard(BOSS_ICON, 'Boss guards it', 'Kill the tower\u2019s boss before the tower can be captured.'));
    grid.appendChild(this.howtoCard(NEXUS_ICON, 'Finish the Nexus', 'Kill its Overseer to drop the shield, then capture it (10s) to end the match.'));
    grid.appendChild(this.howtoCard(OVERDRIVE_ICON, 'Press F in your towers', 'COLONY OVERDRIVE: doubled stats for 30s. Your tower\u2019s shield then drops.'));
    grid.appendChild(this.howtoCard(AUTO_ATTACK_ICON, 'Your gun is automatic', 'It fires at anything in range. You only steer Skill and Ultimate.'));
    grid.appendChild(this.howtoCard(LEVEL_ICON, 'Level up', 'Kills give XP. Each level, pick 1 of 3 perks.'));
    grid.appendChild(this.howtoCard(NECROTECH_ICON, 'Loot Necrotech', 'Bosses drop it. KEEP, SWAP or MUTATE \u2014 two fused classes are a PERMUTATION; fill all three slots and they form a TRIPLE.', true));
    panel.appendChild(grid);

    panel.appendChild(el('h3', '', 'Colonies'));
    const strip = el('div', 'howto-colonies');
    for (const c of COLONIES) {
      const chip = el('div', 'howto-colony');
      chip.style.color = c.css;
      chip.appendChild(el('div', 'n', `${c.symbol} ${c.name}`));
      chip.appendChild(el('div', 'd', c.desc));
      strip.appendChild(chip);
    }
    panel.appendChild(strip);

    const note = el('div', 'howto-note');
    note.innerHTML = IS_TOUCH
      ? 'Left stick moves \u2022 right pad aims \u2022 buttons jump, dash, Skill and Ultimate.'
      : 'Move <span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span> \u2022 Jump <span class="kbd">SPACE</span> \u2022 Dash <span class="kbd">SHIFT</span> \u2022 Skill <span class="kbd">LMB</span> / <span class="kbd">E</span> (hold to aim) \u2022 Ultimate <span class="kbd">RMB</span> / <span class="kbd">Q</span> (hold to aim) \u2022 Beacon <span class="kbd">F</span>';
    panel.appendChild(note);

    const row = el('div', 'howto-actions');
    row.appendChild(button('CONTROLS', 'btn primary', () => this.show('controls')));
    panel.appendChild(row);
    s.appendChild(panel);
    this.addBack(s, 'Back to the main menu', () => this.show('menu'));
    this.reg('howto', s);
  }

  private buildControls(): void {
    const s = el('div', 'screen');
    const panel = el('div', 'panel');
    panel.appendChild(el('div', 'panel-title', 'CONTROLS'));
    panel.innerHTML += `
      <h3>Desktop</h3>
      <p><span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span> Move (momentum-based)</p>
      <p><span class="kbd">SPACE</span> Jump</p>
      <p><span class="kbd">SHIFT</span> Dash — 3 charges, brief invulnerability, charges recharge over time</p>
      <p><span class="kbd">LEFT CLICK</span> or <span class="kbd">E</span> — Skill. Hold the button to aim: the ground marker shows the exact lane, cone or blast, release to fire.</p>
      <p><span class="kbd">RIGHT CLICK</span> or <span class="kbd">Q</span> — Ultimate. Same hold-to-aim gesture; the marker turns into the Ultimate's footprint.</p>
      <p><span class="kbd">F</span> Activate owned Beacon ability while inside its shield</p>
      <p><span class="kbd">ARROWS</span> Aim with the keyboard — takes over from the cursor and points the Skill / Ultimate</p>
      <p><b>Mouse cursor</b> — the default way to set the Skill / Ultimate direction</p>
      <p class="accent2"><b>Ground markers</b> — a lane for skillshots, a fan for cones and a ringed disc for aimed blasts. The size is the real reach: what you see is what gets hit.</p>
      <h3>Important</h3>
      <p class="accent2"><b>Mouse movement never rotates the camera.</b> The camera follows your momentum automatically and is always aligned to the planet surface.</p>
      <h3>Mobile</h3>
      <p>Left virtual stick moves. Buttons: Jump, Dash, Skill, Ultimate. Use the aim pad (right side) to point abilities — it supports multi-touch, so you can move, dash and fire at the same time.</p>
    `;
    s.appendChild(panel);
    this.addBack(s, 'Back to the main menu', () => this.show('menu'));
    this.reg('controls', s);
  }

  private buildPlay(): void {
    // PLAY is a FIXED screen: the title is its header (pinned to the top) and the format cards
    // fill every pixel under it. It never grows a scrollbar — the layout IS the viewport.
    const s = el('div', 'screen play-screen');
    const head = el('div', 'play-head');
    head.appendChild(el('div', 'menu-title', 'PLAY'));
    head.appendChild(el('div', 'menu-sub', 'choose your match format'));
    s.appendChild(head);
    const col = el('div', 'menu-col play-col');

    // ---- the format: CLASSIC is the live game; RANK is on the board but locked. The choice comes
    // before any lobby controls, so nobody is thrown into creating a room before picking a mode.
    const modes = el('div', 'play-modes');
    this.classicCard = el('div', 'mode-card');
    this.classicCard.setAttribute('role', 'button');
    this.classicCard.setAttribute('tabindex', '0');
    this.classicCard.setAttribute('aria-label', 'Classic — host or join a lobby');
    this.classicCard.innerHTML =
      `<div class="mode-ico">${ICON_SWORDS}</div>` +
      '<div class="mode-name">CLASSIC</div>' +
      '<div class="mode-desc">Host or join a peer-to-peer lobby. Up to 9 survivors, 3v3v3.</div>' +
      '<div class="mode-tag">PLAY NOW</div>';
    this.classicCard.addEventListener('click', () => this.pickPlayMode('classic'));
    this.classicCard.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) this.pickPlayMode('classic');
    });
    modes.appendChild(this.classicCard);

    const rank = el('div', 'mode-card locked');
    rank.setAttribute('aria-disabled', 'true');
    rank.innerHTML =
      `<div class="mode-ico">${ICON_LADDER}</div>` +
      '<div class="mode-name">RANK</div>' +
      '<div class="mode-desc">Climb the ladder against matched opponents.</div>' +
      '<div class="mode-badge">COMING SOON</div>';
    rank.addEventListener('click', () => {
      this.flashAnim(rank, 'shake');
      this.toast('Ranked matches are coming soon', 1800);
    });
    modes.appendChild(rank);
    col.appendChild(modes);

    // Room feedback ("Creating lobby…", "Rejoining room …") lands here while the classic entry is
    // still folded away — the entry itself never opens on its own.
    this.playNote = el('div', 'muted play-note', '');
    col.appendChild(this.playNote);

    // ---- the classic entry, revealed by picking CLASSIC: host a room or join one by code
    const enter = el('div', 'play-enter');
    this.playEnter = enter;

    // ---- survivor name: editable right here, saved locally for next time
    const nameRow = el('div', 'menu-name');
    const nameInput = el('input', 'menu-input') as HTMLInputElement;
    this.playNameInput = nameInput;
    nameInput.value = this.name;
    nameInput.maxLength = 16;
    nameInput.placeholder = 'YOUR NAME';
    nameInput.spellcheck = false;
    nameInput.autocomplete = 'off';
    nameInput.addEventListener('input', () => this.rememberName(nameInput.value));
    nameInput.addEventListener('change', () => {
      this.rememberName(nameInput.value);
      nameInput.value = this.name;
    });
    nameRow.appendChild(el('span', 'menu-name-label', 'LIBERATOR NAME'));
    nameRow.appendChild(nameInput);
    enter.appendChild(nameRow);

    enter.appendChild(button('CREATE LOBBY', 'btn primary', () => this.cbs.createLobby(this.name)));
    const joinRow = el('div', 'flex');
    joinRow.style.gap = '8px';
    this.joinInput = el('input', '') as HTMLInputElement;
    this.joinInput.placeholder = 'LOBBY CODE';
    this.joinInput.maxLength = 6;
    this.joinInput.style.cssText =
      'flex:1;padding:clamp(8px,1.8vh,12px);background:rgba(20,14,32,.9);border:1px solid rgba(150,110,255,.35);border-radius:4px;color:#efe7ff;font-size:16px;letter-spacing:.3em;text-transform:uppercase;text-align:center;';
    const joinBtn = button('JOIN', 'btn primary', () => this.cbs.joinLobby(this.joinInput.value.trim().toUpperCase(), this.name));
    joinRow.appendChild(this.joinInput);
    joinRow.appendChild(joinBtn);
    enter.appendChild(joinRow);
    this.playStatus = el('div', 'muted', '');
    this.playStatus.style.cssText = 'font-size:12px;text-align:center;min-height:18px;';
    enter.appendChild(this.playStatus);
    col.appendChild(enter);

    s.appendChild(col);
    this.playScreen = s;
    // The fixed menu screens cannot scroll, so a soft keyboard would simply cover the join field —
    // see `bindSoftKeyboard` for the visual-viewport pan that fixes it.
    this.bindSoftKeyboard(s, [nameInput, this.joinInput]);
    this.addBack(s, 'Back to the main menu', () => this.show('menu'));
    this.reg('play', s);
  }

  /**
   * Soft-keyboard guard for the fixed menu screens (the lobby-code field, in practice).
   *
   * These screens are `overflow: hidden` full-viewport layouts: when a phone opens its keyboard
   * there is nothing to scroll, so nothing moves the focused field out from under the keys and the
   * player types blind (on Chrome/Android the field only "jumps" once typing starts, and on some
   * builds not at all). The fix is a VISUAL-VIEWPORT pan done by hand: while one of `fields` is
   * focused, measure how far its bottom edge pokes past the visible area above the keyboard and
   * lift the whole column by that much (`--kb-shift`, applied by `.play-col` in the stylesheet).
   * `visualViewport` is the only API that reports the keyboard-shrunk height — a plain
   * `window.innerHeight` does not move on Android.
   *
   * The measurement subtracts the shift currently in effect, so repeated calls (the keyboard
   * slides in with a burst of resize events) converge instead of compounding, and blur returns the
   * column to its resting place.
   */
  private bindSoftKeyboard(screen: HTMLElement, fields: HTMLInputElement[]): void {
    const vv = window.visualViewport;
    let shift = 0;
    const apply = (): void => {
      const focused = document.activeElement;
      if (!(focused instanceof HTMLInputElement) || fields.indexOf(focused) < 0) {
        if (shift !== 0) {
          shift = 0;
          screen.style.setProperty('--kb-shift', '0px');
        }
        return;
      }
      const vpBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      const rect = focused.getBoundingClientRect();
      // Where the field sits WITHOUT the pan: the transform has already lifted it by `shift`, so
      // the raw rect reads `shift` higher than the resting position. (Subtracting instead of adding
      // here made each re-measure "prove" the pan was no longer needed and snap back to zero.)
      const natural = rect.bottom + shift;
      const next = Math.max(0, Math.round(natural + 16 - vpBottom));
      if (next !== shift) {
        shift = next;
        screen.style.setProperty('--kb-shift', `${shift}px`);
      }
    };
    // the keyboard animates in over ~200-300 ms: re-measure across it, and once more after
    for (const f of fields) {
      f.addEventListener('focus', () => {
        apply();
        window.setTimeout(apply, 120);
        window.setTimeout(apply, 420);
      });
      f.addEventListener('blur', apply);
    }
    if (vv) {
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
    }
    window.addEventListener('resize', apply);
  }

  /**
   * Picks a match format on the PLAY screen. Only CLASSIC enters anything — RANK is deliberately a
   * dead end until it exists. The entry panel is revealed rather than the screen swapped, so the
   * player can see what they picked (and change it after coming back).
   */
  private pickPlayMode(mode: 'classic'): void {
    if (this.playMode === mode) return;
    this.playMode = mode;
    this.playScreen.classList.add('mode-picked');
    this.classicCard.classList.add('sel');
    // a short confirm pop on the chosen card; the entry drops in on the same beat (its reveal is
    // pure CSS now — see `.screen.mode-picked .play-enter`). Nothing scrolls: the screen is a
    // fixed layout, so the entry is always on screen the instant it appears.
    this.flashAnim(this.classicCard, 'picked');
  }

  /**
   * Plays a one-shot CSS animation class: remove it, force a reflow (re-adding without one is a
   * no-op) and add it again, then clear it when the animation ends so it can be replayed. The event
   * check matters — `animationend` bubbles, and a descendant's animation must not clear this class.
   */
  private flashAnim(target: HTMLElement, cls: string): void {
    target.classList.remove(cls);
    void target.offsetWidth;
    target.classList.add(cls);
    const onEnd = (e: AnimationEvent): void => {
      if (e.target !== target) return;
      target.classList.remove(cls);
      target.removeEventListener('animationend', onEnd);
    };
    target.addEventListener('animationend', onEnd);
  }

  /**
   * Folds the classic entry away and clears the format choice. Called on every fresh entry to the
   * PLAY screen (see show()): the selection is scoped to ONE visit, not remembered.
   */
  private resetPlayMode(): void {
    this.playMode = null;
    this.playScreen.classList.remove('mode-picked');
    this.classicCard.classList.remove('sel');
    // a stale "rejoining room…" would be a lie on a screen the player just walked back into
    this.setPlayStatus('');
  }

  setPlayStatus(text: string, danger = false): void {
    // The status belongs to the classic entry — but an incoming status must NEVER open that panel
    // on its own (the player asked to see the format choice first), so while it is still folded
    // away the same line is mirrored onto the note under the cards.
    this.playStatus.textContent = text;
    this.playStatus.className = danger ? 'danger' : 'muted';
    this.playNote.textContent = text;
    this.playNote.className = danger ? 'danger play-note' : 'muted play-note';
  }

  /** `?lobby=CODE` deep link support. */
  prefillLobby(code: string): void {
    this.joinInput.value = code;
    this.show('play');
    this.pickPlayMode('classic');
    this.setPlayStatus('Lobby code filled in — press JOIN, or CREATE LOBBY for your own match.');
  }

  // ------------------------------------------------------------ lobby

  private buildLobby(): void {
    const s = el('div', 'screen lobby-screen');

    // ---- header: pinned at the TOP of the screen — the LOBBY title wears the same dress as the
    // NECROFALL wordmark (`.menu-title` gradient), with the format chip riding beside it.
    // The panel below is a fixed-height stack (code row → line-up → actions) that always fits the
    // viewport: a lobby never scrolls vertically, only the seat track scrolls sideways.
    const head = el('div', 'lobby-head');
    head.appendChild(el('div', 'menu-title lobby-title', 'LOBBY'));
    head.appendChild(el('span', 'lobby-mode', 'CLASSIC'));
    s.appendChild(head);

    // No `.panel` slab: the roster stands on the screen's own backdrop, on a lit stage (see the
    // `.lobby-*` styles) — a champion line-up, not a dialog box.
    const panel = el('div', 'lobby-panel');

    // ---- the room code is CHROME, not content: small, top-right, with the copy / share glyphs in
    // reach beside it. (It used to be a giant centred number on a panel slab — the hero of the
    // screen — which ate the roster's height and read like an input field.)
    // Read order is [SHARE][COPY][CODE] on ONE line; the "up to N survivors" caption is a line
    // under the whole row.
    const codebar = el('div', 'lobby-codebar');
    const copyBtn = button(ICON_COPY, 'lobby-icon', () => {
      void navigator.clipboard?.writeText(this.lobbyCode.textContent ?? '');
      this.toast('Lobby code copied', 1400);
    });
    copyBtn.type = 'button';
    copyBtn.title = 'Copy the lobby code';
    copyBtn.setAttribute('aria-label', 'Copy the lobby code');
    const shareBtn = button(ICON_SHARE, 'lobby-icon', () => {
      const code = this.lobbyCode.textContent ?? '';
      const url = `${location.origin}${location.pathname}?lobby=${code}`;
      const nav = navigator as Navigator & { share?: (data: { title: string; text: string; url: string }) => Promise<void> };
      if (nav.share) {
        void nav.share({ title: 'NECROFALL', text: `Join my Necrofall match: ${code}`, url });
      } else {
        void navigator.clipboard?.writeText(url);
        this.toast('Invite link copied', 1600);
      }
    });
    shareBtn.type = 'button';
    shareBtn.title = 'Share an invite link';
    shareBtn.setAttribute('aria-label', 'Share an invite link');
    const codeRow = el('div', 'lobby-coderow');
    this.lobbyCode = el('div', 'lobby-code', '-----');
    codeRow.append(shareBtn, copyBtn, this.lobbyCode);
    codebar.appendChild(codeRow);
    codebar.appendChild(el('div', 'lobby-codecap', `UP TO ${CONFIG.maxPlayers} SURVIVORS · ${CONFIG.maxPerColony} PER COLONY`));
    s.appendChild(codebar);

    // ---- the line-up. Avatar i and seat card i share one slot width in ONE scrolling track, so
    // every avatar stands exactly above its own card (SelectionPreview lays the row out in the same
    // (i + 0.5) / n rhythm), and the whole scene scrolls together on a narrow screen.
    this.lobbyLineup = el('div', 'lobby-lineup');
    const track = el('div', 'lobby-track');
    this.lobbyTrack = track;
    // seats are swept with the thumb or a held mouse button; a drag that starts on the 3D rail is a
    // turntable spin instead, and the wheel scrolls the roster from anywhere on the screen
    this.attachDragScroll(track, '.lobby-rail', s);
    this.lobbyTrackInner = el('div', 'lobby-track-inner');
    this.lobbyRail = el('div', 'sel-preview lobby-rail');
    this.lobbySeats = el('div', 'lobby-seats');
    this.lobbyTrackInner.appendChild(this.lobbyRail);
    this.lobbyTrackInner.appendChild(this.lobbySeats);
    track.appendChild(this.lobbyTrackInner);
    this.lobbyLineup.appendChild(track);
    panel.appendChild(this.lobbyLineup);

    this.lobbyHint = el('div', 'muted lobby-hint', '');
    panel.appendChild(this.lobbyHint);

    const actions = el('div', 'lobby-actions');
    this.lobbyReady = button('READY', 'btn', () => this.cbs.toggleReady());
    this.lobbyStart = button('START MATCH', 'btn primary', () => this.cbs.startMatch());
    const leave = button('LEAVE', 'btn ghost', () => this.cbs.leaveRoom());
    actions.appendChild(this.lobbyReady);
    actions.appendChild(leave);
    actions.appendChild(this.lobbyStart);
    panel.appendChild(actions);
    s.appendChild(panel);
    this.addBack(s, 'Leave the lobby', () => this.cbs.leaveRoom());
    this.reg('lobby', s);
  }

  updateLobby(
    code: string,
    players: { id: string; name: string; ready: boolean; colony: number; nt: number; isHost: boolean; me: boolean; acc?: string }[],
    isHost: boolean,
    status: string,
    canStart = true
  ): void {
    this.lobbyCode.textContent = code || '-----';

    // ---- the avatar rail: one dressed figure per seat, in the same order as the seat cards
    this.lobbyAvatars = players.map(p => ({ id: p.id, colony: p.colony, ready: p.ready, me: p.me, acc: p.acc ?? '' }));
    this.refreshLobbyAvatars();
    this.lobbyLineup.classList.toggle('hidden', players.length === 0);
    if (players.length > 0) {
      // THREE seats always stand fully on screen (each at least a third of the track wide); any
      // seats past that extend the track and are reached by scrolling it SIDEWAYS — a roster of
      // nine keeps its roomy cards instead of crushing nine seats into the width.
      const w = this.lobbyTrack.clientWidth || 700;
      const seatMin = Math.max(146, Math.floor(w / 3));
      this.lobbyTrackInner.style.width = `max(100%, ${players.length * seatMin}px)`;
    }

    // ---- the seat cards under the avatars
    this.lobbySeats.innerHTML = '';
    for (const p of players) {
      const seat = el('div', 'seat');
      const card = el('div', `seat-card${p.me ? ' me' : ''}${p.ready ? ' ready' : ''}${p.isHost ? ' host' : ''}`);
      const col = p.colony >= 0 ? COLONIES[p.colony] : null;
      // each seat is TINTED with its player's colony colour (same vars the other cards use), so the
      // roster reads at a glance instead of being a wall of identical dark boxes
      if (col) tintCard(card, col.color, col.css);
      const name = el('div', 'seat-name', p.name);
      if (col) name.style.color = col.css;
      card.appendChild(name);
      const chips = el('div', 'seat-chips');
      if (col) {
        const chip = el('span', 'seat-chip colony', `${col.symbol} ${col.name}`);
        chip.style.color = col.css;
        chips.appendChild(chip);
      } else {
        chips.appendChild(el('span', 'seat-chip dim', 'NO COLONY'));
      }
      if (p.nt >= 0) chips.appendChild(el('span', 'seat-chip', NECROTECHS[p.nt] ? NECROTECHS[p.nt].name : 'MUTATED'));
      if (p.isHost) chips.appendChild(el('span', 'seat-chip host', 'HOST'));
      if (p.me) chips.appendChild(el('span', 'seat-chip you', 'YOU'));
      card.appendChild(chips);
      card.appendChild(el('div', 'seat-state', p.ready ? 'READY \u2713' : 'WAITING'));
      // The host runs the room: it can remove anyone but itself, straight from the seat card.
      if (isHost && !p.me) {
        const kick = button('\u2715', 'seat-kick', () => this.cbs.kickPlayer(p.id));
        kick.title = `Remove ${p.name} from the lobby`;
        kick.setAttribute('aria-label', `Remove ${p.name} from the lobby`);
        card.appendChild(kick);
      }
      seat.appendChild(card);
      this.lobbySeats.appendChild(seat);
    }

    const me = players.find(p => p.me);
    this.lobbyStart.classList.toggle('hidden', !isHost);
    // START is gated on EVERY seat being ready — no jumping the gun on a player still reading.
    this.lobbyStart.disabled = isHost && !canStart;
    this.lobbyStart.textContent = canStart ? 'START MATCH' : 'WAITING FOR READY…';
    this.lobbyReady.classList.toggle('hidden', isHost);
    this.lobbyReady.textContent = me?.ready ? 'READY \u2713' : 'READY';
    this.lobbyReady.classList.toggle('on', !!me?.ready);
    this.lobbyHint.textContent = status;
  }

  /** Pushes the roster into the 3D rail (a no-op while the preview is on another screen). */
  private refreshLobbyAvatars(): void {
    this.preview?.setLobbyAvatars(this.lobbyAvatars);
  }

  // ------------------------------------------------------------ colony select

  private buildColonySelect(): void {
    // `scroll`: on a landscape phone the three colony cards cannot fit under the champion preview,
    // and a centred screen with `overflow: hidden` used to cut the top card clean off the frame.
    // `colony-screen` is the hook the TOUCH stylesheet uses to make the screen fit a phone without
    // any scrolling at all (see styles.mobile.css).
    const s = el('div', 'screen scroll colony-screen');
    const head = el('div', 'sel-head');
    head.appendChild(el('div', 'sel-title', 'SELECT COLONY'));
    this.colonyTimer = el('div', 'sel-timer', '5');
    head.appendChild(this.colonyTimer);
    this.colonySub = el('div', 'sel-sub', '');
    head.appendChild(this.colonySub);
    s.appendChild(head);
    // the champions, live: each colony's figure in its own colours doing its own pose
    this.colonyPreviewBox = el('div', 'sel-preview');
    this.colonyPreviewBox.addEventListener('pointerleave', () => {
      this.colonyHover = -1;
      this.preview?.setFocus(Math.max(0, this.colonyPick));
    });
    s.appendChild(this.colonyPreviewBox);
    const cards = el('div', 'cards');
    COLONIES.forEach((c, idx) => {
      const card = el('div', 'card');
      tintCard(card, c.color, c.css);
      // ---- crest: the colony's symbol inside a lit ring, above the name
      const crest = el('div', 'colony-crest');
      const sym = el('div', 'colony-sym', c.symbol);
      sym.style.color = c.css;
      crest.appendChild(sym);
      card.appendChild(crest);
      const h = el('h4', '', c.name);
      h.style.color = c.css;
      card.appendChild(h);
      card.appendChild(el('div', 'desc', c.desc));
      // ---- bonuses as a row list: each line gets its own row and an up/down arrow
      const bonus = el('div', 'bonus');
      bonus.innerHTML = c.bonus
        .map(b => {
          const neg = b.trim().startsWith('-');
          const text = b.trim().replace(/^[+\-\s]+/, '').trim();
          return `<span class="bonus-row ${neg ? 'neg' : 'pos'}"><i>${neg ? '▼' : '▲'}</i>${text}</span>`;
        })
        .join('');
      card.appendChild(bonus);
      // ---- how many seats are taken, as a corner badge, and what this card is doing right now
      const count = el('div', 'count-badge');
      count.style.color = c.css;
      card.appendChild(count);
      card.appendChild(el('div', 'pick-tag', 'SELECTED'));
      card.classList.add('colony-card');
      card.addEventListener('click', () => this.onColonyClick(idx));
      card.addEventListener('pointerenter', () => {
        this.colonyHover = idx;
        this.preview?.setFocus(idx);
      });
      cards.appendChild(card);
      this.colonyCards.push({ card, count });
    });
    s.appendChild(cards);
    this.reg('colony', s);
  }

  onColonyClick: (idx: number) => void = () => undefined;

  updateColonySelect(timer: number, counts: number[], myColony: number, selected: number, total: number, late = false): void {
    this.colonyTimer.textContent = Math.max(0, Math.ceil(timer)).toString();
    this.colonySub.textContent = late
      ? 'DROPPING INTO A LIVE MATCH — PICK YOUR COLONY'
      : `${selected} / ${total} PLAYERS SELECTED — FULL COLONIES ARE LOCKED`;
    if (myColony !== this.colonyPick) {
      this.colonyPick = myColony;
      this.preview?.setSelected(myColony);
      if (this.colonyHover < 0) this.preview?.setFocus(Math.max(0, myColony));
    }
    this.colonyCards.forEach((c, idx) => {
      const full = counts[idx] >= CONFIG.maxPerColony;
      c.count.innerHTML = `${counts[idx]}<span> / ${CONFIG.maxPerColony}</span>`;
      c.card.classList.toggle('sel', myColony === idx);
      c.card.classList.toggle('full', full && myColony !== idx);
      c.card.classList.toggle('has-room', !full);
    });
  }

  // ------------------------------------------------------------ necrotech select

  private buildNecrotechSelect(): void {
    // Fixed screen: the class list is ONE HORIZONTAL strip — the cards scroll sideways, the page
    // never scrolls down, so the timer, the weapon stage and the choice always share one screen.
    const s = el('div', 'screen nt-screen');
    this.ntScreen = s;
    const head = el('div', 'sel-head');
    head.appendChild(el('div', 'sel-title', 'SELECT NECROTECH'));
    this.ntTimer = el('div', 'sel-timer', '10');
    head.appendChild(this.ntTimer);
    this.ntSub = el('div', 'sel-sub', '');
    head.appendChild(this.ntSub);
    s.appendChild(head);
    // the class's weapon, live: the model on the stand changes as the pointer moves
    this.ntPreviewBox = el('div', 'sel-preview');
    this.ntPreviewBox.addEventListener('pointerleave', () => {
      this.ntHover = -1;
      this.preview?.showWeapon(Math.max(0, this.ntPick));
    });
    s.appendChild(this.ntPreviewBox);
    const grid = el('div', 'nt-grid');
    // the class list is swept with the thumb or a held mouse button, and the wheel scrolls it from
    // ANYWHERE on the screen — hovering a gap between cards must not be a dead spot
    this.attachDragScroll(grid, undefined, s);
    NECROTECHS.forEach((nt, idx) => {
      const card = el('div', 'nt-card');
      const color = `#${nt.stats.color.toString(16).padStart(6, '0')}`;
      tintCard(card, nt.stats.color, color);
      // ---- header: the class icon in a lit ring, its name and role, and the picked stamp
      const head = el('div', 'nt-head');
      const icon = el('div', 'nt-icon');
      icon.style.color = color;
      icon.innerHTML = iconFor(nt);
      head.appendChild(icon);
      const nameCol = el('div', 'nt-name');
      nameCol.appendChild(el('h4', '', nt.name));
      nameCol.appendChild(el('span', 'role', nt.role.toUpperCase()));
      head.appendChild(nameCol);
      head.appendChild(el('div', 'nt-pick', 'LOCKED IN'));
      card.appendChild(head);
      // ---- the numbers as three chips, so they read at a glance instead of as one line
      const stats = el('div', 'nt-stats');
      stats.innerHTML =
        `<span><i>DMG</i>${nt.stats.damage}</span>` +
        `<span><i>RATE</i>${nt.stats.rate}/s</span>` +
        `<span><i>RANGE</i>${nt.stats.range}</span>`;
      card.appendChild(stats);
      // ---- one block per ability: tag + name on the first line, the text underneath
      const ability = (cls: string, tag: string, name: string, desc: string): HTMLElement => {
        const row = el('div', `row ${cls}`);
        row.innerHTML = `<span class="tag ${cls}">${tag}</span><b>${name}</b><p>${desc}</p>`;
        return row;
      };
      const rows = el('div', 'nt-rows');
      rows.appendChild(ability('skill', 'SKILL', nt.skill.name, nt.skill.desc));
      rows.appendChild(ability('ult', 'ULT', nt.ult.name, nt.ult.desc));
      rows.appendChild(ability('pass', 'PASSIVE', nt.passiveName, nt.passiveDesc));
      card.appendChild(rows);
      card.addEventListener('click', () => {
        // A long-press INSPECT owns its release: closing the overlay is the whole tap, it never
        // locks the class in (same contract as the HUD's ability tooltip).
        if (card.dataset.inspect === '1') {
          delete card.dataset.inspect;
          return;
        }
        this.closeNtExpand();
        this.onNecrotechClick(idx);
      });
      card.addEventListener('pointerenter', (e) => {
        this.ntHover = idx;
        this.preview?.showWeapon(idx);
        // Desktop: the details expand on HOVER (the card itself stays the simple version).
        if ((e as PointerEvent).pointerType === 'mouse') this.openNtExpand(idx, card);
      });
      card.addEventListener('pointerleave', (e) => {
        if ((e as PointerEvent).pointerType === 'mouse') this.closeNtExpand();
      });
      // Touch: a 420 ms press WITHOUT drag opens the details. Movement past a thumb's wobble
      // cancels it — a sweep across the strip is a roster scroll, never an inspect.
      let px = 0;
      let py = 0;
      card.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') return;
        px = e.clientX;
        py = e.clientY;
        window.clearTimeout(this.ntExpandTimer);
        this.ntExpandTimer = window.setTimeout(() => {
          card.dataset.inspect = '1';
          this.openNtExpand(idx, card);
        }, 420);
      });
      card.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'touch' || card.dataset.inspect === '1') return;
        if (Math.abs(e.clientX - px) + Math.abs(e.clientY - py) > 12) window.clearTimeout(this.ntExpandTimer);
      });
      card.addEventListener('pointerup', () => window.clearTimeout(this.ntExpandTimer));
      card.addEventListener('pointercancel', () => window.clearTimeout(this.ntExpandTimer));
      grid.appendChild(card);
      this.ntCards.push(card);
    });
    s.appendChild(grid);
    // The necrotech details overlay (see `openNtExpand`): a child of the SCREEN, never of the
    // scroll strip — the strip clips its overflow, and this panel must expand UPWARDS out of it.
    this.ntExpand = el('div', 'nt-expand');
    s.appendChild(this.ntExpand);
    // sweeping the roster is not reading it: any strip movement closes the open details
    grid.addEventListener('scroll', () => this.closeNtExpand());
    // tapping the empty screen (not a card, not the open details) dismisses the details
    s.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement | null;
      if (!t || (!t.closest('.nt-card') && !t.closest('.nt-expand'))) this.closeNtExpand();
    });
    this.reg('necrotech', s);
  }

  /**
   * Opens the full description of one necrotech card in the floating overlay.
   *
   * The class strip cards are deliberately SIMPLE on every device (icon, name, stat chips, the
   * ability NAMES): the paragraphs live only here. The panel is anchored to the card's own column
   * and grows UPWARDS over the weapon stage — it is absolutely positioned inside the screen, so
   * the strip and the page NEVER change height while it is open, and only one card's details can
   * exist at a time: opening another replaces the previous.
   */
  private openNtExpand(idx: number, card: HTMLElement): void {
    const nt = NECROTECHS[idx];
    if (!nt || !this.ntExpand || !this.ntScreen) return;
    // Re-opening the SAME card is a no-op only while its panel is actually up. A stale latch — the
    // card was hovered the instant the screen appeared under a parked cursor, before it had any
    // layout — used to block every later hover of that card and left an invisible panel latched at
    // the origin. If the overlay is not open, the request goes through and is re-measured.
    if (this.ntExpandIdx === idx && this.ntExpand.classList.contains('open')) return;
    // ...and a degenerate measurement (screen mid-show, width/height 0) is refused rather than
    // latched: the next hover re-measures for real.
    const sr = this.ntScreen.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    if (cr.width < 20 || cr.height < 20 || sr.width < 20 || sr.height < 20) {
      this.ntExpandIdx = -1;
      return;
    }
    this.ntExpandIdx = idx;
    const color = `#${nt.stats.color.toString(16).padStart(6, '0')}`;
    tintCard(this.ntExpand, nt.stats.color, color);
    // The same dressing as the card it belongs to, plus the ability texts underneath
    const head = el('div', 'nt-head');
    const icon = el('div', 'nt-icon');
    icon.style.color = color;
    icon.innerHTML = iconFor(nt);
    head.appendChild(icon);
    const nameCol = el('div', 'nt-name');
    nameCol.appendChild(el('h4', '', nt.name));
    nameCol.appendChild(el('span', 'role', nt.role.toUpperCase()));
    head.appendChild(nameCol);
    const stats = el('div', 'nt-stats');
    stats.innerHTML =
      `<span><i>DMG</i>${nt.stats.damage}</span>` +
      `<span><i>RATE</i>${nt.stats.rate}/s</span>` +
      `<span><i>RANGE</i>${nt.stats.range}</span>`;
    const rows = el('div', 'nt-rows');
    const ability = (cls: string, tag: string, name: string, desc: string): HTMLElement => {
      const row = el('div', `row ${cls}`);
      row.innerHTML = `<span class="tag ${cls}">${tag}</span><b>${name}</b><p>${desc}</p>`;
      return row;
    };
    rows.appendChild(ability('skill', 'SKILL', nt.skill.name, nt.skill.desc));
    rows.appendChild(ability('ult', 'ULT', nt.ult.name, nt.ult.desc));
    rows.appendChild(ability('pass', 'PASSIVE', nt.passiveName, nt.passiveDesc));
    this.ntExpand.replaceChildren(head, stats, rows);
    this.ntExpand.classList.add('open');
    // Geometry: same column as the card, bottom edge level with the card's bottom, growing up.
    // `maxHeight` is the room between the screen's top and that bottom edge, so the panel can
    // never push the layout — on tiny viewports it scrolls inside itself instead. (Measured at the
    // top of this method, before the content swap, so an early bail never builds anything.)
    this.ntExpand.style.width = `${Math.round(cr.width)}px`;
    this.ntExpand.style.left = `${Math.round(cr.left - sr.left)}px`;
    this.ntExpand.style.bottom = `${Math.round(sr.bottom - cr.bottom)}px`;
    this.ntExpand.style.maxHeight = `${Math.max(120, Math.round(cr.bottom - sr.top) - 8)}px`;
    card.classList.add('open');
  }

  /** Closes the necrotech details overlay (a no-op when none is open). */
  private closeNtExpand(): void {
    if (this.ntExpandIdx < 0) return;
    this.ntExpandIdx = -1;
    window.clearTimeout(this.ntExpandTimer);
    this.ntExpand?.classList.remove('open');
    for (const c of this.ntCards) c.classList.remove('open');
    for (const c of this.ntCards) delete c.dataset.inspect;
  }

  onNecrotechClick: (idx: number) => void = () => undefined;

  updateNecrotechSelect(timer: number, myNt: number, selected: number, total: number, late = false): void {
    this.ntTimer.textContent = Math.max(0, Math.ceil(timer)).toString();
    this.ntSub.textContent = late
      ? 'DROPPING INTO A LIVE MATCH — PICK YOUR NECROTECH'
      : `${selected} / ${total} PLAYERS LOCKED IN — MUTATIONS HAPPEN MID-MATCH`;
    this.ntCards.forEach((c, idx) => c.classList.toggle('sel', myNt === idx));
    if (myNt !== this.ntPick) {
      this.ntPick = myNt;
      if (this.ntHover < 0) this.preview?.showWeapon(Math.max(0, myNt));
    }
  }

  // ------------------------------------------------------------ customize

  /**
   * The customize screen: the live avatar wearing the saved outfit, the category tabs and the
   * catalog cards. Clicking a card equips it — there is NO try-on: the avatar only ever wears
   * what has actually been selected. The choice is saved in the browser and persists across
   * reloads. The title is the screen's header and RANDOMIZE rides at the top-right corner.
   */
  private buildCustomize(): void {
    const s = el('div', 'screen acc-screen');
    // The CUSTOMIZE title is the fixed header: centred, dressed in the same gradient as the PLAY
    // title (`.menu-title`), with no explainer line under it.
    const head = el('div', 'sel-head acc-head');
    head.appendChild(el('div', 'menu-title acc-title', 'CUSTOMIZE'));
    s.appendChild(head);

    // top-right: a bare glyph, no button pot — it is an action, not a panel
    const random = button(ICON_SHUFFLE, 'acc-random', () => this.randomizeAccessories());
    random.title = 'Randomize the whole outfit';
    random.setAttribute('aria-label', 'Randomize the whole outfit');
    s.appendChild(random);

    // Two columns: the avatar owns the left half at full height (it IS the screen), the catalog
    // list scrolls on the right. Narrow screens fold back into a stack.
    const layout = el('div', 'acc-layout');
    const left = el('div', 'acc-left');
    this.customizePreviewBox = el('div', 'sel-preview acc-preview');
    left.appendChild(this.customizePreviewBox);
    this.accCaption = el('div', 'acc-caption', '');
    left.appendChild(this.accCaption);
    layout.appendChild(left);

    const right = el('div', 'acc-right');
    const tabs = el('div', 'acc-tabs');
    for (const cat of CATEGORY_ORDER) {
      const b = button('', 'btn small acc-tab', () => this.setAccTab(cat));
      b.innerHTML = `${accTabIcon(cat)}<span>${CATEGORY_LABELS[cat]}</span>`;
      this.accTabs.set(cat, b);
      tabs.appendChild(b);
    }
    right.appendChild(tabs);

    this.accStrip = el('div', 'acc-strip');
    right.appendChild(this.accStrip);

    layout.appendChild(right);
    s.appendChild(layout);
    this.addBack(s, 'Back to the main menu', () => this.show('menu'), 'left');
    this.reg('customize', s);
    // no thumbnails yet: generating them is deferred until the screen is actually opened
    this.renderAccStrip(false);
  }

  private setAccTab(cat: AccessoryCategory): void {
    if (this.accTab === cat) return;
    this.accTab = cat;
    this.renderAccStrip();
    this.refreshCustomizePreview();
  }

  /** Rebuilds the category strip (tabs + cards) from the catalog and the worn selection. */
  private renderAccStrip(icons = true): void {
    for (const [cat, b] of this.accTabs) b.classList.toggle('active', cat === this.accTab);
    const defs = defsOf(this.accTab);
    this.accStrip.innerHTML = '';
    const worn = this.accSel[this.accTab];
    const mk = (idx: number, name: string, desc: string): void => {
      const card = el('div', idx === worn ? 'acc-card sel' : 'acc-card');
      // ---- the squircle: a real render of the item, so the list reads as a shelf of objects
      // instead of a wall of names (idx -1 = NONE, which has no model: an empty slot instead)
      const icon = el('div', idx < 0 ? 'acc-ico none' : 'acc-ico');
      if (idx >= 0 && icons) {
        const url = itemThumb(this.accTab, idx);
        if (url) {
          const img = el('img', 'acc-ico-img') as HTMLImageElement;
          img.src = url;
          img.alt = '';
          img.draggable = false;
          icon.appendChild(img);
        }
      }
      const main = el('div', 'acc-main');
      main.appendChild(el('div', 'acc-n', name));
      main.appendChild(el('div', 'acc-d', desc));
      if (idx === worn) main.appendChild(el('div', 'acc-tag', 'ACTIVE'));
      card.appendChild(icon);
      card.appendChild(main);
      // equip on press — no hover/touch try-on (the avatar only shows the SELECTED item)
      card.addEventListener('click', () => this.equipAccessory(this.accTab, idx));
      this.accStrip.appendChild(card);
    };
    mk(-1, 'NONE', 'Wear nothing in this slot.');
    // the list reads A→Z, but the INDICES stay the catalog's own: the wire format and the saved
    // selection are index/id based, so only the display order is sorted.
    defs
      .map((_d, i) => i)
      .sort((a, b) => defs[a].name.localeCompare(defs[b].name))
      .forEach(i => mk(i, defs[i].name, defs[i].desc));
    this.refreshAccCaption();
  }

  private equipAccessory(cat: AccessoryCategory, idx: number): void {
    if (this.accSel[cat] === idx) return;
    this.accSel = { ...this.accSel, [cat]: idx };
    this.cbs.setAccessories(this.accSel);
    this.renderAccStrip();
    this.refreshCustomizePreview();
  }

  private randomizeAccessories(): void {
    const pick = (n: number): number => Math.floor(Math.random() * (n + 1)) - 1;
    this.accSel = {
      hat: pick(defsOf('hat').length),
      backpack: pick(defsOf('backpack').length),
      pet: pick(defsOf('pet').length),
    };
    this.cbs.setAccessories(this.accSel);
    this.renderAccStrip();
    this.refreshCustomizePreview();
    this.toast('New outfit equipped', 1500);
  }

  private refreshCustomizePreview(): void {
    // the avatar always wears exactly the SAVED selection — nothing else can dress it
    this.preview?.showAccessories(this.accSel);
    this.refreshAccCaption();
  }

  /**
   * The line under the avatar: what is worn right now. The avatar itself already shows it, and
   * the caption names all three slots in one glance.
   */
  private refreshAccCaption(): void {
    if (!this.accCaption) return;
    this.accCaption.className = 'acc-caption';
    this.accCaption.textContent = CATEGORY_ORDER
      .map(cat => `${CATEGORY_LABELS[cat].slice(0, -1)}: ${defAt(cat, this.accSel[cat])?.name ?? 'NONE'}`)
      .join('   ·   ');
  }

  // ------------------------------------------------------------ HUD

  private buildHud(): void {
    const h = this.hud;
    this.root.appendChild(h);

    // ---------------- 2D boss nameplates (track the creature in world space)
    this.bossLayer = el('div', 'boss-layer');
    this.root.appendChild(this.bossLayer);

    // ---------------- top: left (circular minimap) • center (timer) • right (towers)
    const top = el('div', 'hud-top');

    const leftCol = el('div', 'hud-left');
    this.minimap = document.createElement('canvas');
    this.minimap.className = 'minimap';
    this.minimap.width = 320;
    this.minimap.height = 320;
    leftCol.appendChild(this.minimap);
    // Settings cog, top-left under the radar: the same panel Esc opens.
    const settings = el('div', 'hud-settings');
    settings.title = 'Settings — Esc';
    settings.setAttribute('role', 'button');
    settings.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/>' +
      '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"/>' +
      '</svg>';
    settings.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      this.cbs.openMenu();
    });
    leftCol.appendChild(settings);
    top.appendChild(leftCol);

    const timerPanel = el('div', 'timer');
    this.timerVal = el('div', 'val', '10:00');
    timerPanel.appendChild(this.timerVal);
    const rail = el('div', 'rail');
    this.timerRail = el('i');
    rail.appendChild(this.timerRail);
    timerPanel.appendChild(rail);
    top.appendChild(timerPanel);

    // ---------------- right: the 5 tower symbols (4 Beacons + Nexus) + objectives
    const widget = el('div', 'tower-widget');
    const symRow = el('div', 'tower-symbols');
    for (let i = 0; i < 5; i++) {
      const sym = el('div', `tsym${i === 4 ? ' nexus' : ''}`);
      const fill = el('div', 'tsym-fill');
      const ring = el('div', 'tsym-ring');
      const glyph = el('div', 'glyph', i === 4 ? NEXUS_ICON : BEACON_ICON);
      const status = el('div', 'tsym-status hidden', '');
      sym.appendChild(fill);
      sym.appendChild(ring);
      sym.appendChild(glyph);
      sym.appendChild(status);
      symRow.appendChild(sym);
      this.towerWidget.push({ el: sym, glyph, ring, status, fill });
    }
    widget.appendChild(symRow);

    // ---- objectives: what the colony is actually supposed to be doing
    this.taskList = el('div', 'task-list');
    widget.appendChild(this.taskList);
    top.appendChild(widget);

    h.appendChild(top);

    this.debugBox = el('div', 'debug hidden', '');
    h.appendChild(this.debugBox);

    // ---------------- bottom left: game notifications (toasts + kill feed)
    const leftStack = el('div', 'hud-left-stack');
    this.killfeed = el('div', 'killfeed');
    this.toastBox = el('div', 'toast');
    leftStack.appendChild(this.killfeed);
    leftStack.appendChild(this.toastBox);
    h.appendChild(leftStack);

    // ---------------- bottom right: Jump / Dash counters, then Skill + Ultimate
    const rightStack = el('div', 'hud-right-stack');
    const actions = el('div', 'action-row');
    /** A small round action button (jump / dash) with its charge count in the corner. */
    const mkSmall = (cls: string, key: string, svg: string, onClick: () => void): { box: HTMLElement; count: HTMLElement } => {
      const box = el('div', `ab-sm ${cls}`);
      box.innerHTML = svg;
      const count = el('div', 'ab-sm-count', '0');
      const keyTag = el('div', 'ab-sm-key', key);
      box.appendChild(count);
      box.appendChild(keyTag);
      box.addEventListener('click', e => {
        e.stopPropagation();
        onClick();
      });
      actions.appendChild(box);
      return { box, count };
    };
    const jumpBtn = mkSmall('jump', 'SPACE', ICON_JUMP, () => this.input?.queueJump());
    const dashBtn = mkSmall('dash', 'SHIFT', ICON_DASH, () => this.input?.queueDash());
    // The Beacon ability gets a real button on desktop too. It appears ONLY while the local player
    // stands inside one of their own shielded Beacons — the exact condition the F key checks — so
    // the rail answers "can I use it right now?" without reading the prompt line.
    const beaconBtn = mkSmall('beacon', 'F', ICON_BEACON, () => this.input?.queueBeacon());
    this.jumpCount = jumpBtn.count;
    this.dashCount = dashBtn.count;
    this.beaconBtn = beaconBtn.box;
    const mkAbility = (
      tag: string,
      alt: string
    ): { box: HTMLElement; sweep: HTMLElement; txt: HTMLElement; name: HTMLElement; icon: HTMLElement; ring: HTMLElement } => {
      const box = el('div', 'ab');
      const ring = el('div', 'ab-ring');
      const icon = el('div', 'ab-icon');
      const sweep = el('div', 'ab-sweep');
      const txt = el('div', 'ab-cd', '');
      // the ability's own name is the headline; the slot tag (SKILL / ULTIMATE) sits underneath
      const k = el('div', 'ab-key', '—');
      const altKey = el('div', 'ab-alt', alt);
      const nm = el('div', 'ab-name', tag);
      box.appendChild(ring);
      box.appendChild(icon);
      box.appendChild(sweep);
      box.appendChild(txt);
      box.appendChild(k);
      box.appendChild(altKey);
      box.appendChild(nm);
      actions.appendChild(box);
      return { box, sweep, txt, name: nm, icon, ring };
    };
    const skill = mkAbility('SKILL', 'E');
    this.skillBtn = skill.box;
    this.skillMask = skill.sweep;
    this.skillCdTxt = skill.txt;
    this.skillName = skill.name;
    this.skillKey = skill.box.querySelector('.ab-key') as HTMLElement;
    this.skillAccent = skill.ring;
    this.skillIcon = skill.icon;
    this.skillBtn.addEventListener('click', () => this.input?.queueSkill());
    const ult = mkAbility('ULTIMATE', 'Q');
    this.ultBtn = ult.box;
    this.ultMask = ult.sweep;
    this.ultCdTxt = ult.txt;
    this.ultName = ult.name;
    this.ultKey = ult.box.querySelector('.ab-key') as HTMLElement;
    this.ultAccent = ult.ring;
    this.ultIcon = ult.icon;
    this.ultBtn.addEventListener('click', () => this.input?.queueUlt());
    this.skillBtn.style.pointerEvents = 'auto';
    this.ultBtn.style.pointerEvents = 'auto';
    // Hovering a skill (desktop) or holding it without dragging (touch) shows what it does — the
    // HUD otherwise only carries the name, and the full text lived in the Esc panel.
    this.bindAbilityTip(this.skillBtn, 'skill', 'E');
    this.bindAbilityTip(this.ultBtn, 'ult', 'Q');
    rightStack.appendChild(actions);
    h.appendChild(rightStack);

    // ---------------- bottom centre: the Necrotech tag is the only persistent bar
    const bottom = el('div', 'hud-bottom');
    const ntRow = el('div', 'nt-row');
    this.pillsRow = ntRow;
    // The mutation chip shows the mutation's NAME. Hovering (or long-pressing) it reveals what the
    // permutation actually does, through the same shared tooltip the status icons use, so the
    // bottom row stays one glanceable line instead of a wall of text.
    this.mutTag = el('span', 'tag mut hidden', '');
    this.bindMutationTip(this.mutTag);
    ntRow.appendChild(this.mutTag);
    this.ntTag = el('span', 'tag nt-name', 'NECROTECH');
    ntRow.appendChild(this.ntTag);
    // The buff strip (the COLONY OVERDRIVE countdown) sits ABOVE the mutation / Necrotech line: it
    // is a timed state of the whole colony, not part of the loadout headline — and as the last item
    // in that row it wrapped UNDER the very text it is meant to announce.
    this.buffTags = el('div', 'nt-row buff-row');
    bottom.appendChild(this.buffTags);
    bottom.appendChild(ntRow);
    h.appendChild(bottom);

    this.zoneBar = el('div', 'zone-bar hidden');
    this.zoneLabel = el('div', 'lbl', '');
    const zbar = el('div', 'bar');
    this.zoneFill = el('i');
    zbar.appendChild(this.zoneFill);
    this.zoneBar.appendChild(this.zoneLabel);
    this.zoneBar.appendChild(zbar);
    h.appendChild(this.zoneBar);

    this.bannerBox = el('div', 'banner hidden', '');
    h.appendChild(this.bannerBox);

    // The mutation reveal: significant enough to stop the eye, small enough to keep playing. It is
    // deliberately NOT a modal — freezing the player for a build notification would be a downgrade.
    this.mutateBox = el('div', 'mutate-reveal hidden');
    h.appendChild(this.mutateBox);

    this.promptBox = el('div', 'prompt hidden');
    this.promptCap = el('span', 'cap', 'F');
    this.promptText = el('span', '', '');
    this.promptBox.appendChild(this.promptCap);
    this.promptBox.appendChild(this.promptText);
    h.appendChild(this.promptBox);

    this.connBox = el('div', 'conn', '');
    h.appendChild(this.connBox);
  }

  updateHud(d: HudData): void {
    // ---- timer
    setText(this.timerVal, formatTime(d.remaining));
    setClass(this.timerVal, 'low', d.remaining < 60);
    const timeFrac = d.matchTime > 0 ? clamp01(1 - d.remaining / d.matchTime) : 0;
    setStyle(this.timerRail, 'width', `${timeFrac * 100}%`);

    // ---- tower symbols: owner ink + capture arc + single status glyph
    for (let i = 0; i < this.towerWidget.length; i++) {
      const sym = this.towerWidget[i];
      const info = d.towers[i];
      if (!info) continue;
      const ownerCss = info.owner >= 0 ? COLONIES[info.owner].css : '';
      const capturing = info.capture > 0.001 && info.captureColony >= 0;
      // ANY capture in flight flashes the icon, including the first takeover of a Beacon or the
      // Nexus — that one is always your own colony, and it is the moment the tower is won.
      const stolen = capturing;
      const shieldFrac = clamp01(info.shieldFrac);
      const shieldTiming = info.shieldUp && shieldFrac > 0 && shieldFrac < 1;
      // The ring outside the tile is ONE bar, the way the radar draws it: a capture in flight wins
      // over the ward (the ward is exactly what it is about to break), otherwise the ward's
      // remaining life flies the owner's banner — red while a Warden still holds the tower.
      let ringCss = '';
      let ringFrac = 0;
      if (capturing) {
        ringCss = COLONIES[info.captureColony].css;
        ringFrac = clamp01(info.capture);
      } else if (info.shieldUp) {
        ringCss = info.bossAlive || info.owner < 0 ? WARD_RED : COLONIES[info.owner].css;
        ringFrac = shieldTiming ? shieldFrac : 1;
      }
      // ONE colour per tower, used by the tile, its fill, its glow and the letter badge's ring: the
      // colour of whoever HOLDS it right now. A steal in flight therefore leaves the icon flying the
      // DEFENDER's banner — only the ring around it changes hands — and the icon flips to the new
      // colony the moment the capture COMPLETES, because that is when `owner` itself changes.
      // Colour on the icon is the claim "this is theirs", and a capture that has not finished is not
      // a claim: showing the taker's colour from the first frame announced a tower as lost while the
      // defenders could still be standing in the ring. SEAL RED while a Beacon belongs to nobody at
      // all (its Necrophage warden is over it either way); the Nexus keeps its pale landmark icon.
      const towerCss = info.owner >= 0
        ? COLONIES[info.owner].css
        : info.kind === 'nexus'
          ? '#e2d9ff'
          : WARD_RED;
      setClass(sym.el, 'owned', info.owner >= 0);
      setClass(sym.el, 'shielded', info.shieldUp);
      setClass(sym.el, 'guarded', info.shieldUp && info.bossAlive);
      setClass(sym.el, 'capturing', capturing);
      setClass(sym.el, 'taking', stolen);
      setClass(sym.el, 'ring', ringFrac > 0);
      setClass(sym.el, 'shield-timing', shieldTiming);
      setClass(sym.el, 'low', shieldTiming && info.shieldT <= 5);
      setStyle(sym.el, 'color', towerCss);
      setVar(sym.el, '--tower-color', towerCss);
      // the glyph only whitens when the tower is actually held — same rule as the icon colour
      setStyle(sym.glyph, 'color', info.owner >= 0 ? '#ffffff' : '#cbb9ea');
      if (ringFrac > 0) {
        setVar(sym.ring, '--ring-color', ringCss);
        setVar(sym.ring, '--ring-frac', `${ringFrac}`);
      }

      let status = '';
      let title = info.kind === 'nexus' ? 'Nexus' : beaconName(i);
      if (info.owner >= 0) title += ` — ${COLONIES[info.owner].name}`;
      if (info.bossAlive) {
        status = 'skull';
        title += ' — guardian alive';
      } else if (info.shieldUp) {
        status = 'shield';
        title += shieldTiming
          ? ` — shield falls in ${Math.ceil(info.shieldT)}s`
          : info.kind === 'nexus'
            ? ' — seal holds — liberate the Beacons'
            : ' — shield active (beacon power unused)';
      } else if (info.state === 'vulnerable') {
        status = 'warn';
        title += ' — EXPOSED';
      } else if (capturing) {
        status = 'cap';
      }
      // A capture in flight always names itself, even when a status glyph (a live guardian, a ward)
      // already owns the bubble — the ring is moving, the tooltip says who is moving it.
      if (capturing) {
        title += ` — ${COLONIES[info.captureColony].name} capturing ${Math.round(info.capture * 100)}%`;
      }
      // The corner badge is the Beacon's LETTER (A-D) — the call-out every colony uses on voice —
      // tinted by the tower's state. The Nexus is the one landmark that needs none.
      const letter = info.kind === 'nexus' ? '' : BEACON_LETTERS[i] ?? '';
      setText(sym.status, letter);
      const statusCls = `tsym-status${letter === '' ? ' hidden' : status === '' ? '' : ` ${status}`}`;
      if (sym.status.className !== statusCls) sym.status.className = statusCls;
      if (sym.el.title !== title) sym.el.title = title;
    }

    // ---- objectives (top-right, under the tower tracker)
    // Rows are created once and then diffed: this used to be an innerHTML assignment — a full HTML
    // parse — every single frame.
    const tasks = d.tasks ?? [];
    let taskSig = '';
    for (const t of tasks) taskSig += `${t.label}|${t.progress}|${t.done ? 1 : 0};`;
    if (taskSig !== this.taskSig) {
      this.taskSig = taskSig;
      for (let i = 0; i < tasks.length; i++) {
        while (this.taskRows.length <= i) {
          const row = el('div', 'task');
          const mark = el('span', 'tk', '');
          const label = el('span', 'tt', '');
          const prog = el('span', 'tp', '');
          row.append(mark, label, prog);
          this.taskList.appendChild(row);
          this.taskRows.push({ row, mark, label, prog });
        }
        const r = this.taskRows[i];
        const t = tasks[i];
        setText(r.mark, t.done ? '\u2714' : '\u25cb');
        setText(r.label, t.label);
        setText(r.prog, t.progress);
        setClass(r.row, 'done', t.done);
        setClass(r.row, 'hidden', false);
      }
      for (let i = tasks.length; i < this.taskRows.length; i++) setClass(this.taskRows[i].row, 'hidden', true);
    }

    // ---- necrotech + buffs (the only bottom-centre readout)
    setText(this.ntTag, d.necrotechName);
    setStyle(this.ntTag, 'color', d.necrotechColor);
    setStyle(this.ntTag, 'borderColor', d.necrotechColor);
    // The mutation NAME is the bottom-centre headline, so a player always knows what they built.
    setClass(this.mutTag, 'hidden', d.mutated === 0 || !d.mutationName);
    if (d.mutated !== 0 && d.mutationName) {
      setText(this.mutTag, d.mutationName);
      setStyle(this.mutTag, 'color', d.mutationColor);
      setStyle(this.mutTag, 'borderColor', d.mutationColor);
      this.mutTipLabel = `${d.mutationName} — ${d.mutationRarity || 'MUTATION'}`;
      this.mutTipDesc =
        `${d.mutationSources}. ${d.mutationDesc}` +
        (d.mutationTags ? ` [${d.mutationTags}]` : '') +
        ` · MUTATIONS ${d.mutationCount}/${d.mutationLimit}`;
    }
    let buffSig = '';
    for (const b of d.buffs) buffSig += `${b.cls}:${b.text};`;
    if (buffSig !== this.buffSig) {
      this.buffSig = buffSig;
      this.buffTags.textContent = '';
      for (const b of d.buffs) this.buffTags.appendChild(el('span', `tag ${b.cls}`, b.text));
    }

    // ---- abilities: round icons with a cooldown sweep, seconds, key and name
    // Skill and Ultimate use different icon families (see necrotech/AbilityIcons.ts)
    const sIcon = abilityIcon(d.skillName, d.skillDesc, false);
    const uIcon = abilityIcon(d.ultName, d.ultDesc, true);
    if (this.skillIcon.dataset.glyph !== sIcon) {
      this.skillIcon.innerHTML = sIcon;
      this.skillIcon.dataset.glyph = sIcon;
    }
    if (this.ultIcon.dataset.glyph !== uIcon) {
      this.ultIcon.innerHTML = uIcon;
      this.ultIcon.dataset.glyph = uIcon;
    }

    setText(this.skillKey, d.skillName);
    setText(this.ultKey, d.ultName);
    // `.ab-name` keeps its slot tag (SKILL / ULTIMATE) — the name now lives on the button itself
    setStyle(this.skillAccent, 'color', d.necrotechColor);
    setStyle(this.ultAccent, 'color', d.necrotechColor);
    setStyle(this.skillIcon, 'color', d.necrotechColor);
    setStyle(this.ultIcon, 'color', d.necrotechColor);
    const skillFrac = d.skillMax > 0 ? clamp01(d.skillCd / d.skillMax) : 0;
    setVar(this.skillMask, '--cd', `${(1 - skillFrac) * 100}%`);
    setText(this.skillCdTxt, d.skillCd > 0.15 ? d.skillCd.toFixed(1) : '');
    setClass(this.skillBtn, 'ready', d.skillCd <= 0);
    const ultFrac = d.ultMax > 0 ? clamp01(d.ultCd / d.ultMax) : 0;
    setVar(this.ultMask, '--cd', `${(1 - ultFrac) * 100}%`);
    setText(this.ultCdTxt, d.ultCd > 0.15 ? Math.ceil(d.ultCd).toString() : '');
    setClass(this.ultBtn, 'ready', d.ultCd <= 0);

    // ---- mobile cluster mirrors the same state
    if (this.mSkillIco && this.mSkillIco.dataset.glyph !== sIcon) {
      this.mSkillIco.innerHTML = sIcon;
      this.mSkillIco.dataset.glyph = sIcon;
      this.mSkillIco.style.color = d.necrotechColor;
    }
    if (this.mUltIco && this.mUltIco.dataset.glyph !== uIcon) {
      this.mUltIco.innerHTML = uIcon;
      this.mUltIco.dataset.glyph = uIcon;
      this.mUltIco.style.color = d.necrotechColor;
    }
    if (this.mSkillCd) {
      setText(this.mSkillCd, d.skillCd > 0.15 ? d.skillCd.toFixed(1) : '');
      setClass(this.mSkillBtn ?? null, 'cooling', d.skillCd > 0.15);
      setClass(this.mSkillBtn ?? null, 'ready', d.skillCd <= 0);
    }
    if (this.mUltCd) {
      setText(this.mUltCd, d.ultCd > 0.15 ? Math.ceil(d.ultCd).toString() : '');
      setClass(this.mUltBtn ?? null, 'cooling', d.ultCd > 0.15);
      setClass(this.mUltBtn ?? null, 'ready', d.ultCd <= 0);
    }
    if (this.mDashCount) {
      setText(this.mDashCount, `${d.dashCharges}`);
      setClass(this.mDashCount, 'empty', d.dashCharges <= 0);
    }
    if (this.mJumpCount) {
      setText(this.mJumpCount, `${d.jumpsLeft}`);
      setClass(this.mJumpCount, 'empty', d.jumpsLeft <= 0);
    }
    setText(this.mSkillName ?? null, d.skillName);
    setText(this.mUltName ?? null, d.ultName);
    setClass(this.mBeaconBtn ?? null, 'available', d.beaconReady);

    // ---- desktop rail: jump / dash charges, and the ability text the hover tip needs
    // the Beacon button follows the same rule as its mobile twin: visible iff the ability is usable
    setClass(this.beaconBtn, 'available', d.beaconReady);
    if (this.jumpCount) {
      setText(this.jumpCount, `${d.jumpsLeft}`);
      setClass(this.jumpCount, 'empty', d.jumpsLeft <= 0);
    }
    if (this.dashCount) {
      setText(this.dashCount, `${d.dashCharges}`);
      setClass(this.dashCount, 'empty', d.dashCharges <= 0);
    }
    this.abInfo.skill.name = d.skillName;
    this.abInfo.skill.desc = d.skillDesc;
    this.abInfo.skill.cd = d.skillCd;
    this.abInfo.skill.cdMax = d.skillMax;
    this.abInfo.ult.name = d.ultName;
    this.abInfo.ult.desc = d.ultDesc;
    this.abInfo.ult.cd = d.ultCd;
    this.abInfo.ult.cdMax = d.ultMax;
    // a tip that is up while the loadout changes (a mutation, a swap) has to redraw
    if (this.abilityTipOpen()) this.abTipSig = '';

    // ---- Esc panel live stats (only while it is open)
    if (this.pauseOpen) this.renderPausePanel(d);

    // ---- capture bar
    if (d.zone) {
      setClass(this.zoneBar, 'hidden', false);
      setText(this.zoneLabel, d.zone.label);
      setStyle(this.zoneFill, 'width', `${clamp01(d.zone.progress) * 100}%`);
      setStyle(this.zoneFill, 'background', d.zone.colony >= 0 ? COLONIES[d.zone.colony].css : '#b9aed2');
    } else {
      setClass(this.zoneBar, 'hidden', true);
    }

    // ---- prompt
    setClass(this.promptBox, 'hidden', !d.prompt);
    if (d.prompt) {
      setText(this.promptCap, d.promptKey);
      setText(this.promptText, d.prompt);
    }

    setText(this.connBox, d.conn);
  }

  /**
   * Capture readout pinned above a tower that is being flipped: the percentage is the bar fill,
   * the countdown is the time left before the tower changes hands.
   * (A tower's SHIELD is drawn as an `hp-plate ward` instead — see `updateBossPlates` — so it
   * inherits the same visibility rules as a boss health bar.)
   */
  updateTowerPlates(list: TowerPlate[]): void {
    const seen = new Set<number>();
    for (const t of list) {
      seen.add(t.idx);
      let plate = this.towerPlates.get(t.idx);
      if (!plate) {
        const box = el('div', 'tw-plate');
        const nm = el('div', 'tw-nm', '');
        const bar = el('div', 'tw-bar');
        const fill = el('i');
        bar.appendChild(fill);
        const row = el('div', 'tw-row');
        const cd = el('span', 'tw-cd', '');
        const pct = el('span', 'tw-pct', '');
        row.append(pct, cd);
        box.append(nm, bar, row);
        this.bossLayer.appendChild(box);
        plate = { el: box, nm, pct, fill, cd };
        this.towerPlates.set(t.idx, plate);
      }
      setClass(plate.el, 'hidden', !t.visible);
      if (!t.visible) continue;
      setStyle(plate.el, 'transform', `translate(${Math.round(t.x)}px, ${Math.round(t.y)}px) translate(-50%, -100%)`);
      setText(plate.nm, t.label);
      setStyle(plate.nm, 'color', t.color);
      setStyle(plate.fill, 'width', `${clamp01(t.frac) * 100}%`);
      setStyle(plate.fill, 'background', t.color);
      setText(plate.pct, `${Math.round(clamp01(t.frac) * 100)}%`);
      setStyle(plate.pct, 'color', t.color);
      // the countdown is what the percentage is counting up to
      setText(plate.cd, `${Math.max(0, t.remain).toFixed(1)}s`);
      const title = `${t.label} — ${t.colonyName} capturing`;
      if (plate.el.title !== title) plate.el.title = title;
    }
    for (const [idx, plate] of this.towerPlates) {
      if (seen.has(idx)) continue;
      plate.el.remove();
      this.towerPlates.delete(idx);
    }
  }

  /** Screen-space health plates, positioned by the game's world→screen projection. */
  updateBossPlates(list: BossPlate[]): void {
    const seen = new Set<string>();
    for (const b of list) {
      seen.add(b.key);
      let plate = this.bossPlates.get(b.key);
      if (!plate) {
        const box = el('div', `hp-plate ${b.kind}`);
        const name = el('div', 'hp-name', '');
        const bar = el('div', 'hp-bar');
        const fill = el('i');
        bar.appendChild(fill);
        let xpFill: HTMLElement | null = null;
        let shieldWrap: HTMLElement | null = null;
        let shieldFill: HTMLElement | null = null;
        let lvl: HTMLElement | null = null;
        let statusRow: HTMLElement | null = null;
        let crown: HTMLElement | null = null;
        let stunWrap: HTMLElement | null = null;
        let stunFill: HTMLElement | null = null;
        let rage: HTMLElement | null = null;
        let stunTag: HTMLElement | null = null;
        let cap: HTMLElement | null = null;
        const dashes: { el: HTMLElement; fill: HTMLElement }[] = [];
        if (b.kind === 'player') {
          // the Necromutation crown sits ABOVE the status row, so it must come first in the DOM
          crown = el('div', 'hp-crown hidden');
          crown.innerHTML = crownIcon();
          box.appendChild(crown);
          // status icons (buffs / debuffs) sit above the whole plate, MOBA style
          statusRow = el('div', 'hp-status');
          box.appendChild(statusRow);
          // level badge + name, health, Necromutation, dash pips — the full MOBA stack
          const head = el('div', 'hp-head');
          lvl = el('span', 'hp-lvl', '1');
          head.appendChild(lvl);
          head.appendChild(name);
          const dashWrap = el('div', 'hp-dash');
          for (let i = 0; i < 3; i++) {
            const pip = el('div', 'hp-pip');
            dashWrap.appendChild(pip);
            dashes.push({ el: pip, fill: pip });
          }
          head.appendChild(dashWrap);
          box.appendChild(head);
          box.appendChild(bar);
          // Necrotic Ward: a translucent light-blue slab laid over the health fill
          shieldWrap = el('div', 'hp-shield');
          shieldFill = el('i');
          shieldWrap.appendChild(shieldFill);
          box.appendChild(shieldWrap);
          const xp = el('div', 'hp-xp');
          xpFill = el('i');
          xp.appendChild(xpFill);
          box.appendChild(xp);
        } else if (b.kind === 'ward') {
          // tower shield: name, hatched bar, then the line that says what unlocks it
          box.appendChild(name);
          box.appendChild(bar);
          cap = el('div', 'hp-cap', '');
          box.appendChild(cap);
        } else if (b.kind === 'boss') {
          // A boss carries TWO bars: health, then STUN. The stun bar is not a second health pool —
          // it is the meter that opens the punish window, so it is drawn separately and answers
          // "how close am I to breaking it".
          box.appendChild(name);
          box.appendChild(bar);
          stunWrap = el('div', 'hp-stun');
          stunFill = el('i');
          stunWrap.appendChild(stunFill);
          box.appendChild(stunWrap);
          rage = el('div', 'hp-rage hidden', 'ENRAGED');
          box.appendChild(rage);
          // The STUNNED call-out: ONE word. The tag marks the state, and the state is already
          // obvious in the world (the bar is empty, the body droops, it is not fighting back), so any
          // sentence after it is noise on top of a moment the player is reading at a glance.
          stunTag = el('div', 'hp-broken hidden', 'STUNNED');
          box.appendChild(stunTag);
        } else {
          box.appendChild(name);
          box.appendChild(bar);
        }
        this.bossLayer.appendChild(box);
        plate = { el: box, name, fill, xpFill, lvl, dashes, statusRow, crown, cap, shieldWrap, shieldFill, stunWrap, stunFill, rage, stunTag, statusSig: '', hpQ: -1, statusIcons: [] };
        this.bossPlates.set(b.key, plate);
      }
      const frac = clamp01(b.hp / Math.max(1, b.maxHp));
      setClass(plate.el, 'hidden', !b.visible);
      setClass(plate.el, 'self', b.self);
      if (!b.visible) continue;
      setStyle(plate.el, 'transform', `translate(${Math.round(b.x)}px, ${Math.round(b.y)}px) translate(-50%, -100%)`);
      setText(plate.name, b.name);
      setStyle(plate.name, 'color', b.color);
      setStyle(plate.fill, 'width', `${frac * 100}%`);
      if (b.kind === 'player') {
        // health-reactive gradient: green -> orange -> red as it depletes. Quantised to whole
        // percent so the gradient string is rebuilt when the bar visibly moves, not every frame.
        const q = Math.round(frac * 100);
        if (q !== plate.hpQ) {
          plate.hpQ = q;
          const [g1, g2] = playerHpGradient(frac);
          setStyle(plate.fill, 'background', `linear-gradient(90deg, ${g1}, ${g2})`);
        }
        // shield charge rides on top of the health fill
        const smax = Math.max(1, b.shieldMax ?? 0);
        const sfrac = clamp01((b.shield ?? 0) / smax);
        if (plate.shieldWrap && plate.shieldFill) {
          const on = sfrac > 0.001;
          setClass(plate.shieldWrap, 'hidden', !on);
          if (on) setStyle(plate.shieldFill, 'width', `${sfrac * 100}%`);
        }
        setClass(plate.el, 'critical', frac <= 0.28);
        // Necromutation marks: a veteran ring from level 10, a crown from level 20
        setClass(plate.el, 'veteran', b.level >= 10);
        setClass(plate.el, 'crowned', b.level >= 20);
        if (plate.crown) {
          const crowned = b.level >= 20;
          setClass(plate.crown, 'hidden', !crowned);
          if (crowned) setStyle(plate.crown, 'color', b.color);
        }
        this.updateStatusRow(plate, b.statuses ?? []);
      } else if (b.kind === 'base') {
        // A fortress is impregnable: a dark slab crossed with grey diagonals, never a health
        // gradient, so the plate reads as structural rather than as something to shoot at.
        setStyle(plate.fill, 'background', BASE_HATCH);
        const title = `${b.name} — impregnable. Its shield keeps Necrophages out and cannot be broken.`;
        if (plate.el.title !== title) plate.el.title = title;
      } else if (b.kind === 'ward') {
        // A tower's shield is a LOCK, not a health pool: hatched in the banner flying it and dark
        // grey, always full, with the condition that opens it spelled out underneath. The hatch
        // takes the plate's own colour, so a captured Beacon is hatched in its colony's colour and
        // only a ward nobody owns (a guarded Beacon, the sealed Nexus) is red.
        setStyle(plate.fill, 'width', '100%');
        setStyle(plate.fill, 'background', wardHatch(b.color));
        if (plate.cap) setText(plate.cap, b.caption ?? '');
        const title = `${b.name} — ${b.caption ?? 'shielded'}`;
        if (plate.el.title !== title) plate.el.title = title;
      } else if (b.kind === 'boss') {
        // STUN: drains as the boss is hit, and an empty bar is the damage window. A broken boss
        // flashes the whole plate so the punish window cannot be missed.
        const sfrac = clamp01((b.stun ?? 0) / Math.max(0.0001, b.stunMax ?? 1));
        if (plate.stunFill) setStyle(plate.stunFill, 'width', `${sfrac * 100}%`);
        if (plate.stunWrap) setClass(plate.stunWrap, 'hidden', (b.stunMax ?? 0) <= 0);
        setClass(plate.el, 'stunned', !!b.stunned);
        setClass(plate.el, 'enraged', !!b.enraged);
        if (plate.rage) setClass(plate.rage, 'hidden', !b.enraged);
        if (plate.stunTag) setClass(plate.stunTag, 'hidden', !b.stunned);
        setStyle(plate.fill, 'background', '');
      } else {
        setStyle(plate.fill, 'background', '');
      }
      if (plate.xpFill) setStyle(plate.xpFill, 'width', `${clamp01(b.xpFrac) * 100}%`);
      if (plate.lvl) setText(plate.lvl, `${b.level}`);
      for (let i = 0; i < plate.dashes.length; i++) {
        // dashes are simply available or not — no outline, no refill bar
        const pip = plate.dashes[i];
        setClass(pip.el, 'on', i < b.dashCharges);
        const disp = i < b.dashMax ? '' : 'none';
        if (pip.el.style.display !== disp) pip.el.style.display = disp;
      }
    }
    for (const [key, plate] of this.bossPlates) {
      if (seen.has(key)) continue;
      plate.el.remove();
      this.bossPlates.delete(key);
    }
  }

  /**
   * Buff / debuff icons above a player's name row: a circular icon per status with a
   * countdown ring (buffs fill clockwise, debuffs in red), a stack badge and a tooltip
   * that opens on hover or on a touch hold.
   */
  private updateStatusRow(plate: { statusRow: HTMLElement | null; statusSig: string; statusIcons: { el: HTMLElement; ring: HTMLElement; count: HTMLElement; label: string; desc: string }[] }, list: NonNullable<BossPlate['statuses']>): void {
    const row = plate.statusRow;
    if (!row) return;
    const sig = list.map(s => `${s.key}/${s.kind}/${s.icon}${s.stacks > 1 ? '×' + s.stacks : ''}`).join('|');
    if (sig !== plate.statusSig) {
      plate.statusSig = sig;
      row.innerHTML = '';
      plate.statusIcons = [];
      for (const s of list) {
        // the status key rides on the icon as a class, so a single status can be styled on its own
        // (the mutation stack count reads in the Necrotech purple instead of the count amber)
        const icon = el('div', `st-icon ${s.kind} st-${s.key}`);
        const ring = el('div', 'st-ring');
        const glyph = el('div', 'st-glyph');
        glyph.innerHTML = statusIcon(s.icon);
        const count = el('div', 'st-n', '');
        icon.append(ring, glyph, count);
        icon.title = s.label;
        row.appendChild(icon);
        const entry = { el: icon, ring, count, label: s.label, desc: s.desc };
        plate.statusIcons.push(entry);
        // tooltip: hover with a mouse, or press and hold on a touch screen
        icon.addEventListener('pointerenter', (e) => {
          if (e.pointerType === 'touch') return;
          this.showStatusTip(entry.el, entry.label, entry.desc);
        });
        icon.addEventListener('pointerleave', () => this.hideStatusTip());
        icon.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          try {
            icon.setPointerCapture(e.pointerId);
          } catch {
            /* capture is best-effort */
          }
          icon.classList.add('holding');
          this.showStatusTip(entry.el, entry.label, entry.desc);
        });
        const end = (): void => {
          icon.classList.remove('holding');
          this.hideStatusTip();
        };
        icon.addEventListener('pointerup', end);
        icon.addEventListener('pointercancel', end);
      }
    }
    for (let i = 0; i < plate.statusIcons.length; i++) {
      const entry = plate.statusIcons[i];
      const s = list[i];
      if (!s) continue;
      const frac = s.total > 0 ? clamp01(s.remain / s.total) : 1;
      setVar(entry.ring, '--p', frac.toFixed(3));
      const secs = s.timed && s.remain > 0 ? `${Math.ceil(s.remain)}s` : '';
      setText(entry.count, s.stacks > 1 ? `×${s.stacks}` : secs);
      setClass(entry.el, 'timed', s.timed);
      entry.desc = s.desc;
      entry.label = s.label;
    }
  }

  private showStatusTip(anchor: HTMLElement, label: string, desc: string): void {
    if (!this.statusTip) {
      this.statusTip = el('div', 'st-tip');
      this.root.appendChild(this.statusTip);
    }
    const tip = this.statusTip;
    tip.innerHTML = `<b>${label}</b><span>${desc}</span>`;
    tip.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const w = tip.offsetWidth;
    const centred = r.left + r.width / 2 - w / 2;
    const x = Math.min(Math.max(centred, 6), Math.max(6, window.innerWidth - w - 6));
    const y = Math.max(6, r.top - tip.offsetHeight - 8);
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  private hideStatusTip(): void {
    this.statusTip?.classList.add('hidden');
  }

  /**
   * The mutation chip's description, on desktop hover and touch long-press. Deliberately the same
   * tooltip the status icons use: one overlay, one set of placement rules, no new UI language.
   */
  private bindMutationTip(node: HTMLElement): void {
    node.addEventListener('pointerenter', e => {
      if (e.pointerType === 'touch') return;
      if (this.mutTipLabel) this.showStatusTip(node, this.mutTipLabel, this.mutTipDesc);
    });
    node.addEventListener('pointerleave', e => {
      if (e.pointerType === 'touch') return;
      this.hideStatusTip();
    });
    let timer = 0;
    node.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (this.mutTipLabel) this.showStatusTip(node, this.mutTipLabel, this.mutTipDesc);
      }, 380);
    });
    const clear = (): void => {
      window.clearTimeout(timer);
      this.hideStatusTip();
    };
    node.addEventListener('pointerup', clear);
    node.addEventListener('pointercancel', clear);
  }

  /**
   * Ability description overlay. Desktop: pointer hover on the round skill/ultimate button.
   * Touch: press and HOLD without dragging to aim — the same button doubles as the aim stick, so a
   * drag means "aim", and a still hold means "what does this do?".
   */
  private bindAbilityTip(node: HTMLElement, kind: 'skill' | 'ult', key: string): void {
    node.addEventListener('pointerenter', e => {
      if (e.pointerType === 'touch') return;
      this.showAbilityTip(node, kind, key);
    });
    node.addEventListener('pointerleave', e => {
      if (e.pointerType === 'touch') return;
      this.hideAbilityTip();
    });
    // touch: a long press that never turns into a drag
    let timer = 0;
    let shown = false;
    node.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      shown = false;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        shown = true;
        // the SAME flag stops the aim button from casting when this press is released
        node.dataset.inspect = '1';
        this.showAbilityTip(node, kind, key);
      }, 420);
    });
    const clear = (): void => {
      window.clearTimeout(timer);
      if (shown) this.hideAbilityTip();
      shown = false;
      delete node.dataset.inspect;
    };
    node.addEventListener('pointerup', clear);
    node.addEventListener('pointercancel', clear);
    node.addEventListener('pointermove', e => {
      if (e.pointerType !== 'touch' || !shown) return;
      this.hideAbilityTip();
      shown = false;
    });
  }

  /** True while a long-press description is up, so the button can skip casting on release. */
  private abilityTipOpen(): boolean {
    return !!this.abTip && !this.abTip.classList.contains('hidden');
  }

  private showAbilityTip(anchor: HTMLElement, kind: 'skill' | 'ult', key: string): void {
    const info = this.abInfo[kind];
    if (!info.name) return;
    if (!this.abTip) {
      this.abTip = el('div', 'ab-tip');
      this.root.appendChild(this.abTip);
    }
    const tip = this.abTip;
    const cd = info.cdMax > 0 ? `${info.cdMax.toFixed(info.cdMax >= 10 ? 0 : 1)}s cooldown` : '';
    const sig = `${info.name}|${info.desc}|${cd}|${key}`;
    if (sig !== this.abTipSig) {
      this.abTipSig = sig;
      tip.innerHTML =
        `<div class="abt-head"><span class="abt-key">${key}</span>` +
        `<b>${info.name}</b><span class="abt-tag">${kind === 'skill' ? 'SKILL' : 'ULTIMATE'}</span></div>` +
        `<p>${info.desc}</p>` +
        (cd ? `<div class="abt-cd">${cd}</div>` : '');
    }
    tip.classList.remove('hidden');
    const r = anchor.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    // sit above the button, nudged left so the wide text never runs off the right edge
    const x = Math.min(Math.max(r.left + r.width / 2 - w / 2, 8), Math.max(8, window.innerWidth - w - 8));
    const y = Math.max(8, r.top - h - 10);
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  private hideAbilityTip(): void {
    this.abTip?.classList.add('hidden');
  }

  drawMinimap(d: MiniData): void {
    // While the Esc menu is up the radar is hidden (the card covers it) — skip the canvas work.
    if (this.hud.classList.contains('menu-open')) return;
    // The radar is a 150 m plot rebuilt from scratch every call: a full canvas clear, a radial
    // gradient, a shadow-blurred sigil per tower, and a dot per enemy. Redrawing it at ~20 Hz
    // instead of 60 halves nothing visually — the plot moves a couple of pixels — and takes one of
    // the most expensive DOM jobs out of two thirds of the frames.
    const now = performance.now();
    if (now - this.mapLast < 50) return;
    this.mapLast = now;
    // The radar is drawn in CSS pixels at device resolution so the landmarks keep the same
    // apparent size whether the minimap is shrunk on a phone or grown on a desktop.
    const rect = this.minimap.getBoundingClientRect();
    const css = Math.round(rect.width);
    if (css < 24) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const backing = Math.round(css * dpr);
    if (this.minimap.width !== backing) {
      this.minimap.width = backing;
      this.minimap.height = backing;
    }
    const ctx = this.minimap.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const size = css;
    const c = size / 2;
    const r = c - 3;
    const scale = (r - 8) / Math.max(1, d.range);

    // world-space point -> radar pixel offset on the local tangent plane
    const project = (p: { x: number; y: number; z: number }): [number, number] => {
      const dx = p.x - d.origin.x;
      const dy = p.y - d.origin.y;
      const dz = p.z - d.origin.z;
      const fx = dx * d.right.x + dy * d.right.y + dz * d.right.z;
      const fz = dx * d.fwd.x + dy * d.fwd.y + dz * d.fwd.z;
      return [c + fx * scale, c - fz * scale];
    };

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.clip();

    // terrain-less disc with a soft vignette
    const grad = ctx.createRadialGradient(c, c, r * 0.15, c, c, r);
    grad.addColorStop(0, 'rgba(30, 20, 52, 0.55)');
    grad.addColorStop(1, 'rgba(12, 8, 22, 0.72)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // range rings
    ctx.strokeStyle = 'rgba(160, 120, 255, 0.14)';
    ctx.lineWidth = 1;
    for (const f of [0.5, 1]) {
      ctx.beginPath();
      ctx.arc(c, c, (r - 8) * f, 0, Math.PI * 2);
      ctx.stroke();
    }

    // towers — always visible as colour-coded icons (same glyphs as the top-right tracker):
    // in range they sit at their real spot, out of range they are pinned to the rim.
    // Beacons and the Nexus are the landmarks the player navigates by: draw them big.
    const iconR = Math.min(Math.max(size * 0.085, 6), 11);
    // One blink phase for the whole radar, so every landmark being taken pulses together.
    const blinkA = 0.22 + 0.78 * (0.5 + 0.5 * Math.sin(now * 0.008));
    const legend: {
      x: number; y: number; idx: number; kind: string; owner: number; off: boolean;
      shieldUp: boolean; shieldFrac: number; guarded: boolean; blink: boolean;
      capture: number; captureColony: number;
    }[] = [];
    for (const t of d.towers) {
      const [x, y] = project(t);
      const dx = x - c;
      const dy = y - c;
      const dist = Math.hypot(dx, dy);
      const own = t.kind === 'nexus' ? iconR * 1.18 : iconR;
      const rim = r - own - 2;
      const off = dist > rim;
      let px = x;
      let py = y;
      if (off) {
        px = c + (dx / Math.max(1, dist)) * rim;
        py = c + (dy / Math.max(1, dist)) * rim;
      }
      legend.push({
        x: px, y: py, idx: t.idx, kind: t.kind, owner: t.owner, off,
        shieldUp: t.shieldUp, shieldFrac: t.shieldFrac, guarded: t.guarded,
        capture: t.capture, captureColony: t.captureColony,
        // ANY capture in flight flashes the landmark, the same tell as the tracker — a first
        // takeover of a Beacon or the Nexus counts just as much as a steal.
        blink: t.capture > 0.001 && t.captureColony >= 0,
      });
    }
    for (const L of legend) {
      // An unclaimed BEACON is SEAL RED here — the same rule the tracker and the tower's own glow
      // use, so "nobody has this one yet" is one colour everywhere. The Nexus is the exception: it
      // is the map's fixed landmark, so its pale sigil stays put and the seal red rides the shield
      // ring drawn around it instead.
      const owner =
        L.owner >= 0
          ? COLONIES[L.owner].css
          : L.kind === 'nexus'
            ? 'rgba(222,211,248,0.95)'
            : '#ff2d4a';
      const rad = L.kind === 'nexus' ? iconR * 1.18 : iconR;
      ctx.save();
      ctx.globalAlpha = (L.off ? 0.92 : 1) * (L.blink ? blinkA : 1);

      // glowing backing disc so the sigil stays legible over any terrain colour
      ctx.beginPath();
      ctx.arc(L.x, L.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(9,6,16,0.92)';
      ctx.fill();
      ctx.shadowColor = owner;
      ctx.shadowBlur = rad * 0.55;
      ctx.lineWidth = Math.max(1.4, rad * 0.2);
      ctx.strokeStyle = owner;
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.fillStyle = owner;
      ctx.strokeStyle = owner;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      if (L.kind === 'nexus') {
        // Nexus: diamond core with four rays
        const r2 = rad * 0.5;
        ctx.lineWidth = Math.max(1.2, rad * 0.18);
        ctx.beginPath();
        ctx.moveTo(L.x, L.y - r2);
        ctx.lineTo(L.x + r2, L.y);
        ctx.lineTo(L.x, L.y + r2);
        ctx.lineTo(L.x - r2, L.y);
        ctx.closePath();
        ctx.fill();
        const rr = rad * 0.9;
        for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as [number, number][]) {
          ctx.beginPath();
          ctx.moveTo(L.x + dx * r2 * 1.35, L.y + dy * r2 * 1.35);
          ctx.lineTo(L.x + dx * rr, L.y + dy * rr);
          ctx.stroke();
        }
      } else {
        // Beacon: a lettered disc — A/B/C/D, the same call-out the tracker badge and every global
        // notice use, so "go to C" means one thing to the whole colony. The owned backing disc and
        // rim above already carry the colony colour.
        const s = rad / 9.5;
        ctx.font = `900 ${(rad * 1.5).toFixed(1)}px Consolas, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = L.owner >= 0 ? '#ffffff' : 'rgba(232, 224, 255, 0.92)';
        ctx.fillText(BEACON_LETTERS[L.idx] ?? '?', L.x, L.y + rad * 0.06);
      }
      ctx.restore();
    }

    // Wards, on the radar: a circular progress ring around a shielded tower — a FULL circle while
    // the ward simply stands, and an arc that eats its way round while a timer runs.
    //
    // The ring is what marks a Beacon that is still held by its Guardian. Drawing it only during a
    // countdown (which a guardian-held Beacon never has — its ward has no timer) stripped the shield
    // off every enemy Beacon on the radar. The guardian's own red dot is a separate mark, plotted
    // like every other enemy: only while it is inside radar range.
    for (const L of legend) {
      const taking = L.capture > 0.001 && L.captureColony >= 0;
      const wardFrac = clamp01(L.shieldFrac);
      if (!L.shieldUp && !taking) continue;
      const railR = (L.kind === 'nexus' ? iconR * 1.18 : iconR) + 3.6;
      const frac = taking ? clamp01(L.capture) : wardFrac;
      const css = taking
        ? COLONIES[L.captureColony].css
        : L.owner >= 0
          ? COLONIES[L.owner].css
          : '#ff2d4a';
      ctx.save();
      ctx.globalAlpha = L.off ? 0.6 : 0.95;
      // the empty rail, so a partial arc reads as remaining time rather than a random stroke
      ctx.beginPath();
      ctx.arc(L.x, L.y, railR, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(9,6,16,0.75)';
      ctx.lineWidth = 2.6;
      ctx.stroke();
      if (frac > 0.005) {
        ctx.beginPath();
        ctx.arc(L.x, L.y, railR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
        ctx.strokeStyle = css;
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        ctx.shadowColor = css;
        ctx.shadowBlur = 4;
        ctx.stroke();
      }
      ctx.restore();
    }
    // enemies
    ctx.fillStyle = 'rgba(255, 96, 120, 0.6)';
    for (const e of d.enemies) {
      if (e.boss) continue;
      const [x, y] = project(e);
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#ff3d5a';
    // The guardian's big red dot follows the SAME range rule as every other enemy — it is plotted
    // only inside the radar's 150 m, never pinned from across the planet. But it used to hold full
    // size and full colour right out to the rim, so a guardian at the edge of the plot read as a
    // marked objective rather than as something nearby. It now fades and shrinks as it approaches
    // the edge: unmistakable when it is actually on you, gone by the time it is at the boundary.
    for (const e of d.enemies) {
      if (!e.boss) continue;
      const [x, y] = project(e);
      const off = Math.hypot(x - c, y - c) / Math.max(1, r - 8);
      const near = clamp01(1 - Math.max(0, off - 0.55) / 0.45);
      if (near <= 0.03) continue;
      ctx.globalAlpha = near;
      ctx.beginPath();
      ctx.arc(x, y, 3.6 * (0.7 + 0.3 * near), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // colony-mates
    for (const p of d.players) {
      if (!p.alive || p.isLocal) continue;
      const [x, y] = project(p);
      ctx.fillStyle = COLONIES[p.colony] ? COLONIES[p.colony].css : '#fff';
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // The local player: a small, rounded person glyph inside a round outline at the centre of the
    // radar, so the marker reads as *you are here*. Everything is a curve — no corners, no facing
    // wedge (the radar is world-aligned). The disc and its two rings are drawn as three passes so
    // the outline stays crisp over any terrain colour.
    const RING = 5.5;
    ctx.fillStyle = 'rgba(9, 6, 16, 0.45)';
    ctx.strokeStyle = 'rgba(9, 6, 16, 0.8)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(c, c, RING, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(c, c + 1.9, 2.5, 2.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(c, c - 2.3, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(c, c, RING, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // rim
    ctx.strokeStyle = 'rgba(160, 120, 255, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  toast(text: string, ms = 2200): void {
    const item = el('div', 'item', text);
    this.toastBox.appendChild(item);
    while (this.toastBox.children.length > 4) this.toastBox.removeChild(this.toastBox.children[0]);
    window.setTimeout(() => item.remove(), ms);
  }

  killFeed(text: string, color: string): void {
    const item = el('div', 'kf', text);
    item.style.borderLeft = `3px solid ${color}`;
    this.killfeed.appendChild(item);
    while (this.killfeed.children.length > 5) this.killfeed.removeChild(this.killfeed.children[0]);
    window.setTimeout(() => item.remove(), 5000);
  }

  banner(text: string, ms = 2000): void {
    this.bannerParts([{ text }], ms);
  }

  /**
   * A banner built from coloured runs, so a global notice can name each party in its OWN colour:
   * the colony taking a tower in its banner, the tower in the colour of whoever currently holds it.
   * Each run carries its own glow — without that, a coloured word still sits inside the banner's
   * white halo and reads as a highlight rather than as a colour.
   */
  bannerParts(parts: BannerPart[], ms = 2000): void {
    const box = this.bannerBox;
    box.textContent = '';
    for (const part of parts) {
      if (!part.text) continue;
      const span = el('span', '', part.text);
      if (part.color) {
        span.style.color = part.color;
        span.style.textShadow = `0 0 26px ${part.color}, 0 2px 10px #000`;
      }
      box.appendChild(span);
    }
    this.showBanner(ms);
  }

  private showBanner(ms: number): void {
    this.bannerBox.classList.remove('hidden');
    window.clearTimeout((this.bannerBox as HTMLElement & { _t?: number })._t);
    (this.bannerBox as HTMLElement & { _t?: number })._t = window.setTimeout(
      () => this.bannerBox.classList.add('hidden'),
      ms
    );
  }

  /**
   * The "NEW NECROTECH MUTATION" reveal. Shows the mutation's own name and what it actually does, in
   * the existing HUD language (same fonts, same tag row, same accent colours) rather than a new one.
   * Auto-dismisses; it never blocks play.
   */
  showMutationDiscovery(def: { name: string; requires: readonly string[]; desc: string; rarity: string; tags: string[]; color: number; named: boolean }, ms = 5200): void {
    const tint = `#${def.color.toString(16).padStart(6, '0')}`;
    const box = this.mutateBox;
    box.textContent = '';
    box.style.borderColor = tint;

    const triple = def.requires.length > 2;
    // ONE headline for every reveal — pair or triple, authored or not: the rarity tag underneath
    // carries the detail, the panel just says what happened (a new Necrotech mutation).
    const head = el('div', 'mr-head', 'NEW NECROTECH MUTATION');
    const name = el('div', 'mr-name', def.name);
    name.style.color = tint;
    // The source classes ("FROST + NOVA + PYRE") are deliberately NOT listed under the name: the
    // name IS the reveal, and repeating the inputs the player just picked was a line, not news.
    const tags = el('div', 'mr-tags');
    for (const t of [`${def.rarity.toUpperCase()}${triple ? ' TRIPLE' : ''}`, ...def.tags]) tags.appendChild(el('span', 'mr-tag', t));
    const desc = el('div', 'mr-desc', def.desc);
    box.append(head, name, tags, desc);
    box.classList.remove('hidden');
    // The card stands EXACTLY where the persistent chips stand (same `bottom` in CSS), so those
    // chips step aside for as long as it is up: the reveal IS the bottom-centre readout here.
    this.pillsRow.classList.add('pills-away');
    // restart the reveal animation
    box.classList.remove('show');
    void box.offsetWidth;
    box.classList.add('show');
    window.clearTimeout((box as HTMLElement & { _t?: number })._t);
    (box as HTMLElement & { _t?: number })._t = window.setTimeout(() => this.endMutationReveal(), ms);
  }

  /**
   * Ends the reveal: the card goes, and the pills it stood in for rise back in from below — the row
   * reads as sliding back up into its live readout rather than blinking on.
   */
  private endMutationReveal(): void {
    const box = this.mutateBox;
    box.classList.remove('show');
    box.classList.add('hidden');
    const row = this.pillsRow;
    row.classList.remove('pills-away');
    row.classList.remove('pills-in');
    void row.offsetWidth;   // re-trigger the rise after a rapid show → dismiss cycle
    row.classList.add('pills-in');
  }

  setConnectionStatus(text: string): void {
    this.connBox.textContent = text;
  }

  setDebugVisible(v: boolean): void {
    this.debugVisible = v;
    this.debugBox.classList.toggle('hidden', !v);
  }

  get isDebugVisible(): boolean {
    return this.debugVisible;
  }

  setDebug(lines: string[]): void {
    if (!this.debugVisible) return;
    this.debugBox.textContent = lines.join('\n');
  }

  // ------------------------------------------------------------ modals

  private buildModals(): void {
    // `levelup` / `pickup` are the two ARCADE pickers: a rotating light-beam fan spins behind the
    // card (see the `.modal.levelup` block in styles.css).
    this.levelUpModal = el('div', 'modal levelup hidden');
    const card = el('div', 'modal-card');
    card.appendChild(el('div', 'panel-title', 'NECROMUTATION — CHOOSE A PERK'));
    // No inline font size: the picker's type scales with the viewport through the CSS (.modal.levelup
    // .modal-card > .muted), so it stays in step with the cards below it.
    const sub = el('div', 'muted', 'You are invulnerable and immobile while choosing. Full heal on selection.');
    card.appendChild(sub);
    this.levelUpPerks = el('div', 'perks');
    card.appendChild(this.levelUpPerks);
    this.levelUpTimer = el('div', 'big-timer', '5.0');
    card.appendChild(this.levelUpTimer);
    this.levelUpModal.appendChild(card);
    this.root.appendChild(this.levelUpModal);

    this.pickupModal = el('div', 'modal pickup hidden');
    const card2 = el('div', 'modal-card');
    card2.appendChild(el('div', 'panel-title', 'NEW NECROTECH'));
    card2.appendChild(el('div', 'muted pickup-sub', 'Ignore it, swap it in, or fuse the two.'));
    this.pickupCols = el('div', 'pickup-cols');
    card2.appendChild(this.pickupCols);
    this.pickupMutateNote = el('div', 'pickup-note', '');
    card2.appendChild(this.pickupMutateNote);
    // Three named actions, one line each: IGNORE / SWAP are the safe reads, MUTATE is the one that
    // can produce a PERMUTATION (or a rare SUPER) — so it is the step-up button, not a floodlight.
    const actions = el('div', 'pickup-actions');
    const pick = (label: string, cap: string, cls: string, choice: 'keep' | 'swap' | 'mutate'): HTMLButtonElement => {
      // `btn` for the shared base (pointer-events, cursor, focus ring) — `.pick-btn` restyles it.
      const b = button('', `btn pick-btn ${cls}`, () => this.cbs.pickupChoice(choice));
      b.appendChild(el('span', 'pl', label));
      b.appendChild(el('span', 'pc', cap));
      return b;
    };
    actions.appendChild(pick('IGNORE', 'leave the drop', 'keep', 'keep'));
    actions.appendChild(pick('SWAP', 'take the drop', 'swap', 'swap'));
    actions.appendChild(pick('MUTATE', 'fuse both', 'mutate', 'mutate'));
    card2.appendChild(actions);
    this.pickupTimer = el('div', 'big-timer', '10.0');
    card2.appendChild(this.pickupTimer);
    this.pickupModal.appendChild(card2);
    this.root.appendChild(this.pickupModal);

    // ---- respawn overlay
    this.respawnModal = el('div', 'modal hidden respawn');
    const rcard = el('div', 'modal-card');
    rcard.appendChild(el('div', 'respawn-title', 'YOU DIED'));
    this.respawnKiller = el('div', 'respawn-killer', 'Necrophages overwhelmed you.');
    rcard.appendChild(this.respawnKiller);
    this.respawnTimer = el('div', 'big-timer', '5.0');
    rcard.appendChild(this.respawnTimer);
    rcard.appendChild(el('div', 'muted', 'Respawning in colony base...')).style.fontSize = '12px';
    this.respawnModal.appendChild(rcard);
    this.root.appendChild(this.respawnModal);

    // ---- Esc menu: a slim side panel so the match stays visible and keeps running.
    this.pauseModal = el('div', 'modal hidden pause');
    const pcard = el('div', 'modal-card pause-card');
    // The header is PINNED (it holds the X); only `.pause-body` below it scrolls, so closing the
    // panel never depends on where the list happens to be scrolled to.
    const phead = el('div', 'pause-head');
    const pheadRow = el('div', 'pause-head-row');
    pheadRow.appendChild(el('div', 'panel-title', 'MENU'));
    const pclose = el('button', 'pause-x') as HTMLButtonElement;
    pclose.type = 'button';
    pclose.setAttribute('aria-label', 'Close the menu');
    pclose.title = 'Close (Esc)';
    pclose.innerHTML = ICON_CLOSE;
    pclose.addEventListener('click', () => this.cbs.closeMenu());
    pheadRow.appendChild(pclose);
    phead.appendChild(pheadRow);
    pcard.appendChild(phead);
    const pbody = el('div', 'pause-body');
    pcard.appendChild(pbody);

    // Room code: the match can be joined at any time, so the code lives here too.
    const proom = el('div', 'pause-room');
    const psec = el('div', 'psec', 'ROOM CODE');
    proom.appendChild(psec);
    const prow = el('div', 'room-row');
    this.pauseRoomCode = el('span', 'room-code', '—');
    prow.appendChild(this.pauseRoomCode);
    prow.appendChild(
      button('COPY', 'btn small', () => {
        const code = this.pauseRoomCode.textContent ?? '';
        if (!code || code === '—') return;
        void navigator.clipboard?.writeText(code);
        this.toast('Room code copied', 1400);
      })
    );
    proom.appendChild(prow);
    this.pauseRoomHint = el('div', 'room-hint', '');
    proom.appendChild(this.pauseRoomHint);
    pbody.appendChild(proom);

    this.pauseStats = el('div', 'pause-stats');
    pbody.appendChild(this.pauseStats);
    this.pauseAbilities = el('div', 'pause-abilities');
    pbody.appendChild(this.pauseAbilities);
    this.pausePerks = el('div', 'pause-perks');
    pbody.appendChild(this.pausePerks);

    const plist = el('div', 'pause-controls');
    plist.innerHTML = `
      <div class="pc"><span class="kbd">W A S D</span> move</div>
      <div class="pc"><span class="kbd">SPACE</span> jump</div>
      <div class="pc"><span class="kbd">SHIFT</span> dash</div>
      <div class="pc"><span class="kbd">SKILL</span> left mouse / E</div>
      <div class="pc"><span class="kbd">ULTIMATE</span> right mouse / Q</div>
      <div class="pc"><span class="kbd">ARROWS</span> aim (replaces cursor)</div>
      <div class="pc"><span class="kbd">WHEEL</span> zoom camera</div>
      <div class="pc"><span class="kbd">ESC</span> close</div>`;
    pbody.appendChild(plist);
    const pbtns = el('div', 'pause-buttons');
    // No CLOSE button at the bottom any more: the X in the header, Esc itself and a tap anywhere
    // outside the card all close the panel, so a third way out was just one more row to read.
    /**
     * One row of the Esc panel's action pair: a lit icon pot + its label. The two actions are given
     * separate tints on purpose — FULLSCREEN only changes the framing, LEAVE MATCH ends the run.
     */
    const mkPauseBtn = (cls: string, icon: string, label: string, onClick: () => void): HTMLButtonElement => {
      const b = button('', `btn pause-btn ${cls}`, onClick);
      const ico = el('span', 'pb-ico', '');
      ico.innerHTML = icon;
      b.appendChild(ico);
      b.appendChild(el('span', 'pb-lbl', label));
      return b;
    };
    // Always usable: where the Element Fullscreen API is missing (iPhone, iOS in-app browsers) the
    // toggle falls back to the immersive mode instead of hiding — a hidden button left the player
    // with no way at all to reclaim the screen (ui/Fullscreen.ts).
    this.fsBtn = mkPauseBtn('pb-fs', ICON_EXPAND, 'FULLSCREEN', () => void this.onFullscreenToggle());
    pbtns.appendChild(this.fsBtn);
    pbtns.appendChild(mkPauseBtn('pb-leave', ICON_EXIT, 'LEAVE MATCH', () => this.cbs.leaveMatch()));
    pbody.appendChild(pbtns);
    // Filled in by refreshFullscreenHint(): says why fullscreen cannot work, instead of the button
    // silently doing nothing (which is what "fullscreen is broken on Safari" always was).
    this.fsHint = el('div', 'fs-hint hidden');
    pbody.appendChild(this.fsHint);
    // Touch devices only: the block that turns "it still zooms" into a named cause — the page zoom
    // scale, what the finger actually hit, that element's touch-action, and the fullscreen state.
    if (IS_TOUCH) {
      this.diag = el('div', 'diag');
      pbody.appendChild(this.diag);
    }
    this.pauseModal.appendChild(pcard);
    this.root.appendChild(this.pauseModal);
    // Covers every source of change: our own toggle, F11 / a gesture, and the home-screen mode.
    onFullscreenChange(() => {
      this.syncFullscreenLabel();
      this.refreshFullscreenHint();
    });
  }

  /**
   * Fullscreen is a plain browser toggle — no game state involved, so it can be flipped from the
   * Esc menu mid-match without touching the running simulation. On iPhone the same button moves
   * between the browser bars and the immersive mode.
   */
  private async onFullscreenToggle(): Promise<void> {
    const before = fullscreenMode();
    const after = await toggleFullscreen();
    this.syncFullscreenLabel();
    this.refreshFullscreenHint();
    const why = fullscreenUnavailableReason() ?? lastFullscreenError();
    if (after === before) {
      // Nothing happened, so say why rather than leaving a button that looks dead.
      const reason = why ?? 'the browser refused the request';
      console.warn('[necrofall] fullscreen:', reason);
      this.banner(`FULLSCREEN UNAVAILABLE — ${reason.toUpperCase()}`, 5000);
      return;
    }
    if (after === 'immersive') this.banner('iOS: SHARE → ADD TO HOME SCREEN FOR TRUE FULLSCREEN', 4200);
    else this.banner(after === 'none' ? 'FULLSCREEN OFF' : 'FULLSCREEN ON', 1400);
  }

  /** The diagnosis shown under the fullscreen button — only when there is something to say. */
  private refreshFullscreenHint(): void {
    const hint = this.fsHint;
    if (!hint) return;
    const mode = fullscreenMode();
    const unavailable = fullscreenUnavailableReason();
    const error = lastFullscreenError();
    if (mode === 'native' || mode === 'standalone' || (!unavailable && !error)) {
      hint.classList.add('hidden');
      return;
    }
    const lines: string[] = [];
    if (unavailable) lines.push(`Fullscreen is not available: ${unavailable}.`);
    if (error) lines.push(`The browser said: ${error}.`);
    if (isAppleTouchDevice() && !isStandalone()) {
      lines.push(
        'FULLSCREEN hides the browser bars (scroll mode). <b>Share → Add to Home Screen</b> opens ' +
          'NECROFALL with no browser UI at all — the only true fullscreen iOS gives a web app.'
      );
    } else if (!window.isSecureContext) {
      lines.push('Serve the page over <b>https://</b> (or from localhost) to enable fullscreen.');
    }
    hint.innerHTML = lines.map(line => `<div>${line}</div>`).join('');
    hint.classList.remove('hidden');
  }

  /** Device-side diagnostics for the touch layer — printed in the pause panel on touch devices. */
  private refreshDiagnostics(): void {
    const node = this.diag;
    if (!node) return;
    const t = touchDiagnostics();
    const fsReason = fullscreenUnavailableReason();
    const fsError = lastFullscreenError();
    // A scale above 1.00 is a zoom that actually happened — with the CSS chain in place it should
    // read 1.00 forever. There is deliberately no "reset" counter any more: nothing fights a zoom
    // after the fact, because WebKit only lets CSS `touch-action` prevent it (TouchGuard.ts).
    node.textContent = [
      `ZOOM ${t.scale.toFixed(2)} · max ${t.maxScale.toFixed(2)}`,
      `LAST TAP ${t.target} · touch-action ${t.targetTouchAction}`,
      `FULLSCREEN ${fullscreenMode()}${fsReason ? ` · ${fsReason}` : ''}${fsError ? ` · ${fsError}` : ''}`,
    ].join('\n');
  }

  /** The label follows reality: the player can also leave fullscreen with F11 or a gesture. */
  private syncFullscreenLabel(): void {
    if (!this.fsBtn) return;
    const mode = fullscreenMode();
    // Home-screen app: already chrome-free, so there is nothing to toggle.
    const usable = mode !== 'standalone';
    this.fsBtn.classList.toggle('hidden', !usable);
    this.fsBtn.disabled = !usable;
    // Only the label span (and the bracket glyph) change — writing `textContent` here would wipe
    // the icon out of the button.
    const label = this.fsBtn.querySelector('.pb-lbl');
    if (label) label.textContent = mode === 'none' ? 'FULLSCREEN' : 'EXIT FULLSCREEN';
    const ico = this.fsBtn.querySelector('.pb-ico');
    if (ico) ico.innerHTML = mode === 'none' ? ICON_EXPAND : ICON_COLLAPSE;
  }

  /** Live snapshot of the player's run, rendered into the Esc panel every frame. */
  private renderPausePanel(d: HudData): void {
    // Room code first: it is the one line that matters to the friends waiting to drop in.
    const code = d.roomCode || '';
    const label = code || '—';
    if (this.pauseRoomCode.textContent !== label) this.pauseRoomCode.textContent = label;
    const hint = code
      ? 'Share it — anybody can join mid-match from the PLAY menu.'
      : 'Offline match — no room code to share.';
    if (this.pauseRoomHint.textContent !== hint) this.pauseRoomHint.textContent = hint;
    this.pauseRoomHint.classList.toggle('offline', !code);
    this.pauseRoomCode.classList.toggle('offline', !code);

    // The panel is BUILT once and then patched, never re-parsed: the old code assigned the three
    // sections' `innerHTML` on every frame the menu was left open, which flickered (the sections
    // are the ABILITIES / MUTATION / PERKS readout) and re-parsed ~1.8 kB of HTML 60 times a second.
    // This signature carries everything that changes the panel's SHAPE — stat row set, kit names,
    // perk list — and a rebuild happens only when it actually changes (a pick, a fusion, a swap).
    const perkSig = (d.perks ?? []).map(p => `${p.name}|${p.desc}`).join(';');
    const sig = [
      d.necrotechName, d.mutated, d.mutationName, d.mutationRarity, d.mutationSources, d.mutationDesc,
      d.mutationTags, d.mutationCount, d.mutationLimit, d.skillName, d.ultName, d.passiveName,
      d.autoTargets, perkSig,
    ].join('§');
    if (sig !== this.pauseSig) {
      this.pauseSig = sig;
      this.buildPauseSections(d, perkSig);
      this.pauseVals = Array.from(this.pauseModal.querySelectorAll<HTMLElement>('[data-w]'));
    }

    // ---- live values: one diff-gated text write per slot, nothing structural
    const cdText = (cd: number, isUlt: boolean): string =>
      cd > 0.15 ? (isUlt ? `${Math.ceil(cd)}s` : `${cd.toFixed(1)}s`) : 'READY';
    for (const node of this.pauseVals) {
      switch (node.dataset.w) {
        case 'hp': setText(node, `${Math.ceil(Math.max(0, d.hp))} / ${Math.round(d.maxHp)}`); break;
        case 'xp': setText(node, `${Math.round(d.xp)} / ${Math.round(d.xpNeed)}`); break;
        case 'lvl': setText(node, `${d.level}`); break;
        case 'dash': setText(node, `${d.dashCharges} / ${d.dashMax}`); break;
        case 'cdS': setText(node, cdText(d.skillCd, false)); break;
        case 'cdU': setText(node, cdText(d.ultCd, true)); break;
        case 'cdM': setText(node, `${d.mutationCount} / ${d.mutationLimit}`); break;
        default: break;
      }
    }
  }

  /**
   * One-shot HTML build for the Esc panel, with a `data-w` slot on every value that changes while
   * the menu sits open. Called from `renderPausePanel` only when the structural signature moves.
   */
  private buildPauseSections(d: HudData, _perkSig: string): void {
    // `v` seeds the slot so a freshly built panel is never empty for the frame before the patch
    const stat = (k: string, v: string, slot = ''): string =>
      `<div class="pstat"><span class="pk">${k}</span><span class="pv"${slot ? ` data-w="${slot}"` : ''}>${v}</span></div>`;
    // One ability block: icon + name + cooldown, then what the ability actually does.
    const ability = (label: string, name: string, desc: string, cd: string, slot: string, isUlt: boolean): string =>
      `<div class="pabi">` +
      `<div class="pab">` +
      `<span class="pico">${abilityIcon(name, desc, isUlt)}</span>` +
      `<span class="pk">${label}</span>` +
      `<span class="pv">${name}</span>` +
      `<span class="pc2"${slot ? ` data-w="${slot}"` : ''}>${cd}</span>` +
      `</div>` +
      `<div class="pdesc">${desc || '—'}</div>` +
      `</div>`;
    const cdText = (cd: number, isUlt: boolean): string =>
      cd > 0.15 ? (isUlt ? `${Math.ceil(cd)}s` : `${cd.toFixed(1)}s`) : 'READY';
    this.pauseStats.innerHTML =
      stat('HEALTH', `${Math.ceil(Math.max(0, d.hp))} / ${Math.round(d.maxHp)}`, 'hp') +
      stat('NECROMUTATION', `${Math.round(d.xp)} / ${Math.round(d.xpNeed)}`, 'xp') +
      stat('LEVEL', `${d.level}`, 'lvl') +
      stat('DASHES', `${d.dashCharges} / ${d.dashMax}`, 'dash') +
      // the level-scaling multishot: only worth a row once it is more than the base single target
      (d.autoTargets > 1 ? stat('SIMULTANEOUS FIRE', `${d.autoTargets} TARGETS`) : '') +
      stat('NECROTECH', `${d.necrotechName}${d.mutated === 2 ? ' (SUPER)' : d.mutated ? ' (MUTATED)' : ''}`) +
      // The mutation readout: the loadout's own name plus the hard cap, so a player can always check
      // how much room is left before the next fusion has to replace something.
      (d.mutated
        ? stat('MUTATIONS', `${d.mutationCount} / ${d.mutationLimit}`, 'cdM')
        : '');
    this.pauseAbilities.innerHTML =
      `<div class="psec">ABILITIES</div>` +
      ability('SKILL · E', d.skillName, d.skillDesc, cdText(d.skillCd, false), 'cdS', false) +
      ability('ULTIMATE · Q', d.ultName, d.ultDesc, cdText(d.ultCd, true), 'cdU', true) +
      // the passive rides with the kit: always on, no cooldown, so it reads as a third ability block
      ability('PASSIVE', d.passiveName, d.passiveDesc, 'ALWAYS ON', '', false) +
      // the mutation is the fourth block: its own name, its two source Necrotechs and what the
      // permutation does, spelled out where a player already goes to read their build
      (d.mutated && d.mutationName
        ? `<div class="psec">MUTATION</div>` +
          ability(
            d.mutationRarity || 'MUTATION',
            d.mutationName,
            `${d.mutationSources} — ${d.mutationDesc}${d.mutationTags ? ` [${d.mutationTags}]` : ''}`,
            `${d.mutationCount} / ${d.mutationLimit}`,
            'cdM',
            false
          )
        : '');
    this.pausePerks.innerHTML =
      `<div class="psec">PERKS</div>` +
      ((d.perks ?? []).length
        ? d.perks.map(p => `<div class="pstat"><span class="pv">${p.name}</span><span class="pk2">${p.desc}</span></div>`).join('')
        : '<div class="muted" style="font-size:11px">No perks yet — level up by killing Necrophages.</div>');
  }

  // ------------------------------------------------------------ death / pause

  showRespawn(seconds: number, killer: string | null): void {
    this.respawnKiller.textContent = killer ? `Eliminated by ${killer}` : 'Necrophages overwhelmed you.';
    setText(this.respawnTimer, seconds.toFixed(1));
    this.respawnModal.classList.remove('hidden');
  }

  tickRespawn(seconds: number): void {
    if (this.respawnModal.classList.contains('hidden')) return;
    setText(this.respawnTimer, Math.max(0, seconds).toFixed(1));
  }

  hideRespawn(): void {
    this.respawnModal.classList.add('hidden');
  }

  showPauseMenu(): void {
    this.pauseModal.classList.remove('hidden');
    // The Esc card sits on top of the radar — drop the radar so it does not shine through.
    this.hud.classList.add('menu-open');
    this.syncFullscreenLabel();
    this.refreshFullscreenHint();
    this.refreshDiagnostics();
    // A press anywhere outside the card closes the menu again (see `onPauseOutside`).
    window.addEventListener('pointerdown', this.onPauseOutside, true);
  }

  hidePauseMenu(): void {
    this.pauseModal.classList.add('hidden');
    this.hud.classList.remove('menu-open');
    window.removeEventListener('pointerdown', this.onPauseOutside, true);
  }

  /**
   * Dismiss the Esc menu the moment the player presses the world — the game screen itself or any HUD
   * button. On a phone the panel is a detour, not a mode, and hunting for CLOSE under a thumb was
   * the worst part of it. The press is CONSUMED: closing the menu must never also fire whatever
   * ability happened to sit under the finger.
   */
  private onPauseOutside = (e: PointerEvent): void => {
    const t = e.target as Node | null;
    const card = this.pauseModal.querySelector('.pause-card');
    if (t && card && card.contains(t)) return;   // inside the panel: normal interaction
    e.preventDefault();
    e.stopPropagation();
    this.cbs.closeMenu();
  };

  get pauseOpen(): boolean {
    return !this.pauseModal.classList.contains('hidden');
  }

  /** True while a full-screen overlay owns the view (Necromutation, Necrotech, respawn). */
  get overlayOpen(): boolean {
    return !this.levelUpModal.classList.contains('hidden')
      || !this.pickupModal.classList.contains('hidden')
      || !this.respawnModal.classList.contains('hidden');
  }

  /**
   * The picker's tier language: green = a plain stat gain, blue = an upgraded kit piece, violet =
   * the best of the numeric picks, gold = the GAME-CHANGING picks (they rewrite how the body moves
   * and kills). Keyed by the PERK (`Perk.tier`), never by its seat — `Game.openLevelUp` shuffles the
   * three seats on every deal, so the colours land in a different position each level-up.
   */
  private static readonly TIER_TINTS: Record<PerkTier, { hex: number; css: string }> = {
    common: { hex: 0x4dffa6, css: '#4dffa6' },
    rare: { hex: 0x63d2ff, css: '#63d2ff' },
    mythic: { hex: 0xc94dff, css: '#c94dff' },
    legendary: { hex: 0xffd666, css: '#ffd666' },
  };

  showLevelUp(perks: { name: string; desc: string; tier?: PerkTier; pills?: { v: string; l: string; k: 'up' | 'down' | 'alt' }[] }[], seconds: number): void {
    this.levelUpPerks.innerHTML = '';
    this.perkButtons.length = 0;
    perks.forEach((p, idx) => {
      const card = el('div', 'perk');
      // The card wears ITS PERK's tier colour — the colour describes the pick, the seat means
      // nothing. All three fly in on the SAME beat (the picker runs on a countdown, so a delayed
      // deal would only cost the player reaction time), and there is deliberately NO 1-2-3 badge.
      const tier = p.tier ?? 'common';
      const tint = UI.TIER_TINTS[tier];
      tintCard(card, tint.hex, tint.css);
      // the tier also rides as a CLASS: the stat chips inside the card take the SAME colour, so the
      // whole card reads as one thing (a gold game-changing pick must not show a violet chip — see
      // `.perk.tier-* .pill` in styles.css)
      card.classList.add(`tier-${tier}`);
      card.appendChild(el('div', 'perk-glyph', '◆'));
      card.appendChild(el('h5', '', p.name));
      // The numbers ride a row of coloured pills ABOVE the sentence: green = a gain, red = a cost,
      // violet = an effect that is not a percentage at all. The prose stays underneath for anyone
      // who wants the full wording, but the choice is readable from the pills alone.
      const pills = el('div', 'perk-pills');
      for (const pill of p.pills ?? []) {
        const node = el('span', `pill ${pill.k}`);
        node.appendChild(el('b', '', pill.v));
        node.appendChild(el('i', '', pill.l));
        pills.appendChild(node);
      }
      if (pills.childElementCount) card.appendChild(pills);
      card.appendChild(el('p', '', p.desc));
      card.addEventListener('click', () => this.cbs.perkPick(idx));
      this.levelUpPerks.appendChild(card);
      this.perkButtons.push(card);
    });
    setText(this.levelUpTimer, seconds.toFixed(1));
    this.levelUpModal.classList.remove('hidden');
  }

  tickLevelUpTimer(seconds: number): void {
    if (this.levelUpModal.classList.contains('hidden')) return;
    setText(this.levelUpTimer, Math.max(0, seconds).toFixed(1));
  }

  hideLevelUp(): void {
    this.levelUpModal.classList.add('hidden');
  }

  showPickup(
    current: { name: string; role: string; rows: string[] },
    next: { name: string; role: string; rows: string[] },
    mutateNote: string,
    seconds: number
  ): void {
    this.pickupCols.innerHTML = '';
    /**
     * One side of the offer, in the picker's own card language: a header chip, the class in its
     * colour, and its kit as tagged rows (the "Skill — Flamewave" strings arrive from the game and
     * are split here). The RECOVERED side is the bright one — it is the card that just changed.
     */
    const mk = (label: string, info: { name: string; role: string; rows: string[] }, color: string, fresh: boolean): void => {
      const col = el('div', fresh ? 'pickup-col fresh' : 'pickup-col');
      col.style.setProperty('--col', color);
      col.appendChild(el('div', 'pickup-tag', label));
      const nm = el('div', 'nm', info.name);
      nm.style.color = color;
      col.appendChild(nm);
      col.appendChild(el('div', 'role', info.role));
      const kit = el('div', 'pickup-kit');
      for (const r of info.rows) {
        const row = el('div', 'pickup-row');
        const at = r.indexOf(' — ');
        const tag = at >= 0 ? r.slice(0, at) : '';
        const val = at >= 0 ? r.slice(at + 3) : r;
        if (tag) row.appendChild(el('span', `tag ${tag.toLowerCase()}`, tag.toUpperCase()));
        row.appendChild(el('b', '', val));
        kit.appendChild(row);
      }
      col.appendChild(kit);
      this.pickupCols.appendChild(col);
    };
    mk('CURRENT', current, '#b9a8d8', false);
    mk('NEW', next, '#e0a2ff', true);
    this.pickupMutateNote.textContent = mutateNote;
    setText(this.pickupTimer, seconds.toFixed(1));
    this.pickupModal.classList.remove('hidden');
  }

  tickPickupTimer(seconds: number): void {
    if (this.pickupModal.classList.contains('hidden')) return;
    setText(this.pickupTimer, Math.max(0, seconds).toFixed(1));
  }

  hidePickup(): void {
    this.pickupModal.classList.add('hidden');
  }

  // ------------------------------------------------------------ results

  showResults(data: ResultsData): void {
    if (this.resultsScreen) this.resultsScreen.remove();
    const s = el('div', 'screen results-screen');
    s.appendChild(el('div', `results-vignette ${data.victory ? 'win' : 'lose'}`));
    // Everything lives in one auto-margined column: centred while it fits, scrollable when it
    // does not, so no verdict, stat or button is ever clipped on a short or narrow viewport.
    const inner = el('div', 'results-inner');
    s.appendChild(inner);

    // ---- header: emblem, verdict, colony (or the reason nothing was claimed)
    const head = el('div', 'results-head');
    const emblem = el('div', `results-emblem ${data.victory ? 'win' : 'lose'}`, data.victory ? '◈' : '☠');
    head.appendChild(emblem);
    head.appendChild(el('div', `results-title ${data.victory ? 'win' : 'lose'}`, data.victory ? 'PLANET CLAIMED' : 'NECROPHAGES WIN'));
    const sub = data.victory && data.winnerColony !== null
      ? COLONIES[data.winnerColony].name
      : (data.reason ?? 'TIME EXPIRED — NO COLONY CLAIMED THE PLANET');
    const colonyEl = el('div', 'results-colony', sub);
    if (data.victory && data.winnerColony !== null) colonyEl.style.color = COLONIES[data.winnerColony].css;
    head.appendChild(colonyEl);
    if (data.matchTime) head.appendChild(el('div', 'results-time', `MATCH LENGTH ${data.matchTime}`));
    inner.appendChild(head);

    // ---- headline numbers, big and readable
    if (data.hero && data.hero.length) {
      const strip = el('div', 'results-hero');
      for (const h of data.hero) {
        const cell = el('div', 'results-hero-cell');
        const v = el('div', 'v', h.value);
        if (h.accent) v.style.color = h.accent;
        cell.appendChild(v);
        cell.appendChild(el('div', 'k', h.label));
        strip.appendChild(cell);
      }
      inner.appendChild(strip);
    }

    const grid = el('div', 'results-grid');

    // ---- towers as chips, coloured by owner
    const towers = el('div', 'panel');
    towers.appendChild(el('div', 'panel-title', 'TOWER CONTROL'));
    const chips = el('div', 'tower-chips');
    for (const t of data.tiles) {
      const chip = el('div', `tower-chip${t.owner >= 0 ? '' : ' free'}`);
      const dot = el('span', 'dot');
      dot.style.background = t.owner >= 0 ? COLONIES[t.owner].css : '#4b3f63';
      if (t.owner >= 0) dot.style.boxShadow = `0 0 12px ${COLONIES[t.owner].css}`;
      chip.appendChild(dot);
      chip.appendChild(el('span', 'nm', t.label));
      chips.appendChild(chip);
    }
    towers.appendChild(chips);
    const owned = data.tiles.filter(t => t.owner >= 0).length;
    towers.appendChild(el('div', 'tower-count', `${owned} / ${data.tiles.length} TOWERS CAPTURED`));

    if (data.standings && data.standings.length) {
      const bars = el('div', 'standings');
      const best = Math.max(1, ...data.standings.map(x => x.towers));
      for (const st of data.standings) {
        const row = el('div', 'standings-row');
        const nm = el('span', 'nm', st.name);
        nm.style.color = st.color;
        row.appendChild(nm);
        const track = el('div', 'track');
        const fill = el('div', 'fill');
        fill.style.width = `${Math.round((st.towers / best) * 100)}%`;
        fill.style.background = st.color;
        track.appendChild(fill);
        row.appendChild(track);
        row.appendChild(el('span', 'n', `${st.towers}`));
        bars.appendChild(row);
      }
      towers.appendChild(bars);
    }
    grid.appendChild(towers);

    const stats = el('div', 'panel');
    stats.appendChild(el('div', 'panel-title', 'MATCH REPORT'));
    const sg = el('div', 'stats-grid');
    for (const st of data.stats) {
      sg.appendChild(el('div', 'k', st.k));
      sg.appendChild(el('div', 'v', st.v));
    }
    stats.appendChild(sg);
    grid.appendChild(stats);
    inner.appendChild(grid);

    const back = button('RETURN TO MAIN MENU', 'btn primary', () => this.cbs.returnToMenu());
    back.style.marginTop = '22px';
    inner.appendChild(back);

    this.reg('results', s);
    this.resultsScreen = s;
    this.show('results');
  }

  // ------------------------------------------------------------ mobile

  private buildMobile(): void {
    const m = this.mobile;
    document.body.classList.toggle('nf-touch', IS_TOUCH);

    // ---- left thumb: movement stick (a <button> for the same iOS reason as the cluster below).
    // It is FLOATING: the button is the resting hint in the lower-left corner, and the drag gesture
    // can start anywhere on the lower-left half of the WORLD — see `joyDown` below.
    const joy = el('button', 'joy idle');
    joy.type = 'button';
    joy.tabIndex = -1;
    const knob = el('div', 'knob');
    joy.appendChild(knob);
    m.appendChild(joy);

    // ---- right thumb: the big DASH button mirrors the movement stick (same size, opposite side).
    // Jump / Skill / Ultimate fan out into its top-left quadrant, MOBA style, each labelled like the
    // desktop rail, and a Beacon button appears to the left of Jump whenever a friendly Beacon can
    // be fired.
    const cluster = el('div', 'm-cluster');
    // Real <button> elements: correct semantics (focusable, AT-friendly), and they carry the
    // explicit `touch-action: manipulation` below. What actually stopped the iOS double-tap zoom
    // was the touch-action CHAIN, not the element type — see the note in styles.css: a single
    // `none` above a button intersects the opt-out away. The cluster never becomes an ancestor of
    // a `none` subtree: the stick is the only `none` surface and it holds no buttons.
    const mk = (cls: string, tag: string): { box: HTMLElement; cd: HTMLElement; ico: HTMLElement; name: HTMLElement } => {
      const box = el('button', `mbtn ${cls}`);
      box.type = 'button';
      box.tabIndex = -1;          // the cluster is touch-only: never steal keyboard focus
      box.appendChild(el('div', 'm-tag', tag));
      const ico = el('div', 'm-ico');
      box.appendChild(ico);
      const cd = el('div', 'm-cd', '');
      box.appendChild(cd);
      const nm = el('div', 'm-name', '');
      box.appendChild(nm);
      cluster.appendChild(box);
      return { box, cd, ico, name: nm };
    };
    const dash = mk('dash', 'DASH');
    const dashCount = el('div', 'm-count', '3');
    dash.box.appendChild(dashCount);
    const jump = mk('jump', 'JUMP');
    // ground leap + the free mid-air leap: the counter starts at 2, never 1
    const jumpCount = el('div', 'm-count', `${CONFIG.player.baseJumps + 1}`);
    jump.box.appendChild(jumpCount);
    const skill = mk('skill', '');
    const ult = mk('ult', '');
    const beacon = mk('beacon', 'BEACON');
    // the ability's own glyph, the same one the desktop rail shows
    beacon.ico.innerHTML = ICON_BEACON;
    // Jump and dash carry the desktop rail's glyphs too — a bare "JUMP" / "DASH" word left the two
    // buttons that are pressed most often as the only unlabelled-by-shape controls on the pad.
    jump.ico.innerHTML = ICON_JUMP;
    dash.ico.innerHTML = ICON_DASH;
    this.mDashCount = dashCount;
    this.mJumpCount = jumpCount;
    this.mSkillCd = skill.cd;
    this.mUltCd = ult.cd;
    this.mSkillBtn = skill.box;
    this.mUltBtn = ult.box;
    this.mSkillIco = skill.ico;
    this.mUltIco = ult.ico;
    this.mJumpBtn = jump.box;
    this.mBeaconBtn = beacon.box;
    this.mSkillName = skill.name;
    this.mUltName = ult.name;
    m.appendChild(cluster);
    this.root.appendChild(m);

    const bindButton = (node: HTMLElement, action: () => void): void => {
      node.addEventListener('pointerdown', e => {
        e.preventDefault();
        action();
        node.style.opacity = '0.6';
      });
      const up = (): void => {
        node.style.opacity = '1';
      };
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
      node.addEventListener('pointerleave', up);
    };
    bindButton(jump.box, () => this.input?.queueJump());
    bindButton(dash.box, () => this.input?.queueDash());
    bindButton(beacon.box, () => this.input?.queueBeacon());

    // ---- abilities: drag the button itself to aim, like a MOBA skill button.
    // Press and drag away from the button to swing the aim (the ground chevron follows), release to
    // fire. A quick tap fires along the aim you already had.
    const AIM_DRAG = 54;   // px of drag for a full deflection
    const bindAimButton = (node: HTMLElement, kind: 'skill' | 'ult', cast: () => void): void => {
      let id = -1;
      let sx = 0;
      let sy = 0;
      let dragged = false;
      node.addEventListener('pointerdown', e => {
        e.preventDefault();
        id = e.pointerId;
        sx = e.clientX;
        sy = e.clientY;
        dragged = false;
        try {
          node.setPointerCapture(e.pointerId);
        } catch {
          /* capture is best-effort */
        }
        node.classList.add('aiming');
        // hold-to-aim: the game brightens this ability's ground footprint until release
        this.input?.setAiming(kind);
      });
      node.addEventListener('pointermove', e => {
        if (e.pointerId !== id) return;
        const dx = e.clientX - sx;
        const dy = e.clientY - sy;
        const len = Math.hypot(dx, dy);
        if (len > 7) dragged = true;
        if (len < 1e-3) return;
        const k = Math.min(1, len / AIM_DRAG);
        // screen-space direction -> world aim, resolved against the fixed camera by InputManager
        this.input?.setTouchAim((dx / len) * k, (-dy / len) * k, true);
      });
      const end = (e: PointerEvent): void => {
        if (e.pointerId !== id) return;
        id = -1;
        node.classList.remove('aiming');
        this.input?.setAiming(null);
        // releasing stops the drag updating the aim but keeps the direction for the world chevron
        if (dragged) this.input?.setTouchAim(0, 0, false);
        // a long press was an INSPECT, not a cast: it reads the skill's description instead
        if (node.dataset.inspect === '1') return;
        cast();
      };
      node.addEventListener('pointerup', end);
      node.addEventListener('pointercancel', end);
    };
    bindAimButton(skill.box, 'skill', () => this.input?.queueSkill());
    bindAimButton(ult.box, 'ult', () => this.input?.queueUlt());

    // joystick — FLOATING: the base jumps under the thumb wherever the press lands in the
    // lower-left half of the world, and eases back to its corner hint when the thumb lifts. A
    // fixed circle asks the player to find it without looking, which is exactly what the thumb
    // cannot do mid-fight; a floating one always starts under the finger that is already there.
    let joyId = -1;
    const setKnob = (dx: number, dy: number): void => {
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    /** Travel that means "full deflection" — the knob stops at the rim, never past it. */
    const joyTravel = (): number => Math.max(28, joy.offsetWidth * 0.34);
    const joyMove = (e: PointerEvent): void => {
      const rect = joy.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const travel = joyTravel();
      let dx = e.clientX - cx;
      let dy = e.clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > travel) {
        dx = (dx / len) * travel;
        dy = (dy / len) * travel;
      }
      setKnob(dx, dy);
      this.input?.setJoystick(dx / travel, -dy / travel, true);
    };
    /** Puts the stick under the thumb, clamped so the whole circle stays inside the screen. */
    const joyTo = (x: number, y: number): void => {
      const size = joy.offsetWidth || 132;
      const half = size / 2;
      const cx = Math.min(Math.max(x, half + 6), window.innerWidth - half - 6);
      const cy = Math.min(Math.max(y, half + 6), window.innerHeight - half - 6);
      joy.classList.add('floating');
      joy.classList.remove('idle');
      joy.style.left = `${Math.round(cx - half)}px`;
      joy.style.top = `${Math.round(cy - half)}px`;
    };
    const joyHome = (): void => {
      joy.style.left = '';
      joy.style.top = '';
      joy.classList.remove('floating');
      joy.classList.add('idle');
    };
    /** The movement lane: the lower-left half of the screen, where the thumb rests anyway. */
    const inMoveLane = (x: number, y: number): boolean =>
      x < window.innerWidth * 0.5 && y > window.innerHeight * 0.35;
    const joyDown = (e: PointerEvent): void => {
      if (e.pointerType === 'mouse') return;                  // the floating stick is for fingers / pens
      if (this.mobile.classList.contains('hidden')) return;   // not in a match
      // A picker owns the whole screen while it is up — never start a drag through it.
      if (this.overlayOpen || !this.pauseModal.classList.contains('hidden')) return;
      const target = e.target as HTMLElement | null;
      const onWorld = !!target && target.tagName === 'CANVAS';
      // Only the world (or the resting stick itself) starts a move; a press on any real control
      // belongs to that control.
      if (!onWorld && target !== joy && target !== knob) return;
      if (joyId !== -1 || !inMoveLane(e.clientX, e.clientY)) return;
      joyId = e.pointerId;
      joyTo(e.clientX, e.clientY);
      try {
        joy.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      // Cancel the compatibility mouse events a touch on the canvas would otherwise synthesise: the
      // world's mouse handler reads `mousedown` as "press and hold to aim", so a drag to MOVE must
      // not end with a Skill flying out where the thumb happened to be lifted.
      if (onWorld) e.preventDefault();
      joyMove(e);
    };
    const joyEnd = (e: PointerEvent): void => {
      if (e.pointerId !== joyId) return;
      joyId = -1;
      setKnob(0, 0);
      this.input?.setJoystick(0, 0, false);
      joyHome();
    };
    window.addEventListener('pointerdown', joyDown, { passive: false });
    window.addEventListener('pointermove', e => {
      if (e.pointerId === joyId) joyMove(e);
    });
    window.addEventListener('pointerup', joyEnd);
    window.addEventListener('pointercancel', joyEnd);
  }

  bindMobile(input: InputManager): void {
    this.input = input;
  }
}
