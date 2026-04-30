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

export interface MarketMood {
  fiiNet?: number;
  diiNet?: number;
  vix?: number;
  niftyChangePct?: number;
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
}

export interface BriefingData {
  date: string;
  mood: MarketMood;
  /** LLM-generated narrative summary of market conditions. */
  moodNarrative?: string;
  watchlistAlerts: WatchlistAlert[];
  topGainers: MoverRow[];
  topLosers: MoverRow[];
  news: NewsRow[];
  /** AI-generated thesis cards (Phase 3). */
  theses?: ThesisCard[];
  /** True when the AI thesis section is intentionally empty (Phase 1). */
  aiPicksDisabled?: boolean;
}

export function renderBriefing(data: BriefingData): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Market Pulse - ${esc(data.date)}</title>
  <style>${baseStyles()}</style>
</head>
<body>
  <main class="wrap">
    ${renderHeader(data.date)}
    ${renderMood(data.mood, data.moodNarrative)}
    ${renderWatchlistAlerts(data.watchlistAlerts)}
    ${renderMovers(data.topGainers, data.topLosers)}
    ${renderAiPicks(data.theses, data.aiPicksDisabled)}
    ${renderNews(data.news)}
    ${renderFooter()}
  </main>
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

function renderMood(mood: MarketMood, narrative?: string): string {
  const cards = [
    moodCard('FII Net (Cash)', formatCrore(mood.fiiNet), mood.fiiNet),
    moodCard('DII Net (Cash)', formatCrore(mood.diiNet), mood.diiNet),
    moodCard('India VIX', mood.vix != null ? mood.vix.toFixed(2) : '—', null),
    moodCard(
      'Nifty 50 Δ',
      mood.niftyChangePct != null ? `${mood.niftyChangePct.toFixed(2)}%` : '—',
      mood.niftyChangePct ?? null,
    ),
  ].join('');

  const narrativeHtml = narrative ? `<div class="mood-narrative">${esc(narrative)}</div>` : '';

  return `
    <section class="card">
      <h2>Market Mood</h2>
      <div class="grid grid-4">${cards}</div>
      ${narrativeHtml}
    </section>`;
}

