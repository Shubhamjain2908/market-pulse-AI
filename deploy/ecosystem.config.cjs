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
      out_file: path.join(logDir, 'pm2-pulse.log'),
      error_file: path.join(logDir, 'pm2-pulse.log'),
      time: true,
    },
    {
      name: 'kite-auto-login',
      cwd: root,
      script: 'dist/auth/kite-auto-login/index.js',
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
      },
      merge_logs: true,
      combine_logs: true,
      out_file: path.join(logDir, 'pm2-kite-auto-login.log'),
      error_file: path.join(logDir, 'pm2-kite-auto-login.log'),
      time: true,
    },
    {
      name: 'kite-auth',
      cwd: root,
      script: 'dist/auth/kite-auth-server.js',
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
      },
      merge_logs: true,
      combine_logs: true,
      out_file: path.join(logDir, 'pm2-auth.log'),
      error_file: path.join(logDir, 'pm2-auth.log'),
      time: true,
    },
    {
      name: 'datasette',
      script: '/home/ubuntu/datasette-config/datasette.sh',
      interpreter: 'bash',
      restart_delay: 5000,
      max_restarts: 10,
      autorestart: true,
      watch: false,
      error_file: '/home/ubuntu/.pm2/logs/datasette-error.log',
      out_file: '/home/ubuntu/.pm2/logs/datasette-out.log',
    },
  ],
};
