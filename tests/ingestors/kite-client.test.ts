import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KiteApiError, KiteClient } from '../../src/ingestors/kite/client.js';

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe('KiteClient', () => {
  let server: Server;
  let baseUrl: string;
  let received: RecordedRequest[] = [];
  let nextResponse: { status: number; body: string } = { status: 200, body: '' };

  beforeEach(async () => {
    received = [];
    nextResponse = { status: 200, body: '' };
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push({
          method: req.method ?? 'GET',
          url: req.url ?? '',
          headers: req.headers,
          body,
        });
        res.writeHead(nextResponse.status, { 'content-type': 'application/json' });
        res.end(nextResponse.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('generateSession sends api_key + request_token + checksum and parses session', async () => {
    nextResponse = {
      status: 200,
      body: JSON.stringify({
        status: 'success',
        data: {
          user_id: 'AB1234',
          user_name: 'Test User',
          api_key: 'thekey',
          access_token: 'fresh-token-xyz',
          login_time: '2026-04-30 09:15:00',
        },
      }),
    };

    const client = new KiteClient({
      apiKey: 'thekey',
      apiSecret: 'thesecret',
      baseUrl,
    });
    const session = await client.generateSession('reqtoken123');

    expect(session.access_token).toBe('fresh-token-xyz');
    expect(session.user_id).toBe('AB1234');

    const req = received[0];
    expect(req).toBeDefined();
    if (!req) return;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/session/token');
    expect(req.body).toContain('api_key=thekey');
    expect(req.body).toContain('request_token=reqtoken123');
    // sha256("thekey" + "reqtoken123" + "thesecret") deterministically
    expect(req.body).toMatch(/checksum=[a-f0-9]{64}/);
  });

  it('getHoldings sends Authorization header with api_key:access_token', async () => {
    nextResponse = {
      status: 200,
      body: JSON.stringify({
        status: 'success',
        data: [
          {
            tradingsymbol: 'INFY',
            exchange: 'NSE',
            quantity: 50,
            average_price: 1500,
            last_price: 1620,
            pnl: 6000,
            day_change: 200,
            day_change_percentage: 0.5,
            product: 'CNC',
          },
        ],
      }),
    };

    const client = new KiteClient({
      apiKey: 'thekey',
      apiSecret: 'thesecret',
      accessToken: 'tok',
      baseUrl,
    });
    const holdings = await client.getHoldings();

    expect(holdings).toHaveLength(1);
    expect(holdings[0]?.tradingsymbol).toBe('INFY');
    expect(received[0]?.headers.authorization).toBe('token thekey:tok');
    expect(received[0]?.headers['x-kite-version']).toBe('3');
  });

  it('throws KiteApiError when the API reports an error envelope', async () => {
    nextResponse = {
      status: 403,
      body: JSON.stringify({
        status: 'error',
        message: 'Token is invalid or has expired',
        error_type: 'TokenException',
      }),
    };
    const client = new KiteClient({
      apiKey: 'k',
      apiSecret: 's',
      accessToken: 'expired',
      baseUrl,
    });
    await expect(client.getHoldings()).rejects.toBeInstanceOf(KiteApiError);

    try {
      await client.getHoldings();
    } catch (err) {
      expect(err).toBeInstanceOf(KiteApiError);
      const e = err as KiteApiError;
      expect(e.errorType).toBe('TokenException');
      expect(e.isTokenExpired()).toBe(true);
    }
  });

  it('hasSession reflects api_key + access_token presence', () => {
    expect(new KiteClient({ apiKey: 'k', apiSecret: 's', accessToken: 't' }).hasSession()).toBe(
      true,
    );
    expect(new KiteClient({ apiKey: 'k', apiSecret: 's' }).hasSession()).toBe(false);
  });

  it('loginUrl encodes the api_key', () => {
    const url = new KiteClient({ apiKey: 'a/b' }).loginUrl();
    expect(url).toContain('api_key=a%2Fb');
    expect(url).toMatch(/^https:\/\/kite\.zerodha\.com\/connect\/login/);
  });
});
