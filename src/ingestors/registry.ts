/**
 * Ingestor registry. Phase 0 is a stub - real ingestors are registered in
 * Phase 1. Selecting ingestors is driven by `MARKET_DATA_PROVIDER` and
 * the requested capability.
 */

import { config } from '../config/env.js';
import type { Ingestor, IngestorCapability } from './types.js';

const registry = new Map<string, Ingestor>();

export function registerIngestor(ingestor: Ingestor): void {
  if (registry.has(ingestor.name)) {
    throw new Error(`Ingestor already registered: ${ingestor.name}`);
  }
  registry.set(ingestor.name, ingestor);
}

export function getIngestor(name: string): Ingestor {
  const i = registry.get(name);
  if (!i) {
    throw new Error(
      `Unknown ingestor "${name}". Registered: ${[...registry.keys()].join(', ') || '(none)'}`,
    );
  }
  return i;
}

export function listIngestors(capability?: IngestorCapability): Ingestor[] {
  const all = [...registry.values()];
  return capability ? all.filter((i) => i.capabilities.has(capability)) : all;
}

/**
 * Resolve the preferred ingestor for a given capability based on env config.
 * Returns `null` when no registered ingestor matches - callers should treat
 * that as "data source not available yet" (typical during Phase 0).
 */
export function pickIngestor(capability: IngestorCapability): Ingestor | null {
  const candidates = listIngestors(capability);
  if (candidates.length === 0) return null;

  const preferred =
    config.MARKET_DATA_PROVIDER === 'kite'
      ? candidates.find((c) => c.name.startsWith('kite'))
      : candidates.find((c) => !c.name.startsWith('kite'));

  return preferred ?? candidates[0] ?? null;
}
