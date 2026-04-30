/**
 * Wires the registered ingestors based on `MARKET_DATA_PROVIDER`. Phase 1
 * registers four free-tier sources by default:
 *
 *   - Yahoo: bulk historical OHLCV (the workhorse for the enricher)
 *   - NSE: today's quote-equity + FII/DII (the only authoritative source
 *     for FII/DII activity)
 *   - Screener: fundamentals (P/E, ROE, debt/equity, ...)
 *   - RSS: ET + Moneycontrol headlines
 *
 * Idempotent: calling bootstrapIngestors() twice doesn't re-register.
 */

import { config } from '../config/env.js';
import { logger } from '../logger.js';
import { NseIngestor } from './nse/ingestor.js';
import { listIngestors, registerIngestor } from './registry.js';
import { RssNewsIngestor } from './rss/ingestor.js';
import { ScreenerIngestor } from './screener/ingestor.js';
import { YahooIngestor } from './yahoo/ingestor.js';

let bootstrapped = false;

export function bootstrapIngestors(): void {
  if (bootstrapped) return;

  if (config.MARKET_DATA_PROVIDER === 'free') {
    registerIngestor(new YahooIngestor());
    registerIngestor(new NseIngestor());
    registerIngestor(new ScreenerIngestor());
    registerIngestor(new RssNewsIngestor());
  } else if (config.MARKET_DATA_PROVIDER === 'kite') {
    // Kite ingestor lands in Phase 5. Until then fall back to free sources.
    logger.warn('kite provider not implemented yet, registering free ingestors');
    registerIngestor(new YahooIngestor());
    registerIngestor(new NseIngestor());
    registerIngestor(new ScreenerIngestor());
    registerIngestor(new RssNewsIngestor());
  }

  bootstrapped = true;
  logger.debug({ ingestors: listIngestors().map((i) => i.name) }, 'ingestors bootstrapped');
}
