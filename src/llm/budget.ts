/**
 * Per-run LLM spend cap. Single-process daily pipeline sets `currentRunId` via
 * `startRunBudget`; worker-thread deployments would need explicit run context.
 */

import { child } from '../logger.js';

const log = child({ component: 'llm-budget' });

export class LlmBudgetExceededError extends Error {
  readonly runId: string;
  readonly spent: number;
  readonly cap: number;

  constructor(runId: string, spent: number, cap: number) {
    super(
      `LLM budget exceeded for run ${runId}: spent $${spent.toFixed(4)} / cap $${cap.toFixed(2)}`,
    );
    this.name = 'LlmBudgetExceededError';
    this.runId = runId;
    this.spent = spent;
    this.cap = cap;
  }
}

const budgets = new Map<string, { spent: number; cap: number }>();
let currentRunId: string | null = null;

export function getCurrentRunId(): string | null {
  return currentRunId;
}

export function startRunBudget(runId: string, capUsd: number): void {
  currentRunId = runId;
  budgets.set(runId, { spent: 0, cap: capUsd });
}

export function clearRunBudget(runId?: string): void {
  const id = runId ?? currentRunId;
  if (id) {
    budgets.delete(id);
  }
  if (!runId || currentRunId === runId) {
    currentRunId = null;
  }
}

function getBudget(runId: string): { spent: number; cap: number } {
  const budget = budgets.get(runId);
  if (!budget) {
    throw new Error(`No LLM budget initialized for run ${runId}`);
  }
  return budget;
}

export function assertBudgetAvailable(runId: string): void {
  const budget = getBudget(runId);
  if (budget.spent >= budget.cap) {
    log.error({ runId, spent: budget.spent, cap: budget.cap }, 'LLM budget cap exceeded');
    throw new LlmBudgetExceededError(runId, budget.spent, budget.cap);
  }
}

export function getRunBudget(runId: string): { spent: number; cap: number } | undefined {
  return budgets.get(runId);
}

export function recordLlmSpend(runId: string, usd: number): void {
  const budget = getBudget(runId);
  const next = budget.spent + usd;
  if (next > budget.cap) {
    budget.spent = next;
    log.error({ runId, spent: next, cap: budget.cap }, 'LLM budget cap exceeded after spend');
    throw new LlmBudgetExceededError(runId, next, budget.cap);
  }
  budget.spent = next;
}
