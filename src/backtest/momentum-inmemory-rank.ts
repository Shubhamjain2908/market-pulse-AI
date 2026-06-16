/**
 * In-memory momentum composite + rank (same weighting as {@link runMomentumRanker}).
 */

import type { MomentumConfig } from '../config/loaders.js';
import { crossSectionalZ, isMomentumFalseFlag, winsorize } from '../rankers/momentum-ranker.js';

export interface MomentumScoredRow {
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
}

/**
 * `eligible` order defines factor array indices (must match f1/eps/rs/bo ordering).
 */
export function scoreMomentumFromFactorRows(
  eligible: string[],
  f1: number[],
  eps: (number | null)[],
  rs: (number | null)[],
  bo: (number | null)[],
  cfg: MomentumConfig,
  netProfitTtm: (number | null)[] = [],
): MomentumScoredRow[] {
  const w = cfg.weights;
  const cap = cfg.winsorise_zscore;
  const bonus = cfg.breakout_bonus;
  const epsThreshold = cfg.false_flag_eps_threshold_pct;
  const falseFlagZThreshold = cfg.false_flag_z_threshold;

  const z1 = crossSectionalZ(f1);
  const zEps = crossSectionalZ(eps);
  const zRs = crossSectionalZ(rs);
  const zBo = crossSectionalZ(bo);

  const z1w = z1.map((z) => winsorize(z, cap));
  const zEpsw = zEps.map((z) => winsorize(z, cap));
  const zRsw = zRs.map((z) => winsorize(z, cap));
  const zBow = zBo.map((z) => winsorize(z, cap));

  const scored: MomentumScoredRow[] = [];
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
    const falseFlag = isMomentumFalseFlag({
      z1: zv1,
      profitGrowthYoy: rawEps ?? null,
      netProfitTtm: netProfitTtm[i] ?? null,
      falseFlagZThreshold,
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

  return scored;
}
