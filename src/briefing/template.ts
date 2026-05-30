/**
 * HTML rendering for the daily briefing. Pure function: data in, HTML out.
 *
 * Phase 1 deliberately uses no template engine. The output is a single
 * self-contained HTML page (inline styles, no external assets) so it
 * renders correctly in Gmail, Slack and a saved-to-disk file. We'll
 * graduate to a proper template only if the rendering grows complex.
 *
 * All user-visible text passes through `esc()` to prevent XSS leaking
 * from news headlines or fundamentals scrapes.
 */

import { SEBI_DISCLAIMER } from '../constants.js';
import type { GlobalCuesSection } from '../market/global-cues.js';

/** Palette for briefing HTML — interpolated into `<style>` and critical inline styles (no `var()`). */
export const THEME = {
  accent: '#2e86ab',
  positive: '#1a7f37',
  negative: '#cf222e',
  bg: '#f7f8fa',
  card: '#ffffff',
  text: '#1a1f2c',
  muted: '#6b7280',
  border: '#e5e7eb',
} as const;

export interface MarketMood {
  fiiNet: number | undefined;
  diiNet: number | undefined;
  /** Latest cash-segment FII/DII row date (may be before briefing date). */
  fiiDiiDate: string | undefined;
  vix: number | undefined;
  vixDate: string | undefined;
  niftyChangePct: number | undefined;
  /** Date of the Nifty bar used for Δ (previous session on holidays). */
  niftyBarDate: string | undefined;
}

export interface WatchlistAlert {
  symbol: string;
  signal: string;
  value: number;
  description: string;
}

export interface MoverRow {
  symbol: string;
  changePct: number;
  close: number;
  volume?: number;
}

export interface NewsRow {
  headline: string;
  source: string;
  url: string;
  publishedAt: string;
  symbol?: string;
  sentiment?: number | null;
}

export interface ThesisCard {
  symbol: string;
  thesis: string;
  bullCase: string[];
  bearCase: string[];
  entryZone: string;
  stopLoss: string;
  target: string;
  timeHorizon: string;
  confidence: number;
  triggerReason: string;
  /** Position after interest ranking (same workflow universe). */
  rank?: number;
  /** Short signal summary from ranking (for “why #N”). */
  rankBlurb?: string;
}

export interface PortfolioPositionCard {
  symbol: string;
  qty: number;
  avgPrice: number;
  lastPrice: number | null;
  pnl: number | null;
  pnlPct: number | null;
  dayChangePct: number | null;
  action: 'HOLD' | 'ADD' | 'TRIM' | 'EXIT' | null;
  conviction: number | null;
  thesis: string | null;
  triggerReason: string | null;
  bullPoints: string[];
  bearPoints: string[];
  suggestedStop: number | null;
  suggestedTarget: number | null;
  /** Latest RSI / volume / 52w context from `signals` (after enrich). */
  technicalSummary?: string | null;
}

export interface PortfolioRiskRollup {
  topWeights: Array<{ symbol: string; weightPct: number; valueInr: number }>;
  topLosers: Array<{ symbol: string; pnlPct: number; pnlInr: number }>;
  drawdownBuckets: {
    gt0: number;
    zeroToNeg10: number;
    neg10ToNeg20: number;
    ltNeg20: number;
  };
  sectorWeights?: Array<{ sector: string; weightPct: number }>;
}

export interface PortfolioSummary {
  totalValue: number;
  totalPnl: number;
  totalPnlPct: number;
  dayChange: number | null;
  dayChangePct: number | null;
  source: 'kite' | 'manual';
  positions: PortfolioPositionCard[];
  /** Concentration / drawdown distribution — optional when totals are computable. */
  riskRollup?: PortfolioRiskRollup;
  /** Kite holdings `as_of` predates the expected session — AI review was skipped. */
  staleHoldingsWarning?: string;
}

export interface ScreenMatch {
  screenName: string;
  screenLabel: string;
  symbols: string[];
  description: string | undefined;
  timeHorizon: string | undefined;
}

/** A single warning to surface in the briefing header (yellow banner pattern). */
export interface WarningEntry {
  /** Short category label, e.g. "Ingest" or "Data gap". */
  category: string;
  /** Human-readable detail shown in the banner. */
  message: string;
}

/** Forward-tested LLM signals (paper ledger). Shown when stats exist. */
export interface SignalPerformance {
  windowDays: number;
  closed: number;
  open: number;
  winRate: number | null;
  avgWinnerPct: number | null;
  avgLoserPct: number | null;
  expectancyPct: number | null;
  minSampleMet: boolean;
}

/** Why the AI Picks section looks empty or different — avoids ambiguous placeholders. */
export type AiPicksSectionStatus =
  | { kind: 'ok' }
  | { kind: 'skipped'; reason: 'skip_ai_flag' }
  | { kind: 'holiday'; label: string }
  | {
      kind: 'empty';
      reason: 'no_candidates' | 'all_watchlist_owned';
      candidateCount: number | undefined;
    }
  | { kind: 'all_failed'; failed: number };

export interface BriefingData {
  date: string;
  mood: MarketMood;
  /** Global indices / FX / commodities from `quotes` (Yahoo macro symbols). */
  globalCues: GlobalCuesSection;
  /** LLM-generated narrative summary of market conditions. */
  moodNarrative: string | undefined;
  /** When set, cash market was closed — banner + no fresh pipeline LLMs. */
  marketClosure: { kind: 'weekend' | 'holiday'; label: string } | undefined;
  watchlistAlerts: WatchlistAlert[];
  /** Screens that fired today (Phase 2). */
  screenMatches: ScreenMatch[] | undefined;
  topGainers: MoverRow[];
  topLosers: MoverRow[];
  news: NewsRow[];
  /** AI-generated thesis cards (Phase 3). */
  theses?: ThesisCard[];
  /** Portfolio summary + per-holding analysis (Phase 5). */
  portfolio?: PortfolioSummary;
  aiPicksStatus: AiPicksSectionStatus;
  /** Paper-trade performance (last N days) — Phase 7. */
  signalPerformance?: SignalPerformance;
  /** Pre-rendered trailing-stop activity (inserted above regime / global cues). */
  trailingStopBlock?: string;
  /** Pre-rendered regime card + optional change banner (inserted above global cues). */
  regimeBlock?: string;
  /** Momentum screener block (rank monitor + decay alerts); between screener and watchlist. */
  momentumBlock?: string;
  /** Non-fatal warnings to display in a yellow banner at the top of the briefing. */
  warnings?: WarningEntry[];
}

