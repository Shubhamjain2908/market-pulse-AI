/**
 * One-shot Yahoo historical OHLCV backfill into `quotes`.
 *
 * - Conflicts: INSERT OR IGNORE on PK (symbol, exchange, date) — never overwrites live rows.
 * - `close` = Yahoo unadjusted close; `adj_close` = Yahoo adj. close (for returns / splits).
 * - `source` = `yahoo_historical` (distinct from live `yahoo`).
 *
 * Usage:
 *   pnpm exec tsx src/scripts/ingest-historical-quotes.ts --symbols all --from 2020-01-01 --to 2026-05-21
 *   pnpm exec tsx src/scripts/ingest-historical-quotes.ts --symbols RELIANCE,TCS --from 2020-01-01 --to 2026-05-21 --dry-run
 */

import { parseArgs } from 'node:util';
import type { Database as DatabaseType } from 'better-sqlite3';
import YahooFinance from 'yahoo-finance2';
import { getMomentumUniverseSymbols } from '../config/loaders.js';
import { MARKET_TIMEZONE } from '../constants.js';
import { closeDb, getDb, migrate } from '../db/index.js';
import { isIsoDate, parseIsoDate } from '../ingestors/base/dates.js';
import { toYahooFinanceTicker } from '../market/yahoo-ticker.js';

const BATCH_SIZE = 10;
const RETRY_LIMIT = 3;
const DELAY_MS = 1200;
/** Yahoo daily bars are UTC-aligned; shift by IST offset before calendar-day bucketing (see spec). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const yahoo = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

interface YahooChartBar {
  date: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  adjclose?: number | null;
  volume?: number | null;
}

type HistoricalQuoteInsert = {
  symbol: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adj_close: number | null;
  volume: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage(): void {
  console.log(`Usage:
  pnpm exec tsx src/scripts/ingest-historical-quotes.ts \\
    --symbols all|<comma-separated> \\
    --from YYYY-MM-DD \\
    --to YYYY-MM-DD \\
    [--dry-run]
`);
}

function normalizeNseSymbol(raw: string): string {
  const u = raw.trim().toUpperCase();
  if (u.endsWith('.NS')) return u.slice(0, -3);
  return u;
}

/** IST calendar date for the bar: Yahoo UTC stamp + 5:30, then YYYY-MM-DD in Asia/Kolkata. */
function barTradingDateIst(barDate: Date): string {
  const shifted = new Date(barDate.getTime() + IST_OFFSET_MS);
  return shifted.toLocaleDateString('sv-SE', { timeZone: MARKET_TIMEZONE });
}

function isIstWeekendIso(isoDate: string): boolean {
  const noonIst = new Date(`${isoDate}T12:00:00+05:30`);
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TIMEZONE,
    weekday: 'short',
  }).format(noonIst);
  return wd === 'Sat' || wd === 'Sun';
}

function chartBarToRow(symbol: string, q: YahooChartBar): HistoricalQuoteInsert | null {
  if (q.open == null || q.high == null || q.low == null || q.close == null) return null;
  if (q.close === 0) return null;

  const date = barTradingDateIst(q.date);
  if (!isIsoDate(date)) return null;
  if (isIstWeekendIso(date)) return null;

  const adjRaw = q.adjclose;
  const adj_close = adjRaw == null || Number.isNaN(adjRaw) ? null : adjRaw;

  return {
    symbol,
    date,
    open: q.open,
    high: q.high,
    low: q.low,
    close: q.close,
    adj_close,
    volume: q.volume ?? 0,
  };
}

