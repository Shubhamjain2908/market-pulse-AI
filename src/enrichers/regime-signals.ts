/**
 * Deterministic regime inputs + weighted score buckets (-16 .. +16).
 * DB-only: benchmarks (`NIFTY_50`, `INDIA_VIX`), `fii_dii` cash segment, `signals` + `quotes`.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { getRecentQuotes } from '../db/queries.js';
import {
  BENCHMARK_QUOTE_SYMBOLS,
  GLOBAL_MACRO_QUOTE_SYMBOLS,
  INDIA_VIX_BENCHMARK_SYMBOL,
  NIFTY_BENCHMARK_SYMBOL,
} from '../market/benchmarks.js';
import { defaultIngestSymbolUniverse } from '../market/ingest-symbols.js';
import { listTradingDaysBackward } from '../market/trading-days.js';
import type { Fii5dTrend, RegimeSignals } from '../types/regime.js';
import { mean } from './technical/indicators.js';

const EXCLUDED_FROM_BREADTH = new Set<string>([
  ...BENCHMARK_QUOTE_SYMBOLS,
  ...GLOBAL_MACRO_QUOTE_SYMBOLS,
]);

function scoreNiftyVsSma200(pct: number): number {
  if (pct > 3) return 2;
  if (pct >= 1 && pct <= 3) return 1;
  if (pct >= -1 && pct < 1) return 0;
  if (pct >= -3 && pct < -1) return -1;
  return -2;
}

function scoreSma200Slope10d(pct: number): number {
  if (pct > 0.3) return 2;
  if (Math.abs(pct) <= 0.05) return 0;
  if (pct > 0.05 && pct <= 0.3) return 1;
  if (pct >= -0.3 && pct < -0.05) return -1;
  return -2;
}

function scoreVixLevel(vix: number): number {
  if (vix < 12) return 2;
  if (vix >= 12 && vix < 16) return 1;
  if (vix >= 16 && vix < 20) return 0;
  if (vix >= 20 && vix < 26) return -1;
  return -2;
}

function scoreVix5dChangePct(changePct: number): number {
  if (changePct <= -10) return 2;
  if (changePct >= 15) return -2;
  if (changePct >= -5 && changePct <= 5) return 0;
  if (changePct > 5 && changePct < 15) return -1;
  return 1;
}

function scoreFii20d(cr: number): number {
  if (cr > 8000) return 2;
  if (cr >= 2000 && cr <= 8000) return 1;
  if (cr >= -2000 && cr <= 2000) return 0;
  if (cr >= -8000 && cr < -2000) return -1;
  return -2;
}

function classifyFii5dTrend(recentFirstFive: number[]): Fii5dTrend {
  if (recentFirstFive.length < 5) return 'MIXED';
  const [d0, d1] = recentFirstFive;
  const slice = recentFirstFive.slice(0, 5);
  if (slice.every((x) => x > 0)) return 'POSITIVE';
  if (slice.every((x) => x < 0)) return 'NEGATIVE';
  if (d0 !== undefined && d1 !== undefined && d0 > 0 && d1 <= 0) return 'TURNING_POSITIVE';
  if (d0 !== undefined && d1 !== undefined && d0 < 0 && d1 >= 0) return 'TURNING_NEGATIVE';
  return 'MIXED';
}

function scoreFii5dTrendEnum(t: Fii5dTrend): number {
  switch (t) {
    case 'TURNING_POSITIVE':
      return 2;
    case 'POSITIVE':
      return 1;
    case 'MIXED':
      return 0;
    case 'NEGATIVE':
      return -1;
    case 'TURNING_NEGATIVE':
      return -2;
  }
}

function scoreAdRatio(ad: number): number {
  if (ad > 2.5) return 2;
  if (ad >= 1.5 && ad <= 2.5) return 1;
  if (ad >= 0.8 && ad < 1.5) return 0;
  if (ad >= 0.5 && ad < 0.8) return -1;
  return -2;
}

function scorePctAboveSma200(pct: number): number {
  if (pct > 65) return 2;
  if (pct >= 55 && pct <= 65) return 1;
  if (pct >= 45 && pct < 55) return 0;
  if (pct >= 35 && pct < 45) return -1;
  return -2;
}

function prevTradingDate(db: DatabaseType, symbol: string, date: string): string | null {
  const row = db
    .prepare(`SELECT MAX(date) AS d FROM quotes WHERE symbol = ? AND exchange = 'NSE' AND date < ?`)
    .get(symbol, date) as { d: string | null } | undefined;
  return row?.d ?? null;
}

/**
 * Latest INDIA_VIX close on or before `date` (ascending quote rows).
 * Carries forward the prior session when today's EOD bar is not ingested yet.
 */
