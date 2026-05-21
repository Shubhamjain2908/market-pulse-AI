/**
 * Pure trailing-stop math (no DB). Spec: adaptive-trailing-stop + plan (golden rule, lock-in, floor).
 */

import type { TrailingStopSizing } from '../config/trailing-stop-sizing.js';
import { isInitialTrailingMult, isTightenedTrailingMult } from '../config/trailing-stop-sizing.js';
import type { TrailingStopResult } from '../types/trailing-stop.js';

export interface ComputeNewStopInput {
  entryPrice: number;
  highestCloseSinceEntry: number;
  currentStopLoss: number;
  /** Must be finite and > 0 (caller skips bar when ATR unavailable). */
  atr14Today: number;
  /** Config-driven initial / tightened multipliers and lock-in threshold. */
  sizing: TrailingStopSizing;
  /** Persisted trailing multiplier (normalized to sizing bands by caller). */
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
 * `wasTightened` flags mult crossing initial→tightened in DB; `action` is RAISED/HELD/TIGHTENED.
 */
export function computeNewStop(p: ComputeNewStopInput): TrailingStopResult {
  const {
    entryPrice,
    highestCloseSinceEntry,
    currentStopLoss,
    atr14Today,
    sizing,
    currentMultiplier,
  } = p;

  const unrealisedPct = ((highestCloseSinceEntry - entryPrice) / entryPrice) * 100;

  const alreadyTightened = isTightenedTrailingMult(currentMultiplier, sizing);
  const useTightened = unrealisedPct >= sizing.lockInThresholdPct || alreadyTightened;
  const multiplier = useTightened ? sizing.tightenedMultiplier : sizing.initialMultiplier;

  const rawCandidate = highestCloseSinceEntry - multiplier * atr14Today;
  const candidateStop = Math.max(rawCandidate, candidateStopFloor(entryPrice));

  const newStop = Math.max(candidateStop, currentStopLoss);
  const wasRaised = newStop > currentStopLoss;
  const wasTightened = useTightened && isInitialTrailingMult(currentMultiplier, sizing);

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
  initialMultiplier: number,
): number {
  if (atr14AtEntry == null || !Number.isFinite(atr14AtEntry)) return llmStopLoss;
  const atrBasedStop = entryPrice - initialMultiplier * atr14AtEntry;
  return Math.max(llmStopLoss, atrBasedStop);
}
