// NECROFALL — the LOBBY route (#/lobby): the PLAY screen in its PICKED state.
// Picking CLASSIC on #/play shrinks the format cards and drops this setup in;
// the party screen's back chevron and deep links land here. The page itself is
// PlayPage — this is only the entry point.
import { ShellContext } from '../ShellContext';
import { PlayPage } from './PlayPage';

export class LobbyPage extends PlayPage {
  constructor(ctx: ShellContext) {
    super(ctx, true);
  }
}
