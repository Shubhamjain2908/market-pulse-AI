/**
 * Weekly momentum portfolio rebalance (Phase 4.2): regime gate, rank-decay exits,
 * promoted entries with sector cap + earnings blackout. Uses Friday session prices
 * when `calendarDate` falls on a weekend.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { classifySector } from '../briefing/sector-classifier.js';
import { loadMomentumConfig, loadSectorMap } from '../config/loaders.js';
import { getDb } from '../db/index.js';
import {
  type PaperTradeRow,
  closePaperTrade,
  getNseCloseOnOrBefore,
  getOpenPaperTradesForSignal,
  insertPaperTradeIfAbsent,
} from '../db/queries.js';
import { getRegimeForCalendarDate, isStrategyAllowed } from '../db/regime-queries.js';
import { child } from '../logger.js';
import { lastOpenOnOrBefore } from '../market/trading-days.js';
import { runMomentumRanker } from '../rankers/momentum-ranker.js';
import type { Regime } from '../types/regime.js';

const log = child({ component: 'momentum-rebalance' });

function pnlPctLong(entry: number, exit: number): number {
  return ((exit - entry) / entry) * 100;
}

function closeManualAtSession(
  trade: PaperTradeRow,
  sessionDate: string,
  notes: string,
  db: DatabaseType,
): boolean {
  const px = getNseCloseOnOrBefore(trade.symbol, sessionDate, db);
  if (px == null) {
    log.warn({ symbol: trade.symbol, sessionDate }, 'momentum exit skipped: no quote');
    return false;
  }
  const pnl = pnlPctLong(trade.entryPrice, px);
  const status = pnl >= 0 ? 'CLOSED_WIN' : 'CLOSED_LOSS';
  closePaperTrade(trade.id, status, sessionDate, px, pnl, db, notes, 'MANUAL');
  return true;
}

export interface ApplyMomentumRegimeGateOptions {
  calendarDate: string;
  regime: Regime | null | undefined;
  db?: DatabaseType;
}

/** After regime classification: liquidate all open `momentum_mf` when regime ∉ cfg.regime_gate. */
export function applyMomentumRegimeGateExits(opts: ApplyMomentumRegimeGateOptions): number {
  const db = opts.db ?? getDb();
  const cfg = loadMomentumConfig();
  const regime = opts.regime;
  if (regime == null) return 0;
  if (cfg.regime_gate.includes(regime)) return 0;

  const sessionDate = lastOpenOnOrBefore(opts.calendarDate);
  if (!sessionDate) {
    log.warn({ calendarDate: opts.calendarDate }, 'regime gate exit: no session date');
    return 0;
  }

  const open = getOpenPaperTradesForSignal('momentum_mf', db);
  let closed = 0;
  const note = `regime exit: regime changed to ${regime} (calendar ${opts.calendarDate})`;
  for (const t of open) {
    if (closeManualAtSession(t, sessionDate, note, db)) closed++;
  }
  if (closed > 0) {
    log.info({ closed, regime, sessionDate }, 'momentum regime gate: closed open trades');
  }
  return closed;
}

interface MomSignalsMaps {
  rankBySymbol: Map<string, number>;
}

function loadMomentumRanks(sessionDate: string, db: DatabaseType): MomSignalsMaps {
  const rows = db
    .prepare(
      `
    SELECT symbol, name, value FROM signals
    WHERE date = ? AND name IN ('mom_rank')
  `,
    )
    .all(sessionDate) as Array<{ symbol: string; name: string; value: number }>;

  const rankBySymbol = new Map<string, number>();
  for (const r of rows) {
    const sym = r.symbol.toUpperCase();
    if (r.name === 'mom_rank') rankBySymbol.set(sym, r.value);
  }
  return { rankBySymbol };
}

function getEarningsBlackoutExpectedDate(
  symbol: string,
  sessionDate: string,
  windowDays: number,
  db: DatabaseType,
): string | null {
  const row = db
    .prepare(
      `
    SELECT expected_date FROM earnings_calendar
    WHERE symbol = ?
      AND expected_date BETWEEN date(?, printf('-%d days', ?)) AND date(?, printf('+%d days', ?))
    ORDER BY expected_date ASC
    LIMIT 1
  `,
    )
    .get(symbol, sessionDate, windowDays, sessionDate, windowDays) as
    | { expected_date: string }
    | undefined;
  return row?.expected_date ?? null;
}

