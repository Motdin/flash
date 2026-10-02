/**
 * PM2 Configuration for running Morpho LLM Operator & Executor on a VPS
 * Usage:
 *   pm2 start deploy/ecosystem.config.cjs
 *   pm2 logs morpho-llm-operator
 *   pm2 save && pm2 startup
 */
module.exports = {
  apps: [
    {
      name: 'morpho-llm-operator',
      cwd: './tools',
      script: 'node_modules/.bin/tsx',
      args: 'src/commands/watch.ts',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
