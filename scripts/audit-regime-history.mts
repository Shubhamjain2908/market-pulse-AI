/**
 * Explain `regime_daily` labels vs score-only raw mapping (and why BULL_TRENDING can be absent).
 *
 * Usage:
 *   pnpm exec tsx scripts/audit-regime-history.mts --from 2023-01-01 --to 2026-05-21
 *
 * Requires: migrated DB; reads `regime_daily` rows in the date range (no recompute).
 */

import { parseArgs } from 'node:util';

import { mapScoreTotalToRegime } from '../src/analysers/regime-classifier.js';
import { closeDb, getDb, migrate } from '../src/db/index.js';
import { isIsoDate } from '../src/ingestors/base/dates.js';
import type { Regime } from '../src/types/regime.js';
import { argvForCliParseArgs } from './argv-for-cli.js';

function rawLabelFromRow(scoreTotal: number, crisisOverride: boolean): Regime {
  if (crisisOverride) return 'CRISIS';
  return mapScoreTotalToRegime(scoreTotal);
}

function bump(h: Record<string, number>, k: string): void {
  h[k] = (h[k] ?? 0) + 1;
}

migrate();
const db = getDb();

const { values } = parseArgs({
  args: argvForCliParseArgs(),
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
  },
});

const from = values.from;
const to = values.to;
if (typeof from !== 'string' || typeof to !== 'string' || !isIsoDate(from) || !isIsoDate(to)) {
  console.error(
    'Usage: pnpm exec tsx scripts/audit-regime-history.mts --from YYYY-MM-DD --to YYYY-MM-DD',
  );
  closeDb();
  process.exitCode = 1;
  process.exit();
}

const rows = db
  .prepare(
    `
    SELECT date, regime, score_total, score_trend, score_vix, score_fii, score_breadth,
           crisis_override, pct_above_sma200, ad_ratio
    FROM regime_daily
    WHERE date >= ? AND date <= ?
    ORDER BY date ASC
  `,
  )
  .all(from, to) as Array<{
  date: string;
  regime: string;
  score_total: number;
  score_trend: number;
  score_vix: number;
  score_fii: number;
  score_breadth: number;
  crisis_override: number;
  pct_above_sma200: number | null;
  ad_ratio: number | null;
}>;

const persistedHist: Record<string, number> = {};
const rawHist: Record<string, number> = {};
let rawBullDays = 0;
let pctAboveNull = 0;
let adNull = 0;
const mismatchSamples: Array<{
  date: string;
  persisted: string;
  rawFromScore: string;
  scoreTotal: number;
}> = [];

for (const r of rows) {
  bump(persistedHist, r.regime);
  const raw = rawLabelFromRow(Number(r.score_total), r.crisis_override === 1);
  bump(rawHist, raw);
  if (raw === 'BULL_TRENDING') rawBullDays++;
  if (r.pct_above_sma200 == null) pctAboveNull++;
  if (r.ad_ratio == null) adNull++;
  if (raw !== r.regime && mismatchSamples.length < 8) {
    mismatchSamples.push({
      date: r.date,
      persisted: r.regime,
      rawFromScore: raw,
      scoreTotal: Number(r.score_total),
    });
  }
}

const scoreTotals = rows.map((r) => Number(r.score_total));
const minScore = scoreTotals.length ? Math.min(...scoreTotals) : 0;
const maxScore = scoreTotals.length ? Math.max(...scoreTotals) : 0;
const avgScore = scoreTotals.length
  ? scoreTotals.reduce((a, b) => a + b, 0) / scoreTotals.length
  : 0;
const daysScoreGe2 = scoreTotals.filter((s) => s >= 2).length;

const hints: string[] = [
  'score_total ≥ 2 maps to raw BULL_TRENDING (see mapScoreTotalToRegime). Persisted regime also requires 3-session agreement + crisis streak rules — raw BULL days can exceed persisted BULL days.',
  'If score_total is almost always in [-2,2), inputs are neutral/weak (common when pct_above_sma200 is NULL — enrich historical signals — or fii_dii is sparse).',
];

if (pctAboveNull > rows.length * 0.5) {
  hints.push(
    `pct_above_sma200 is NULL on ${pctAboveNull}/${rows.length} rows — run historical enrich so regime-signals breadth is populated.`,
  );
}

console.log(
  JSON.stringify(
    {
      from,
      to,
      rowCount: rows.length,
      persistedRegimeHistogram: persistedHist,
      rawScoreRegimeHistogram: rawHist,
      rawBullTrendingDays: rawBullDays,
      scoreTotalStats: {
        min: minScore,
        max: maxScore,
        avg: Number(avgScore.toFixed(3)),
        daysWithScoreGte2: daysScoreGe2,
      },
      breadthNulls: { pctAboveSma200Null: pctAboveNull, adRatioNull: adNull },
      samplePersistedVsRawMismatch: mismatchSamples,
      hints,
    },
    null,
    2,
  ),
);

closeDb();
