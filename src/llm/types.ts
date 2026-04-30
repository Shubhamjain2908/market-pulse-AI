/**
 * LLM provider contract. Designed so we can swap between cursor-agent CLI,
 * Anthropic, Vertex (Gemini) and OpenAI without changing prompt code.
 *
 * All methods accept an optional AbortSignal so we can cancel long-running
 * generations when the cron job times out or the CLI is interrupted.
 */

import type { ZodType } from 'zod';

export interface GenerateTextOptions {
  /** System prompt - persona and constraints. */
  system: string;
  /** User prompt - the actual task/data. */
  user: string;
  /** Sampling temperature. Defaults to 0.2 for analytical tasks. */
  temperature?: number;
  /** Hard cap on output tokens. Provider-specific. */
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface GenerateJsonOptions<T> extends GenerateTextOptions {
  /** Zod schema the response must conform to. */
  schema: ZodType<T>;
  /** Number of repair attempts on parse/validation failure. Default: 1. */
  maxRetries?: number;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
}

export interface LlmTextResult {
  text: string;
  usage: LlmUsage;
  model: string;
}

export interface LlmJsonResult<T> {
  data: T;
  /** Raw text returned by the model, kept for audit/debugging. */
  raw: string;
  usage: LlmUsage;
  model: string;
}

export interface LlmProvider {
  /** Stable id, e.g. 'cursor-agent' | 'anthropic' | 'vertex' | 'openai'. */
  readonly name: string;
  /** Resolved model identifier - useful for logs and persistence. */
  readonly model: string;

  generateText(opts: GenerateTextOptions): Promise<LlmTextResult>;
  generateJson<T>(opts: GenerateJsonOptions<T>): Promise<LlmJsonResult<T>>;
}
