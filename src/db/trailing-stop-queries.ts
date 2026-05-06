/**
 * SQLite accessors for adaptive trailing-stop columns and trailing_stop_log.
 * Business rules live in the evaluator / engine — keep this layer thin.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import type {
  NearStopOpenRow,
  TrailingStopLogInsert,
  TrailingStopLogRow,
} from '../types/trailing-stop.js';
import { getDb } from './connection.js';

const ATR14_NAME = 'atr_14';

function parseLogRow(row: Record<string, unknown>): TrailingStopLogRow {
  return {
    id: Number(row.id),
    tradeId: Number(row.trade_id),
    symbol: String(row.symbol),
    logDate: String(row.log_date),
    prevStop: Number(row.prev_stop),
    newStop: Number(row.new_stop),
    stopDelta: Number(row.stop_delta),
    candidateStop: Number(row.candidate_stop),
    highestClose: Number(row.highest_close),
    atr14Today: row.atr14_today == null ? null : Number(row.atr14_today),
    multiplierUsed: Number(row.multiplier_used),
    unrealisedPct: Number(row.unrealised_pct),
    action: row.action as TrailingStopLogRow['action'],
    narrative: row.narrative == null ? null : String(row.narrative),
    notes: row.notes == null || row.notes === '' ? null : String(row.notes),
    createdAt: String(row.created_at),
  };
}

/** Step 1 of EOD: clear yesterday's alert latch on all OPEN rows. */
export function resetStopRaisedTodayForOpenTrades(db: DatabaseType = getDb()): void {
  db.prepare(`UPDATE paper_trades SET stop_raised_today = 0 WHERE status = 'OPEN'`).run();
}

/**
 * Today's `signals` atr_14, or the most recent value within the prior 3 calendar days.
 * Returns undefined when no usable row exists in that window (caller skips trailing math).
 */
export function getAtr14(
  symbol: string,
  refDate: string,
  db: DatabaseType = getDb(),
): number | undefined {
  const sym = symbol.toUpperCase();

  const direct = db
    .prepare(
      `
      SELECT value FROM signals
      WHERE symbol = ? AND date = ? AND name = ?
    `,
    )
    .get(sym, refDate, ATR14_NAME) as { value: number } | undefined;
  if (direct) return direct.value;

  const row = db
    .prepare(
      `
      SELECT value FROM signals
      WHERE symbol = ? AND name = ?
        AND date <= ?
        AND date >= date(?, '-3 days')
      ORDER BY date DESC
      LIMIT 1
    `,
    )
    .get(sym, ATR14_NAME, refDate, refDate) as { value: number } | undefined;

  return row?.value;
}

/** Max daily close strictly after `exclusiveStartDate` through `inclusiveEndDate` inclusive. */
export function getMaxCloseBetween(
  symbol: string,
  exclusiveStartDate: string,
  inclusiveEndDate: string,
  db: DatabaseType = getDb(),
): number | null {
  const sym = symbol.toUpperCase();
  const row = db
    .prepare(
      `
      SELECT MAX(close) AS m FROM quotes
      WHERE symbol = ? AND exchange = 'NSE'
        AND date > ? AND date <= ?
    `,
    )
    .get(sym, exclusiveStartDate, inclusiveEndDate) as { m: number | null } | undefined;
  const m = row?.m ?? null;
  return m != null ? m : null;
}

export interface PaperTradeTrailingPatch {
  stopLoss?: number;
  highestCloseSinceEntry?: number | null;
  atr14AtEntry?: number | null;
  trailingMultiplier?: number;
  /** 0/1 latch for briefing alerts */
  stopRaisedToday?: 0 | 1;
}

export function patchPaperTradeTrailing(
  tradeId: number,
  patch: PaperTradeTrailingPatch,
  db: DatabaseType = getDb(),
): void {
  const assigns: string[] = [];
  const params: Record<string, unknown> = { id: tradeId };

  if (patch.stopLoss !== undefined) {
    assigns.push('stop_loss = @stopLoss');
    params.stopLoss = patch.stopLoss;
  }
  if (patch.highestCloseSinceEntry !== undefined) {
    assigns.push('highest_close_since_entry = @highestCloseSinceEntry');
    params.highestCloseSinceEntry = patch.highestCloseSinceEntry;
  }
  if (patch.atr14AtEntry !== undefined) {
    assigns.push('atr14_at_entry = @atr14AtEntry');
    params.atr14AtEntry = patch.atr14AtEntry;
  }
  if (patch.trailingMultiplier !== undefined) {
    assigns.push('trailing_multiplier = @trailingMultiplier');
    params.trailingMultiplier = patch.trailingMultiplier;
  }
  if (patch.stopRaisedToday !== undefined) {
    assigns.push('stop_raised_today = @stopRaisedToday');
    params.stopRaisedToday = patch.stopRaisedToday;
  }

  if (assigns.length === 0) return;

  db.prepare(
    `UPDATE paper_trades SET ${assigns.join(', ')} WHERE id = @id AND status = 'OPEN'`,
  ).run(params);
}

