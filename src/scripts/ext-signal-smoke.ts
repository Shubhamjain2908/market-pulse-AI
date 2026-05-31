/**
 * Live smoke test: sync portfolio → ext-signal holdings ingest → overlap report.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { type PortfolioSyncResult, runPortfolioSync } from '../agents/portfolio-sync.js';
import { loadExtSignalProvider } from '../config/loaders.js';
import { getDb, getLatestHoldings } from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import {
  type ExtSignalIngestResult,
  runExtSignalHoldingsIngestor,
} from '../ingestors/ext-signal-holdings-ingestor.js';

export interface ExtSignalSmokeOptions {
  date?: string;
  /** Use latest `portfolio_holdings` snapshot without running sync. */
  skipPortfolioSync?: boolean;
  db?: DatabaseType;
}

export interface ExtSignalPortfolioMatch {
  symbol: string;
  qty: number;
  lastPrice: number | null;
  strategies: Array<{
    strategyName: string;
    displayName: string;
    weightPct: number;
  }>;
  thesisContextPreview: string | null;
}

export interface ExtSignalSmokeResult {
  date: string;
  portfolio: PortfolioSyncResult | { source: 'db_snapshot'; holdingsCount: number; date: string };
  ingest: ExtSignalIngestResult;
  configuredStrategies: Array<{ name: string; displayName: string }>;
  strategyHoldings: Array<{
    strategyName: string;
    displayName: string;
    positionCount: number;
    symbols: string[];
  }>;
  portfolioMatches: ExtSignalPortfolioMatch[];
  portfolioSymbolsWithoutSignal: string[];
  signalSymbolsNotInPortfolio: string[];
}

function formatThesisContextPreview(
  asOf: string,
  strategies: Array<{ displayName: string; weightPct: number }>,
): string {
  const lines = strategies.map((s) => `${s.displayName} (${s.weightPct.toFixed(1)}% weight)`);
  return [
    '## External signal (corroborating only)',
    `This symbol appears in the following external model portfolios as of ${asOf}: ${lines.join(', ')}.`,
    'Treat as weak corroboration only — not a primary thesis input.',
    'Do not reference or name the signal source in the thesis output.',
  ].join('\n');
}

export async function runExtSignalSmoke(
  opts: ExtSignalSmokeOptions = {},
): Promise<ExtSignalSmokeResult> {
  const date = opts.date ?? isoDateIst();
  const db = opts.db ?? getDb();
  const providerConfig = loadExtSignalProvider();

  const portfolio = opts.skipPortfolioSync
    ? {
        source: 'db_snapshot' as const,
        holdingsCount: getLatestHoldings(db).length,
        date,
      }
    : await runPortfolioSync({ date });

  const ingest = await runExtSignalHoldingsIngestor(db);
  const asOf = ingest.asOf;

  const strategyHoldings = db
    .prepare(
      `
    SELECT strategy_name, symbol, weight_pct
    FROM ext_signal_holdings
    WHERE as_of = ?
    ORDER BY strategy_name, weight_pct DESC
  `,
    )
    .all(asOf) as Array<{ strategy_name: string; symbol: string; weight_pct: number }>;

  const byStrategy = new Map<string, Array<{ symbol: string; weight_pct: number }>>();
  for (const row of strategyHoldings) {
    const list = byStrategy.get(row.strategy_name) ?? [];
    list.push({ symbol: row.symbol, weight_pct: row.weight_pct });
    byStrategy.set(row.strategy_name, list);
  }

  const strategySummaries = providerConfig.strategies.map((s) => {
    const positions = byStrategy.get(s.name) ?? [];
    return {
      strategyName: s.name,
      displayName: s.display_name,
      positionCount: positions.length,
      symbols: positions.map((p) => p.symbol),
    };
  });

  const signalBySymbol = new Map<
    string,
    Array<{ strategyName: string; displayName: string; weightPct: number }>
  >();
  for (const row of strategyHoldings) {
    const strat = providerConfig.strategies.find((s) => s.name === row.strategy_name);
    const entry = {
      strategyName: row.strategy_name,
      displayName: strat?.display_name ?? row.strategy_name,
      weightPct: row.weight_pct,
    };
    const list = signalBySymbol.get(row.symbol) ?? [];
    list.push(entry);
    signalBySymbol.set(row.symbol, list);
  }

  const holdings = getLatestHoldings(db);
  const portfolioSymbols = new Set(holdings.map((h) => h.symbol.toUpperCase()));

  const portfolioMatches: ExtSignalPortfolioMatch[] = [];
  for (const h of holdings) {
    const symbol = h.symbol.toUpperCase();
    const strategies = signalBySymbol.get(symbol) ?? [];
    if (strategies.length === 0) continue;
    portfolioMatches.push({
      symbol,
      qty: h.qty,
      lastPrice: h.lastPrice ?? null,
      strategies,
      thesisContextPreview: formatThesisContextPreview(
        asOf,
        strategies.map((s) => ({ displayName: s.displayName, weightPct: s.weightPct })),
      ),
    });
  }
  portfolioMatches.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const portfolioSymbolsWithoutSignal = holdings
    .map((h) => h.symbol.toUpperCase())
    .filter((sym) => !signalBySymbol.has(sym))
    .sort((a, b) => a.localeCompare(b));

  const signalSymbolsNotInPortfolio = [...signalBySymbol.keys()]
    .filter((sym) => !portfolioSymbols.has(sym))
    .sort((a, b) => a.localeCompare(b));

  return {
    date,
    portfolio,
    ingest,
    configuredStrategies: providerConfig.strategies.map((s) => ({
      name: s.name,
      displayName: s.display_name,
    })),
    strategyHoldings: strategySummaries,
    portfolioMatches,
    portfolioSymbolsWithoutSignal,
    signalSymbolsNotInPortfolio,
  };
}
