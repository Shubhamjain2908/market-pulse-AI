import { describe, expect, it } from 'vitest';
import {
  assertBudgetAvailable,
  clearRunBudget,
  LlmBudgetExceededError,
  recordLlmSpend,
  startRunBudget,
} from '../../src/llm/budget.js';

describe('llm budget', () => {
  const runId = 'test-run-2026-06-11';

  it('tracks spend and throws when cap exceeded', () => {
    startRunBudget(runId, 0.5);
    assertBudgetAvailable(runId);
    recordLlmSpend(runId, 0.3);
    recordLlmSpend(runId, 0.15);
    expect(() => recordLlmSpend(runId, 0.1)).toThrow(LlmBudgetExceededError);
    clearRunBudget(runId);
  });

  it('assertBudgetAvailable fails when already at cap', () => {
    startRunBudget(runId, 0.1);
    recordLlmSpend(runId, 0.1);
    expect(() => assertBudgetAvailable(runId)).toThrow(LlmBudgetExceededError);
    clearRunBudget(runId);
  });
});
