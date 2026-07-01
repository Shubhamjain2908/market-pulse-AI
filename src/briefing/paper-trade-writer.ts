/**
 * Record paper-trade rows for forward testing from thesis (AI Picks) and portfolio ADD actions.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config/env.js';
import { loadMomentumConfig, loadSectorMap } from '../config/loaders.js';
import { resolveBookValueInr } from '../db/index.js';
import {
  hasOpenPaperTradeForSymbol,
  insertPaperTradeIfAbsent,
  type PaperTradeHorizon,
  type PaperTradeInsertRow,
  type PaperTradeSignalType,
} from '../db/queries.js';
import { child } from '../logger.js';
import {
  aggregateSectorCapExceeded,
  computePositionWeightPct,
  openSectorCounts,
  resolveSymbolSector,
} from '../strategies/position-sizer.js';
import { evaluateAiPickEligibility } from './ai-pick-gate.js';
import { getAtr14AtEntry, resolveAiPickStop } from './ai-pick-stop.js';
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
  /** Shadow: aggregate sector cap would block at next cohort boundary; insert still proceeds. */
  sectorCapExceeded: number;
  blockedAiPick: number;
  blockedPortfolioAdd: number;
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

export interface SizedPaperTradeInsertResult {
  inserted: boolean;
  sectorCapExceeded: boolean;
}

function insertSizedPaperTrade(
  row: PaperTradeInsertRow,
  entry: number,
  stop: number,
  bookValueInr: number,
  riskPct: number,
  maxSingleStockPct: number,
  sectorCounts: Map<string, number>,
  sectorMap: Record<string, string>,
  maxSectorAggregate: number,
  db: DatabaseType,
): SizedPaperTradeInsertResult {
  const sectorCapExceeded = aggregateSectorCapExceeded(
    row.symbol,
    sectorCounts,
    sectorMap,
    db,
    maxSectorAggregate,
  );
  if (sectorCapExceeded) {
    log.info(
      {
        symbol: row.symbol,
        signalType: row.signalType,
        blockReason: 'aggregate_sector_cap',
        shadowOnly: true,
      },
      'aggregate sector cap exceeded — insert proceeds (shadow until cohort boundary)',
    );
  }
  const positionWeightPct = computePositionWeightPct(
    entry,
    stop,
    bookValueInr,
    riskPct,
    maxSingleStockPct,
  );
  const inserted = insertPaperTradeIfAbsent(
    { ...row, positionWeightPct: positionWeightPct ?? undefined },
    db,
  );
  if (inserted) {
    const sec = resolveSymbolSector(row.symbol, db, sectorMap);
    if (sec !== 'Unknown') {
      sectorCounts.set(sec, (sectorCounts.get(sec) ?? 0) + 1);
    }
  }
  return { inserted, sectorCapExceeded };
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
  let sectorCapExceeded = 0;
  let blockedAiPick = 0;
  let blockedPortfolioAdd = 0;

  const momentumCfg = loadMomentumConfig();
  const sizing = momentumCfg.position_sizing;
  const sectorMap = loadSectorMap();
  const sectorCounts = openSectorCounts(db, sectorMap);
  const bookValueInr = resolveBookValueInr(db).bookValueInr;

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
      const catalystInsert = insertSizedPaperTrade(
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
        entry,
        entry * 0.96,
        bookValueInr,
        sizing.risk_pct,
        sizing.max_single_stock_pct,
        sectorCounts,
        sectorMap,
        momentumCfg.max_sector_aggregate,
        db,
      );
      if (catalystInsert.inserted) insertedCatalystEntry++;
      if (catalystInsert.sectorCapExceeded) sectorCapExceeded++;
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

    const gate = evaluateAiPickEligibility(t.symbol, sourceDate, t, db);
    if (!gate.eligible) {
      blockedAiPick++;
      log.info(
        { event: 'ai_pick_blocked', symbol: t.symbol, reasons: gate.reasons, facts: gate.facts },
        'AI_PICK blocked by eligibility gate',
      );
      continue;
    }

    const atr14 = getAtr14AtEntry(t.symbol, sourceDate, db);
    const stopResult = resolveAiPickStop(entry, stop, atr14);
    if (!stopResult.ok) {
      blockedAiPick++;
      log.info(
        {
          event: 'ai_pick_blocked',
          symbol: t.symbol,
          reason: stopResult.reason,
          entry,
          parsedStop: stop,
          atr14,
        },
        'AI_PICK blocked by stop distance guard',
      );
      continue;
    }
    if (stopResult.normalized) {
      log.warn(
        {
          event: 'ai_pick_stop_normalized',
          symbol: t.symbol,
          parsedStop: stopResult.parsedStop,
          normalizedStop: stopResult.normalizedStop,
          effectiveStop: stopResult.effectiveStop,
        },
        'AI_PICK stop widened to minimum distance',
      );
    }
    if (stopResult.floorApplied) {
      log.warn(
        {
          event: 'ai_pick_stop_floor_applied',
          symbol: t.symbol,
          parsedStop: stopResult.parsedStop,
          normalizedStop: stopResult.normalizedStop,
          hardFloor: stopResult.hardFloor,
          effectiveStop: stopResult.effectiveStop,
        },
        'AI_PICK stop raised to 8% hard floor',
      );
    }

    const { horizon, maxHoldDays } = horizonToDays(t.timeHorizon ?? 'medium');
    if (blockIfOpenPaperTradeExists(t.symbol, 'AI_PICK', db)) {
      crossStrategyBlocked++;
      continue;
    }
    const aiPickInsert = insertSizedPaperTrade(
      {
        symbol: t.symbol,
        signalType: 'AI_PICK',
        sourceDate,
        entryPrice: entry,
        stopLoss: stopResult.effectiveStop,
        target,
        timeHorizon: horizon,
        maxHoldDays,
        atr14AtEntry: stopResult.atr14AtEntry,
      },
      entry,
      stopResult.effectiveStop,
      bookValueInr,
      sizing.risk_pct,
      sizing.max_single_stock_pct,
      sectorCounts,
      sectorMap,
      momentumCfg.max_sector_aggregate,
      db,
    );
    if (aiPickInsert.inserted) insertedAiPick++;
    if (aiPickInsert.sectorCapExceeded) sectorCapExceeded++;
  }

  if (portfolio?.positions?.length) {
    for (const p of portfolio.positions) {
      if (p.action !== 'ADD') continue;
      if (config.PORTFOLIO_ADD_PAPER_TRADES !== '1') {
        blockedPortfolioAdd++;
        log.info(
          { symbol: p.symbol, event: 'portfolio_add_paper_disabled' },
          'PORTFOLIO_ADD paper trade disabled by config',
        );
        continue;
      }
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
      const addInsert = insertSizedPaperTrade(
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
        entry,
        stop,
        bookValueInr,
        sizing.risk_pct,
        sizing.max_single_stock_pct,
        sectorCounts,
        sectorMap,
        momentumCfg.max_sector_aggregate,
        db,
      );
      if (addInsert.inserted) insertedPortfolioAdd++;
      if (addInsert.sectorCapExceeded) sectorCapExceeded++;
    }
  }

  return {
    insertedAiPick,
    insertedPortfolioAdd,
    insertedCatalystEntry,
    crossStrategyBlocked,
    sectorCapExceeded,
    blockedAiPick,
    blockedPortfolioAdd,
  };
}
