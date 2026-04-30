/**
 * Mock LLM provider used by tests and the `LLM_PROVIDER=mock` mode. Returns
 * deterministic fake content so the rest of the pipeline can be exercised
 * without making network calls.
 */

import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  LlmJsonResult,
  LlmProvider,
  LlmTextResult,
} from '../types.js';

export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock-model';

  async generateText(_opts: GenerateTextOptions): Promise<LlmTextResult> {
    return {
      text: '[mock] this is a placeholder response.',
      model: this.model,
      usage: { durationMs: 0 },
    };
  }

  async generateJson<T>(_opts: GenerateJsonOptions<T>): Promise<LlmJsonResult<T>> {
    // Build a minimal object that conforms to the schema by inspecting it.
    // Tests can override this provider with their own mock when they need
    // more specific data.
    const fallback = {} as unknown as T;
    return {
      data: fallback,
      raw: JSON.stringify(fallback),
      model: this.model,
      usage: { durationMs: 0 },
    };
  }
}
