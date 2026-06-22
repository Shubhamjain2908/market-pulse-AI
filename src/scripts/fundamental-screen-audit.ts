/**
 * Audit why fundamental screens (quality_at_value, dividend_compounder) rarely fire:
 * per-criterion pass rates on watchlist + full fundamentals universe.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { runScreenEngine } from '../analysers/engine.js';
import { evaluateCriterion } from '../analysers/evaluator.js';
import { DbSignalProvider } from '../analysers/signal-provider.js';
import { loadScreens, loadWatchlist } from '../config/loaders.js';
import { getDb } from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { lastOpenOnOrBefore } from '../market/trading-days.js';
import type { ScreenDefinition } from '../types/domain.js';

const AUDIT_SCREENS = ['quality_at_value', 'dividend_compounder'] as const;

export interface CriterionPassRate {
  signal: string;
  op: string;
  threshold: number | [number, number];
  passCount: number;
  universe: number;
  missingCount: number;
}

export interface ScreenAuditRow {
  screenName: string;
  universe: number;
  fullPassCount: number;
  bottleneck: string | null;
  criteria: CriterionPassRate[];
}

export interface FundamentalScreenAuditResult {
  sessionDate: string;
  watchlistSize: number;
  fundamentalsUniverse: number;
  roeUnitSkew: { fractionScale: number; percentScale: number };
  watchlist: ScreenAuditRow[];
  fundamentals: ScreenAuditRow[];
  engineMatches: Record<string, number>;
}

function auditScreenForSymbols(
  screen: ScreenDefinition,
  symbols: string[],
  date: string,
  provider: DbSignalProvider,
): ScreenAuditRow {
  const criteriaStats: CriterionPassRate[] = screen.criteria.map((c) => ({
    signal: c.signal,
    op: c.op,
    threshold: c.value as number | [number, number],
    passCount: 0,
    universe: symbols.length,
    missingCount: 0,
  }));

  let fullPassCount = 0;
  for (const symbol of symbols) {
    let allPass = true;
    for (let i = 0; i < screen.criteria.length; i++) {
      const criterion = screen.criteria[i];
      const stat = criteriaStats[i];
      if (!criterion || !stat) continue;
      const ev = evaluateCriterion(criterion, symbol, date, provider);
      if (ev.lhs == null) {
        stat.missingCount++;
        allPass = false;
        continue;
      }
      if (ev.matched) stat.passCount++;
      else allPass = false;
    }
    if (allPass) fullPassCount++;
  }

  const bottleneck =
    criteriaStats
      .filter((c) => c.passCount < c.universe)
      .sort((a, b) => a.passCount - b.passCount)[0] ?? null;

  return {
    screenName: screen.name,
    universe: symbols.length,
    fullPassCount,
    bottleneck: bottleneck
      ? `${bottleneck.signal} ${bottleneck.op} ${JSON.stringify(bottleneck.threshold)} (${bottleneck.passCount}/${bottleneck.universe} pass, ${bottleneck.missingCount} missing)`
      : null,
    criteria: criteriaStats,
  };
}

function loadFundamentalsSymbols(db: DatabaseType): string[] {
  const rows = db
    .prepare(
      `
    SELECT DISTINCT symbol FROM fundamentals
    ORDER BY symbol
  `,
    )
    .all() as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol.toUpperCase());
}

function countRoeUnitSkew(db: DatabaseType): { fractionScale: number; percentScale: number } {
  const rows = db
    .prepare(
      `
    SELECT f.roe FROM fundamentals f
    INNER JOIN (
      SELECT symbol, MAX(as_of) AS max_as_of FROM fundamentals GROUP BY symbol
    ) m ON f.symbol = m.symbol AND f.as_of = m.max_as_of
    WHERE f.roe IS NOT NULL
  `,
    )
    .all() as Array<{ roe: number }>;
  let fractionScale = 0;
  let percentScale = 0;
  for (const r of rows) {
    if (Math.abs(r.roe) > 0 && Math.abs(r.roe) < 1) fractionScale++;
    else percentScale++;
  }
  return { fractionScale, percentScale };
}

export function runFundamentalScreenAudit(
  opts: { date?: string; db?: DatabaseType } = {},
): FundamentalScreenAuditResult {
  const db = opts.db ?? getDb();
  const calendarDate = opts.date ?? isoDateIst();
  const sessionDate = lastOpenOnOrBefore(calendarDate) ?? calendarDate;
  const provider = new DbSignalProvider(db);
  const watchlist = loadWatchlist().symbols.map((s) => s.toUpperCase());
  const fundamentalsSymbols = loadFundamentalsSymbols(db);
  const screens = loadScreens().filter((s) =>
    (AUDIT_SCREENS as readonly string[]).includes(s.name),
  );

  const engine = runScreenEngine(
    {
      date: sessionDate,
      symbols: watchlist,
      screens,
      persist: false,
    },
    db,
  );

  return {
    sessionDate,
    watchlistSize: watchlist.length,
    fundamentalsUniverse: fundamentalsSymbols.length,
    roeUnitSkew: countRoeUnitSkew(db),
    watchlist: screens.map((s) => auditScreenForSymbols(s, watchlist, sessionDate, provider)),
    fundamentals: screens.map((s) =>
      auditScreenForSymbols(s, fundamentalsSymbols, sessionDate, provider),
    ),
    engineMatches: engine.matchesByScreen,
  };
}
