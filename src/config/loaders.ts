/**
 * Loaders for committed JSON configs (watchlist, screens, portfolio).
 * Each loader validates with zod, caches the parsed result by file path,
 * and surfaces clear errors when a config is malformed.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { PortfolioSchema, ScreenDefinitionSchema } from '../types/domain.js';
import type { Portfolio, ScreenDefinition } from '../types/domain.js';

const cache = new Map<string, unknown>();

const WatchlistFileSchema = z.object({
  description: z.string().optional(),
  symbols: z.array(z.string().min(1)).min(1),
});
export type WatchlistFile = z.infer<typeof WatchlistFileSchema>;

const ScreensFileSchema = z.object({
  description: z.string().optional(),
  screens: z.array(ScreenDefinitionSchema).min(1),
});
export type ScreensFile = z.infer<typeof ScreensFileSchema>;

const PortfolioFileSchema = PortfolioSchema.extend({
  description: z.string().optional(),
});
export type PortfolioFile = z.infer<typeof PortfolioFileSchema>;

export interface LoaderOptions {
  /** Override the path to the config file. */
  path?: string;
  /** Skip the cache - useful in tests. */
  fresh?: boolean;
}

export function loadWatchlist(opts: LoaderOptions = {}): WatchlistFile {
  const path = opts.path ?? resolve(process.cwd(), 'config/watchlist.json');
  return readJsonConfig(path, WatchlistFileSchema, opts.fresh);
}

export function loadScreens(opts: LoaderOptions = {}): ScreenDefinition[] {
  const path = opts.path ?? resolve(process.cwd(), 'config/screens.json');
  const file = readJsonConfig(path, ScreensFileSchema, opts.fresh);
  return file.screens;
}

export function loadPortfolio(opts: LoaderOptions = {}): Portfolio {
  const path = opts.path ?? resolve(process.cwd(), 'config/portfolio.json');
  const file = readJsonConfig(path, PortfolioFileSchema, opts.fresh);
  // Drop helper fields and zero-qty placeholders.
  return {
    currency: file.currency,
    totalCapital: file.totalCapital,
    holdings: file.holdings.filter((h) => h.qty > 0),
  };
}

function readJsonConfig<T>(path: string, schema: z.ZodType<T>, fresh = false): T {
  if (!fresh && cache.has(path)) return cache.get(path) as T;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `failed to read config at ${path}. Run 'cp config/${path.split('/').pop()}.example' if you haven't yet.`,
      { cause: err },
    );
  }
  let json: unknown;
  try {
    // Strip $schema and other tooling-only fields before validating.
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config at ${path} is not valid JSON`, { cause: err });
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`config at ${path} failed validation:\n${issues}`);
  }
  cache.set(path, result.data);
  return result.data;
}

/** Clear the loader cache. Mostly useful for tests. */
export function clearConfigCache(): void {
  cache.clear();
}
