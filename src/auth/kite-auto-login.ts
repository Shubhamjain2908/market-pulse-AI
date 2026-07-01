/**
 * Headless Kite Connect OAuth login via Playwright + TOTP.
 * Run once: `pnpm kite-auto-login`  |  scheduled: PM2 `kite-auth` at 08:30 IST
 */

import { mkdirSync } from 'node:fs';
import { generate } from 'otplib';
import { type Browser, type BrowserContext, chromium, type Locator, type Page } from 'playwright';
import { config } from '../config/env.js';
import { PROJECT_DOTENV_PATH } from '../config/project-paths.js';
import { closeDb, getDb, migrate } from '../db/index.js';
import { assertEnvFileHasKey, extractRequestToken, upsertEnvVar } from '../ingestors/kite/auth.js';
import { KiteClient } from '../ingestors/kite/client.js';
import { child } from '../logger.js';

const log = child({ component: 'kite-auto-login' });

const USER_ID_SELECTORS = ['#userid', 'form input[type="text"]:visible'];
const PASSWORD_SELECTORS = ['#password', 'form input[type="password"]:visible'];
const TOTP_SELECTORS = [
  'input[type="number"][maxlength="6"]:visible',
  'input[label="External TOTP"]:visible',
  'input[type="number"]:visible',
];

// 1GB VM flags — drop --single-process if login becomes unstable
const LOW_MEMORY_CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
] as const;

export interface KiteAutoLoginResult {
  accessToken: string;
  userId: string;
  envPath: string;
  cookies: { publicToken: boolean; enctoken: boolean };
}

export async function runKiteAutoLogin(
  envPath = process.env.MP_DOTENV_PATH ?? PROJECT_DOTENV_PATH,
): Promise<KiteAutoLoginResult> {
  const creds = requireAutoLoginEnv();
  const client = new KiteClient();
  const headless = config.KITE_AUTO_LOGIN_HEADLESS === 'true';

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    browser = await chromium.launch({
      headless,
      args: [...LOW_MEMORY_CHROMIUM_ARGS],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Executable doesn't exist") || msg.includes('playwright install')) {
      throw new Error(
        'Playwright Chromium not installed. Run: pnpm playwright:install (then retry pnpm kite-auto-login)',
        { cause: err },
      );
    }
    if (
      msg.includes('shared libraries') ||
      msg.includes('libatk') ||
      msg.includes('exitCode=127')
    ) {
      throw new Error(
        'Chromium system libraries missing (Linux). Run once on the VM: sudo pnpm playwright:install-deps',
        { cause: err },
      );
    }
    if (process.platform === 'linux' && msg.includes('has been closed')) {
      throw new Error(
        'Chromium failed to start on Linux. Run once: sudo pnpm playwright:install-deps (then retry pnpm kite-auto-login)',
        { cause: err },
      );
    }
    throw err;
  }

  try {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
      // tracing/video/har off — defaults, stated explicitly for 1GB deploys
      recordVideo: undefined,
      recordHar: undefined,
    });
    page = await context.newPage();

    migrate();
    const priorSnapshot = readKiteAccessTokenSnapshot();

    await page.goto(client.loginUrl(), { waitUntil: 'domcontentloaded', timeout: 60_000 });

    await fillFirst(page, USER_ID_SELECTORS, creds.userId);
    await fillAndSubmit(page, PASSWORD_SELECTORS, creds.password);
    await waitForTotpOrRedirect(page);

    if (!hasRequestToken(page.url())) {
      const totp = await generate({ secret: creds.totpSecret });
      await fillAndSubmitTotp(page, totp);
    }

    await waitForLoginComplete(page);

    const { accessToken, userId } = await resolveAccessToken(page, client, priorSnapshot);

    persistKiteAccessToken(accessToken, envPath);

    const cookies = await context.cookies();
    const cookieStatus = {
      publicToken: cookies.some((c) => c.name === 'public_token'),
      enctoken: cookies.some((c) => c.name === 'enctoken'),
    };
    log.info(cookieStatus, 'kite session cookies');

    return {
      accessToken,
      userId,
      envPath,
      cookies: cookieStatus,
    };
  } catch (err) {
    if (page) {
      const successVisible = await page
        .getByText('Kite token updated successfully')
        .isVisible()
        .catch(() => false);
      if (!successVisible) {
        await captureFailureScreenshot(page);
      }
    }
    throw err;
  } finally {
    await closePlaywright({ page, context, browser });
  }
}

