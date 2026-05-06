/**
 * Fire-and-forget LLM post-mortem for STOPPED_OUT trailing_stop_log rows (writes `narrative` only).
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { getDb } from '../db/connection.js';
import { getStopLogById, setTrailingStopLogNarrative } from '../db/trailing-stop-queries.js';
import { getLlmProvider } from '../llm/index.js';
import { child } from '../logger.js';
import { GAP_DOWN_THROUGH_STOP_NOTE } from '../types/trailing-stop.js';

const log = child({ component: 'trailing-stop-postmortem' });

/** Matches MockLlmProvider branch — keep prefix stable. */
export const TRAILING_STOP_POSTMORTEM_SYSTEM_PREFIX =
  'You are a risk analyst writing a post-mortem for a paper-traded NSE cash-market long position that hit its stop';

const TRAILING_STOP_POSTMORTEM_SYSTEM = `${TRAILING_STOP_POSTMORTEM_SYSTEM_PREFIX}.

Facts arrive as JSON only — do not invent prices or dates.
Write 2–4 complete sentences in plain English: what the stop-out reflects about volatility (ATR context),
how trailing behaved versus the entry thesis, and whether a gap-through-stop flag matters.
No buy/sell recommendations. No bullet points.`;

function validateNarrative(text: string): void {
  const t = text.trim();
  if (t.length < 35) throw new Error('post-mortem narrative too short');
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 8) throw new Error('post-mortem narrative too few words');
}

export interface StopOutPostMortemPayload {
  symbol: string;
  logDate: string;
  tradeId: number;
  stopFillPrice: number;
  prevStop: number;
  highestCloseInLog: number;
  atr14AtEvent: number | null;
  multiplierUsed: number;
  unrealisedPctAtEvent: number;
  gapDownThroughStop: boolean;
  tradeStatus: string;
  entryPrice: number;
  outcomeDate: string | null;
  exitPrice: number | null;
  pnlPct: number | null;
  exitReason: string | null;
  tradeNotes: string | null;
}

function buildPayload(
  row: NonNullable<ReturnType<typeof getStopLogById>>,
  trade: {
    entryPrice: number;
    status: string;
    outcomeDate: string | null;
    exitPrice: number | null;
    pnlPct: number | null;
    exitReason: string | null;
    notes: string | null;
  },
): StopOutPostMortemPayload {
  return {
    symbol: row.symbol,
    logDate: row.logDate,
    tradeId: row.tradeId,
    stopFillPrice: row.newStop,
    prevStop: row.prevStop,
    highestCloseInLog: row.highestClose,
    atr14AtEvent: row.atr14Today,
    multiplierUsed: row.multiplierUsed,
    unrealisedPctAtEvent: row.unrealisedPct,
    gapDownThroughStop: row.notes === GAP_DOWN_THROUGH_STOP_NOTE,
    tradeStatus: trade.status,
    entryPrice: trade.entryPrice,
    outcomeDate: trade.outcomeDate,
    exitPrice: trade.exitPrice,
    pnlPct: trade.pnlPct,
    exitReason: trade.exitReason,
    tradeNotes: trade.notes,
  };
}

/**
 * Loads log + paper trade, calls LLM, persists `trailing_stop_log.narrative`.
 * On any failure, narrative stays null — briefing shows the pending placeholder.
 */
export async function runTrailingStopPostMortem(logId: number, db?: DatabaseType): Promise<void> {
  const conn = db ?? getDb();
  const row = getStopLogById(logId, conn);
  if (!row || row.action !== 'STOPPED_OUT') return;

  const tradeRow = conn
    .prepare(
      `
    SELECT entry_price AS entryPrice, status, outcome_date AS outcomeDate,
           exit_price AS exitPrice, pnl_pct AS pnlPct, exit_reason AS exitReason, notes
    FROM paper_trades WHERE id = ?
  `,
    )
    .get(row.tradeId) as
    | {
        entryPrice: number;
        status: string;
        outcomeDate: string | null;
        exitPrice: number | null;
        pnlPct: number | null;
        exitReason: string | null;
        notes: string | null;
      }
    | undefined;

  if (!tradeRow) {
    log.warn({ logId, tradeId: row.tradeId }, 'post-mortem: paper_trades row missing');
    return;
  }

  const payload = buildPayload(row, tradeRow);
  const llm = getLlmProvider();

  try {
    const result = await llm.generateText({
      system: TRAILING_STOP_POSTMORTEM_SYSTEM,
      user: `stop_out_facts_json:\n${JSON.stringify(payload)}`,
      temperature: 0.25,
      maxOutputTokens: 280,
    });
    const text = result.text.trim();
    validateNarrative(text);
    setTrailingStopLogNarrative(logId, text, conn);
    log.info({ logId, symbol: row.symbol }, 'trailing stop post-mortem written');
  } catch (err) {
    log.warn(
      { err: (err as Error).message, logId, symbol: row.symbol },
      'trailing stop post-mortem failed',
    );
  }
}

/** Non-blocking; when no DB is passed, the async body uses `getDb()` (reconnects if the main handle was closed). */
export function scheduleTrailingStopPostMortem(logId: number): void {
  void runTrailingStopPostMortem(logId).catch((err) => {
    log.warn({ err: String(err), logId }, 'trailing stop post-mortem rejected');
  });
}
