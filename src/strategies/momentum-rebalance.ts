/**
 * Weekly momentum portfolio rebalance (Phase 4.2): regime gate, rank-decay exits,
 * promoted entries with sector cap + earnings blackout. Uses Friday session prices
 * when `calendarDate` falls on a weekend.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { buildStockContext, THESIS_JSON_SYSTEM_PROMPT } from '../agents/thesis-generator.js';
import type { MomentumRebalanceSummary } from '../briefing/momentum-card.js';
import { parseInrPriceMidpoint } from '../briefing/paper-trade-parsers.js';
import { classifySector } from '../briefing/sector-classifier.js';
import { loadMomentumConfig, loadPortfolio, loadSectorMap } from '../config/loaders.js';
import { getDb } from '../db/index.js';
import {
  closePaperTrade,
  getNseCloseOnOrBefore,
  getOpenPaperTradesForSignal,
  insertPaperTradeIfAbsent,
  type PaperTradeRow,
  type UpsertThesisRow,
  upsertMomentumRebalanceBriefing,
  upsertThesis,
} from '../db/queries.js';
import { getRegimeForCalendarDate, isStrategyAllowed } from '../db/regime-queries.js';
import { getAtr14 } from '../db/trailing-stop-queries.js';
import { getLlmProvider } from '../llm/index.js';
import type { LlmProvider } from '../llm/types.js';
import { child } from '../logger.js';
import { lastOpenOnOrBefore } from '../market/trading-days.js';
import { runMomentumRanker } from '../rankers/momentum-ranker.js';
import { type Thesis, ThesisSchema } from '../types/domain.js';
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
  /** Tests / dry-runs can skip LLM thesis generation. */
  skipThesis?: boolean;
  llm?: LlmProvider;
}

export interface MomentumRebalanceResult {
  calendarDate: string;
  sessionDate: string;
  regime: Regime | null;
  regimeAllowed: boolean;
  rankerRan: boolean;
  /** Present when embedded ranker ran; regime exits are counted only via `applyMomentumRegimeGateExits` (daily). */
  rankerSnapshot?: { universeSize: number; eligibleCount: number };
  closedRankDecay: number;
  entriesInserted: number;
  sectorCapBlocked: number;
  blackoutBlocked: number;
  falseFlagBlocked: number;
  unchangedHeld: number;
  thesisFailed: number;
  /** Omitted when regime is allowed and rebalance proceeded normally. */
  skippedReason?: 'regime_gate' | 'missing_regime';
}

/** Shape expected by {@link renderMomentumBriefingBlock} (also persisted for weekend `brief`). */
export function toMomentumRebalanceBriefingSummary(
  r: MomentumRebalanceResult,
): MomentumRebalanceSummary {
  return {
    calendarDate: r.calendarDate,
    sessionDate: r.sessionDate,
    regimeAllowed: r.regimeAllowed,
    regime: r.regime,
    closedRankDecay: r.closedRankDecay,
    entriesInserted: r.entriesInserted,
    unchangedHeld: r.unchangedHeld,
    sectorCapBlocked: r.sectorCapBlocked,
    blackoutBlocked: r.blackoutBlocked,
    falseFlagBlocked: r.falseFlagBlocked,
    skippedReason: r.skippedReason,
    thesisFailed: r.thesisFailed,
    rankerSnapshot: r.rankerSnapshot,
  };
}

function finishMomentumRebalance(
  db: DatabaseType,
  r: MomentumRebalanceResult,
): MomentumRebalanceResult {
  upsertMomentumRebalanceBriefing(toMomentumRebalanceBriefingSummary(r), db);
  return r;
}

interface MomentumEntryContext {
  rank: number;
  composite: number | null;
  falseFlag: boolean;
  mom121: number | null;
  epsRevision: number | null;
  rsBa: number | null;
  breakout: number | null;
}

function loadMomentumEntryContext(
  symbol: string,
  sessionDate: string,
  rank: number,
  db: DatabaseType,
): MomentumEntryContext {
  const rows = db
    .prepare(
      `
    SELECT name, value FROM signals
    WHERE symbol = ? AND date = ?
      AND name IN ('mom_composite_score','mom_false_flag','mom_12_1_return','mom_relative_strength_ba','mom_volume_breakout_flag')
  `,
    )
    .all(symbol, sessionDate) as Array<{ name: string; value: number }>;
  const m = new Map(rows.map((r) => [r.name, r.value] as const));
  const epsRow = db
    .prepare(
      `
    SELECT profit_growth_yoy FROM fundamentals
    WHERE symbol = ? AND as_of <= ?
    ORDER BY as_of DESC LIMIT 1
  `,
    )
    .get(symbol, sessionDate) as { profit_growth_yoy: number | null } | undefined;

  return {
    rank,
    composite: m.get('mom_composite_score') ?? null,
    falseFlag: (m.get('mom_false_flag') ?? 0) >= 1,
    mom121: m.get('mom_12_1_return') ?? null,
    epsRevision: epsRow?.profit_growth_yoy ?? null,
    rsBa: m.get('mom_relative_strength_ba') ?? null,
    breakout: m.get('mom_volume_breakout_flag') ?? null,
  };
}

