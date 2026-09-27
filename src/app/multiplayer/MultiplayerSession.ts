// NECROFALL — the active multiplayer session (plan §10).
//
// A single mutable record the shell and the game seam can consult: which mode
// is live, which provider owns it and (for official play) which match.
import { MultiplayerMode } from './MultiplayerMode';
import { MultiplayerProvider } from './MultiplayerProvider';

export interface MultiplayerSessionState {
  mode: MultiplayerMode;
  provider: MultiplayerProvider | null;
  officialMatchId: number;
}

function createSession(): MultiplayerSessionState {
  return { mode: 'official', provider: null, officialMatchId: 0 };
}

let session = createSession();

export const MultiplayerSession = {
  get state(): MultiplayerSessionState {
    return session;
  },
  begin(mode: MultiplayerMode, provider: MultiplayerProvider | null): void {
    session = { mode, provider, officialMatchId: 0 };
  },
  setOfficialMatch(matchId: number): void {
    session.officialMatchId = matchId;
  },
  end(): void {
    session = createSession();
  },
};
