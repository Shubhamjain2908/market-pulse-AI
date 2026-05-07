/**
 * Daily momentum factors (1, 3, 4) + earnings blackout flag for the momentum universe.
 * Factor 2 (`profit_growth_yoy`) is read from `fundamentals` at rank time — not written here.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { loadMomentumConfig } from '../config/loaders.js';
import {
  deleteMomentumFactorSignals,
  deleteSignalByName,
  getDb,
  hasMinPriceHistory,
  isInEarningsBlackoutCalendarWindow,
  upsertSignals,
} from '../db/index.js';
import { child } from '../logger.js';
import { NIFTY_BENCHMARK_SYMBOL } from '../market/benchmarks.js';
import type { Signal } from '../types/domain.js';

const log = child({ component: 'momentum-signals' });

const MOM_SOURCE = 'momentum' as const;

/** §3.1 — index slack around the target lag when the exact offset is awkward after merges/holidays. */
const LAG_FALLBACK_TRADING_DAYS = 5;

const QUOTE_LOOKBACK_CAP = 420;

export interface MomentumSignalsStats {
  symbolsTargeted: number;
  symbolsColdStart: number;
  blackoutRowsWritten: number;
  factorSignalRowsWritten: number;
}

function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * Close at `lagFromEnd` (1 = last bar). Tries index offsets in order:
 * 0, −1, +1, −2, +2, … ±`fallbackTd`.
 */
export function pickCloseAtLagWithFallback(
  closes: number[],
  lagFromEnd: number,
  fallbackTd: number,
): number | null {
  const n = closes.length;
  if (lagFromEnd < 1 || n < lagFromEnd) return null;
  const baseIdx = n - lagFromEnd;
  const deltas: number[] = [0];
  for (let k = 1; k <= fallbackTd; k++) {
    deltas.push(-k, k);
  }
  for (const d of deltas) {
    const i = baseIdx + d;
    if (i >= 0 && i < n) {
      const v = closes[i];
      if (v != null && Number.isFinite(v) && v > 0) return v;
    }
  }
  return null;
}

/** Factor 1: 12–1 price momentum % over configured lags (spec §3.1). */
export function computeMom121ReturnPct(
  closes: number[],
  lagShort: number,
  lagLong: number,
  fallbackTd: number,
): number | null {
  const shortPx = pickCloseAtLagWithFallback(closes, lagShort, fallbackTd);
  const longPx = pickCloseAtLagWithFallback(closes, lagLong, fallbackTd);
  if (shortPx == null || longPx == null || longPx <= 0) return null;
  return ((shortPx - longPx) / longPx) * 100;
}

function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a == null || b == null || a <= 0 || b <= 0 || !Number.isFinite(a) || !Number.isFinite(b)) {
      return [];
    }
    out.push(b / a - 1);
  }
  return out;
}

/** OLS slope β where y ≈ β·x (single regressor), using simple returns. */
export function betaFromAlignedReturns(yRet: number[], xRet: number[]): number | null {
  if (yRet.length !== xRet.length || yRet.length < 30) return null;
  const mx = mean(xRet);
  const my = mean(yRet);
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < xRet.length; i++) {
    const xi = xRet[i];
    const yi = yRet[i];
    if (xi === undefined || yi === undefined) continue;
    const dx = xi - mx;
    const dy = yi - my;
    cov += dx * dy;
    vx += dx * dx;
  }
  if (vx < 1e-14) return null;
  return cov / vx;
}

