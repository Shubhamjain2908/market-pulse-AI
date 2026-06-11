/**
 * Record paper-trade rows for forward testing from thesis (AI Picks) and portfolio ADD actions.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import {
  hasOpenPaperTradeForSymbol,
  insertPaperTradeIfAbsent,
  type PaperTradeHorizon,
  type PaperTradeSignalType,
} from '../db/queries.js';
import { child } from '../logger.js';
import { parseInrPriceMidpoint } from './paper-trade-parsers.js';
import type { PortfolioSummary, ThesisCard } from './template.js';

const log = child({ component: 'paper-trade-writer' });

/** Matches momentum_mf hard stop floor (entry × 0.92). */
const AI_PICK_HARD_STOP_FLOOR_MULT = 0.92;

function horizonToDays(horizon: string): { horizon: PaperTradeHorizon; maxHoldDays: number } {
  const h = horizon.toLowerCase().trim();
  if (h === 'short') return { horizon: 'short', maxHoldDays: 30 };
  if (h === 'long') return { horizon: 'long', maxHoldDays: 252 };
  return { horizon: 'medium', maxHoldDays: 90 };
}

function isValidLongLevel(entry: number, stop: number, target: number): boolean {
  if (!(entry > 0 && stop > 0 && target > 0)) return false;
  if (target <= entry) return false;
  if (stop >= entry) return false;
  return true;
}

interface CatalystScreenCriteria {
  days_to_earnings: number;
  atr_14: number | null;
}

function getCatalystScreenCriteria(
  symbol: string,
  sourceDate: string,
  db: DatabaseType,
): CatalystScreenCriteria | null {
  const row = db
    .prepare(
      `
      SELECT matched_criteria AS matchedCriteria
      FROM screens
      WHERE symbol = ? AND date = ? AND screen_name = 'catalyst_entry'
      LIMIT 1
    `,
    )
    .get(symbol, sourceDate) as { matchedCriteria: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.matchedCriteria) as Record<string, unknown>;
    const daysToEarnings = parsed.days_to_earnings;
    if (typeof daysToEarnings !== 'number' || !Number.isFinite(daysToEarnings)) {
      return null;
    }
    const atr14 =
      typeof parsed.atr_14 === 'number' && Number.isFinite(parsed.atr_14) ? parsed.atr_14 : null;
    return { days_to_earnings: daysToEarnings, atr_14: atr14 };
  } catch {
    return null;
  }
}

export interface PaperTradeRecordResult {
  insertedAiPick: number;
  insertedPortfolioAdd: number;
  insertedCatalystEntry: number;
  crossStrategyBlocked: number;
}

function blockIfOpenPaperTradeExists(
  symbol: string,
  signalType: PaperTradeSignalType,
  db: DatabaseType,
): boolean {
  if (!hasOpenPaperTradeForSymbol(symbol, db)) return false;
  log.info(
    { symbol, signalType, blockReason: 'open_in_other_strategy' },
    'paper trade dedup — symbol already open under different signal',
  );
  return true;
}

/**
 * Idempotent: one row per (symbol, signal_type, source_date). Safe to call on every brief run.
 */
