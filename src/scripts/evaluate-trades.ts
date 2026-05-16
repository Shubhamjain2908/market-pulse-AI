/**
 * Daily evaluation of open paper trades: adaptive trailing stops, conservative same-day SL+TP,
 * target, and max-hold time-stop vs session OHLC.
 *
 * Ruling R3: stop fills at `bar.open` when the session gaps through the stop (long).
 * Hard floor: before each bar’s SL/TP checks, `stopLoss = max(stopLoss, hardFloor)` so persisted stops
 * below the −8% floor still lift when trailing is skipped (e.g. missing `atr_14` that day).
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { scheduleTrailingStopPostMortem } from '../agents/trailing-stop-postmortem.js';
import { loadMomentumConfig } from '../config/loaders.js';
import { type PaperTradeRow, closePaperTrade, getOpenPaperTrades } from '../db/queries.js';
import {
  getAtr14,
  insertStopLog,
  patchPaperTradeTrailing,
  resetStopRaisedTodayForOpenTrades,
} from '../db/trailing-stop-queries.js';
import { isoDateIst, parseIsoDate } from '../ingestors/base/dates.js';
import { child } from '../logger.js';
import { NIFTY_BENCHMARK_SYMBOL } from '../market/benchmarks.js';
import type { ExitReason } from '../types/trailing-stop.js';
import { GAP_DOWN_THROUGH_STOP_NOTE } from '../types/trailing-stop.js';
import { applyDay1InitialStop, computeNewStop } from './trailing-stop-engine.js';

const log = child({ component: 'evaluate-trades' });

function lowerExclusiveIsoFromBarDate(barDate: string): string {
  const ref = parseIsoDate(barDate);
  const t = ref.getTime() - 5 * 24 * 60 * 60 * 1000;
  return isoDateIst(new Date(t));
}

export interface EvaluatePaperTradesOptions {
  /** When true, skip fire-and-forget LLM post-mortem on STOPPED_OUT (writes no narrative). */
  skipAi?: boolean;
}

export interface EvaluateTradesResult {
  asOf: string;
  evaluated: number;
  closed: number;
  closedWin: number;
  closedLoss: number;
  closedTime: number;
  stillOpen: number;
  skippedNoData: number;
}

interface OhlcBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function buildTradingDayIndex(
  db: DatabaseType,
  sourceDate: string,
  asOf: string,
): Map<string, number> {
  const rows = db
    .prepare(
      `
    SELECT DISTINCT date FROM quotes
    WHERE symbol = ? AND exchange = 'NSE' AND date > ? AND date <= ?
    ORDER BY date ASC
  `,
    )
    .all(NIFTY_BENCHMARK_SYMBOL, sourceDate, asOf) as Array<{ date: string }>;
  const m = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row) m.set(row.date, i + 1);
  }
  return m;
}

function getSymbolBars(
  db: DatabaseType,
  symbol: string,
  sourceDate: string,
  asOf: string,
): OhlcBar[] {
  return db
    .prepare(
      `
    SELECT date, open, high, low, close FROM quotes
    WHERE symbol = ? AND exchange = 'NSE' AND date > ? AND date <= ?
    ORDER BY date ASC
  `,
    )
    .all(symbol, sourceDate, asOf) as OhlcBar[];
}

function pnlPctLong(entry: number, exit: number): number {
  return ((exit - entry) / entry) * 100;
}

/** Spec / momentum-config `hard_stop_pct` (e.g. -8 → floor at 92% of entry for longs). */
function hardStopFloorFromPct(entryPrice: number, hardStopPct: number): number {
  return entryPrice * (1 + hardStopPct / 100);
}

/**
 * Long R3: if the bar trades through the stop and the session opened below it, fill at the
 * open; otherwise at the stop level.
 */
export function exitPriceWhenStopHit(bar: OhlcBar, stopLoss: number): number {
  if (bar.open < stopLoss) return bar.open;
  return stopLoss;
}

function normalizeTrailingMult(row: PaperTradeRow): number {
  const m = row.trailingMultiplier;
  if (m == null) return 2;
  return m === 1.5 ? 1.5 : 2;
}

function unrealisedPctFromHigh(entryPrice: number, highestClose: number): number {
  return ((highestClose - entryPrice) / entryPrice) * 100;
}

