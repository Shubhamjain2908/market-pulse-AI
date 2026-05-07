/**
 * Momentum strategy (`momentum_mf`) briefing block: rank-decay alerts, optional rebalance summary,
 * and a daily rank monitor for open paper trades.
 */

import type { Database as DatabaseType } from 'better-sqlite3';

import { getLatestSignalsMap } from '../agents/portfolio-trigger.js';
import { loadMomentumConfig } from '../config/loaders.js';
import { getNseCloseOnOrBefore, getOpenPaperTradesForSignal } from '../db/queries.js';

function esc(s: string | number | undefined | null): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Passed from the Sunday rebalance job or CLI when briefing runs in the same process. */
export interface MomentumRebalanceSummary {
  calendarDate: string;
  sessionDate: string;
  closedRankDecay: number;
  entriesInserted: number;
  unchangedHeld: number;
  sectorCapBlocked: number;
  blackoutBlocked: number;
}

function signedPct(p: number): string {
  const sign = p >= 0 ? '+' : '−';
  return `${sign}${Math.abs(p).toFixed(2)}%`;
}

/**
 * HTML fragment (section card) or empty string when there is nothing to show.
 */
export function renderMomentumBriefingBlock(
  date: string,
  db: DatabaseType,
  rebalance?: MomentumRebalanceSummary,
): string {
  const cfg = loadMomentumConfig();
  const exitTh = cfg.exit_rank_threshold;
  const amberLow = 15;

  const openMom = getOpenPaperTradesForSignal('momentum_mf', db);
  const rows = openMom.map((t) => {
    const signals = getLatestSignalsMap(t.symbol, date, db);
    const rank = signals.mom_rank;
    const falseFlagRaw = signals.mom_false_flag;
    const falseFlagUnknown = falseFlagRaw == null || !Number.isFinite(falseFlagRaw);
    const falseFlag = falseFlagRaw === 1;
    const close = getNseCloseOnOrBefore(t.symbol, date, db);
    const pnlPct = close != null ? ((close - t.entryPrice) / t.entryPrice) * 100 : null;
    return {
      symbol: t.symbol,
      entryDate: t.sourceDate,
      rank,
      falseFlag,
      stop: t.stopLoss,
      pnlPct,
      rankOk: rank != null && Number.isFinite(rank),
      falseFlagUnknown,
    };
  });

  const decay = rows.filter((r) => {
    const rk = r.rank;
    return rk != null && Number.isFinite(rk) && rk >= amberLow && rk <= exitTh;
  });

  if (rows.length === 0 && !rebalance) {
    return '';
  }

  const rebalanceHtml = rebalance
    ? `<div class="momentum-rebalance muted">
        <strong>Last rebalance (${esc(rebalance.calendarDate)})</strong>
        · session ${esc(rebalance.sessionDate)}
        · rank exits ${rebalance.closedRankDecay}
        · new entries ${rebalance.entriesInserted}
        · unchanged ${rebalance.unchangedHeld}
        · sector cap blocked ${rebalance.sectorCapBlocked}
        · blackout blocked ${rebalance.blackoutBlocked}
      </div>`
    : '';

  const decayHtml =
    decay.length > 0
      ? `<div class="momentum-decay-wrap">
      <h3 class="momentum-sub">Rank decay watch (${amberLow}–${exitTh})</h3>
      <p class="section-lede muted">Open momentum positions approaching systematic rank exit (&gt;${exitTh}).</p>
      <table class="momentum-table">
        <thead><tr><th>Symbol</th><th>mom_rank</th><th>P&amp;L %</th></tr></thead>
        <tbody>
          ${decay
            .map(
              (r) => `
            <tr class="momentum-row-amber">
              <td><strong>${esc(r.symbol)}</strong></td>
              <td>${esc(String(r.rank))}</td>
              <td>${r.pnlPct == null ? '—' : esc(signedPct(r.pnlPct))}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`
      : '';

  const monitorHtml =
    rows.length > 0
      ? `<div class="momentum-monitor-wrap">
      <h3 class="momentum-sub">Momentum portfolio monitor</h3>
      <p class="section-lede muted">Open <code>momentum_mf</code> paper trades vs latest momentum signals (${esc(date)}).</p>
      <table class="momentum-table">
        <thead><tr><th>Symbol</th><th>Entry</th><th>mom_rank</th><th>P&amp;L %</th><th>Stop</th><th>False flag</th></tr></thead>
        <tbody>
          ${rows
            .map((r) => {
              const rk = r.rankOk ? String(r.rank) : '—';
              const pnl = r.pnlPct == null ? '—' : signedPct(r.pnlPct);
              const ff = r.falseFlagUnknown ? '—' : r.falseFlag ? 'Yes' : 'No';
              return `
            <tr>
              <td><strong>${esc(r.symbol)}</strong></td>
              <td>${esc(r.entryDate)}</td>
              <td>${esc(rk)}</td>
              <td>${esc(pnl)}</td>
              <td>${esc(r.stop.toFixed(2))}</td>
              <td>${esc(ff)}</td>
            </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>`
      : '';

  const body = [rebalanceHtml, decayHtml, monitorHtml].filter(Boolean).join('\n');
  if (!body) return '';

  return `
    <section class="card momentum-card">
      <h2>Momentum screener</h2>
      <p class="section-lede muted">Multi-factor momentum book · rank exit threshold &gt;${exitTh}</p>
      ${body}
    </section>`;
}
