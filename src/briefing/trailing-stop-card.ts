/**
 * HTML for paper-trade trailing activity (RAISED / TIGHTENED / STOPPED_OUT from EOD log,
 * plus live NEAR_STOP rows from open positions vs today's close and ATR).
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { getNearStopOpenTrades, getStopLogForDate } from '../db/trailing-stop-queries.js';
import {
  GAP_DOWN_THROUGH_STOP_NOTE,
  type NearStopOpenRow,
  TRAILING_STOP_ANALYSIS_PENDING,
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

const ACTION_ORDER: Record<string, number> = {
  STOPPED_OUT: 0,
  TIGHTENED: 1,
  RAISED: 2,
};

function sortLogs(rows: TrailingStopLogRow[]): TrailingStopLogRow[] {
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

function detailForLog(row: TrailingStopLogRow): string {
  const parts: string[] = [];
  parts.push(
    `${fmtRupee(row.prevStop)} → ${fmtRupee(row.newStop)} (${signedDelta(row.stopDelta)})`,
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

function renderLogRows(rows: TrailingStopLogRow[]): string {
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
  logs: TrailingStopLogRow[],
  nearStop: NearStopOpenRow[],
  sessionDate: string,
): string {
  const briefingLogs = logs.filter(
    (r) => r.action === 'RAISED' || r.action === 'TIGHTENED' || r.action === 'STOPPED_OUT',
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
    <p class="section-lede muted">Adaptive trailing from EOD evaluation. HELD rows are omitted here.</p>
    ${logBlock}
    ${nearBlock}
  </section>`;
}

/** Loads today&apos;s log plus live near-stop OPEN rows and returns HTML, or an empty string. */
export function renderTrailingStopBriefingBlock(sessionDate: string, db: DatabaseType): string {
  const logs = getStopLogForDate(sessionDate, db);
  const near = getNearStopOpenTrades(sessionDate, db);
  return renderTrailingStopSection(logs, near, sessionDate);
}
