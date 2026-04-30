/**
 * Google Vertex AI (Gemini) provider stub. Wired up in Phase 3 with
 * `@google-cloud/vertexai`. Auth uses Application Default Credentials -
 * point GOOGLE_APPLICATION_CREDENTIALS at a service-account JSON.
 */

import { config } from '../../config/env.js';
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  LlmJsonResult,
  LlmProvider,
  LlmTextResult,
} from '../types.js';

export class VertexProvider implements LlmProvider {
  readonly name = 'vertex';
  readonly model: string;

  constructor() {
    if (!config.GOOGLE_VERTEX_PROJECT) {
      throw new Error(
        'VertexProvider requires GOOGLE_VERTEX_PROJECT. Set it in .env or switch LLM_PROVIDER.',
      );
    }
    this.model = config.VERTEX_MODEL;
  }

  async generateText(_opts: GenerateTextOptions): Promise<LlmTextResult> {
    throw new Error(
      'VertexProvider.generateText is not implemented yet. Add @google-cloud/vertexai in Phase 3.',
    );
  }

  async generateJson<T>(_opts: GenerateJsonOptions<T>): Promise<LlmJsonResult<T>> {
    throw new Error(
      'VertexProvider.generateJson is not implemented yet. Add @google-cloud/vertexai in Phase 3.',
    );
  }
}
