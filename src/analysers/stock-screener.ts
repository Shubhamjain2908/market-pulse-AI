import type { Database as DatabaseType } from 'better-sqlite3';
import { loadEtfExclusions, loadScreens, loadWatchlist } from '../config/loaders.js';
import {
  getDb,
  getDistinctOpenPaperTradeSymbols,
  getLatestHoldings,
  getSizeMultiplier,
  isStrategyAllowed,
} from '../db/index.js';
import { getQualityGarpFundamentals, upsertScreenResults } from '../db/queries.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { child } from '../logger.js';
import type { ScreenDefinition, ScreenResult } from '../types/domain.js';
import type { Regime } from '../types/regime.js';
import { runCatalystScreener } from './catalyst-screener.js';
import type { ScreenEngineResult } from './engine.js';
import { runScreenEngine } from './engine.js';
import {
  createEmptyQualityGarpFunnel,
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
  type QualityGarpUniverseScope,
  recordQualityGarpFunnelFailure,
  resolveQualityGarpSymbols,
} from './quality-garp.js';
import { DbSignalProvider, type SignalProvider } from './signal-provider.js';

const log = child({ component: 'stock-screener-analyser' });
const CATALYST_ENTRY_SCREEN = 'catalyst_entry';

export interface StockScreenerOptions {
  date?: string;
  symbols?: string[];
  screens?: ScreenDefinition[];
  onlyScreen?: string;
  provider?: SignalProvider;
  persist?: boolean;
  regime?: Regime;
  /** Backtest replay: fundamentals as_of <= screen date. Live paths omit this. */
  pointInTimeFundamentals?: boolean;
}

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
}

interface QualityGarpEvaluation {
  passed: boolean;
  score: number;
  matchedCount: number;
  failedGate?: QualityGarpFailGate;
  matchedCriteria?: QualityGarpMatchedCriteria;
}

export function runStockScreenAnalyser(
  opts: StockScreenerOptions = {},
  db: DatabaseType = getDb(),
): ScreenEngineResult {
  const date = opts.date ?? isoDateIst();
  const symbols = (opts.symbols ?? loadWatchlist().symbols).map((s) => s.toUpperCase());
  let screens = opts.screens ?? loadScreens();

  if (opts.onlyScreen) {
    screens = screens.filter((s) => s.name === opts.onlyScreen);
    if (screens.length === 0) {
      throw new Error(`No screen named "${opts.onlyScreen}" found in config/screens.json`);
    }
  }

  const provider = opts.provider ?? new DbSignalProvider(db);
  const persist = opts.persist ?? true;
  const etfExclusions = new Set(loadEtfExclusions().map((s) => s.toUpperCase()));
  const alreadyOwned = new Set([
    ...getLatestHoldings(db).map((h) => h.symbol.toUpperCase()),
    ...getDistinctOpenPaperTradeSymbols(db).map((s) => s.toUpperCase()),
  ]);

  const qualityScreen = screens.find((s) => s.name === QUALITY_GARP_SCREEN);
  const catalystScreen = screens.find((s) => s.name === CATALYST_ENTRY_SCREEN);
  const dslScreens = screens.filter(
    (s) => s.name !== QUALITY_GARP_SCREEN && s.name !== CATALYST_ENTRY_SCREEN,
  );

  const matchesByScreen: Record<string, number> = {};
  const partialByScreen: Record<string, number> = {};
  const funnelByScreen: Record<string, QualityGarpFunnelCounts> = {};
  const evaluations = [];
  const screensApplied: string[] = [];

  if (dslScreens.length > 0) {
    const dslResult = runScreenEngine(
      {
        date,
        symbols,
        screens: dslScreens,
        provider,
        persist,
        regime: opts.regime,
      },
      db,
    );
    Object.assign(matchesByScreen, dslResult.matchesByScreen);
    Object.assign(partialByScreen, dslResult.partialByScreen);
    evaluations.push(...dslResult.evaluations);
    screensApplied.push(...dslResult.screensApplied);
  }

  if (qualityScreen) {
    const qualityUniverse = resolveQualityGarpSymbols(db, opts.symbols);
    const qualityResult = runQualityGarpScreen(
      {
        date,
        symbols: qualityUniverse.symbols,
        universeScope: qualityUniverse.universeScope,
        provider,
        persist,
        regime: opts.regime,
        etfExclusions,
        alreadyOwned,
        pointInTimeFundamentals: opts.pointInTimeFundamentals,
      },
      db,
    );
    matchesByScreen[QUALITY_GARP_SCREEN] = qualityResult.matches;
    partialByScreen[QUALITY_GARP_SCREEN] = qualityResult.partial;
    funnelByScreen[QUALITY_GARP_SCREEN] = qualityResult.funnel;
    evaluations.push(...qualityResult.evaluations);
    screensApplied.push(QUALITY_GARP_SCREEN);
  }

  if (catalystScreen) {
    const catalystResult = runCatalystEntryScreen(
      {
        date,
        persist,
        regime: opts.regime,
        etfExclusions,
        alreadyOwned,
      },
      db,
    );
    matchesByScreen[CATALYST_ENTRY_SCREEN] = catalystResult.matches;
    partialByScreen[CATALYST_ENTRY_SCREEN] = catalystResult.partial;
    evaluations.push(...catalystResult.evaluations);
    screensApplied.push(CATALYST_ENTRY_SCREEN);
  }

  return {
    date,
    screensApplied,
    matchesByScreen,
    partialByScreen,
    funnelByScreen: Object.keys(funnelByScreen).length > 0 ? funnelByScreen : undefined,
    evaluations,
  };
}

