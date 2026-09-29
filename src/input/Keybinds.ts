// NECROFALL — control remapping (plan §37): one shared table of action → key.
// The game's InputManager reads it on every event, the account's
// `player_settings` row persists it, and the controls sheet edits it.
// Codes are KeyboardEvent.code strings ('KeyW', 'Space', 'ShiftLeft', ...).

export type BindAction = 'up' | 'down' | 'left' | 'right' | 'jump' | 'dash' | 'skill' | 'ult' | 'beacon' | 'recall';

export const BIND_ORDER: BindAction[] = ['up', 'down', 'left', 'right', 'jump', 'dash', 'skill', 'ult', 'beacon', 'recall'];

export const BIND_LABELS: Record<BindAction, string> = {
  up: 'Move forward',
  down: 'Move back',
  left: 'Move left',
  right: 'Move right',
  jump: 'Jump',
  dash: 'Dash',
  skill: 'Skill',
  ult: 'Ultimate',
  beacon: 'Beacon ability',
  recall: 'Recall',
};

export const DEFAULT_BINDS: Record<BindAction, string> = {
  up: 'KeyW',
  down: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  dash: 'ShiftLeft',
  skill: 'KeyE',
  ult: 'KeyQ',
  beacon: 'KeyF',
  // RECALL on the keyboard (user ask 2026-09-30): R, next to the movement cluster.
  recall: 'KeyR',
};

/** Friendly label for a key code: 'KeyW' → 'W', 'Space' → 'SPACE', 'ArrowUp' → 'UP'. */
export function keyLabel(code: string): string {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return code.slice(5).toUpperCase();
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'SHIFT';
  if (code === 'ControlLeft' || code === 'ControlRight') return 'CTRL';
  if (code === 'AltLeft' || code === 'AltRight') return 'ALT';
  return code.toUpperCase();
}

class KeybindsStore {
  static readonly shared = new KeybindsStore();

  private binds: Record<BindAction, string> = { ...DEFAULT_BINDS };
  private reverse = new Map<string, BindAction>();
  /** The last payload applied from the account row — hydrate() only acts on change. */
  private hydrated = '';
  private listeners = new Set<() => void>();

  constructor() {
    this.rebuild();
  }

  private rebuild(): void {
    this.reverse.clear();
    for (const action of BIND_ORDER) {
      const code = this.binds[action];
      if (code) this.reverse.set(code, action);
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    for (const cb of [...this.listeners]) cb();
  }

  get(action: BindAction): string {
    return this.binds[action];
  }

  /** Which action a key code triggers right now (null = unbound). */
  actionFor(code: string): BindAction | null {
    const hit = this.reverse.get(code);
    if (hit) return hit;
    // the default dash also answers the right-hand shift key
    if (code === 'ShiftRight' && this.binds.dash === 'ShiftLeft') return 'dash';
    return null;
  }

  /** Which action already owns `code` (used by the editor for conflict checks). */
  owner(code: string): BindAction | null {
    return this.actionFor(code);
  }

  /** Rebind one action. A colliding action falls back to its default so nothing goes unbound. */
  set(action: BindAction, code: string): void {
    for (const other of BIND_ORDER) {
      if (other !== action && this.binds[other] === code) this.binds[other] = DEFAULT_BINDS[other];
    }
    this.binds[action] = code;
    this.rebuild();
    this.changed();
  }

  reset(): void {
    this.binds = { ...DEFAULT_BINDS };
    this.rebuild();
    this.changed();
  }

  serialize(): string {
    return JSON.stringify(this.binds);
  }

  /** Apply the account's authoritative payload (empty/null = defaults). */
  hydrate(json: string | null | undefined): void {
    const payload = (json ?? '').trim();
    if (payload === this.hydrated) return;
    this.hydrated = payload;
    const next = { ...DEFAULT_BINDS };
    if (payload) {
      try {
        const parsed = JSON.parse(payload) as Partial<Record<BindAction, string>>;
        for (const action of BIND_ORDER) {
          const value = parsed[action];
          if (typeof value === 'string' && value.length > 0 && value.length <= 32) next[action] = value;
        }
      } catch {
        /* malformed payload — keep the defaults */
      }
    }
    this.binds = next;
    this.rebuild();
    this.changed();
  }
}

export const Keybinds = KeybindsStore.shared;