/** Factor 3: 63d stock return minus β-adjusted Nifty return; β from last `betaDays` overlapping daily returns. */
export function computeRelativeStrengthBetaAdjusted(
  stockCloses: number[],
  benchCloses: number[],
  rsDays: number,
  betaDays: number,
  betaFloor: number,
): number | null {
  if (
    stockCloses.length !== benchCloses.length ||
    stockCloses.length < Math.max(rsDays, betaDays + 1)
  ) {
    return null;
  }
  const n = stockCloses.length;
  const lastS = stockCloses[n - 1];
  const lagS = stockCloses[n - rsDays];
  const lastB = benchCloses[n - 1];
  const lagB = benchCloses[n - rsDays];
  const rStock63 = lastS != null && lagS != null && lastS > 0 && lagS > 0 ? lastS / lagS - 1 : null;
  const rBench63 = lastB != null && lagB != null && lastB > 0 && lagB > 0 ? lastB / lagB - 1 : null;
  if (rStock63 == null || rBench63 == null) return null;

  const yR = dailyReturns(stockCloses);
  const xR = dailyReturns(benchCloses);
  if (yR.length !== xR.length || yR.length < betaDays) return null;
  const ySlice = yR.slice(-betaDays);
  const xSlice = xR.slice(-betaDays);
  const betaHat = betaFromAlignedReturns(ySlice, xSlice);
  const betaEff = betaHat != null && Number.isFinite(betaHat) ? Math.max(betaHat, betaFloor) : null;

  if (betaEff != null) {
    return rStock63 - betaEff * rBench63;
  }
  return rStock63 - rBench63;
}

export function computeVolumeBreakoutFlag(
  closes: number[],
  volumeRatio20d: number | null | undefined,
  maxWindow: number,
  thresholdFrac: number,
  minVolumeRatio: number,
): number | null {
  if (closes.length < maxWindow) return null;
  const window = closes.slice(-maxWindow);
  const peak = Math.max(...window);
  const last = window[window.length - 1];
  if (last == null || !(last > 0 && peak > 0)) return null;
  if (volumeRatio20d == null || !Number.isFinite(volumeRatio20d)) return null;
  const passesPrice = last >= thresholdFrac * peak;
  const passesVol = volumeRatio20d > minVolumeRatio;
  return passesPrice && passesVol ? 1 : 0;
}

function loadStockClosesAsc(
  symbol: string,
  asOf: string,
  limit: number,
  db: DatabaseType,
): number[] {
  const rows = db
    .prepare(
      `
      SELECT close FROM quotes
      WHERE symbol = ? AND exchange = 'NSE' AND date <= ?
      ORDER BY date ASC
      LIMIT ?
    `,
    )
    .all(symbol.toUpperCase(), asOf, limit) as Array<{ close: number }>;
  return rows.map((r) => r.close);
}

function loadAlignedStockBench(
  stockSym: string,
  benchSym: string,
  asOf: string,
  limit: number,
  db: DatabaseType,
): { stock: number[]; bench: number[] } {
  const rows = db
    .prepare(
      `
      SELECT s.close AS sc, b.close AS bc
      FROM quotes s
      INNER JOIN quotes b
        ON s.date = b.date AND b.symbol = ? AND b.exchange = 'NSE'
      WHERE s.symbol = ? AND s.exchange = 'NSE' AND s.date <= ?
      ORDER BY s.date ASC
      LIMIT ?
    `,
    )
    .all(benchSym.toUpperCase(), stockSym.toUpperCase(), asOf, limit) as Array<{
    sc: number;
    bc: number;
  }>;
  const stock: number[] = [];
  const bench: number[] = [];
  for (const r of rows) {
    stock.push(r.sc);
    bench.push(r.bc);
  }
  return { stock, bench };
}

function readVolumeRatio20d(symbol: string, date: string, db: DatabaseType): number | null {
  const row = db
    .prepare(
      `
      SELECT value FROM signals
      WHERE symbol = ? AND date = ? AND name = 'volume_ratio_20d'
      LIMIT 1
    `,
    )
    .get(symbol.toUpperCase(), date) as { value: number } | undefined;
  if (row == null || !Number.isFinite(row.value)) return null;
  return row.value;
}

/**
 * Computes momentum factor signals + blackout for `symbols` on `date`.
 */