export function renderBriefing(data: BriefingData): string {
  const t = THEME;
  const bodyInner = `
    ${renderHeader(data.date)}
    ${renderWarnings(data.warnings)}
    ${renderMood(data.date, data.mood, data.moodNarrative, data.marketClosure)}
    ${renderSignalPerformance(data.signalPerformance)}
    ${data.trailingStopBlock ?? ''}
    ${data.regimeBlock ?? ''}
    ${renderGlobalCues(data.globalCues)}
    ${renderPortfolio(data.portfolio)}
    ${renderScreenMatches(data.screenMatches)}
    ${data.momentumBlock ?? ''}
    ${renderWatchlistAlerts(data.watchlistAlerts)}
    ${renderMovers(data.topGainers, data.topLosers)}
    ${renderAiPicks(data.theses, data.aiPicksStatus)}
    ${renderNews(data.news)}
    ${renderFooter()}`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Market Pulse - ${esc(data.date)}</title>
  <style>${baseStyles()}</style>
</head>
<body style="margin:0;padding:0;background-color:${t.bg};color:${t.text};font-size:15px;line-height:1.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;">
  <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout" style="background-color:${t.bg};">
    <tr>
      <td align="center" style="padding:16px 12px;">
        <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout" style="max-width:600px;margin:0 auto;background-color:${t.bg};">
          <tr>
            <td class="email-master-cell" style="vertical-align:top;">
              ${bodyInner}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderHeader(date: string): string {
  return `
    <header class="hero">
      <div class="brand">Market Pulse AI</div>
      <h1>Morning Briefing &middot; ${esc(date)}</h1>
      <p class="subtitle">Personal Indian-markets briefing &middot; NSE / BSE</p>
    </header>`;
}

function renderMood(
  briefingDate: string,
  mood: MarketMood,
  narrative?: string,
  marketClosure?: { kind: 'weekend' | 'holiday'; label: string },
): string {
  const banner = marketClosure
    ? `<div class="closure-banner"><strong>NSE closed</strong> (${esc(marketClosure.label)}). Values below are from the latest saved session in your database; dates marked <span class="tag">prev</span> are earlier than ${esc(briefingDate)}.</div>`
    : '';

  const moodCells = [
    moodCard(
      'FII Net (Cash)',
      formatCroreOrNoData(mood.fiiNet),
      mood.fiiNet,
      mood.fiiDiiDate,
      briefingDate,
    ),
    moodCard(
      'DII Net (Cash)',
      formatCroreOrNoData(mood.diiNet),
      mood.diiNet,
      mood.fiiDiiDate,
      briefingDate,
    ),
    moodCard(
      'India VIX',
      mood.vix != null ? mood.vix.toFixed(2) : 'No data',
      null,
      mood.vixDate,
      briefingDate,
    ),
    moodCard(
      'Nifty 50 Δ',
      mood.niftyChangePct != null ? `${mood.niftyChangePct.toFixed(2)}%` : 'No data',
      mood.niftyChangePct ?? null,
      mood.niftyBarDate,
      briefingDate,
    ),
  ]
    .map((cell) => `<td width="25%" valign="top" style="padding:4px;">${cell}</td>`)
    .join('');
  const moodTable = `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout mood-cells-table"><tr>${moodCells}</tr></table>`;

  const narrativeHtml = narrative
    ? `<p class="section-lede muted">Plain-language read — figures stay in the cards above.</p><div class="mood-narrative">${esc(narrative)}</div>`
    : '';

  return `
    <section class="card">
      <h2>Market Mood</h2>
      ${banner}
      ${moodTable}
      ${narrativeHtml}
    </section>`;
}

function renderSignalPerformance(perf?: SignalPerformance): string {
  if (!perf) return '';

  const pct = (n: number | null) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);
  const rate = (r: number | null) => (r == null ? '—' : `${(r * 100).toFixed(1)}%`);

  const body = perf.minSampleMet
    ? (() => {
        const statDivs = [
          `<div class="stat"><div class="stat-label">Win rate (${perf.windowDays}d)</div><div class="stat-value">${rate(perf.winRate)}</div></div>`,
          `<div class="stat"><div class="stat-label">Expectancy / trade</div><div class="stat-value">${pct(perf.expectancyPct)}</div></div>`,
          `<div class="stat"><div class="stat-label">Avg winner</div><div class="stat-value positive">${pct(perf.avgWinnerPct)}</div></div>`,
          `<div class="stat"><div class="stat-label">Avg loser</div><div class="stat-value negative">${pct(perf.avgLoserPct)}</div></div>`,
          `<div class="stat"><div class="stat-label">Closed in window</div><div class="stat-value">${perf.closed}</div></div>`,
          `<div class="stat"><div class="stat-label">Open (total)</div><div class="stat-value">${perf.open}</div></div>`,
        ];
        const perfRows: string[] = [];
        for (let i = 0; i < statDivs.length; i += 2) {
          const left = statDivs[i] ?? '';
          const right = statDivs[i + 1] ?? '&nbsp;';
          perfRows.push(
            `<tr><td width="50%" valign="top" style="padding:4px;">${left}</td><td width="50%" valign="top" style="padding:4px;">${right}</td></tr>`,
          );
        }
        return `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout signal-performance-grid">${perfRows.join('')}</table>
      <p class="section-lede muted">Based on forward-tested paper trades (EOD). Not investment advice.</p>`;
      })()
    : `<p class="section-lede muted">Collecting forward-testing data. At least 5 closed trades in the last ${perf.windowDays} days are required before win rate and expectancy are shown. (Currently <strong>${perf.closed}</strong> closed, <strong>${perf.open}</strong> open.)</p>`;

  return `
    <section class="card signal-performance">
      <h2>Signal performance (paper)</h2>
      ${body}
    </section>`;
}

