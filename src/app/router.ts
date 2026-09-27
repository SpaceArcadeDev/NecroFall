// NECROFALL — hash router for the account shell (plan §87: app/router).
//
// Routes are deliberately few: the shell is a lobby, not a website.
//   #/home            — the MOBA-style main menu
//   #/play            — the CLASSIC / RANK format menu
//   #/lobby           — the LOBBY screen (official party or P2P entry)
//   #/party           — the OFFICIAL PARTY screen (its own menu page)
//   #/profile/<hex>   — a player profile
// Login, onboarding, matchmaking and the loading screen are STATE, not routes.
export type Route =
  | { name: 'home' }
  | { name: 'play' }
  | { name: 'lobby' }
  | { name: 'party' }
  | { name: 'profile'; hex: string };

export function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [head, arg] = hash.split('/');
  if (head === 'play') return { name: 'play' };
  if (head === 'lobby') return { name: 'lobby' };
  if (head === 'party') return { name: 'party' };
  if (head === 'profile' && arg) return { name: 'profile', hex: arg.toLowerCase() };
  return { name: 'home' };
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'play':
      return '#/play';
    case 'lobby':
      return '#/lobby';
    case 'party':
      return '#/party';
    case 'profile':
      return `#/profile/${route.hex}`;
    default:
      return '#/home';
  }
}

export function navigate(route: Route): void {
  const hash = routeToHash(route);
  if (window.location.hash !== hash) window.location.hash = hash;
}

export function onRouteChange(cb: (route: Route) => void): () => void {
  const handler = (): void => cb(parseRoute());
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
}
