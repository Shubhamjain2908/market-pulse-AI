/**
 * NSE cookie warm-up. The NSE public JSON endpoints (under /api/*) reject
 * requests that don't already have a session cookie. Hitting the public
 * homepage first sets the cookies we need, then subsequent /api/ calls
 * succeed using the same cookie jar.
 *
 * Akamai bot-defence on NSE rotates session cookies fairly aggressively,
 * so callers should `prime()` before each ingest run, and re-prime on
 * 401/403 responses.
 *
 * The prime requests must look like a real browser navigation — we
 * explicitly STRIP any XHR-flavoured headers (referer, origin, x-requested-
 * with) that the API client uses by default, otherwise Akamai silently
 * tarpits the connection (see request timing out at 20s in the dev logs).
 */

import type { HttpClient } from '../base/http-client.js';

const NSE_BASE = 'https://www.nseindia.com';
const PRIME_PATHS = ['/', '/get-quotes/equity?symbol=RELIANCE'];

const BROWSER_NAV_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
} as const;

export async function primeNseCookies(client: HttpClient, signal?: AbortSignal): Promise<void> {
  for (const path of PRIME_PATHS) {
    await client.acquire(signal);
    await client.got(`${NSE_BASE}${path}`, {
      // Override BOTH the API-style defaults and ensure browser-y headers.
      // Using `headers: undefined` for the API ones forces got to drop them.
      headers: {
        ...BROWSER_NAV_HEADERS,
        referer: undefined,
        origin: undefined,
        'x-requested-with': undefined,
      },
      // The homepage often returns a 200 or a 302; sometimes a 403 from
      // Akamai's bot challenge — but cookies are set in either case, so
      // don't treat HTTP errors as fatal here.
      throwHttpErrors: false,
      // Cookie priming should be quick. Cap aggressively.
      timeout: { request: 10_000 },
      retry: { limit: 1 },
      signal,
    });
  }
}