export function enrichMomentumSignals(
  date: string,
  symbols: string[],
  db: DatabaseType = getDb(),
): MomentumSignalsStats {
  const cfg = loadMomentumConfig();
  const bench = NIFTY_BENCHMARK_SYMBOL;
  const lagLong = cfg.lookback.price_momentum_start_days;
  const lagShort = cfg.lookback.price_momentum_lag_days;
  const rsDays = cfg.lookback.rs_days;
  const betaDays = cfg.lookback.beta_days;
  const max252 = 252;
  const thrPct = cfg.breakout_threshold_pct;
  const thresholdFrac = 1 - thrPct / 100;
  const minVolRatio = cfg.breakout_volume_ratio;
  const betaFloor = cfg.beta_floor;
  const blackoutDays = cfg.earnings_blackout_days;

  const stats: MomentumSignalsStats = {
    symbolsTargeted: symbols.length,
    symbolsColdStart: 0,
    blackoutRowsWritten: 0,
    factorSignalRowsWritten: 0,
  };

  const blackoutRows: Signal[] = [];
  const factorRows: Signal[] = [];

  for (const raw of symbols) {
    const symbol = raw.toUpperCase();

    const blackout = isInEarningsBlackoutCalendarWindow(symbol, date, db, blackoutDays);
    blackoutRows.push({
      symbol,
      date,
      name: 'mom_earnings_blackout',
      value: blackout ? 1 : 0,
      source: MOM_SOURCE,
    });

    const cold253 = !hasMinPriceHistory(symbol, lagLong, date, db);
    const cold252 = !hasMinPriceHistory(symbol, max252, date, db);

    if (cold253) {
      stats.symbolsColdStart++;
      deleteMomentumFactorSignals(symbol, date, db);
      continue;
    }

    const stockOnly = loadStockClosesAsc(symbol, date, QUOTE_LOOKBACK_CAP, db);
    if (stockOnly.length < lagLong) {
      deleteMomentumFactorSignals(symbol, date, db);
      continue;
    }

    const mom121 = computeMom121ReturnPct(stockOnly, lagShort, lagLong, LAG_FALLBACK_TRADING_DAYS);
    if (mom121 != null && Number.isFinite(mom121)) {
      factorRows.push({
        symbol,
        date,
        name: 'mom_12_1_return',
        value: mom121,
        source: MOM_SOURCE,
      });
    } else {
      deleteSignalByName(symbol, date, 'mom_12_1_return', db);
    }

    const aligned = loadAlignedStockBench(symbol, bench, date, QUOTE_LOOKBACK_CAP, db);
    const rsBa = computeRelativeStrengthBetaAdjusted(
      aligned.stock,
      aligned.bench,
      rsDays,
      betaDays,
      betaFloor,
    );
    if (rsBa != null && Number.isFinite(rsBa)) {
      factorRows.push({
        symbol,
        date,
        name: 'mom_relative_strength_ba',
        value: rsBa,
        source: MOM_SOURCE,
      });
    } else {
      deleteSignalByName(symbol, date, 'mom_relative_strength_ba', db);
    }

    const volRatio = readVolumeRatio20d(symbol, date, db);
    let breakout: number | null = null;
    if (!cold252 && stockOnly.length >= max252) {
      breakout = computeVolumeBreakoutFlag(stockOnly, volRatio, max252, thresholdFrac, minVolRatio);
    }
    if (breakout != null) {
      factorRows.push({
        symbol,
        date,
        name: 'mom_volume_breakout_flag',
        value: breakout,
        source: MOM_SOURCE,
      });
    } else {
      deleteSignalByName(symbol, date, 'mom_volume_breakout_flag', db);
    }
  }

  stats.blackoutRowsWritten = upsertSignals(blackoutRows, db);
  stats.factorSignalRowsWritten = upsertSignals(factorRows, db);

  log.info(stats, 'momentum signals enrichment complete');
  return stats;
}