function requireAutoLoginEnv(): { userId: string; password: string; totpSecret: string } {
  const userId = config.KITE_USER_ID?.trim() ?? '';
  const password = config.KITE_PASSWORD?.trim() ?? '';
  const totpSecret = config.KITE_TOTP_SECRET?.trim() ?? '';
  const missing: string[] = [];
  if (!userId) missing.push('KITE_USER_ID');
  if (!password) missing.push('KITE_PASSWORD');
  if (!totpSecret) missing.push('KITE_TOTP_SECRET');
  if (!config.KITE_API_KEY?.trim()) missing.push('KITE_API_KEY');
  if (!config.KITE_API_SECRET?.trim()) missing.push('KITE_API_SECRET');
  if (missing.length > 0) {
    throw new Error(`Missing env for kite auto-login: ${missing.join(', ')}`);
  }
  return { userId, password, totpSecret };
}

async function fillFirst(page: Page, selectors: string[], value: string): Promise<void> {
  const loc = await firstVisible(page, selectors);
  await loc.fill(value);
}

/** Enter on the filled field — avoids disabled processing submit buttons */
async function fillAndSubmit(page: Page, selectors: string[], value: string): Promise<void> {
  const loc = await firstVisible(page, selectors);
  await loc.click();
  await loc.fill(value);
  // locator.press hangs on Kite React inputs — keyboard Enter targets focused field
  await page.keyboard.press('Enter');
}

/** TOTP is type=number; fill+locator.press often stalls — type digits + keyboard/submit fallbacks */
async function fillAndSubmitTotp(page: Page, totp: string): Promise<void> {
  const loc = await firstVisible(page, TOTP_SELECTORS);
  await loc.click();
  await loc.clear();
  await loc.pressSequentially(totp, { delay: 40 });
  await page.keyboard.press('Enter');

  if (await loginProgressed(page, 5_000)) return;

  const submit = page.locator('button[type="submit"]:not([disabled])').first();
  await submit.click({ timeout: 30_000 });
}

async function loginProgressed(page: Page, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    page.waitForURL(/request_token=|auth\/callback/, { timeout: timeoutMs }).then(() => true),
    page
      .getByText('Kite token updated successfully')
      .waitFor({ timeout: timeoutMs })
      .then(() => true),
  ]).catch(() => false);
}

async function waitForTotpOrRedirect(page: Page): Promise<void> {
  if (hasRequestToken(page.url())) return;
  await Promise.race([
    page.waitForURL(/request_token=/, { timeout: 45_000 }),
    page.waitForSelector(TOTP_SELECTORS.join(', '), { timeout: 45_000 }),
  ]).catch(() => {
    if (!hasRequestToken(page.url()) && !isAuthCallbackUrl(page.url())) {
      throw new Error('Stuck after credentials — no TOTP step and no redirect');
    }
  });
}

function isAuthCallbackUrl(url: string): boolean {
  const redirect = config.KITE_REDIRECT_URL?.trim();
  if (redirect) {
    try {
      const expected = new URL(redirect);
      const actual = new URL(url);
      return actual.host === expected.host && actual.pathname === expected.pathname;
    } catch {
      return url.includes('/auth/callback');
    }
  }
  return url.includes('/auth/callback');
}

async function waitForLoginComplete(page: Page): Promise<void> {
  if (isAuthCallbackUrl(page.url())) {
    await Promise.race([
      page.getByText('Kite token updated successfully').waitFor({ timeout: 90_000 }),
      page
        .getByText('Kite authentication failed')
        .waitFor({ timeout: 90_000 })
        .then(() => {
          throw new Error('kite-auth-server callback reported authentication failed');
        }),
    ]);
    return;
  }

  if (hasRequestToken(page.url())) return;

  await Promise.race([
    page.waitForURL(/request_token=/, { timeout: 90_000 }),
    page.getByText('Kite token updated successfully').waitFor({ timeout: 90_000 }),
  ]);
}

async function resolveAccessToken(
  page: Page,
  client: KiteClient,
  priorSnapshot: KiteAccessTokenSnapshot,
): Promise<{ accessToken: string; userId: string }> {
  migrate();

  const onSuccessPage = await page
    .getByText('Kite token updated successfully')
    .isVisible()
    .catch(() => false);
  const onCallback = isAuthCallbackUrl(page.url());

  // kite-auth-server exchanges on callback — read local sqlite (works on Oracle VM)
  if (onSuccessPage || onCallback) {
    const fromDb = await waitForRefreshedKiteAccessToken(priorSnapshot, 45_000);
    if (fromDb) {
      log.info({ tokenPreview: mask(fromDb) }, 'access_token loaded from sqlite');
      return { accessToken: fromDb, userId: config.KITE_USER_ID?.trim() ?? 'unknown' };
    }
    throwRemoteCallbackError(onSuccessPage);
  }

  const requestToken = extractRequestToken(page.url());
  if (requestToken) {
    log.info({ requestToken: mask(requestToken) }, 'exchanging request_token');
    const session = await client.generateSession(requestToken);
    return { accessToken: session.access_token, userId: session.user_id };
  }

  throw new Error(
    `Login finished without access_token (url=${redactUrl(page.url())}). ` +
      'Ensure kite-auth is running on the redirect host.',
  );
}

