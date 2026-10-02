// NECROFALL — the shell's UI router (overhaul §2).
//
// The hash router (`app/router.ts`) owns URL state; THIS router owns the
// transition itself: it stamps `document.documentElement.dataset.uiScreen`,
// keeps the previous-screen context and broadcasts `nf:ui:navigate` so motion,
// audio and the dev audit can all hook ONE event instead of per-screen code.
// Screens never reload the page — the shell swaps compositions in place.

export type UIScreen =
  | 'boot'
  | 'login'
  | 'onboarding'
  | 'main'
  | 'profile'
  | 'play'
  | 'lobby'
  | 'rank'
  | 'solo'
  | 'custom'
  | 'events'
  | 'queue'
  | 'match'
  | 'graphics'
  | 'loading';

export interface ScreenContext {
  previous?: UIScreen;
  modeId?: string;
  playerId?: string;
}

export interface ScreenNavigateDetail {
  screen: UIScreen;
  previous: UIScreen;
  context: ScreenContext;
}

export class UIRouter {
  private current: UIScreen = 'boot';
  private context: ScreenContext = {};
  private listeners = new Set<(detail: ScreenNavigateDetail) => void>();

  navigate(screen: UIScreen, context: ScreenContext = {}): void {
    const previous = this.current;
    if (previous === screen) {
      this.context = { ...this.context, ...context };
      return;
    }
    this.current = screen;
    this.context = { previous, ...context };
    document.documentElement.dataset.uiScreen = screen;
    const detail: ScreenNavigateDetail = { screen, previous, context: this.context };
    window.dispatchEvent(new CustomEvent<ScreenNavigateDetail>('nf:ui:navigate', { detail }));
    for (const cb of this.listeners) cb(detail);
  }

  /** Contextual back: children fall to their recorded parent, else main. */
  back(): void {
    const previous = this.context.previous;
    if (previous && previous !== this.current) {
      this.navigate(previous);
      return;
    }
    if (this.current !== 'main') this.navigate('main');
  }

  getScreen(): UIScreen {
    return this.current;
  }

  getContext(): ScreenContext {
    return this.context;
  }

  onNavigate(cb: (detail: ScreenNavigateDetail) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

export const uiRouter = new UIRouter();
