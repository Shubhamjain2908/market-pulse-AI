/**
 * Option A backtest: `ai_pick` — rule-based screen proxy (no LLM).
 * Entry next session open after signal; fixed hold window; costs on exit.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { getMomentumUniverseSymbols } from '../../config/loaders.js';
import { getTodayRegime } from '../../db/regime-queries.js';
import { NIFTY_BENCHMARK_SYMBOL } from '../../market/benchmarks.js';
import { addCalendarDaysIst } from '../../market/trading-days.js';
import { buildTrade } from '../metrics.js';
import { loadOhlcvMap } from '../quotes-loader.js';
import type { OptionARegimeSource, RegimeProxyMap } from '../regime-proxy.js';
import { type OHLCVBar, SIGNAL_WINDOW_LEN, computeSignalsForLastBar } from '../signals.js';
import type { ClosedSimTrade } from '../types.js';
import { filterOptionAUniverse } from '../universe-filter.js';

const HOLD_DAYS = 20;

export interface AiPickBacktestOpts {
  from: string;
  to: string;
  costBpsRoundTrip: number;
  minHistoryDays: number;
  universe?: string[];
  db: DatabaseType;
  regimeSource: OptionARegimeSource;
  regimeProxyByDate?: RegimeProxyMap;
}

function regimeForDay(D: string, opts: AiPickBacktestOpts): string | null {
  if (opts.regimeSource === 'proxy' && opts.regimeProxyByDate) {
    return opts.regimeProxyByDate.get(D) ?? 'CHOPPY';
  }
  return getTodayRegime(D, opts.db)?.regime ?? null;
}

function barsThroughDate(all: OHLCVBar[], date: string): OHLCVBar[] {
  const idx = all.findIndex((b) => b.date > date);
  if (idx === -1) return all;
  return all.slice(0, idx + 1);
}

function sliceWindowEndingAt(all: OHLCVBar[], date: string, len: number): OHLCVBar[] {
  const through = barsThroughDate(all, date);
  if (through.length === 0) return [];
  return through.slice(-len);
}

function passesAiPickProxy(s: NonNullable<ReturnType<typeof computeSignalsForLastBar>>): boolean {
  if (s.rsi14 < 35 || s.rsi14 > 65) return false;
  if (!(s.close > s.sma50)) return false;
  if (!(s.volumeRatio20d > 1.2)) return false;
  if (!(s.pctFrom52wHigh <= -3)) return false;
  return true;
}

export function runAiPickBacktest(opts: AiPickBacktestOpts): ClosedSimTrade[] {
  const benchSym = NIFTY_BENCHMARK_SYMBOL.toUpperCase();
  const universeRaw = (opts.universe ?? getMomentumUniverseSymbols({ fresh: true })).map((s) =>
    s.toUpperCase(),
  );
  const universe = filterOptionAUniverse(
    universeRaw,
    opts.from,
    opts.to,
    opts.minHistoryDays,
    opts.db,
  );

  const extendedFrom = addCalendarDaysIst(opts.from, -400);
  const ohlcv = loadOhlcvMap([...universe, benchSym], extendedFrom, opts.to, opts.db);
  const benchBars = ohlcv.get(benchSym) ?? [];
  const tradingDays = benchBars.map((b) => b.date).filter((d) => d >= opts.from && d <= opts.to);

  const closed: ClosedSimTrade[] = [];
  const costFrac = opts.costBpsRoundTrip / 10_000;

  for (let di = 0; di < tradingDays.length; di++) {
    const D = tradingDays[di];
    if (!D) continue;
    const regime = regimeForDay(D, opts);
    if (regime !== 'BULL_TRENDING') continue;

    const nextD = tradingDays[di + 1];
    if (!nextD) break;

    for (const sym of universe) {
      const barsAll = ohlcv.get(sym);
      if (!barsAll) continue;
      const win = sliceWindowEndingAt(barsAll, D, SIGNAL_WINDOW_LEN);
      const sig = computeSignalsForLastBar(win);
      if (!sig || !passesAiPickProxy(sig)) continue;

      const entryBar = barsAll.find((b) => b.date === nextD);
      if (!entryBar) continue;
      const entryPx = entryBar.open;
      if (!(entryPx > 0)) continue;

      const entryIdx = barsAll.findIndex((b) => b.date === nextD);
      if (entryIdx === -1) continue;
      const forward = barsAll.slice(entryIdx + 1).map((b) => ({ date: b.date, close: b.close }));
      const t = buildTrade(sym, { date: nextD, close: entryPx }, forward, HOLD_DAYS);
      if (!t) continue;

      const exitNet = t.exitPrice * (1 - costFrac);
      closed.push({
        symbol: sym,
        entryDate: t.entryDate,
        entryPrice: t.entryPrice,
        exitDate: t.exitDate,
        exitPrice: exitNet,
        returnPct: ((exitNet - t.entryPrice) / t.entryPrice) * 100,
        maxDrawdownPct: t.maxDrawdownPct,
        holdDays: t.holdDays,
      });
    }
  }

  return closed;
}
