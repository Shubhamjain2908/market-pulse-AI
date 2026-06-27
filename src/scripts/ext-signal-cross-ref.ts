/**
 * Cross-reference ext_signal_holdings vs watchlist, momentum ranks, portfolio, paper trades.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { loadExtSignalProvider, loadWatchlist } from '../config/loaders.js';
import { getDb, getLatestHoldings } from '../db/index.js';
import { getTopMomentumRankSnapshotForSession } from '../db/queries.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { lastOpenOnOrBefore } from '../market/trading-days.js';

export interface ExtSignalCrossRefOverlap {
  symbol: string;
  inWatchlist: boolean;
  momRank: number | null;
  inPortfolio: boolean;
  openPaperTrade: string | null;
  strategies: Array<{ strategyName: string; displayName: string; weightPct: number }>;
}

export interface ExtSignalCrossRefResult {
  asOf: string;
  sessionDate: string;
  configuredStrategies: string[];
  extSignalAsOf: string | null;
  overlapRows: ExtSignalCrossRefOverlap[];
  summary: {
    extSignalSymbols: number;
    watchlistHits: number;
    momentumTop15Hits: number;
    portfolioHits: number;
    openPaperHits: number;
    tripleOverlapMomExt: string[];
  };
}

export function runExtSignalCrossRef(
  opts: { date?: string; db?: DatabaseType } = {},
): ExtSignalCrossRefResult {
  const db = opts.db ?? getDb();
  const calendarDate = opts.date ?? isoDateIst();
  const sessionDate = lastOpenOnOrBefore(calendarDate) ?? calendarDate;
  const providerConfig = loadExtSignalProvider();
  const watchlist = new Set(loadWatchlist().symbols.map((s: string) => s.toUpperCase()));

  const momTop = getTopMomentumRankSnapshotForSession(sessionDate, 15, db);
  const momRankBySymbol = new Map(momTop.map((r) => [r.symbol, r.rank]));
  // if Sunday ranker hasn't written session rows yet, fall back to latest ≤ session
  if (momTop.length === 0) {
    const fallback = db
      .prepare(
        `
      SELECT symbol, value AS rank FROM signals s
      WHERE name = 'mom_rank' AND date = (
        SELECT MAX(date) FROM signals WHERE name = 'mom_rank' AND date <= ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM signals x
        WHERE x.symbol = s.symbol AND x.date = s.date
          AND x.name = 'mom_rank_excluded' AND x.value >= 1
      )
      ORDER BY value ASC, symbol ASC
      LIMIT 15
    `,
      )
      .all(sessionDate) as Array<{ symbol: string; rank: number }>;
    for (const r of fallback) {
      momRankBySymbol.set(r.symbol.toUpperCase(), r.rank);
    }
  }

  const portfolioSyms = new Set(getLatestHoldings(db).map((h) => h.symbol.toUpperCase()));

  const openPaper = db
    .prepare(
      `
    SELECT symbol, signal_type FROM paper_trades WHERE status = 'OPEN'
  `,
    )
    .all() as Array<{ symbol: string; signal_type: string }>;
  const paperBySymbol = new Map(openPaper.map((r) => [r.symbol.toUpperCase(), r.signal_type]));

  const latestAsOfRow = db.prepare(`SELECT MAX(as_of) AS asOf FROM ext_signal_holdings`).get() as {
    asOf: string | null;
  };
  const extAsOf = latestAsOfRow?.asOf ?? null;

  const holdings =
    extAsOf == null
      ? []
      : (db
          .prepare(
            `
      SELECT strategy_name, symbol, weight_pct
      FROM ext_signal_holdings
      WHERE as_of = ?
    `,
          )
          .all(extAsOf) as Array<{
          strategy_name: string;
          symbol: string;
          weight_pct: number;
        }>);

  const bySymbol = new Map<
    string,
    Array<{ strategyName: string; displayName: string; weightPct: number }>
  >();
  for (const row of holdings) {
    const sym = row.symbol.toUpperCase();
    const strat = providerConfig.strategies.find((s) => s.name === row.strategy_name);
    const list = bySymbol.get(sym) ?? [];
    list.push({
      strategyName: row.strategy_name,
      displayName: strat?.display_name ?? row.strategy_name,
      weightPct: row.weight_pct,
    });
    bySymbol.set(sym, list);
  }

  const allSymbols = new Set<string>([
    ...[...watchlist],
    ...[...momRankBySymbol.keys()],
    ...[...portfolioSyms],
    ...[...paperBySymbol.keys()],
    ...[...bySymbol.keys()],
  ]);

  const overlapRows: ExtSignalCrossRefOverlap[] = [...allSymbols]
    .sort((a, b) => a.localeCompare(b))
    .map((symbol) => ({
      symbol,
      inWatchlist: watchlist.has(symbol),
      momRank: momRankBySymbol.get(symbol) ?? null,
      inPortfolio: portfolioSyms.has(symbol),
      openPaperTrade: paperBySymbol.get(symbol) ?? null,
      strategies: bySymbol.get(symbol) ?? [],
    }));

  const extSymbols = [...bySymbol.keys()];
  const tripleOverlapMomExt = extSymbols.filter((s) => momRankBySymbol.has(s) && bySymbol.has(s));

  return {
    asOf: calendarDate,
    sessionDate,
    configuredStrategies: providerConfig.strategies.map((s) => s.name),
    extSignalAsOf: extAsOf,
    overlapRows,
    summary: {
      extSignalSymbols: extSymbols.length,
      watchlistHits: extSymbols.filter((s) => watchlist.has(s)).length,
      momentumTop15Hits: tripleOverlapMomExt.length,
      portfolioHits: extSymbols.filter((s) => portfolioSyms.has(s)).length,
      openPaperHits: extSymbols.filter((s) => paperBySymbol.has(s)).length,
      tripleOverlapMomExt: tripleOverlapMomExt.sort((a, b) => {
        const ra = momRankBySymbol.get(a) ?? 999;
        const rb = momRankBySymbol.get(b) ?? 999;
        return ra - rb;
      }),
    },
  };
}
