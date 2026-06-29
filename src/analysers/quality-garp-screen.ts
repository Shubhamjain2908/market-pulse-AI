import type { Database as DatabaseType } from 'better-sqlite3';
import { getSizeMultiplier, isStrategyAllowed } from '../db/index.js';
import {
  getQualityGarpFundamentals,
  getTrailingOpmStdDev,
  upsertScreenResults,
} from '../db/queries.js';
import type { ScreenResult } from '../types/domain.js';
import type { Regime } from '../types/regime.js';
import type { ScreenEngineResult } from './engine.js';
import {
  createEmptyQualityGarpFunnel,
  OPM_STD_DEV_MAX_PCT,
  persistQualityGarpFunnel,
  QUALITY_GARP_DE_MAX,
  QUALITY_GARP_PB_MAX,
  QUALITY_GARP_PE_MAX,
  QUALITY_GARP_PEG_MAX,
  QUALITY_GARP_ROCE_MIN,
  QUALITY_GARP_ROE_MIN,
  QUALITY_GARP_RSI_MAX,
  QUALITY_GARP_SCREEN,
  QUALITY_GARP_SMA50_PCT_MAX,
  QUALITY_GARP_TOTAL_GATES,
  type QualityGarpFailGate,
  type QualityGarpFunnelCounts,
  recordQualityGarpFunnelFailure,
  resolveQualityGarpSymbols,
} from './quality-garp.js';
import type { SignalProvider } from './signal-provider.js';

interface QualityGarpMatchedCriteria {
  [key: string]: unknown;
  latest_roe: number;
  prev_roe: number;
  third_roe: number;
  latest_roce: number;
  latest_rev_growth: number | null;
  pe: number;
  pb: number;
  peg: number;
  debt_to_equity: number;
  market_cap: number | null;
  promoter_holding_pct: number | null;
  promoter_holding_change_qoq: number | null;
  rsi_14: number;
  sma_50: number;
  close: number;
  pct_from_sma50: number;
  opm_std_dev: number | null;
}

interface QualityGarpEvaluation {
  passed: boolean;
  score: number;
  matchedCount: number;
  failedGate?: QualityGarpFailGate;
  matchedCriteria?: QualityGarpMatchedCriteria;
}

export function runQualityGarpScreen(
  opts: {
    date: string;
    symbols?: string[];
    provider: SignalProvider;
    persist: boolean;
    regime?: Regime;
    etfExclusions: Set<string>;
    pointInTimeFundamentals?: boolean;
  },
  db: DatabaseType,
): {
  matches: number;
  partial: number;
  funnel: QualityGarpFunnelCounts;
  evaluations: ScreenEngineResult['evaluations'];
} {
  const { date, provider, persist, regime, etfExclusions, pointInTimeFundamentals } = opts;
  const qualityUniverse = resolveQualityGarpSymbols(db, opts.symbols);
  const symbols = qualityUniverse.symbols;
  const funnel = createEmptyQualityGarpFunnel();
  funnel.universe = symbols.length;

  if (regime != null && !isStrategyAllowed(QUALITY_GARP_SCREEN, regime, db)) {
    return { matches: 0, partial: 0, funnel, evaluations: [] };
  }

  const fundamentals = getQualityGarpFundamentals(date, db, {
    pointInTime: pointInTimeFundamentals === true,
  });
  const fundamentalsBySymbol = new Map(fundamentals.map((row) => [row.symbol.toUpperCase(), row]));

  const results: ScreenResult[] = [];
  const evaluations: ScreenEngineResult['evaluations'] = [];
  let matches = 0;

  for (const symbol of symbols) {
    const fundamental = fundamentalsBySymbol.get(symbol);
    if (fundamental?.pe != null && fundamental.pb != null) {
      funnel.candidates_pe_pb++;
    }

    const opmStdDev = getTrailingOpmStdDev(symbol, date, 4, db);
    const evaluation = evaluateQualityGarpSymbol(
      symbol,
      date,
      fundamental,
      provider,
      etfExclusions,
      opmStdDev,
    );
    const totalCriteria = QUALITY_GARP_TOTAL_GATES;

    if (evaluation.passed) {
      funnel.passed++;
    } else if (evaluation.failedGate) {
      recordQualityGarpFunnelFailure(funnel, evaluation.failedGate);
    }

    evaluations.push({
      symbol,
      date,
      screenName: QUALITY_GARP_SCREEN,
      criteria: [],
      matchedCount: evaluation.matchedCount,
      totalCriteria,
      score: evaluation.score,
      passed: evaluation.passed,
    });

    if (!evaluation.passed || !evaluation.matchedCriteria) continue;
    matches++;
    const matchedCriteria =
      regime == null
        ? evaluation.matchedCriteria
        : {
            ...evaluation.matchedCriteria,
            __regime_meta: {
              regime,
              sizeMultiplier: getSizeMultiplier(QUALITY_GARP_SCREEN, regime, db),
              strategyId: QUALITY_GARP_SCREEN,
            },
          };

    results.push({
      symbol,
      date,
      screenName: QUALITY_GARP_SCREEN,
      score: 1,
      matchedCriteria,
    });
  }

  if (persist) {
    upsertScreenResults(results, db);
  }

  if (persist && pointInTimeFundamentals !== true) {
    persistQualityGarpFunnel({
      date,
      screen: QUALITY_GARP_SCREEN,
      matches,
      universe_scope: qualityUniverse.universeScope,
      regime,
      funnel,
      recordedAt: new Date().toISOString(),
    });
  }

  return {
    matches,
    partial: 0,
    funnel,
    evaluations,
  };
}