function loadRankedSymbolsOrdered(sessionDate: string, db: DatabaseType): string[] {
  const rows = db
    .prepare(
      `
    SELECT symbol, value FROM signals
    WHERE date = ? AND name = 'mom_rank'
    ORDER BY value ASC, symbol ASC
  `,
    )
    .all(sessionDate) as Array<{ symbol: string; value: number }>;
  return rows.map((r) => r.symbol.toUpperCase());
}

function resolveSector(
  symbol: string,
  db: DatabaseType,
  sectorMap: Record<string, string>,
): string {
  const row = db.prepare('SELECT sector FROM symbols WHERE symbol = ?').get(symbol) as
    | { sector: string | null }
    | undefined;
  return classifySector(symbol, sectorMap, row?.sector ?? null);
}

export interface MomentumRebalanceOptions {
  calendarDate: string;
  db?: DatabaseType;
  universe?: string[];
  /** When false (default), runs ranker first so `mom_rank` is fresh for `sessionDate`. */
  skipRanker?: boolean;
}

export interface MomentumRebalanceResult {
  calendarDate: string;
  sessionDate: string;
  regime: Regime | null;
  regimeAllowed: boolean;
  rankerRan: boolean;
  closedRegime: number;
  closedRankDecay: number;
  entriesInserted: number;
  sectorCapBlocked: number;
  blackoutBlocked: number;
  unchangedHeld: number;
  skippedReason?: 'regime_gate';
}

