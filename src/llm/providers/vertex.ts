/**
 * Google Vertex AI — Gemini via `@google/genai`.
 *
 * Auth: Application Default Credentials. Either set
 * `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON path, or run
 * `gcloud auth application-default login` for local development.
 *
 * Model IDs follow Vertex GA naming (see Cloud docs "Model versions and
 * lifecycle"). Defaults in env point at the current Gemini 2.5 family.
 *
 * Migrated from @google-cloud/vertexai (deprecated mid-2026) to @google/genai.
 */

import { FinishReason, GoogleGenAI, HarmBlockThreshold, HarmCategory } from '@google/genai';
import { config } from '../../config/env.js';
import { parseAndValidate } from '../json.js';
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  LlmJsonResult,
  LlmProvider,
  LlmTextResult,
} from '../types.js';

/**
 * Research-oriented safety: keep harassment/hate/sexual strict, but allow
 * "dangerous" bucket to pass at BLOCK_NONE — FII/DII flows and index % moves
 * often get mis-tagged as generic policy/financial-advice and return empty candidates.
 */
const RESEARCH_SAFETY_SETTINGS = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

export class VertexProvider implements LlmProvider {
  readonly name = 'vertex';
  readonly model: string;
  private readonly ai: GoogleGenAI;

  constructor() {
    if (!config.GOOGLE_VERTEX_PROJECT) {
      throw new Error(
        'VertexProvider requires GOOGLE_VERTEX_PROJECT. Set it in .env or switch LLM_PROVIDER.',
      );
    }
    this.model = config.VERTEX_MODEL;
    this.ai = new GoogleGenAI({
      vertexai: true,
      project: config.GOOGLE_VERTEX_PROJECT,
      location: config.GOOGLE_VERTEX_LOCATION,
    });
  }

  async generateText(opts: GenerateTextOptions): Promise<LlmTextResult> {
    const started = Date.now();

    const result = await this.ai.models.generateContent({
      model: this.model,
      contents: opts.user,
      config: {
        systemInstruction: opts.system,
        safetySettings: RESEARCH_SAFETY_SETTINGS,
        temperature: opts.temperature ?? 0.2,
        maxOutputTokens: opts.maxOutputTokens ?? 8192,
      },
    });

    const text = extractResponseText(result);
    const usage = result.usageMetadata;
    return {
      text,
      model: this.model,
      usage: {
        inputTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
        durationMs: Date.now() - started,
      },
    };
  }

  async generateJson<T>(opts: GenerateJsonOptions<T>): Promise<LlmJsonResult<T>> {
    const maxRetries = opts.maxRetries ?? 1;
    let lastErr: unknown;
    let lastRaw = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const started = Date.now();
      const userPrompt =
        attempt === 0
          ? opts.user
          : `${opts.user}\n\nIMPORTANT: Return ONLY a single valid JSON object matching the schema. No markdown fences, no commentary.`;

      try {
        const result = await this.ai.models.generateContent({
          model: this.model,
          contents: userPrompt,
          config: {
            systemInstruction: opts.system,
            safetySettings: RESEARCH_SAFETY_SETTINGS,
            temperature: opts.temperature ?? 0.1,
            maxOutputTokens: opts.maxOutputTokens ?? 8192,
            responseMimeType: 'application/json',
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
            inputTokens: usage?.promptTokenCount,
            outputTokens: usage?.candidatesTokenCount,
            durationMs: Date.now() - started,
          },
        };
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Vertex JSON generation failed after retries: ${lastRaw.slice(0, 300)}`);
  }
}

function extractResponseText(result: any, opts?: { rejectMaxTokens?: boolean }): string {
  const promptFeedback = result.promptFeedback;
  if (promptFeedback?.blockReason) {
    throw new Error(`Vertex blocked the prompt: ${promptFeedback.blockReason}`);
  }

  const candidates = result.candidates ?? [];
  if (candidates.length === 0) {
    throw new Error('Vertex returned no candidates.');
  }

  const primeCandidate = candidates[0];
  const finishReason = primeCandidate.finishReason;

  if (
    finishReason &&
    finishReason !== FinishReason.STOP &&
    finishReason !== FinishReason.MAX_TOKENS
  ) {
    throw new Error(
      `Vertex stopped with finishReason=${finishReason}${primeCandidate.finishMessage ? `: ${primeCandidate.finishMessage}` : ''}`,
    );
  }

  if (opts?.rejectMaxTokens && finishReason === FinishReason.MAX_TOKENS) {
    throw new Error(
      'Vertex hit MAX_TOKENS — output truncated. Increase maxOutputTokens or shorten the task.',
    );
  }

  if (result.text) {
    return result.text.trim();
  }

  throw new Error('Vertex returned no text content in the response.');
}
