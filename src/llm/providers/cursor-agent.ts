/**
 * cursor-agent provider. Spawns the local `cursor-agent` CLI in headless
 * print mode (`-p --output-format json`) and parses the structured response.
 *
 * Docs: https://cursor.com/docs/cli/reference/output-format
 *
 * Phase 0 ships the adapter shell with full text generation. JSON generation
 * uses `parseAndValidate` to coerce + validate the LLM's text output.
 */

import { spawn } from 'node:child_process';
import { config } from '../../config/env.js';
import { parseAndValidate } from '../json.js';
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  LlmJsonResult,
  LlmProvider,
  LlmTextResult,
} from '../types.js';

interface CursorAgentResultEnvelope {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  duration_ms: number;
  result: string;
  session_id?: string;
  request_id?: string;
}

export interface CursorAgentProviderOptions {
  bin?: string;
  model?: string;
}

export class CursorAgentProvider implements LlmProvider {
  readonly name = 'cursor-agent';
  readonly model: string;
  private readonly bin: string;

  constructor(opts: CursorAgentProviderOptions = {}) {
    this.bin = opts.bin ?? config.CURSOR_AGENT_BIN ?? 'cursor-agent';
    this.model = opts.model ?? config.CURSOR_AGENT_MODEL ?? 'default';
  }

  async generateText(opts: GenerateTextOptions): Promise<LlmTextResult> {
    const prompt = this.buildPrompt(opts.system, opts.user);
    const args = ['-p', '--output-format', 'json'];
    if (this.model && this.model !== 'default') {
      args.push('--model', this.model);
    }
    args.push(prompt);

    const started = Date.now();
    const stdout = await this.runProcess(args, opts.signal);
    const envelope = this.parseEnvelope(stdout);
    return {
      text: envelope.result,
      model: this.model,
      usage: { durationMs: envelope.duration_ms ?? Date.now() - started },
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
            : `${opts.user}\n\nIMPORTANT: Return ONLY valid JSON matching the requested schema. Previous attempt failed validation.`,
      });
      lastRaw = text.text;
      try {
        const data = parseAndValidate(text.text, opts.schema);
        return {
          data,
          raw: text.text,
          model: this.model,
          usage: text.usage,
        };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`cursor-agent JSON generation failed after retries: ${lastRaw}`);
  }

  private buildPrompt(system: string, user: string): string {
    return `[SYSTEM]\n${system.trim()}\n\n[TASK]\n${user.trim()}`;
  }

  private parseEnvelope(stdout: string): CursorAgentResultEnvelope {
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error('cursor-agent produced empty output');
    }
    let parsed: CursorAgentResultEnvelope;
    try {
      parsed = JSON.parse(trimmed) as CursorAgentResultEnvelope;
    } catch (err) {
      throw new Error(
        `cursor-agent did not emit JSON envelope. First 500 chars: ${trimmed.slice(0, 500)}`,
        { cause: err },
      );
    }
    if (parsed.is_error) {
      throw new Error(`cursor-agent reported error: ${parsed.result}`);
    }
    return parsed;
  }

  private runProcess(args: string[], signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(
            new Error(
              `cursor-agent exited with code ${code}. stderr: ${stderr.trim().slice(0, 500)}`,
            ),
          );
        }
      });
    });
  }
}
