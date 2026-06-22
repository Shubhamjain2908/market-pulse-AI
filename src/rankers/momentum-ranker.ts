/**
 * Cross-sectional momentum composite and ranks for the momentum universe (Phase 4.1).
 * Reads Factors 1/3/4 from `signals`, Factor 2 from `fundamentals` (profit_growth_yoy, net_profit_ttm).
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { getMomentumUniverseSymbols, loadMomentumConfig } from '../config/loaders.js';
import { deleteMomentumRankSignals, getDb, upsertSignals } from '../db/index.js';
import { mean } from '../enrichers/technical/indicators.js';
import { child } from '../logger.js';
import type { Signal } from '../types/domain.js';

const log = child({ component: 'momentum-ranker' });

const MOM_SOURCE = 'momentum_ranker' as const;

export interface MomentumRankerResult {
  asOf: string;
  universeSize: number;
  eligibleCount: number;
  signalsWritten: number;
  rankClears: number;
  ranked: Array<{
    symbol: string;
    rank: number;
    composite: number;
    falseFlag: boolean;
    factor1Raw: number;
    factor2Raw: number | null;
    factor3Raw: number | null;
    factor4Raw: number | null;
    z1: number;
    zEps: number;
    zRs: number;
    zBreakout: number;
  }>;
  excludedSymbols: string[];
}

function stdPop(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  let v = 0;
  for (const x of xs) v += (x - m) ** 2;
  return Math.sqrt(v / xs.length);
}

/** Cross-sectional z using population σ over finite inputs; missing → 0 (neutral). */
export function crossSectionalZ(values: (number | null)[]): number[] {
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (finite.length < 2) {
    return values.map(() => 0);
  }
  const mu = mean(finite);
  const sigma = stdPop(finite);
  if (sigma < 1e-12) {
    return values.map((v) => (v != null && Number.isFinite(v) ? 0 : 0));
  }
  return values.map((v) => (v != null && Number.isFinite(v) ? (v - mu) / sigma : 0));
}

export function winsorize(z: number, cap: number): number {
  if (!Number.isFinite(z)) return 0;
  return Math.max(-cap, Math.min(cap, z));
}

/** False momentum: top-quartile price mom with weak EPS YoY or loss-making TTM profit. */
export function isMomentumFalseFlag(opts: {
  z1: number;
  profitGrowthYoy: number | null;
  netProfitTtm: number | null;
  falseFlagZThreshold: number;
  epsThreshold: number;
}): boolean {
  const topQuartile = opts.z1 > opts.falseFlagZThreshold;
  const epsWeak =
    opts.profitGrowthYoy != null &&
    Number.isFinite(opts.profitGrowthYoy) &&
    opts.profitGrowthYoy < opts.epsThreshold;
  const lossMaking =
    opts.netProfitTtm != null && Number.isFinite(opts.netProfitTtm) && opts.netProfitTtm < 0;
  return topQuartile && (epsWeak || lossMaking);
}

/** `sortedAsc` must be sorted ascending. q in [0,1]. */
export function quantileSorted(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  if (sortedAsc.length === 1) {
    const only = sortedAsc[0];
    return only != null ? only : Number.NaN;
  }
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sortedAsc[lo];
  const b = sortedAsc[hi];
  if (a === undefined || b === undefined) return Number.NaN;
  return lo === hi ? a : a + (b - a) * (pos - lo);
}

interface FactorSnapshot {
  mom121: number | null;
  rsBa: number | null;
  breakout: number | null;
}

function loadFactorSnapshots(
  universe: string[],
  asOf: string,
  db: DatabaseType,
): Map<string, FactorSnapshot> {
  if (universe.length === 0) return new Map();
  const ph = universe.map(() => '?').join(',');
  const rows = db
    .prepare(
      `
      SELECT symbol, name, value FROM signals
      WHERE date = ?
        AND symbol IN (${ph})
        AND name IN ('mom_12_1_return', 'mom_relative_strength_ba', 'mom_volume_breakout_flag')
    `,
    )
    .all(asOf, ...universe) as Array<{ symbol: string; name: string; value: number }>;

  const map = new Map<string, FactorSnapshot>();
  for (const sym of universe) {
    map.set(sym, { mom121: null, rsBa: null, breakout: null });
  }
  for (const r of rows) {
    const u = r.symbol.toUpperCase();
    const snap = map.get(u);
    if (!snap) continue;
    if (r.name === 'mom_12_1_return') snap.mom121 = r.value;
    else if (r.name === 'mom_relative_strength_ba') snap.rsBa = r.value;
    else if (r.name === 'mom_volume_breakout_flag') snap.breakout = r.value;
  }
  return map;
}

