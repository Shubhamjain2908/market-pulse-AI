/**
 * EOD paper-trade evaluation + structured health report (pino + optional SMTP).
 * Run on demand via `pnpm evaluate` / `pnpm cli evaluate` (not scheduled).
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { sendHtmlEmail } from '../briefing/delivery/email.js';
import { config } from '../config/env.js';
import { getDb } from '../db/index.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { child } from '../logger.js';
import { runEvaluatePaperTrades } from '../scripts/evaluate-trades.js';
import { runTrailingStopPostMortem } from './trailing-stop-postmortem.js';

const log = child({ component: 'eod-evaluate' });

/** Baseline for clean AI_PICK stats (see EOD report section 6). */
export const AI_PICK_POST_FIX_CREATED_AT = '2026-05-12';

export interface EodHealthQuerySnapshot {
  signalPerformance30d: Array<{
    signal_type: string;
    trades: number;
    wr: number | null;
    avg_out: number | null;
    avg_win: number | null;
    avg_loss: number | null;
  }>;
  signalPerformance30dDeduped: Array<{
    signal_type: string;
    trades: number;
    wr: number | null;
    avg_out: number | null;
    avg_win: number | null;
    avg_loss: number | null;
  }>;
  openPositions: Array<{
    symbol: string;
    signal_type: string;
    entry: number;
    sl: number;
    sl_pct: number;
    source_date: string;
  }>;
  /** Symbols with more than one OPEN row (dedup regression watch). */
  openPositionDuplicates: Array<{ symbol: string; open_count: number }>;
  regimeRecent3: Array<{
    date: string;
    regime: string;
    regime_age: number;
    score_total: number;
    score_trend: number;
    score_vix: number;
    score_fii: number;
    score_breadth: number;
    vix_value: number;
    nifty_vs_sma200: number | null;
  }>;
  recentClosures: Array<{
    id: number;
    symbol: string;
    signal_type: string;
    source_date: string;
    outcome_date: string | null;
    entry: number | null;
    exit: number | null;
    pnl: number | null;
    exit_reason: string | null;
  }>;
  postFixAiPick: {
    trades: number;
    wr: number | null;
    avg_out: number | null;
  };
  corporateActions7d: Array<{
    symbol: string;
    ex_date: string;
    type: string;
    factor: number;
    source: string;
    applied_at: string;
  }>;
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
  stopRaisesToday: { raises: number };
  guardrailHitsToday: Array<{ kind: string; hits: number }>;
}