export function pickVixCloseOnOrBefore(
  ascVix: ReadonlyArray<{ date: string; close: number }>,
  date: string,
): { row: { date: string; close: number }; stale: boolean } | null {
  const exact = ascVix.find((q) => q.date === date);
  if (exact) return { row: exact, stale: false };
  const onOrBefore = ascVix.filter((q) => q.date <= date);
  const latest = onOrBefore.at(-1);
  return latest ? { row: latest, stale: true } : null;
}

/**
 * Compute all raw inputs and the 8 sub-scores + bucket totals for `date` (IST YYYY-MM-DD).
 */
export function computeRegimeSignals(db: DatabaseType, date: string): RegimeSignals {
  const warnings: string[] = [];

  const niftyRows = getRecentQuotes(NIFTY_BENCHMARK_SYMBOL, 260, db);
  const ascNifty = [...niftyRows].reverse();
  const closes = ascNifty.map((q) => q.close);

  let niftyVsSma200Pct: number | null = null;
  let sma200Slope10dPct: number | null = null;
  let niftyGapPct: number | null = null;

  if (closes.length < 200) {
    warnings.push(
      `NIFTY_50: need 200+ EOD rows for SMA200; have ${closes.length} (nifty_vs_sma200 / slope treated as neutral)`,
    );
  } else {
    const sma200Today = mean(closes.slice(-200));
    const latest = closes.at(-1) ?? 0;
    niftyVsSma200Pct = ((latest - sma200Today) / sma200Today) * 100;
    if (closes.length >= 210) {
      const sma200_10dAgo = mean(closes.slice(-210, -10));
      sma200Slope10dPct = ((sma200Today - sma200_10dAgo) / sma200_10dAgo) * 100;
    } else {
      warnings.push('NIFTY_50: need 210+ rows for 10d SMA200 slope; slope neutral');
    }
  }

  const rowToday = ascNifty.find((q) => q.date === date);
  const prevD = prevTradingDate(db, NIFTY_BENCHMARK_SYMBOL, date);
  if (rowToday && prevD) {
    const prevRow = db
      .prepare(`SELECT close FROM quotes WHERE symbol = ? AND exchange = 'NSE' AND date = ?`)
      .get(NIFTY_BENCHMARK_SYMBOL, prevD) as { close: number } | undefined;
    if (prevRow && prevRow.close > 0) {
      niftyGapPct = ((rowToday.open - prevRow.close) / prevRow.close) * 100;
    }
  } else {
    warnings.push('NIFTY_50: missing quote row for date or prior session — gap % unavailable');
  }

  const vixRows = getRecentQuotes(INDIA_VIX_BENCHMARK_SYMBOL, 30, db);
  const ascVix = [...vixRows].reverse();
  let vixCurrent: number | null = null;
  let vix5dChangePct: number | null = null;
  const vixPick = pickVixCloseOnOrBefore(ascVix, date);
  if (vixPick) {
    vixCurrent = vixPick.row.close;
    if (vixPick.stale) {
      warnings.push(
        `INDIA_VIX: no quote row for ${date}; using stale close from ${vixPick.row.date}`,
      );
    }
    const idx = ascVix.findIndex((q) => q.date === vixPick.row.date);
    if (idx >= 5) {
      const vix5dAgo = ascVix[idx - 5]?.close;
      if (vix5dAgo != null && vix5dAgo > 0) {
        vix5dChangePct = ((vixPick.row.close - vix5dAgo) / vix5dAgo) * 100;
      }
    } else {
      warnings.push('INDIA_VIX: not enough history on or before date for 5d change');
    }
  } else {
    warnings.push(`INDIA_VIX: no quote row on or before ${date}`);
  }

  const fiiNetStmt = db.prepare(
    `SELECT fii_net AS fiiNet FROM fii_dii WHERE segment = 'cash' AND date = ?`,
  );

  const tradingDays20 = listTradingDaysBackward(date, 20);
  let fii20dRollingCr: number | null = null;
  if (tradingDays20.length > 0) {
    let sum20 = 0;
    let found20 = 0;
    for (const d of tradingDays20) {
      const r = fiiNetStmt.get(d) as { fiiNet: number } | undefined;
      if (r != null && Number.isFinite(r.fiiNet)) {
        sum20 += r.fiiNet;
        found20++;
      }
    }
    if (found20 > 0) {
      fii20dRollingCr = sum20;
      if (found20 < 20) {
        warnings.push(
          `fii_dii cash: summed ${found20} of last 20 trading sessions up to ${date} — partial 20d rolling total`,
        );
      }
    } else {
      warnings.push(`fii_dii cash: no FII rows for the last 20 trading sessions ending ${date}`);
    }
  } else {
    warnings.push('fii_dii cash: could not resolve trading calendar for 20d rolling sum');
  }

  const tradingDays5 = listTradingDaysBackward(date, 5);
  const last5nets: number[] = [];
  for (const d of tradingDays5) {
    const r = fiiNetStmt.get(d) as { fiiNet: number } | undefined;
    if (r != null && Number.isFinite(r.fiiNet)) last5nets.push(r.fiiNet);
  }
  const fii5dTrend = classifyFii5dTrend(last5nets);

  const universe = defaultIngestSymbolUniverse(db).filter((s) => !EXCLUDED_FROM_BREADTH.has(s));
  const prevBreadth = prevTradingDate(db, NIFTY_BENCHMARK_SYMBOL, date);

  let advances = 0;
  let declines = 0;
  if (prevBreadth && universe.length > 0) {
    const placeholders = universe.map(() => '?').join(',');
    const todayQs = db
      .prepare(
        `SELECT symbol, close FROM quotes WHERE date = ? AND exchange = 'NSE' AND symbol IN (${placeholders})`,
      )
      .all(date, ...universe) as Array<{ symbol: string; close: number }>;
    const prevQs = db
      .prepare(
        `SELECT symbol, close FROM quotes WHERE date = ? AND exchange = 'NSE' AND symbol IN (${placeholders})`,
      )
      .all(prevBreadth, ...universe) as Array<{ symbol: string; close: number }>;
    const prevMap = new Map(prevQs.map((r) => [r.symbol, r.close]));
    for (const t of todayQs) {
      const pc = prevMap.get(t.symbol);
      if (pc == null || pc <= 0) continue;
      if (t.close > pc) advances++;
      else if (t.close < pc) declines++;
    }
  } else {
    warnings.push('Breadth AD: missing prior session or empty universe — AD ratio unavailable');
  }

  let adRatio: number | null = null;
  if (advances + declines > 0) {
    adRatio = advances / Math.max(declines, 1);
  }

  const breadthRow = db
    .prepare(
      `
      SELECT
        SUM(CASE WHEN s_close.value > s_sma.value THEN 1 ELSE 0 END) AS above_cnt,
        COUNT(*) AS total_cnt
      FROM signals AS s_close
      INNER JOIN signals AS s_sma
        ON s_close.symbol = s_sma.symbol AND s_close.date = s_sma.date
      WHERE s_close.date = ?
        AND s_close.name = 'close'
        AND s_sma.name = 'sma_200'
    `,
    )
    .get(date) as { above_cnt: number | null; total_cnt: number | null } | undefined;

  let pctAboveSma200: number | null = null;
  if (
    breadthRow &&
    breadthRow.total_cnt != null &&
    breadthRow.total_cnt > 0 &&
    breadthRow.above_cnt != null
  ) {
    pctAboveSma200 = (breadthRow.above_cnt / breadthRow.total_cnt) * 100;
  } else {
    warnings.push(
      'Breadth % above SMA200: no close/sma_200 signal pairs for date — run enrich first; metric unavailable',
    );
  }

  const sn = niftyVsSma200Pct != null ? scoreNiftyVsSma200(niftyVsSma200Pct) : 0;
  const ss = sma200Slope10dPct != null ? scoreSma200Slope10d(sma200Slope10dPct) : 0;
  const sv = vixCurrent != null ? scoreVixLevel(vixCurrent) : 0;
  const sv5 = vix5dChangePct != null ? scoreVix5dChangePct(vix5dChangePct) : 0;
  const sf20 = fii20dRollingCr != null ? scoreFii20d(fii20dRollingCr) : 0;
  const sf5 = scoreFii5dTrendEnum(fii5dTrend);
  const sad = adRatio != null ? scoreAdRatio(adRatio) : 0;
  const spct = pctAboveSma200 != null ? scorePctAboveSma200(pctAboveSma200) : 0;

  const scoreTrend = sn + ss;
  const scoreVix = sv + sv5;
  const scoreFii = sf20 + sf5;
  const scoreBreadth = sad + spct;
  const scoreTotal = scoreTrend + scoreVix + scoreFii + scoreBreadth;

  return {
    date,
    niftyVsSma200Pct,
    sma200Slope10dPct,
    vixCurrent,
    vix5dChangePct,
    fii20dRollingCr,
    fii5dTrend,
    adRatio,
    pctAboveSma200,
    niftyGapPct,
    scoreNiftySma: sn,
    scoreSma200Slope: ss,
    scoreVixLevel: sv,
    scoreVix5d: sv5,
    scoreFii20d: sf20,
    scoreFii5dTrend: sf5,
    scoreAdRatio: sad,
    scorePctAboveSma200: spct,
    scoreTrend,
    scoreVix,
    scoreFii,
    scoreBreadth,
    scoreTotal,
    warnings,
  };
}
