/**
 * Anthropic Claude provider stub. The full implementation lands in Phase 3
 * once `@anthropic-ai/sdk` is added as a dependency. For Phase 0 we keep the
 * type contract honest by throwing if the user selects this provider without
 * the implementation in place.
 */

import { config } from '../../config/env.js';
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  LlmJsonResult,
  LlmProvider,
  LlmTextResult,
} from '../types.js';

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;

  constructor() {
    if (!config.ANTHROPIC_API_KEY) {
      throw new Error(
        'AnthropicProvider requires ANTHROPIC_API_KEY. Set it in .env or switch LLM_PROVIDER.',
      );
    }
    this.model = config.ANTHROPIC_MODEL;
  }

  async generateText(_opts: GenerateTextOptions): Promise<LlmTextResult> {
    throw new Error(
      'AnthropicProvider.generateText is not implemented yet. Add @anthropic-ai/sdk in Phase 3.',
    );
  }

  async generateJson<T>(_opts: GenerateJsonOptions<T>): Promise<LlmJsonResult<T>> {
    throw new Error(
      'AnthropicProvider.generateJson is not implemented yet. Add @anthropic-ai/sdk in Phase 3.',
    );
  }
}