export function collectEodHealthSnapshot(db: DatabaseType): EodHealthQuerySnapshot {
  const signalPerformance30d = db
    .prepare(
      `
    SELECT signal_type,
           COUNT(*) AS trades,
           ROUND(AVG(CASE WHEN pnl_pct >= 0 THEN 1.0 ELSE 0.0 END) * 100, 1) AS wr,
           ROUND(AVG(pnl_pct), 2) AS avg_out,
           ROUND(AVG(CASE WHEN pnl_pct >= 0 THEN pnl_pct END), 2) AS avg_win,
           ROUND(AVG(CASE WHEN pnl_pct < 0 THEN pnl_pct END), 2) AS avg_loss
    FROM paper_trades
    WHERE status != 'OPEN'
      AND outcome_date >= date('now', 'localtime', '-30 days')
    GROUP BY signal_type
  `,
    )
    .all() as EodHealthQuerySnapshot['signalPerformance30d'];

  const signalPerformance30dDeduped = db
    .prepare(
      `
    WITH d AS (
      SELECT signal_type, pnl_pct,
        ROW_NUMBER() OVER (
          PARTITION BY symbol, signal_type, ROUND(entry_price, 0)
          ORDER BY source_date ASC
        ) AS rn
      FROM paper_trades
      WHERE status != 'OPEN'
        AND outcome_date >= date('now', 'localtime', '-30 days')
    )
    SELECT signal_type,
           COUNT(*) AS trades,
           ROUND(AVG(CASE WHEN pnl_pct >= 0 THEN 1.0 ELSE 0.0 END) * 100, 1) AS wr,
           ROUND(AVG(pnl_pct), 2) AS avg_out,
           ROUND(AVG(CASE WHEN pnl_pct >= 0 THEN pnl_pct END), 2) AS avg_win,
           ROUND(AVG(CASE WHEN pnl_pct < 0 THEN pnl_pct END), 2) AS avg_loss
    FROM d
    WHERE rn = 1
    GROUP BY signal_type
  `,
    )
    .all() as EodHealthQuerySnapshot['signalPerformance30dDeduped'];

  const openPositions = db
    .prepare(
      `
    SELECT symbol, signal_type,
           ROUND(entry_price, 2) AS entry,
           ROUND(stop_loss, 2) AS sl,
           ROUND((stop_loss - entry_price) / entry_price * 100, 1) AS sl_pct,
           source_date
    FROM paper_trades
    WHERE status = 'OPEN'
    ORDER BY signal_type, symbol
  `,
    )
    .all() as EodHealthQuerySnapshot['openPositions'];

  const openPositionDuplicates = db
    .prepare(
      `
    SELECT symbol, COUNT(*) AS open_count
    FROM paper_trades
    WHERE status = 'OPEN'
    GROUP BY symbol
    HAVING COUNT(*) > 1
    ORDER BY open_count DESC, symbol
  `,
    )
    .all() as EodHealthQuerySnapshot['openPositionDuplicates'];

  const regimeRecent3 = db
    .prepare(
      `
    SELECT date, regime, regime_age, score_total,
           score_trend, score_vix, score_fii, score_breadth,
           vix_value, ROUND(nifty_vs_sma200, 2) AS nifty_vs_sma200
    FROM regime_daily
    ORDER BY date DESC
    LIMIT 3
  `,
    )
    .all() as EodHealthQuerySnapshot['regimeRecent3'];

  const recentClosures = db
    .prepare(
      `
    SELECT id, symbol, signal_type,
           source_date, outcome_date,
           ROUND(entry_price, 2) AS entry,
           ROUND(exit_price, 2) AS exit,
           ROUND(pnl_pct, 2) AS pnl,
           exit_reason
    FROM paper_trades
    WHERE status != 'OPEN'
      AND outcome_date >= date('now', 'localtime', '-4 days')
    ORDER BY outcome_date DESC, signal_type
  `,
    )
    .all() as EodHealthQuerySnapshot['recentClosures'];

  const postFixAiPick = db
    .prepare(
      `
    SELECT COUNT(*) AS trades,
           ROUND(AVG(CASE WHEN pnl_pct >= 0 THEN 1.0 ELSE 0.0 END) * 100, 1) AS wr,
           ROUND(AVG(pnl_pct), 2) AS avg_out
    FROM paper_trades
    WHERE signal_type = 'AI_PICK'
      AND status != 'OPEN'
      AND created_at >= ?
  `,
    )
    .get(AI_PICK_POST_FIX_CREATED_AT) as EodHealthQuerySnapshot['postFixAiPick'];

  const corporateActions7d = db
    .prepare(
      `
    SELECT symbol, ex_date, type, factor, source, applied_at
    FROM corporate_actions
    WHERE applied_at >= date('now', 'localtime', '-7 days')
    ORDER BY applied_at DESC
  `,
    )
    .all() as EodHealthQuerySnapshot['corporateActions7d'];

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
    signalPerformance30d,
    signalPerformance30dDeduped,
    openPositions,
    openPositionDuplicates,
    regimeRecent3,
    recentClosures,
    postFixAiPick,
    corporateActions7d,
    tradesClosedToday,
    openTradesSummary,
    expectancyBySignalType,
    tradesNearTimeStop,
    stopRaisesToday,
    guardrailHitsToday,
  };
}