function computeSuggestedSizePct(
  entryPrice: number,
  stopLoss: number,
  portfolioValue: number,
  riskPct: number,
  maxSingleStockPct: number,
): number {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopLoss) || entryPrice <= stopLoss) {
    return Math.max(0, maxSingleStockPct);
  }
  const riskAmount = portfolioValue * (riskPct / 100);
  const perShareRisk = entryPrice - stopLoss;
  if (perShareRisk <= 0 || !Number.isFinite(perShareRisk)) return Math.max(0, maxSingleStockPct);
  const shares = riskAmount / perShareRisk;
  const positionValue = shares * entryPrice;
  if (!Number.isFinite(positionValue) || portfolioValue <= 0) return Math.max(0, maxSingleStockPct);
  const pct = (positionValue / portfolioValue) * 100;
  return Math.max(0, Math.min(maxSingleStockPct, pct));
}

const MOMENTUM_ENTRY_THESIS_ADDENDUM = `MOMENTUM SLEEVE ENTRY (same JSON schema as above):
- The "## Momentum Context" block has rank and factor numbers — weave them into thesis, bullCase, and bearCase.
- Set triggerScreen to "momentum_mf (rank entry)" (or include that phrase).
- The JSON "symbol" field MUST be exactly the ticker from the first line of the user message ("Ticker for JSON symbol field").
- If mom_false_flag is 1 in Momentum Context, confidenceScore must be ≤ 5.`;

const MOMENTUM_ENTRY_SYSTEM = `${THESIS_JSON_SYSTEM_PROMPT}

${MOMENTUM_ENTRY_THESIS_ADDENDUM}`;

async function generateEntryThesis(
  symbol: string,
  sessionDate: string,
  ctx: MomentumEntryContext,
  llm: LlmProvider,
  db: DatabaseType,
): Promise<{ thesis: Thesis; model: string; raw: string } | null> {
  try {
    const base = buildStockContext(symbol, sessionDate, db, 'thesis');
    const momentumPayload = JSON.stringify(
      {
        rank: ctx.rank,
        composite_score: ctx.composite,
        mom_12_1_return: ctx.mom121,
        mom_eps_revision: ctx.epsRevision,
        mom_relative_strength_ba: ctx.rsBa,
        mom_volume_breakout_flag: ctx.breakout,
        mom_false_flag: ctx.falseFlag ? 1 : 0,
      },
      null,
      2,
    );
    const user = `Ticker for JSON symbol field (required): ${symbol.toUpperCase()}\n\n${base}\n\n## Momentum Context\n${momentumPayload}`;
    const result = await llm.generateJson({
      system: MOMENTUM_ENTRY_SYSTEM,
      user,
      schema: ThesisSchema,
      temperature: 0.2,
      maxRetries: 2,
    });
    let thesis = result.data;
    thesis = { ...thesis, symbol: symbol.toUpperCase() };
    if (ctx.falseFlag && thesis.confidenceScore > 5) {
      thesis = { ...thesis, confidenceScore: 5 };
    }
    return { thesis, model: result.model, raw: result.raw };
  } catch (err) {
    log.warn({ symbol, err: (err as Error).message }, 'momentum thesis generation failed');
    return null;
  }
}

