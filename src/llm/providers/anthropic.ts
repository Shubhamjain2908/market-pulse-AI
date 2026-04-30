/**
 * Anthropic Claude provider. Uses the official @anthropic-ai/sdk.
 * Supports both generateText (for narrative sections) and generateJson
 * (with zod validation + retry for structured output like theses).
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config/env.js';
import { parseAndValidate } from '../json.js';
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
  private readonly client: Anthropic;

  constructor() {
    if (!config.ANTHROPIC_API_KEY) {
      throw new Error(
        'AnthropicProvider requires ANTHROPIC_API_KEY. Set it in .env or switch LLM_PROVIDER.',
      );
    }
    this.model = config.ANTHROPIC_MODEL;
    this.client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }

  async generateText(opts: GenerateTextOptions): Promise<LlmTextResult> {
    const started = Date.now();
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: opts.maxOutputTokens ?? 4096,
        temperature: opts.temperature ?? 0.2,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
      },
      { signal: opts.signal ?? null },
    );

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return {
      text,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        durationMs: Date.now() - started,
      },
    };
  }

  async generateJson<T>(opts: GenerateJsonOptions<T>): Promise<LlmJsonResult<T>> {
    const maxRetries = opts.maxRetries ?? 1;
    let lastErr: unknown;
    let lastRaw = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const text = await this.generateText({
        ...opts,
        user:
          attempt === 0
            ? opts.user
            : `${opts.user}\n\nIMPORTANT: Your previous response was not valid JSON. Return ONLY a JSON object, no markdown fences, no explanation.`,
      });
      lastRaw = text.text;
      try {
        const data = parseAndValidate(text.text, opts.schema);
        return { data, raw: text.text, model: text.model, usage: text.usage };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Anthropic JSON generation failed: ${lastRaw.slice(0, 200)}`);
  }
}
