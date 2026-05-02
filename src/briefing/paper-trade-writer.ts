/**
 * Record paper-trade rows for forward testing from thesis (AI Picks) and portfolio ADD actions.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { type PaperTradeHorizon, insertPaperTradeIfAbsent } from '../db/queries.js';
import { child } from '../logger.js';
import { parseInrPriceMidpoint } from './paper-trade-parsers.js';
import type { PortfolioSummary, ThesisCard } from './template.js';

const log = child({ component: 'paper-trade-writer' });

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

/**
 * Idempotent: one row per (symbol, signal_type, source_date). Safe to call on every brief run.
 */
export function recordPaperTrades(
  sourceDate: string,
  theses: ThesisCard[],
  portfolio: PortfolioSummary | undefined,
  db: DatabaseType,
): { insertedAiPick: number; insertedPortfolioAdd: number } {
  let insertedAiPick = 0;
  let insertedPortfolioAdd = 0;

  for (const t of theses) {
    const entry = parseInrPriceMidpoint(t.entryZone);
    const stop = parseInrPriceMidpoint(t.stopLoss);
    const target = parseInrPriceMidpoint(t.target);
    if (entry == null || stop == null || target == null) {
      log.warn({ symbol: t.symbol }, 'paper trade skipped: unparseable INR levels');
      continue;
    }
    if (!isValidLongLevel(entry, stop, target)) {
      log.warn(
        { symbol: t.symbol, entry, stop, target },
        'paper trade skipped: invalid long setup (target<=entry or stop>=entry)',
      );
      continue;
    }
    const { horizon, maxHoldDays } = horizonToDays(t.timeHorizon ?? 'medium');
    const ok = insertPaperTradeIfAbsent(
      {
        symbol: t.symbol,
        signalType: 'AI_PICK',
        sourceDate,
        entryPrice: entry,
        stopLoss: stop,
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

  return { insertedAiPick, insertedPortfolioAdd };
}
