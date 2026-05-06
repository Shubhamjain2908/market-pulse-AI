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

/**
 * Written to `trailing_stop_log.notes` on STOPPED_OUT when the session opened below the
 * active stop but we still book the fill at `stop_loss` (paper convention). Queryable for
 * signal-quality backtests.
 */
export const GAP_DOWN_THROUGH_STOP_NOTE = 'gap_down_open:true';

/** Briefing copy when STOPPED_OUT has no narrative yet (LLM pending, failed, or --skip-ai). Spec §Prompt 4. */
export const TRAILING_STOP_ANALYSIS_PENDING = 'Analysis pending...';

/** Plain result from trailing-stop arithmetic (pure engine implements this in Phase 2). */
export interface TrailingStopResult {
  newStop: number;
  candidateStop: number;
  multiplier: 1.5 | 2;
  unrealisedPct: number;
  wasRaised: boolean;
  /** True when DB had mult 2.0 but this bar applies 1.5 rule (gain ≥15%); may coexist with HELD. */
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
  /** Machine-oriented tags (e.g. {@link GAP_DOWN_THROUGH_STOP_NOTE}); separate from LLM narrative. */
  notes: string | null;
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
  /** Optional; e.g. {@link GAP_DOWN_THROUGH_STOP_NOTE} when applicable. */
  notes?: string | null;
}

/** Rows from trailing_stop_log (briefing renders RAISED / TIGHTENED / STOPPED_OUT). */
export type TrailingLogAlertRow = Omit<TrailingStopLogRow, 'tradeId'> & {
  tradeId: number;
};

/** Optional join from `paper_trades` for briefing STOPPED_OUT copy (trade P&L vs stop-audit delta). */
export interface TrailingStopLogBriefingExtras {
  tradeEntryPrice?: number | null;
  tradeExitPrice?: number | null;
  tradePnlPct?: number | null;
}

export type TrailingStopLogBriefingRow = TrailingStopLogRow & TrailingStopLogBriefingExtras;

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
