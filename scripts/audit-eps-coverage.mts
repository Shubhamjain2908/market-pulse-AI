/**
 * EPS coverage audit + cross-sectional diagnostic (PR #131).
 *
 * Validates whether `quarterly_fundamentals.eps` improves on the current
 * `profit_growth_yoy` proxy (Factor 2) for momentum ranking.
 *
 * Tests:
 *   1. Coverage: % of momentum-universe symbols with ≥4 quarters of EPS.
 *   2. QoQ EPS growth rates vs annual/snapshot profit_growth_yoy.
 *   3. Week-over-week variation: for last 12 rebalance dates, % of weeks
 *      where profit_growth_yoy is identical to the prior week vs quarterly-
 *      derived growth changing.
 *   4. Staleness ceiling documentation.
 *
 * Gate: coverage <50% of momentum-universe → halt and document.
 *
 * Usage: pnpm exec tsx scripts/audit-eps-coverage.mts
 *        pnpm exec tsx scripts/audit-eps-coverage.mts --as-of 2026-06-30
 */

import { parseArgs } from 'node:util';
import { getMomentumUniverseSymbols } from '../src/config/loaders.js';
import { closeDb, getDb, migrate } from '../src/db/index.js';
import { child } from '../src/logger.js';
import { argvForCliParseArgs } from './argv-for-cli.js';

const log = child({ component: 'audit-eps-coverage' });

interface EpsGrowthRecord {
  symbol: string;
  epsGrowthPct: number | null;
  profitGrowthYoy: number | null;
  latestQuarter: string | null;
}

interface WoWChange {
  symbol: string;
  totalWeeks: number;
  pgyStableWeeks: number;
  pgyChangeWeeks: number;
  pgyStablePct: number | null;
  epsChangeWeeks: number | null;
  epsChangePct: number | null;
}

migrate();
const db = getDb();

const { values } = parseArgs({
  args: argvForCliParseArgs(),
  options: {
    'as-of': { type: 'string' },
  },
});

const asOf =
  typeof values['as-of'] === 'string' ? values['as-of'] : new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// 1. Load momentum universe
// ---------------------------------------------------------------------------
const universe = [...new Set(getMomentumUniverseSymbols().map((s) => s.toUpperCase()))].sort();
log.info({ universeSize: universe.length }, 'momentum universe loaded');

if (universe.length === 0) {
  console.error('FATAL: empty momentum universe — check config/momentum-universe.json');
  closeDb();
  process.exit(1);
}

const ph = universe.map(() => '?').join(',');

// ---------------------------------------------------------------------------
// 2. Coverage statistics
// ---------------------------------------------------------------------------
const totalWithEps = db
  .prepare(
    `SELECT COUNT(DISTINCT symbol) AS c FROM quarterly_fundamentals
     WHERE eps IS NOT NULL AND symbol IN (${ph})`,
  )
  .all(...universe) as Array<{ c: number }>;

const symbolsWithEps = totalWithEps[0]?.c ?? 0;

const totalWith4Q = db
  .prepare(
    `SELECT COUNT(*) AS c FROM (
      SELECT symbol, COUNT(*) AS cnt FROM quarterly_fundamentals
      WHERE eps IS NOT NULL AND symbol IN (${ph})
      GROUP BY symbol HAVING cnt >= 4
    )`,
  )
  .all(...universe) as Array<{ c: number }>;

const symbolsWith4Q = totalWith4Q[0]?.c ?? 0;

const coverage = {
  universeSize: universe.length,
  symbolsWithEps,
  coveragePct:
    universe.length > 0 ? Number(((symbolsWithEps / universe.length) * 100).toFixed(1)) : 0,
  symbolsWith4QorMore: symbolsWith4Q,
  coverage4QPct:
    universe.length > 0 ? Number(((symbolsWith4Q / universe.length) * 100).toFixed(1)) : 0,
};

// Distribution of available EPS quarters
const quarterDist = db
  .prepare(
    `SELECT cnt, COUNT(*) AS symbols FROM (
      SELECT symbol, COUNT(*) AS cnt FROM quarterly_fundamentals
      WHERE eps IS NOT NULL AND symbol IN (${ph})
      GROUP BY symbol
    ) GROUP BY cnt ORDER BY cnt`,
  )
  .all(...universe) as Array<{ cnt: number; symbols: number }>;

// ---------------------------------------------------------------------------
// 3. QoQ EPS growth vs profit_growth_yoy
// ---------------------------------------------------------------------------

