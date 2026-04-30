/**
 * Briefing Composer agent. Phase 0 placeholder - emits a tiny HTML stub so
 * the delivery pathway can be exercised end-to-end before Phase 1 lands.
 */

import { SEBI_DISCLAIMER } from '../constants.js';
import { logger } from '../logger.js';

export interface BriefRunOptions {
  date?: string;
  /** Override delivery method for this run. */
  delivery?: 'file' | 'email' | 'slack' | 'telegram';
}

export interface BriefRunResult {
  date: string;
  html: string;
  delivery: string;
}

export async function runBriefingComposer(opts: BriefRunOptions = {}): Promise<BriefRunResult> {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const delivery = opts.delivery ?? 'file';
  logger.info({ phase: 'brief', date, delivery }, 'briefing placeholder ran');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Market Pulse AI - ${date}</title>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; line-height: 1.5;">
  <h1>Market Pulse AI</h1>
  <p>Briefing pipeline scaffold is live. Real content lands in Phase 3.</p>
  <hr />
  <p style="font-size: 0.8rem; color: #666;">${SEBI_DISCLAIMER}</p>
</body>
</html>`;

  return { date, html, delivery };
}
