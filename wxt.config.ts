import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'EnhanceJira',
    description: 'Enhance Jira board cards with full Bitbucket PR approval data',
    version: '0.3.2',
    permissions: ['storage'],
    host_permissions: [
      'https://*.atlassian.net/*',
      'https://api.bitbucket.org/*',
    ],
  },
});