// Get latest quarterly EPS per symbol (T) and 4-quarters-ago EPS (T-4)
// to compute QoQ YoY growth: (eps_t - eps_t-4) / abs(eps_t-4)
const epsGrowthRows = db
  .prepare(
    `WITH RankedQ AS (
      SELECT symbol, eps, quarter_end,
        ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY quarter_end DESC) AS rn
      FROM quarterly_fundamentals
      WHERE eps IS NOT NULL AND symbol IN (${ph})
    ),
    LatestQ AS (
      SELECT symbol, eps AS eps_t, quarter_end AS latest_quarter
      FROM RankedQ WHERE rn = 1
    ),
    Q4 AS (
      SELECT symbol, eps AS eps_t4
      FROM RankedQ WHERE rn = 5
    )
    SELECT l.symbol, l.eps_t, l.latest_quarter, q.eps_t4
    FROM LatestQ l
    LEFT JOIN Q4 q ON l.symbol = q.symbol`,
  )
  .all(...universe) as Array<{
  symbol: string;
  eps_t: number;
  latest_quarter: string;
  eps_t4: number | null;
}>;

// Get latest profit_growth_yoy per symbol
const pgyRows = db
  .prepare(
    `SELECT symbol, profit_growth_yoy AS profitGrowthYoy
     FROM (
       SELECT symbol, profit_growth_yoy,
         ROW_NUMBER() OVER (
           PARTITION BY symbol
           ORDER BY as_of DESC,
             CASE source WHEN 'yahoo_snapshot' THEN 0 WHEN 'screener' THEN 1 ELSE 2 END
         ) AS rn
       FROM fundamentals
       WHERE source IN ('yahoo_snapshot', 'screener')
         AND profit_growth_yoy IS NOT NULL
         AND symbol IN (${ph})
     ) WHERE rn = 1`,
  )
  .all(...universe) as Array<{ symbol: string; profitGrowthYoy: number }>;

const pgyMap = new Map(pgyRows.map((r) => [r.symbol, r.profitGrowthYoy]));

const epsGrowthRecords: EpsGrowthRecord[] = [];
const epsGrowthValues: number[] = [];
const pgyValues: number[] = [];

for (const r of epsGrowthRows) {
  const growth =
    r.eps_t4 != null && Number.isFinite(r.eps_t4) && r.eps_t4 !== 0
      ? ((r.eps_t - r.eps_t4) / Math.abs(r.eps_t4)) * 100
      : null;

  const pgy = pgyMap.get(r.symbol) ?? null;

  epsGrowthRecords.push({
    symbol: r.symbol,
    epsGrowthPct: growth != null ? Number(growth.toFixed(2)) : null,
    profitGrowthYoy: pgy != null ? Number(pgy.toFixed(2)) : null,
    latestQuarter: r.latest_quarter,
  });

  if (growth != null && Number.isFinite(growth)) {
    epsGrowthValues.push(growth);
  }
  if (pgy != null && Number.isFinite(pgy)) {
    pgyValues.push(pgy);
  }
}

