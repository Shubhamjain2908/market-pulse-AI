/**
 * Weekday 16:30 IST: paper trade evaluation + structured EOD health report (log + optional email).
 * Scheduler job key: `weekday-1630-evaluate`.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { sendHtmlEmail } from '../briefing/delivery/email.js';
import { config } from '../config/env.js';
import { getDb } from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { child } from '../logger.js';
import { runEvaluatePaperTrades } from '../scripts/evaluate-trades.js';

const log = child({ component: 'eod-evaluate' });

export interface EodHealthQuerySnapshot {
  tradesClosedToday: Array<{
    symbol: string;
    signal_type: string;
    exit_reason: string | null;
    pnl_pct: number | null;
  }>;
  openTradesSummary: Array<{
    symbol: string;
    signal_type: string;
    entry_price: number;
    stop_loss: number;
    highest_close_since_entry: number | null;
    days_open: number | null;
    max_hold_days: number;
  }>;
  expectancyBySignalType: Array<{
    signal_type: string;
    trades: number;
    avg_pnl: number | null;
    win_rate: number | null;
  }>;
  tradesNearTimeStop: Array<{
    symbol: string;
    signal_type: string;
    days_open: number;
    max_hold_days: number;
  }>;
  currentRegime: Array<{
    date: string;
    regime: string;
    score_total: number;
    regime_age: number;
  }>;
  stopRaisesToday: { raises: number };
  guardrailHitsToday: Array<{ kind: string; hits: number }>;
}

export function collectEodHealthSnapshot(db: DatabaseType): EodHealthQuerySnapshot {
  const tradesClosedToday = db
    .prepare(
      `
    SELECT symbol, signal_type, exit_reason, pnl_pct
    FROM paper_trades
    WHERE outcome_date = date('now', 'localtime')
  `,
    )
    .all() as EodHealthQuerySnapshot['tradesClosedToday'];

  const openTradesSummary = db
    .prepare(
      `
    SELECT symbol, signal_type, entry_price, stop_loss, highest_close_since_entry,
           julianday('now', 'localtime') - julianday(source_date) AS days_open,
           max_hold_days
    FROM paper_trades
    WHERE status = 'OPEN'
  `,
    )
    .all() as EodHealthQuerySnapshot['openTradesSummary'];

  const expectancyBySignalType = db
    .prepare(
      `
    SELECT signal_type,
           COUNT(*) AS trades,
           ROUND(AVG(pnl_pct), 2) AS avg_pnl,
           ROUND(100.0 * SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS win_rate
    FROM paper_trades
    WHERE status != 'OPEN'
    GROUP BY signal_type
  `,
    )
    .all() as EodHealthQuerySnapshot['expectancyBySignalType'];

  const tradesNearTimeStop = db
    .prepare(
      `
    SELECT symbol, signal_type, days_open, max_hold_days
    FROM (
      SELECT *,
             CAST(julianday('now', 'localtime') - julianday(source_date) AS INTEGER) AS days_open
      FROM paper_trades
      WHERE status = 'OPEN'
    )
    WHERE max_hold_days > 0
      AND CAST(days_open AS REAL) / max_hold_days >= 0.8
  `,
    )
    .all() as EodHealthQuerySnapshot['tradesNearTimeStop'];

  const currentRegime = db
    .prepare(
      `
    SELECT date, regime, score_total, regime_age
    FROM regime_daily
    ORDER BY date DESC
    LIMIT 1
  `,
    )
    .all() as EodHealthQuerySnapshot['currentRegime'];

  const stopRaisesToday = db
    .prepare(
      `
    SELECT COUNT(*) AS raises
    FROM trailing_stop_log
    WHERE log_date = date('now', 'localtime')
      AND action = 'RAISE'
  `,
    )
    .get() as EodHealthQuerySnapshot['stopRaisesToday'];

  const guardrailHitsToday = db
    .prepare(
      `
    SELECT kind, COUNT(*) AS hits
    FROM alerts
    WHERE date = date('now', 'localtime')
    GROUP BY kind
  `,
    )
    .all() as EodHealthQuerySnapshot['guardrailHitsToday'];

  return {
    tradesClosedToday,
    openTradesSummary,
    expectancyBySignalType,
    tradesNearTimeStop,
    currentRegime,
    stopRaisesToday,
    guardrailHitsToday,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return String(n);
}

function buildEodHealthReportHtml(reportDate: string, snap: EodHealthQuerySnapshot): string {
  const tableStyle =
    'width:100%;border-collapse:collapse;margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.4;color:#222;';
  const thStyle =
    'text-align:left;border:1px solid #ddd;padding:8px;background:#f5f5f5;font-weight:600;';
  const tdStyle = 'border:1px solid #ddd;padding:8px;vertical-align:top;word-break:break-word;';
  const h2Style =
    'font-family:Arial,Helvetica,sans-serif;font-size:16px;margin:24px 0 8px 0;color:#111;border-bottom:2px solid #1a73e8;padding-bottom:4px;';

  const rowsToTable = (headers: string[], rows: string[][]): string => {
    if (rows.length === 0) {
      return `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#666;margin:0 0 16px 0;">No rows.</p>`;
    }
    const head = `<tr>${headers.map((h) => `<th style="${thStyle}">${escapeHtml(h)}</th>`).join('')}</tr>`;
    const body = rows
      .map(
        (r) => `<tr>${r.map((c) => `<td style="${tdStyle}">${escapeHtml(c)}</td>`).join('')}</tr>`,
      )
      .join('');
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="${tableStyle}">${head}${body}</table>`;
  };

  const regime = snap.currentRegime[0];
  const regimeBlock =
    regime != null
      ? rowsToTable(
          ['date', 'regime', 'score_total', 'regime_age'],
          [[regime.date, regime.regime, fmtNum(regime.score_total), String(regime.regime_age)]],
        )
      : `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#666;">No regime row.</p>`;

  const closedRows = snap.tradesClosedToday.map((r) => [
    r.symbol,
    r.signal_type,
    r.exit_reason ?? '—',
    fmtNum(r.pnl_pct),
  ]);
  const openRows = snap.openTradesSummary.map((r) => [
    r.symbol,
    r.signal_type,
    fmtNum(r.entry_price),
    fmtNum(r.stop_loss),
    fmtNum(r.highest_close_since_entry),
    fmtNum(r.days_open),
    String(r.max_hold_days),
  ]);
  const expRows = snap.expectancyBySignalType.map((r) => [
    r.signal_type,
    String(r.trades),
    fmtNum(r.avg_pnl),
    fmtNum(r.win_rate),
  ]);
  const nearRows = snap.tradesNearTimeStop.map((r) => [
    r.symbol,
    r.signal_type,
    String(r.days_open),
    String(r.max_hold_days),
  ]);
  const guardRows = snap.guardrailHitsToday.map((r) => [r.kind, String(r.hits)]);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>EOD Health Report ${escapeHtml(reportDate)}</title>
</head>
<body style="margin:0;padding:16px;background:#fafafa;">
  <div style="max-width:640px;margin:0 auto;background:#fff;padding:16px;border-radius:8px;border:1px solid #e0e0e0;">
    <h1 style="font-family:Arial,Helvetica,sans-serif;font-size:20px;margin:0 0 8px 0;color:#111;">EOD Health Report</h1>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#555;margin:0 0 20px 0;">Session date: <strong>${escapeHtml(reportDate)}</strong></p>

    <h2 style="${h2Style}">1. Trades closed today</h2>
    ${rowsToTable(['symbol', 'signal_type', 'exit_reason', 'pnl_pct'], closedRows)}

    <h2 style="${h2Style}">2. Open trades summary</h2>
    ${rowsToTable(
      [
        'symbol',
        'signal_type',
        'entry_price',
        'stop_loss',
        'highest_close_since_entry',
        'days_open',
        'max_hold_days',
      ],
      openRows,
    )}

    <h2 style="${h2Style}">3. Expectancy by signal type (closed)</h2>
    ${rowsToTable(['signal_type', 'trades', 'avg_pnl', 'win_rate'], expRows)}

    <h2 style="${h2Style}">4. Trades near time-stop (≥80% of max hold)</h2>
    ${rowsToTable(['symbol', 'signal_type', 'days_open', 'max_hold_days'], nearRows)}

    <h2 style="${h2Style}">5. Current regime</h2>
    ${regimeBlock}

    <h2 style="${h2Style}">6. Stop raises today</h2>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;margin:0 0 16px 0;"><strong>Raises:</strong> ${String(snap.stopRaisesToday.raises)}</p>

    <h2 style="${h2Style}">7. Guardrail hits today (alerts)</h2>
    ${rowsToTable(['kind', 'hits'], guardRows)}

    <p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#888;margin:24px 0 0 0;">Market Pulse — automated EOD health. Tables are inline for Gmail on phone and desktop.</p>
  </div>
</body>
</html>`;
}

function buildEodHealthReportPlainText(reportDate: string, snap: EodHealthQuerySnapshot): string {
  return JSON.stringify({ reportDate, ...snap }, null, 2);
}

export async function runEodEvaluate(db: DatabaseType = getDb()): Promise<void> {
  const reportDate = isoDateIst();
  const evaluateResult = runEvaluatePaperTrades(reportDate, db, { skipAi: false });
  const health = collectEodHealthSnapshot(db);

  log.info(
    {
      event: 'eod_health_report',
      reportDate,
      evaluateResult,
      tradesClosedToday: health.tradesClosedToday,
      openTradesSummary: health.openTradesSummary,
      expectancyBySignalType: health.expectancyBySignalType,
      tradesNearTimeStop: health.tradesNearTimeStop,
      currentRegime: health.currentRegime,
      stopRaisesToday: health.stopRaisesToday,
      guardrailHitsToday: health.guardrailHitsToday,
    },
    'eod health report',
  );

  if (config.BRIEFING_DELIVERY !== 'email') {
    log.info(
      { delivery: config.BRIEFING_DELIVERY },
      'eod health report email skipped (BRIEFING_DELIVERY is not email)',
    );
    return;
  }

  try {
    const html = buildEodHealthReportHtml(reportDate, health);
    const text = buildEodHealthReportPlainText(reportDate, health);
    await sendHtmlEmail({
      subject: `[MarketPulse] EOD Health Report — ${reportDate}`,
      html,
      text,
    });
    log.info({ reportDate }, 'eod health report email sent');
  } catch (err) {
    log.error({ err, reportDate }, 'eod health report email failed');
  }
}
