/**
 * External signal provider holdings → `ext_signal_holdings`.
 * Fail-open: never throws to workflow callers. One MCP session (initialize + tools/call) per strategy.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { loadExtSignalProvider } from '../config/loaders.js';
import { child } from '../logger.js';
import { isoDateIst } from './base/dates.js';

const log = child({ component: 'ext-signal-holdings-ingestor' });

const STRATEGY_TIMEOUT_MS = 15_000;

export interface ExtSignalIngestResult {
  skipped: boolean;
  skipReason?: string;
  asOf: string;
  strategiesAttempted: number;
  strategiesSucceeded: number;
  /** Net-new rows written today (`INSERT OR IGNORE` with `changes > 0`). */
  symbolsInserted: number;
  /** Rows skipped because the same `(strategy_name, symbol, as_of)` already exists. */
  alreadyPresent: number;
}

function skippedIngest(reason: string, asOf: string): ExtSignalIngestResult {
  return {
    skipped: true,
    skipReason: reason,
    asOf,
    strategiesAttempted: 0,
    strategiesSucceeded: 0,
    symbolsInserted: 0,
    alreadyPresent: 0,
  };
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    protocolVersion?: string;
  };
  error?: { message?: string; code?: number };
}

interface HoldingsPosition {
  symbol: string;
  price?: number;
  weight_pct: number;
}

interface HoldingsPayload {
  strategy?: string;
  as_of?: string;
  positions?: HoldingsPosition[];
}

function extractExtraHeaders(res: Response): Record<string, string> {
  const extra: Record<string, string> = {};
  const sessionId = res.headers.get('mcp-session-id');
  if (sessionId) extra['mcp-session-id'] = sessionId;
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    extra.Cookie = setCookie.map((c) => c.split(';')[0] ?? c).join('; ');
  }
  return extra;
}

async function postJsonRpc(
  endpoint: string,
  body: Record<string, unknown>,
  apiKey: string,
  signal: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Promise<{ json: JsonRpcResponse; extraHeaders: Record<string, string> }> {
  const res = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const responseExtra = extractExtraHeaders(res);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ext signal provider HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  let json: JsonRpcResponse;
  try {
    json = JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw new Error('ext signal provider response is not valid JSON');
  }
  if (json.error) {
    throw new Error(json.error.message ?? 'ext signal provider JSON-RPC error');
  }
  return { json, extraHeaders: responseExtra };
}

async function mcpInitialize(
  endpoint: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const { extraHeaders } = await postJsonRpc(
    endpoint,
    {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'market-pulse-ai', version: '1.0.0' },
      },
    },
    apiKey,
    signal,
  );
  return extraHeaders;
}

function parseHoldingsFromToolResult(json: JsonRpcResponse): HoldingsPayload {
  const text = json.result?.content?.[0]?.text;
  if (!text) throw new Error('ext signal holdings: missing result.content[0].text');
  const payload = JSON.parse(text) as HoldingsPayload;
  if (!Array.isArray(payload.positions)) {
    throw new Error('ext signal holdings: missing positions array');
  }
  return payload;
}

async function fetchStrategyHoldings(
  endpoint: string,
  strategyName: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<HoldingsPayload> {
  const sessionHeaders = await mcpInitialize(endpoint, apiKey, signal);
  const { json } = await postJsonRpc(
    endpoint,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_holdings',
        arguments: { name: strategyName },
      },
    },
    apiKey,
    signal,
    sessionHeaders,
  );
  return parseHoldingsFromToolResult(json);
}

export async function runExtSignalHoldingsIngestor(
  db: DatabaseType,
): Promise<ExtSignalIngestResult> {
  const asOf = isoDateIst();
  const fileConfig = loadExtSignalProvider();
  if (!fileConfig.enabled) {
    return skippedIngest('config disabled', asOf);
  }

  const endpoint = process.env.EXT_SIGNAL_ENDPOINT?.trim();
  if (!endpoint) {
    log.warn('EXT_SIGNAL_ENDPOINT not set — skipping ext signal holdings ingest');
    return skippedIngest('EXT_SIGNAL_ENDPOINT not set', asOf);
  }

  const apiKey = process.env.EXT_SIGNAL_API_KEY?.trim();
  if (!apiKey) {
    log.warn('ext signal provider key not set — skipping holdings ingest');
    return skippedIngest('EXT_SIGNAL_API_KEY not set', asOf);
  }
  const insert = db.prepare(`
    INSERT OR IGNORE INTO ext_signal_holdings
      (strategy_name, symbol, as_of, weight_pct, price, source)
    VALUES (?, ?, ?, ?, ?, 'ext_signal')
  `);

  let strategiesAttempted = 0;
  let strategiesSucceeded = 0;
  let symbolsInserted = 0;
  let positionsAttempted = 0;

  for (const strategy of fileConfig.strategies) {
    strategiesAttempted += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STRATEGY_TIMEOUT_MS);
    try {
      const payload = await fetchStrategyHoldings(
        endpoint,
        strategy.name,
        apiKey,
        controller.signal,
      );
      let strategyInserted = 0;
      for (const pos of payload.positions ?? []) {
        const weight = pos.weight_pct;
        if (!Number.isFinite(weight) || weight <= 0) continue;
        const symbol = String(pos.symbol ?? '')
          .trim()
          .toUpperCase();
        if (!symbol) continue;
        positionsAttempted += 1;
        const price =
          pos.price != null && Number.isFinite(pos.price) ? (pos.price as number) : null;
        const result = insert.run(strategy.name, symbol, asOf, weight, price);
        if (result.changes > 0) {
          strategyInserted += 1;
          symbolsInserted += 1;
        }
      }
      strategiesSucceeded += 1;
      log.debug(
        { strategy: strategy.name, symbolsInserted: strategyInserted, asOf },
        'ext signal strategy holdings ingested',
      );
    } catch (err) {
      log.warn(
        { err: (err as Error).message, strategy: strategy.name },
        'ext signal strategy holdings ingest failed',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  const alreadyPresent = positionsAttempted - symbolsInserted;

  log.info(
    {
      strategiesAttempted,
      strategiesSucceeded,
      symbolsInserted,
      alreadyPresent,
    },
    'ext signal holdings ingest complete',
  );

  return {
    skipped: false,
    asOf,
    strategiesAttempted,
    strategiesSucceeded,
    symbolsInserted,
    alreadyPresent,
  };
}
