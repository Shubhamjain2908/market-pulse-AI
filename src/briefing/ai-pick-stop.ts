/**
 * Minimum stop-distance normalization for AI_PICK paper trades (normalize-then-kill).
 */

import type { Database as DatabaseType } from 'better-sqlite3';

const MIN_RISK_PCT = 0.02;
const MAX_RISK_PCT = 0.08;
const ATR_MULT = 1.0;

export type AiPickStopBlockReason = 'stop_distance_conflict';

export type AiPickStopResult =
  | {
      ok: true;
      effectiveStop: number;
      atr14AtEntry: number | null;
      normalized: boolean;
      parsedStop: number;
      normalizedStop: number;
    }
  | { ok: false; reason: AiPickStopBlockReason };

export function getAtr14AtEntry(
  symbol: string,
  sourceDate: string,
  db: DatabaseType,
): number | null {
  const row = db
    .prepare(
      `
      SELECT value FROM signals
      WHERE symbol = ? AND name = 'atr_14' AND date <= ?
      ORDER BY date DESC LIMIT 1
    `,
    )
    .get(symbol.toUpperCase(), sourceDate) as { value: number } | undefined;
  return row?.value ?? null;
}

export function resolveAiPickStop(
  entry: number,
  parsedStop: number,
  atr14: number | null,
): AiPickStopResult {
  const minDist = Math.max(entry * MIN_RISK_PCT, (atr14 ?? entry * MIN_RISK_PCT) * ATR_MULT);
  const maxDist = entry * MAX_RISK_PCT;

  if (minDist > maxDist) {
    return { ok: false, reason: 'stop_distance_conflict' };
  }

  const normalizedStop = entry - minDist;
  const normalized = parsedStop > normalizedStop;
  const effectiveStop = normalized ? normalizedStop : parsedStop;
  const finalStop = Math.max(effectiveStop, entry * (1 - MAX_RISK_PCT));

  return {
    ok: true,
    effectiveStop: finalStop,
    atr14AtEntry: atr14,
    normalized,
    parsedStop,
    normalizedStop,
  };
}
