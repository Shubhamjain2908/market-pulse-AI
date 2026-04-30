/**
 * Briefing Composer agent. Phase 3: composes a full AI-enhanced briefing
 * including LLM-generated narrative and thesis cards.
 */

import { composeBriefing } from '../briefing/composer.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { child } from '../logger.js';

const log = child({ component: 'briefing-composer' });

export interface BriefRunOptions {
  date?: string;
  delivery?: 'file' | 'email' | 'slack' | 'telegram';
  /** Skip LLM-generated sections (narrative, etc.). */
  skipAi?: boolean;
}

export interface BriefRunResult {
  date: string;
  html: string;
  delivery: string;
  alertCount: number;
  newsCount: number;
  thesesCount: number;
  screenMatchesCount: number;
  hasNarrative: boolean;
}

export async function runBriefingComposer(opts: BriefRunOptions = {}): Promise<BriefRunResult> {
  const date = opts.date ?? isoDateIst();
  const delivery = opts.delivery ?? 'file';

  const composed = await composeBriefing({ date, skipAi: opts.skipAi });
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
    hasNarrative: !!composed.data.moodNarrative,
  };
}
