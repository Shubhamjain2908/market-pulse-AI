/**
 * Quality-GARP screener: gate thresholds, funnel tracking, symbol resolution.
 * Consolidated from quality-garp-gates.ts, quality-garp-funnel.ts, quality-garp-universe.ts.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config/env.js';
import { loadWatchlist } from '../config/loaders.js';
import { child } from '../logger.js';
import type { Regime } from '../types/regime.js';

const log = child({ component: 'quality-garp-funnel' });

// ---------------------------------------------------------------------------
// Symbol resolution (universe)
// ---------------------------------------------------------------------------

/** How the quality_garp symbol list was resolved for this run. */
export type QualityGarpUniverseScope = 'yahoo_annual' | 'watchlist' | 'override';

export interface QualityGarpSymbolResolution {
  symbols: string[];
  universeScope: QualityGarpUniverseScope;
}

/**
 * Live + backtest default: all symbols with `yahoo_annual` fundamentals (~241).
 * Matches audit denominators and backtest `resolveBacktestSymbols`.
 */
export function resolveQualityGarpSymbols(
  db: DatabaseType,
  overrideSymbols?: string[],
): QualityGarpSymbolResolution {
  if (overrideSymbols != null) {
    return {
      symbols: overrideSymbols.map((s) => s.toUpperCase()),
      universeScope: 'override',
    };
  }

  const symbols = (
    db
      .prepare(`SELECT DISTINCT symbol FROM fundamentals WHERE source = 'yahoo_annual'`)
      .pluck()
      .all() as string[]
  ).map((s) => s.toUpperCase());

  return { symbols, universeScope: 'yahoo_annual' };
}

/** Watchlist-only resolution (legacy); not used by live quality_garp today. */
export function resolveQualityGarpWatchlistSymbols(): QualityGarpSymbolResolution {
  return {
    symbols: loadWatchlist().symbols.map((s) => s.toUpperCase()),
    universeScope: 'watchlist',
  };
}

// ---------------------------------------------------------------------------
// Gate thresholds
// ---------------------------------------------------------------------------

/** Shared Quality-GARP v2 gate thresholds (screener + audit). */

export const QUALITY_GARP_SCREEN = 'quality_garp';
export const QUALITY_GARP_TOTAL_GATES = 13;
export const PROMOTER_PLEDGE_MAX_PCT = 15;
export const QUALITY_GARP_PE_MAX = 35;
export const QUALITY_GARP_PB_MAX = 6;
export const QUALITY_GARP_ROCE_MIN = 0.2;
export const QUALITY_GARP_DE_MAX = 0.5;
export const QUALITY_GARP_PEG_MAX = 1.2;
export const QUALITY_GARP_ROE_MIN = 0.18;
export const QUALITY_GARP_RSI_MAX = 45;
export const QUALITY_GARP_SMA50_PCT_MAX = 5;

// Fail-open on <4 quarters. 5% ≈ P80 of covered symbols (median 2.33%, P75 4.21%).
export const OPM_STD_DEV_MAX_PCT = 5.0;

// ---------------------------------------------------------------------------
// Regime-aware threshold resolution (ITEM 1a)
// ---------------------------------------------------------------------------

/**
 * Per-regime threshold overrides for the quality_garp screen.
 * Only threshold-sensitive timing gates are varied by regime.
 * Fundamental quality floors (ROE, ROCE, D/E, PB, OPM stddev) remain constant.
 */
export interface GarpThresholds {
  peMax: number;
  pbMax: number;
  roeMin: number;
  roceMin: number;
  deMax: number;
  pegMax: number;
  rsiMax: number;
  sma50PctMax: number;
  opmStdDevMax: number;
}

/**
 * Resolves gate thresholds based on market regime.
 * CHOPPY (default) returns existing hardcoded constants — zero behaviour change.
 * Bypass in CRISIS: CRISIS entries are already blocked at the strategy-gate level,
 * but we provide tight thresholds as a safety net.
 */
export function resolveGarpThresholds(regime?: Regime): GarpThresholds {
  switch (regime) {
    case 'BULL_TRENDING':
      return {
        peMax: 40,
        pbMax: QUALITY_GARP_PB_MAX,
        roeMin: QUALITY_GARP_ROE_MIN,
        roceMin: QUALITY_GARP_ROCE_MIN,
        deMax: QUALITY_GARP_DE_MAX,
        pegMax: 1.4,
        rsiMax: 55,
        sma50PctMax: 8,
        opmStdDevMax: OPM_STD_DEV_MAX_PCT,
      };
    case 'BEAR_TRENDING':
      return {
        peMax: 28,
        pbMax: QUALITY_GARP_PB_MAX,
        roeMin: QUALITY_GARP_ROE_MIN,
        roceMin: QUALITY_GARP_ROCE_MIN,
        deMax: QUALITY_GARP_DE_MAX,
        pegMax: 1.0,
        rsiMax: 40,
        sma50PctMax: 3,
        opmStdDevMax: OPM_STD_DEV_MAX_PCT,
      };
    case 'CRISIS':
      return {
        peMax: 22,
        pbMax: QUALITY_GARP_PB_MAX,
        roeMin: QUALITY_GARP_ROE_MIN,
        roceMin: QUALITY_GARP_ROCE_MIN,
        deMax: QUALITY_GARP_DE_MAX,
        pegMax: 0.9,
        rsiMax: 35,
        sma50PctMax: 0,
        opmStdDevMax: OPM_STD_DEV_MAX_PCT,
      };
    default:
      // CHOPPY or undefined — existing behaviour, unchanged constants
      return {
        peMax: QUALITY_GARP_PE_MAX,
        pbMax: QUALITY_GARP_PB_MAX,
        roeMin: QUALITY_GARP_ROE_MIN,
        roceMin: QUALITY_GARP_ROCE_MIN,
        deMax: QUALITY_GARP_DE_MAX,
        pegMax: QUALITY_GARP_PEG_MAX,
        rsiMax: QUALITY_GARP_RSI_MAX,
        sma50PctMax: QUALITY_GARP_SMA50_PCT_MAX,
        opmStdDevMax: OPM_STD_DEV_MAX_PCT,
      };
  }
}

