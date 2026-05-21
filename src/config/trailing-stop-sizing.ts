/**
 * Authoritative trailing-stop parameters from momentum-config (live + evaluate-trades).
 * Backtest fallbacks in `position.ts` mirror these values when sweep opts omit overrides.
 */

import { type MomentumConfig, loadMomentumConfig } from './loaders.js';

export interface TrailingStopSizing {
  initialMultiplier: number;
  tightenedMultiplier: number;
  lockInThresholdPct: number;
}

export function trailingStopSizingFromMomentumConfig(
  cfg: MomentumConfig = loadMomentumConfig(),
): TrailingStopSizing {
  const ps = cfg.position_sizing;
  return {
    initialMultiplier: ps.atr_multiplier,
    tightenedMultiplier: ps.tightened_multiplier,
    lockInThresholdPct: ps.lock_in_threshold_pct,
  };
}

const TIGHT_EPS = 1e-6;

/** True when persisted mult is in the tightened band (incl. legacy 1.5). */
export function isTightenedTrailingMult(stored: number, sizing: TrailingStopSizing): boolean {
  if (Math.abs(stored - sizing.tightenedMultiplier) < TIGHT_EPS) return true;
  if (sizing.tightenedMultiplier === 1.5 && Math.abs(stored - 1.5) < TIGHT_EPS) return true;
  return false;
}

/** True when persisted mult is in the initial band (incl. legacy 2.0). */
export function isInitialTrailingMult(stored: number, sizing: TrailingStopSizing): boolean {
  if (Math.abs(stored - sizing.initialMultiplier) < TIGHT_EPS) return true;
  if (Math.abs(stored - 2) < TIGHT_EPS && sizing.initialMultiplier !== 2) return true;
  return false;
}

/** Map DB `trailing_multiplier` to config bands (legacy 2.0 → 2.5 initial). */
export function normalizePersistedTrailingMult(
  stored: number | null | undefined,
  sizing: TrailingStopSizing,
): number {
  if (stored == null || !Number.isFinite(stored)) return sizing.initialMultiplier;
  if (isTightenedTrailingMult(stored, sizing)) return sizing.tightenedMultiplier;
  if (isInitialTrailingMult(stored, sizing)) return sizing.initialMultiplier;
  return stored;
}
