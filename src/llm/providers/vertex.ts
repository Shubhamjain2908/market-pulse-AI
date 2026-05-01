/**
 * Google Vertex AI — Gemini via `@google-cloud/vertexai`.
 *
 * Auth: Application Default Credentials. Either set
 * `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON path, or run
 * `gcloud auth application-default login` for local development.
 *
 * Model IDs follow Vertex GA naming (see Cloud docs “Model versions and
 * lifecycle”). Defaults in env point at the current Gemini 2.5 family.
 */

import {
  BlockedReason,
  FinishReason,
  type GenerateContentResponse,
  HarmBlockThreshold,
  HarmCategory,
  VertexAI,
} from '@google-cloud/vertexai';
import { config } from '../../config/env.js';
import { parseAndValidate } from '../json.js';
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  LlmJsonResult,
  LlmProvider,
  LlmTextResult,
} from '../types.js';

/** Conservative safety thresholds — stock tickers / P&L often trip “financial advice” heuristics at BLOCK_MEDIUM. */
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
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
];

export class VertexProvider implements LlmProvider {
  readonly name = 'vertex';
  readonly model: string;
  private readonly vertex: VertexAI;

  constructor() {
    if (!config.GOOGLE_VERTEX_PROJECT) {
      throw new Error(
        'VertexProvider requires GOOGLE_VERTEX_PROJECT. Set it in .env or switch LLM_PROVIDER.',
      );
    }
    this.model = config.VERTEX_MODEL;
    this.vertex = new VertexAI({
      project: config.GOOGLE_VERTEX_PROJECT,
      location: config.GOOGLE_VERTEX_LOCATION,
    });
  }

  async generateText(opts: GenerateTextOptions): Promise<LlmTextResult> {
    const started = Date.now();
    const generativeModel = this.vertex.getGenerativeModel(
      {
        model: this.model,
        systemInstruction: opts.system,
        safetySettings: RESEARCH_SAFETY_SETTINGS,
        generationConfig: {
          temperature: opts.temperature ?? 0.2,
          maxOutputTokens: opts.maxOutputTokens ?? 8192,
        },
      },
      { timeout: config.VERTEX_TIMEOUT_MS },
    );

    const result = await generativeModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: opts.user }] }],
    });

    const text = extractResponseText(result.response);
    const usage = result.response.usageMetadata;
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

      const generativeModel = this.vertex.getGenerativeModel(
        {
          model: this.model,
          systemInstruction: opts.system,
          safetySettings: RESEARCH_SAFETY_SETTINGS,
          generationConfig: {
            temperature: opts.temperature ?? 0.1,
            maxOutputTokens: opts.maxOutputTokens ?? 8192,
            responseMimeType: 'application/json',
          },
        },
        { timeout: config.VERTEX_TIMEOUT_MS },
      );

      const result = await generativeModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      });

      const raw = extractResponseText(result.response);
      lastRaw = raw;
      const usage = result.response.usageMetadata;

      try {
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

function extractResponseText(response: GenerateContentResponse): string {
  const pf = response.promptFeedback;
  if (pf?.blockReason && pf.blockReason !== BlockedReason.BLOCKED_REASON_UNSPECIFIED) {
    throw new Error(`Vertex blocked the prompt: ${pf.blockReason}. ${pf.blockReasonMessage ?? ''}`);
  }

  const cand = response.candidates?.[0];
  if (!cand?.content?.parts?.length) {
    throw new Error('Vertex returned no text candidates (empty or safety-filtered response).');
  }

  const reason = cand.finishReason;
  if (
    reason &&
    reason !== FinishReason.STOP &&
    reason !== FinishReason.MAX_TOKENS &&
    reason !== FinishReason.FINISH_REASON_UNSPECIFIED
  ) {
    throw new Error(
      `Vertex stopped with finishReason=${reason}${cand.finishMessage ? `: ${cand.finishMessage}` : ''}`,
    );
  }

  let text = '';
  for (const part of cand.content.parts) {
    if ('text' in part && part.text) text += part.text;
  }
  return text.trim();
}
