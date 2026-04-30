/**
 * Kite Connect HTTP client. Hand-rolled instead of pulling in the
 * `kiteconnect` npm package because:
 *   - The official package targets CJS and pulls a bunch of legacy deps.
 *   - We only need a tiny subset of endpoints (auth + holdings + LTP +
 *     quote + instruments + historical).
 *   - Hand-rolling keeps the request/response shape transparent and Zod-
 *     validated, so a Kite-side change surfaces as a clear schema error.
 *
 * Auth model: `request_token` (one-time, from the redirect URL) +
 * SHA256(api_key + request_token + api_secret) → `access_token` (valid
 * until ~6 AM IST the next day). The user runs `mp kite-login` daily
 * during market hours (or before market open) to refresh.
 *
 * Reference: https://kite.trade/docs/connect/v3/
 */

import { createHash } from 'node:crypto';
import got, { type Got } from 'got';
import { z } from 'zod';
import { config } from '../../config/env.js';
import { child } from '../../logger.js';
import {
  KiteEnvelopeSchema,
  type KiteHolding,
  KiteHoldingSchema,
  KiteLtpResponseSchema,
  KiteQuoteResponseSchema,
  type KiteSession,
  KiteSessionSchema,
} from './types.js';

const log = child({ component: 'kite-client' });

export interface KiteClientOptions {
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class KiteClient {
  readonly apiKey: string;
  private readonly apiSecret: string | undefined;
  private accessToken: string | undefined;
  private readonly http: Got;

  constructor(opts: KiteClientOptions = {}) {
    this.apiKey = opts.apiKey ?? config.KITE_API_KEY ?? '';
    this.apiSecret = opts.apiSecret ?? config.KITE_API_SECRET;
    this.accessToken = opts.accessToken ?? config.KITE_ACCESS_TOKEN;
    if (!this.apiKey) {
      throw new Error(
        'KITE_API_KEY is not set. Add your Kite Connect API key to .env (https://kite.trade > My Apps).',
      );
    }
    this.http = got.extend({
      prefixUrl: opts.baseUrl ?? config.KITE_API_BASE,
      timeout: { request: opts.timeoutMs ?? 30_000 },
      retry: { limit: 2, methods: ['GET'] },
      headers: { 'X-Kite-Version': '3' },
      throwHttpErrors: false,
    });
  }

  /** Returns true when api_key + access_token are present (auth-ready). */
  hasSession(): boolean {
    return !!(this.apiKey && this.accessToken);
  }

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  /**
   * URL the user opens in a browser to log in. Zerodha redirects to a
   * URL configured in their Kite app dashboard with `?request_token=...`
   * appended on success.
   */
  loginUrl(): string {
    return `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(this.apiKey)}`;
  }

  /**
   * Exchange a one-time request_token for a long-lived access_token.
   * The checksum is sha256(api_key + request_token + api_secret).
   */
  async generateSession(requestToken: string): Promise<KiteSession> {
    if (!this.apiSecret) {
      throw new Error('KITE_API_SECRET is required to generate a session');
    }
    const checksum = createHash('sha256')
      .update(`${this.apiKey}${requestToken}${this.apiSecret}`)
      .digest('hex');
    const form = new URLSearchParams({
      api_key: this.apiKey,
      request_token: requestToken,
      checksum,
    });
    const res = await this.http.post('session/token', {
      body: form.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      responseType: 'text',
    });
    const envelope = this.parseEnvelope(res.body, res.statusCode);
    const session = KiteSessionSchema.parse(envelope);
    this.accessToken = session.access_token;
    log.info({ user: session.user_id }, 'kite session generated');
    return session;
  }

  // -------------------------------------------------------------------------
  // Authenticated endpoints
  // -------------------------------------------------------------------------

  async getHoldings(): Promise<KiteHolding[]> {
    const data = await this.authedGet('portfolio/holdings');
    return z.array(KiteHoldingSchema).parse(data);
  }

  /**
   * Batch LTP lookup. Instruments are passed as `EXCHANGE:TRADINGSYMBOL`
   * (e.g. `NSE:RELIANCE`). Returns a map keyed by the same strings.
   */
  async getLtp(
    instruments: string[],
  ): Promise<Record<string, { instrument_token: number; last_price: number }>> {
    if (instruments.length === 0) return {};
    const params = new URLSearchParams();
    for (const i of instruments) params.append('i', i);
    const data = await this.authedGet(`quote/ltp?${params.toString()}`);
    return KiteLtpResponseSchema.parse(data);
  }

  /** Full quote (OHLC + LTP + volume) for the given instruments. */
  async getQuote(instruments: string[]) {
    if (instruments.length === 0) return {};
    const params = new URLSearchParams();
    for (const i of instruments) params.append('i', i);
    const data = await this.authedGet(`quote?${params.toString()}`);
    return KiteQuoteResponseSchema.parse(data);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async authedGet(path: string): Promise<unknown> {
    if (!this.accessToken) {
      throw new Error('No access_token set. Run `pnpm cli kite-login` first to refresh.');
    }
    const res = await this.http.get(path, {
      headers: { Authorization: `token ${this.apiKey}:${this.accessToken}` },
      responseType: 'text',
    });
    return this.parseEnvelope(res.body, res.statusCode);
  }

  private parseEnvelope(body: string, statusCode: number): unknown {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      throw new Error(`Kite returned non-JSON (status ${statusCode}): ${body.slice(0, 200)}`, {
        cause: err,
      });
    }
    const envelope = KiteEnvelopeSchema.parse(parsed);
    if (envelope.status !== 'success') {
      const detail = envelope.message ?? envelope.error_type ?? 'unknown error';
      throw new KiteApiError(
        `Kite API error (status ${statusCode}): ${detail}`,
        envelope.error_type,
        statusCode,
      );
    }
    return envelope.data;
  }
}

export class KiteApiError extends Error {
  constructor(
    message: string,
    public readonly errorType: string | undefined,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'KiteApiError';
  }

  /** True when the access_token is invalid/expired and the user must re-login. */
  isTokenExpired(): boolean {
    return (
      this.errorType === 'TokenException' ||
      (this.errorType === 'GeneralException' && this.statusCode === 403)
    );
  }
}
