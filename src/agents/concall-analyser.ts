/**
 * Concall intelligence analyser.
 * For each concall transcript with extracted text, calls the LLM to produce
 * structured analysis (sentiment, credibility, guidance, delivery, deflections, summary).
 *
 * Follows the pattern from `generateTheses` in `thesis-generator.ts`:
 * - Uses `llm.generateJson` with zod schema
 * - `p-limit` concurrency respecting `config.THESIS_CONCURRENCY`
 * - Budget via `src/llm/budget.ts`
 * - Never throws — returns result counters on any failure
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import pLimit from 'p-limit';
import { config } from '../config/env.js';
import { getDb } from '../db/connection.js';
import {
  type ConcallIntelRow,
  getLatestConcallIntel,
  getTranscriptsWithoutIntel,
  upsertConcallIntel,
} from '../db/queries.js';
import { assertBudgetAvailable, getCurrentRunId } from '../llm/budget.js';
import { getLlmProvider } from '../llm/index.js';
import type { LlmProvider } from '../llm/types.js';
import { child } from '../logger.js';
import { type ConcallIntel, ConcallIntelSchema } from '../types/domain.js';

const log = child({ component: 'concall-analyser' });

const CONCALL_SYSTEM_PROMPT = `You are a senior Indian equity research analyst specialising in earnings conference calls.
Analyse the provided transcript and return structured intelligence.

RULES:
1. Use ONLY the transcript text provided — do NOT use any outside knowledge.
2. Guidance items MUST include a "verbatim" field with a short, direct quote from the transcript.
3. For delivery/promise-vs-delivery: compare ONLY against the prior guidance passed in (if any).
   Mark anything unverifiable as "unverifiable" — never infer actuals from context.
4. Deflections: note questions where management avoided answering. Provide brief description of each deflection.
5. Summary: max 120 words. Focus on actionable insights for an equity investor.
6. credibility_stars: 1 (low confidence, evasive) to 5 (highly credible, detailed guidance).
7. sentiment: one of positive, cautiously_positive, neutral, cautious, negative.

Return ONLY a single JSON object matching the schema.`;

/**
 * Analyse pending concall transcripts via LLM.
 * Processes transcripts that have text but no intel row yet.
 * Respects LLM budget and concurrency limits.
 */
export interface AnalyseConcallOptions {
  maxPerRun?: number;
  signal?: AbortSignal;
}

export interface AnalyseConcallResult {
  analysed: number;
  failed: number;
  skipped: number;
}

export async function analyseConcallTranscripts(
  opts: AnalyseConcallOptions = {},
  db: DatabaseType = getDb(),
  llm: LlmProvider = getLlmProvider(),
): Promise<AnalyseConcallResult> {
  const maxPerRun = opts.maxPerRun ?? config.CONCALL_MAX_PER_RUN;
  const rawTranscripts = getTranscriptsWithoutIntel(maxPerRun, db);
  // Narrow text from string|null to string (SQL WHERE ct.text IS NOT NULL guarantees non-null)
  const transcripts: Array<{
    symbol: string;
    announcedAt: string;
    text: string;
    charCount: number | null;
  }> = rawTranscripts.map((t) => ({
    symbol: t.symbol,
    announcedAt: t.announcedAt,
    text: t.text ?? '',
    charCount: t.charCount,
  }));

  if (transcripts.length === 0) {
    log.info('no unanalysed concall transcripts');
    return { analysed: 0, failed: 0, skipped: 0 };
  }

  log.info({ count: transcripts.length }, 'concall analysis starting');

  const limit = pLimit(config.THESIS_CONCURRENCY);
  const results = await Promise.all(
    transcripts.map((t) =>
      limit(async () => {
        try {
          // Check budget before each call
          const runId = getCurrentRunId();
          if (runId) assertBudgetAvailable(runId);

          // Get prior intel for delivery comparison
          const priorIntel = getLatestConcallIntel(t.symbol, t.announcedAt, db);

          const userMessage = buildConcallUserMessage(t, priorIntel);

          const result = await llm.generateJson<ConcallIntel>({
            system: CONCALL_SYSTEM_PROMPT,
            user: userMessage,
            schema: ConcallIntelSchema,
            temperature: 0.2,
            maxRetries: 2,
          });

          const data = result.data;

          // Build the stored row
          const row: ConcallIntelRow = {
            symbol: t.symbol,
            announcedAt: t.announcedAt,
            quarterLabel: data.quarterLabel ?? null,
            sentiment: data.sentiment,
            credibilityStars: data.credibilityStars,
            guidanceJson: JSON.stringify(data.guidance),
            deliveryJson: data.delivery ? JSON.stringify(data.delivery) : null,
            deflectionsJson: data.deflections ? JSON.stringify(data.deflections) : null,
            summary: data.summary,
            model: result.model,
          };

          upsertConcallIntel(row, db);

          log.info(
            {
              symbol: t.symbol,
              sentiment: data.sentiment,
              credibilityStars: data.credibilityStars,
              guidanceCount: data.guidance.length,
              model: result.model,
            },
            'concall analysis complete',
          );
          return { ok: true as const };
        } catch (err) {
          log.warn({ symbol: t.symbol, err: (err as Error).message }, 'concall analysis failed');
          return { ok: false as const };
        }
      }),
    ),
  );

  let analysed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.ok) analysed++;
    else failed++;
  }

  log.info({ analysed, failed, total: transcripts.length }, 'concall analysis batch complete');
  return { analysed, failed, skipped: transcripts.length - analysed - failed };
}

/**
 * Build the user message for the LLM concall analysis call.
 * Includes transcript text and optional prior guidance for delivery tracking.
 */
function buildConcallUserMessage(
  transcript: {
    symbol: string;
    announcedAt: string;
    text: string;
    charCount: number | null;
  },
  priorIntel: ConcallIntelRow | null,
): string {
  const parts: string[] = [];

  parts.push(`Analyse the ${transcript.symbol} concall transcript announced on ${transcript.announcedAt}.
Transcript length: ${transcript.charCount?.toLocaleString() ?? 'unknown'} characters.

=== TRANSCRIPT TEXT START ===
${transcript.text}
=== TRANSCRIPT TEXT END ===`);

  if (priorIntel) {
    parts.push(`
=== PRIOR GUIDANCE (for delivery tracking) ===
Sentiment: ${priorIntel.sentiment}
Credibility: ${priorIntel.credibilityStars}/5
Previous guidance: ${priorIntel.guidanceJson}
Previous delivery: ${priorIntel.deliveryJson ?? 'none'}
Previous deflections: ${priorIntel.deflectionsJson ?? 'none'}
Previous summary: ${priorIntel.summary}
`);
  } else {
    parts.push(`
No prior guidance record available for delivery comparison — mark all delivery outcomes as "unverifiable".
`);
  }

  return parts.join('\n');
}