interface FundamentalSnapshot {
  profitGrowthYoy: number | null;
  netProfitTtm: number | null;
}

function loadLatestFundamentals(
  universe: string[],
  asOf: string,
  db: DatabaseType,
): Map<string, FundamentalSnapshot> {
  const out = new Map<string, FundamentalSnapshot>();
  if (universe.length === 0) return out;
  const ph = universe.map(() => '?').join(',');
  const rows = db
    .prepare(
      `
      SELECT f.symbol AS symbol,
             f.profit_growth_yoy AS profit_growth_yoy,
             f.net_profit_ttm AS net_profit_ttm
      FROM fundamentals f
      INNER JOIN (
        SELECT symbol, MAX(as_of) AS mx
        FROM fundamentals
        WHERE as_of <= ?
        GROUP BY symbol
      ) t ON f.symbol = t.symbol AND f.as_of = t.mx
      WHERE f.symbol IN (${ph})
    `,
    )
    .all(asOf, ...universe) as Array<{
    symbol: string;
    profit_growth_yoy: number | null;
    net_profit_ttm: number | null;
  }>;

  for (const sym of universe) {
    out.set(sym.toUpperCase(), { profitGrowthYoy: null, netProfitTtm: null });
  }
  for (const r of rows) {
    const pg = r.profit_growth_yoy;
    const np = r.net_profit_ttm;
    out.set(r.symbol.toUpperCase(), {
      profitGrowthYoy: pg != null && Number.isFinite(pg) ? pg : null,
      netProfitTtm: np != null && Number.isFinite(np) ? np : null,
    });
  }
  return out;
}

/**
 * Computes composite scores and ranks for `asOf` (typically rebalance Friday EOD date).
 * Eligible = momentum-universe symbols with `mom_12_1_return` on `asOf`.
 */
