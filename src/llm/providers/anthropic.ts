/**
 * Anthropic Claude provider. Uses the official @anthropic-ai/sdk.
 * Supports both generateText (for narrative sections) and generateJson
 * (with zod validation + retry for structured output like theses).
 */

import Anthropic from '@anthropic-ai/sdk';
import type { output, ZodType } from 'zod';
import { config } from '../../config/env.js';
import { parseAndValidate } from '../json.js';
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  LlmJsonResult,
  LlmProvider,
  LlmTextResult,
} from '../types.js';

async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fn(ctl.signal);
  } catch (err) {
    if (ctl.signal.aborted) {
      throw new Error(`${label} timed out after ${ms}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([a, b]);
  }
  const merged = new AbortController();
  const abort = () => merged.abort();
  if (a.aborted || b.aborted) {
    merged.abort();
    return merged.signal;
  }
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return merged.signal;
}

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
    const response = await withTimeout(
      (timeoutSignal) => {
        const signal = opts.signal ? mergeSignals(opts.signal, timeoutSignal) : timeoutSignal;
        return this.client.messages.create(
          {
            model: this.model,
            max_tokens: opts.maxOutputTokens ?? 4096,
            temperature: opts.temperature ?? 0.2,
            system: opts.system,
            messages: [{ role: 'user', content: opts.user }],
          },
          { signal },
        );
      },
      config.ANTHROPIC_TIMEOUT_MS,
      'anthropic.messages.create',
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

  async generateJson<TSchema extends ZodType>(
    opts: GenerateJsonOptions<TSchema>,
  ): Promise<LlmJsonResult<output<TSchema>>> {
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
