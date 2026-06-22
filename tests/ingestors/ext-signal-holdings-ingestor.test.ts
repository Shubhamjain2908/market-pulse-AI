import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as loaders from '../../src/config/loaders.js';
import { PROJECT_ROOT } from '../../src/config/project-paths.js';
import { closeDb, getDb, migrate } from '../../src/db/index.js';

const mockWarn = vi.hoisted(() => vi.fn());
const noop = vi.hoisted(() => vi.fn());

vi.mock('../../src/logger.js', () => {
  const stub = () => ({
    warn: mockWarn,
    info: noop,
    debug: noop,
    error: noop,
    child: stub,
  });
  const logger = stub();
  return { child: stub, logger };
});

import {
  runExtSignalHoldingsIngestor,
  unwrapHoldingsPayload,
} from '../../src/ingestors/ext-signal-holdings-ingestor.js';

const ENDPOINT = 'https://example.com/mcp/';
const STRATEGIES = [
  { name: 'momentum_blend_monthly_rebalance', display_name: 'Multi-Horizon Momentum Blend' },
  { name: 'DCF_Compounder_Stack', display_name: 'DCF Compounder Stack' },
] as const;

function providerConfig(
  overrides: Partial<loaders.ExtSignalProviderFile> = {},
): loaders.ExtSignalProviderFile {
  return {
    enabled: true,
    strategies: [...STRATEGIES],
    ...overrides,
  };
}

function holdingsText(positions: Array<{ symbol: string; price: number; weight_pct: number }>) {
  return JSON.stringify({
    strategy: 'momentum_blend_monthly_rebalance',
    as_of: '2026-05-29 00:00:00',
    positions,
  });
}

function jsonRpcToolResult(text: string) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text }] },
  };
}

function jsonRpcInitResult() {
  return {
    jsonrpc: '2.0',
    id: 0,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'provider', version: '0.1.0' },
    },
  };
}

function mockFetchForStrategies(
  handlers: Record<string, () => Response | Promise<Response>>,
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(ENDPOINT);
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params?: { arguments?: { name?: string } };
      };
      if (body.method === 'initialize') {
        return new Response(JSON.stringify(jsonRpcInitResult()), { status: 200 });
      }
      const name = body.params?.arguments?.name ?? '';
      const handler = handlers[name];
      if (!handler) {
        return new Response('not found', { status: 404 });
      }
      return handler();
    }),
  );
}

