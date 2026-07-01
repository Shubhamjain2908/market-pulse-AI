import { Cron } from 'croner';
import express from 'express';
import { config } from '../config/env.js';
import { PROJECT_DOTENV_PATH } from '../config/project-paths.js';
import { MARKET_TIMEZONE } from '../constants.js';
import { closeDb, getDb, migrate } from '../db/index.js';
import { upsertEnvVar } from '../ingestors/kite/auth.js';
import { KiteClient } from '../ingestors/kite/client.js';
import { child } from '../logger.js';

const log = child({ component: 'kite-auth-server' });
const app = express();
const kite = new KiteClient();
const CUE_DASHBOARD_HTML_PATH = '/home/ubuntu/cue/dist/dashboard.html';

app.get('/auth/kite', (_req, res) => {
  const loginUrl = kite.loginUrl();
  log.info({ loginUrl }, 'redirecting to kite login');
  res.redirect(loginUrl);
});

app.get('/auth/callback', async (req, res) => {
  const requestToken =
    typeof req.query.request_token === 'string' ? req.query.request_token.trim() : '';
  if (!requestToken) {
    res.status(400).send(renderErrorPage('Missing request_token in callback URL.'));
    return;
  }

  try {
    const session = await kite.generateSession(requestToken);
    upsertKiteAccessToken(session.access_token);
    upsertEnvVar(
      process.env.MP_DOTENV_PATH ?? PROJECT_DOTENV_PATH,
      'KITE_ACCESS_TOKEN',
      session.access_token,
    );

    const nowLabel = formatIstNow();
    const expiry = getTokenExpiryFromIssuedAt(new Date());
    log.info(
      { userId: session.user_id, expires: expiry.label },
      'kite access_token generated and saved to sqlite config table',
    );

    res.status(200).send(renderSuccessPage({ nowLabel, expiryLabel: expiry.label }));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'kite callback session exchange failed');
    res.status(500).send(renderErrorPage(reason));
  }
});

app.get('/auth/status', (_req, res) => {
  const row = getDb()
    .prepare("SELECT value, updated_at FROM config WHERE key = 'kite_access_token' LIMIT 1")
    .get() as { value: string; updated_at: string } | undefined;

  const token = row?.value?.trim() ?? '';
  const updatedAt = row?.updated_at;
  const expiry = updatedAt
    ? getTokenExpiryFromIssuedAt(parseSqliteTimestamp(updatedAt))
    : getTokenExpiryFromIssuedAt(new Date());
  const valid = token.length > 0 && updatedAt != null && new Date() < expiry.instant;

  res.json({
    valid,
    token_preview: token ? maskToken(token) : '',
    expires: expiry.label,
  });
});

app.get('/auth/cue-dashboard', (_req, res) => {
  res.sendFile(CUE_DASHBOARD_HTML_PATH, (err?: NodeJS.ErrnoException) => {
    if (!err) return;
    if (err.code === 'ENOENT') {
      log.warn(
        { path: CUE_DASHBOARD_HTML_PATH },
        'cue dashboard html file not found while serving /auth/cue-dashboard',
      );
      res.status(200).send(renderCueDashboardFallbackPage(CUE_DASHBOARD_HTML_PATH));
      return;
    }
    log.error({ err, path: CUE_DASHBOARD_HTML_PATH }, 'failed to serve cue dashboard html');
    res.status(200).send(renderCueDashboardFallbackPage(CUE_DASHBOARD_HTML_PATH));
  });
});

function upsertKiteAccessToken(token: string): void {
  getDb()
    .prepare(
      `
      INSERT INTO config (key, value, updated_at)
      VALUES ('kite_access_token', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `,
    )
    .run(token);
}

function maskToken(token: string): string {
  if (token.length <= 8) return token;
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function parseSqliteTimestamp(value: string): Date {
  // SQLite CURRENT_TIMESTAMP is UTC in "YYYY-MM-DD HH:MM:SS" format.
  return new Date(`${value.replace(' ', 'T')}Z`);
}

function getTokenExpiryFromIssuedAt(issuedAt: Date): { label: string; instant: Date } {
  const issueIst = getIstDateParts(issuedAt);
  const nextIstDate = addDaysToYmd(issueIst.year, issueIst.month, issueIst.day, 1);
  const expiryUtc = new Date(
    Date.UTC(nextIstDate.year, nextIstDate.month - 1, nextIstDate.day, 0, 30, 0),
  );
  return {
    label: `${nextIstDate.year}-${pad2(nextIstDate.month)}-${pad2(nextIstDate.day)} 06:00 IST`,
    instant: expiryUtc,
  };
}

function getIstDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const day = Number(parts.find((p) => p.type === 'day')?.value);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error('Failed to compute IST date parts');
  }

  return { year, month, day };
}

