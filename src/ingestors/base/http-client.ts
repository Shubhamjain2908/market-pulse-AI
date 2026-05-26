/**
 * Shared HTTP client factory backed by `got`. Adds:
 *   - per-host rate limiting (token bucket)
 *   - cookie jar (for sites like NSE that require warm-up)
 *   - configurable retry policy with exponential backoff + jitter
 *   - structured logging of retry attempts
 *   - network error code handling (ECONNRESET, ETIMEDOUT, ENOTFOUND, ...)
 *   - maxRetryAfter cap to avoid infinite waits on 429/503 Retry-After
 *   - realistic User-Agent + Accept headers
 *
 * Each ingestor module gets its own client via `createHttpClient()` so they
 * don't trample each other's rate buckets.
 */

import got, { type Got, type OptionsOfTextResponseBody, type RequestError } from 'got';
import { CookieJar } from 'tough-cookie';
import { child } from '../../logger.js';
import { RateLimiter, type RateLimiterOptions } from './rate-limiter.js';

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Maximum number of retry attempts. Default 3. */
  limit: number;

  /** HTTP methods eligible for retry. Default ['GET', 'HEAD']. */
  methods: Array<'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'>;

  /** HTTP status codes that trigger a retry. Default [408, 429, 500, 502, 503, 504]. */
  statusCodes: number[];

  /**
   * Node.js error codes that trigger a retry (network-level failures).
   * Default covers transient errors: ETIMEDOUT, ECONNRESET, EADDRINUSE,
   * ECONNREFUSED, EPIPE, ENOTFOUND, ENETUNREACH, EAI_AGAIN.
   */
  errorCodes: string[];

  /**
   * Upper bound (ms) on how long to honour a Retry-After header.
   * Default 30_000 — a 429 asking us to wait 5 minutes will be capped to 30s.
   */
  maxRetryAfterMs: number;

  /**
   * Minimum delay (ms) between retries. Actual delay is computed as
   * `Math.min(maxDelayMs, baseDelayMs * 2^attempt + jitter)`.
   * Default 1_000.
   */
  baseDelayMs: number;

  /**
   * Maximum delay (ms) between retries. Default 10_000.
   */
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryOptions = {
  limit: 3,
  methods: ['GET', 'HEAD'],
  statusCodes: [408, 429, 500, 502, 503, 504],
  errorCodes: [
    'ETIMEDOUT',
    'ECONNRESET',
    'EADDRINUSE',
    'ECONNREFUSED',
    'EPIPE',
    'ENOTFOUND',
    'ENETUNREACH',
    'EAI_AGAIN',
  ],
  maxRetryAfterMs: 30_000,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
};

const retryLog = child({ component: 'http-client-retry' });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HttpClientOptions {
  /** Stable identifier for logging/debugging. */
  name: string;
  /** Defaults applied to every request (e.g. `prefixUrl`, `headers`). */
  defaults?: OptionsOfTextResponseBody;
  /** Token-bucket configuration. Leave undefined to disable rate limiting. */
  rateLimit?: RateLimiterOptions;
  /** Enable a cookie jar — required for NSE-style session sites. */
  withCookieJar?: boolean;
  /**
   * Retry policy overrides. Fields that aren't provided fall back to
   * {@link DEFAULT_RETRY}. Example: `{ limit: 5, maxRetryAfterMs: 15_000 }`.
   */
  retry?: Partial<RetryOptions>;
}

export interface HttpClient {
  readonly name: string;
  readonly got: Got;
  readonly cookieJar: CookieJar | undefined;
  /** Acquire a rate-limit token. Most callers should use `request()` instead. */
  acquire(signal?: AbortSignal): Promise<void>;
  /** Convenience wrapper — acquires a token then calls `got()`. */
  request<T>(url: string, options?: OptionsOfTextResponseBody): Promise<T>;
}

// ---------------------------------------------------------------------------
// Default headers
// ---------------------------------------------------------------------------

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'user-agent': DEFAULT_USER_AGENT,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
} as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const cookieJar = opts.withCookieJar ? new CookieJar() : undefined;
  const limiter = opts.rateLimit ? new RateLimiter(opts.rateLimit) : undefined;

  const retryCfg: RetryOptions = { ...DEFAULT_RETRY, ...opts.retry };

  const instance = got.extend({
    timeout: { request: 20_000 },
    retry: {
      limit: retryCfg.limit,
      methods: retryCfg.methods,
      statusCodes: retryCfg.statusCodes,
      errorCodes: retryCfg.errorCodes,
      maxRetryAfter: retryCfg.maxRetryAfterMs,
      calculateDelay: ({
        attemptCount,
        computedValue,
        error,
      }: {
        attemptCount: number;
        computedValue: number;
        error?: RequestError;
      }) => {
        const statusCode = error?.response?.statusCode ?? 0;

        // Guardrail: never retry non-retriable HTTP statuses (e.g. 404).
        if (statusCode > 0 && !retryCfg.statusCodes.includes(statusCode)) {
          return 0;
        }

        // If got computed a value (e.g. from Retry-After header), cap it.
        if (computedValue > 0) {
          return Math.min(computedValue, retryCfg.maxRetryAfterMs);
        }
        // Otherwise, exponential backoff with full jitter.
        const delay = Math.min(retryCfg.maxDelayMs, retryCfg.baseDelayMs * 2 ** (attemptCount - 1));
        // Full jitter: random [0, delay).
        return Math.round(Math.random() * delay);
      },
    },
    headers: { ...DEFAULT_HEADERS, ...(opts.defaults?.headers ?? {}) },
    cookieJar,
    hooks: {
      beforeRetry: [
        (err: RequestError) => {
          retryLog.warn(
            {
              errorCode: err.code ?? 'unknown',
              statusCode: err.response?.statusCode ?? 0,
              name: opts.name,
            },
            `http retry — ${opts.name}`,
          );
        },
      ],
    },
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
      await acquire(options?.signal ?? undefined);
      return instance(url, options).json<T>();
    },
  };
}