function runQualityGarpScreen(
  opts: {
    date: string;
    symbols: string[];
    universeScope: QualityGarpUniverseScope;
    provider: SignalProvider;
    persist: boolean;
    regime?: Regime;
    etfExclusions: Set<string>;
    alreadyOwned: Set<string>;
    pointInTimeFundamentals?: boolean;
  },
  db: DatabaseType,
): {
  matches: number;
  partial: number;
  funnel: QualityGarpFunnelCounts;
  evaluations: ScreenEngineResult['evaluations'];
} {
  const {
    date,
    symbols,
    universeScope,
    provider,
    persist,
    regime,
    etfExclusions,
    pointInTimeFundamentals,
  } = opts;
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

    const evaluation = evaluateQualityGarpSymbol(
      symbol,
      date,
      fundamental,
      provider,
      etfExclusions,
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
      universe_scope: universeScope,
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

function runCatalystEntryScreen(
  opts: {
    date: string;
    persist: boolean;
    regime?: Regime;
    etfExclusions: Set<string>;
    alreadyOwned: Set<string>;
  },
  db: DatabaseType,
): { matches: number; partial: number; evaluations: ScreenEngineResult['evaluations'] } {
  const { date, persist, regime, etfExclusions, alreadyOwned } = opts;

  if (regime != null && !isStrategyAllowed(CATALYST_ENTRY_SCREEN, regime, db)) {
    log.info({ screen: CATALYST_ENTRY_SCREEN, regime }, 'catalyst_entry gated by regime');
    return { matches: 0, partial: 0, evaluations: [] };
  }

  // IMPORTANT: `date` is derived upstream from isoDateIst() and passed through unchanged.
  const candidates = runCatalystScreener(db, date, alreadyOwned, etfExclusions);
  const evaluations: ScreenEngineResult['evaluations'] = candidates.map((candidate) => ({
    symbol: candidate.symbol,
    date,
    screenName: CATALYST_ENTRY_SCREEN,
    criteria: [],
    matchedCount: 1,
    totalCriteria: 1,
    score: 1,
    passed: true,
  }));
  const results: ScreenResult[] = candidates.map((candidate) => {
    const matchedCriteria =
      regime == null
        ? { ...candidate }
        : {
            ...candidate,
            __regime_meta: {
              regime,
              sizeMultiplier: getSizeMultiplier(CATALYST_ENTRY_SCREEN, regime, db),
              strategyId: CATALYST_ENTRY_SCREEN,
            },
          };
    return {
      symbol: candidate.symbol,
      date,
      screenName: CATALYST_ENTRY_SCREEN,
      score: 1,
      matchedCriteria,
    };
  });

  if (persist) {
    upsertScreenResults(results, db);
  }

  return { matches: results.length, partial: 0, evaluations };
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
): QualityGarpEvaluation {
  let matchedCount = 0;

  // Gate 1: ETF/SGB exclusion list
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

  // Gate 2: hard valuation null guard
  if (fundamentals.pe == null || fundamentals.pb == null) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'valuation_null',
    };
  }
  matchedCount++;

  // Gate 3: valuation ceilings
  if (fundamentals.pe > QUALITY_GARP_PE_MAX || fundamentals.pb > QUALITY_GARP_PB_MAX) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'valuation',
    };
  }
  matchedCount++;

  // Gate 4: 3-year ROE floor (yahoo_annual decimals)
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

  // Gate 5: ROCE quality floor
  if (fundamentals.latestRoce == null || fundamentals.latestRoce < QUALITY_GARP_ROCE_MIN) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'roce',
    };
  }
  matchedCount++;

  // Gate 6: conservative leverage
  if (fundamentals.debtToEquity == null || fundamentals.debtToEquity >= QUALITY_GARP_DE_MAX) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'debt',
    };
  }
  matchedCount++;

  // Gate 7: growth at reasonable price
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

  // Gate 8: technical dip via RSI
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

  // Gate 9: within 5% of SMA50
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

  // Gate 10: fail-open on NULL promoter change; block only active selling
  if (fundamentals.promoterHoldingChangeQoQ != null && fundamentals.promoterHoldingChangeQoQ < 0) {
    return {
      passed: false,
      score: gateScore(matchedCount),
      matchedCount,
      failedGate: 'promoter',
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
    },
  };
}
