/**
 * Interactive Kite login helper. Walks the user through the daily token
 * dance:
 *   1. Print the login URL (and try to open it in the browser).
 *   2. User logs in, Zerodha redirects to the configured app redirect
 *      URL with `?request_token=XXX` appended. User pastes the URL or
 *      just the token back into the terminal.
 *   3. We exchange the request_token for an access_token (sha256 of
 *      api_key + request_token + api_secret).
 *   4. The fresh access_token is written to the repo-root `.env` (see
 *      `MP_DOTENV_PATH` / `project-paths.ts`), removing every prior assignment
 *      for that key so duplicates or `export KEY=` lines cannot leave a stale
 *      token as the effective value.
 */

import { exec } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { PROJECT_DOTENV_PATH } from '../../config/project-paths.js';
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
  envPath = process.env.MP_DOTENV_PATH ?? PROJECT_DOTENV_PATH,
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
  assertEnvFileHasKey(envPath, 'KITE_ACCESS_TOKEN', session.access_token);
  const st = statSync(envPath);
  console.log(`\n  Wrote KITE_ACCESS_TOKEN to:\n    ${envPath}`);
  console.log(
    `  (disk verify OK — ${st.size} bytes, mtime ${st.mtime.toISOString()}; reload the file in your editor if it still looks old.)\n`,
  );

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
 * Idempotent `KEY=value` upsert in a `.env`-style file. Removes **all** lines
 * that assign `key` (optional leading whitespace, optional `export`, optional
 * spaces around `=`) so duplicate keys cannot keep a stale value as the last
 * assignment. Appends one fresh `KEY=value` line at the end.
 */
export function upsertEnvVar(path: string, key: string, value: string): void {
  const line = `${key}=${value}`;
  if (!existsSync(path)) {
    writeFileSync(path, `${line}\n`, 'utf8');
    return;
  }
  let text = readFileSync(path, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  text = text.replace(/\r\n/g, '\n');

  const kept = text.split('\n').filter((l) => !lineAssignsKey(l, key));
  const body = kept.join('\n').replace(/\n+$/, '');
  const next = body.length > 0 ? `${body}\n${line}\n` : `${line}\n`;
  writeFileSync(path, next, 'utf8');
}

function lineAssignsKey(line: string, key: string): boolean {
  return new RegExp(`^\\s*(?:export\\s+)?${escapeRegex(key)}\\s*=`).test(line);
}

/**
 * Confirms the token was persisted. If this throws, the write path or
 * permissions are wrong — not an editor refresh issue.
 */
function assertEnvFileHasKey(path: string, key: string, expectedValue: string): void {
  const raw = readFileSync(path, 'utf8');
  const values = parseAllAssignmentsForKey(raw, key);
  if (values.length === 0) {
    throw new Error(`After write, no ${key}= line found in ${path} (disk read-back failed).`);
  }
  if (values.length > 1) {
    throw new Error(
      `After write, ${values.length} ${key}= lines found in ${path}; remove duplicates manually.`,
    );
  }
  if (values[0] !== expectedValue) {
    throw new Error(
      `After write, ${key} on disk does not match session token (got len=${values[0]?.length ?? 0}, expected len=${expectedValue.length}). File: ${path}`,
    );
  }
}

function parseAllAssignmentsForKey(fileText: string, key: string): string[] {
  let text = fileText;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  text = text.replace(/\r\n/g, '\n');
  const lineRe = new RegExp(`^\\s*(?:export\\s+)?${escapeRegex(key)}\\s*=\\s*(.*)$`);
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(lineRe);
    if (!m) continue;
    out.push(normalizeEnvValue(m[1] ?? ''));
  }
  return out;
}

/** Trim, strip optional surrounding quotes, strip trailing ` # comment`. */
function normalizeEnvValue(raw: string): string {
  let v = raw.trim();
  const hash = v.indexOf('#');
  if (hash !== -1) {
    v = v.slice(0, hash).trim();
  }
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
