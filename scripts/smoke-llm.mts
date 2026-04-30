/**
 * Smoke-test the configured LLM provider. Runs three calls of increasing
 * complexity and prints the wall-clock duration for each:
 *   1. Plain text generation (1 sentence)
 *   2. JSON generation against a small zod schema
 *   3. Realistic 3-bullet thesis prompt
 *
 * Usage:  pnpm tsx scripts/smoke-llm.mts
 */

import { z } from 'zod';
import { getLlmProvider } from '../src/llm/index.js';

const provider = getLlmProvider();
console.log(`provider: ${provider.name} (model=${provider.model})`);

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    const r = await fn();
    console.log(`✓ ${label} — ${Date.now() - t}ms`);
    return r;
  } catch (err) {
    console.log(`✗ ${label} — ${Date.now() - t}ms`);
    console.log((err as Error).message);
    throw err;
  }
}

await step('text', async () => {
  const r = await provider.generateText({
    system: 'You are a concise assistant.',
    user: 'Reply with the single word: PONG',
  });
  console.log(`  text: "${r.text}"`);
});

await step('json', async () => {
  const Schema = z.object({
    sentiment: z.number().min(-1).max(1),
    rationale: z.string().min(1).max(280),
  });
  const r = await provider.generateJson({
    system: 'You output JSON. Numbers must be in the requested range.',
    user: `Score this headline for market sentiment.\n\nHeadline: "Reliance reports record Q4 profits, beats estimates"\n\nReturn JSON: { "sentiment": <-1..1>, "rationale": "<short reason>" }`,
    schema: Schema,
    maxRetries: 1,
  });
  console.log(`  json: sentiment=${r.data.sentiment}, rationale="${r.data.rationale}"`);
});

await step('thesis', async () => {
  const Schema = z.object({
    action: z.enum(['BUY', 'HOLD', 'SELL']),
    bullets: z.array(z.string()).min(3).max(3),
  });
  const r = await provider.generateJson({
    system:
      'You are an Indian-equity research assistant. Output strict JSON only. Never give individualised investment advice; you describe technical setups.',
    user: `Analyse this setup.\n\nStock: HDFCBANK\nClose: 1640\nSMA50: 1612\nSMA200: 1580\nRSI 14: 58\nVolume ratio (20d): 1.8\n\nReturn JSON: { "action": "BUY|HOLD|SELL", "bullets": ["...", "...", "..."] }`,
    schema: Schema,
    maxRetries: 1,
  });
  console.log(`  thesis: ${r.data.action}`);
  for (const b of r.data.bullets) console.log(`    - ${b}`);
});

console.log('\nLLM smoke test passed.');
