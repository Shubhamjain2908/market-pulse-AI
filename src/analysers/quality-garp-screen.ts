import type { Database as DatabaseType } from 'better-sqlite3';
import { config } from '../config/env.js';
import { getSizeMultiplier, isStrategyAllowed } from '../db/index.js';
import {
  getPromoterPledgeSnapshot,
  getQualityDecayScore,
  getQualityGarpFundamentals,
  getTrailingOpmStdDev,
  replaceScreenResultsForDate,
} from '../db/queries.js';
import type { ScreenResult } from '../types/domain.js';
import type { Regime } from '../types/regime.js';
import type { ScreenEngineResult } from './engine.js';
import {
  createEmptyQualityGarpFunnel,
  type GarpThresholds,
  PROMOTER_PLEDGE_MAX_PCT,
  persistQualityGarpFunnel,
  QUALITY_GARP_SCREEN,
  QUALITY_GARP_TOTAL_GATES,
  type QualityGarpFailGate,
  type QualityGarpFunnelCounts,
  recordQualityGarpFunnelFailure,
  resolveGarpThresholds,
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
  pledge_pct: number | null;
  qds_score?: number;
  qds_warning?: boolean;
  qds_signals?: Record<string, boolean>;
  regime_thresholds?: {
    rsiMax: number;
    sma50PctMax: number;
    peMax: number;
    pegMax: number;
  };
}

interface QualityGarpEvaluation {
  passed: boolean;
  score: number;
  matchedCount: number;
  failedGate?: QualityGarpFailGate;
  matchedCriteria?: QualityGarpMatchedCriteria;
  pledgeGateSkipped?: boolean;
  pledgeShadowHit?: boolean;
  qdsSkipped?: boolean;
  qdsWarning?: boolean;
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
  const thresholds = resolveGarpThresholds(regime);
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
      db,
      regime,
      thresholds,
    );
    const totalCriteria = QUALITY_GARP_TOTAL_GATES;

    if (evaluation.passed) {
      funnel.passed++;
    } else if (evaluation.failedGate) {
      recordQualityGarpFunnelFailure(funnel, evaluation.failedGate);
    }

    // Track OPM skips (null std-dev = fewer than 4 quarters of data).
    // These symbols pass all non-OPM gates but were never evaluated on OPM.
    if (opmStdDev == null && !evaluation.failedGate) {
      funnel.opm_skipped++;
    }
    if (evaluation.pledgeGateSkipped && !evaluation.failedGate) {
      funnel.pledge_skipped++;
    }
    if (evaluation.pledgeShadowHit) {
      funnel.pledge_shadow++;
    }
    if (evaluation.qdsSkipped && !evaluation.failedGate) {
      funnel.qds_skipped++;
    }
    if (evaluation.qdsWarning) {
      funnel.qds_warning++;
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
    replaceScreenResultsForDate(results, date, QUALITY_GARP_SCREEN, db);
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
  db: DatabaseType,
  regime: Regime | undefined,
  thresholds: GarpThresholds,
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

  if (fundamentals.pe > thresholds.peMax || fundamentals.pb > thresholds.pbMax) {
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
    fundamentals.latestRoe < thresholds.roeMin ||
    fundamentals.prevRoe < thresholds.roeMin ||
    fundamentals.thirdRoe < thresholds.roeMin
  ) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'roe_3yr',
    };
  }
  matchedCount++;

  if (fundamentals.latestRoce == null || fundamentals.latestRoce < thresholds.roceMin) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'roce',
    };
  }
  matchedCount++;

  if (fundamentals.debtToEquity == null || fundamentals.debtToEquity >= thresholds.deMax) {
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
  if (fundamentals.peg >= thresholds.pegMax) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'peg',
    };
  }
  matchedCount++;

  const rsi14 = provider.get(symbol, date, 'rsi_14');
  if (rsi14 == null || rsi14 >= thresholds.rsiMax) {
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
  if (pctFromSma50 > thresholds.sma50PctMax) {
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

  const pledgePct = getPromoterPledgeSnapshot(symbol, date, db).latest?.pctSharesPledged ?? null;
  let pledgeGateSkipped = false;
  let pledgeShadowHit = false;

  if (pledgePct != null) {
    if (pledgePct > PROMOTER_PLEDGE_MAX_PCT) {
      if (config.QUALITY_GARP_PLEDGE_GATE === '1') {
        return {
          passed: false,
          score: gateScore(matchedCount),
          matchedCount,
          failedGate: 'pledge',
        };
      }
      pledgeShadowHit = true;
    }
    matchedCount++;
  } else {
    pledgeGateSkipped = true;
  }

  if (opmStdDev !== null) {
    if (opmStdDev > thresholds.opmStdDevMax) {
      return {
        passed: false,
        score: gateScore(matchedCount),
        matchedCount,
        failedGate: 'opm_stability',
      };
    }
    matchedCount++;
  }

  // Gate 13: Quality Decay Score
  // Bypass entirely in CRISIS (known deterioration is expected).
  let qdsScore: number | undefined;
  let evaluationQdsWarning = false;
  let qdsSignals: Record<string, boolean> | undefined;
  let qdsSkipped = false;

  if (regime !== 'CRISIS') {
    const qdsResult = getQualityDecayScore(symbol, date, db);
    if (qdsResult == null) {
      qdsSkipped = true; // fail-open: insufficient data
    } else if (qdsResult.score <= 3) {
      return {
        passed: false,
        score: gateScore(matchedCount),
        matchedCount,
        failedGate: 'qds',
      };
    } else {
      matchedCount++;
      qdsScore = qdsResult.score;
      qdsSignals = qdsResult.signals;
      if (qdsResult.score === 4) {
        evaluationQdsWarning = true;
      }
    }
  } else {
    qdsSkipped = true;
  }

  return {
    passed: true,
    score: gateScore(matchedCount),
    matchedCount,
    pledgeGateSkipped,
    pledgeShadowHit,
    qdsSkipped,
    qdsWarning: evaluationQdsWarning,
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
      pledge_pct: pledgePct,
      ...(qdsScore != null
        ? {
            qds_score: qdsScore,
            qds_warning: evaluationQdsWarning,
            qds_signals: qdsSignals,
          }
        : {}),
      regime_thresholds: {
        rsiMax: thresholds.rsiMax,
        sma50PctMax: thresholds.sma50PctMax,
        peMax: thresholds.peMax,
        pegMax: thresholds.pegMax,
      },
    },
  };
}
