/**
 * Briefing Composer agent. Phase 3: composes a full AI-enhanced briefing
 * including LLM-generated narrative and thesis cards.
 */

import { composeBriefing } from '../briefing/composer.js';
import type { MomentumRebalanceSummary } from '../briefing/momentum-card.js';
import type { WarningEntry } from '../briefing/template.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { child } from '../logger.js';

const log = child({ component: 'briefing-composer' });

export interface BriefRunOptions {
  date?: string;
  delivery?: 'file' | 'email';
  /** Skip LLM-generated sections (narrative, etc.). */
  skipAi?: boolean;
  /**
   * Whether to admit new paper trades from theses and portfolio ADD actions.
   * Default true. Set false for EOD Reconciliation Run.
   */
  admitNewPaperTrades?: boolean;
  /** Weekend / NSE holiday — closed-market brief from persisted DB rows only. */
  marketClosure?: { kind: 'weekend' | 'holiday'; label: string };
  /** When theses were generated in the same workflow pass (for AI Picks messaging). */
  thesisRun?: {
    generated: number;
    failed: number;
    candidateCount: number;
    eligibleUniverseSize: number;
    watchlistSize: number;
  };
  momentumRebalanceSummary?: MomentumRebalanceSummary;
  /** Non-fatal pipeline warnings surfaced during the workflow run. */
  warnings?: WarningEntry[];
  /** When true, render a prominent LLM budget-exceeded banner in the briefing. */
  budgetExceeded?: boolean;
}

export interface BriefRunResult {
  date: string;
  html: string;
  delivery: string;
  alertCount: number;
  newsCount: number;
  thesesCount: number;
  screenMatchesCount: number;
  portfolioCount: number;
  hasNarrative: boolean;
}

export async function runBriefingComposer(opts: BriefRunOptions = {}): Promise<BriefRunResult> {
  const date = opts.date ?? isoDateIst();
  const delivery = opts.delivery ?? 'file';

  const composed = await composeBriefing({
    date,
    skipAi: opts.skipAi,
    marketClosure: opts.marketClosure,
    thesisRun: opts.thesisRun,
    momentumRebalanceSummary: opts.momentumRebalanceSummary,
    warnings: opts.warnings,
    budgetExceeded: opts.budgetExceeded,
  });
  const screenMatches = composed.data.screenMatches?.reduce((s, m) => s + m.symbols.length, 0) ?? 0;
  log.info(
    {
      date: composed.date,
      alerts: composed.data.watchlistAlerts.length,
      screenMatches,
      news: composed.data.news.length,
      theses: composed.data.theses?.length ?? 0,
      hasNarrative: !!composed.data.moodNarrative,
    },
    'briefing composed',
  );

  return {
    date: composed.date,
    html: composed.html,
    delivery,
    alertCount: composed.data.watchlistAlerts.length,
    newsCount: composed.data.news.length,
    thesesCount: composed.data.theses?.length ?? 0,
    screenMatchesCount: screenMatches,
    portfolioCount: composed.data.portfolio?.positions.length ?? 0,
    hasNarrative: !!composed.data.moodNarrative,
  };
}