// ---------------------------------------------------------------------------
// Funnel types
// ---------------------------------------------------------------------------

export type QualityGarpFailGate =
  | 'etf_exclusion'
  | 'no_fundamentals'
  | 'valuation_null'
  | 'valuation'
  | 'roe_3yr'
  | 'roce'
  | 'debt'
  | 'peg_null'
  | 'peg'
  | 'rsi'
  | 'sma50'
  | 'promoter'
  | 'pledge'
  | 'opm_stability'
  | 'qds';

/** Per-gate elimination counts (one bucket per symbol). */
export interface QualityGarpFunnelCounts {
  universe: number;
  candidates_pe_pb: number;
  etf_exclusion: number;
  no_fundamentals: number;
  valuation_null: number;
  valuation: number;
  roe_3yr: number;
  roce: number;
  debt: number;
  peg_null: number;
  peg: number;
  rsi: number;
  sma50: number;
  promoter: number;
  pledge: number;
  pledge_shadow: number;
  pledge_skipped: number;
  opm_stability: number;
  opm_skipped: number;
  qds: number;
  qds_warning: number;
  qds_skipped: number;
  passed: number;
}

export interface QualityGarpFunnelRecord {
  date: string;
  screen: 'quality_garp';
  matches: number;
  /** Symbol resolution source — compare funnel counts to audit/backtest. */
  universe_scope: QualityGarpUniverseScope;
  regime?: Regime;
  funnel: QualityGarpFunnelCounts;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Funnel helpers
// ---------------------------------------------------------------------------

export function createEmptyQualityGarpFunnel(): QualityGarpFunnelCounts {
  return {
    universe: 0,
    candidates_pe_pb: 0,
    etf_exclusion: 0,
    no_fundamentals: 0,
    valuation_null: 0,
    valuation: 0,
    roe_3yr: 0,
    roce: 0,
    debt: 0,
    peg_null: 0,
    peg: 0,
    rsi: 0,
    sma50: 0,
    promoter: 0,
    pledge: 0,
    pledge_shadow: 0,
    pledge_skipped: 0,
    opm_stability: 0,
    opm_skipped: 0,
    qds: 0,
    qds_warning: 0,
    qds_skipped: 0,
    passed: 0,
  };
}

export function recordQualityGarpFunnelFailure(
  funnel: QualityGarpFunnelCounts,
  gate: QualityGarpFailGate,
): void {
  funnel[gate]++;
}

function funnelLogPath(): string {
  const dbDir = dirname(config.DATABASE_PATH);
  return join(dbDir, 'quality_garp_funnel.jsonl');
}

/** Append a timestamped funnel record for forward validation (live paths only). */
export function persistQualityGarpFunnel(record: QualityGarpFunnelRecord): void {
  const path = funnelLogPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  log.info(
    {
      date: record.date,
      matches: record.matches,
      universe_scope: record.universe_scope,
      funnel: record.funnel,
    },
    'quality_garp funnel',
  );
}

/** Latest funnel record for a calendar date (briefing diagnostic). */
export function readQualityGarpFunnelForDate(date: string): QualityGarpFunnelRecord | null {
  const path = funnelLogPath();
  if (!existsSync(path)) return null;

  let latest: QualityGarpFunnelRecord | null = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as QualityGarpFunnelRecord;
      if (row.date === date) latest = row;
    } catch {
      // skip malformed lines
    }
  }
  return latest;
}

export function formatQualityGarpFunnelSummary(
  funnel: QualityGarpFunnelCounts,
  universeScope?: QualityGarpUniverseScope,
): string {
  const preRsi =
    funnel.valuation + funnel.roe_3yr + funnel.roce + funnel.debt + funnel.peg_null + funnel.peg;
  const scopeLabel = universeScope ? ` [${universeScope}, n=${funnel.universe}]` : '';
  const opmSummary =
    funnel.opm_skipped > 0
      ? `OPM ${funnel.opm_stability} fail, ${funnel.opm_skipped} skipped`
      : `OPM ${funnel.opm_stability}`;
  const qdsSummary =
    funnel.qds_skipped > 0
      ? `QDS ${funnel.qds} fail, ${funnel.qds_warning} warn, ${funnel.qds_skipped} skipped`
      : `QDS ${funnel.qds} fail, ${funnel.qds_warning} warn`;
  return [
    `Quality-GARP: 0 matches (${funnel.candidates_pe_pb} PE/PB candidates${scopeLabel}).`,
    `Pre-RSI eliminations: valuation ${funnel.valuation}, 3yr ROE ${funnel.roe_3yr},`,
    `ROCE ${funnel.roce}, D/E ${funnel.debt}, PEG null ${funnel.peg_null}, PEG fail ${funnel.peg}.`,
    `Technical: RSI ${funnel.rsi}, SMA50 ${funnel.sma50}, promoter ${funnel.promoter}, pledge ${funnel.pledge} (${funnel.pledge_shadow} shadow), ${opmSummary}.`,
    `QDS: ${qdsSummary}.`,
    `Passed all gates: ${funnel.passed} (pre-RSI survivors: ${preRsi}).`,
  ].join(' ');
}
