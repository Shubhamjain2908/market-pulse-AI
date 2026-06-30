/**
 * EPS coverage audit — go/no-go gate for quarterly fundamentals Factor 2 upgrade.
 *
 * Gate: coverage <50% of momentum-universe → HALT (exit 1).
 *       quarterly-derived EPS σ < current profit_growth_yoy σ → HALT (exit 1).
 *
 * Usage: pnpm eps:audit-coverage
 */

import { getMomentumUniverseSymbols } from '../src/config/loaders.js';
import { closeDb, getDb, migrate } from '../src/db/index.js';
import { isoDateIst } from '../src/ingestors/base/dates.js';

migrate();
const db = getDb();
const asOf = isoDateIst();

// ---------------------------------------------------------------------------
// 1. Load momentum universe
// ---------------------------------------------------------------------------
const universe = [...new Set(getMomentumUniverseSymbols().map((s) => s.toUpperCase()))].sort();
if (universe.length === 0) {
  console.error('FATAL: empty momentum universe');
  closeDb();
  process.exit(1);
}
const ph = universe.map(() => '?').join(',');

// ---------------------------------------------------------------------------
// 2. Coverage: symbols with ≥4 quarters of EPS
// ---------------------------------------------------------------------------
const coverageRow = db
  .prepare(
    `SELECT COUNT(*) AS c FROM (
      SELECT symbol FROM quarterly_fundamentals
      WHERE eps IS NOT NULL AND symbol IN (${ph})
      GROUP BY symbol HAVING COUNT(*) >= 4
    )`,
  )
  .get(...universe) as { c: number };

const symbolsWith4Q = coverageRow.c;
const coveragePct = Number(((symbolsWith4Q / universe.length) * 100).toFixed(1));

// ---------------------------------------------------------------------------
// 3. QoQ EPS growth vs profit_growth_yoy — compute cross-sectional σ
// ---------------------------------------------------------------------------

// EPS growth: (eps_t - eps_t-4) / abs(eps_t-4)
const epsRows = db
  .prepare(
    `WITH Ranked AS (
      SELECT symbol, eps,
        ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY quarter_end DESC) AS rn
      FROM quarterly_fundamentals
      WHERE eps IS NOT NULL AND symbol IN (${ph})
    ),
    T  AS (SELECT symbol, eps AS eps_t FROM Ranked WHERE rn = 1),
    T4 AS (SELECT symbol, eps AS eps_t4 FROM Ranked WHERE rn = 5)
    SELECT t.symbol, t.eps_t, t4.eps_t4
    FROM T t LEFT JOIN T4 t4 ON t.symbol = t4.symbol`,
  )
  .all(...universe) as Array<{ symbol: string; eps_t: number; eps_t4: number | null }>;

const epsValues: number[] = [];
for (const r of epsRows) {
  if (r.eps_t4 != null && Number.isFinite(r.eps_t4) && r.eps_t4 !== 0) {
    epsValues.push(((r.eps_t - r.eps_t4) / Math.abs(r.eps_t4)) * 100);
  }
}

// Latest profit_growth_yoy per symbol (yahoo_snapshot preferred over screener on same date)
const pgyRows = db
  .prepare(
    `SELECT profit_growth_yoy FROM (
      SELECT profit_growth_yoy,
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
  .all(...universe) as Array<{ profit_growth_yoy: number }>;

const pgyValues = pgyRows.map((r) => r.profit_growth_yoy).filter(Number.isFinite);

function popStd(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length);
}

const epsStd = popStd(epsValues);
const pgyStd = popStd(pgyValues);
const epsN = epsValues.length;
const pgyN = pgyValues.length;

// ---------------------------------------------------------------------------
// 4. Go/no-go gate
// ---------------------------------------------------------------------------
const coveragePass = coveragePct >= 50;
const sigmaPass = epsStd != null && pgyStd != null ? epsStd > pgyStd : false;
const verdict = coveragePass && sigmaPass ? 'PASS' : 'HALT';

const output = {
  audit: 'EPS coverage gate (B-ENG-12)',
  asOf,
  universeSize: universe.length,
  coverage: { symbolsWith4QorMore: symbolsWith4Q, coveragePct, pass: coveragePass },
  epsGrowth: { n: epsN, std: epsStd != null ? Number(epsStd.toFixed(2)) : null },
  profitGrowth: { n: pgyN, std: pgyStd != null ? Number(pgyStd.toFixed(2)) : null },
  gate: { coveragePass, sigmaPass, verdict },
};

console.log(JSON.stringify(output, null, 2));

closeDb();

if (verdict === 'HALT') {
  console.error(`GATE: HALT — coverage=${coveragePct}% (threshold=50%), sigmaPass=${sigmaPass}`);
  process.exitCode = 1;
}
