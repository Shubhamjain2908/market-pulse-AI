/**
 * Quality Decay Score (QDS) coverage audit — go/no-go gate for ITEM 2 gate threshold.
 *
 * Computes the 6-signal QDS for every symbol with ≥5 quarters of quarterly_fundamentals
 * data and prints the score distribution. Use the P10 of the distribution to set the
 * hard-block threshold for the QDS gate in quality_garp.
 *
 * Usage: pnpm tsx scripts/audit-qds-coverage.mts
 */

import { closeDb, getDb, migrate } from '../src/db/index.js';

migrate();
const db = getDb();

// ---------------------------------------------------------------------------
// 1. Load GARP universe (all symbols with yahoo_annual fundamentals)
// ---------------------------------------------------------------------------
const universe = (
  db
    .prepare(`SELECT DISTINCT symbol FROM fundamentals WHERE source = 'yahoo_annual'`)
    .pluck()
    .all() as string[]
)
  .map((s) => s.toUpperCase())
  .sort();

if (universe.length === 0) {
  console.error('FATAL: empty GARP universe');
  closeDb();
  process.exit(1);
}

const ph = universe.map(() => '?').join(',');

// ---------------------------------------------------------------------------
// 2. Quarter coverage: how many symbols have 0..N quarters
// ---------------------------------------------------------------------------
const qCounts = db
  .prepare(
    `SELECT symbol, COUNT(*) AS q FROM quarterly_fundamentals
     WHERE symbol IN (${ph})
     GROUP BY symbol
     ORDER BY q DESC`,
  )
  .all(...universe) as Array<{ symbol: string; q: number }>;

const qHistogram: Record<number, number> = {};
for (const r of qCounts) {
  qHistogram[r.q] = (qHistogram[r.q] ?? 0) + 1;
}
const with5Plus = qCounts.filter((r) => r.q >= 5).length;
const total = universe.length;

console.log(
  JSON.stringify(
    {
      audit: 'Quality Decay Score (QDS) coverage',
      universeSize: total,
      quarterCoverage: {
        with5Plus,
        coveragePct: Number(((with5Plus / total) * 100).toFixed(1)),
        histogram: Object.fromEntries(
          Object.entries(qHistogram).sort(([a], [b]) => Number(a) - Number(b)),
        ),
      },
    },
    null,
    2,
  ),
);

// ---------------------------------------------------------------------------
// 3. QDS computation for symbols with ≥5 quarters
// ---------------------------------------------------------------------------
const qdsRows = db
  .prepare(
    `SELECT symbol, quarter_end, net_profit, operating_cash_flow, opm_pct, revenue
     FROM quarterly_fundamentals
     WHERE symbol IN (${ph})
     ORDER BY symbol, quarter_end DESC`,
  )
  .all(...universe) as Array<{
  symbol: string;
  quarter_end: string;
  net_profit: number | null;
  operating_cash_flow: number | null;
  opm_pct: number | null;
  revenue: number | null;
}>;

// Group by symbol
const bySymbol = new Map<string, typeof qdsRows>();
for (const row of qdsRows) {
  const list = bySymbol.get(row.symbol) ?? [];
  list.push(row);
  bySymbol.set(row.symbol, list);
}

interface QdsResult {
  symbol: string;
  quarters: number;
  score: number;
  signals: {
    netProfitPositive: boolean;
    netProfitImproving: boolean;
    ocfPositive: boolean;
    ocfExceedsNetProfit: boolean;
    opmImproving: boolean;
    revenueImproving: boolean;
  };
}

const results: QdsResult[] = [];

