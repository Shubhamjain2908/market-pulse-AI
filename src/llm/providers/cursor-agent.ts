/**
 * cursor-agent provider (CLI v3+ compatible).
 *
 * The newer `cursor-agent` CLI (the same one shipped with Cursor 2026)
 * is a coding agent that:
 *   - Reads `CURSOR_API_KEY` from the environment for auth.
 *   - Takes a prompt as the trailing argument (no `-p` / `--output-format`).
 *   - Streams tool/status events to stderr (suppressed unless --verbose).
 *   - Writes the final assistant message as plain text to stdout.
 *
 * Because cursor-agent is a *coding* agent capable of making file system
 * changes, we sandbox each invocation by setting `--cwd` to a fresh
 * temporary directory. That neutralises any accidental "and update the
 * README while you're at it" behaviour. Our prompts only ever ask for
 * a structured text reply, so the sandbox is a safety belt, not a
 * functional dependency.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const log = child({ component: 'cursor-agent-provider' });

export interface CursorAgentProviderOptions {
  bin?: string;
  model?: string;
  apiKey?: string;
  /** Per-call timeout in ms. Defaults to CURSOR_AGENT_TIMEOUT_MS. */
  timeoutMs?: number;
}

export class CursorAgentProvider implements LlmProvider {
  readonly name = 'cursor-agent';
  readonly model: string;
  private readonly bin: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: CursorAgentProviderOptions = {}) {
    this.bin = opts.bin ?? config.CURSOR_AGENT_BIN ?? 'cursor-agent';
    this.model = opts.model ?? config.CURSOR_AGENT_MODEL ?? 'default';
    this.apiKey = opts.apiKey ?? config.CURSOR_API_KEY;
    this.timeoutMs = opts.timeoutMs ?? config.CURSOR_AGENT_TIMEOUT_MS;
    if (!this.apiKey) {
      log.warn(
        'CURSOR_API_KEY is not set; cursor-agent will likely fail. Get a key at https://cursor.com/docs/sdk/typescript#authentication',
      );
    }
  }

  async generateText(opts: GenerateTextOptions): Promise<LlmTextResult> {
    const prompt = this.buildPrompt(opts.system, opts.user);
    const started = Date.now();
    const stdout = await this.runProcess(prompt, opts.signal);
    return {
      text: stdout.trim(),
      model: this.model,
      usage: { durationMs: Date.now() - started },
    };
  }

  async generateJson<T>(opts: GenerateJsonOptions<T>): Promise<LlmJsonResult<T>> {
    const maxRetries = opts.maxRetries ?? 1;
    let lastErr: unknown;
    let lastRaw = '';
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // The coding-agent variant likes to wrap responses in conversational
      // prose. Restate the JSON-only contract on every retry.
      const userPrompt =
        attempt === 0
          ? `${opts.user}\n\nRespond with ONLY a single valid JSON object that matches the schema. No commentary, no markdown fences, no explanation before or after.`
          : `${opts.user}\n\nThe previous attempt failed JSON validation. Respond with ONLY a single valid JSON object that matches the schema. No prose, no markdown.`;

      const text = await this.generateText({ ...opts, user: userPrompt });
      lastRaw = text.text;
      try {
        const data = parseAndValidate(text.text, opts.schema);
        return { data, raw: text.text, model: this.model, usage: text.usage };
      } catch (err) {
        lastErr = err;
        log.debug(
          { attempt, err: (err as Error).message, snippet: text.text.slice(0, 200) },
          'cursor-agent JSON validation failed, retrying',
        );
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`cursor-agent JSON generation failed after retries: ${lastRaw}`);
  }

  private buildPrompt(system: string, user: string): string {
    return `[SYSTEM]\n${system.trim()}\n\n[TASK]\n${user.trim()}`;
  }

  private runProcess(prompt: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const sandbox = mkdtempSync(join(tmpdir(), 'mp-cursor-'));
      const args: string[] = ['--cwd', sandbox, '--', prompt];

      const env: NodeJS.ProcessEnv = { ...process.env };
      if (this.apiKey) env.CURSOR_API_KEY = this.apiKey;

      const child = spawn(this.bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
        env,
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(
          new Error(
            `cursor-agent timed out after ${this.timeoutMs}ms. Last stderr: ${stderr.trim().slice(0, 500)}`,
          ),
        );
      }, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        try {
          rmSync(sandbox, { recursive: true, force: true });
        } catch {
          // best effort
        }
      };

      child.on('error', (err) => {
        cleanup();
        reject(err);
      });
      child.on('close', (code) => {
        cleanup();
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