function renderGlobalCues(section: GlobalCuesSection): string {
  if (section.rows.length === 0) return '';
  const cells = section.rows.map((r) => {
    const staleTag = r.stale ? ` <span class="tag">prev ${esc(r.asOf ?? '')}</span>` : '';
    const note = r.note ? `<div class="muted global-cue-note">${esc(r.note)}</div>` : '';
    const cls = r.changePct == null ? 'neutral' : r.changePct >= 0 ? 'positive' : 'negative';
    return `
        <div class="global-cue ${cls}">
          <div class="mood-label">${esc(r.label)}</div>
          <div class="mood-value">${esc(r.display)}${staleTag}</div>
          ${note}
        </div>`;
  });
  const cueRows: string[] = [];
  for (let i = 0; i < cells.length; i += 3) {
    const c0 = cells[i] ?? '';
    const c1 = cells[i + 1] ?? '';
    const c2 = cells[i + 2] ?? '';
    cueRows.push(
      `<tr><td width="33%" valign="top" style="padding:4px;">${c0}</td><td width="33%" valign="top" style="padding:4px;">${c1}</td><td width="34%" valign="top" style="padding:4px;">${c2}</td></tr>`,
    );
  }
  return `
    <section class="card">
      <h2>Global Cues</h2>
      <p class="section-lede muted">Overnight / US session markers from Yahoo macro symbols ingested with your pipeline. Nifty 50 spot uses the same cash benchmark series as elsewhere in this report — not USD-denominated offshore futures.</p>
      <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout global-cues-table">${cueRows.join('')}</table>
    </section>`;
}

function moodCard(
  label: string,
  value: string,
  sentiment: number | null | undefined,
  metricDate?: string,
  briefingDate?: string,
): string {
  const cls =
    sentiment == null ? 'mood neutral' : sentiment > 0 ? 'mood positive' : 'mood negative';
  let display = value;
  if (metricDate && briefingDate && metricDate < briefingDate && value !== 'No data') {
    display = `${value} [prev ${metricDate}]`;
  }
  return `
    <div class="${cls}">
      <div class="mood-label">${esc(label)}</div>
      <div class="mood-value">${esc(display)}</div>
    </div>`;
}

function renderWatchlistAlerts(alerts: WatchlistAlert[]): string {
  if (alerts.length === 0) {
    return `
      <section class="card">
        <h2>Watchlist Alerts</h2>
        <p class="muted">No watchlist symbols crossed an alert threshold today.</p>
      </section>`;
  }
  const rows = alerts
    .map(
      (a) => `
        <tr>
          <td><strong>${esc(a.symbol)}</strong></td>
          <td>${esc(a.signal)}</td>
          <td>${esc(formatNumber(a.value))}</td>
          <td>${esc(a.description)}</td>
        </tr>`,
    )
    .join('');

  return `
    <section class="card">
      <h2>Watchlist Alerts</h2>
      <p class="section-lede muted">Automated threshold crosses — confirm vs your plan before acting.</p>
      <table class="briefing-data-table">
        <thead><tr><th>Symbol</th><th>Signal</th><th>Value</th><th>Note</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function renderPortfolio(p?: PortfolioSummary): string {
  if (!p || p.positions.length === 0) return '';

  const summaryClass = p.totalPnl >= 0 ? 'positive' : 'negative';
  const dayClass =
    p.dayChangePct == null ? 'neutral' : p.dayChangePct >= 0 ? 'positive' : 'negative';

  const summary = `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout portfolio-summary-table"><tr>
      <td width="25%" valign="top" style="padding:4px;"><div class="mood neutral">
        <div class="mood-label">Total Value</div>
        <div class="mood-value">${formatInr(p.totalValue)}</div>
      </div></td>
      <td width="25%" valign="top" style="padding:4px;"><div class="mood ${summaryClass}">
        <div class="mood-label">Unrealised P&amp;L</div>
        <div class="mood-value">${signed(formatInr(p.totalPnl))} (${p.totalPnlPct.toFixed(2)}%)</div>
      </div></td>
      <td width="25%" valign="top" style="padding:4px;"><div class="mood ${dayClass}">
        <div class="mood-label">Today's Change</div>
        <div class="mood-value">${p.dayChangePct == null ? '—' : `${signedPct(p.dayChangePct)}`}</div>
      </div></td>
      <td width="25%" valign="top" style="padding:4px;"><div class="mood neutral">
        <div class="mood-label">Holdings</div>
        <div class="mood-value">${p.positions.length}</div>
      </div></td>
    </tr></table>`;

  const risk = p.riskRollup ? renderPortfolioRiskRollup(p.riskRollup) : '';

  const cardRows = p.positions
    .map(
      (c) =>
        `<tr><td style="padding:0 0 12px 0;vertical-align:top;">${renderPositionCard(c)}</td></tr>`,
    )
    .join('');
  const positionTable = `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout position-cards-table">${cardRows}</table>`;

  const staleBanner = p.staleHoldingsWarning
    ? `<div class="closure-banner"><strong>Stale Kite holdings</strong> — ${esc(p.staleHoldingsWarning)}</div>`
    : '';

  return `
    <section class="card">
      <h2>My Portfolio <span class="muted">· source: ${esc(p.source)}</span></h2>
      <p class="section-lede muted">Recommendations come from today&apos;s saved analysis — align with your risk limits.</p>
      ${staleBanner}
      ${summary}
      ${risk}
      ${positionTable}
    </section>`;
}