function gateScore(matchedCount: number): number {
  return matchedCount / QUALITY_GARP_TOTAL_GATES;
}

function evaluateQualityGarpSymbol(
  symbol: string,
  date: string,
  fundamentals: ReturnType<typeof getQualityGarpFundamentals>[number] | undefined,
  provider: SignalProvider,
  etfExclusions: Set<string>,
  opmStdDev: number | null,
): QualityGarpEvaluation {
  let matchedCount = 0;

  if (etfExclusions.has(symbol)) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'etf_exclusion',
    };
  }
  matchedCount++;

  if (!fundamentals) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'no_fundamentals',
    };
  }

  if (fundamentals.pe == null || fundamentals.pb == null) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'valuation_null',
    };
  }
  matchedCount++;

  if (fundamentals.pe > QUALITY_GARP_PE_MAX || fundamentals.pb > QUALITY_GARP_PB_MAX) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'valuation',
    };
  }
  matchedCount++;

  if (
    fundamentals.latestRoe == null ||
    fundamentals.prevRoe == null ||
    fundamentals.thirdRoe == null ||
    fundamentals.latestRoe < QUALITY_GARP_ROE_MIN ||
    fundamentals.prevRoe < QUALITY_GARP_ROE_MIN ||
    fundamentals.thirdRoe < QUALITY_GARP_ROE_MIN
  ) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'roe_3yr',
    };
  }
  matchedCount++;

  if (fundamentals.latestRoce == null || fundamentals.latestRoce < QUALITY_GARP_ROCE_MIN) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'roce',
    };
  }
  matchedCount++;

  if (fundamentals.debtToEquity == null || fundamentals.debtToEquity >= QUALITY_GARP_DE_MAX) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'debt',
    };
  }
  matchedCount++;

  if (fundamentals.peg == null) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'peg_null',
    };
  }
  if (fundamentals.peg >= QUALITY_GARP_PEG_MAX) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'peg',
    };
  }
  matchedCount++;

  const rsi14 = provider.get(symbol, date, 'rsi_14');
  if (rsi14 == null || rsi14 >= QUALITY_GARP_RSI_MAX) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'rsi',
    };
  }
  matchedCount++;

  const sma50 = provider.get(symbol, date, 'sma_50');
  const close = provider.get(symbol, date, 'close');
  if (sma50 == null || close == null || sma50 === 0) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'sma50',
    };
  }
  const pctFromSma50 = Math.abs(((close - sma50) / sma50) * 100);
  if (pctFromSma50 > QUALITY_GARP_SMA50_PCT_MAX) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'sma50',
    };
  }
  matchedCount++;

  if (fundamentals.promoterHoldingChangeQoQ != null && fundamentals.promoterHoldingChangeQoQ < 0) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'promoter',
    };
  }
  matchedCount++;

  if (opmStdDev !== null && opmStdDev > OPM_STD_DEV_MAX_PCT) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'opm_stability',
    };
  }
  matchedCount++;

  return {
    passed: true,
    score: gateScore(matchedCount),
    matchedCount,
    matchedCriteria: {
      latest_roe: fundamentals.latestRoe,
      prev_roe: fundamentals.prevRoe,
      third_roe: fundamentals.thirdRoe,
      latest_roce: fundamentals.latestRoce,
      latest_rev_growth: fundamentals.latestRevGrowth,
      pe: fundamentals.pe,
      pb: fundamentals.pb,
      peg: fundamentals.peg,
      debt_to_equity: fundamentals.debtToEquity,
      market_cap: fundamentals.marketCap,
      promoter_holding_pct: fundamentals.promoterHoldingPct,
      promoter_holding_change_qoq: fundamentals.promoterHoldingChangeQoQ,
      rsi_14: rsi14,
      sma_50: sma50,
      close,
      pct_from_sma50: pctFromSma50,
      opm_std_dev: opmStdDev,
    },
  };
}