export interface RunEodEvaluateOptions {
  /** Session `asOf` for bar walk (defaults IST calendar today). */
  asOf?: string;
  /** When true, skip fire-and-forget LLM post-mortems on STOPPED_OUT. */
  skipAi?: boolean;
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

function dedupMaterialityLines(snap: EodHealthQuerySnapshot): string[] {
  const rawMap = new Map(snap.signalPerformance30d.map((r) => [r.signal_type, r.trades]));
  const lines: string[] = [];
  for (const d of snap.signalPerformance30dDeduped) {
    const rawN = rawMap.get(d.signal_type) ?? 0;
    const gap = rawN - d.trades;
    if (gap !== 0) {
      lines.push(`${d.signal_type}: raw ${rawN} trades vs deduped ${d.trades} (Δ ${gap})`);
    }
  }
  for (const r of snap.signalPerformance30d) {
    if (!snap.signalPerformance30dDeduped.some((x) => x.signal_type === r.signal_type)) {
      lines.push(`${r.signal_type}: present in raw 30d only (${r.trades} trades)`);
    }
  }
  if (lines.length === 0) {
    return ['No material row-count gap between raw and deduped 30d buckets (per signal_type).'];
  }
  return lines;
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

  const perf30 = snap.signalPerformance30d.map((r) => [
    r.signal_type,
    String(r.trades),
    fmtNum(r.wr),
    fmtNum(r.avg_out),
    fmtNum(r.avg_win),
    fmtNum(r.avg_loss),
  ]);
  const perf30d = snap.signalPerformance30dDeduped.map((r) => [
    r.signal_type,
    String(r.trades),
    fmtNum(r.wr),
    fmtNum(r.avg_out),
    fmtNum(r.avg_win),
    fmtNum(r.avg_loss),
  ]);
  const dedupNote = dedupMaterialityLines(snap).map(escapeHtml).join('<br/>');

  const openPosRows = snap.openPositions.map((r) => [
    r.symbol,
    r.signal_type,
    fmtNum(r.entry),
    fmtNum(r.sl),
    fmtNum(r.sl_pct),
    r.source_date,
  ]);
  const dupWarning =
    snap.openPositionDuplicates.length === 0
      ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#2e7d32;margin:0 0 12px 0;">No symbol has more than one OPEN row.</p>`
      : `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#c62828;margin:0 0 12px 0;"><strong>Dedup regression:</strong> symbol(s) with &gt;1 OPEN row — ${escapeHtml(JSON.stringify(snap.openPositionDuplicates))}</p>`;

  const regimeRows = snap.regimeRecent3.map((r) => [
    r.date,
    r.regime,
    String(r.regime_age),
    fmtNum(r.score_total),
    fmtNum(r.score_trend),
    fmtNum(r.score_vix),
    fmtNum(r.score_fii),
    fmtNum(r.score_breadth),
    fmtNum(r.vix_value),
    fmtNum(r.nifty_vs_sma200),
  ]);

  const closureRows = snap.recentClosures.map((r) => [
    String(r.id),
    r.symbol,
    r.signal_type,
    r.source_date,
    r.outcome_date ?? '—',
    fmtNum(r.entry),
    fmtNum(r.exit),
    fmtNum(r.pnl),
    r.exit_reason ?? '—',
  ]);

  const aiPickNote =
    snap.postFixAiPick.trades >= 10
      ? '10+ closed trades — suitable as primary performance slice.'
      : `Only ${snap.postFixAiPick.trades} closed trade(s); treat as early read until ≥10.`;

  const corpRows = snap.corporateActions7d.map((r) => [
    r.symbol,
    r.ex_date,
    r.type,
    fmtNum(r.factor),
    r.source,
    r.applied_at,
  ]);

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
  <div style="max-width:720px;margin:0 auto;background:#fff;padding:16px;border-radius:8px;border:1px solid #e0e0e0;">
    <h1 style="font-family:Arial,Helvetica,sans-serif;font-size:20px;margin:0 0 8px 0;color:#111;">EOD Health Report</h1>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#555;margin:0 0 20px 0;">Evaluate as-of: <strong>${escapeHtml(reportDate)}</strong> (IST calendar / session context per pipeline)</p>

    <h2 style="${h2Style}">1. Signal performance (30d)</h2>
    ${rowsToTable(['signal_type', 'trades', 'wr%', 'avg_out', 'avg_win', 'avg_loss'], perf30)}

    <h2 style="${h2Style}">2. Deduped signal performance (30d)</h2>
    ${rowsToTable(['signal_type', 'trades', 'wr%', 'avg_out', 'avg_win', 'avg_loss'], perf30d)}
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#444;margin:0 0 16px 0;line-height:1.5;"><strong>Dedup vs raw:</strong><br/>${dedupNote}</p>

    <h2 style="${h2Style}">3. Open positions</h2>
    ${dupWarning}
    ${rowsToTable(['symbol', 'signal_type', 'entry', 'sl', 'sl_pct', 'source_date'], openPosRows)}

    <h2 style="${h2Style}">4. Regime state (last 3 rows)</h2>
    ${rowsToTable(
      [
        'date',
        'regime',
        'regime_age',
        'score_total',
        'score_trend',
        'score_vix',
        'score_fii',
        'score_breadth',
        'vix_value',
        'nifty_vs_sma200',
      ],
      regimeRows,
    )}

    <h2 style="${h2Style}">5. Recent closures (outcome in last 4 local days)</h2>
    ${rowsToTable(
      [
        'id',
        'symbol',
        'signal_type',
        'source_date',
        'outcome_date',
        'entry',
        'exit',
        'pnl%',
        'exit_reason',
      ],
      closureRows,
    )}

    <h2 style="${h2Style}">6. AI_PICK post-fix (created_at ≥ ${escapeHtml(AI_PICK_POST_FIX_CREATED_AT)})</h2>
    ${rowsToTable(
      ['trades', 'wr%', 'avg_out'],
      [
        [
          String(snap.postFixAiPick.trades),
          fmtNum(snap.postFixAiPick.wr),
          fmtNum(snap.postFixAiPick.avg_out),
        ],
      ],
    )}
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#444;margin:0 0 16px 0;">${escapeHtml(aiPickNote)}</p>

    <h2 style="${h2Style}">7. Corporate actions (applied in last 7 local days)</h2>
    ${rowsToTable(['symbol', 'ex_date', 'type', 'factor', 'source', 'applied_at'], corpRows)}

    <h2 style="${h2Style}">Daily — trades closed today</h2>
    ${rowsToTable(['symbol', 'signal_type', 'exit_reason', 'pnl_pct'], closedRows)}

    <h2 style="${h2Style}">Daily — open trail monitor</h2>
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

    <h2 style="${h2Style}">Daily — lifetime expectancy by signal type</h2>
    ${rowsToTable(['signal_type', 'trades', 'avg_pnl', 'win_rate'], expRows)}

    <h2 style="${h2Style}">Daily — near time-stop (≥80% of max hold)</h2>
    ${rowsToTable(['symbol', 'signal_type', 'days_open', 'max_hold_days'], nearRows)}

    <h2 style="${h2Style}">Daily — stop raises today</h2>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;margin:0 0 16px 0;"><strong>Raises:</strong> ${String(snap.stopRaisesToday.raises)}</p>

    <h2 style="${h2Style}">Daily — guardrail hits today (alerts)</h2>
    ${rowsToTable(['kind', 'hits'], guardRows)}

    <p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#888;margin:24px 0 0 0;">Market Pulse — from <code>pnpm evaluate</code>. Inline tables for Gmail.</p>
  </div>
</body>
</html>`;
}

function buildEodHealthReportPlainText(reportDate: string, snap: EodHealthQuerySnapshot): string {
  return JSON.stringify(
    { reportDate, ...snap, dedupMateriality: dedupMaterialityLines(snap) },
    null,
    2,
  );
}

export async function runEodEvaluate(
  db: DatabaseType = getDb(),
  opts: RunEodEvaluateOptions = {},
): Promise<void> {
  const reportDate = opts.asOf ?? isoDateIst();
  const skipAi = opts.skipAi ?? false;
  const postMortemLogIds: number[] = [];
  const evaluateResult = runEvaluatePaperTrades(reportDate, db, {
    skipAi,
    postMortemLogIdsOut: skipAi ? undefined : postMortemLogIds,
  });
  if (!skipAi) {
    for (const logId of postMortemLogIds) {
      await runTrailingStopPostMortem(logId, db);
    }
  }
  const health = collectEodHealthSnapshot(db);

  log.info(
    {
      event: 'eod_health_report',
      reportDate,
      skipAi,
      postMortemsAwaited: postMortemLogIds.length,
      evaluateResult,
      signalPerformance30d: health.signalPerformance30d,
      signalPerformance30dDeduped: health.signalPerformance30dDeduped,
      openPositions: health.openPositions,
      openPositionDuplicates: health.openPositionDuplicates,
      dedupMateriality: dedupMaterialityLines(health),
      regimeRecent3: health.regimeRecent3,
      recentClosures: health.recentClosures,
      postFixAiPick: health.postFixAiPick,
      corporateActions7d: health.corporateActions7d,
      tradesClosedToday: health.tradesClosedToday,
      openTradesSummary: health.openTradesSummary,
      expectancyBySignalType: health.expectancyBySignalType,
      tradesNearTimeStop: health.tradesNearTimeStop,
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