for (const [symbol, rows] of bySymbol) {
  if (rows.length < 5) continue;
  const latest = rows[0];
  const yearAgo = rows[4];
  if (!latest || !yearAgo) continue;

  const netProfitPositive = latest.net_profit != null && latest.net_profit > 0;
  const netProfitImproving =
    latest.net_profit != null && yearAgo.net_profit != null
      ? latest.net_profit > yearAgo.net_profit
      : false;
  const ocfPositive = latest.operating_cash_flow != null && latest.operating_cash_flow > 0;
  const ocfExceedsNetProfit =
    latest.operating_cash_flow != null && latest.net_profit != null
      ? latest.operating_cash_flow > latest.net_profit
      : false;
  const opmImproving =
    latest.opm_pct != null && yearAgo.opm_pct != null ? latest.opm_pct > yearAgo.opm_pct : false;
  const revenueImproving =
    latest.revenue != null && yearAgo.revenue != null ? latest.revenue > yearAgo.revenue : false;

  const signals = {
    netProfitPositive,
    netProfitImproving,
    ocfPositive,
    ocfExceedsNetProfit,
    opmImproving,
    revenueImproving,
  };
  const score = Object.values(signals).filter(Boolean).length;

  results.push({ symbol, quarters: rows.length, score, signals });
}

// ---------------------------------------------------------------------------
// 4. Distribution output
// ---------------------------------------------------------------------------
const scoreDist: Record<number, number> = {};
for (let i = 0; i <= 6; i++) scoreDist[i] = 0;
for (const r of results) {
  scoreDist[r.score] = (scoreDist[r.score] ?? 0) + 1;
}

// Cumulative distribution for threshold selection
let cumulative = 0;
const cumulativeDist: Array<{ score: number; count: number; pct: string; cumulativePct: string }> =
  [];
for (let i = 0; i <= 6; i++) {
  cumulative += scoreDist[i] ?? 0;
  cumulativeDist.push({
    score: i,
    count: scoreDist[i] ?? 0,
    pct: Number((((scoreDist[i] ?? 0) / results.length) * 100).toFixed(1)).toString(),
    cumulativePct: Number(((cumulative / results.length) * 100).toFixed(1)).toString(),
  });
}

// Find P10 threshold
const p10Score = (() => {
  let cum = 0;
  for (let i = 0; i <= 6; i++) {
    cum += scoreDist[i] ?? 0;
    if (cum / results.length >= 0.1) return i;
  }
  return 0;
})();

// Bottom scorers (score ≤ 2)
const lowScorers = results
  .filter((r) => r.score <= 2)
  .sort((a, b) => a.score - b.score)
  .slice(0, 15)
  .map((r) => ({
    symbol: r.symbol,
    score: r.score,
    quarters: r.quarters,
    failedSignals: Object.entries(r.signals)
      .filter(([, v]) => !v)
      .map(([k]) => k),
  }));

// Top scorers (score = 6)
const topScorers = results
  .filter((r) => r.score === 6)
  .sort((a, b) => a.symbol.localeCompare(b.symbol))
  .slice(0, 10)
  .map((r) => ({ symbol: r.symbol, score: r.score, quarters: r.quarters }));

// Median and mean
const scores = results.map((r) => r.score).sort((a, b) => a - b);
const medianScore = scores[Math.floor(scores.length / 2)] ?? 0;
const meanScore = Number((scores.reduce((s, v) => s + v, 0) / scores.length).toFixed(2));

const output = {
  audit: 'Quality Decay Score (QDS) coverage',
  universeSize: total,
  quarterCoverage: {
    with5Plus,
    coveragePct: Number(((with5Plus / total) * 100).toFixed(1)),
    histogram: Object.fromEntries(
      Object.entries(qHistogram).sort(([a], [b]) => Number(a) - Number(b)),
    ),
  },
  qdsResults: {
    scored: results.length,
    distribution: scoreDist,
    cumulativeDistribution: cumulativeDist,
    median: medianScore,
    mean: meanScore,
    p10Score,
    thresholdRecommendation: `block at ≤ ${p10Score} (P10 of distribution)`,
  },
  examples: {
    lowScorers: lowScorers.length > 0 ? lowScorers : 'none — no symbols score ≤ 2',
    topScorers: topScorers.length > 0 ? topScorers : 'none — no symbols score 6',
  },
};

console.log(JSON.stringify(output, null, 2));

closeDb();
