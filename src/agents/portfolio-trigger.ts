/**
 * Decides whether a holding receives a full LLM portfolio review or a
 * deterministic "lite" snapshot (token-saving gate + noisy-default avoidance).
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import type { PortfolioHoldingRow } from '../db/index.js';
import { lastOpenOnOrBefore } from '../market/trading-days.js';

/**
 * Unrealised loss at or below this level always forces a full LLM portfolio review.
 * Override with `PORTFOLIO_FULL_REVIEW_LOSS_PCT` (e.g. `-15`).
 */
export function getPortfolioDeepLossPct(): number {
  const raw = process.env.PORTFOLIO_FULL_REVIEW_LOSS_PCT;
  if (raw === undefined || raw === '') return -20;
  const n = Number(raw);
  return Number.isFinite(n) ? n : -20;
}

export interface SignalSnapshot {
  rsi: number | undefined;
  volRatio: number | undefined;
  pct52wHigh: number | undefined;
  pct52wLow: number | undefined;
  /** Close divided by SMA20 minus 1, when both exist */
  vsSma20Pct: number | undefined;
}

/**
 * Latest value per `signals.name` for `symbol` on or before `asOfDate`.
 * Technical and momentum rows often land on different session dates (daily enrich vs weekly ranker);
 * taking MAX(date) across all names would drop stale-frequency signals (e.g. mom_* after a Monday RSI write).
 */
export function getLatestSignalsMap(
  symbol: string,
  asOfDate: string,
  db: DatabaseType,
): Record<string, number> {
  const sym = symbol.toUpperCase();
  const rows = db
    .prepare(
      `
      SELECT name, value FROM (
        SELECT name, value,
          ROW_NUMBER() OVER (PARTITION BY name ORDER BY date DESC) AS rn
        FROM signals
        WHERE symbol = ? AND date <= ?
          AND date >= date(?, '-90 days')
      )
      WHERE rn = 1
    `,
    )
    .all(sym, asOfDate, asOfDate) as Array<{ name: string; value: number }>;
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

/**
 * Same as {@link getLatestSignalsMap} but batched for many symbols (thesis ranking).
 */
export function getLatestSignalsMapsForSymbols(
  symbols: string[],
  asOfDate: string,
  db: DatabaseType,
): Map<string, Record<string, number>> {
  if (symbols.length === 0) return new Map();
  const upper = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const placeholders = upper.map(() => '?').join(',');
  const rows = db
    .prepare(
      `
      SELECT symbol, name, value FROM (
        SELECT symbol, name, value,
          ROW_NUMBER() OVER (PARTITION BY symbol, name ORDER BY date DESC) AS rn
        FROM signals
        WHERE date <= ? AND date >= date(?, '-90 days') AND symbol IN (${placeholders})
      )
      WHERE rn = 1
    `,
    )
    .all(asOfDate, asOfDate, ...upper) as Array<{ symbol: string; name: string; value: number }>;

  const bySym = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const sym = r.symbol.toUpperCase();
    const cur = bySym.get(sym) ?? {};
    cur[r.name] = r.value;
    bySym.set(sym, cur);
  }
  return bySym;
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

  if (h.pnlPct != null && h.pnlPct <= getPortfolioDeepLossPct()) return true;

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

  const bullPoints: string[] = [];
  const bearPoints: string[] = [];

  if (snap.rsi != null && snap.rsi < 38) {
    bullPoints.push(
      `RSI ${snap.rsi.toFixed(0)} — momentum washed out; bounce risk if trend intact`,
    );
  }
  if (snap.volRatio != null && snap.volRatio >= 1.2) {
    bullPoints.push(`Volume ${snap.volRatio.toFixed(2)}× 20d avg — participation backs moves`);
  }
  if (snap.vsSma20Pct != null && snap.vsSma20Pct < -2) {
    bullPoints.push(
      `Price ${snap.vsSma20Pct.toFixed(1)}% below SMA20 — room to mean-revert vs short-term mean`,
    );
  }
  if (snap.pct52wLow != null && snap.pct52wLow <= 8) {
    bullPoints.push(`Only ${snap.pct52wLow.toFixed(1)}% off 52W low — valuation cushion vs peaks`);
  }
  if (h.pnlPct != null && h.pnlPct > 8) {
    bullPoints.push(`Unrealised +${h.pnlPct.toFixed(1)}% — profit buffer for pullbacks`);
  }

  if (snap.rsi != null && snap.rsi > 62) {
    bearPoints.push(`RSI ${snap.rsi.toFixed(0)} — extension; pullback risk into resistance`);
  }
  if (snap.volRatio != null && snap.volRatio < 0.85) {
    bearPoints.push(`Volume ${snap.volRatio.toFixed(2)}× 20d — weak participation on up moves`);
  }
  if (snap.pct52wHigh != null && snap.pct52wHigh >= -3) {
    bearPoints.push(
      `${Math.abs(snap.pct52wHigh).toFixed(1)}% off 52W high — crowded zone for adds`,
    );
  }
  if (snap.vsSma20Pct != null && snap.vsSma20Pct > 4) {
    bearPoints.push(`+${snap.vsSma20Pct.toFixed(1)}% vs SMA20 — short-term stretched`);
  }
  if (h.pnlPct != null && h.pnlPct < -8) {
    bearPoints.push(`Unrealised ${h.pnlPct.toFixed(1)}% — needs repair vs entry / thesis`);
  }

  if (bullPoints.length === 0) {
    bullPoints.push('Technicals neutral — no clear oversold edge in this snapshot');
  }
  if (bearPoints.length === 0) {
    bearPoints.push('No major technical red flags in snapshot (RSI / vol / 52W band)');
  }

  return {
    thesis: `Technical snapshot (lite path — no full LLM call this run). ${line}. Unrealised P&L ${pnl} vs entry.`,
    bullPoints,
    bearPoints,
    triggerReason:
      'Lite snapshot — full review runs on deeper loss threshold, alerts, news/screens, or extreme signals. See Market Mood for flows.',
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
export function getLatestSignalDate(symbol: string, date: string, db: DatabaseType): string | null {
  const row = db
    .prepare(
      `
      SELECT MAX(date) AS d
      FROM signals
      WHERE symbol = ? AND date <= ? AND date >= date(?, '-90 days')
    `,
    )
    .get(symbol.toUpperCase(), date, date) as { d: string | null } | undefined;
  return row?.d ?? null;
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
  const signalDate = getLatestSignalDate(symbol, date, db);
  const expectedSession = lastOpenOnOrBefore(date) ?? date;
  if (signalDate && signalDate < expectedSession) {
    return `${line} · Signals as of ${signalDate} (prior NSE session)`;
  }
  return line;
}