function throwRemoteCallbackError(onSuccessPage: boolean): never {
  const redirectLabel = config.KITE_REDIRECT_URL?.trim() ?? 'your Kite Connect redirect URL';
  if (onSuccessPage) {
    throw new Error(
      `Kite login succeeded on ${redirectLabel} but local sqlite (${config.DATABASE_PATH}) was not refreshed. ` +
        'Run auto-login on the same host as kite-auth, or use `pnpm kite-login` for local dev.',
    );
  }
  throw new Error(
    `No refreshed kite_access_token in local sqlite after callback to ${redirectLabel}. ` +
      'Run kite-auto-login on the same host as kite-auth.',
  );
}

export interface KiteAccessTokenSnapshot {
  token: string;
  updatedAt: string | null;
}

/** True when kite-auth (or auto-login) wrote a new session after our snapshot. */
export function kiteAccessTokenRefreshed(
  prior: KiteAccessTokenSnapshot,
  current: KiteAccessTokenSnapshot,
): boolean {
  if (!current.token) return false;
  if (current.token !== prior.token) return true;
  return current.updatedAt != null && current.updatedAt !== prior.updatedAt;
}

async function waitForRefreshedKiteAccessToken(
  priorSnapshot: KiteAccessTokenSnapshot,
  timeoutMs = 45_000,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = readKiteAccessTokenSnapshot();
    if (kiteAccessTokenRefreshed(priorSnapshot, current)) return current.token;
    await sleep(200);
  }
  return null;
}

function readKiteAccessTokenSnapshot(): KiteAccessTokenSnapshot {
  const row = getDb()
    .prepare("SELECT value, updated_at FROM config WHERE key = 'kite_access_token' LIMIT 1")
    .get() as { value?: string | null; updated_at?: string | null } | undefined;
  return {
    token: row?.value?.trim() ?? '',
    updatedAt: row?.updated_at ?? null,
  };
}

function persistKiteAccessToken(token: string, envPath: string): void {
  upsertEnvVar(envPath, 'KITE_ACCESS_TOKEN', token);
  assertEnvFileHasKey(envPath, 'KITE_ACCESS_TOKEN', token);
  migrate();
  getDb()
    .prepare(
      `INSERT INTO config (key, value, updated_at)
       VALUES ('kite_access_token', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    )
    .run(token);
  log.info(
    { envPath, tokenPreview: mask(token) },
    'kite access_token persisted to .env and sqlite',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasRequestToken(url: string): boolean {
  return url.includes('request_token=');
}

async function firstVisible(page: Page, selectors: string[]): Promise<Locator> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 8_000 });
      return loc;
    } catch {
      // try next selector
    }
  }
  throw new Error(`No visible element among: ${selectors.join(', ')}`);
}

async function captureFailureScreenshot(page: Page): Promise<void> {
  try {
    mkdirSync('errors', { recursive: true });
    const ts = new Date().toISOString().replaceAll(':', '-');
    const path = `errors/login-failed-${ts}.png`;
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    log.error({ path }, 'login failed — screenshot saved');
  } catch (shotErr) {
    log.warn({ err: shotErr }, 'could not save failure screenshot');
  }
}

async function closePlaywright(opts: {
  page?: Page;
  context?: BrowserContext;
  browser?: Browser;
}): Promise<void> {
  if (opts.page) {
    try {
      await opts.page.close();
    } catch (err) {
      log.warn({ err }, 'page.close failed during cleanup');
    }
  }
  if (opts.context) {
    try {
      await opts.context.close();
    } catch (err) {
      log.warn({ err }, 'context.close failed during cleanup');
    }
  }
  if (opts.browser) {
    try {
      await opts.browser.close();
    } catch (err) {
      log.warn({ err }, 'browser.close failed during cleanup');
    }
  }
}

function mask(t: string): string {
  return t.length <= 8 ? '****' : `${t.slice(0, 4)}…${t.slice(-4)}`;
}

function redactUrl(url: string): string {
  return url.replace(/request_token=[^&]+/, 'request_token=***');
}

function istNow(): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: false,
  }).format(new Date());
}

const isMain =
  process.argv[1]?.endsWith('kite-auto-login.ts') ||
  process.argv[1]?.endsWith('login.js') ||
  process.argv[1]?.includes('kite-auto-login/login');

if (isMain) {
  runKiteAutoLogin()
    .then((r) => {
      console.log(`[${istNow()} IST] kite auto-login ok user=${r.userId} env=${r.envPath}`);
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      console.error(
        `[${istNow()} IST] kite auto-login failed:`,
        err instanceof Error ? err.message : err,
      );
      closeDb();
      process.exit(1);
    });
}
