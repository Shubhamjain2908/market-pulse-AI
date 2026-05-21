/**
 * Option A backtest: `momentum_mf` — weekly rebalance proxy, in-memory ranks, regime gate,
 * sector cap + earnings blackout, trailing/target/time exits via {@link stepLongPositionOneBar}.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { classifySector } from '../../briefing/sector-classifier.js';
import {
  getMomentumUniverseSymbols,
  loadMomentumConfig,
  loadSectorMap,
} from '../../config/loaders.js';
import { isInEarningsBlackoutCalendarWindow } from '../../db/momentum-queries.js';
import { getTodayRegime } from '../../db/regime-queries.js';
import {
  computeMom121ReturnPct,
  computeRelativeStrengthBetaAdjusted,
  computeVolumeBreakoutFlag,
} from '../../enrichers/momentum-signals.js';
import { atr } from '../../enrichers/technical/indicators.js';
import { NIFTY_BENCHMARK_SYMBOL } from '../../market/benchmarks.js';
import { addCalendarDaysIst, lastOpenOnOrBefore } from '../../market/trading-days.js';
import { buildTradingDayIndex } from '../../scripts/evaluate-trades.js';
import type { Regime } from '../../types/regime.js';
import { scoreMomentumFromFactorRows } from '../momentum-inmemory-rank.js';
import { type LongTrailState, initLongTrailState, stepLongPositionOneBar } from '../position.js';
import { loadOhlcvMap } from '../quotes-loader.js';
import type { OptionARegimeSource, RegimeProxyMap } from '../regime-proxy.js';
import { type OHLCVBar, SIGNAL_WINDOW_LEN, computeSignalsForLastBar } from '../signals.js';
import type { BacktestExitReason, ClosedSimTrade } from '../types.js';
import { filterOptionAUniverse } from '../universe-filter.js';

const MARKET_TZ = 'Asia/Kolkata';

export interface MomentumMfBacktestOpts {
  from: string;
  to: string;
  costBpsRoundTrip: number;
  minHistoryDays: number;
  /** Initial ATR stop multiplier (Phase 1 sweep); defaults to momentum config. */
  initialMultiplier?: number;
  /** Tightened trail multiplier after lock-in (Phase 2 sweep). */
  tightenedMultiplier?: number;
  /** Peak gain % to flip tightened trail (Phase 2 sweep). */
  lockInThresholdPct?: number;
  /** When set, overrides momentum universe. */
  universe?: string[];
  db: DatabaseType;
  regimeSource: OptionARegimeSource;
  regimeProxyByDate?: RegimeProxyMap;
}

interface OpenPosition {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  target: number;
  maxHoldDays: number;
  trail: LongTrailState;
}

function isSundayIst(iso: string): boolean {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_TZ,
    weekday: 'short',
  }).format(new Date(`${iso}T12:00:00+05:30`));
  return wd === 'Sun';
}

