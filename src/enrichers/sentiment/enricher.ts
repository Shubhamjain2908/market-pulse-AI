/**
 * Sentiment enricher. Scores news headlines (and optional summaries) using
 * the active LLM provider. Headlines are batched to reduce LLM calls - a
 * single prompt scores up to ~25 headlines at once.
 *
 * Output: sentiment column updated in the `news` table, range -1.0 (very
 * bearish) to +1.0 (very bullish), 0.0 = neutral.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { getLlmProvider } from '../../llm/index.js';
import type { LlmProvider } from '../../llm/types.js';
import { child } from '../../logger.js';

const log = child({ component: 'sentiment-enricher' });

const BATCH_SIZE = 25;

const SentimentBatchSchema = z.array(
  z.object({
    id: z.number(),
    sentiment: z.number().min(-1).max(1),
  }),
);
type SentimentBatch = z.infer<typeof SentimentBatchSchema>;

const SYSTEM_PROMPT = `You are a financial news sentiment classifier for the Indian stock market (NSE/BSE).

Given a batch of news headlines, score each one on a scale from -1.0 to +1.0:
  -1.0 = very bearish (company disaster, regulatory crackdown, fraud)
  -0.5 = bearish (missed earnings, downgrades, sector headwinds)
   0.0 = neutral (routine announcements, informational)
  +0.5 = bullish (beat estimates, upgrades, expansion plans)
  +1.0 = very bullish (massive order wins, transformative deals)

Be precise. Most general market news is near 0. Company-specific positive/negative events
are typically in the -0.7 to +0.7 range. Reserve -1.0/+1.0 for extreme events.

Return ONLY a JSON array of objects: [{ "id": <number>, "sentiment": <number> }]
No explanation, no markdown fences, just the JSON array.`;

export interface SentimentEnricherOptions {
  /** Max headlines per LLM batch. Default 25. */
  batchSize?: number;
  /** Only score items with null sentiment. Default true. */
  unscoredOnly?: boolean;
  /** Cap total headlines processed per run. Default 100. */
  limit?: number;
}

export interface SentimentEnricherStats {
  scored: number;
  failed: number;
  batches: number;
}

export async function enrichSentiment(
  opts: SentimentEnricherOptions = {},
  db: DatabaseType = getDb(),
  llm: LlmProvider = getLlmProvider(),
): Promise<SentimentEnricherStats> {
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const limit = opts.limit ?? 100;
  const unscoredOnly = opts.unscoredOnly ?? true;

  const rows = db
    .prepare(
      `SELECT id, headline, summary, symbol FROM news
       ${unscoredOnly ? 'WHERE sentiment IS NULL' : ''}
       ORDER BY published_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: number;
    headline: string;
    summary: string | null;
    symbol: string | null;
  }>;

  if (rows.length === 0) {
    log.info('no unscored headlines to process');
    return { scored: 0, failed: 0, batches: 0 };
  }

  const stats: SentimentEnricherStats = { scored: 0, failed: 0, batches: 0 };
  const updateStmt = db.prepare('UPDATE news SET sentiment = ? WHERE id = ?');

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    stats.batches++;

    try {
      const headlineList = batch
        .map((r) => {
          const sym = r.symbol ? ` [${r.symbol}]` : '';
          const summary = r.summary ? ` — ${r.summary.slice(0, 120)}` : '';
          return `{ "id": ${r.id}, "headline": "${escapeForPrompt(r.headline)}${sym}${summary}" }`;
        })
        .join('\n');

      const result = await llm.generateJson<SentimentBatch>({
        system: SYSTEM_PROMPT,
        user: `Score these ${batch.length} headlines:\n\n${headlineList}`,
        schema: SentimentBatchSchema,
        temperature: 0.1,
        maxRetries: 1,
      });

      const tx = db.transaction(() => {
        for (const item of result.data) {
          const clamped = Math.max(-1, Math.min(1, item.sentiment));
          updateStmt.run(clamped, item.id);
          stats.scored++;
        }
      });
      tx();

      log.debug(
        { batch: stats.batches, scored: result.data.length, model: result.model },
        'sentiment batch scored',
      );
    } catch (err) {
      log.warn({ batch: stats.batches, err: (err as Error).message }, 'sentiment batch failed');
      stats.failed += batch.length;
    }
  }

  log.info(stats, 'sentiment enrichment complete');
  return stats;
}

function escapeForPrompt(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, ' ');
}
