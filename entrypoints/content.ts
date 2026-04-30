import { startBoardWatcher } from './content/observer';
import { startColoring } from './content/coloring';
import { startTooltip } from './content/tooltip';
import { startBanner } from './content/banner';
import { info } from '../lib/log';

export default defineContentScript({
  matches: ['https://*.atlassian.net/jira/software/*'],
  main() {
    info('content script alive on', location.href);
    void startBoardWatcher();
    startColoring();
    startTooltip();
    startBanner();
  },
});