function listRebalanceSessionDates(from: string, to: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = from;
  while (cur <= to) {
    if (isSundayIst(cur)) {
      const session = lastOpenOnOrBefore(cur);
      if (session && !seen.has(session)) {
        seen.add(session);
        out.push(session);
      }
    }
    cur = addCalendarDaysIst(cur, 1);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function adjSeries(bars: OHLCVBar[]): number[] {
  return bars.map((b) => b.adjClose ?? b.close);
}

function alignAdjSeries(
  stock: OHLCVBar[],
  bench: OHLCVBar[],
): { stock: number[]; bench: number[] } {
  const benchByDate = new Map(bench.map((b) => [b.date, b]));
  const sPx: number[] = [];
  const bPx: number[] = [];
  for (const s of stock) {
    const b = benchByDate.get(s.date);
    if (!b) continue;
    sPx.push(s.adjClose ?? s.close);
    bPx.push(b.adjClose ?? b.close);
  }
  return { stock: sPx, bench: bPx };
}

function buildAtrByDate(bars: OHLCVBar[]): Map<string, number> {
  const ohlc = bars.map((b) => ({
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
  const series = atr(ohlc, 14);
  const m = new Map<string, number>();
  for (let i = 0; i < bars.length; i++) {
    const d = bars[i]?.date;
    const v = series[i];
    if (d && v != null && Number.isFinite(v)) m.set(d, v);
  }
  return m;
}

function loadEpsMap(
  universe: string[],
  asOf: string,
  db: DatabaseType,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (universe.length === 0) return out;
  const ph = universe.map(() => '?').join(',');
  const rows = db
    .prepare(
      `
      SELECT f.symbol AS symbol, f.profit_growth_yoy AS profit_growth_yoy
      FROM fundamentals f
      INNER JOIN (
        SELECT symbol, MAX(as_of) AS mx
        FROM fundamentals
        WHERE as_of <= ?
        GROUP BY symbol
      ) t ON f.symbol = t.symbol AND f.as_of = t.mx
      WHERE f.symbol IN (${ph})
    `,
    )
    .all(asOf, ...universe.map((s) => s.toUpperCase())) as Array<{
    symbol: string;
    profit_growth_yoy: number | null;
  }>;
  for (const sym of universe) out.set(sym.toUpperCase(), null);
  for (const r of rows) {
    const v = r.profit_growth_yoy;
    out.set(r.symbol.toUpperCase(), v != null && Number.isFinite(v) ? v : null);
  }
  return out;
}

function resolveSector(
  symbol: string,
  db: DatabaseType,
  sectorMap: Record<string, string>,
): string {
  const row = db.prepare('SELECT sector FROM symbols WHERE symbol = ?').get(symbol.toUpperCase()) as
    | { sector: string | null }
    | undefined;
  return classifySector(symbol, sectorMap, row?.sector ?? null);
}

function regimeForDay(D: string, opts: MomentumMfBacktestOpts): Regime | null {
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

function barOnDate(all: OHLCVBar[], date: string): OHLCVBar | undefined {
  return all.find((b) => b.date === date);
}

function sliceWindowEndingAt(all: OHLCVBar[], date: string, len: number): OHLCVBar[] {
  const through = barsThroughDate(all, date);
  if (through.length === 0) return [];
  return through.slice(-len);
}

export function runMomentumMfBacktest(opts: MomentumMfBacktestOpts): ClosedSimTrade[] {
  const cfg = loadMomentumConfig();
  const sectorMap = loadSectorMap({ fresh: true });
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
  const benchSym = NIFTY_BENCHMARK_SYMBOL.toUpperCase();

  const extendedFrom = addCalendarDaysIst(opts.from, -450);
  const allSyms = [...new Set([...universe, benchSym])];
  const ohlcv = loadOhlcvMap(allSyms, extendedFrom, opts.to, opts.db);
  const benchBars = ohlcv.get(benchSym) ?? [];

  const atrBySymbol = new Map<string, Map<string, number>>();
  for (const sym of allSyms) {
    const bars = ohlcv.get(sym);
    if (bars) atrBySymbol.set(sym, buildAtrByDate(bars));
  }

  const tradingDays = benchBars.map((b) => b.date).filter((d) => d >= opts.from && d <= opts.to);
  const rebalanceSessions = new Set(listRebalanceSessionDates(opts.from, opts.to));

  const closed: ClosedSimTrade[] = [];
  let open: OpenPosition[] = [];

  const initialMultiplier = opts.initialMultiplier ?? cfg.position_sizing.atr_multiplier;
  const tightenedMultiplier = opts.tightenedMultiplier;
  const lockInThresholdPct = opts.lockInThresholdPct;

  const closePositionAt = (
    p: OpenPosition,
    exitDate: string,
    exitPrice: number,
    exitReason: BacktestExitReason,
    meta?: {
      hardFloorOverridden?: boolean;
      floorBinding?: boolean;
      wasTailWinner?: boolean;
    },
  ): void => {
    const costFrac = opts.costBpsRoundTrip / 10_000;
    const exitNet = exitPrice * (1 - costFrac);
    const retNet = ((exitNet - p.entryPrice) / p.entryPrice) * 100;
    const dayIdx = buildTradingDayIndex(opts.db, p.entryDate, exitDate);
    const holdDays = dayIdx.get(exitDate) ?? 0;
    closed.push({
      symbol: p.symbol,
      entryDate: p.entryDate,
      entryPrice: p.entryPrice,
      exitDate,
      exitPrice: exitNet,
      returnPct: retNet,
      maxDrawdownPct: Math.min(0, p.trail.maxDrawdownPct),
      holdDays,
      exitReason,
      hardFloorOverridden: meta?.hardFloorOverridden ?? p.trail.hardFloorOverridden,
      floorBinding: meta?.floorBinding ?? p.trail.floorBinding,
      wasTailWinner: meta?.wasTailWinner ?? p.trail.wasTailWinner,
    });
  };

  for (const D of tradingDays) {
    const regime = regimeForDay(D, opts);
    const regimeAllowed = regime != null && cfg.regime_gate.includes(regime as Regime);

    if (!regimeAllowed) {
      for (const p of open) {
        const bx = barOnDate(ohlcv.get(p.symbol) ?? [], D);
        if (bx) closePositionAt(p, D, bx.close, 'REGIME_EXIT');
      }
      open = [];
    }

    for (const p of [...open]) {
      if (p.entryDate === D) continue;
      const bx = barOnDate(ohlcv.get(p.symbol) ?? [], D);
      if (!bx) continue;
      const atrToday = atrBySymbol.get(p.symbol)?.get(D);
      const dayIdx = buildTradingDayIndex(opts.db, p.entryDate, opts.to);
      const elapsed = dayIdx.get(D) ?? 0;
      const step = stepLongPositionOneBar(
        p.trail,
        bx,
        atrToday,
        elapsed,
        opts.db,
        opts.costBpsRoundTrip,
      );
      if (step.status === 'closed') {
        closed.push({
          symbol: p.symbol,
          entryDate: p.entryDate,
          entryPrice: p.entryPrice,
          exitDate: step.result.exitDate,
          exitPrice: step.result.exitNetPrice,
          returnPct: step.result.returnPct,
          maxDrawdownPct: step.result.maxDrawdownPct,
          holdDays: step.result.holdDays,
          exitReason: step.result.exitReason,
          hardFloorOverridden: step.result.hardFloorOverridden,
          floorBinding: step.result.floorBinding,
          wasTailWinner: step.result.wasTailWinner,
        });
        open = open.filter((x) => x.symbol !== p.symbol);
      } else {
        const idx = open.findIndex((x) => x.symbol === p.symbol);
        if (idx >= 0) open[idx] = { ...p, trail: step.state };
      }
    }

    if (!rebalanceSessions.has(D) || !regimeAllowed) continue;

    const rankedThisSession = (() => {
      const eligible: string[] = [];
      const f1: number[] = [];
      const rs: (number | null)[] = [];
      const bo: (number | null)[] = [];
      const epsMap = loadEpsMap(universe, D, opts.db);
      const bench = ohlcv.get(benchSym) ?? [];

      for (const sym of universe) {
        const barsAll = ohlcv.get(sym);
        if (!barsAll) continue;
        const through = barsThroughDate(barsAll, D);
        if (through.length < cfg.lookback.price_momentum_start_days) continue;

        const px = adjSeries(through);
        const mom121 = computeMom121ReturnPct(
          px,
          cfg.lookback.price_momentum_lag_days,
          cfg.lookback.price_momentum_start_days,
          5,
        );
        if (mom121 == null || !Number.isFinite(mom121)) continue;

        const aligned = alignAdjSeries(through, barsThroughDate(bench, D));
        const rsBa =
          aligned.stock.length >= cfg.lookback.rs_days
            ? computeRelativeStrengthBetaAdjusted(
                aligned.stock,
                aligned.bench,
                cfg.lookback.rs_days,
                cfg.lookback.beta_days,
                cfg.beta_floor,
              )
            : null;

        const win = sliceWindowEndingAt(barsAll, D, SIGNAL_WINDOW_LEN);
        const sig = computeSignalsForLastBar(win);
        const volRatio = sig?.volumeRatio20d ?? null;
        let breakout: number | null = null;
        if (through.length >= 252 && sig) {
          breakout = computeVolumeBreakoutFlag(
            px,
            volRatio,
            252,
            1 - cfg.breakout_threshold_pct / 100,
            cfg.breakout_volume_ratio,
          );
        }

        eligible.push(sym);
        f1.push(mom121);
        rs.push(rsBa);
        bo.push(breakout);
      }

      const epsArr = eligible.map((s) => epsMap.get(s) ?? null);
      return scoreMomentumFromFactorRows(eligible, f1, epsArr, rs, bo, cfg);
    })();

    const rankBySym = new Map<string, number>();
    rankedThisSession.forEach((row, i) => rankBySym.set(row.symbol, i + 1));

    for (const p of [...open]) {
      const rk = rankBySym.get(p.symbol);
      if (rk != null && rk > cfg.exit_rank_threshold) {
        const bx = barOnDate(ohlcv.get(p.symbol) ?? [], D);
        if (bx) {
          closePositionAt(p, D, bx.close, 'RANK_DECAY');
          open = open.filter((x) => x.symbol !== p.symbol);
        }
      }
    }

    const heldSyms = new Set(open.map((p) => p.symbol));
    const sectorCounts = new Map<string, number>();
    for (const p of open) {
      const sec = resolveSector(p.symbol, opts.db, sectorMap);
      if (sec !== 'Unknown') sectorCounts.set(sec, (sectorCounts.get(sec) ?? 0) + 1);
    }

    const rankedSyms = rankedThisSession.map((r) => r.symbol);
    let slots = cfg.portfolio_slots - open.length;
    for (const sym of rankedSyms) {
      if (slots <= 0) break;
      if (heldSyms.has(sym)) continue;
      if (rankedThisSession.find((r) => r.symbol === sym)?.falseFlag) continue;
      if (isInEarningsBlackoutCalendarWindow(sym, D, opts.db, cfg.earnings_blackout_days)) continue;
      const sec = resolveSector(sym, opts.db, sectorMap);
      if (sec !== 'Unknown' && (sectorCounts.get(sec) ?? 0) >= cfg.max_per_sector) continue;

      const barsAll = ohlcv.get(sym);
      if (!barsAll) continue;
      const bx = barOnDate(barsAll, D);
      if (!bx) continue;
      const entryPx = bx.close;
      const atrEntry = atrBySymbol.get(sym)?.get(D) ?? entryPx * 0.02;
      const hardMult = 1 + cfg.hard_stop_pct / 100;
      const hardFloorStop = entryPx * hardMult;
      const atrStop = entryPx - initialMultiplier * atrEntry;
      const stopLoss = Math.max(hardFloorStop, atrStop);
      const target = entryPx * (1 + cfg.position_sizing.trim_return_pct / 100);

      const trail = initLongTrailState({
        symbol: sym,
        entryPrice: entryPx,
        sourceDate: D,
        initialMultiplier,
        tightenedMultiplier,
        lockInThresholdPct,
        initialStopLoss: stopLoss,
        target,
        maxHoldDays: 90,
        atr14AtSourceDate: atrEntry,
      });

      open.push({
        symbol: sym,
        entryDate: D,
        entryPrice: entryPx,
        target,
        maxHoldDays: 90,
        trail,
      });
      heldSyms.add(sym);
      if (sec !== 'Unknown') sectorCounts.set(sec, (sectorCounts.get(sec) ?? 0) + 1);
      slots--;
    }
  }

  for (const p of open) {
    const bars = ohlcv.get(p.symbol);
    const last = bars?.[bars.length - 1];
    if (last && last.date <= opts.to) {
      closePositionAt(p, last.date, last.close, 'WINDOW_END');
    }
  }

  return closed;
}
