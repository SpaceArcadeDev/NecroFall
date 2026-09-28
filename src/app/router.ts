// NECROFALL — hash router for the account shell (plan §87: app/router).
//
// Routes are deliberately few: the shell is a lobby, not a website.
//   #/home            — the MOBA-style main menu
//   #/play            — the CLASSIC / RANK format menu
//   #/lobby           — the LOBBY SETUP screen (colony row + JOIN / CREATE LOBBY)
//   #/room            — the LOBBY ROOM itself (the P2P lobby's dress; old #/party kept as alias)
//   #/rank            — the RANK mode: the intergalactic map (plan §48)
//   #/graphics        — the GRAPHICS settings page (preset + frame-rate cap)
//   #/match/<id>      — an OFFICIAL match by id: shareable, join or rejoin midway
//   #/profile/<hex>   — a player profile
// Login, onboarding, matchmaking and the loading screen are STATE, not routes.
export type Route =
  | { name: 'home' }
  | { name: 'play' }
  | { name: 'lobby' }
  | { name: 'room' }
  | { name: 'rank' }
  | { name: 'graphics' }
  | { name: 'match'; id: number }
  | { name: 'profile'; hex: string };

export function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [head, arg] = hash.split('/');
  if (head === 'play') return { name: 'play' };
  if (head === 'lobby') return { name: 'lobby' };
  if (head === 'room' || head === 'party') return { name: 'room' };
  if (head === 'rank') return { name: 'rank' };
  if (head === 'graphics') return { name: 'graphics' };
  if (head === 'match' && arg) {
    const id = Number(arg);
    if (Number.isFinite(id) && id > 0) return { name: 'match', id: Math.floor(id) };
  }
  if (head === 'profile' && arg) return { name: 'profile', hex: arg.toLowerCase() };
  return { name: 'home' };
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'play':
      return '#/play';
    case 'lobby':
      return '#/lobby';
    case 'room':
      return '#/room';
    case 'rank':
      return '#/rank';
    case 'graphics':
      return '#/graphics';
    case 'match':
      return `#/match/${route.id}`;
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
