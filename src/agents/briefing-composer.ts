/**
 * Briefing Composer agent. Phase 1 produces a template-rendered HTML
 * briefing - no LLM involvement. Phase 3 will replace the placeholder
 * AI-picks card with actual thesis output.
 */

import { composeBriefing } from '../briefing/composer.js';
import { isoDateIst } from '../ingestors/base/dates.js';
import { child } from '../logger.js';

const log = child({ component: 'briefing-composer' });

export interface BriefRunOptions {
  date?: string;
  delivery?: 'file' | 'email' | 'slack' | 'telegram';
}

export interface BriefRunResult {
  date: string;
  html: string;
  delivery: string;
  alertCount: number;
  newsCount: number;
}

export async function runBriefingComposer(opts: BriefRunOptions = {}): Promise<BriefRunResult> {
  const date = opts.date ?? isoDateIst();
  const delivery = opts.delivery ?? 'file';

  const composed = composeBriefing({ date });
  log.info(
    {
      date: composed.date,
      alerts: composed.data.watchlistAlerts.length,
      news: composed.data.news.length,
    },
    'briefing composed',
  );

  return {
    date: composed.date,
    html: composed.html,
    delivery,
    alertCount: composed.data.watchlistAlerts.length,
    newsCount: composed.data.news.length,
  };
}
