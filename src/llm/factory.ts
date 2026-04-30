/**
 * LLM provider factory. Resolves the active provider from env config.
 * The factory is the only place that knows which providers exist - the rest
 * of the codebase consumes the `LlmProvider` interface.
 */

import { config } from '../config/env.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { CursorAgentProvider } from './providers/cursor-agent.js';
import { MockLlmProvider } from './providers/mock.js';
import { OpenAIProvider } from './providers/openai.js';
import { VertexProvider } from './providers/vertex.js';
import type { LlmProvider } from './types.js';

let cached: LlmProvider | null = null;

export function getLlmProvider(): LlmProvider {
  if (cached) return cached;
  cached = createLlmProvider();
  return cached;
}

/** Force a specific provider, mostly used in tests. */
export function setLlmProvider(provider: LlmProvider): void {
  cached = provider;
}

/** Reset the cache - useful after env changes in tests. */
export function resetLlmProvider(): void {
  cached = null;
}

function createLlmProvider(): LlmProvider {
  switch (config.LLM_PROVIDER) {
    case 'cursor-agent':
      return new CursorAgentProvider();
    case 'anthropic':
      return new AnthropicProvider();
    case 'vertex':
      return new VertexProvider();
    case 'openai':
      return new OpenAIProvider();
    case 'mock':
      return new MockLlmProvider();
    default: {
      const exhaustive: never = config.LLM_PROVIDER;
      throw new Error(`Unsupported LLM_PROVIDER: ${exhaustive}`);
    }
  }
}
