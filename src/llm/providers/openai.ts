/**
 * OpenAI provider stub. Wired up in Phase 3 with the `openai` SDK.
 */

import { config } from '../../config/env.js';
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  LlmJsonResult,
  LlmProvider,
  LlmTextResult,
} from '../types.js';

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  readonly model: string;

  constructor() {
    if (!config.OPENAI_API_KEY) {
      throw new Error(
        'OpenAIProvider requires OPENAI_API_KEY. Set it in .env or switch LLM_PROVIDER.',
      );
    }
    this.model = config.OPENAI_MODEL;
  }

  async generateText(_opts: GenerateTextOptions): Promise<LlmTextResult> {
    throw new Error(
      'OpenAIProvider.generateText is not implemented yet. Add the openai SDK in Phase 3.',
    );
  }

  async generateJson<T>(_opts: GenerateJsonOptions<T>): Promise<LlmJsonResult<T>> {
    throw new Error(
      'OpenAIProvider.generateJson is not implemented yet. Add the openai SDK in Phase 3.',
    );
  }
}
