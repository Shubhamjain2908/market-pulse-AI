/**
 * NSE cookie warm-up. The NSE public JSON endpoints (under /api/*) reject
 * requests that don't already have a session cookie. Hitting the public
 * homepage first sets the cookies we need, then subsequent /api/ calls
 * succeed using the same cookie jar.
 *
 * Akamai bot-defence on NSE rotates session cookies fairly aggressively,
 * so callers should `prime()` before each ingest run, and re-prime on
 * 401/403 responses.
 */

import type { HttpClient } from '../base/http-client.js';

const NSE_BASE = 'https://www.nseindia.com';
const PRIME_PATHS = ['/', '/get-quotes/equity?symbol=RELIANCE'];

export async function primeNseCookies(client: HttpClient, signal?: AbortSignal): Promise<void> {
  for (const path of PRIME_PATHS) {
    await client.acquire(signal);
    await client.got(`${NSE_BASE}${path}`, {
      headers: { accept: 'text/html' },
      signal,
    });
  }
}