function renderPortfolioRiskRollup(r: PortfolioRiskRollup): string {
  const tw = r.topWeights
    .map(
      (w) =>
        `<tr><td><strong>${esc(w.symbol)}</strong></td><td>${w.weightPct.toFixed(1)}%</td><td>${formatInr(w.valueInr)}</td></tr>`,
    )
    .join('');
  const losers = r.topLosers
    .map(
      (l) =>
        `<tr><td><strong>${esc(l.symbol)}</strong></td><td class="negative">${l.pnlPct.toFixed(2)}%</td><td>${formatInr(l.pnlInr)}</td></tr>`,
    )
    .join('');
  const b = r.drawdownBuckets;
  const sectors =
    r.sectorWeights
      ?.map((s) => `<tr><td>${esc(s.sector)}</td><td>${s.weightPct.toFixed(1)}%</td></tr>`)
      .join('') ?? '';

  const sectorBlock =
    r.sectorWeights && r.sectorWeights.length > 0
      ? `
      <div class="risk-col">
        <h3 class="h-small">Sector mix (mapped)</h3>
        <table class="briefing-data-table"><thead><tr><th>Sector</th><th>Weight</th></tr></thead><tbody>${sectors}</tbody></table>
      </div>`
      : '';

  return `
    <div class="portfolio-risk-rollup">
      <h3 class="h-small">Portfolio risk snapshot</h3>
      <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout portfolio-risk-cols"><tr>
        <td width="33%" valign="top" style="padding:4px;"><div class="risk-col">
          <h3 class="h-small">Top weights</h3>
          <table class="briefing-data-table"><thead><tr><th>Symbol</th><th>Wt%</th><th>Value</th></tr></thead><tbody>${tw}</tbody></table>
        </div></td>
        <td width="33%" valign="top" style="padding:4px;"><div class="risk-col">
          <h3 class="h-small">Largest unrealised losers (%)</h3>
          <table class="briefing-data-table"><thead><tr><th>Symbol</th><th>P&amp;L%</th><th>P&amp;L</th></tr></thead><tbody>${losers || `<tr><td colspan="3" class="muted">None</td></tr>`}</tbody></table>
        </div></td>
        <td width="34%" valign="top" style="padding:4px;"><div class="risk-col">
          <h3 class="h-small">P&amp;L distribution</h3>
          <ul class="muted tight-list">
            <li>&gt; 0%: <strong>${b.gt0}</strong> positions</li>
            <li>0% to −10%: <strong>${b.zeroToNeg10}</strong></li>
            <li>−10% to −20%: <strong>${b.neg10ToNeg20}</strong></li>
            <li>&lt; −20%: <strong>${b.ltNeg20}</strong></li>
          </ul>
        </div></td>
      </tr></table>
      ${sectorBlock}
    </div>`;
}

function renderPointColumn(points: string[], mark: string, tone: 'bull' | 'bear'): string {
  if (points.length === 0) return '';
  const color = tone === 'bull' ? THEME.positive : THEME.negative;
  const items = points.map((b) => `<li>${esc(b)}</li>`).join('');
  return `
    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout point-list-table">
      <tr>
        <td width="16" valign="top" style="color:${color};font-weight:800;font-size:14px;line-height:1.2;padding-top:2px;">${mark}</td>
        <td valign="top"><ul class="point-ul">${items}</ul></td>
      </tr>
    </table>`;
}

function renderPositionCard(c: PortfolioPositionCard): string {
  const pnlClass = c.pnlPct == null ? 'neutral' : c.pnlPct >= 0 ? 'positive' : 'negative';
  const pnl =
    c.pnl != null && c.pnlPct != null
      ? `${signed(formatInr(c.pnl))} (${c.pnlPct.toFixed(2)}%)`
      : '—';
  const dayChip =
    c.dayChangePct == null
      ? ''
      : ` <span class="day-chip ${c.dayChangePct >= 0 ? 'positive' : 'negative'}">${signedPct(c.dayChangePct)} today</span>`;
  const actionChip = c.action
    ? `<span class="action-chip ${c.action.toLowerCase()}">${c.action}</span> `
    : '';

  const headline = `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout position-header-table"><tr>
      <td valign="top" style="width:50%;padding:0 8px 0 0;"><strong>${esc(c.symbol)}</strong><span class="muted"> · ${c.qty.toFixed(0)} qty @ ₹${c.avgPrice.toFixed(2)}</span></td>
      <td valign="top" align="right" style="width:50%;padding:0 0 0 8px;">${actionChip}<span class="${pnlClass}">${pnl}</span>${dayChip}</td>
    </tr></table>`;

  const tech =
    c.technicalSummary != null && c.technicalSummary !== ''
      ? `<p class="position-tech">${esc(c.technicalSummary)}</p>`
      : '';

  const thesis = c.thesis ? `<p class="position-thesis">${esc(c.thesis)}</p>` : '';
  const trigger = c.triggerReason
    ? `<p class="position-trigger"><span class="muted">Review:</span> ${esc(c.triggerReason)}</p>`
    : '';
  const bullBlock = renderPointColumn(c.bullPoints, '+', 'bull');
  const bearBlock = renderPointColumn(c.bearPoints, '−', 'bear');
  const pointsTable =
    bullBlock || bearBlock
      ? `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout position-points-table" style="margin-top:8px;"><tr>
      <td width="50%" valign="top" style="padding:0 8px 0 0;">${bullBlock || '&nbsp;'}</td>
      <td width="50%" valign="top" style="padding:0 0 0 8px;">${bearBlock || '&nbsp;'}</td>
    </tr></table>`
      : '';
  const levels = formatLevels(c.suggestedStop, c.suggestedTarget, c.lastPrice);

  const t = THEME;
  return `
    <div class="position-card" style="display:block;width:100%;max-width:100%;box-sizing:border-box;margin:0;border:1px solid ${t.border};border-radius:8px;background:#fafbfd;padding:14px;">
      ${headline}
      ${tech}
      ${thesis}
      ${trigger}
      ${pointsTable}
      ${levels}
    </div>`;
}

