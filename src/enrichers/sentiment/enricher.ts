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

/** Every requested news row id must appear exactly once in the model output. */
export function validateSentimentBatch(expectedIds: number[], items: SentimentBatch): void {
  const sortedExp = [...expectedIds].sort((a, b) => a - b);
  const gotIds = items.map((x) => x.id).sort((a, b) => a - b);
  if (sortedExp.length !== gotIds.length) {
    throw new Error(
      `Sentiment count mismatch: expected ${sortedExp.length} ids, got ${gotIds.length}`,
    );
  }
  for (let i = 0; i < sortedExp.length; i++) {
    if (sortedExp[i] !== gotIds[i]) {
      throw new Error(`Sentiment id mismatch at ${i}: expected ${sortedExp[i]}, got ${gotIds[i]}`);
    }
  }
}

const SYSTEM_PROMPT = `You are a financial news sentiment classifier for the Indian stock market (NSE/BSE).

Given a batch of news headlines, score each one on a scale from -1.0 to +1.0:
  -1.0 = very bearish (company disaster, regulatory crackdown, fraud)
  -0.5 = bearish (missed earnings, downgrades, sector headwinds)
   0.0 = neutral (routine announcements, informational)
  +0.5 = bullish (beat estimates, upgrades, expansion plans)
  +1.0 = very bullish (massive order wins, transformative deals)

Indian context: PSU defence shipbuilders, NBFCs, IT services, pharma, and banks behave differently from US peers.
Earnings beats with explicit profit growth (YoY/QoQ) should score clearly positive (+0.45 to +0.75), not near zero.

Few-shot (headline → sentiment):
- "Mazagon Dock Q4 profit jumps 42% YoY, margins expand" → +0.65 (strong earnings beat, defence shipbuilder)
- "Equitas Small Finance Bank Q4 PAT surges five-fold; asset quality stable" → +0.55 (earnings transformation)
- "SEBI issues show-cause notice to XYZ on disclosure lapses" → -0.70 (regulatory overhang)
- "Nifty closes flat; FIIs net sellers for third day" → -0.05 (mildly negative macro flow, not about one stock)
- "Laurus Labs Q4 PAT up 19%; guides steady FY growth" → +0.50 (solid earnings, pharma)

You MUST return one object per input id — same ids, no duplicates, no missing rows.

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

    const expectedIds = batch.map((r) => r.id);
    let batchOk = false;
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt < 2 && !batchOk; attempt++) {
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
          temperature: 0.15,
          maxRetries: 1,
        });

        validateSentimentBatch(expectedIds, result.data);

        const tx = db.transaction(() => {
          for (const item of result.data) {
            const clamped = Math.max(-1, Math.min(1, item.sentiment));
            updateStmt.run(clamped, item.id);
            stats.scored++;
          }
        });
        tx();

        log.debug(
          { batch: stats.batches, scored: result.data.length, model: result.model, attempt },
          'sentiment batch scored',
        );
        batchOk = true;
      } catch (err) {
        lastErr = err as Error;
        log.warn(
          { batch: stats.batches, attempt, err: lastErr.message },
          'sentiment batch attempt failed',
        );
      }
    }

    if (!batchOk) {
      log.warn(
        { batch: stats.batches, err: lastErr?.message },
        'sentiment batch failed after retries',
      );
      stats.failed += batch.length;
    }
  }

  log.info(stats, 'sentiment enrichment complete');
  return stats;
}

function escapeForPrompt(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, ' ');
}
