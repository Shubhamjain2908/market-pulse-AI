/**
 * Decides whether a holding receives a full LLM portfolio review or a
 * deterministic "lite" snapshot (token-saving gate + noisy-default avoidance).
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import type { PortfolioHoldingRow } from '../db/index.js';

/** Unrealised loss at or below this level always forces a full review. */
export const PORTFOLIO_DEEP_LOSS_PCT = -30;

export interface SignalSnapshot {
  rsi?: number;
  volRatio?: number;
  pct52wHigh?: number;
  pct52wLow?: number;
  /** Close divided by SMA20 minus 1, when both exist */
  vsSma20Pct?: number;
}

export function getLatestSignalsMap(
  symbol: string,
  date: string,
  db: DatabaseType,
): Record<string, number> {
  const rows = db
    .prepare(
      `
      SELECT name, value FROM signals
      WHERE symbol = ? AND date <= ?
        AND date = (SELECT MAX(date) FROM signals s2 WHERE s2.symbol = signals.symbol AND s2.date <= ?)
    `,
    )
    .all(symbol, date, date) as Array<{ name: string; value: number }>;
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

export function parseSignalSnapshot(s: Record<string, number>): SignalSnapshot {
  const close = s.close;
  const sma20 = s.sma_20;
  let vsSma20Pct: number | undefined;
  if (close != null && sma20 != null && sma20 > 0) {
    vsSma20Pct = ((close - sma20) / sma20) * 100;
  }
  return {
    rsi: s.rsi_14,
    volRatio: s.volume_ratio_20d,
    pct52wHigh: s.pct_from_52w_high,
    pct52wLow: s.pct_from_52w_low,
    vsSma20Pct,
  };
}

export function signalExtremesWarrantReview(s: Record<string, number>): boolean {
  const rsi = s.rsi_14;
  if (rsi != null && (rsi <= 35 || rsi >= 65)) return true;
  const vr = s.volume_ratio_20d;
  if (vr != null && vr >= 1.5) return true;
  const hi = s.pct_from_52w_high;
  if (hi != null && hi >= -3) return true;
  const lo = s.pct_from_52w_low;
  if (lo != null && lo <= 5) return true;
  return false;
}

/**
 * When true, every holding uses the full LLM path (legacy behaviour).
 * Read at call time from `process.env` so tests can toggle without reloading config.
 */
export function isPortfolioLiteDisabled(): boolean {
  return process.env.PORTFOLIO_ANALYSIS_DISABLE_LITE === '1';
}

/**
 * Full LLM review if any material trigger matches; otherwise a cheap lite row is used.
 */
export function needsPortfolioLlmReview(
  h: PortfolioHoldingRow,
  date: string,
  db: DatabaseType,
): boolean {
  if (isPortfolioLiteDisabled()) return true;

  if (h.pnlPct != null && h.pnlPct <= PORTFOLIO_DEEP_LOSS_PCT) return true;

  const alert = db
    .prepare(
      `
      SELECT 1 FROM alerts
      WHERE symbol = ? AND date >= date(?, '-5 days')
      LIMIT 1
    `,
    )
    .get(h.symbol, date);
  if (alert) return true;

  const news = db
    .prepare(
      `
      SELECT 1 FROM news
      WHERE symbol = ? AND published_at >= datetime(?, '-5 days')
      LIMIT 1
    `,
    )
    .get(h.symbol, date);
  if (news) return true;

  const screen = db
    .prepare(
      `
      SELECT 1 FROM screens
      WHERE symbol = ? AND date >= date(?, '-10 days')
      LIMIT 1
    `,
    )
    .get(h.symbol, date);
  if (screen) return true;

  const signals = getLatestSignalsMap(h.symbol, date, db);
  return signalExtremesWarrantReview(signals);
}

export interface LiteSnapshotCopy {
  thesis: string;
  bullPoints: string[];
  bearPoints: string[];
  triggerReason: string;
}

export function buildLiteSnapshotCopy(
  h: PortfolioHoldingRow,
  date: string,
  db: DatabaseType,
): LiteSnapshotCopy {
  const s = getLatestSignalsMap(h.symbol, date, db);
  const snap = parseSignalSnapshot(s);
  const line = formatTechnicalLine(snap);
  const pnl = h.pnlPct != null ? `${h.pnlPct.toFixed(1)}%` : 'n/a';
  return {
    thesis: `Snapshot only (no full LLM call — quiet vs automated triggers). ${line}. Unrealised P&L ${pnl} vs entry.`,
    bullPoints:
      snap.rsi != null && snap.rsi < 40
        ? [`RSI oversold territory (${snap.rsi.toFixed(0)})`]
        : ['No automated bull trigger'],
    bearPoints:
      snap.rsi != null && snap.rsi > 60
        ? [`Momentum stretched (RSI ${snap.rsi.toFixed(0)})`]
        : ['No automated bear trigger'],
    triggerReason:
      'Below portfolio LLM review threshold — macro context is in Market Mood; see technicals above.',
  };
}

export function formatTechnicalLine(snap: SignalSnapshot): string {
  const parts: string[] = [];
  if (snap.rsi != null) parts.push(`RSI ${snap.rsi.toFixed(0)}`);
  if (snap.volRatio != null) parts.push(`Vol× ${snap.volRatio.toFixed(2)}`);
  if (snap.vsSma20Pct != null)
    parts.push(`${snap.vsSma20Pct >= 0 ? '+' : ''}${snap.vsSma20Pct.toFixed(1)}% vs SMA20`);
  if (snap.pct52wLow != null && snap.pct52wLow <= 8)
    parts.push(`${snap.pct52wLow.toFixed(1)}% off 52W low`);
  if (parts.length === 0)
    return 'No technical signals in DB for this symbol (run ingest + enrich).';
  return `Technicals: ${parts.join(' · ')}`;
}

/** One-line summary for the HTML card (may be null if no data). */
export function technicalSummaryLine(
  symbol: string,
  date: string,
  db: DatabaseType,
): string | null {
  const s = getLatestSignalsMap(symbol, date, db);
  if (Object.keys(s).length === 0) return null;
  const line = formatTechnicalLine(parseSignalSnapshot(s));
  return line;
}
