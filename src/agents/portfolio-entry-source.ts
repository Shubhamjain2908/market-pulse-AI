/**
 * Resolve how a live holding entered the book (paper ledger, screens, thesis).
 * Used for strategy-aware portfolio guardrails and LLM position context.
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import type { PaperTradeSignalType } from '../db/queries.js';

export type PortfolioEntrySource = PaperTradeSignalType | 'quality_garp' | 'unknown';

const INFERABLE_SCREENS = ['quality_garp', 'catalyst_entry'] as const;

export function resolvePaperEntrySource(
  symbol: string,
  sourceDate: string,
  signalType: PaperTradeSignalType,
  db: DatabaseType,
): PortfolioEntrySource {
  if (signalType !== 'AI_PICK') return signalType;
  const qualityGarp = db
    .prepare(
      `
      SELECT 1
      FROM screens
      WHERE symbol = ? AND date = ? AND screen_name = 'quality_garp'
      LIMIT 1
    `,
    )
    .get(symbol.toUpperCase(), sourceDate);
  return qualityGarp ? 'quality_garp' : 'AI_PICK';
}

/**
 * Best-effort origin for Kite/manual holdings without a paper-trade row.
 * Paper ledger wins; then recent screens; then thesis trigger text; else unknown.
 */
export function resolveHoldingEntrySource(
  symbol: string,
  asOfDate: string,
  db: DatabaseType,
): PortfolioEntrySource {
  const sym = symbol.toUpperCase();

  const paper = db
    .prepare(
      `
      SELECT source_date AS sourceDate, signal_type AS signalType
      FROM paper_trades
      WHERE symbol = ? AND source_date <= ?
      ORDER BY source_date DESC, id DESC
      LIMIT 1
    `,
    )
    .get(sym, asOfDate) as { sourceDate: string; signalType: PaperTradeSignalType } | undefined;
  if (paper) {
    return resolvePaperEntrySource(sym, paper.sourceDate, paper.signalType, db);
  }

  const screen = db
    .prepare(
      `
      SELECT screen_name AS screenName
      FROM screens
      WHERE symbol = ?
        AND date <= ?
        AND date >= date(?, '-365 days')
        AND screen_name IN ('quality_garp', 'catalyst_entry', 'momentum_mf')
      ORDER BY date DESC
      LIMIT 1
    `,
    )
    .get(sym, asOfDate, asOfDate) as { screenName: string } | undefined;
  if (screen?.screenName === 'quality_garp') return 'quality_garp';
  if (screen?.screenName === 'catalyst_entry') return 'catalyst_entry';
  if (screen?.screenName === 'momentum_mf') return 'momentum_mf';

  const openMom = db
    .prepare(
      `
      SELECT 1
      FROM paper_trades
      WHERE symbol = ? AND status = 'OPEN' AND signal_type = 'momentum_mf'
      LIMIT 1
    `,
    )
    .get(sym);
  if (openMom) return 'momentum_mf';

  const thesis = db
    .prepare(
      `
      SELECT trigger_reason AS triggerReason
      FROM theses
      WHERE symbol = ? AND date <= ?
      ORDER BY date DESC
      LIMIT 1
    `,
    )
    .get(sym, asOfDate) as { triggerReason: string } | undefined;
  if (thesis?.triggerReason) {
    const lower = thesis.triggerReason.toLowerCase();
    for (const name of INFERABLE_SCREENS) {
      if (lower.includes(name)) return name;
    }
    if (lower.includes('momentum')) return 'momentum_mf';
  }

  return 'unknown';
}
