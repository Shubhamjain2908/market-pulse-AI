/**
 * Pure trailing-stop math (no DB). Spec: adaptive-trailing-stop + plan (golden rule, 15% tighten, floor).
 */

import type { TrailingStopResult } from '../types/trailing-stop.js';

export interface ComputeNewStopInput {
  entryPrice: number;
  highestCloseSinceEntry: number;
  currentStopLoss: number;
  /** Must be finite and > 0 (caller skips trailing math when ATR unavailable). */
  atr14Today: number;
  /** Persisted trailing multiplier: 2.0 until gain ≥15%, then 1.5 forever. */
  currentMultiplier: number;
}

export function candidateStopFloor(entryPrice: number): number {
  return entryPrice * 0.5;
}

/**
 * Daily trailing step after highest close is updated.
 * `wasTightened` flags mult crossing 2→1.5 in DB (`trailing_multiplier`); `action` is RAISED/HELD/TIGHTENED.
 */
export function computeNewStop(p: ComputeNewStopInput): TrailingStopResult {
  const { entryPrice, highestCloseSinceEntry, currentStopLoss, atr14Today, currentMultiplier } = p;

  const unrealisedPct = ((highestCloseSinceEntry - entryPrice) / entryPrice) * 100;

  const alreadyTight = currentMultiplier === 1.5;
  const multiplier: 1.5 | 2 = unrealisedPct >= 15 || alreadyTight ? 1.5 : 2;

  const rawCandidate = highestCloseSinceEntry - multiplier * atr14Today;
  const candidateStop = Math.max(rawCandidate, candidateStopFloor(entryPrice));

  const newStop = Math.max(candidateStop, currentStopLoss);
  const wasRaised = newStop > currentStopLoss;
  const wasTightened = multiplier === 1.5 && currentMultiplier === 2;

  let action: TrailingStopResult['action'];
  if (!wasRaised) action = 'HELD';
  else if (wasTightened) action = 'TIGHTENED';
  else action = 'RAISED';

  return {
    newStop,
    candidateStop,
    multiplier,
    unrealisedPct,
    wasRaised,
    wasTightened,
    action,
  };
}

/** Day 1 consolidated stop vs LLM; null ATR preserves LLM level. */
export function applyDay1InitialStop(
  entryPrice: number,
  llmStopLoss: number,
  atr14AtEntry: number | null,
): number {
  if (atr14AtEntry == null || !Number.isFinite(atr14AtEntry)) return llmStopLoss;
  const atrBasedStop = entryPrice - 2 * atr14AtEntry;
  return Math.max(llmStopLoss, atrBasedStop);
}
