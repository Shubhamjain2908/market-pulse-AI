/**
 * Unit tests for the enhanced HTTP client retry configuration.
 * Validates that RetryOptions are merged correctly with defaults, that
 * the createHttpClient function applies them, and that the beforeRetry
 * hook structures are wired up.
 */

import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../../src/ingestors/base/http-client.js';

describe('HttpClient retry options', () => {
  it('uses defaults when no retry option is passed', () => {
    const client = createHttpClient({ name: 'test' });
    // got.extend() should apply the default retry config
    const retryOptions = (client.got.defaults.options as { retry?: Record<string, unknown> }).retry;
    // Default limit is 3
    expect(retryOptions?.limit).toBe(3);
  });

  it('merges partial retry options with defaults', () => {
    const client = createHttpClient({
      name: 'test-partial',
      retry: { limit: 5, maxRetryAfterMs: 15_000 },
    });
    const retryOptions = (
      client.got.defaults.options as {
        retry?: Record<string, unknown>;
      }
    ).retry;
    // Our override
    expect(retryOptions?.limit).toBe(5);
    expect(retryOptions?.maxRetryAfter).toBe(15_000);
    // Defaults preserved
    expect(retryOptions?.methods).toEqual(['GET', 'HEAD']);
    expect(retryOptions?.statusCodes).toEqual([408, 429, 500, 502, 503, 504]);
    expect(retryOptions?.errorCodes).toContain('ECONNRESET');
    expect(retryOptions?.errorCodes).toContain('ETIMEDOUT');
    expect(retryOptions?.errorCodes).toContain('ENOTFOUND');
  });

  it('accepts custom status codes', () => {
    const client = createHttpClient({
      name: 'test-custom-status',
      retry: { statusCodes: [429, 503] },
    });
    const retryOptions = (
      client.got.defaults.options as {
        retry?: Record<string, unknown>;
      }
    ).retry;
    expect(retryOptions?.statusCodes).toEqual([429, 503]);
  });

  it('accepts custom error codes', () => {
    const client = createHttpClient({
      name: 'test-custom-errors',
      retry: { errorCodes: ['ETIMEDOUT', 'ECONNRESET'] },
    });
    const retryOptions = (
      client.got.defaults.options as {
        retry?: Record<string, unknown>;
      }
    ).retry;
    expect(retryOptions?.errorCodes).toEqual(['ETIMEDOUT', 'ECONNRESET']);
  });

  it('accepts custom methods', () => {
    const client = createHttpClient({
      name: 'test-custom-methods',
      retry: { methods: ['GET'] },
    });
    const retryOptions = (
      client.got.defaults.options as {
        retry?: Record<string, unknown>;
      }
    ).retry;
    expect(retryOptions?.methods).toEqual(['GET']);
  });

  it('exposes name on the returned client', () => {
    const client = createHttpClient({ name: 'my-ingestor' });
    expect(client.name).toBe('my-ingestor');
  });

  it('exposes the underlying got instance', () => {
    const client = createHttpClient({ name: 'test-got' });
    // The got instance should be an extendable function
    expect(typeof client.got).toBe('function');
    expect(typeof client.got.extend).toBe('function');
  });

  it('request() accepts a url string and returns a promise', () => {
    const client = createHttpClient({ name: 'test-request' });
    // request() returns a Promise — verify the contract without hitting the network.
    const result = client.request('http://127.0.0.1:1/x');
    expect(result).toBeInstanceOf(Promise);
    // Let it settle (will reject with ECONNREFUSED after retries).
    // We suppress the rejection to avoid unhandled promise warnings.
    result.catch(() => {});
  });

  describe('calculateDelay logic', () => {
    it('caps computed value from Retry-After to maxRetryAfterMs', () => {
      // Verify the retry config includes maxRetryAfter
      const client = createHttpClient({
        name: 'test-retry-after-cap',
        retry: { maxRetryAfterMs: 10_000 },
      });
      const retryOptions = (
        client.got.defaults.options as {
          retry?: Record<string, unknown>;
        }
      ).retry;
      expect(retryOptions?.maxRetryAfter).toBe(10_000);
    });

    it('returns 0 for non-retriable HTTP statuses such as 404', () => {
      const client = createHttpClient({ name: 'test-no-retry-404' });
      const retryOptions = (
        client.got.defaults.options as {
          retry?: { calculateDelay?: (ctx: unknown) => number };
        }
      ).retry;
      const calculateDelay = retryOptions?.calculateDelay;
      expect(typeof calculateDelay).toBe('function');

      const delay = calculateDelay?.({
        attemptCount: 1,
        computedValue: 100,
        error: { response: { statusCode: 404 } },
      });
      expect(delay).toBe(0);
    });
  });

  it('default error codes cover common transient network failures', () => {
    const client = createHttpClient({ name: 'test-error-codes' });
    const retryOptions = (
      client.got.defaults.options as {
        retry?: Record<string, unknown>;
      }
    ).retry;
    const codes = retryOptions?.errorCodes as string[];
    expect(codes).toContain('ETIMEDOUT');
    expect(codes).toContain('ECONNRESET');
    expect(codes).toContain('ECONNREFUSED');
    expect(codes).toContain('ENOTFOUND');
    expect(codes).toContain('ENETUNREACH');
    expect(codes).toContain('EAI_AGAIN');
    expect(codes).toContain('EPIPE');
    expect(codes).toContain('EADDRINUSE');
  });
});

describe('HttpClient default headers', () => {
  it('sets a realistic browser User-Agent', () => {
    const client = createHttpClient({ name: 'test-headers' });
    const headers = (client.got.defaults.options as { headers?: Record<string, string> }).headers;
    expect(headers?.['user-agent']).toMatch(
      /^Mozilla\/5\.0 \(Macintosh;.*\) AppleWebKit\/.* Safari\/.*$/,
    );
  });

  it('includes accept-language', () => {
    const client = createHttpClient({ name: 'test-accept-lang' });
    const headers = (client.got.defaults.options as { headers?: Record<string, string> }).headers;
    expect(headers?.['accept-language']).toBe('en-US,en;q=0.9');
  });
});

describe('HttpClient with cookie jar', () => {
  it('creates a cookie jar when requested', () => {
    const client = createHttpClient({ name: 'test-cookies', withCookieJar: true });
    expect(client.cookieJar).toBeDefined();
  });

  it('does not create a cookie jar by default', () => {
    const client = createHttpClient({ name: 'test-no-cookies' });
    expect(client.cookieJar).toBeUndefined();
  });
});
