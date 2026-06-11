/**
 * Budget-aware LLM wrapper and per-model token pricing.
 * All production providers are wrapped via `wrapWithBudgetTracking` in the factory.
 */

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

/** USD per token (input / output). See architecture-v2.md §7. */
export const MODEL_COST_USD_PER_TOKEN: Record<string, { input: number; output: number }> = {
  'deepseek-chat': { input: 0.00000027, output: 0.0000011 },
};

function resolveModelPricing(model: string): { input: number; output: number } | undefined {
  if (model in MODEL_COST_USD_PER_TOKEN) {
    return MODEL_COST_USD_PER_TOKEN[model];
  }
  const base = model.split(/[:/]/)[0]?.trim();
  if (base && base in MODEL_COST_USD_PER_TOKEN) {
    return MODEL_COST_USD_PER_TOKEN[base];
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

  async generateJson<T>(opts: GenerateJsonOptions<T>): Promise<LlmJsonResult<T>> {
    const runId = getCurrentRunId();
    if (runId) assertBudgetAvailable(runId);

    const result = await this.inner.generateJson(opts);
    trackUsage(result.model, result.usage);
    return result;
  }
}

export function wrapWithBudgetTracking(provider: LlmProvider): LlmProvider {
  return new BudgetAwareLlmProvider(provider);
}
