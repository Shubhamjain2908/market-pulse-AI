/**
 * HTML fragments for the regime card + change banner (spec §7.1–§7.3).
 */

import type { RegimeGateSummaryRow } from '../db/regime-queries.js';
import type { Regime, RegimeRow } from '../types/regime.js';
import { THEME } from './template.js';

function esc(s: string | number | undefined | null): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Spec §7.1 — border, background, icon per regime. */
const REGIME_PALETTE: Record<
  Regime,
  { border: string; bg: string; icon: string; cssClass: string; label: string }
> = {
  BULL_TRENDING: {
    border: '#27AE60',
    bg: '#EAFAF1',
    icon: '▲',
    cssClass: 'regime-card--bull',
    label: 'BULL TRENDING',
  },
  BEAR_TRENDING: {
    border: '#E74C3C',
    bg: '#FDEDEC',
    icon: '▼',
    cssClass: 'regime-card--bear',
    label: 'BEAR TRENDING',
  },
  CHOPPY: {
    border: '#E67E22',
    bg: '#FEF9E7',
    icon: '↔',
    cssClass: 'regime-card--choppy',
    label: 'CHOPPY',
  },
  CRISIS: {
    border: '#8E44AD',
    bg: '#F5EEF8',
    icon: '⚠',
    cssClass: 'regime-card--crisis',
    label: 'CRISIS',
  },
};

function scoreBarPct(scoreTotal: number): number {
  const clamped = Math.max(-16, Math.min(16, scoreTotal));
  return ((clamped + 16) / 32) * 100;
}

export interface RegimeGateSummary {
  active: RegimeGateSummaryRow[];
  totalRows: number;
}

/** Rule-based FII/DII 5-session flow label shown between score tiles and regime narrative. */
export interface RegimeFlowAttribution {
  label: string;
  narrative: string;
}

function renderFlowAttributionBlock(flow: RegimeFlowAttribution): string {
  const c = THEME;
  return `
    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout regime-flow-attribution" style="margin:0 0 10px;" aria-label="FII/DII flow attribution"><tr>
      <td style="padding:8px 10px;border-left:3px solid ${c.border};background:rgba(255,255,255,0.45);border-radius:0 6px 6px 0;">
        <p class="regime-flow-label" style="margin:0 0 4px;font-size:13px;font-weight:600;line-height:1.4;color:${c.text};">${esc(flow.label)}</p>
        <p class="regime-flow-narrative" style="margin:0;font-size:12px;line-height:1.45;color:${c.muted};">${esc(flow.narrative)}</p>
      </td>
    </tr></table>`;
}

export function renderRegimeCard(
  row: RegimeRow,
  gateSummary: RegimeGateSummary,
  flowAttribution?: RegimeFlowAttribution | null,
  cotGoldMacroLine?: string,
): string {
  const pal = REGIME_PALETTE[row.regime];
  const narrative = row.narrative?.trim() || 'No narrative stored for this session.';
  const dataRecency = row.date
    ? `<div class="regime-data-recency muted">Data as of ${esc(row.date)}</div>`
    : '';
  const active = gateSummary.active.length;
  const total = gateSummary.totalRows;
  const gateLine =
    total === 0
      ? 'Strategy gates not seeded for this regime.'
      : row.regime === 'CRISIS' && active === 0
        ? 'All entries paused — no strategies active in CRISIS.'
        : `${active} of ${total} strategies active (see gate table for sizes).`;

  const barPct = scoreBarPct(row.scoreTotal);
  const buckets: Array<{ name: string; value: number }> = [
    { name: 'Trend', value: row.scoreTrend },
    { name: 'VIX', value: row.scoreVix },
    { name: 'FII', value: row.scoreFii },
    { name: 'Breadth', value: row.scoreBreadth },
  ];

  const tiles = buckets
    .map(
      (b) => `
      <td width="25%" valign="top" style="padding:4px;">
      <div class="regime-tile">
        <div class="regime-tile-label">${esc(b.name)}</div>
        <div class="regime-tile-value">${b.value >= 0 ? '+' : ''}${esc(b.value.toFixed(1))}</div>
      </div></td>`,
    )
    .join('');

  return `
  <section class="regime-card ${pal.cssClass}" style="border:2px solid ${pal.border};background:${pal.bg};" aria-label="Market regime">
    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout regime-card-header-table" style="margin-bottom:10px;"><tr>
      <td valign="top"><div class="regime-badge">${esc(pal.icon)} ${esc(pal.label)}</div></td>
      <td valign="top" align="right" style="font-size:13px;color:#6b7280;">Day ${esc(row.regimeAge)} · Score ${row.scoreTotal >= 0 ? '+' : ''}${esc(row.scoreTotal.toFixed(1))}</td>
    </tr></table>
    <div class="regime-scorebar-wrap" aria-hidden="true">
      <div class="regime-scorebar-track">
        <div class="regime-scorebar-fill" style="width:${barPct.toFixed(1)}%"></div>
      </div>
      <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout regime-scorebar-labels" style="margin-top:2px;font-size:10px;color:#6b7280;"><tr>
        <td width="33%" valign="top">-16</td>
        <td width="34%" valign="top" align="center">0</td>
        <td width="33%" valign="top" align="right">+16</td>
      </tr></table>
    </div>
    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout regime-tiles-table" style="margin-bottom:12px;"><tr>${tiles}</tr></table>
    ${flowAttribution ? renderFlowAttributionBlock(flowAttribution) : ''}
    ${cotGoldMacroLine ?? ''}
    ${dataRecency}
    <p class="regime-narrative">${esc(narrative)}</p>
    <p class="regime-gate-summary muted">${esc(gateLine)}</p>
  </section>`;
}

/**
 * Prominent banner when `regime` differs from yesterday's persisted `prev_regime` on this row.
 */
export function renderRegimeChangeBanner(
  row: RegimeRow,
  ctx?: { prevScoreTotal: number | null },
): string {
  if (!row.prevRegime || row.prevRegime === row.regime) return '';
  const prev = row.prevRegime.replace(/_/g, ' ');
  const next = row.regime.replace(/_/g, ' ');
  const scoreHint =
    ctx?.prevScoreTotal != null
      ? ` Score moved from ${ctx.prevScoreTotal >= 0 ? '+' : ''}${ctx.prevScoreTotal.toFixed(1)} to ${row.scoreTotal >= 0 ? '+' : ''}${row.scoreTotal.toFixed(1)}.`
      : '';
  return `
  <div class="regime-change-banner" role="status">
    <strong>REGIME CHANGE:</strong> ${esc(prev)} → ${esc(next)} · Day 1 of new regime.${esc(scoreHint)}
  </div>`;
}