export function evaluateOnePaperTrade(
  trade: PaperTradeRow,
  db: DatabaseType,
  asOf: string,
  opts?: EvaluatePaperTradesOptions,
): 'CLOSED_WIN' | 'CLOSED_LOSS' | 'CLOSED_TIME' | 'no_data' | 'still_open' {
  const bars = getSymbolBars(db, trade.symbol, trade.sourceDate, asOf);
  if (bars.length === 0) return 'no_data';

  const hardFloor = hardStopFloorFromPct(trade.entryPrice, loadMomentumConfig().hard_stop_pct);

  const dayIndex = buildTradingDayIndex(db, trade.sourceDate, asOf);
  const initialLlmStop = trade.stopLoss;

  let stopLoss = initialLlmStop;
  let highestClose = trade.highestCloseSinceEntry == null ? null : trade.highestCloseSinceEntry;
  let atr14AtEntryStored: number | null = trade.atr14AtEntry ?? null;
  let trailingMult = normalizeTrailingMult(trade);
  /** Last candidate from trailing math (for STOPPED_OUT audit row when available). */
  let lastTrailCandidate = stopLoss;
  let lastTrailUnrealisedPct = unrealisedPctFromHigh(
    trade.entryPrice,
    highestClose ?? trade.entryPrice,
  );

  let initialSetupComplete = trade.atr14AtEntry != null || trade.highestCloseSinceEntry != null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar) continue;

    const stopAtBarStart = stopLoss;

    const maxCloseSinceEntry =
      highestClose === null ? bar.close : Math.max(highestClose, bar.close);
    highestClose = maxCloseSinceEntry;
    lastTrailUnrealisedPct = unrealisedPctFromHigh(trade.entryPrice, maxCloseSinceEntry);

    let skipTrailThisBar = false;

    if (!initialSetupComplete) {
      const atrOnSource = getAtr14(trade.symbol, trade.sourceDate, db);
      stopLoss = applyDay1InitialStop(trade.entryPrice, initialLlmStop, atrOnSource ?? null);
      stopLoss = Math.max(stopLoss, hardFloor);
      atr14AtEntryStored = atrOnSource ?? null;
      initialSetupComplete = true;
      skipTrailThisBar = true;
      lastTrailCandidate = stopLoss;
    }

    if (initialSetupComplete && !skipTrailThisBar) {
      const atrToday = getAtr14(trade.symbol, bar.date, db);
      if (atrToday !== undefined) {
        const prevStop = stopLoss;
        const res = computeNewStop({
          entryPrice: trade.entryPrice,
          highestCloseSinceEntry: maxCloseSinceEntry,
          currentStopLoss: stopLoss,
          atr14Today: atrToday,
          currentMultiplier: trailingMult,
        });
        lastTrailCandidate = res.candidateStop;
        lastTrailUnrealisedPct = res.unrealisedPct;
        stopLoss = Math.max(res.newStop, hardFloor);
        trailingMult = res.multiplier;

        insertStopLog(
          {
            tradeId: trade.id,
            symbol: trade.symbol,
            logDate: bar.date,
            prevStop,
            newStop: stopLoss,
            stopDelta: stopLoss - prevStop,
            candidateStop: res.candidateStop,
            highestClose: maxCloseSinceEntry,
            atr14Today: atrToday,
            multiplierUsed: res.multiplier,
            unrealisedPct: res.unrealisedPct,
            action: res.action,
          },
          db,
        );
      }
    }

    stopLoss = Math.max(stopLoss, hardFloor);

    const prevCloseRow = db
      .prepare(
        `SELECT close FROM quotes WHERE symbol = ? AND exchange = 'NSE' AND date < ? ORDER BY date DESC LIMIT 1`,
      )
      .get(trade.symbol, bar.date) as { close: number } | undefined;
    const prevClose = prevCloseRow?.close;

    let skipStopTargetThisBar = false;
    if (prevClose != null && Number.isFinite(prevClose) && bar.open < prevClose * 0.7) {
      skipStopTargetThisBar = true;
      const lowerEx = lowerExclusiveIsoFromBarDate(bar.date);
      const caRecent = db
        .prepare(
          'SELECT 1 AS x FROM corporate_actions WHERE symbol = ? AND ex_date > ? AND ex_date <= ? LIMIT 1',
        )
        .get(trade.symbol, lowerEx, bar.date) as { x: number } | undefined;
      const caAppliedRecent = caRecent != null ? 'Yes' : 'No';
      log.warn(
        {
          symbol: trade.symbol,
          barDate: bar.date,
          prevClose,
          todayOpen: bar.open,
          caAppliedRecent,
          currentStop: stopLoss,
        },
        `CIRCUIT BREAKER: ${trade.symbol} gapped down >30%. Trailing stop evaluation bypassed. CA_Applied_Recent: ${caAppliedRecent}. Current_Stop: ${stopLoss}.`,
      );
    }

    const hitSl = bar.low <= stopLoss;
    const hitTg = bar.close >= trade.target;
    const elapsed = dayIndex.get(bar.date) ?? 0;

    const raisedForBriefingLatch =
      stopLoss > stopAtBarStart && bar.date === asOf && !skipTrailThisBar;

    const persistOpenRow = (): void => {
      patchPaperTradeTrailing(
        trade.id,
        {
          stopLoss,
          highestCloseSinceEntry: maxCloseSinceEntry,
          atr14AtEntry: atr14AtEntryStored,
          trailingMultiplier: trailingMult,
          stopRaisedToday: raisedForBriefingLatch ? 1 : 0,
        },
        db,
      );
    };

    const logStoppedOut = (logDate: string, notes: string | null, exitReason: ExitReason): void => {
      const exitPx = exitPriceWhenStopHit(bar, stopLoss);
      const gap = bar.open < stopLoss ? GAP_DOWN_THROUGH_STOP_NOTE : undefined;
      // STOPPED_OUT row: new_stop is booked exit price (R3: gap-through uses bar.open).
      const logId = insertStopLog(
        {
          tradeId: trade.id,
          symbol: trade.symbol,
          logDate,
          prevStop: stopAtBarStart,
          newStop: exitPx,
          stopDelta: exitPx - stopAtBarStart,
          candidateStop: lastTrailCandidate,
          highestClose: maxCloseSinceEntry,
          atr14Today: getAtr14(trade.symbol, logDate, db) ?? null,
          multiplierUsed: trailingMult,
          unrealisedPct: lastTrailUnrealisedPct,
          action: 'STOPPED_OUT',
          notes: gap,
        },
        db,
      );
      const pnl = pnlPctLong(trade.entryPrice, exitPx);
      const status = pnl >= 0 ? 'CLOSED_WIN' : 'CLOSED_LOSS';
      closePaperTrade(trade.id, status, logDate, exitPx, pnl, db, notes ?? null, exitReason);
      if (logId !== null && !opts?.skipAi) scheduleTrailingStopPostMortem(logId);
    };

    if (!skipStopTargetThisBar && hitSl && hitTg) {
      const exitPx = exitPriceWhenStopHit(bar, stopLoss);
      const gap = bar.open < stopLoss ? GAP_DOWN_THROUGH_STOP_NOTE : undefined;
      const logId = insertStopLog(
        {
          tradeId: trade.id,
          symbol: trade.symbol,
          logDate: bar.date,
          prevStop: stopAtBarStart,
          newStop: exitPx,
          stopDelta: exitPx - stopAtBarStart,
          candidateStop: lastTrailCandidate,
          highestClose: maxCloseSinceEntry,
          atr14Today: getAtr14(trade.symbol, bar.date, db) ?? null,
          multiplierUsed: trailingMult,
          unrealisedPct: lastTrailUnrealisedPct,
          action: 'STOPPED_OUT',
          notes: gap,
        },
        db,
      );
      const pnl = pnlPctLong(trade.entryPrice, exitPx);
      const exitReasonStop: ExitReason = skipTrailThisBar ? 'INITIAL_STOP' : 'TRAILING_STOP';
      closePaperTrade(
        trade.id,
        'CLOSED_LOSS',
        bar.date,
        exitPx,
        pnl,
        db,
        'same-day SL+TP: counted as loss (conservative)',
        exitReasonStop,
      );
      if (logId !== null && !opts?.skipAi) scheduleTrailingStopPostMortem(logId);
      return 'CLOSED_LOSS';
    }

    if (!skipStopTargetThisBar && hitSl) {
      const exitReasonStop: ExitReason = skipTrailThisBar ? 'INITIAL_STOP' : 'TRAILING_STOP';
      logStoppedOut(bar.date, null, exitReasonStop);
      const exitPx = exitPriceWhenStopHit(bar, stopLoss);
      return pnlPctLong(trade.entryPrice, exitPx) >= 0 ? 'CLOSED_WIN' : 'CLOSED_LOSS';
    }

    if (!skipStopTargetThisBar && hitTg) {
      closePaperTrade(
        trade.id,
        'CLOSED_WIN',
        bar.date,
        trade.target,
        pnlPctLong(trade.entryPrice, trade.target),
        db,
        null,
        'TARGET_HIT',
      );
      return 'CLOSED_WIN';
    }

    if (elapsed >= trade.maxHoldDays) {
      closePaperTrade(
        trade.id,
        'CLOSED_TIME',
        bar.date,
        bar.close,
        pnlPctLong(trade.entryPrice, bar.close),
        db,
        null,
        'TIME_EXIT',
      );
      return 'CLOSED_TIME';
    }

    persistOpenRow();
  }

  return 'still_open';
}

export function runEvaluatePaperTrades(
  asOf: string,
  db: DatabaseType,
  opts?: EvaluatePaperTradesOptions,
): EvaluateTradesResult {
  resetStopRaisedTodayForOpenTrades(db);

  const open = getOpenPaperTrades(db);
  let closedWin = 0;
  let closedLoss = 0;
  let closedTime = 0;
  let skippedNoData = 0;

  for (const t of open) {
    const result = evaluateOnePaperTrade(t, db, asOf, opts);
    if (result === 'no_data') {
      skippedNoData++;
    } else if (result === 'CLOSED_WIN') closedWin++;
    else if (result === 'CLOSED_LOSS') closedLoss++;
    else if (result === 'CLOSED_TIME') closedTime++;
  }

  const closed = closedWin + closedLoss + closedTime;
  const stillOpen = getOpenPaperTrades(db).length;

  return {
    asOf,
    evaluated: open.length,
    closed,
    closedWin,
    closedLoss,
    closedTime,
    stillOpen,
    skippedNoData,
  };
}
