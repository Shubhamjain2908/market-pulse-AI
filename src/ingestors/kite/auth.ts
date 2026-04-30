/**
 * Interactive Kite login helper. Walks the user through the daily token
 * dance:
 *   1. Print the login URL (and try to open it in the browser).
 *   2. User logs in, Zerodha redirects to the configured app redirect
 *      URL with `?request_token=XXX` appended. User pastes the URL or
 *      just the token back into the terminal.
 *   3. We exchange the request_token for an access_token (sha256 of
 *      api_key + request_token + api_secret).
 *   4. The fresh access_token is appended to `.env` (replacing any
 *      previous KITE_ACCESS_TOKEN line) so subsequent commands pick it
 *      up without further setup.
 */

import { exec } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { child } from '../../logger.js';
import { KiteClient } from './client.js';

const log = child({ component: 'kite-auth' });

export interface KiteLoginResult {
  accessToken: string;
  userId: string;
  userName?: string;
  envPath: string;
}

export async function runKiteLogin(
  envPath = resolve(process.cwd(), '.env'),
): Promise<KiteLoginResult> {
  const client = new KiteClient();
  const url = client.loginUrl();

  console.log('\n  Open this URL in your browser to log in to Kite:');
  console.log(`  ${url}\n`);
  console.log('  After logging in, Zerodha will redirect you to a URL like:');
  console.log('    https://your-redirect-url/?request_token=XXXXXXXXXX&action=login&...');
  console.log('  Paste either the full redirect URL or just the request_token below.\n');

  // Best-effort browser launch; ignore failures.
  tryOpenBrowser(url);

  const rl = createInterface({ input: stdin, output: stdout });
  const raw = (await rl.question('  request_token (or full redirect URL): ')).trim();
  rl.close();

  const requestToken = extractRequestToken(raw);
  if (!requestToken) {
    throw new Error(
      'Could not extract request_token from input. Expected ?request_token=... or just the token.',
    );
  }

  log.info({ requestToken: maskToken(requestToken) }, 'exchanging request_token');
  const session = await client.generateSession(requestToken);
  upsertEnvVar(envPath, 'KITE_ACCESS_TOKEN', session.access_token);

  return {
    accessToken: session.access_token,
    userId: session.user_id,
    userName: session.user_name,
    envPath,
  };
}

function extractRequestToken(input: string): string | null {
  if (!input) return null;
  // Pasted full URL → parse the query string.
  if (input.includes('request_token=')) {
    const match = input.match(/request_token=([^&\s]+)/);
    return match?.[1] ?? null;
  }
  // Bare token: alphanumeric, 16-64 chars.
  if (/^[A-Za-z0-9]{8,64}$/.test(input)) return input;
  return null;
}

function tryOpenBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) log.debug({ err: err.message }, 'could not auto-open browser; user will copy/paste');
  });
}

function maskToken(t: string): string {
  return t.length <= 8 ? '****' : `${t.slice(0, 4)}…${t.slice(-4)}`;
}

/**
 * Idempotent `KEY=value` upsert in a .env-style file. Preserves comments
 * and ordering; replaces an existing matching line in place.
 */
export function upsertEnvVar(path: string, key: string, value: string): void {
  const line = `${key}=${value}`;
  if (!existsSync(path)) {
    writeFileSync(path, `${line}\n`);
    return;
  }
  const original = readFileSync(path, 'utf8');
  const re = new RegExp(`^${escapeRegex(key)}=.*$`, 'm');
  let next: string;
  if (re.test(original)) {
    next = original.replace(re, line);
  } else {
    next = original.endsWith('\n') ? `${original}${line}\n` : `${original}\n${line}\n`;
  }
  writeFileSync(path, next);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
