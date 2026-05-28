/**
 * Loaders for committed JSON configs (watchlist, screens, portfolio).
 * Each loader validates with zod, caches the parsed result by file path,
 * and surfaces clear errors when a config is malformed.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Portfolio, ScreenDefinition } from '../types/domain.js';
import { PortfolioSchema, ScreenDefinitionSchema } from '../types/domain.js';
import type { StrategyGatesFile } from '../types/regime.js';
import { RegimeSchema, StrategyGatesFileSchema } from '../types/regime.js';

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

const MomentumUniverseFileSchema = z.object({
  asOf: z.string(),
  description: z.string().optional(),
  buckets: z.object({
    watchlist: z.array(z.string().min(1)),
    nifty_100: z.array(z.string().min(1)),
    nifty_midcap_50: z.array(z.string().min(1)),
  }),
});
export type MomentumUniverseFile = z.infer<typeof MomentumUniverseFileSchema>;

const MomentumConfigSchema = z.object({
  strategy_id: z.string(),
  regime_gate: z.array(RegimeSchema),
  universe: z.string(),
  portfolio_slots: z.number(),
  exit_rank_threshold: z.number(),
  hard_stop_pct: z.number(),
  rebalance_day: z.string(),
  weights: z.object({
    mom_12_1: z.number(),
    eps_revision: z.number(),
    rel_strength_ba: z.number(),
    breakout_flag: z.number(),
  }),
  breakout_bonus: z.number(),
  winsorise_zscore: z.number(),
  lookback: z.object({
    price_momentum_start_days: z.number(),
    price_momentum_lag_days: z.number(),
    beta_days: z.number(),
    rs_days: z.number(),
    eps_revision_days: z.number(),
    volume_avg_days: z.number(),
  }),
  breakout_threshold_pct: z.number(),
  breakout_volume_ratio: z.number(),
  beta_floor: z.number(),
  false_flag_eps_threshold_pct: z.number(),
  /** Winsorised z1 threshold for false-flag top-quartile proxy (tunable without deploy). */
  false_flag_z_threshold: z.number(),
  max_per_sector: z.number(),
  earnings_blackout_days: z.number(),
  position_sizing: z.object({
    risk_pct: z.number(),
    atr_multiplier: z.number(),
    lock_in_threshold_pct: z.number(),
    tightened_multiplier: z.number(),
    add_tranche_atr: z.number(),
    add_tranche_size_pct: z.number(),
    trim_rsi_threshold: z.number(),
    trim_return_pct: z.number(),
    trim_days_max: z.number(),
    trim_amount_pct: z.number(),
    max_single_stock_pct: z.number(),
  }),
});
export type MomentumConfig = z.infer<typeof MomentumConfigSchema>;

const EtfExclusionsFileSchema = z.object({
  description: z.string().optional(),
  symbols: z.array(z.string().min(1)).default([]),
});
export type EtfExclusionsFile = z.infer<typeof EtfExclusionsFileSchema>;

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

export function loadStrategyGates(opts: LoaderOptions = {}): StrategyGatesFile {
  const path = opts.path ?? resolve(process.cwd(), 'config/strategy-gates.json');
  return readJsonConfig(path, StrategyGatesFileSchema, opts.fresh);
}

/** Bucketed symbol lists for the momentum screener (~150-name union). */
export function loadMomentumUniverse(opts: LoaderOptions = {}): MomentumUniverseFile {
  const path = opts.path ?? resolve(process.cwd(), 'config/momentum-universe.json');
  return readJsonConfig(path, MomentumUniverseFileSchema, opts.fresh);
}

/** Deduped union of all momentum universe buckets, uppercased and sorted. */
export function getMomentumUniverseSymbols(opts: LoaderOptions = {}): string[] {
  const f = loadMomentumUniverse(opts);
  const set = new Set<string>();
  for (const s of f.buckets.watchlist) set.add(s.toUpperCase());
  for (const s of f.buckets.nifty_100) set.add(s.toUpperCase());
  for (const s of f.buckets.nifty_midcap_50) set.add(s.toUpperCase());
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function loadMomentumConfig(opts: LoaderOptions = {}): MomentumConfig {
  const path = opts.path ?? resolve(process.cwd(), 'config/momentum-config.json');
  return readJsonConfig(path, MomentumConfigSchema, opts.fresh);
}

/** Configurable symbol list where RSI/volume heuristics should be ignored. */
export function loadEtfExclusions(opts: LoaderOptions = {}): string[] {
  const path = opts.path ?? resolve(process.cwd(), 'config/etf-exclusions.json');
  const file = readJsonConfig(path, EtfExclusionsFileSchema, opts.fresh);
  const symbols = file.symbols ?? [];
  return [...new Set(symbols.map((s) => s.toUpperCase()))].sort((a, b) => a.localeCompare(b));
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

const SectorMapSchema = z.record(z.string(), z.string());

/**
 * Optional symbol → sector labels for briefing portfolio rollup (`config/sector-map.json`).
 * Missing file or invalid JSON returns `{}` (sectors fall back to "Unknown").
 */
export function loadSectorMap(opts: LoaderOptions = {}): Record<string, string> {
  const path = opts.path ?? resolve(process.cwd(), 'config/sector-map.json');
  const cacheKey = `sector-map:${path}`;
  if (!opts.fresh && cache.has(cacheKey)) return cache.get(cacheKey) as Record<string, string>;
  try {
    const raw = readFileSync(path, 'utf8');
    const json: unknown = JSON.parse(raw);
    const parsed = SectorMapSchema.safeParse(json);
    if (!parsed.success) {
      cache.set(cacheKey, {});
      return {};
    }
    const upper: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      upper[k.toUpperCase()] = v;
    }
    cache.set(cacheKey, upper);
    return upper;
  } catch {
    cache.set(cacheKey, {});
    return {};
  }
}
