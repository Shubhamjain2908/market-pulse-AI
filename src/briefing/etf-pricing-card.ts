/**
 * ETF iNAV premium/discount briefing block for held symbols in `etf-exclusions.json`.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { loadEtfExclusions } from '../config/loaders.js';
import { getLatestHoldings } from '../db/index.js';
import { getInavSnapshotsForDate, type InavSnapshotRow } from '../db/queries.js';
import { THEME } from './template.js';

const SECTION_MIN_ABS_PCT = 0.25;
const PREMIUM_WARN_PCT = 0.5;
const DISCOUNT_NOTE_ABS_PCT = 0.25;

export type EtfPricingSeverity = 'warn' | 'note';

export interface EtfPricingAlertRow {
  symbol: string;
  inav: number;
  lastPrice: number;
  premiumDiscountPct: number;
  severity: EtfPricingSeverity;
}

function esc(s: string | number | undefined | null): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function classifyEtfPricingAlert(
  premiumDiscountPct: number,
): EtfPricingAlertRow['severity'] | null {
  if (premiumDiscountPct > PREMIUM_WARN_PCT) return 'warn';
  if (premiumDiscountPct < -DISCOUNT_NOTE_ABS_PCT) return 'note';
  return null;
}

/** Held ETFs (portfolio ∩ etf-exclusions) with actionable premium/discount lines. */
export function buildEtfPricingAlerts(
  date: string,
  db: DatabaseType,
  staleHoldings: boolean,
): EtfPricingAlertRow[] {
  if (staleHoldings) return [];

  const etfSet = new Set(loadEtfExclusions().map((s) => s.toUpperCase()));
  const held = getLatestHoldings(db)
    .map((h) => h.symbol.toUpperCase())
    .filter((s) => etfSet.has(s));

  if (held.length === 0) return [];

  const snapshots = getInavSnapshotsForDate(date, held, db);
  const bySymbol = new Map(snapshots.map((s) => [s.symbol.toUpperCase(), s]));

  const alerts: EtfPricingAlertRow[] = [];
  for (const symbol of held) {
    const snap = bySymbol.get(symbol);
    if (!snap) continue;
    if (Math.abs(snap.premiumDiscountPct) <= SECTION_MIN_ABS_PCT) continue;

    const severity = classifyEtfPricingAlert(snap.premiumDiscountPct);
    if (!severity) continue;

    alerts.push({
      symbol,
      inav: snap.inav,
      lastPrice: snap.lastPrice,
      premiumDiscountPct: snap.premiumDiscountPct,
      severity,
    });
  }

  alerts.sort((a, b) => Math.abs(b.premiumDiscountPct) - Math.abs(a.premiumDiscountPct));
  return alerts;
}

function formatPct(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function lineForRow(row: EtfPricingAlertRow): string {
  const pct = formatPct(row.premiumDiscountPct);
  if (row.severity === 'warn') {
    return `<strong>WARN</strong> ${esc(row.symbol)}: trading at ${pct} vs iNAV (₹${esc(row.lastPrice.toFixed(2))} vs ₹${esc(row.inav.toFixed(2))}) — buying at premium.`;
  }
  return `<strong>NOTE</strong> ${esc(row.symbol)}: trading at ${pct} vs iNAV (₹${esc(row.lastPrice.toFixed(2))} vs ₹${esc(row.inav.toFixed(2))}) — trading at discount.`;
}

/**
 * HTML section or empty string when no held ETF crosses WARN/NOTE thresholds.
 */
export function renderEtfPricingBlock(
  date: string,
  db: DatabaseType,
  staleHoldings: boolean,
): string {
  const alerts = buildEtfPricingAlerts(date, db, staleHoldings);
  if (alerts.length === 0) return '';

  const c = THEME;
  const rows = alerts
    .map(
      (row) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid ${c.border};font-size:13px;line-height:1.45;color:${c.text};">
          ${lineForRow(row)}
        </td>
      </tr>`,
    )
    .join('');

  return `
  <section class="card etf-pricing-card" style="background:${c.card};border:1px solid ${c.border};border-radius:10px;padding:16px 18px;margin-bottom:14px;" aria-label="ETF pricing">
    <h2 style="margin:0 0 8px;font-size:16px;color:${c.accent};">ETF Pricing (iNAV)</h2>
    <p style="margin:0 0 10px;font-size:13px;line-height:1.45;color:${c.muted};">
      Held ETFs vs NSE iNAV for ${esc(date)}. Premium above ${PREMIUM_WARN_PCT}% is flagged; discount beyond ${DISCOUNT_NOTE_ABS_PCT}% is noted.
    </p>
    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout etf-pricing-table" style="border-collapse:collapse;">
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

/** @internal test helper */
export function alertsFromSnapshots(
  heldSymbols: string[],
  snapshots: InavSnapshotRow[],
): EtfPricingAlertRow[] {
  const bySymbol = new Map(snapshots.map((s) => [s.symbol.toUpperCase(), s]));
  const alerts: EtfPricingAlertRow[] = [];
  for (const symbol of heldSymbols.map((s) => s.toUpperCase())) {
    const snap = bySymbol.get(symbol);
    if (!snap) continue;
    if (Math.abs(snap.premiumDiscountPct) <= SECTION_MIN_ABS_PCT) continue;
    const severity = classifyEtfPricingAlert(snap.premiumDiscountPct);
    if (!severity) continue;
    alerts.push({
      symbol,
      inav: snap.inav,
      lastPrice: snap.lastPrice,
      premiumDiscountPct: snap.premiumDiscountPct,
      severity,
    });
  }
  return alerts;
}
