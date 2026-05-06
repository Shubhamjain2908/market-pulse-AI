/**
 * Types for adaptive trailing stops (paper_trades extensions + trailing_stop_log).
 */

export const EXIT_REASONS = [
  'TRAILING_STOP',
  'INITIAL_STOP',
  'TARGET_HIT',
  'TIME_EXIT',
  'MANUAL',
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

/** Append-only trailing_stop_log.action values */
export const STOP_LOG_ACTIONS = ['RAISED', 'HELD', 'TIGHTENED', 'STOPPED_OUT'] as const;
export type StopLogAction = (typeof STOP_LOG_ACTIONS)[number];

/** Plain result from trailing-stop arithmetic (pure engine implements this in Phase 2). */
export interface TrailingStopResult {
  newStop: number;
  candidateStop: number;
  multiplier: 1.5 | 2;
  unrealisedPct: number;
  wasRaised: boolean;
  wasTightened: boolean;
  action: 'RAISED' | 'HELD' | 'TIGHTENED';
}

export interface TrailingStopLogRow {
  id: number;
  tradeId: number;
  symbol: string;
  logDate: string;
  prevStop: number;
  newStop: number;
  stopDelta: number;
  candidateStop: number;
  highestClose: number;
  atr14Today: number | null;
  multiplierUsed: number;
  unrealisedPct: number;
  action: StopLogAction;
  narrative: string | null;
  createdAt: string;
}

export interface TrailingStopLogInsert {
  tradeId: number;
  symbol: string;
  logDate: string;
  prevStop: number;
  newStop: number;
  stopDelta: number;
  candidateStop: number;
  highestClose: number;
  atr14Today: number | null;
  multiplierUsed: number;
  unrealisedPct: number;
  action: StopLogAction;
}

/** Rows from trailing_stop_log (briefing renders RAISED / TIGHTENED / STOPPED_OUT). */
export type TrailingLogAlertRow = Omit<TrailingStopLogRow, 'tradeId'> & {
  tradeId: number;
};

/** NEAR_STOP is computed fresh (not persisted in trailing_stop_log). */
export interface NearStopOpenRow {
  kind: 'NEAR_STOP';
  tradeId: number;
  symbol: string;
  stopLoss: number;
  todayClose: number;
  atr14Today: number;
  /** todayClose - stopLoss */
  cushion: number;
}

/** Data passed to briefing trailing-stop renderer (log rows vs live NEAR_STOP). */
export type TrailingBriefingAlert = TrailingStopLogRow | NearStopOpenRow;
