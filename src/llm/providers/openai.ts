/**
 * OpenAI provider. Uses the official `openai` SDK (v6+).
 * Supports generateText and generateJson with zod retry.
 */

import OpenAI from 'openai';
import { config } from '../../config/env.js';
import { parseAndValidate } from '../json.js';
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
  private readonly client: OpenAI;

  constructor() {
    if (!config.OPENAI_API_KEY) {
      throw new Error(
        'OpenAIProvider requires OPENAI_API_KEY. Set it in .env or switch LLM_PROVIDER.',
      );
    }
    this.model = config.OPENAI_MODEL;
    this.client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }

  async generateText(opts: GenerateTextOptions): Promise<LlmTextResult> {
    const started = Date.now();
    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxOutputTokens ?? 4096,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      },
      { signal: opts.signal ?? undefined },
    );

    const text = response.choices[0]?.message?.content ?? '';
    return {
      text,
      model: response.model,
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
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
      : new Error(`OpenAI JSON generation failed: ${lastRaw.slice(0, 200)}`);
  }
}
