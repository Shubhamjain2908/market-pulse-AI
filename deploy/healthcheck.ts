/**
 * Post-briefing health probe for cron (IST). Run after the morning schedule
 * (e.g. 08:30 IST weekdays) once `mp schedule` has delivered the briefing.
 *
 * Checks (trading days only where noted):
 *  - Email: `briefings` row for today with delivery_method=email and delivered_at set
 *  - regime_daily: row for today when the cash market is open (not weekend/holiday)
 *  - Pipeline: optional JSON run-summary thesis failures; optional PM2 log scan for pino errors today
 *
 * Appends one TSV line to HEALTHCHECK_LOG; on failure sends HEALTHCHECK_ALERT_TO (or SMTP_TO).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chdir } from 'node:process';
import nodemailer from 'nodemailer';
import { config } from '../src/config/env.js';
import { PROJECT_ROOT } from '../src/config/project-paths.js';
import { closeDb, getDb } from '../src/db/index.js';
import { isoDateIst } from '../src/ingestors/base/dates.js';
import { getMarketClosure } from '../src/market/nse-calendar.js';

chdir(PROJECT_ROOT);

const MARKET_TIMEZONE = 'Asia/Kolkata';

function healthLogPath(): string {
  const raw = process.env.HEALTHCHECK_LOG;
  return raw && raw.length > 0 ? resolve(raw) : join(PROJECT_ROOT, 'deploy/logs/health.log');
}

function pipelineLogPaths(): string[] {
  const raw = process.env.HEALTHCHECK_PIPELINE_LOG;
  if (raw && raw.trim().length > 0) {
    return raw
      .split(',')
      .map((s) => resolve(s.trim()))
      .filter(Boolean);
  }
  return [
    join(PROJECT_ROOT, 'deploy/logs/pm2-combined.log'),
    join(PROJECT_ROOT, 'deploy/logs/pm2-out.log'),
    join(PROJECT_ROOT, 'deploy/logs/pm2-err.log'),
  ];
}

function istDateFromPinoTime(time: unknown): string | null {
  if (typeof time === 'number' && Number.isFinite(time)) {
    return new Date(time).toLocaleDateString('sv-SE', { timeZone: MARKET_TIMEZONE });
  }
  if (typeof time === 'string') {
    const d = Date.parse(time);
    if (!Number.isNaN(d)) {
      return new Date(d).toLocaleDateString('sv-SE', { timeZone: MARKET_TIMEZONE });
    }
  }
  return null;
}

function scanPipelineLogsForTodayErrors(date: string): string | null {
  const needles = [
    'scheduled job failed',
    'Sunday momentum rebalance failed',
    'Sunday earnings calendar refresh failed',
  ];
  for (const filePath of pipelineLogPaths()) {
    if (!existsSync(filePath)) continue;
    let chunk: string;
    try {
      const buf = readFileSync(filePath);
      const tail = buf.subarray(Math.max(0, buf.length - 512_000));
      chunk = tail.toString('utf8');
    } catch {
      continue;
    }
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      if (!needles.some((n) => line.includes(n))) continue;
      try {
        const obj = JSON.parse(line) as { level?: number; time?: unknown };
        if (typeof obj.level === 'number' && obj.level < 50) continue;
        const logDate = istDateFromPinoTime(obj.time);
        if (logDate === date) {
          return `pipeline_log_error:${filePath}:${line.slice(0, 200)}`;
        }
      } catch {
        if (line.includes(date)) {
          return `pipeline_log_error:${filePath}:${line.slice(0, 200)}`;
        }
      }
    }
  }
  return null;
}

function readRunSummaryThesisFailures(date: string): string | null {
  if (config.BRIEFING_RUN_SUMMARY_JSON !== '1') return null;
  const dir = resolve(PROJECT_ROOT, config.BRIEFING_OUTPUT_DIR);
  const path = join(dir, `run-summary-${date}.json`);
  if (!existsSync(path)) return `run_summary_missing:${path}`;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      thesisRun?: { failed?: number };
    };
    const failed = raw.thesisRun?.failed;
    if (typeof failed === 'number' && failed > 0) {
      return `thesis_failed_count:${failed}`;
    }
  } catch (e) {
    return `run_summary_parse_error:${(e as Error).message}`;
  }
  return null;
}

function checkEmailBriefing(db: ReturnType<typeof getDb>, date: string): string | null {
  if (config.BRIEFING_DELIVERY !== 'email') {
    return null;
  }
  const row = db
    .prepare(
      `SELECT delivered_at FROM briefings
       WHERE date = ? AND delivery_method = 'email'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(date) as { delivered_at: string | null } | undefined;
  if (!row?.delivered_at) {
    return 'email_briefing_not_delivered';
  }
  return null;
}

function checkRegimeRow(db: ReturnType<typeof getDb>, date: string): string | null {
  const row = db.prepare('SELECT 1 AS ok FROM regime_daily WHERE date = ?').get(date) as
    | { ok: number }
    | undefined;
  if (!row) return 'regime_daily_missing';
  return null;
}

interface GttPostFixTrancheRow {
  signal_type: string;
  closed_count: number;
  avg_pnl_net: number | null;
  hit_rate: number | null;
}

function queryGttPostFixTranche(db: ReturnType<typeof getDb>): GttPostFixTrancheRow[] {
  return db
    .prepare(
      `
      SELECT
        signal_type,
        COUNT(*) AS closed_count,
        ROUND(AVG(pnl_pct), 2) AS avg_pnl_net,
        ROUND(SUM(CASE WHEN pnl_pct > 0 THEN 1.0 ELSE 0.0 END) / COUNT(*) * 100, 1) AS hit_rate
      FROM paper_trades
      WHERE status IN ('CLOSED_WIN', 'CLOSED_LOSS', 'CLOSED_TIME')
        AND source_date >= '2026-05-14'
      GROUP BY signal_type
    `,
    )
    .all() as GttPostFixTrancheRow[];
}

function formatGttPostFixTranche(rows: GttPostFixTrancheRow[]): string {
  if (rows.length === 0) {
    return 'gtt_post_fix_tranche: empty (no closed paper trades with source_date >= 2026-05-14)';
  }
  const parts = rows.map(
    (r) =>
      `${r.signal_type}:n=${r.closed_count},avg_pnl_net=${r.avg_pnl_net ?? 'null'}%,hit_rate=${r.hit_rate ?? 'null'}%`,
  );
  return `gtt_post_fix_tranche: ${parts.join('; ')}`;
}

function queryGttPostFixTrancheWeighted(db: ReturnType<typeof getDb>): GttPostFixTrancheRow[] {
  return db
    .prepare(
      `
      SELECT
        signal_type,
        COUNT(*) AS closed_count,
        ROUND(SUM(pnl_pct * position_weight_pct) / SUM(position_weight_pct), 2) AS avg_pnl_net,
        ROUND(SUM(CASE WHEN pnl_pct > 0 THEN 1.0 ELSE 0.0 END) / COUNT(*) * 100, 1) AS hit_rate
      FROM paper_trades
      WHERE status IN ('CLOSED_WIN', 'CLOSED_LOSS', 'CLOSED_TIME')
        AND source_date >= '2026-05-14'
        AND position_weight_pct IS NOT NULL
      GROUP BY signal_type
    `,
    )
    .all() as GttPostFixTrancheRow[];
}

function formatGttPostFixTrancheWeighted(rows: GttPostFixTrancheRow[]): string {
  if (rows.length === 0) {
    return 'gtt_post_fix_tranche_weighted: empty (no sized closed trades with source_date >= 2026-05-14)';
  }
  const parts = rows.map(
    (r) =>
      `${r.signal_type}:n=${r.closed_count},avg_pnl_w=${r.avg_pnl_net ?? 'null'}%,hit_rate=${r.hit_rate ?? 'null'}%`,
  );
  return `gtt_post_fix_tranche_weighted: ${parts.join('; ')}`;
}

async function sendAlert(reasons: string[], gttTrancheDetail: string): Promise<void> {
  const to = (process.env.HEALTHCHECK_ALERT_TO ?? config.SMTP_TO ?? '').trim();
  if (!to) {
    console.error(
      'healthcheck: failure but HEALTHCHECK_ALERT_TO and SMTP_TO are empty — no alert sent',
    );
    return;
  }
  if (!config.SMTP_USER || !config.SMTP_PASS || !config.SMTP_FROM) {
    console.error('healthcheck: SMTP_USER / SMTP_PASS / SMTP_FROM required to send alert');
    return;
  }
  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
  });
  const prefix = process.env.HEALTHCHECK_ALERT_SUBJECT_PREFIX ?? '[Market Pulse]';
  const statusLine = reasons.length === 0 ? 'healthcheck OK' : 'healthcheck FAIL';
  await transporter.sendMail({
    from: config.SMTP_FROM,
    to,
    subject: `${prefix} ${statusLine}`,
    text: [`date=${isoDateIst()}`, '', gttTrancheDetail, '', ...reasons].join('\n'),
  });
}

function appendHealthLog(line: string): void {
  const path = healthLogPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`, 'utf8');
}

async function main(): Promise<void> {
  const date = isoDateIst();
  const closure = getMarketClosure(date);
  const reasons: string[] = [];

  const db = getDb({ readonly: true });
  let gttTrancheDetail = 'gtt_post_fix_tranche: unavailable';

  try {
    const emailErr = checkEmailBriefing(db, date);
    if (emailErr) reasons.push(emailErr);

    if (!closure) {
      const regimeErr = checkRegimeRow(db, date);
      if (regimeErr) reasons.push(regimeErr);
    }

    const summaryErr = readRunSummaryThesisFailures(date);
    if (summaryErr) reasons.push(summaryErr);

    const logErr = scanPipelineLogsForTodayErrors(date);
    if (logErr) reasons.push(logErr);

    const gttRows = queryGttPostFixTranche(db);
    gttTrancheDetail = formatGttPostFixTranche(gttRows);
    console.log(gttTrancheDetail);
    console.log(formatGttPostFixTrancheWeighted(queryGttPostFixTrancheWeighted(db)));

    //     const corrupt = db.prepare(`
    //   SELECT COUNT(*) AS cnt FROM paper_trades pt
    //   JOIN quotes q ON q.symbol = pt.symbol AND q.exchange = 'NSE' AND q.date = pt.outcome_date
    //   WHERE pt.status IN ('CLOSED_LOSS','CLOSED_WIN')
    //     AND pt.exit_reason IN ('TRAILING_STOP','INITIAL_STOP')
    //     AND q.low  > pt.exit_price
    //     AND q.open >= pt.exit_price
    // `).get() as { cnt: number };
    //
    //     if (corrupt.cnt > 0) {
    //       alerts.push(`CORRUPT_STOP_OUTS: ${corrupt.cnt} trades closed where low never reached stop`);
    //     }
  } finally {
    closeDb();
  }

  const ok = reasons.length === 0;
  const ts = new Date().toISOString();
  const status = ok ? 'OK' : 'FAIL';
  const detail = ok
    ? `all_checks_passed; ${gttTrancheDetail}`
    : `${reasons.join('; ')}; ${gttTrancheDetail}`;
  const line = `${ts}\t${status}\t${date}\t${detail}`;
  console.log(line);
  appendHealthLog(line);

  if (!ok) {
    await sendAlert(reasons, gttTrancheDetail);
    process.exitCode = 1;
  }
}

void main().catch((err) => {
  const ts = new Date().toISOString();
  const msg = err instanceof Error ? err.message : String(err);
  const line = `${ts}\tFAIL\t${isoDateIst()}\thealthcheck_exception:${msg}`;
  console.error(line);
  try {
    appendHealthLog(line);
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
});
