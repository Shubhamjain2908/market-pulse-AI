/**
 * Cross-sectional momentum composite and ranks for the momentum universe (Phase 4.1).
 * Reads Factors 1/3/4 from `signals`, Factor 2 from `fundamentals.profit_growth_yoy`.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { getMomentumUniverseSymbols, loadMomentumConfig } from '../config/loaders.js';
import { deleteMomentumRankSignals, getDb, upsertSignals } from '../db/index.js';
import { child } from '../logger.js';
import type { Signal } from '../types/domain.js';

const log = child({ component: 'momentum-ranker' });

const MOM_SOURCE = 'momentum' as const;

export interface MomentumRankerResult {
  asOf: string;
  universeSize: number;
  eligibleCount: number;
  signalsWritten: number;
  rankClears: number;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
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

function loadLatestProfitGrowthYoy(
  universe: string[],
  asOf: string,
  db: DatabaseType,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (universe.length === 0) return out;
  const ph = universe.map(() => '?').join(',');
  const rows = db
    .prepare(
      `
      SELECT f.symbol AS symbol, f.profit_growth_yoy AS profit_growth_yoy
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
    .all(asOf, ...universe) as Array<{ symbol: string; profit_growth_yoy: number | null }>;

  for (const sym of universe) {
    out.set(sym.toUpperCase(), null);
  }
  for (const r of rows) {
    const v = r.profit_growth_yoy;
    out.set(r.symbol.toUpperCase(), v != null && Number.isFinite(v) ? v : null);
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

  let universe = (opts.universe ?? getMomentumUniverseSymbols({ fresh: true })).map((s) =>
    s.toUpperCase(),
  );
  universe = [...new Set(universe)].sort((a, b) => a.localeCompare(b));

  const factorMap = loadFactorSnapshots(universe, asOf, db);
  const epsMap = loadLatestProfitGrowthYoy(universe, asOf, db);

  const eligible = universe.filter((sym) => {
    const m = factorMap.get(sym)?.mom121;
    return m != null && Number.isFinite(m);
  });
  const eligibleSet = new Set(eligible);

  let rankClears = 0;
  for (const sym of universe) {
    if (!eligibleSet.has(sym)) {
      deleteMomentumRankSignals(sym, asOf, db);
      rankClears++;
    }
  }

  if (eligible.length === 0) {
    log.warn({ asOf, universeSize: universe.length }, 'momentum ranker: no eligible symbols');
    return {
      asOf,
      universeSize: universe.length,
      eligibleCount: 0,
      signalsWritten: 0,
      rankClears,
    };
  }

  const f1: number[] = [];
  const eps: (number | null)[] = [];
  const rs: (number | null)[] = [];
  const bo: (number | null)[] = [];

  for (const sym of eligible) {
    const snap = factorMap.get(sym);
    f1.push(snap?.mom121 ?? 0);
    eps.push(epsMap.get(sym) ?? null);
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

  const z1Sorted = [...z1w].sort((a, b) => a - b);
  const q75 = quantileSorted(z1Sorted, 0.75);

  type Row = {
    symbol: string;
    composite: number;
    falseFlag: boolean;
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
    const topQuartile = Number.isFinite(q75) && zv1 >= q75;
    const epsWeak = rawEps != null && Number.isFinite(rawEps) && rawEps < epsThreshold;
    const falseFlag = topQuartile && epsWeak;

    scored.push({ symbol: sym, composite, falseFlag });
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
    );
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
  };
}
