import { startBoardWatcher } from './content/observer';
import { startColoring } from './content/coloring';
import { startBanner } from './content/banner';
import { startBranchHoverCard } from './content/branchHoverCard';
import { info } from '../lib/log';

export default defineContentScript({
  matches: ['https://*.atlassian.net/jira/software/*'],
  main() {
    info('content script alive on', location.href);
    void startBoardWatcher();
    startColoring();
    startBanner();
    startBranchHoverCard();
  },
});