/** Idempotent on (trade_id, log_date, action). Returns new row id when inserted, else null. */
export function insertStopLog(row: TrailingStopLogInsert, db: DatabaseType = getDb()): number | null {
  const result = db
    .prepare(
      `
    INSERT OR IGNORE INTO trailing_stop_log (
      trade_id, symbol, log_date,
      prev_stop, new_stop, stop_delta, candidate_stop, highest_close,
      atr14_today, multiplier_used, unrealised_pct, action, notes
    ) VALUES (
      @tradeId, @symbol, @logDate,
      @prevStop, @newStop, @stopDelta, @candidateStop, @highestClose,
      @atr14Today, @multiplierUsed, @unrealisedPct, @action, @notes
    )
  `,
    )
    .run({
      tradeId: row.tradeId,
      symbol: row.symbol.toUpperCase(),
      logDate: row.logDate,
      prevStop: row.prevStop,
      newStop: row.newStop,
      stopDelta: row.stopDelta,
      candidateStop: row.candidateStop,
      highestClose: row.highestClose,
      atr14Today: row.atr14Today,
      multiplierUsed: row.multiplierUsed,
      unrealisedPct: row.unrealisedPct,
      action: row.action,
      notes: row.notes ?? null,
    });
  if (result.changes === 0) return null;
  return Number(result.lastInsertRowid);
}

/** Single log row by primary key (post-mortem agent). */
export function getStopLogById(id: number, db: DatabaseType = getDb()): TrailingStopLogRow | undefined {
  const row = db.prepare(`SELECT * FROM trailing_stop_log WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? parseLogRow(row) : undefined;
}

/** All trailing events for `logDate` (EOD batch date key). */
export function getStopLogForDate(date: string, db: DatabaseType = getDb()): TrailingStopLogRow[] {
  const rows = db
    .prepare(
      `
      SELECT * FROM trailing_stop_log
      WHERE log_date = ?
      ORDER BY trade_id ASC, id ASC
    `,
    )
    .all(date) as Record<string, unknown>[];
  return rows.map(parseLogRow);
}

/** OPEN trades where cushion to stop is at most today’s ATR14 (live briefing helper). */
export function getNearStopOpenTrades(
  sessionDate: string,
  db: DatabaseType = getDb(),
): NearStopOpenRow[] {
  const rows = db
    .prepare(
      `
      SELECT pt.id AS tradeId,
             pt.symbol AS symbol,
             pt.stop_loss AS stopLoss,
             q.close AS todayClose,
             s.value AS atr14Today,
             (q.close - pt.stop_loss) AS cushion
      FROM paper_trades pt
      JOIN quotes q
        ON q.symbol = pt.symbol AND q.exchange = 'NSE' AND q.date = @sessionDate
      JOIN signals s
        ON s.symbol = pt.symbol AND s.date = @sessionDate AND s.name = @atrName
      WHERE pt.status = 'OPEN'
        AND q.close >= pt.stop_loss
        AND (q.close - pt.stop_loss) <= s.value
    `,
    )
    .all({
      sessionDate,
      atrName: ATR14_NAME,
    }) as Array<{
    tradeId: number;
    symbol: string;
    stopLoss: number;
    todayClose: number;
    atr14Today: number;
    cushion: number;
  }>;

  return rows.map((r) => ({
    kind: 'NEAR_STOP',
    tradeId: r.tradeId,
    symbol: String(r.symbol).toUpperCase(),
    stopLoss: r.stopLoss,
    todayClose: r.todayClose,
    atr14Today: r.atr14Today,
    cushion: r.cushion,
  }));
}

export function setTrailingStopLogNarrative(
  logId: number,
  narrative: string,
  db: DatabaseType = getDb(),
): void {
  db.prepare('UPDATE trailing_stop_log SET narrative = @n WHERE id = @logId').run({
    logId,
    n: narrative,
  });
}