function moodCard(label: string, value: string, sentiment: number | null | undefined): string {
  const cls =
    sentiment == null ? 'mood neutral' : sentiment > 0 ? 'mood positive' : 'mood negative';
  return `
    <div class="${cls}">
      <div class="mood-label">${esc(label)}</div>
      <div class="mood-value">${esc(value)}</div>
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
      <table>
        <thead><tr><th>Symbol</th><th>Signal</th><th>Value</th><th>Note</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
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
      <div class="grid grid-2">
        <div>
          <h3>Gainers</h3>
          <table><thead><tr><th>Symbol</th><th>Δ%</th><th>Close</th></tr></thead>
            <tbody>${gainerRows}</tbody></table>
        </div>
        <div>
          <h3>Losers</h3>
          <table><thead><tr><th>Symbol</th><th>Δ%</th><th>Close</th></tr></thead>
            <tbody>${loserRows}</tbody></table>
        </div>
      </div>
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

function renderAiPicks(theses?: ThesisCard[], disabled?: boolean): string {
  if (disabled) {
    return `
      <section class="card ai-placeholder">
        <h2>AI Picks</h2>
        <p class="muted">AI thesis generation is disabled for this run.</p>
      </section>`;
  }

  if (!theses || theses.length === 0) {
    return `
      <section class="card">
        <h2>AI Picks</h2>
        <p class="muted">No stocks met the signal threshold for AI analysis today.</p>
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
        <div class="thesis-header">
          <span class="thesis-symbol">${esc(t.symbol)}</span>
          <span class="thesis-horizon tag">${esc(horizonLabel)}</span>
          <span class="thesis-confidence" title="Confidence: ${t.confidence}/10">
            <span class="conf-bar" style="width:${confidencePct}%"></span>
            ${t.confidence}/10
          </span>
        </div>
        <p class="thesis-body">${esc(t.thesis)}</p>
        <div class="thesis-levels">
          <span class="level positive">Entry: ${esc(t.entryZone)}</span>
          <span class="level negative">SL: ${esc(t.stopLoss)}</span>
          <span class="level accent">Target: ${esc(t.target)}</span>
        </div>
        <div class="grid grid-2">
          <div>
            <h4 class="bull-header">Bull Case</h4>
            <ul class="thesis-list">${bullItems}</ul>
          </div>
          <div>
            <h4 class="bear-header">Bear Case</h4>
            <ul class="thesis-list">${bearItems}</ul>
          </div>
        </div>
        <div class="thesis-trigger muted">Triggered by: ${esc(t.triggerReason)}</div>
      </div>`;
    })
    .join('');

  return `
    <section class="card">
      <h2>AI Picks &middot; Top ${theses.length}</h2>
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
      <ul class="news">${items}</ul>
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

function formatCrore(n: number | undefined): string {
  if (n == null) return '—';
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

// Inline styles. Keep small, avoid JS, optimised for both Gmail and saved
// HTML viewing in a desktop browser.
function baseStyles(): string {
  return `
    :root {
      color-scheme: light dark;
      --bg: #f7f8fa;
      --card: #ffffff;
      --text: #1a1f2c;
      --muted: #6b7280;
      --border: #e5e7eb;
      --accent: #2e86ab;
      --positive: #1a7f37;
      --negative: #cf222e;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text);
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
    .wrap { max-width: 760px; margin: 24px auto; padding: 0 16px; }
    .hero { padding: 24px 0; border-bottom: 2px solid var(--accent); margin-bottom: 16px; }
    .hero .brand { font-size: 12px; letter-spacing: 0.12em; color: var(--accent);
      text-transform: uppercase; font-weight: 700; }
    .hero h1 { font-size: 26px; margin: 4px 0 6px; }
    .hero .subtitle { color: var(--muted); margin: 0; font-size: 13px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px;
      padding: 16px 18px; margin-bottom: 14px; }
    .card h2 { margin: 0 0 12px; font-size: 16px; color: var(--accent); }
    .card h3 { margin: 0 0 8px; font-size: 14px; }
    .grid { display: grid; gap: 12px; }
    .grid-2 { grid-template-columns: 1fr 1fr; }
    .grid-4 { grid-template-columns: repeat(4, 1fr); }
    @media (max-width: 600px) {
      .grid-2, .grid-4 { grid-template-columns: 1fr 1fr; }
    }
    .mood { padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
      background: #fafbfd; }
    .mood-label { font-size: 11px; color: var(--muted); text-transform: uppercase;
      letter-spacing: 0.06em; }
    .mood-value { font-size: 18px; font-weight: 600; margin-top: 4px; }
    .mood.positive .mood-value { color: var(--positive); }
    .mood.negative .mood-value { color: var(--negative); }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase;
      letter-spacing: 0.04em; }
    td.positive { color: var(--positive); font-weight: 600; }
    td.negative { color: var(--negative); font-weight: 600; }
    .muted { color: var(--muted); font-size: 13px; }
    .news { list-style: none; padding: 0; margin: 0; }
    .news li { padding: 8px 0; border-bottom: 1px solid var(--border); }
    .news li:last-child { border-bottom: none; }
    .news a { color: var(--text); text-decoration: none; font-weight: 500; }
    .news a:hover { color: var(--accent); }
    .news .meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
    .tag { background: #eef4f8; color: var(--accent); padding: 1px 6px; border-radius: 4px;
      font-weight: 600; font-size: 11px; }
    .ai-placeholder { background: #fbf7e9; border-color: #f0e0a8; }
    .mood-narrative { margin-top: 12px; padding: 10px 14px; background: #f8fafc;
      border-left: 3px solid var(--accent); border-radius: 4px; font-size: 14px;
      line-height: 1.6; color: var(--text); }
    .thesis-card { border: 1px solid var(--border); border-radius: 8px; padding: 14px;
      margin-bottom: 12px; background: #fafbfd; }
    .thesis-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .thesis-symbol { font-size: 18px; font-weight: 700; color: var(--accent); }
    .thesis-horizon { font-size: 11px; }
    .thesis-confidence { font-size: 12px; color: var(--muted); position: relative;
      display: inline-flex; align-items: center; gap: 4px; }
    .conf-bar { display: inline-block; height: 6px; background: var(--accent); border-radius: 3px;
      min-width: 4px; }
    .thesis-body { margin: 0 0 10px; font-size: 14px; line-height: 1.5; }
    .thesis-levels { display: flex; gap: 12px; margin-bottom: 10px; font-size: 13px;
      font-weight: 600; }
    .level.positive { color: var(--positive); }
    .level.negative { color: var(--negative); }
    .level.accent { color: var(--accent); }
    .bull-header { color: var(--positive); font-size: 13px; margin: 0 0 4px; }
    .bear-header { color: var(--negative); font-size: 13px; margin: 0 0 4px; }
    .thesis-list { margin: 0; padding-left: 18px; font-size: 13px; }
    .thesis-list li { margin-bottom: 2px; }
    .thesis-trigger { margin-top: 8px; font-size: 11px; }
    .sentiment-badge { display: inline-block; padding: 1px 6px; border-radius: 4px;
      font-size: 10px; font-weight: 600; letter-spacing: 0.03em; vertical-align: middle;
      margin-left: 4px; }
    .sentiment-badge.positive { background: #dcfce7; color: var(--positive); }
    .sentiment-badge.negative { background: #fee2e2; color: var(--negative); }
    .sentiment-badge.neutral { background: #f3f4f6; color: var(--muted); }
    footer { margin-top: 18px; padding: 14px 0; text-align: center; color: var(--muted);
      font-size: 11px; }
    .disclaimer { max-width: 600px; margin: 0 auto; font-style: italic; }
  `;
}