export function recordPaperTrades(
  sourceDate: string,
  theses: ThesisCard[],
  portfolio: PortfolioSummary | undefined,
  db: DatabaseType,
): PaperTradeRecordResult {
  let insertedAiPick = 0;
  let insertedPortfolioAdd = 0;
  let insertedCatalystEntry = 0;
  let crossStrategyBlocked = 0;

  for (const t of theses) {
    const entry = parseInrPriceMidpoint(t.entryZone);
    const stop = parseInrPriceMidpoint(t.stopLoss);
    const target = parseInrPriceMidpoint(t.target);
    if (entry == null || stop == null || target == null) {
      log.warn({ symbol: t.symbol }, 'paper trade skipped: unparseable INR levels');
      continue;
    }
    const catalystCriteria = getCatalystScreenCriteria(t.symbol, sourceDate, db);
    if (catalystCriteria) {
      if (!isValidLongLevel(entry, stop, target)) {
        log.warn(
          { symbol: t.symbol, entry, stop, target },
          'paper trade skipped: invalid long setup (target<=entry or stop>=entry)',
        );
        continue;
      }
      const maxHoldDays = Math.max(1, Math.trunc(catalystCriteria.days_to_earnings) + 2);
      if (blockIfOpenPaperTradeExists(t.symbol, 'catalyst_entry', db)) {
        crossStrategyBlocked++;
        continue;
      }
      const ok = insertPaperTradeIfAbsent(
        {
          symbol: t.symbol,
          signalType: 'catalyst_entry',
          sourceDate,
          entryPrice: entry,
          stopLoss: entry * 0.96,
          target: entry * 1.08,
          timeHorizon: 'short',
          maxHoldDays,
          stopType: 'fixed',
          trailingMultiplier: 0,
          atr14AtEntry: catalystCriteria.atr_14,
        },
        db,
      );
      if (ok) insertedCatalystEntry++;
      continue;
    }

    if (!(entry > 0 && stop > 0 && target > 0)) {
      log.warn(
        { symbol: t.symbol, entry, stop, target },
        'paper trade skipped: invalid long setup (target<=entry or stop>=entry)',
      );
      continue;
    }
    if (target <= entry) {
      log.warn(
        { symbol: t.symbol, entry, stop, target },
        'paper trade skipped: invalid long setup (target<=entry or stop>=entry)',
      );
      continue;
    }
    if (stop >= entry) {
      log.error(
        { symbol: t.symbol, stopLoss: stop, entryPrice: entry },
        'AI_PICK paper trade rejected: stopLoss >= entryPrice',
      );
      continue;
    }

    const hardFloor = entry * AI_PICK_HARD_STOP_FLOOR_MULT;
    const effectiveStop = Math.max(stop, hardFloor);
    if (effectiveStop !== stop) {
      log.warn(
        { symbol: t.symbol, originalStop: stop, effectiveStop },
        'AI_PICK stop raised to 8% hard floor',
      );
    }

    const { horizon, maxHoldDays } = horizonToDays(t.timeHorizon ?? 'medium');
    if (blockIfOpenPaperTradeExists(t.symbol, 'AI_PICK', db)) {
      crossStrategyBlocked++;
      continue;
    }
    const ok = insertPaperTradeIfAbsent(
      {
        symbol: t.symbol,
        signalType: 'AI_PICK',
        sourceDate,
        entryPrice: entry,
        stopLoss: effectiveStop,
        target,
        timeHorizon: horizon,
        maxHoldDays,
      },
      db,
    );
    if (ok) insertedAiPick++;
  }

  if (portfolio?.positions?.length) {
    for (const p of portfolio.positions) {
      if (p.action !== 'ADD') continue;
      const entry = p.lastPrice;
      const stop = p.suggestedStop;
      const target = p.suggestedTarget;
      if (entry == null || stop == null || target == null) {
        log.warn({ symbol: p.symbol }, 'paper trade skipped: ADD missing lastPrice/stop/target');
        continue;
      }
      if (!isValidLongLevel(entry, stop, target)) {
        log.warn(
          { symbol: p.symbol, entry, stop, target },
          'paper trade skipped: invalid ADD levels',
        );
        continue;
      }
      if (blockIfOpenPaperTradeExists(p.symbol, 'PORTFOLIO_ADD', db)) {
        crossStrategyBlocked++;
        continue;
      }
      const ok = insertPaperTradeIfAbsent(
        {
          symbol: p.symbol,
          signalType: 'PORTFOLIO_ADD',
          sourceDate,
          entryPrice: entry,
          stopLoss: stop,
          target,
          timeHorizon: 'medium',
          maxHoldDays: 90,
        },
        db,
      );
      if (ok) insertedPortfolioAdd++;
    }
  }

  return { insertedAiPick, insertedPortfolioAdd, insertedCatalystEntry, crossStrategyBlocked };
}
