/**
 * Compare live `signals.atr_14` vs backtest on-the-fly ATR (Wilder TR, quotes.close).
 *
 * Usage:
 *   pnpm exec tsx scripts/audit-atr-alignment.mts
 *   pnpm exec tsx scripts/audit-atr-alignment.mts --symbols RELIANCE,HDFCBANK,INFY
 */

import { parseArgs } from 'node:util';

import { atr } from '../src/enrichers/technical/indicators.js';
import { closeDb, getDb, migrate } from '../src/db/index.js';
import { argvForCliParseArgs } from './argv-for-cli.js';

const DEFAULT_SYMBOLS = ['RELIANCE', 'HDFCBANK', 'INFY'];
const DIVERGENCE_WARN_PCT = 2;

function backtestAtrAtDate(
  bars: Array<{ date: string; high: number; low: number; close: number; volume: number }>,
  targetDate: string,
): number | null {
  const ohlc = bars.map((b) => ({
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
  const series = atr(ohlc, 14);
  const idx = bars.findIndex((b) => b.date === targetDate);
  if (idx < 0) return null;
  const v = series[idx];
  return v != null && Number.isFinite(v) ? v : null;
}

migrate();
const db = getDb();

const { values } = parseArgs({
  args: argvForCliParseArgs(),
  options: {
    symbols: { type: 'string' },
  },
});

const symbols =
  typeof values.symbols === 'string' && values.symbols.length > 0
    ? values.symbols.split(',').map((s) => s.trim().toUpperCase())
    : DEFAULT_SYMBOLS;

console.log('ATR alignment: signals.atr_14 vs backtest atr(quotes OHLC, Wilder 14)');
console.log(`Warn threshold: >${DIVERGENCE_WARN_PCT}% relative divergence`);
console.log(
  'If WARN after historical backfill: run `pnpm cli enrich -d <date>` to refresh signals, then re-run this audit.\n',
);

let anyWarn = false;

for (const sym of symbols) {
  const aligned = db
    .prepare(
      `
      SELECT q.date AS ref_date, s.value AS signals_atr
      FROM quotes q
      INNER JOIN signals s
        ON s.symbol = q.symbol AND s.date = q.date AND s.name = 'atr_14'
      WHERE q.symbol = ? AND q.exchange = 'NSE'
      ORDER BY q.date DESC
      LIMIT 1
    `,
    )
    .get(sym) as { ref_date: string; signals_atr: number } | undefined;

  if (!aligned) {
    console.log(`${sym}: no overlapping quotes+signals.atr_14 — skip`);
    anyWarn = true;
    continue;
  }

  const refDate = aligned.ref_date;
  const signalsVal = aligned.signals_atr;

  const quoteRows = db
    .prepare(
      `
      SELECT date, high, low, close, volume
      FROM quotes
      WHERE symbol = ? AND exchange = 'NSE' AND date <= ?
      ORDER BY date ASC
    `,
    )
    .all(sym, refDate) as Array<{
    date: string;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;

  const backtestVal = backtestAtrAtDate(quoteRows, refDate);

  if (backtestVal == null) {
    console.log(
      `${sym} @ ${refDate}: signals=${signalsVal ?? 'missing'} backtest=${backtestVal ?? 'missing'}`,
    );
    anyWarn = true;
    continue;
  }

  const relPct = (Math.abs(signalsVal - backtestVal) / backtestVal) * 100;
  const ok = relPct <= DIVERGENCE_WARN_PCT;
  if (!ok) anyWarn = true;
  console.log(
    `${sym} @ ${refDate}: signals=${signalsVal.toFixed(4)} backtest=${backtestVal.toFixed(4)} ` +
      `rel_div=${relPct.toFixed(2)}% ${ok ? 'OK' : 'WARN'}`,
  );
}

console.log('');
if (anyWarn) {
  console.log('Result: REVIEW — one or more symbols exceed divergence threshold or missing data.');
  closeDb();
  process.exitCode = 1;
} else {
  console.log('Result: PASS — ATR within threshold for spot-check symbols.');
}
closeDb();
