/**
 * Environment configuration loader. Reads `.env`, validates with zod, and
 * exposes a typed `config` object. Importing this module triggers validation
 * exactly once - downstream code can rely on `config` being well-formed.
 */

import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  TZ: z.string().default('Asia/Kolkata'),

  DATABASE_PATH: z.string().default('./data/market-pulse.db'),

  LLM_PROVIDER: z
    .enum(['cursor-agent', 'anthropic', 'vertex', 'openai', 'mock'])
    .default('cursor-agent'),

  CURSOR_AGENT_BIN: z.string().optional(),
  CURSOR_AGENT_MODEL: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5'),

  GOOGLE_VERTEX_PROJECT: z.string().optional(),
  GOOGLE_VERTEX_LOCATION: z.string().default('us-central1'),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  VERTEX_MODEL: z.string().default('gemini-2.0-pro'),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o'),

  MARKET_DATA_PROVIDER: z.enum(['free', 'kite']).default('free'),
  KITE_API_KEY: z.string().optional(),
  KITE_API_SECRET: z.string().optional(),
  KITE_ACCESS_TOKEN: z.string().optional(),

  NEWS_API_KEY: z.string().optional(),

  BRIEFING_DELIVERY: z.enum(['file', 'email', 'slack', 'telegram']).default('file'),
  BRIEFING_OUTPUT_DIR: z.string().default('./briefings'),

  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_TO: z.string().optional(),

  SLACK_WEBHOOK_URL: z.string().url().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}

export const config: Env = loadEnv();

/** Re-export for tests that need to validate a raw object. */
export { EnvSchema };
/** Convenience flag - cron and delivery code should bail when true. */
export const isTest = config.NODE_ENV === 'test';
