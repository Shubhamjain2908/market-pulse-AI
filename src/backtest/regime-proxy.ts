/**
 * Backtest-only regime proxy from `quotes` only (no `regime_daily`, FII, VIX, or `signals`).
 *
 * **Deviation from live `runRegimeClassifier`:** three coarse booleans (NIFTY vs SMA200,
 * SMA200 10-session slope, breadth % above SMA200) with no CRISIS override and **no**
 * 3-session persistence — labels are path-independent per day for walk-forward sims.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { addCalendarDaysIst } from '../market/trading-days.js';
import type { Regime } from '../types/regime.js';
import { loadOhlcvMap } from './quotes-loader.js';
import type { OHLCVBar } from './signals.js';
import { filterOptionAUniverse } from './universe-filter.js';

/** How regime labels are resolved for Option A (`proxy` = quotes-only; `daily` = `regime_daily`). */
export type OptionARegimeSource = 'daily' | 'proxy';

export type BacktestRegime = Exclude<Regime, 'CRISIS'>;

export interface RegimeProxyResult {
  regime: BacktestRegime;
  niftyVsSma200Pct: number;
  sma200SlopePct: number;
  breadthPct: number;
  /** Count of the three arms in the "bull" direction (Nifty>0, slope>0, breadth>50%). */
  signalsPositive: number;
}

export type RegimeProxyMap = Map<string, BacktestRegime>;

function mean(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function barsThroughDate(all: OHLCVBar[], date: string): OHLCVBar[] {
  const idx = all.findIndex((b) => b.date > date);
  if (idx === -1) return all;
  return all.slice(0, idx + 1);
}

const MIN_NIFTY_FOR_SLOPE = 210;

/**
 * One trading session `date` (must exist in `niftyBarsAsc` through that date).
 */
export function computeRegimeProxyForDate(
  niftyBarsAsc: OHLCVBar[],
  universeBarsMap: Map<string, OHLCVBar[]>,
  universeForBreadth: string[],
  benchUpper: string,
  date: string,
): RegimeProxyResult | null {
  const through = barsThroughDate(niftyBarsAsc, date);
  const closes = through.map((b) => b.close);
  if (closes.length < MIN_NIFTY_FOR_SLOPE) return null;

  const sma200Today = mean(closes.slice(-200));
  const latest = closes.at(-1) ?? 0;
  const niftyVsSma200Pct = sma200Today > 0 ? ((latest - sma200Today) / sma200Today) * 100 : 0;

  const sma200_10dAgo = mean(closes.slice(-210, -10));
  const sma200SlopePct =
    sma200_10dAgo > 0 ? ((sma200Today - sma200_10dAgo) / sma200_10dAgo) * 100 : 0;

  let above = 0;
  let denom = 0;
  for (const sym of universeForBreadth) {
    const u = sym.toUpperCase();
    if (u === benchUpper) continue;
    const bars = universeBarsMap.get(u);
    if (!bars) continue;
    const t = barsThroughDate(bars, date);
    const c = t.map((b) => b.close);
    if (c.length < 200) continue;
    denom++;
    const sma200 = mean(c.slice(-200));
    const last = c.at(-1) ?? 0;
    if (last > sma200) above++;
  }

  const breadthPct = denom > 0 ? (100 * above) / denom : 50;

  const s1Pos = niftyVsSma200Pct > 0;
  const s1Neg = niftyVsSma200Pct < 0;
  const s2Pos = sma200SlopePct > 0;
  const s2Neg = sma200SlopePct < 0;
  const s3Pos = breadthPct > 50;
  const s3Neg = breadthPct < 40;
  const signalsPositive = Number(s1Pos) + Number(s2Pos) + Number(s3Pos);

  let regime: BacktestRegime = 'CHOPPY';
  if (s1Pos && s2Pos && s3Pos) regime = 'BULL_TRENDING';
  else if (s1Neg && s2Neg && s3Neg) regime = 'BEAR_TRENDING';

  return {
    regime,
    niftyVsSma200Pct,
    sma200SlopePct,
    breadthPct,
    signalsPositive,
  };
}

/**
 * Pre-compute proxy label for each benchmark session in `tradingDates`.
 * Missing or thin history → `CHOPPY` for that date.
 */
export function buildRegimeProxyMap(
  niftyBarsAsc: OHLCVBar[],
  universeBarsMap: Map<string, OHLCVBar[]>,
  tradingDates: string[],
  universeForBreadth: string[],
  benchSymbolUpper: string,
): RegimeProxyMap {
  const out: RegimeProxyMap = new Map();
  const bench = benchSymbolUpper.toUpperCase();
  for (const d of tradingDates) {
    const r = computeRegimeProxyForDate(
      niftyBarsAsc,
      universeBarsMap,
      universeForBreadth,
      bench,
      d,
    );
    out.set(d, r?.regime ?? 'CHOPPY');
  }
  return out;
}

/** Histogram of labels for the ordered session list (e.g. runner JSON). */
export function regimeProxyHistogramForDates(
  tradingDates: string[],
  map: RegimeProxyMap,
): Record<string, number> {
  const h: Record<string, number> = {};
  for (const d of tradingDates) {
    const lab = map.get(d) ?? 'CHOPPY';
    h[lab] = (h[lab] ?? 0) + 1;
  }
  return h;
}

/** Minimum NIFTY (benchmark) EOD rows strictly before `from` (exclusive) for SMA200 context. */
export const REGIME_PROXY_MIN_PRIOR_BARS = 252;

export function countBenchQuotesStrictlyBefore(
  benchSymbolUpper: string,
  beforeIsoDate: string,
  db: DatabaseType,
): number {
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS c FROM quotes
      WHERE symbol = ? AND exchange = 'NSE' AND date < ?
    `,
    )
    .get(benchSymbolUpper.toUpperCase(), beforeIsoDate) as { c: number };
  return row.c;
}

/**
 * Load quotes, filter universe, build proxy map for all benchmark sessions in `[from, to]`.
 * `extendedCalendarDaysBack` should match strategy preload (e.g. 450 for momentum).
 */
export function buildRegimeProxyMapForOptionAWindow(params: {
  db: DatabaseType;
  from: string;
  to: string;
  minHistoryDays: number;
  universeRaw: string[];
  benchSymbolUpper: string;
  extendedCalendarDaysBack: number;
}): {
  map: RegimeProxyMap;
  filteredUniverse: string[];
  tradingDates: string[];
  niftyBars: OHLCVBar[];
} {
  const { db, from, to, minHistoryDays, universeRaw, benchSymbolUpper, extendedCalendarDaysBack } =
    params;
  const bench = benchSymbolUpper.toUpperCase();
  const filteredUniverse = filterOptionAUniverse(universeRaw, from, to, minHistoryDays, db);
  const extendedFrom = addCalendarDaysIst(from, -extendedCalendarDaysBack);
  const syms = [...new Set([...filteredUniverse, bench])];
  const ohlcv = loadOhlcvMap(syms, extendedFrom, to, db);
  const niftyBars = ohlcv.get(bench) ?? [];
  const tradingDates = niftyBars.map((b) => b.date).filter((d) => d >= from && d <= to);
  const map = buildRegimeProxyMap(niftyBars, ohlcv, tradingDates, filteredUniverse, bench);
  return { map, filteredUniverse, tradingDates, niftyBars };
}