function formatLevels(stop: number | null, target: number | null, last: number | null): string {
  const items: string[] = [];
  if (last != null) items.push(`LTP <strong>₹${last.toFixed(2)}</strong>`);
  if (stop != null) items.push(`Stop <strong>₹${stop.toFixed(2)}</strong>`);
  if (target != null) items.push(`Target <strong>₹${target.toFixed(2)}</strong>`);
  if (items.length === 0) return '';
  return `<div class="position-levels">${items.join(' · ')}</div>`;
}

function formatInr(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 10_000_000) return `₹${(v / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000) return `₹${(v / 100_000).toFixed(2)}L`;
  if (abs >= 1_000) return `₹${(v / 1_000).toFixed(2)}K`;
  return `₹${v.toFixed(2)}`;
}

function signed(s: string): string {
  return s.startsWith('-') ? s : `+${s}`;
}

function signedPct(v: number): string {
  return v >= 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`;
}

function renderScreenMatches(matches?: ScreenMatch[]): string {
  if (!matches || matches.length === 0) return '';
  const totalMatches = matches.reduce((s, m) => s + m.symbols.length, 0);
  if (totalMatches === 0) return '';

  const blocks = matches
    .filter((m) => m.symbols.length > 0)
    .map((m) => {
      const tag = m.timeHorizon
        ? `<span class="tag">${esc(m.timeHorizon.toUpperCase())}</span>`
        : '';
      const desc = m.description ? `<p class="muted">${esc(m.description)}</p>` : '';
      const chips = m.symbols.map((s) => `<span class="symbol-chip">${esc(s)}</span>`).join(' ');
      return `
        <div class="screen-block">
          <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout screen-block-title"><tr>
            <td valign="middle"><h3 style="margin:0 0 4px;font-size:14px;color:${THEME.accent};">${esc(m.screenLabel)}</h3></td>
            <td valign="middle" align="right" style="white-space:nowrap;">${tag}</td>
          </tr></table>
          ${desc}
          <div class="symbol-chips">${chips}</div>
        </div>`;
    })
    .join('');

  return `
    <section class="card">
      <h2>Screens Fired Today (${totalMatches})</h2>
      <p class="section-lede muted">A research funnel from your screen rules — not a buy list.</p>
      ${blocks}
    </section>`;
}

function renderMovers(gainers: MoverRow[], losers: MoverRow[]): string {
  const gainerRows =
    gainers.map((g) => moverRow(g, 'positive')).join('') ||
    `<tr><td colspan="3" class="muted">No data</td></tr>`;
  const loserRows =
    losers.map((l) => moverRow(l, 'negative')).join('') ||
    `<tr><td colspan="3" class="muted">No data</td></tr>`;

  return `
    <section class="card">
      <h2>Top Movers (Watchlist)</h2>
      <p class="section-lede muted">Largest % moves vs prior session close among watchlist names.</p>
      <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout movers-two-col"><tr>
        <td width="50%" valign="top" style="padding:0 8px 0 0;">
          <h3>Gainers</h3>
          <table class="briefing-data-table"><thead><tr><th>Symbol</th><th>Δ%</th><th>Close</th></tr></thead>
            <tbody>${gainerRows}</tbody></table>
        </td>
        <td width="50%" valign="top" style="padding:0 0 0 8px;">
          <h3>Losers</h3>
          <table class="briefing-data-table"><thead><tr><th>Symbol</th><th>Δ%</th><th>Close</th></tr></thead>
            <tbody>${loserRows}</tbody></table>
        </td>
      </tr></table>
    </section>`;
}

function moverRow(m: MoverRow, _tone: 'positive' | 'negative'): string {
  return `
    <tr>
      <td><strong>${esc(m.symbol)}</strong></td>
      <td class="${m.changePct >= 0 ? 'positive' : 'negative'}">${m.changePct.toFixed(2)}%</td>
      <td>${esc(formatNumber(m.close))}</td>
    </tr>`;
}