export async function runMomentumRebalance(
  opts: MomentumRebalanceOptions,
): Promise<MomentumRebalanceResult> {
  const db = opts.db ?? getDb();
  const cfg = loadMomentumConfig();
  const llm = opts.skipThesis ? undefined : (opts.llm ?? getLlmProvider());
  const portfolioValue = loadPortfolio().totalCapital;
  const calendarDate = opts.calendarDate;
  const sessionDate = lastOpenOnOrBefore(calendarDate);
  if (!sessionDate) {
    throw new Error(`momentum rebalance: no NSE session on or before ${calendarDate}`);
  }

  let rankerRan = false;
  let rankerSnapshot: { universeSize: number; eligibleCount: number } | undefined;
  if (!opts.skipRanker) {
    const rr = runMomentumRanker({
      asOf: sessionDate,
      db,
      universe: opts.universe,
    });
    rankerRan = true;
    rankerSnapshot = { universeSize: rr.universeSize, eligibleCount: rr.eligibleCount };
  }

  const regimeRow = getRegimeForCalendarDate(calendarDate, db);
  const regime = regimeRow?.regime ?? null;

  if (regime == null) {
    log.warn({ calendarDate, sessionDate }, 'momentum rebalance aborted: missing regime_daily row');
    return finishMomentumRebalance(db, {
      calendarDate,
      sessionDate,
      regime: null,
      regimeAllowed: false,
      rankerRan,
      rankerSnapshot,
      closedRankDecay: 0,
      entriesInserted: 0,
      sectorCapBlocked: 0,
      blackoutBlocked: 0,
      falseFlagBlocked: 0,
      unchangedHeld: getOpenPaperTradesForSignal('momentum_mf', db).length,
      thesisFailed: 0,
      skippedReason: 'missing_regime',
    });
  }

  const regimeAllowed =
    cfg.regime_gate.includes(regime) && isStrategyAllowed(cfg.strategy_id, regime, db);

  if (!regimeAllowed) {
    log.info({ calendarDate, sessionDate, regime }, 'momentum-rebalance gated by regime');
    return finishMomentumRebalance(db, {
      calendarDate,
      sessionDate,
      regime,
      regimeAllowed: false,
      rankerRan,
      rankerSnapshot,
      closedRankDecay: 0,
      entriesInserted: 0,
      sectorCapBlocked: 0,
      blackoutBlocked: 0,
      falseFlagBlocked: 0,
      unchangedHeld: getOpenPaperTradesForSignal('momentum_mf', db).length,
      thesisFailed: 0,
      skippedReason: 'regime_gate',
    });
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
  let falseFlagBlocked = 0;

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
    return finishMomentumRebalance(db, {
      calendarDate,
      sessionDate,
      regime,
      regimeAllowed: true,
      rankerRan,
      rankerSnapshot,
      closedRankDecay,
      entriesInserted: 0,
      sectorCapBlocked: 0,
      blackoutBlocked: 0,
      falseFlagBlocked: 0,
      unchangedHeld: heldBeforeEntries.size,
      thesisFailed: 0,
    });
  }

  const hardMult = 1 + cfg.hard_stop_pct / 100;
  let thesisFailed = 0;

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

    const entryCtx = loadMomentumEntryContext(sym, sessionDate, rkNew, db);
    if (entryCtx.falseFlag) {
      log.info(
        { symbol: sym, source_date: sessionDate, reason: 'false_momentum_flag' },
        '[GATED] momentum_mf entry blocked — mom_false_flag=1',
      );
      falseFlagBlocked++;
      continue;
    }

    let thesisStop: number | null = null;
    let thesisTarget: number | null = null;
    let thesisModel = 'n/a';
    if (!opts.skipThesis) {
      if (!llm) {
        thesisFailed++;
        continue;
      }
      const gen = await generateEntryThesis(sym, sessionDate, entryCtx, llm, db);
      if (!gen) {
        thesisFailed++;
        continue;
      }
      thesisModel = gen.model;
      const thesisRow: UpsertThesisRow = {
        ...gen.thesis,
        symbol: sym,
        date: sessionDate,
        model: gen.model,
        raw: gen.raw,
      };
      upsertThesis(thesisRow, db);
      thesisStop = parseInrPriceMidpoint(gen.thesis.stopLoss);
      thesisTarget = parseInrPriceMidpoint(gen.thesis.target);
    }

    const atr14 = getAtr14(sym, sessionDate, db);
    const atrUsed = atr14 ?? entry * 0.02;
    const atrFallbackUsed = atr14 == null;
    if (atrFallbackUsed) {
      log.info({ symbol: sym, sessionDate }, 'ATR14 missing, using 2% proxy for stop sizing');
    }

    const hardFloorStop = entry * hardMult;
    const atrStop = entry - cfg.position_sizing.atr_multiplier * atrUsed;
    const thesisStopSafe = thesisStop != null && thesisStop < entry ? thesisStop : null;
    const stopLoss = Math.max(hardFloorStop, atrStop, thesisStopSafe ?? Number.NEGATIVE_INFINITY);
    const target =
      thesisTarget != null && thesisTarget > entry
        ? thesisTarget
        : entry * (1 + cfg.position_sizing.trim_return_pct / 100);
    if (!Number.isFinite(stopLoss) || !Number.isFinite(target) || target <= entry) {
      log.warn({ symbol: sym, stopLoss, target, entry }, 'momentum entry skipped: invalid levels');
      continue;
    }

    const suggestedSizePct = computeSuggestedSizePct(
      entry,
      stopLoss,
      portfolioValue,
      cfg.position_sizing.risk_pct,
      cfg.position_sizing.max_single_stock_pct,
    );
    const notes = JSON.stringify({
      rank: entryCtx.rank,
      composite_score: entryCtx.composite,
      suggested_position_size_pct: suggestedSizePct,
      false_flag: entryCtx.falseFlag,
      earnings_blackout_checked: true,
      atr14_used: atrUsed,
      atr14_fallback_2pct: atrFallbackUsed,
      thesis_model: thesisModel,
    });

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
        notes,
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
      falseFlagBlocked,
      heldCount: finalOpen.length,
      thesisFailed,
      rankerSnapshot,
    },
    'momentum rebalance complete',
  );

  return finishMomentumRebalance(db, {
    calendarDate,
    sessionDate,
    regime,
    regimeAllowed: true,
    rankerRan,
    rankerSnapshot,
    closedRankDecay,
    entriesInserted,
    sectorCapBlocked,
    blackoutBlocked,
    falseFlagBlocked,
    unchangedHeld,
    thesisFailed,
  });
}