describe('ext-signal-holdings-ingestor', () => {
  let dbPath: string;
  let originalApiKey: string | undefined;
  let originalEndpoint: string | undefined;
  let configSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-ext-signal-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
    originalApiKey = process.env.EXT_SIGNAL_API_KEY;
    originalEndpoint = process.env.EXT_SIGNAL_ENDPOINT;
    mockWarn.mockClear();
    vi.unstubAllGlobals();
    loaders.clearConfigCache();
  });

  afterEach(() => {
    configSpy?.mockRestore();
    if (originalApiKey === undefined) {
      delete process.env.EXT_SIGNAL_API_KEY;
    } else {
      process.env.EXT_SIGNAL_API_KEY = originalApiKey;
    }
    if (originalEndpoint === undefined) {
      delete process.env.EXT_SIGNAL_ENDPOINT;
    } else {
      process.env.EXT_SIGNAL_ENDPOINT = originalEndpoint;
    }
    closeDb();
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`);
      rmSync(`${dbPath}-shm`);
    } catch {
      // ignore
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    loaders.clearConfigCache();
  });

  function dbWithMigration() {
    const db = getDb({ path: dbPath });
    migrate(db);
    return db;
  }

  it('skips when EXT_SIGNAL_API_KEY absent (warn, no rows)', async () => {
    delete process.env.EXT_SIGNAL_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const db = dbWithMigration();
    await runExtSignalHoldingsIngestor(db);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalled();
    const count = (
      db.prepare('SELECT COUNT(*) AS c FROM ext_signal_holdings').get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it('skips when enabled=false (fetch never called)', async () => {
    process.env.EXT_SIGNAL_API_KEY = 'test-key';
    process.env.EXT_SIGNAL_ENDPOINT = ENDPOINT;
    configSpy = vi
      .spyOn(loaders, 'loadExtSignalProvider')
      .mockReturnValue(providerConfig({ enabled: false }));

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const db = dbWithMigration();
    await runExtSignalHoldingsIngestor(db);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when EXT_SIGNAL_ENDPOINT missing (warn, fetch never called)', async () => {
    process.env.EXT_SIGNAL_API_KEY = 'test-key';
    delete process.env.EXT_SIGNAL_ENDPOINT;
    configSpy = vi.spyOn(loaders, 'loadExtSignalProvider').mockReturnValue(providerConfig());

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const db = dbWithMigration();
    await runExtSignalHoldingsIngestor(db);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalled();
  });

  it('unwraps ftInvstr MCP envelope { data: { positions } }', () => {
    const payload = unwrapHoldingsPayload({
      scope: { strategy: 'DCF_Compounder_Stack' },
      data: {
        strategy: 'DCF_Compounder_Stack',
        as_of: '2026-06-19 00:00:00',
        positions: [{ symbol: 'BSE', price: 4024.9, weight_pct: 6.59 }],
      },
      meta: { disclaimer: 'research' },
    });
    expect(payload.positions).toHaveLength(1);
    expect(payload.positions?.[0]?.symbol).toBe('BSE');
  });

  it('ingests both strategies on success', async () => {
    process.env.EXT_SIGNAL_API_KEY = 'test-key';
    process.env.EXT_SIGNAL_ENDPOINT = ENDPOINT;
    configSpy = vi.spyOn(loaders, 'loadExtSignalProvider').mockReturnValue(providerConfig());

    mockFetchForStrategies({
      momentum_blend_monthly_rebalance: () =>
        new Response(
          JSON.stringify(
            jsonRpcToolResult(
              holdingsText([
                { symbol: 'STLTECH', price: 536.15, weight_pct: 9.84 },
                { symbol: 'RELIANCE', price: 100, weight_pct: 5.1 },
              ]),
            ),
          ),
          { status: 200 },
        ),
      DCF_Compounder_Stack: () =>
        new Response(
          JSON.stringify(
            jsonRpcToolResult(
              JSON.stringify({
                strategy: 'DCF_Compounder_Stack',
                positions: [{ symbol: 'TCS', price: 4000, weight_pct: 12 }],
              }),
            ),
          ),
          { status: 200 },
        ),
    });

    const db = dbWithMigration();
    await runExtSignalHoldingsIngestor(db);

    const rows = db
      .prepare('SELECT strategy_name, symbol, weight_pct FROM ext_signal_holdings ORDER BY symbol')
      .all() as Array<{ strategy_name: string; symbol: string; weight_pct: number }>;
    expect(rows.length).toBe(3);
    expect(rows.some((r) => r.symbol === 'STLTECH')).toBe(true);
    expect(rows.some((r) => r.symbol === 'TCS')).toBe(true);
  });

  it('continues when one strategy hits network error', async () => {
    process.env.EXT_SIGNAL_API_KEY = 'test-key';
    process.env.EXT_SIGNAL_ENDPOINT = ENDPOINT;
    configSpy = vi.spyOn(loaders, 'loadExtSignalProvider').mockReturnValue(providerConfig());

    let initCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe(ENDPOINT);
        const body = JSON.parse(String(init?.body)) as {
          method: string;
          params?: { arguments?: { name?: string } };
        };
        if (body.method === 'initialize') {
          initCalls += 1;
          if (initCalls === 1) throw new Error('network down');
          return new Response(JSON.stringify(jsonRpcInitResult()), { status: 200 });
        }
        if (body.params?.arguments?.name === 'DCF_Compounder_Stack') {
          return new Response(
            JSON.stringify(
              jsonRpcToolResult(
                JSON.stringify({
                  positions: [{ symbol: 'INFY', price: 10, weight_pct: 8 }],
                }),
              ),
            ),
            { status: 200 },
          );
        }
        return new Response('error', { status: 500 });
      }),
    );

    const db = dbWithMigration();
    await expect(runExtSignalHoldingsIngestor(db)).resolves.toMatchObject({
      skipped: false,
    });

    const infy = db
      .prepare(
        `SELECT 1 FROM ext_signal_holdings WHERE symbol = 'INFY' AND strategy_name = 'DCF_Compounder_Stack'`,
      )
      .get();
    expect(infy).toBeTruthy();
  });

  it('continues when one strategy returns HTTP 500', async () => {
    process.env.EXT_SIGNAL_API_KEY = 'test-key';
    process.env.EXT_SIGNAL_ENDPOINT = ENDPOINT;
    configSpy = vi.spyOn(loaders, 'loadExtSignalProvider').mockReturnValue(providerConfig());

    mockFetchForStrategies({
      momentum_blend_monthly_rebalance: () => new Response('error', { status: 500 }),
      DCF_Compounder_Stack: () =>
        new Response(
          JSON.stringify(
            jsonRpcToolResult(
              JSON.stringify({
                positions: [{ symbol: 'WIPRO', price: 10, weight_pct: 8 }],
              }),
            ),
          ),
          { status: 200 },
        ),
    });

    const db = dbWithMigration();
    await expect(runExtSignalHoldingsIngestor(db)).resolves.toMatchObject({
      skipped: false,
    });

    const row = db
      .prepare(
        `SELECT 1 FROM ext_signal_holdings WHERE symbol = 'WIPRO' AND strategy_name = 'DCF_Compounder_Stack'`,
      )
      .get();
    expect(row).toBeTruthy();
  });

  it('INSERT OR IGNORE on duplicate run keeps row count stable', async () => {
    process.env.EXT_SIGNAL_API_KEY = 'test-key';
    process.env.EXT_SIGNAL_ENDPOINT = ENDPOINT;
    configSpy = vi.spyOn(loaders, 'loadExtSignalProvider').mockReturnValue({
      enabled: true,
      strategies: [{ name: 'momentum_blend_monthly_rebalance', display_name: 'Mom' }],
    });

    mockFetchForStrategies({
      momentum_blend_monthly_rebalance: () =>
        new Response(
          JSON.stringify(
            jsonRpcToolResult(holdingsText([{ symbol: 'STLTECH', price: 1, weight_pct: 10 }])),
          ),
          { status: 200 },
        ),
    });

    const db = dbWithMigration();
    await runExtSignalHoldingsIngestor(db);
    const afterFirst = (
      db.prepare('SELECT COUNT(*) AS c FROM ext_signal_holdings').get() as { c: number }
    ).c;
    await runExtSignalHoldingsIngestor(db);
    const afterSecond = (
      db.prepare('SELECT COUNT(*) AS c FROM ext_signal_holdings').get() as { c: number }
    ).c;
    expect(afterSecond).toBe(afterFirst);
  });

  it('malformed response (no positions) is caught without throwing', async () => {
    process.env.EXT_SIGNAL_API_KEY = 'test-key';
    process.env.EXT_SIGNAL_ENDPOINT = ENDPOINT;
    configSpy = vi.spyOn(loaders, 'loadExtSignalProvider').mockReturnValue({
      enabled: true,
      strategies: [{ name: 'momentum_blend_monthly_rebalance', display_name: 'Mom' }],
    });

    mockFetchForStrategies({
      momentum_blend_monthly_rebalance: () =>
        new Response(
          JSON.stringify(jsonRpcToolResult(JSON.stringify({ strategy: 'x', as_of: '2026-05-29' }))),
          { status: 200 },
        ),
    });

    const db = dbWithMigration();
    await expect(runExtSignalHoldingsIngestor(db)).resolves.toMatchObject({
      skipped: false,
    });
    const count = (
      db.prepare('SELECT COUNT(*) AS c FROM ext_signal_holdings').get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it('filters weight_pct <= 0', async () => {
    process.env.EXT_SIGNAL_API_KEY = 'test-key';
    process.env.EXT_SIGNAL_ENDPOINT = ENDPOINT;
    configSpy = vi.spyOn(loaders, 'loadExtSignalProvider').mockReturnValue({
      enabled: true,
      strategies: [{ name: 'momentum_blend_monthly_rebalance', display_name: 'Mom' }],
    });

    mockFetchForStrategies({
      momentum_blend_monthly_rebalance: () =>
        new Response(
          JSON.stringify(
            jsonRpcToolResult(
              holdingsText([
                { symbol: 'CLOSED', price: 1, weight_pct: 0 },
                { symbol: 'SHORT', price: 1, weight_pct: -0.1 },
                { symbol: 'KEEP', price: 1, weight_pct: 3.5 },
              ]),
            ),
          ),
          { status: 200 },
        ),
    });

    const db = dbWithMigration();
    await runExtSignalHoldingsIngestor(db);
    const symbols = db.prepare('SELECT symbol FROM ext_signal_holdings').all() as Array<{
      symbol: string;
    }>;
    expect(symbols.map((s) => s.symbol)).toEqual(['KEEP']);
  });

  it('initialize handshake failure skips strategy without throw', async () => {
    process.env.EXT_SIGNAL_API_KEY = 'test-key';
    process.env.EXT_SIGNAL_ENDPOINT = ENDPOINT;
    configSpy = vi.spyOn(loaders, 'loadExtSignalProvider').mockReturnValue({
      enabled: true,
      strategies: [{ name: 'momentum_blend_monthly_rebalance', display_name: 'Mom' }],
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === 'initialize') {
          throw new Error('network down');
        }
        return new Response(
          JSON.stringify(
            jsonRpcToolResult(holdingsText([{ symbol: 'X', price: 1, weight_pct: 1 }])),
          ),
          { status: 200 },
        );
      }),
    );

    const db = dbWithMigration();
    await expect(runExtSignalHoldingsIngestor(db)).resolves.toMatchObject({
      skipped: false,
    });
    const count = (
      db.prepare('SELECT COUNT(*) AS c FROM ext_signal_holdings').get() as { c: number }
    ).c;
    expect(count).toBe(0);
  });

  it('loads committed config file shape', () => {
    const cfg = loaders.loadExtSignalProvider({ fresh: true });
    const onDisk = JSON.parse(
      readFileSync(join(PROJECT_ROOT, 'config', 'ext-signal-provider.json'), 'utf8'),
    ) as { enabled: boolean; strategies: unknown[] };
    expect(typeof cfg.enabled).toBe('boolean');
    expect(onDisk.enabled).toBe(true);
    expect(Array.isArray(onDisk.strategies)).toBe(true);
    expect(onDisk.strategies).toHaveLength(3);
    expect(onDisk).not.toHaveProperty('endpoint');
  });
});
