/**
 * PM2 process file — use after `pnpm build` from the repo root.
 * Logs are merged for deploy/healthcheck.ts log scanning.
 *
 *   cd /opt/market-pulse-ai
 *   pm2 start deploy/ecosystem.config.cjs
 *   pm2 save && pm2 startup
 */
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const logDir = path.join(root, 'deploy/logs');

module.exports = {
  apps: [
    {
      name: 'market-pulse',
      cwd: root,
      script: 'dist/cli.js',
      args: 'schedule',
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
      },
      // Merge stdout/stderr so HEALTHCHECK_PIPELINE_LOG can point at one file.
      merge_logs: true,
      combine_logs: true,
      out_file: path.join(logDir, 'pm2-combined.log'),
      error_file: path.join(logDir, 'pm2-combined.log'),
      time: true,
    },
  ],
};
