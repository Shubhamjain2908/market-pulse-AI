/**
 * Live (intraday) scanner. Fetches current LTP for the watchlist + every
 * portfolio holding via Kite Connect, persists each tick to the
 * `intraday_quotes` table, and flags symbols whose intraday move crosses
 * a configured threshold (default ±3%) as live alerts.
 *
 * Designed to be cron'd every 5-15 minutes during market hours. One pass
 * per invocation — no long-running daemons. If you want true streaming,
 * Kite supports a WebSocket ticker; that's a follow-up phase.
 *
 * No-op (with warning) when PORTFOLIO_SOURCE != 'kite' or
 * KITE_ACCESS_TOKEN is not set.
 */

import { type Alert, upsertAlerts } from '../analysers/alerts.js';
import { config } from '../config/env.js';
import { loadWatchlist } from '../config/loaders.js';
import {
  type IntradayQuoteRow,
  getDb,
  getLatestHoldings,
  upsertIntradayQuotes,
} from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { KiteApiError, KiteClient } from '../ingestors/kite/client.js';
import { child } from '../logger.js';

const log = child({ component: 'live-scanner' });

export interface LiveScanOptions {
  /** Pct move that triggers a live alert. Default 3%. */
  alertThresholdPct?: number;
  /** Override the universe; defaults to watchlist + holdings. */
  symbols?: string[];
}

export interface LiveScanResult {
  symbolsScanned: number;
  ticksWritten: number;
  alertsFlagged: number;
  capturedAt: string;
  skipped?: string;
}

export async function runLiveScan(opts: LiveScanOptions = {}): Promise<LiveScanResult> {
  const capturedAt = new Date().toISOString();

  if (config.MARKET_DATA_PROVIDER !== 'kite' || !config.KITE_ACCESS_TOKEN) {
    log.info('skipping live scan — set MARKET_DATA_PROVIDER=kite and run kite-login first');
    return {
      symbolsScanned: 0,
      ticksWritten: 0,
      alertsFlagged: 0,
      capturedAt,
      skipped: 'kite not configured',
    };
  }

  const universe = buildUniverse(opts.symbols);
  if (universe.length === 0) {
    return { symbolsScanned: 0, ticksWritten: 0, alertsFlagged: 0, capturedAt };
  }

  const client = new KiteClient();
  const instruments = universe.map((s) => `NSE:${s}`);

  let quotes: Awaited<ReturnType<KiteClient['getQuote']>>;
  try {
    quotes = await client.getQuote(instruments);
  } catch (err) {
    if (err instanceof KiteApiError && err.isTokenExpired()) {
      throw new Error('Kite access_token expired. Refresh with `pnpm cli kite-login`.');
    }
    throw err;
  }

  const ticks: IntradayQuoteRow[] = [];
  const alerts: Alert[] = [];
  const today = isoDateIst();
  const threshold = opts.alertThresholdPct ?? 3;

  for (const i of instruments) {
    const q = quotes[i];
    if (!q) continue;
    const symbol = i.split(':')[1];
    if (!symbol) continue;
    const prevClose = q.ohlc?.close ?? null;
    const changePct =
      prevClose != null && prevClose > 0 ? ((q.last_price - prevClose) / prevClose) * 100 : null;

    ticks.push({
      symbol,
      capturedAt,
      lastPrice: q.last_price,
      prevClose,
      changePct,
      volume: q.volume ?? null,
      source: 'kite-quote',
    });

    if (changePct != null && Math.abs(changePct) >= threshold) {
      const direction = changePct > 0 ? 'up' : 'down';
      alerts.push({
        symbol,
        date: today,
        kind: changePct > 0 ? 'volume_spike' : 'volume_spike', // re-using kind enum
        signal: 'intraday_move_pct',
        value: changePct,
        message: `Intraday ${direction} ${changePct.toFixed(2)}% from previous close (${prevClose?.toFixed(2)} → ${q.last_price.toFixed(2)})`,
      });
    }
  }

  upsertIntradayQuotes(ticks, getDb());
  upsertAlerts(alerts, getDb());

  log.info(
    {
      capturedAt,
      symbols: universe.length,
      ticks: ticks.length,
      alerts: alerts.length,
    },
    'live scan complete',
  );

  return {
    symbolsScanned: universe.length,
    ticksWritten: ticks.length,
    alertsFlagged: alerts.length,
    capturedAt,
  };
}

function buildUniverse(override?: string[]): string[] {
  if (override && override.length > 0) return override.map((s) => s.toUpperCase());
  const watchlist = loadWatchlist().symbols.map((s) => s.toUpperCase());
  const holdings = getLatestHoldings(getDb()).map((h) => h.symbol.toUpperCase());
  return [...new Set([...watchlist, ...holdings])];
}
