/**
 * Minimal Google Studio provider smoke test.
 *
 * Verifies:
 *  1) plain text generation succeeds
 *  2) JSON generation succeeds and validates through zod schema
 *
 * Usage:
 *   LLM_PROVIDER=google-studio pnpm tsx scripts/smoke-google-studio.mts
 */

import { z } from 'zod';
import { getLlmProvider } from '../src/llm/index.js';

async function main(): Promise<void> {
  const provider = getLlmProvider();
  if (provider.name !== 'google-studio') {
    throw new Error(
      `Expected google-studio provider, got "${provider.name}". Run with LLM_PROVIDER=google-studio.`,
    );
  }

  console.log(`provider: ${provider.name} (model=${provider.model})`);

  const textResult = await provider.generateText({
    system: 'You are a terse assistant.',
    user: 'Reply with exactly: PONG',
    maxOutputTokens: 32,
    temperature: 0,
  });

  console.log(`text: ${textResult.text}`);

  const PingSchema = z.object({
    ok: z.boolean(),
    provider: z.string().min(1),
  });

  const jsonResult = await provider.generateJson({
    system: 'Return strict JSON only. No markdown.',
    user: 'Return JSON object: {"ok": true, "provider": "google-studio"}',
    schema: PingSchema,
    maxRetries: 0,
    maxOutputTokens: 64,
    temperature: 0,
  });

  console.log(`json: ${JSON.stringify(jsonResult.data)}`);
  console.log('Google Studio smoke test passed.');
}

void main().catch((err) => {
  console.error('Google Studio smoke test failed.');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
