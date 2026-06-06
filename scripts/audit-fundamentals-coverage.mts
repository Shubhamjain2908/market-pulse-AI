/**
 * Fundamentals coverage + quality_garp gate funnel for latest snapshot date.
 *
 * Usage: pnpm fundamentals:audit
 */

import {
  QUALITY_GARP_DE_MAX,
  QUALITY_GARP_PB_MAX,
  QUALITY_GARP_PE_MAX,
  QUALITY_GARP_PEG_MAX,
  QUALITY_GARP_ROCE_MIN,
  QUALITY_GARP_ROE_MIN,
} from '../src/analysers/quality-garp-gates.js';
import { closeDb, getDb, migrate } from '../src/db/index.js';
import { getQualityGarpFundamentals } from '../src/db/queries.js';
import { isoDateIst } from '../src/ingestors/base/dates.js';

migrate();
const db = getDb();
const asOf = isoDateIst();

const snapshotCoverage = db
  .prepare(
    `
    WITH LatestSnap AS (
      SELECT f.symbol, f.pe, f.pb, f.peg, f.debt_to_equity, f.as_of,
        ROW_NUMBER() OVER (
          PARTITION BY f.symbol
          ORDER BY f.as_of DESC,
            CASE f.source WHEN 'yahoo_snapshot' THEN 0 WHEN 'screener' THEN 1 ELSE 2 END
        ) AS rn
      FROM fundamentals f
      WHERE f.source IN ('yahoo_snapshot', 'screener')
    )
    SELECT
      COUNT(*) AS symbols,
      SUM(pe IS NOT NULL) AS pe_populated,
      SUM(pb IS NOT NULL) AS pb_populated,
      SUM(peg IS NOT NULL) AS peg_populated,
      SUM(debt_to_equity IS NOT NULL) AS de_populated
    FROM LatestSnap
    WHERE rn = 1
  `,
  )
  .get() as {
  symbols: number;
  pe_populated: number;
  pb_populated: number;
  peg_populated: number;
  de_populated: number;
};

const roceSplit = db
  .prepare(
    `
    SELECT
      SUM(roce IS NULL) AS roce_null,
      SUM(roce < ? AND roce IS NOT NULL) AS roce_below_threshold,
      SUM(roce >= ?) AS roce_passing
    FROM (
      SELECT f.roce
      FROM fundamentals f
      WHERE f.source = 'yahoo_annual'
        AND f.as_of = (
          SELECT MAX(f2.as_of)
          FROM fundamentals f2
          WHERE f2.symbol = f.symbol AND f2.source = 'yahoo_annual'
        )
    )
  `,
  )
  .get(QUALITY_GARP_ROCE_MIN, QUALITY_GARP_ROCE_MIN) as {
  roce_null: number;
  roce_below_threshold: number;
  roce_passing: number;
};

const annualCoverage = db
  .prepare(
    `
    WITH AnnualLatest AS (
      SELECT symbol, roe, roce, as_of,
        ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY as_of DESC) AS rn
      FROM fundamentals
      WHERE source = 'yahoo_annual'
    ),
    Annual3 AS (
      SELECT symbol,
        SUM(CASE WHEN rn = 1 AND roe IS NOT NULL THEN 1 ELSE 0 END) AS y1,
        SUM(CASE WHEN rn = 2 AND roe IS NOT NULL THEN 1 ELSE 0 END) AS y2,
        SUM(CASE WHEN rn = 3 AND roe IS NOT NULL THEN 1 ELSE 0 END) AS y3
      FROM (
        SELECT symbol, roe, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY as_of DESC) AS rn
        FROM fundamentals WHERE source = 'yahoo_annual'
      )
      GROUP BY symbol
    )
    SELECT
      (SELECT COUNT(*) FROM AnnualLatest WHERE rn = 1) AS annual_symbols,
      (SELECT SUM(roe IS NOT NULL) FROM AnnualLatest WHERE rn = 1) AS roe_populated,
      (SELECT SUM(roce IS NOT NULL) FROM AnnualLatest WHERE rn = 1) AS roce_populated,
      (SELECT COUNT(*) FROM Annual3 WHERE y1 > 0 AND y2 > 0 AND y3 > 0) AS roe_3yr_consecutive
  `,
  )
  .get() as {
  annual_symbols: number;
  roe_populated: number;
  roce_populated: number;
  roe_3yr_consecutive: number;
};

const staleness = db
  .prepare(
    `
    SELECT
      CASE
        WHEN days_stale <= 7 THEN '0-7d'
        WHEN days_stale <= 30 THEN '8-30d'
        WHEN days_stale <= 90 THEN '31-90d'
        ELSE '90d+'
      END AS bucket,
      COUNT(*) AS symbols
    FROM (
      SELECT symbol,
        CAST(julianday(?) - julianday(MAX(as_of)) AS INTEGER) AS days_stale
      FROM fundamentals
      WHERE source IN ('yahoo_snapshot', 'screener')
      GROUP BY symbol
    )
    GROUP BY bucket
    ORDER BY bucket
  `,
  )
  .all(asOf) as Array<{ bucket: string; symbols: number }>;

const rows = getQualityGarpFundamentals(asOf, db);
const funnel = {
  candidates_pe_pb: rows.length,
  valuation: 0,
  roe_3yr: 0,
  roce: 0,
  debt: 0,
  peg_null: 0,
  peg: 0,
};

for (const f of rows) {
  if (f.pe == null || f.pb == null) continue;
  if (f.pe > QUALITY_GARP_PE_MAX || f.pb > QUALITY_GARP_PB_MAX) {
    funnel.valuation++;
    continue;
  }
  if (
    f.latestRoe == null ||
    f.prevRoe == null ||
    f.thirdRoe == null ||
    f.latestRoe < QUALITY_GARP_ROE_MIN ||
    f.prevRoe < QUALITY_GARP_ROE_MIN ||
    f.thirdRoe < QUALITY_GARP_ROE_MIN
  ) {
    funnel.roe_3yr++;
    continue;
  }
  if (f.latestRoce == null || f.latestRoce < QUALITY_GARP_ROCE_MIN) {
    funnel.roce++;
    continue;
  }
  if (f.debtToEquity == null || f.debtToEquity >= QUALITY_GARP_DE_MAX) {
    funnel.debt++;
    continue;
  }
  if (f.peg == null) {
    funnel.peg_null++;
    continue;
  }
  if (f.peg >= QUALITY_GARP_PEG_MAX) {
    funnel.peg++;
  }
}

console.log(`Fundamentals coverage audit (as_of context: ${asOf})`);
console.log('\nSnapshot (latest per symbol):');
console.log(snapshotCoverage);
console.log('\nAnnual (yahoo_annual latest):');
console.log(annualCoverage);
console.log('\nROCE coverage (yahoo_annual, latest per symbol):');
console.log(`  Passing  (≥${QUALITY_GARP_ROCE_MIN * 100}%): ${roceSplit.roce_passing}`);
console.log(`  Failing  (<${QUALITY_GARP_ROCE_MIN * 100}%): ${roceSplit.roce_below_threshold}`);
console.log(`  No data  (NULL): ${roceSplit.roce_null}`);
console.log('\nSnapshot staleness buckets:');
for (const row of staleness) console.log(`  ${row.bucket}: ${row.symbols}`);
console.log('\nGate funnel (fundamentals only, pre-RSI/SMA50):');
console.log(funnel);

closeDb();
