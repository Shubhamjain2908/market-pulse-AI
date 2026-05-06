/**
 * HTML for paper-trade trailing activity (RAISED / TIGHTENED / STOPPED_OUT from EOD log,
 * plus live NEAR_STOP rows from open positions vs today's close and ATR).
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { getNearStopOpenTrades, getStopLogForBriefingDate } from '../db/trailing-stop-queries.js';
import {
  GAP_DOWN_THROUGH_STOP_NOTE,
  type NearStopOpenRow,
  TRAILING_STOP_ANALYSIS_PENDING,
  type TrailingStopLogBriefingRow,
  type TrailingStopLogRow,
} from '../types/trailing-stop.js';

function esc(s: string | number | undefined | null): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtRupee(n: number): string {
  return `₹${n.toFixed(2)}`;
}

function signedDelta(d: number): string {
  const sign = d >= 0 ? '+' : '−';
  return `${sign}${Math.abs(d).toFixed(2)}`;
}

/** Signed percent for trade P&L lines (not rupee deltas). */
function signedPct(p: number): string {
  const sign = p >= 0 ? '+' : '−';
  return `${sign}${Math.abs(p).toFixed(2)}%`;
}

/** Briefing-only: ignore tiny RAISED/TIGHTENED noise (DB still logs everything). */
const MIN_STOP_DELTA_ABS_INR = 1;
const MIN_STOP_DELTA_FRAC_OF_STOP = 0.005;

export function minMaterialStopDeltaRupee(referenceStop: number): number {
  const ref = referenceStop > 0 ? referenceStop : 1;
  return Math.max(MIN_STOP_DELTA_ABS_INR, ref * MIN_STOP_DELTA_FRAC_OF_STOP);
}

export function shouldIncludeTrailingLogInBriefing(row: TrailingStopLogRow): boolean {
  if (row.action === 'STOPPED_OUT') return true;
  if (row.action !== 'RAISED' && row.action !== 'TIGHTENED') return false;
  const threshold = minMaterialStopDeltaRupee(row.prevStop > 0 ? row.prevStop : row.newStop);
  return Math.abs(row.stopDelta) >= threshold;
}

const ACTION_ORDER: Record<string, number> = {
  STOPPED_OUT: 0,
  TIGHTENED: 1,
  RAISED: 2,
};

function sortLogs(rows: TrailingStopLogBriefingRow[]): TrailingStopLogBriefingRow[] {
  return [...rows].sort((a, b) => {
    const pa = ACTION_ORDER[a.action] ?? 9;
    const pb = ACTION_ORDER[b.action] ?? 9;
    if (pa !== pb) return pa - pb;
    if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol);
    return a.tradeId - b.tradeId;
  });
}

function actionBadgeClass(action: TrailingStopLogRow['action']): string {
  switch (action) {
    case 'STOPPED_OUT':
      return 'trailing-badge trailing-badge--stop';
    case 'TIGHTENED':
      return 'trailing-badge trailing-badge--tight';
    default:
      return 'trailing-badge trailing-badge--raise';
  }
}

function detailForLog(row: TrailingStopLogBriefingRow): string {
  const parts: string[] = [];

  if (row.action === 'STOPPED_OUT') {
    const tradeBits: string[] = [];
    if (row.tradePnlPct != null && Number.isFinite(row.tradePnlPct)) {
      tradeBits.push(`trade P&L ${signedPct(row.tradePnlPct)}`);
    }
    if (
      row.tradeEntryPrice != null &&
      Number.isFinite(row.tradeEntryPrice) &&
      row.tradeExitPrice != null &&
      Number.isFinite(row.tradeExitPrice)
    ) {
      tradeBits.push(
        `entry ${fmtRupee(row.tradeEntryPrice)} → exit ${fmtRupee(row.tradeExitPrice)}`,
      );
    }
    if (tradeBits.length > 0) {
      parts.push(tradeBits.join(' · '));
    }
  }

  parts.push(
    `stop ${fmtRupee(row.prevStop)} → ${fmtRupee(row.newStop)} (${signedDelta(row.stopDelta)} vs session open)`,
  );

  if (row.action !== 'STOPPED_OUT') {
    parts.push(
      `candidate ${fmtRupee(row.candidateStop)} · ${row.multiplierUsed}× ATR · unrealised ${row.unrealisedPct.toFixed(1)}%`,
    );
  }
  if (row.notes === GAP_DOWN_THROUGH_STOP_NOTE) {
    parts.push('gap-down open through stop');
  }
  if (row.action === 'STOPPED_OUT') {
    if (Math.abs(row.stopDelta) < 1e-9) {
      parts.push('fill at stop without intraday raise');
    }
    if (row.narrative?.trim()) {
      parts.push(row.narrative.trim());
    } else {
      parts.push(TRAILING_STOP_ANALYSIS_PENDING);
    }
  } else if (row.narrative?.trim()) {
    parts.push(row.narrative.trim());
  }
  return parts.join(' · ');
}

