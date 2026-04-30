/**
 * Helpers for coaxing structured JSON out of LLMs that return text. Kept
 * provider-agnostic so each adapter can call into them.
 */

import { ZodError, type ZodType } from 'zod';

/**
 * Extract the first JSON object/array from a string, tolerating Markdown
 * code fences, leading prose, and trailing commentary - all common with
 * chat-tuned models.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();

  const firstBrace = trimmed.search(/[[{]/);
  if (firstBrace === -1) return trimmed;

  const opener = trimmed[firstBrace];
  const closer = opener === '{' ? '}' : ']';
  const lastClose = trimmed.lastIndexOf(closer);
  if (lastClose > firstBrace) {
    return trimmed.slice(firstBrace, lastClose + 1);
  }
  return trimmed;
}

export class LlmJsonValidationError extends Error {
  constructor(
    public readonly raw: string,
    public override readonly cause: unknown,
  ) {
    const message =
      cause instanceof ZodError
        ? `LLM JSON failed schema validation: ${cause.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
        : `LLM JSON parse error: ${(cause as Error)?.message ?? 'unknown'}`;
    super(message);
    this.name = 'LlmJsonValidationError';
  }
}

export function parseAndValidate<T>(raw: string, schema: ZodType<T>): T {
  const candidate = extractJson(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new LlmJsonValidationError(raw, err);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new LlmJsonValidationError(raw, result.error);
  }
  return result.data;
}
