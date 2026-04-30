/**
 * Shared HTTP client factory backed by `got`. Adds:
 *   - per-host rate limiting (token bucket)
 *   - cookie jar (for sites like NSE that require warm-up)
 *   - sane retry policy (default got retries on 408/413/429/500/502/503/504)
 *   - realistic User-Agent + Accept headers
 *
 * Each ingestor module gets its own client via `createHttpClient()` so they
 * don't trample each other's rate buckets.
 */

import got, { type Got, type OptionsOfTextResponseBody } from 'got';
import { CookieJar } from 'tough-cookie';
import { RateLimiter, type RateLimiterOptions } from './rate-limiter.js';

export interface HttpClientOptions {
  /** Stable identifier for logging/debugging. */
  name: string;
  /** Defaults applied to every request (e.g. `prefixUrl`, `headers`). */
  defaults?: OptionsOfTextResponseBody;
  /** Token-bucket configuration. Leave undefined to disable rate limiting. */
  rateLimit?: RateLimiterOptions;
  /** Enable a cookie jar - required for NSE-style session sites. */
  withCookieJar?: boolean;
  /** Retry policy override. Defaults to 3 retries with got's defaults. */
  retryLimit?: number;
}

export interface HttpClient {
  readonly name: string;
  readonly got: Got;
  readonly cookieJar?: CookieJar;
  /** Acquire a rate-limit token. Most callers should use `request()` instead. */
  acquire(signal?: AbortSignal): Promise<void>;
  /** Convenience wrapper - acquires a token then calls `got()`. */
  request<T>(url: string, options?: OptionsOfTextResponseBody): Promise<T>;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'user-agent': DEFAULT_USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
} as const;

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const cookieJar = opts.withCookieJar ? new CookieJar() : undefined;
  const limiter = opts.rateLimit ? new RateLimiter(opts.rateLimit) : undefined;

  const instance = got.extend({
    timeout: { request: 20_000 },
    retry: {
      limit: opts.retryLimit ?? 3,
      methods: ['GET', 'HEAD'],
      statusCodes: [408, 429, 500, 502, 503, 504],
    },
    headers: { ...DEFAULT_HEADERS, ...(opts.defaults?.headers ?? {}) },
    cookieJar,
    ...opts.defaults,
  });

  const acquire = async (signal?: AbortSignal): Promise<void> => {
    if (limiter) await limiter.acquire(signal);
  };

  return {
    name: opts.name,
    got: instance,
    cookieJar,
    acquire,
    async request<T>(url: string, options?: OptionsOfTextResponseBody): Promise<T> {
      await acquire(options?.signal as AbortSignal | undefined);
      return instance(url, options).json<T>();
    },
  };
}