export function runMomentumRanker(opts: {
  asOf: string;
  db?: DatabaseType;
  universe?: string[];
}): MomentumRankerResult {
  const db = opts.db ?? getDb();
  const asOf = opts.asOf;
  const cfg = loadMomentumConfig();
  const w = cfg.weights;
  const cap = cfg.winsorise_zscore;
  const bonus = cfg.breakout_bonus;
  const epsThreshold = cfg.false_flag_eps_threshold_pct;
  const falseFlagZThreshold = cfg.false_flag_z_threshold;

  let universe = (opts.universe ?? getMomentumUniverseSymbols({ fresh: true })).map((s) =>
    s.toUpperCase(),
  );
  universe = [...new Set(universe)].sort((a, b) => a.localeCompare(b));
  log.info(
    { universeSize: universe.length },
    'liquidity filter deferred to v1.1 — universe loaded from config',
  );

  const factorMap = loadFactorSnapshots(universe, asOf, db);
  const fundMap = loadLatestFundamentals(universe, asOf, db);

  const eligible = universe.filter((sym) => {
    const m = factorMap.get(sym)?.mom121;
    return m != null && Number.isFinite(m);
  });
  const eligibleSet = new Set(eligible);

  let rankClears = 0;
  const excludedSymbols: string[] = [];
  for (const sym of universe) {
    if (!eligibleSet.has(sym)) {
      deleteMomentumRankSignals(sym, asOf, db);
      rankClears++;
      excludedSymbols.push(sym);
    }
  }

  if (eligible.length === 0) {
    log.warn(
      { asOf, universeSize: universe.length },
      universe.length > 0
        ? 'momentum ranker: zero eligible symbols while universe non-empty — verify Phase 3 enrich (mom_12_1_return) for session date'
        : 'momentum ranker: no eligible symbols (empty universe)',
    );
    return {
      asOf,
      universeSize: universe.length,
      eligibleCount: 0,
      signalsWritten: 0,
      rankClears,
      ranked: [],
      excludedSymbols,
    };
  }

  const f1: number[] = [];
  const eps: (number | null)[] = [];
  const rs: (number | null)[] = [];
  const bo: (number | null)[] = [];

  for (const sym of eligible) {
    const snap = factorMap.get(sym);
    f1.push(snap?.mom121 ?? 0);
    eps.push(fundMap.get(sym)?.profitGrowthYoy ?? null);
    rs.push(snap?.rsBa ?? null);
    const br = snap?.breakout;
    bo.push(br != null && Number.isFinite(br) ? br : null);
  }

  const z1 = crossSectionalZ(f1);
  const zEps = crossSectionalZ(eps);
  const zRs = crossSectionalZ(rs);
  const zBo = crossSectionalZ(bo);

  const z1w = z1.map((z) => winsorize(z, cap));
  const zEpsw = zEps.map((z) => winsorize(z, cap));
  const zRsw = zRs.map((z) => winsorize(z, cap));
  const zBow = zBo.map((z) => winsorize(z, cap));

  const zTopQuartileThreshold = falseFlagZThreshold;

  type Row = {
    symbol: string;
    composite: number;
    falseFlag: boolean;
    factor1Raw: number;
    factor2Raw: number | null;
    factor3Raw: number | null;
    factor4Raw: number | null;
    z1: number;
    zEps: number;
    zRs: number;
    zBreakout: number;
  };

  const scored: Row[] = [];
  for (let i = 0; i < eligible.length; i++) {
    const sym = eligible[i];
    if (sym === undefined) continue;
    const boRaw = bo[i];
    const boTerm = boRaw != null && Number.isFinite(boRaw) ? (boRaw >= 1 ? 1 : 0) : 0;

    const zv1 = z1w[i] ?? 0;
    const zve = zEpsw[i] ?? 0;
    const zvr = zRsw[i] ?? 0;
    const zvb = zBow[i] ?? 0;

    const composite =
      w.mom_12_1 * zv1 +
      w.eps_revision * zve +
      w.rel_strength_ba * zvr +
      w.breakout_flag * zvb +
      bonus * boTerm;

    const rawEps = eps[i];
    const netProfitTtm = fundMap.get(sym)?.netProfitTtm ?? null;
    const falseFlag = isMomentumFalseFlag({
      z1: zv1,
      profitGrowthYoy: rawEps ?? null,
      netProfitTtm,
      falseFlagZThreshold: zTopQuartileThreshold,
      epsThreshold,
    });

    scored.push({
      symbol: sym,
      composite,
      falseFlag,
      factor1Raw: f1[i] ?? 0,
      factor2Raw: eps[i] ?? null,
      factor3Raw: rs[i] ?? null,
      factor4Raw: bo[i] ?? null,
      z1: zv1,
      zEps: zve,
      zRs: zvr,
      zBreakout: zvb,
    });
  }

  scored.sort((a, b) => {
    if (b.composite !== a.composite) return b.composite - a.composite;
    return a.symbol.localeCompare(b.symbol);
  });

  const outSignals: Signal[] = [];
  for (let r = 0; r < scored.length; r++) {
    const row = scored[r];
    if (!row) continue;
    const rank = r + 1;
    outSignals.push(
      {
        symbol: row.symbol,
        date: asOf,
        name: 'mom_composite_score',
        value: row.composite,
        source: MOM_SOURCE,
      },
      {
        symbol: row.symbol,
        date: asOf,
        name: 'mom_rank',
        value: rank,
        source: MOM_SOURCE,
      },
      {
        symbol: row.symbol,
        date: asOf,
        name: 'mom_false_flag',
        value: row.falseFlag ? 1 : 0,
        source: MOM_SOURCE,
      },
      {
        symbol: row.symbol,
        date: asOf,
        name: 'mom_rank_excluded',
        value: 0,
        source: MOM_SOURCE,
      },
    );
  }
  for (const sym of excludedSymbols) {
    outSignals.push({
      symbol: sym,
      date: asOf,
      name: 'mom_rank_excluded',
      value: 1,
      source: MOM_SOURCE,
    });
  }

  const signalsWritten = upsertSignals(outSignals, db);

  log.info(
    {
      asOf,
      universeSize: universe.length,
      eligibleCount: eligible.length,
      signalsWritten,
      rankClears,
    },
    'momentum ranker complete',
  );

  return {
    asOf,
    universeSize: universe.length,
    eligibleCount: eligible.length,
    signalsWritten,
    rankClears,
    ranked: scored.map((row, idx) => ({
      symbol: row.symbol,
      rank: idx + 1,
      composite: row.composite,
      falseFlag: row.falseFlag,
      factor1Raw: row.factor1Raw,
      factor2Raw: row.factor2Raw,
      factor3Raw: row.factor3Raw,
      factor4Raw: row.factor4Raw,
      z1: row.z1,
      zEps: row.zEps,
      zRs: row.zRs,
      zBreakout: row.zBreakout,
    })),
    excludedSymbols,
  };
}