function addDaysToYmd(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function formatIstNow(): string {
  return `${new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: false,
  }).format(new Date())} IST`;
}

function pad2(v: number): string {
  return String(v).padStart(2, '0');
}

function renderSuccessPage(opts: { nowLabel: string; expiryLabel: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kite Auth Success</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f7fb; color: #1c1f26; }
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
    .card { width: min(460px, 100%); background: #fff; border-radius: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.08); padding: 22px; text-align: center; }
    .icon { font-size: 48px; line-height: 1; margin-bottom: 8px; }
    h1 { margin: 0 0 10px; font-size: 1.3rem; color: #0f5132; }
    p { margin: 8px 0; color: #334155; font-size: .98rem; }
    .meta { margin-top: 14px; padding: 12px; border-radius: 10px; background: #ecfdf3; border: 1px solid #bbf7d0; text-align: left; }
    .meta b { color: #065f46; }
    .hint { margin-top: 12px; font-size: .9rem; color: #475569; }
    a { color: #0d6efd; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <div class="icon" aria-hidden="true">&#x2705;</div>
      <h1>Kite token updated successfully</h1>
      <p>Your access token is now stored in SQLite config and ready for portfolio sync/live scan.</p>
      <div class="meta">
        <p><b>Token expiry:</b> Valid until 6:00 AM IST tomorrow (${escapeHtml(opts.expiryLabel)})</p>
        <p><b>Current IST time:</b> ${escapeHtml(opts.nowLabel)}</p>
      </div>
      <p class="hint">You can close this page and run your pipeline commands.</p>
    </section>
  </main>
</body>
</html>`;
}

function renderErrorPage(reason: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kite Auth Failed</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #fff5f5; color: #1c1f26; }
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
    .card { width: min(460px, 100%); background: #fff; border-radius: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.08); padding: 22px; text-align: center; border: 1px solid #fecaca; }
    .icon { font-size: 48px; line-height: 1; margin-bottom: 8px; }
    h1 { margin: 0 0 10px; font-size: 1.3rem; color: #b91c1c; }
    p { margin: 8px 0; color: #334155; font-size: .98rem; }
    .error { margin-top: 12px; padding: 12px; border-radius: 10px; background: #fef2f2; border: 1px solid #fecaca; text-align: left; color: #7f1d1d; }
    a { color: #b91c1c; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <div class="icon" aria-hidden="true">&#x274c;</div>
      <h1>Kite authentication failed</h1>
      <p>Could not exchange the request token. Please retry login.</p>
      <div class="error"><b>Reason:</b> ${escapeHtml(reason)}</div>
      <p><a href="/auth/kite">Try again</a></p>
    </section>
  </main>
</body>
</html>`;
}

function renderCueDashboardFallbackPage(sourcePath: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CUE Dashboard (Fallback)</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1e293b; }
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 20px; }
    .card { width: min(640px, 100%); background: #fff; border-radius: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.08); padding: 22px; border: 1px solid #e2e8f0; }
    h1 { margin: 0 0 8px; font-size: 1.25rem; }
    p { margin: 8px 0; color: #334155; }
    code { background: #f1f5f9; border-radius: 6px; padding: 2px 6px; }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <h1>CUE dashboard is temporarily unavailable</h1>
      <p>The static dashboard file could not be loaded from:</p>
      <p><code>${escapeHtml(sourcePath)}</code></p>
      <p>This fallback page keeps <code>/auth/cue-dashboard</code> responsive even when the file is missing.</p>
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function main(): void {
  migrate();
  const port = readKiteAuthPort();
  const autoLoginCron = startKiteAutoLoginCron();
  const server = app.listen(port, () => {
    log.info(
      {
        port,
        databasePath: config.DATABASE_PATH,
        callbackPath: '/auth/callback',
        autoLoginCron: autoLoginCron != null,
      },
      'kite auth server started',
    );
  });

  const shutdown = (signal: 'SIGINT' | 'SIGTERM') => {
    log.info({ signal }, 'shutting down kite auth server');
    autoLoginCron?.stop();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function kiteAutoLoginConfigured(): boolean {
  return Boolean(
    config.KITE_USER_ID?.trim() &&
      config.KITE_PASSWORD?.trim() &&
      config.KITE_TOTP_SECRET?.trim() &&
      config.KITE_API_KEY?.trim() &&
      config.KITE_API_SECRET?.trim(),
  );
}

function startKiteAutoLoginCron(): Cron | undefined {
  if (!kiteAutoLoginConfigured()) {
    log.info('kite auto-login cron not armed — missing KITE_USER_ID/PASSWORD/TOTP_SECRET');
    return undefined;
  }
  const job = new Cron(
    '30 8 * * 1-5',
    { timezone: MARKET_TIMEZONE, protect: true },
    () => void runScheduledKiteAutoLogin(),
  );
  log.info({ timezone: MARKET_TIMEZONE, schedule: '30 8 * * 1-5' }, 'kite auto-login cron armed');
  return job;
}

async function runScheduledKiteAutoLogin(): Promise<void> {
  const t0 = Date.now();
  log.info({ tag: 'weekday-0830', health: 'started' }, 'kite auto-login started');
  try {
    // ponytail: Playwright loads only at trigger, not Express boot
    const { runKiteAutoLogin } = await import('./kite-auto-login/login.js');
    const result = await runKiteAutoLogin();
    log.info(
      { tag: 'weekday-0830', health: 'ok', durationMs: Date.now() - t0, userId: result.userId },
      'kite auto-login finished',
    );
  } catch (err) {
    log.error(
      { tag: 'weekday-0830', health: 'error', durationMs: Date.now() - t0, err },
      'kite auto-login failed',
    );
  } finally {
    closeDb();
  }
}

function readKiteAuthPort(): number {
  const raw = process.env.KITE_AUTH_PORT;
  if (!raw) return 3001;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return 3001;
  return parsed;
}

main();