export function runMomentumRebalance(opts: MomentumRebalanceOptions): MomentumRebalanceResult {
  const db = opts.db ?? getDb();
  const cfg = loadMomentumConfig();
  const calendarDate = opts.calendarDate;
  const sessionDate = lastOpenOnOrBefore(calendarDate);
  if (!sessionDate) {
    throw new Error(`momentum rebalance: no NSE session on or before ${calendarDate}`);
  }

  let rankerRan = false;
  if (!opts.skipRanker) {
    runMomentumRanker({
      asOf: sessionDate,
      db,
      universe: opts.universe,
    });
    rankerRan = true;
  }

  const regimeRow = getRegimeForCalendarDate(calendarDate, db);
  const regime = regimeRow?.regime ?? null;

  if (regime == null) {
    log.warn({ calendarDate, sessionDate }, 'momentum rebalance aborted: missing regime_daily row');
    return {
      calendarDate,
      sessionDate,
      regime: null,
      regimeAllowed: false,
      rankerRan,
      closedRegime: 0,
      closedRankDecay: 0,
      entriesInserted: 0,
      sectorCapBlocked: 0,
      blackoutBlocked: 0,
      unchangedHeld: getOpenPaperTradesForSignal('momentum_mf', db).length,
      skippedReason: 'regime_gate',
    };
  }

  const regimeAllowed =
    cfg.regime_gate.includes(regime) && isStrategyAllowed(cfg.strategy_id, regime, db);

  if (!regimeAllowed) {
    log.info({ calendarDate, sessionDate, regime }, 'momentum-rebalance gated by regime');
    return {
      calendarDate,
      sessionDate,
      regime,
      regimeAllowed: false,
      rankerRan,
      closedRegime: 0,
      closedRankDecay: 0,
      entriesInserted: 0,
      sectorCapBlocked: 0,
      blackoutBlocked: 0,
      unchangedHeld: getOpenPaperTradesForSignal('momentum_mf', db).length,
      skippedReason: 'regime_gate',
    };
  }

  const { rankBySymbol } = loadMomentumRanks(sessionDate, db);
  const rankedOrder = loadRankedSymbolsOrdered(sessionDate, db);
  const sectorMap = loadSectorMap();

  let closedRankDecay = 0;
  let openTrades = getOpenPaperTradesForSignal('momentum_mf', db);
  const exitThreshold = cfg.exit_rank_threshold;

  for (const t of openTrades) {
    const sym = t.symbol.toUpperCase();
    const rk = rankBySymbol.get(sym);
    const shouldExit = rk == null || !Number.isFinite(rk) || rk > exitThreshold;
    if (shouldExit) {
      const note =
        rk == null
          ? `momentum rebalance: no mom_rank on ${sessionDate}`
          : `momentum rebalance: rank ${rk} > ${exitThreshold}`;
      if (closeManualAtSession(t, sessionDate, note, db)) closedRankDecay++;
    }
  }

  openTrades = getOpenPaperTradesForSignal('momentum_mf', db);
  const heldBeforeEntries = new Set(openTrades.map((t) => t.symbol.toUpperCase()));
  const held = new Set(heldBeforeEntries);

  const sectorCounts = new Map<string, number>();
  for (const t of openTrades) {
    const sec = resolveSector(t.symbol.toUpperCase(), db, sectorMap);
    if (sec !== 'Unknown') {
      sectorCounts.set(sec, (sectorCounts.get(sec) ?? 0) + 1);
    }
  }

  const slotsTarget = cfg.portfolio_slots;
  let entriesInserted = 0;
  let sectorCapBlocked = 0;
  let blackoutBlocked = 0;

  let needed = slotsTarget - openTrades.length;
  if (needed <= 0) {
    log.info(
      {
        calendarDate,
        sessionDate,
        heldCount: openTrades.length,
        closedRankDecay,
        entriesInserted: 0,
      },
      'momentum rebalance: portfolio full after rank exits',
    );
    return {
      calendarDate,
      sessionDate,
      regime,
      regimeAllowed: true,
      rankerRan,
      closedRegime: 0,
      closedRankDecay,
      entriesInserted: 0,
      sectorCapBlocked: 0,
      blackoutBlocked: 0,
      unchangedHeld: heldBeforeEntries.size,
    };
  }

  const hardMult = 1 + cfg.hard_stop_pct / 100;
  const targetMult = 1 + cfg.position_sizing.trim_return_pct / 100;

  for (const sym of rankedOrder) {
    if (needed <= 0) break;
    if (held.has(sym)) continue;

    const rkNew = rankBySymbol.get(sym);
    if (rkNew == null || !Number.isFinite(rkNew) || rkNew > exitThreshold) {
      continue;
    }

    const expectedDate = getEarningsBlackoutExpectedDate(
      sym,
      sessionDate,
      cfg.earnings_blackout_days,
      db,
    );
    if (expectedDate != null) {
      log.info(
        { symbol: sym, sessionDate, expectedDate },
        'momentum-rebalance entry skipped — earnings blackout',
      );
      blackoutBlocked++;
      continue;
    }

    const sec = resolveSector(sym, db, sectorMap);
    if (sec !== 'Unknown') {
      const c = sectorCounts.get(sec) ?? 0;
      if (c >= cfg.max_per_sector) {
        sectorCapBlocked++;
        continue;
      }
    }

    const entry = getNseCloseOnOrBefore(sym, sessionDate, db);
    if (entry == null) {
      log.warn({ sym, sessionDate }, 'momentum entry skipped: no quote');
      continue;
    }

    const stopLoss = entry * hardMult;
    const target = entry * targetMult;

    const ok = insertPaperTradeIfAbsent(
      {
        symbol: sym,
        signalType: 'momentum_mf',
        sourceDate: sessionDate,
        entryPrice: entry,
        stopLoss,
        target,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    if (ok) {
      held.add(sym);
      if (sec !== 'Unknown') {
        sectorCounts.set(sec, (sectorCounts.get(sec) ?? 0) + 1);
      }
      entriesInserted++;
      needed--;
    }
  }

  const finalOpen = getOpenPaperTradesForSignal('momentum_mf', db);
  const finalSyms = new Set(finalOpen.map((t) => t.symbol.toUpperCase()));
  let unchangedHeld = 0;
  for (const s of heldBeforeEntries) {
    if (finalSyms.has(s)) unchangedHeld++;
  }

  log.info(
    {
      calendarDate,
      sessionDate,
      regime,
      closedRankDecay,
      entriesInserted,
      sectorCapBlocked,
      blackoutBlocked,
      heldCount: finalOpen.length,
    },
    'momentum rebalance complete',
  );

  return {
    calendarDate,
    sessionDate,
    regime,
    regimeAllowed: true,
    rankerRan,
    closedRegime: 0,
    closedRankDecay,
    entriesInserted,
    sectorCapBlocked,
    blackoutBlocked,
    unchangedHeld,
  };
}