function renderLogRows(rows: TrailingStopLogBriefingRow[]): string {
  const sorted = sortLogs(rows);
  const body = sorted
    .map((row) => {
      const badge =
        row.action === 'STOPPED_OUT'
          ? 'Stopped out'
          : row.action === 'TIGHTENED'
            ? 'Tightened'
            : 'Raised';
      return `
        <tr>
          <td><strong>${esc(row.symbol)}</strong> <span class="muted">#${row.tradeId}</span></td>
          <td><span class="${actionBadgeClass(row.action)}">${esc(badge)}</span></td>
          <td>${esc(detailForLog(row))}</td>
        </tr>`;
    })
    .join('');
  return `
    <table class="trailing-stop-table">
      <thead><tr><th>Symbol</th><th>Event</th><th>Detail</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function renderNearRows(rows: NearStopOpenRow[]): string {
  const body = rows
    .map(
      (r) => `
      <tr>
        <td><strong>${esc(r.symbol)}</strong> <span class="muted">#${r.tradeId}</span></td>
        <td><span class="trailing-badge trailing-badge--near">Near stop</span></td>
        <td>${esc(
          `close ${fmtRupee(r.todayClose)} vs stop ${fmtRupee(r.stopLoss)} · cushion ${fmtRupee(r.cushion)} (≤ ATR ${fmtRupee(r.atr14Today)})`,
        )}</td>
      </tr>`,
    )
    .join('');
  return `
    <table class="trailing-stop-table">
      <thead><tr><th>Symbol</th><th>Event</th><th>Detail</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

/**
 * Renders the full trailing-stop section from pre-fetched rows (easier to unit test).
 */
export function renderTrailingStopSection(
  logs: TrailingStopLogBriefingRow[],
  nearStop: NearStopOpenRow[],
  sessionDate: string,
): string {
  const briefingLogs = logs.filter(
    (r) =>
      (r.action === 'RAISED' || r.action === 'TIGHTENED' || r.action === 'STOPPED_OUT') &&
      shouldIncludeTrailingLogInBriefing(r),
  );
  if (briefingLogs.length === 0 && nearStop.length === 0) return '';

  const logBlock =
    briefingLogs.length > 0
      ? `
      <h3 class="h-small trailing-stop-sub">EOD log (${esc(sessionDate)})</h3>
      ${renderLogRows(briefingLogs)}`
      : '';

  const nearBlock =
    nearStop.length > 0
      ? `
      <h3 class="h-small trailing-stop-sub">Near stop (open positions)</h3>
      <p class="section-lede muted">Today&apos;s close is within one ATR of the active stop — monitor intraday risk.</p>
      ${renderNearRows(nearStop)}`
      : '';

  return `
  <section class="card trailing-stop-card" aria-label="Paper trade trailing stops">
    <h2>Paper trades · trailing stops</h2>
    <p class="section-lede muted">Adaptive trailing from EOD evaluation. HELD rows are omitted here; tiny stop lifts below ₹1 or 0.5% of the prior stop are omitted as noise.</p>
    ${logBlock}
    ${nearBlock}
  </section>`;
}

/** Loads today's log plus live near-stop OPEN rows and returns HTML, or an empty string. */
export function renderTrailingStopBriefingBlock(sessionDate: string, db: DatabaseType): string {
  const logs = getStopLogForBriefingDate(sessionDate, db);
  const near = getNearStopOpenTrades(sessionDate, db);
  return renderTrailingStopSection(logs, near, sessionDate);
}
