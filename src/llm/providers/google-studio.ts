import type { GenerateContentResponse } from '@google/genai';
import { GoogleGenAI, HarmBlockThreshold, HarmCategory } from '@google/genai';
import type { output, ZodType } from 'zod';
import { config } from '../../config/env.js';
import { child } from '../../logger.js';
import { parseAndValidate } from '../json.js';
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  LlmJsonResult,
  LlmProvider,
  LlmTextResult,
} from '../types.js';

/**
 * Research-oriented safety mapping for the @google/genai SDK:
 * Keeps strict levels on core abuse but prevents financial analysis terminology
 * (e.g. market crash, volatile movement, shorts) from tripping filters.
 */
const RESEARCH_SAFETY_SETTINGS = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE, // Crucial for unrestricted FII/DII quantitative analysis
  },
];

const GEMINI_CALLS_PER_MINUTE = 15;
const GEMINI_WINDOW_MS = 60_000;
const LIMITER_LONG_WAIT_INFO_MS = 2_000;
const limiterLog = child({ component: 'google-studio-rate-limiter', provider: 'google-studio' });

/**
 * Simple in-process sliding-window limiter that queues callers instead of failing.
 * When the window is saturated, callers wait until the oldest start time falls out
 * of the 60s window and then proceed in FIFO order.
 */