async function fetchWithRetry(
  ticker: string,
  period1: Date,
  period2: Date,
  attempt = 1,
): Promise<YahooChartBar[]> {
  try {
    const result = await yahoo.chart(ticker, {
      period1,
      period2,
      interval: '1d',
      /** Pipe-separated flags per yahoo-finance2; include splits for split-aware adj. series. */
      events: 'split',
    });
    return (result.quotes ?? []) as YahooChartBar[];
  } catch (err) {
    if (attempt >= RETRY_LIMIT) {
      console.warn(`[SKIP] ${ticker} failed after ${RETRY_LIMIT} attempts: ${err}`);
      return [];
    }
    await sleep(DELAY_MS * attempt);
    return fetchWithRetry(ticker, period1, period2, attempt + 1);
  }
}

function prepareInsert(db: DatabaseType) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO quotes
      (symbol, exchange, date, open, high, low, close, adj_close, volume, source, ingested_at)
    VALUES
      (@symbol, 'NSE', @date, @open, @high, @low, @close, @adj_close, @volume, 'yahoo_historical', datetime('now'))
  `);

  return db.transaction((rows: HistoricalQuoteInsert[]) => {
    let inserted = 0;
    for (const row of rows) {
      const result = insert.run(row);
      inserted += result.changes;
    }
    return inserted;
  });
}

function resolveSymbols(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === 'all') {
    return getMomentumUniverseSymbols({ fresh: true });
  }
  const out = new Set<string>();
  for (const part of trimmed.split(',')) {
    const s = normalizeNseSymbol(part);
    if (s.length > 0) out.add(s);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      symbols: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  const symbolsArg = values.symbols;
  const fromArg = values.from;
  const toArg = values.to;
  const dryRun = values['dry-run'] === true;

  if (typeof symbolsArg !== 'string' || typeof fromArg !== 'string' || typeof toArg !== 'string') {
    usage();
    process.exitCode = 1;
    return;
  }

  if (!isIsoDate(fromArg) || !isIsoDate(toArg)) {
    console.error('--from and --to must be YYYY-MM-DD');
    process.exitCode = 1;
    return;
  }

  if (parseIsoDate(fromArg).getTime() > parseIsoDate(toArg).getTime()) {
    console.error('--from must be on or before --to');
    process.exitCode = 1;
    return;
  }

  const symbols = resolveSymbols(symbolsArg);
  if (symbols.length === 0) {
    console.error('No symbols to ingest');
    process.exitCode = 1;
    return;
  }

  const period1 = new Date(`${fromArg}T00:00:00+05:30`);
  const period2 = new Date(`${toArg}T23:59:59+05:30`);

  let insertMany: ReturnType<typeof prepareInsert> | null = null;
  if (!dryRun) {
    migrate();
    insertMany = prepareInsert(getDb());
  }

  let totalInserted = 0;
  let totalCandidates = 0;

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const chunk = symbols.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      chunk.map(async (symbol) => {
        const ticker = toYahooFinanceTicker(symbol);
        const quotes = await fetchWithRetry(ticker, period1, period2);
        const rows: HistoricalQuoteInsert[] = [];
        for (const q of quotes) {
          const row = chartBarToRow(symbol, q);
          if (row) rows.push(row);
        }
        return { symbol, rows };
      }),
    );

    for (const { symbol, rows } of results) {
      totalCandidates += rows.length;
      if (dryRun) {
        console.log(`[dry-run] ${symbol}: ${rows.length} valid bar(s) in range`);
      } else if (insertMany) {
        const n = insertMany(rows);
        totalInserted += n;
        console.log(`${symbol}: inserted ${n} / ${rows.length} row(s) (rest already present)`);
      }
    }

    if (i + BATCH_SIZE < symbols.length) {
      await sleep(DELAY_MS);
    }
  }

  if (dryRun) {
    console.log(
      `[dry-run] ${symbols.length} symbol(s); ${totalCandidates} bar(s) after validation (no DB writes)`,
    );
  } else {
    console.log(
      `Done. symbols=${symbols.length}; inserted=${totalInserted}; validatedBars=${totalCandidates}`,
    );
  }

  closeDb();
}

void main().catch((err) => {
  console.error(err);
  closeDb();
  process.exitCode = 1;
});
