/**
 * Budget-aware LLM wrapper and per-model token pricing.
 * All production providers are wrapped via `wrapWithBudgetTracking` in the factory.
 */

import type { output, ZodType } from 'zod';
import { child } from '../logger.js';
import {
  assertBudgetAvailable,
  getCurrentRunId,
  getRunBudget,
  LlmBudgetExceededError,
  recordLlmSpend,
} from './budget.js';
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  LlmJsonResult,
  LlmProvider,
  LlmTextResult,
  LlmUsage,
} from './types.js';

const log = child({ component: 'llm-provider' });

/** Convert published $/1M token list price to $/token. */
function perMillion(usd: number): number {
  return usd / 1_000_000;
}

/**
 * USD per token (input / output). Standard tier, prompts ≤200k tokens.
 * Sources: https://ai.google.dev/gemini-api/docs/pricing (Jun 2026).
 */
export const MODEL_COST_USD_PER_TOKEN: Record<string, { input: number; output: number }> = {
  // DeepSeek Tier (Alias mapping to V4 Flash pricing: $0.14 input / $0.28 output per 1M)
  'deepseek-chat': { input: perMillion(0.14), output: perMillion(0.28) },
  'deepseek-v4-flash': { input: perMillion(0.14), output: perMillion(0.28) },
  'deepseek-v4-pro': { input: perMillion(1.74), output: perMillion(3.48) },

  // Gemini 3.x Tier ($2.00 input / $12.00 output per 1M)
  'gemini-3.1-pro-preview': { input: perMillion(2.0), output: perMillion(12.0) },
  'gemini-3.1-pro': { input: perMillion(2.0), output: perMillion(12.0) },

  // Gemini 2.5 Tier
  'gemini-2.5-pro': { input: perMillion(1.25), output: perMillion(10.0) },
  'gemini-2.5-flash': { input: perMillion(0.3), output: perMillion(2.5) },
};

function modelIdFromResponse(model: string): string {
  const trimmed = model.trim();
  const segments = trimmed.split(/[:/]/);
  return (segments[segments.length - 1] ?? trimmed).trim();
}

function resolveModelPricing(model: string): { input: number; output: number } | undefined {
  const candidates = [model.trim(), modelIdFromResponse(model)];
  for (const id of candidates) {
    if (id in MODEL_COST_USD_PER_TOKEN) {
      return MODEL_COST_USD_PER_TOKEN[id];
    }
    const withoutPreview = id.replace(/-preview(-customtools)?$/, '');
    if (withoutPreview !== id && withoutPreview in MODEL_COST_USD_PER_TOKEN) {
      return MODEL_COST_USD_PER_TOKEN[withoutPreview];
    }
  }
  return undefined;
}

function computeSpendUsd(model: string, usage: LlmUsage, runId: string): number {
  const pricing = resolveModelPricing(model);
  if (!pricing) {
    const budget = getRunBudget(runId) ?? { spent: 0, cap: 0 };
    log.error({ model, runId }, 'unknown model pricing — fail-closed budget stop');
    throw new LlmBudgetExceededError(runId, budget.spent, budget.cap);
  }
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return input * pricing.input + output * pricing.output;
}

function trackUsage(model: string, usage: LlmUsage): void {
  const runId = getCurrentRunId();
  if (!runId) return;

  const hasTokens =
    (usage.inputTokens != null && usage.inputTokens > 0) ||
    (usage.outputTokens != null && usage.outputTokens > 0);
  if (!hasTokens) return;

  const usd = computeSpendUsd(model, usage, runId);
  if (usd > 0) {
    recordLlmSpend(runId, usd);
  }
}

class BudgetAwareLlmProvider implements LlmProvider {
  constructor(private readonly inner: LlmProvider) {}

  get name(): string {
    return this.inner.name;
  }

  get model(): string {
    return this.inner.model;
  }

  async generateText(opts: GenerateTextOptions): Promise<LlmTextResult> {
    const runId = getCurrentRunId();
    if (runId) assertBudgetAvailable(runId);

    const result = await this.inner.generateText(opts);
    trackUsage(result.model, result.usage);
    return result;
  }

  async generateJson<TSchema extends ZodType>(
    opts: GenerateJsonOptions<TSchema>,
  ): Promise<LlmJsonResult<output<TSchema>>> {
    const runId = getCurrentRunId();
    if (runId) assertBudgetAvailable(runId);

    const result = await this.inner.generateJson(opts as GenerateJsonOptions<TSchema>);
    trackUsage(result.model, result.usage);
    return result as LlmJsonResult<output<TSchema>>;
  }
}

export function wrapWithBudgetTracking(provider: LlmProvider): LlmProvider {
  return new BudgetAwareLlmProvider(provider);
}