function renderAiPicks(theses: ThesisCard[] | undefined, status: AiPicksSectionStatus): string {
  if (status.kind === 'skipped') {
    return `
      <section class="card ai-placeholder">
        <h2>AI Picks</h2>
        <p class="muted">AI thesis generation is disabled for this run (--skip-ai).</p>
      </section>`;
  }

  if (status.kind === 'holiday') {
    return `
      <section class="card ai-placeholder">
        <h2>AI Picks</h2>
        <p class="muted">NSE closed (${esc(status.label)}). Thesis cards were not refreshed today.</p>
      </section>`;
  }

  if (status.kind === 'all_failed') {
    return `
      <section class="card ai-placeholder">
        <h2>AI Picks</h2>
        <p class="muted">Thesis LLM calls failed for every candidate (${esc(String(status.failed))}). Check logs and provider credentials.</p>
      </section>`;
  }

  if (!theses || theses.length === 0) {
    if (status.kind === 'empty' && status.reason === 'all_watchlist_owned') {
      return `
      <section class="card">
        <h2>AI Picks</h2>
        <p class="muted">Every watchlist symbol is already in My Portfolio — AI Picks are for new ideas and names not yet held. Existing positions are reviewed under My Portfolio.</p>
      </section>`;
    }
    const hint =
      status.kind === 'empty' && status.reason === 'no_candidates' && status.candidateCount === 0
        ? ' No symbols qualified after ranking — widen watchlist coverage or check screen/alert signals.'
        : status.kind === 'empty' &&
            status.reason === 'no_candidates' &&
            status.candidateCount != null &&
            status.candidateCount > 0
          ? ' Candidates were ranked but no thesis rows appear — check thesis-generation logs.'
          : '';
    return `
      <section class="card">
        <h2>AI Picks</h2>
        <p class="muted">No stocks met the signal threshold for AI analysis today.${hint}</p>
      </section>`;
  }

  const cards = theses
    .map((t) => {
      const bullItems = t.bullCase.map((b) => `<li>${esc(b)}</li>`).join('');
      const bearItems = t.bearCase.map((b) => `<li>${esc(b)}</li>`).join('');
      const confidencePct = (t.confidence / 10) * 100;
      const horizonLabel =
        t.timeHorizon === 'short' ? '1-4W' : t.timeHorizon === 'medium' ? '1-3M' : '3-12M';

      return `
      <div class="thesis-card">
        <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout thesis-header-table" style="margin-bottom:8px;"><tr>
          <td valign="middle"><span class="thesis-symbol">${esc(t.symbol)}</span> <span class="thesis-horizon tag">${esc(horizonLabel)}</span></td>
          <td valign="middle" align="right" style="font-size:12px;color:${THEME.muted};white-space:nowrap;">
            <span class="conf-bar" style="display:inline-block;height:6px;background:${THEME.accent};border-radius:3px;min-width:4px;width:${confidencePct}%;max-width:120px;vertical-align:middle;margin-right:4px;"></span>${t.confidence}/10
          </td>
        </tr></table>
        ${
          t.rank != null
            ? `<div class="thesis-rank muted">#${t.rank} by signal score · ${esc(t.rankBlurb ?? '')}</div>`
            : ''
        }
        <div class="thesis-why-now"><strong>Why now:</strong> ${esc(t.triggerReason)}</div>
        <p class="thesis-body">${esc(t.thesis)}</p>
        <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout thesis-levels-table" style="margin-bottom:10px;font-size:13px;font-weight:600;"><tr>
          <td class="level positive" valign="top" style="padding-right:10px;">Entry: ${esc(t.entryZone)}</td>
          <td class="level negative" valign="top" style="padding-right:10px;">SL: ${esc(t.stopLoss)}</td>
          <td class="level accent" valign="top">Target: ${esc(t.target)}</td>
        </tr></table>
        <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" class="email-layout thesis-cases-table"><tr>
          <td width="50%" valign="top" style="padding:0 8px 0 0;">
            <h4 class="bull-header">Bull Case</h4>
            <ul class="thesis-list">${bullItems}</ul>
          </td>
          <td width="50%" valign="top" style="padding:0 0 0 8px;">
            <h4 class="bear-header">Bear Case</h4>
            <ul class="thesis-list">${bearItems}</ul>
          </td>
        </tr></table>
      </div>`;
    })
    .join('');

  return `
    <section class="card">
      <h2>AI Picks &middot; Top ${theses.length}</h2>
      <p class="section-lede muted">Ideas ranked from today&apos;s signals — verify against your process; not instructions.</p>
      ${cards}
    </section>`;
}

function renderNews(news: NewsRow[]): string {
  if (news.length === 0) {
    return `
      <section class="card">
        <h2>News &middot; Last 48h</h2>
        <p class="muted">No items in the configured RSS feeds for this window.</p>
      </section>`;
  }
  const items = news
    .map(
      (n) => `
        <li>
          <a href="${esc(n.url)}">${esc(n.headline)}</a>
          ${sentimentBadge(n.sentiment)}
          <div class="meta">
            ${esc(n.source)}
            ${n.symbol ? `&middot; <span class="tag">${esc(n.symbol)}</span>` : ''}
            &middot; <time datetime="${esc(n.publishedAt)}">${esc(formatTime(n.publishedAt))}</time>
          </div>
        </li>`,
    )
    .join('');
  return `
    <section class="card">
      <h2>News &middot; Last 48h</h2>
      <p class="section-lede muted">Watchlist-tagged headlines are prioritised when present.</p>
      <ul class="news">${items}</ul>
    </section>`;
}

function renderWarnings(warnings?: WarningEntry[]): string {
  if (!warnings || warnings.length === 0) return '';
  const items = warnings
    .map(
      (w) => `
      <div class="ingest-warning">
        <strong>${esc(w.category)}:</strong> ${esc(w.message)}
      </div>`,
    )
    .join('');
  return `
    <section class="card warnings-card">
      <div class="warnings-header">⚠\ufe0f Pipeline Warnings</div>
      ${items}
    </section>`;
}

function renderFooter(): string {
  return `
    <footer>
      <p class="disclaimer">${esc(SEBI_DISCLAIMER)}</p>
    </footer>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sentimentBadge(sentiment: number | null | undefined): string {
  if (sentiment == null) return '';
  const label = sentiment >= 0.3 ? 'Bullish' : sentiment <= -0.3 ? 'Bearish' : 'Neutral';
  const cls = sentiment >= 0.3 ? 'positive' : sentiment <= -0.3 ? 'negative' : 'neutral';
  return ` <span class="sentiment-badge ${cls}" title="Sentiment: ${sentiment.toFixed(2)}">${label}</span>`;
}

function esc(s: string | number | undefined): string {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatCroreOrNoData(n: number | undefined): string {
  if (n == null) return 'No data';
  const sign = n >= 0 ? '+' : '−';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 1 })} Cr`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// Styles for the briefing `<style>` block. `composeBriefing` runs the final HTML
// through `juice` to inline rules; `preserveMediaQueries` keeps these @media blocks.
// Colours come from {@link THEME} (no CSS custom properties — safe when `<style>` is stripped).
function baseStyles(): string {
  const c = THEME;
  return `
    * { box-sizing: border-box; }
    body { margin: 0; background: ${c.bg}; color: ${c.text};
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
    .email-master-cell { padding: 0; vertical-align: top; }
    table.email-layout { border-collapse: collapse; width: 100%; }
    table.email-layout > tbody > tr > td,
    table.email-layout > tr > td { border-bottom: none !important; }
    .briefing-data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
    .briefing-data-table th,
    .briefing-data-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid ${c.border}; }
    .briefing-data-table th { color: ${c.muted}; font-weight: 600; font-size: 12px; text-transform: uppercase;
      letter-spacing: 0.04em; }
    .briefing-data-table td.positive { color: ${c.positive}; font-weight: 600; }
    .briefing-data-table td.negative { color: ${c.negative}; font-weight: 600; }
    .hero { padding: 24px 0; border-bottom: 2px solid ${c.accent}; margin-bottom: 16px; }
    .hero .brand { font-size: 12px; letter-spacing: 0.12em; color: ${c.accent};
      text-transform: uppercase; font-weight: 700; }
    .hero h1 { font-size: 26px; margin: 4px 0 6px; }
    .hero .subtitle { color: ${c.muted}; margin: 0; font-size: 13px; }
    .card { background: ${c.card}; border: 1px solid ${c.border}; border-radius: 10px;
      padding: 16px 18px; margin-bottom: 14px; }
    .closure-banner { margin-bottom: 12px; padding: 10px 12px; background: #fff8e6;
      border: 1px solid #f0e0a8; border-radius: 8px; font-size: 13px; line-height: 1.45; color: ${c.text}; }
    .card h2 { margin: 0 0 12px; font-size: 16px; color: ${c.accent}; }
    .card h3 { margin: 0 0 8px; font-size: 14px; }
    @media (max-width: 600px) {
      table.mood-cells-table > tr > td,
      table.portfolio-summary-table > tr > td { display: block !important; width: 100% !important; }
    }
    .signal-performance-grid .stat { padding: 10px 12px; border: 1px solid ${c.border};
      border-radius: 8px; background: #fafbfd; }
    .stat-label { font-size: 11px; color: ${c.muted}; text-transform: uppercase;
      letter-spacing: 0.06em; }
    .stat-value { font-size: 17px; font-weight: 600; margin-top: 4px; }
    .stat-value.positive { color: ${c.positive}; }
    .stat-value.negative { color: ${c.negative}; }
    .mood { padding: 10px 12px; border: 1px solid ${c.border}; border-radius: 8px;
      background: #fafbfd; }
    .mood-label { font-size: 11px; color: ${c.muted}; text-transform: uppercase;
      letter-spacing: 0.06em; }
    .mood-value { font-size: 18px; font-weight: 600; margin-top: 4px; }
    .mood.positive .mood-value { color: ${c.positive}; }
    .mood.negative .mood-value { color: ${c.negative}; }
    .global-cue { padding: 10px 12px; border: 1px solid ${c.border}; border-radius: 8px;
      background: #fafbfd; }
    .global-cue-note { font-size: 11px; margin-top: 4px; line-height: 1.35; }
    .global-cue.positive .mood-value { color: ${c.positive}; }
    .global-cue.negative .mood-value { color: ${c.negative}; }
    .trailing-stop-card {
      border-left: 4px solid ${c.accent};
      background: linear-gradient(180deg, #f8fafc 0%, #ffffff 55%);
    }
    .trailing-stop-sub { margin: 14px 0 8px; font-size: 13px; color: ${c.accent}; }
    .trailing-stop-table { font-size: 13px; margin-top: 6px; width: 100%; border-collapse: collapse; }
    .trailing-stop-table th,
    .trailing-stop-table td { padding: 6px 8px; border-bottom: 1px solid ${c.border}; text-align: left; }
    .trailing-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.03em;
      white-space: nowrap;
    }
    .trailing-badge--stop { background: #fde7e7; color: ${c.negative}; }
    .trailing-badge--tight { background: #fff8e6; color: #b7791f; }
    .trailing-badge--raise { background: #e6f4ea; color: ${c.positive}; }
    .trailing-badge--near { background: #eef4f8; color: ${c.accent}; }
    .regime-change-banner {
      margin-bottom: 12px;
      padding: 12px 14px;
      background: #fff4e6;
      border: 1px solid #f0b429;
      border-radius: 8px;
      font-size: 14px;
      line-height: 1.45;
      color: ${c.text};
    }
    .regime-card {
      margin-bottom: 14px;
      padding: 16px 18px;
      border-radius: 10px;
    }
    .regime-badge {
      font-size: 18px;
      font-weight: 800;
      letter-spacing: 0.02em;
    }
    .regime-scorebar-wrap { margin-bottom: 12px; }
    .regime-scorebar-track {
      height: 8px;
      border-radius: 4px;
      background: linear-gradient(90deg, ${c.negative} 0%, ${c.border} 50%, ${c.positive} 100%);
      overflow: hidden;
    }
    .regime-scorebar-fill {
      height: 100%;
      background: rgba(255,255,255,0.35);
      border-right: 2px solid ${c.text};
      box-sizing: border-box;
    }
    .regime-tile {
      padding: 8px 10px;
      border: 1px solid ${c.border};
      border-radius: 8px;
      background: rgba(255,255,255,0.55);
      font-size: 12px;
    }
    .regime-tile-label { color: ${c.muted}; text-transform: uppercase; font-size: 10px; letter-spacing: 0.06em; }
    .regime-tile-value { font-weight: 700; margin-top: 2px; }
    .regime-flow-attribution {
      margin: 0 0 10px;
      padding: 8px 10px;
      border-left: 3px solid ${c.border};
      background: rgba(255,255,255,0.45);
      border-radius: 0 6px 6px 0;
    }
    .regime-flow-label { margin: 0 0 4px; font-size: 13px; font-weight: 600; line-height: 1.4; }
    .regime-flow-narrative { margin: 0; font-size: 12px; line-height: 1.45; }
    .regime-narrative { margin: 0 0 8px; font-size: 14px; line-height: 1.55; }
    .regime-gate-summary { margin: 0; font-size: 12px; }
    .muted { color: ${c.muted}; font-size: 13px; }
    .section-lede { margin: 0 0 12px; max-width: 42rem; line-height: 1.45; }
    .news { list-style: none; padding: 0; margin: 0; }
    .news li { padding: 8px 0; border-bottom: 1px solid ${c.border}; }
    .news li:last-child { border-bottom: none; }
    .news a { color: ${c.text}; text-decoration: none; font-weight: 500; }
    .news a:hover { color: ${c.accent}; }
    .news .meta { color: ${c.muted}; font-size: 12px; margin-top: 2px; }
    .tag { background: #eef4f8; color: ${c.accent}; padding: 1px 6px; border-radius: 4px;
      font-weight: 600; font-size: 11px; }
    .warnings-card { background: #fff8e6; border-color: #f0b429; }
    .warnings-header { font-size: 14px; font-weight: 700; color: #b7791f; margin-bottom: 8px; }
    .ingest-warning { padding: 6px 0; border-bottom: 1px solid #f0e0a8; font-size: 13px; line-height: 1.45; }
    .ingest-warning:last-child { border-bottom: none; }
    .ai-placeholder { background: #fbf7e9; border-color: #f0e0a8; }
    .mood-narrative { margin-top: 12px; padding: 10px 14px; background: #f8fafc;
      border-left: 3px solid ${c.accent}; border-radius: 4px; font-size: 14px;
      line-height: 1.6; color: ${c.text}; }
    .thesis-card { border: 1px solid ${c.border}; border-radius: 8px; padding: 14px;
      margin-bottom: 12px; background: #fafbfd; }
    .thesis-why-now { font-size: 13px; line-height: 1.45; margin: 0 0 8px; color: ${c.text}; }
    .thesis-rank { font-size: 12px; margin: 0 0 6px; line-height: 1.35; }
    .thesis-symbol { font-size: 18px; font-weight: 700; color: ${c.accent}; }
    .thesis-horizon { font-size: 11px; }
    .thesis-body { margin: 0 0 10px; font-size: 14px; line-height: 1.5; }
    .level.positive { color: ${c.positive}; }
    .level.negative { color: ${c.negative}; }
    .level.accent { color: ${c.accent}; }
    .bull-header { color: ${c.positive}; font-size: 13px; margin: 0 0 4px; }
    .bear-header { color: ${c.negative}; font-size: 13px; margin: 0 0 4px; }
    .thesis-list { margin: 0; padding-left: 18px; font-size: 13px; }
    .thesis-list li { margin-bottom: 2px; }
    .sentiment-badge { display: inline-block; padding: 1px 6px; border-radius: 4px;
      font-size: 10px; font-weight: 600; letter-spacing: 0.03em; vertical-align: middle;
      margin-left: 4px; }
    .sentiment-badge.positive { background: #dcfce7; color: ${c.positive}; }
    .sentiment-badge.negative { background: #fee2e2; color: ${c.negative}; }
    .sentiment-badge.neutral { background: #f3f4f6; color: ${c.muted}; }
    .screen-block { padding: 12px; border: 1px solid ${c.border}; border-radius: 8px;
      background: #fafbfd; margin-bottom: 10px; }
    .screen-block:last-child { margin-bottom: 0; }
    .screen-block .muted { margin: 0 0 8px; font-size: 12px; }
    .symbol-chips { margin-top: 6px; line-height: 1.8; }
    .symbol-chip { display: inline-block; padding: 2px 8px; border-radius: 4px;
      background: #eef4f8; color: ${c.accent}; font-weight: 600; font-size: 12px;
      margin: 0 6px 6px 0; }
    .position-cards-table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    .portfolio-risk-rollup { margin-top: 14px; padding-top: 14px; border-top: 1px solid ${c.border}; }
    .portfolio-risk-rollup .h-small { font-size: 13px; margin: 0 0 8px; color: ${c.accent}; }
    .portfolio-risk-rollup .risk-col table { font-size: 13px; }
    .tight-list { margin: 6px 0 0; padding-left: 18px; line-height: 1.5; }
    .point-ul { margin: 0; padding-left: 16px; font-size: 12px; line-height: 1.45; }
    .position-tech { margin: 4px 0 2px; font-size: 12px; color: #5a6578; line-height: 1.4; }
    .position-thesis { margin: 6px 0; font-size: 13px; line-height: 1.5; }
    .position-trigger { margin: 4px 0 8px; font-size: 12px; color: #4a5568; }
    .position-levels { margin-top: 6px; font-size: 12px; color: #4a5568; }
    .action-chip { display: inline-block; padding: 2px 10px; border-radius: 999px;
      font-size: 11px; font-weight: 700; letter-spacing: 0.05em; }
    .action-chip.hold { background: #e6eaf2; color: #2c3e50; }
    .action-chip.add  { background: #d4edda; color: #155724; }
    .action-chip.trim { background: #fff3cd; color: #856404; }
    .action-chip.exit { background: #f8d7da; color: #721c24; }
    .momentum-card { border-left: 4px solid #b7791f; }
    .momentum-rebalance { margin-bottom: 12px; font-size: 13px; line-height: 1.45; }
    .momentum-sub { margin: 14px 0 6px; font-size: 13px; color: ${c.accent}; }
    .momentum-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; }
    .momentum-table th, .momentum-table td { padding: 6px 8px; border-bottom: 1px solid ${c.border}; text-align: left; }
    .momentum-row-amber { background: #fffaf0; }
    .day-chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px;
      font-weight: 600; }
    .day-chip.positive { background: #e6f4ea; color: ${c.positive}; }
    .day-chip.negative { background: #fde7e7; color: ${c.negative}; }
    footer { margin-top: 18px; padding: 14px 0; text-align: center; color: ${c.muted};
      font-size: 11px; }
    .disclaimer { max-width: 600px; margin: 0 auto; font-style: italic; }
  `;
}
