/**
 * Vol-target position weight + cross-sleeve sector cap helpers.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import { classifySector } from '../briefing/sector-classifier.js';
import { getOpenPaperTrades } from '../db/queries.js';

// ponytail: vol_target_v1 only; add sizing_model column when a second model ships
export function computePositionWeightPct(
  entryPrice: number,
  stopLoss: number,
  bookValueInr: number,
  riskPct: number,
  maxSingleStockPct: number,
): number {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopLoss) || entryPrice <= stopLoss) {
    return Math.max(0, maxSingleStockPct);
  }
  const riskAmount = bookValueInr * (riskPct / 100);
  const perShareRisk = entryPrice - stopLoss;
  if (perShareRisk <= 0 || !Number.isFinite(perShareRisk)) return Math.max(0, maxSingleStockPct);
  const shares = riskAmount / perShareRisk;
  const positionValue = shares * entryPrice;
  if (!Number.isFinite(positionValue) || bookValueInr <= 0) return Math.max(0, maxSingleStockPct);
  const pct = (positionValue / bookValueInr) * 100;
  return Math.max(0, Math.min(maxSingleStockPct, pct));
}

export function resolveSymbolSector(
  symbol: string,
  db: DatabaseType,
  sectorMap: Record<string, string>,
): string {
  const row = db.prepare('SELECT sector FROM symbols WHERE symbol = ?').get(symbol.toUpperCase()) as
    | { sector: string | null }
    | undefined;
  return classifySector(symbol, sectorMap, row?.sector ?? null);
}

/** OPEN paper_trades across all signal types. */
export function openSectorCounts(
  db: DatabaseType,
  sectorMap: Record<string, string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of getOpenPaperTrades(db)) {
    const sec = resolveSymbolSector(t.symbol, db, sectorMap);
    if (sec === 'Unknown') continue;
    counts.set(sec, (counts.get(sec) ?? 0) + 1);
  }
  return counts;
}

export function aggregateSectorCapBlocks(
  symbol: string,
  sectorCounts: Map<string, number>,
  sectorMap: Record<string, string>,
  db: DatabaseType,
  maxAggregate: number,
): boolean {
  if (maxAggregate <= 0) return false;
  const sec = resolveSymbolSector(symbol, db, sectorMap);
  if (sec === 'Unknown') return false;
  return (sectorCounts.get(sec) ?? 0) >= maxAggregate;
}