export class SlidingWindowRateLimiter {
  private tail: Promise<void> = Promise.resolve();
  private readonly timestamps: number[] = [];
  private pending = 0;
  private requestSeq = 0;

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  acquire(): Promise<void> {
    const requestId = ++this.requestSeq;
    const enqueuedAt = this.now();
    this.pending += 1;
    limiterLog.debug(
      {
        requestId,
        pending: this.pending,
        windowUsage: this.timestamps.length,
        capacity: this.capacity,
      },
      'gemini limiter: acquire queued',
    );

    const run = async () => {
      try {
        for (;;) {
          const current = this.now();
          while (this.timestamps.length > 0) {
            const oldest = this.timestamps[0];
            if (oldest == null) {
              this.timestamps.shift();
              continue;
            }
            if (current - oldest < this.windowMs) {
              break;
            }
            this.timestamps.shift();
          }

          if (this.timestamps.length < this.capacity) {
            this.timestamps.push(current);
            const waitedMs = current - enqueuedAt;
            const level = waitedMs >= LIMITER_LONG_WAIT_INFO_MS ? 'info' : 'debug';
            limiterLog[level](
              {
                requestId,
                waitedMs,
                pending: this.pending,
                windowUsage: this.timestamps.length,
                capacity: this.capacity,
              },
              'gemini limiter: acquire granted',
            );
            return;
          }

          const oldest = this.timestamps[0];
          if (oldest == null) {
            limiterLog.warn(
              { requestId, pending: this.pending },
              'gemini limiter: missing oldest timestamp while saturated; retrying loop',
            );
            continue;
          }
          const waitMs = Math.max(this.windowMs - (current - oldest), 1);
          limiterLog.debug(
            {
              requestId,
              waitMs,
              pending: this.pending,
              windowUsage: this.timestamps.length,
              capacity: this.capacity,
              oldestAgeMs: current - oldest,
            },
            'gemini limiter: waiting for slot',
          );
          await this.sleep(waitMs);
        }
      } finally {
        this.pending = Math.max(0, this.pending - 1);
      }
    };

    const next = this.tail.then(run, run);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

const geminiRateLimiter = new SlidingWindowRateLimiter(GEMINI_CALLS_PER_MINUTE, GEMINI_WINDOW_MS);

export class GoogleStudioProvider implements LlmProvider {
  readonly model: string;
  readonly name: string = 'google-studio';

  private readonly ai: GoogleGenAI;

  constructor() {
    if (!config.GEMINI_API_KEY) {
      throw new Error(
        'GeminiProvider requires GEMINI_API_KEY. Set it in .env or switch LLM_PROVIDER.',
      );
    }
    this.model = config.GEMINI_MODEL;
    this.ai = new GoogleGenAI({
      apiKey: config.GEMINI_API_KEY,
    });
  }

  async generateText(opts: GenerateTextOptions): Promise<LlmTextResult> {
    const started = Date.now();

    await geminiRateLimiter.acquire();

    // Call global unified generateContent engine directly from models schema
    const result = await this.ai.models.generateContent({
      model: this.model,
      contents: opts.user,
      config: {
        systemInstruction: opts.system,
        safetySettings: RESEARCH_SAFETY_SETTINGS,
        temperature: opts.temperature ?? 0.2,
        maxOutputTokens: opts.maxOutputTokens ?? 8192,
        httpOptions: { timeout: config.GOOGLE_STUDIO_TIMEOUT_MS },
        // Optional: Uncomment below line to ground stock evaluation with live web search results
        tools: [{ googleSearch: {} }],
      },
    });

    const text = extractResponseText(result);
    const usage = result.usageMetadata;

    return {
      text,
      model: this.model,
      usage: {
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
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
    const cleanedSchema = toGoogleResponseSchema(opts.schema);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const started = Date.now();
      const userPrompt =
        attempt === 0
          ? opts.user
          : `${opts.user}\n\nIMPORTANT: Return ONLY a single valid JSON object matching the requested schema. Do not output markdown codeblocks.`;

      try {
        await geminiRateLimiter.acquire();

        const result = await this.ai.models.generateContent({
          model: this.model,
          contents: userPrompt,
          config: {
            systemInstruction: opts.system,
            safetySettings: RESEARCH_SAFETY_SETTINGS,
            temperature: opts.temperature ?? 0.1,
            maxOutputTokens: opts.maxOutputTokens ?? 8192,
            httpOptions: { timeout: config.GOOGLE_STUDIO_TIMEOUT_MS },
            // Strictly enforce structured output matching your custom schema
            responseMimeType: 'application/json',
            // Only pass responseSchema when it is already JSON-schema-like.
            responseSchema: cleanedSchema,
          },
        });

        const raw = extractResponseText(result, { rejectMaxTokens: true });
        lastRaw = raw;
        const usage = result.usageMetadata;

        const data = parseAndValidate(raw, opts.schema);
        return {
          data,
          raw,
          model: this.model,
          usage: {
            inputTokens: usage?.promptTokenCount ?? 0,
            outputTokens: usage?.candidatesTokenCount ?? 0,
            durationMs: Date.now() - started,
          },
        };
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(
          `Google AI Studio JSON generation failed after retries: ${lastRaw.slice(0, 300)}`,
        );
  }
}

function toGoogleResponseSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') {
    return undefined;
  }

  let candidate: unknown;
  const maybeSchema = schema as { toJSON?: () => unknown; jsonSchema?: unknown };
  if (typeof maybeSchema.toJSON === 'function') {
    candidate = maybeSchema.toJSON();
  } else if (maybeSchema.jsonSchema) {
    candidate = maybeSchema.jsonSchema;
  } else {
    candidate = JSON.parse(JSON.stringify(schema));
  }

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }

  const payload = candidate as Record<string, unknown>;
  payload.$schema = undefined;
  payload.additionalProperties = undefined;

  // Zod internals like "_def"/"~standard" are invalid for Gemini responseSchema.
  if (!isLikelyJsonSchema(payload)) {
    return undefined;
  }

  return payload;
}

function isLikelyJsonSchema(value: Record<string, unknown>): boolean {
  return ['type', 'properties', 'items', 'required', 'enum', 'oneOf', 'anyOf', 'allOf'].some(
    (k) => k in value,
  );
}

/**
 * Refactored safety extractor adapted for @google/genai wrapper results mapping.
 */
function extractResponseText(
  result: GenerateContentResponse,
  opts?: { rejectMaxTokens?: boolean },
): string {
  // Check global input prompt rejection status
  const promptFeedback = result.promptFeedback;
  if (promptFeedback?.blockReason) {
    throw new Error(`Google Studio blocked the prompt sequence: ${promptFeedback.blockReason}`);
  }

  const candidates = result.candidates ?? [];
  if (candidates.length === 0) {
    throw new Error('Google Studio returned empty response array with zero structural candidates.');
  }

  const primeCandidate = candidates[0];
  if (!primeCandidate) {
    throw new Error('Google Studio returned a null first candidate.');
  }
  const finishReason = primeCandidate.finishReason;

  // Process stop codes safely
  if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
    throw new Error(`Google Studio stopped execution process via code: ${finishReason}`);
  }

  if (opts?.rejectMaxTokens && finishReason === 'MAX_TOKENS') {
    throw new Error('Google Studio target hit MAX_TOKENS ceiling — output buffer truncated.');
  }

  // Utilize the SDK's built-in text getter helper on the core object result response mapping
  if (result.text) {
    return result.text.trim();
  }

  throw new Error('Google Studio failed to yield valid textual candidate payloads.');
}