function statSummary(values: number[]): {
  n: number;
  mean: number | null;
  median: number | null;
  std: number | null;
  min: number;
  max: number;
} {
  if (values.length === 0) {
    return { n: 0, mean: null, median: null, std: null, min: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  // biome-ignore lint/style/noNonNullAssertion: guarded by values.length === 0 check above
  const midLo = sorted[Math.floor((n - 1) / 2)]!;
  // biome-ignore lint/style/noNonNullAssertion: guarded by values.length === 0 check above
  const midHi = sorted[Math.floor(n / 2)]!;
  const median = (midLo + midHi) / 2;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  // biome-ignore lint/style/noNonNullAssertion: guarded by values.length === 0 check above
  const first = sorted[0]!;
  // biome-ignore lint/style/noNonNullAssertion: guarded by values.length === 0 check above
  const last = sorted[n - 1]!;
  return {
    n,
    mean: Number(mean.toFixed(2)),
    median: Number(median.toFixed(2)),
    std: Number(std.toFixed(2)),
    min: Number(first.toFixed(2)),
    max: Number(last.toFixed(2)),
  };
}

const epsGrowthStats = statSummary(epsGrowthValues);
const pgyStats = statSummary(pgyValues);

// ---------------------------------------------------------------------------
// 4. Week-over-week variation test
//    For last 12 rebalance dates, compute how often profit_growth_yoy
//    stays identical vs quarterly-derived growth changes.
// ---------------------------------------------------------------------------

const rebalanceDates = db
  .prepare(
    `SELECT DISTINCT date FROM signals
     WHERE source = 'momentum_ranker' AND name = 'mom_composite_score'
     ORDER BY date DESC LIMIT 13`,
  )
  .all() as Array<{ date: string }>;

const rebalDates = rebalanceDates.map((r) => r.date);
// Use last 13 dates to get 12 week-over-week comparisons
const wowResults: WoWChange[] = [];

// For each symbol with EPS, check profit_growth_yoy and quarterly EPS
// across consecutive rebalance dates
if (rebalDates.length < 2) {
  log.warn({ datesFound: rebalDates.length }, 'insufficient rebalance dates for WoW test');
} else {
  for (const sym of universe) {
    let pgyStable = 0;
    let pgyChanges = 0;
    let epsChanges = 0;
    let epsComparable = 0;

    for (let i = 0; i < rebalDates.length - 1; i++) {
      const d1 = rebalDates[i];
      const d2 = rebalDates[i + 1];
      if (!d1 || !d2) continue;

      // profit_growth_yoy at each date
      const p1 = db
        .prepare(
          `SELECT profit_growth_yoy FROM fundamentals
         WHERE symbol = ? AND source IN ('yahoo_snapshot', 'screener')
           AND as_of <= ?
         ORDER BY as_of DESC LIMIT 1`,
        )
        .get(sym, d1) as { profit_growth_yoy: number } | undefined;

      const p2 = db
        .prepare(
          `SELECT profit_growth_yoy FROM fundamentals
         WHERE symbol = ? AND source IN ('yahoo_snapshot', 'screener')
           AND as_of <= ?
         ORDER BY as_of DESC LIMIT 1`,
        )
        .get(sym, d2) as { profit_growth_yoy: number } | undefined;

      const v1 = p1?.profit_growth_yoy;
      const v2 = p2?.profit_growth_yoy;

      if (v1 != null && v2 != null) {
        if (v1 === v2) {
          pgyStable++;
        } else {
          pgyChanges++;
        }
      }

      // Quarterly EPS-derived growth at each date
      const eq1 = db
        .prepare(
          `SELECT eps FROM quarterly_fundamentals
         WHERE symbol = ? AND eps IS NOT NULL AND quarter_end <= ?
         ORDER BY quarter_end DESC LIMIT 1`,
        )
        .get(sym, d1) as { eps: number } | undefined;

      const eq2 = db
        .prepare(
          `SELECT eps FROM quarterly_fundamentals
         WHERE symbol = ? AND eps IS NOT NULL AND quarter_end <= ?
         ORDER BY quarter_end DESC LIMIT 1`,
        )
        .get(sym, d2) as { eps: number } | undefined;

      const ev1 = eq1?.eps;
      const ev2 = eq2?.eps;

      if (ev1 != null && ev2 != null) {
        epsComparable++;
        if (ev1 !== ev2) {
          epsChanges++;
        }
      }
    }

    const totalPgy = pgyStable + pgyChanges;
    const totalEps = epsComparable;

    if (totalPgy > 0 || totalEps > 0) {
      wowResults.push({
        symbol: sym,
        totalWeeks: Math.max(totalPgy, totalEps),
        pgyStableWeeks: pgyStable,
        pgyChangeWeeks: pgyChanges,
        pgyStablePct: totalPgy > 0 ? Number(((pgyStable / totalPgy) * 100).toFixed(1)) : null,
        epsChangeWeeks: totalEps > 0 ? epsChanges : null,
        epsChangePct: totalEps > 0 ? Number(((epsChanges / totalEps) * 100).toFixed(1)) : null,
      });
    }
  }
}

// Aggregate WoW results
const symbolsWithPgyData = wowResults.filter((r) => r.totalWeeks > 0);
const symbolsWithEpsData = wowResults.filter((r) => r.epsChangeWeeks != null);

const avgPgyStablePct =
  symbolsWithPgyData.length > 0
    ? Number(
        (
          symbolsWithPgyData.reduce((s, r) => s + (r.pgyStablePct ?? 0), 0) /
          symbolsWithPgyData.length
        ).toFixed(1),
      )
    : null;

const avgEpsChangePct =
  symbolsWithEpsData.length > 0
    ? Number(
        (
          symbolsWithEpsData.reduce((s, r) => s + (r.epsChangePct ?? 0), 0) /
          symbolsWithEpsData.length
        ).toFixed(1),
      )
    : null;

const pgyStableDistribution = [
  { label: '0-25%', count: wowResults.filter((r) => (r.pgyStablePct ?? 0) < 25).length },
  {
    label: '25-50%',
    count: wowResults.filter((r) => (r.pgyStablePct ?? 0) >= 25 && (r.pgyStablePct ?? 0) < 50)
      .length,
  },
  {
    label: '50-75%',
    count: wowResults.filter((r) => (r.pgyStablePct ?? 0) >= 50 && (r.pgyStablePct ?? 0) < 75)
      .length,
  },
  { label: '75-100%', count: wowResults.filter((r) => (r.pgyStablePct ?? 0) >= 75).length },
];

// ---------------------------------------------------------------------------
// 5. Staleness ceiling documentation
// ---------------------------------------------------------------------------
const stalenessNote = [
  'KNOWN CEILING: Quarterly EPS data refreshes 4x/year regardless of source.',
  'A quarterly-cadence factor in a weekly rebalance fundamentally cannot',
  'deliver higher signal refresh frequency. The central architectural',
  'question is whether 4x/year EPS growth is more informative than the',
  'current annual/snapshot proxy. If quarterly data has the same staleness',
  'pattern (identical values across 8-12 consecutive weeks), the improvement',
  'is illusory regardless of source.',
  '',
  'RECOMMENDED FIX (beyond this audit):',
  '  1. Higher-frequency EPS proxy: TTM net profit / shares outstanding',
  '     using quarterly_fundamentals.net_profit, which refreshes quarterly',
  '     but smooths more slowly.',
  '  2. Alternative Factor 2 entirely: operating_profit growth or revenue',
  '     growth from quarterly_fundamentals, which may have different',
  '     cross-sectional properties.',
].join('\n');

// ---------------------------------------------------------------------------
// 6. Go/no-go gate
// ---------------------------------------------------------------------------
const coveragePass = coverage.coverage4QPct >= 50;
const epsSigmaGtPgy =
  epsGrowthStats.std != null && pgyStats.std != null ? epsGrowthStats.std > pgyStats.std : false;

const gate = {
  coverageThreshold: 50,
  coveragePass,
  epsSigmaVsPgySigma: {
    epsGrowthStd: epsGrowthStats.std,
    pgyStd: pgyStats.std,
    epsSigmaGtPgySigma: epsSigmaGtPgy,
    sigmaPass: epsSigmaGtPgy,
  },
  verdict: coveragePass && epsSigmaGtPgy ? 'PASS' : 'HALT',
};

// ---------------------------------------------------------------------------
// 7. Output
// ---------------------------------------------------------------------------
const output = {
  audit: 'EPS coverage + cross-sectional diagnostic (B-ENG-12)',
  asOf,
  coverage,
  quarterDistribution: quarterDist.map((r) => ({ quarters: r.cnt, symbols: r.symbols })),
  epsGrowthVsPgy: {
    epsGrowthQuarterly: epsGrowthStats,
    profitGrowthYoy: pgyStats,
    sampleSymbols: epsGrowthRecords.slice(0, 20).map((r) => ({
      symbol: r.symbol,
      epsGrowthPct: r.epsGrowthPct,
      profitGrowthYoy: r.profitGrowthYoy,
      latestQuarter: r.latestQuarter,
    })),
  },
  weekOverWeek: {
    rebalanceDatesInspected: rebalDates.length,
    weekComparisons: Math.max(0, rebalDates.length - 1),
    symbolsWithPgyData: symbolsWithPgyData.length,
    symbolsWithEpsData: symbolsWithEpsData.length,
    avgPgyStablePct,
    avgEpsChangePct,
    pgyStableDistribution,
    interpretation:
      avgPgyStablePct != null && avgPgyStablePct > 80
        ? 'HIGH STABILITY — profit_growth_yoy is near-constant between report cycles, confirming the original hypothesis.'
        : 'MODERATE STABILITY — profit_growth_yoy changes more frequently than expected.',
    epsVsPgyChange:
      avgEpsChangePct != null && avgPgyStablePct != null
        ? `Quarterly-derived EPS changes ${avgEpsChangePct}% of weeks vs profit_growth_yoy changes ${(100 - (avgPgyStablePct ?? 0)).toFixed(1)}% of weeks.`
        : 'Insufficient data to compare change frequencies.',
  },
  stalenessCeiling: stalenessNote,
  gate,
};

console.log(JSON.stringify(output, null, 2));

log.info({ gate: gate.verdict }, 'EPS audit complete');

closeDb();

if (gate.verdict === 'HALT') {
  console.error(
    `\nGATE: HALT — coverage=${coverage.coverage4QPct}% (threshold=50%), sigmaPass=${epsSigmaGtPgy}`,
  );
  process.exitCode = 1;
}
