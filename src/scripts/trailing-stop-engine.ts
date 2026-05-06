/**
 * Pure trailing-stop math (no DB). Spec: adaptive-trailing-stop + plan (golden rule, 15% tighten, floor).
 */

import type { TrailingStopResult } from '../types/trailing-stop.js';

export interface ComputeNewStopInput {
  entryPrice: number;
  highestCloseSinceEntry: number;
  currentStopLoss: number;
  /** Must be finite and > 0 (caller skips bar when ATR unavailable). */
  atr14Today: number;
  /** Persisted trailing multiplier: 2.0 until first time gain ≥ 15%, then 1.5 forever. */
  currentMultiplier: number;
}

/**
 * Floor for candidate stop: never below half of entry (data-error guard; spec Prompt 2).
 */
export function candidateStopFloor(entryPrice: number): number {
  return entryPrice * 0.5;
}

/**
 * Daily trailing step after highest close is updated.
 * `wasTightened` flags mult crossing 2→1.5 in DB (`trailing_multiplier`); `action` is RAISED/HELD/TIGHTENED.
 *
 * 1. unrealisedPct from highest close vs entry
 * 2. multiplier 1.5 if gain ≥ 15% or already tightened in DB; else 2.0
 * 3. candidate = high − mult×ATR, floored to max(candidate, entry×0.5)
 * 4. newStop = max(candidate, currentStop) — golden rule
 * 5. `action`: TIGHTENED iff stop rose this bar **and** mult transitioned 2→1.5; else RAISED or HELD.
 *    `wasTightened` is true whenever mult uses 1.5 while DB still had 2.0 (including HELD when candidate is below current).
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
  /** Mult rule crossed to 1.5 while DB still had 2.0 (Phase 3 uses this to persist `trailing_multiplier`). */
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

/**
 * Day-1 consolidated stop: never loosens vs LLM level; tightens when ATR says so.
 * `atr14AtEntry == null` → keep LLM stop unchanged.
 */
export function applyDay1InitialStop(
  entryPrice: number,
  llmStopLoss: number,
  atr14AtEntry: number | null,
): number {
  if (atr14AtEntry == null || !Number.isFinite(atr14AtEntry)) return llmStopLoss;
  const atrBasedStop = entryPrice - 2 * atr14AtEntry;
  return Math.max(llmStopLoss, atrBasedStop);
}
