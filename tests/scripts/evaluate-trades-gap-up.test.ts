import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockWarn = vi.hoisted(() => vi.fn());
const noop = vi.hoisted(() => vi.fn());

vi.mock('../../src/logger.js', () => {
  const stub = () => ({
    warn: mockWarn,
    error: noop,
    info: noop,
    debug: noop,
    child: stub,
  });
  return { child: stub, logger: stub() };
});

import * as trailingSizing from '../../src/config/trailing-stop-sizing.js';
import { closeDb, getDb, migrate, upsertQuotes } from '../../src/db/index.js';
import {
  getOpenPaperTrades,
  insertPaperTradeIfAbsent,
  upsertSignals,
} from '../../src/db/queries.js';
import { evaluateOnePaperTrade } from '../../src/scripts/evaluate-trades.js';
import type { RawQuote } from '../../src/types/domain.js';

const legacyTrailSizing = {
  initialMultiplier: 2,
  tightenedMultiplier: 1.5,
  lockInThresholdPct: 15,
} as const;

function q(symbol: string, date: string, o: number, h: number, l: number, c: number): RawQuote {
  return {
    symbol,
    exchange: 'NSE',
    date,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 1,
    source: 't',
  };
}

describe('gap-up circuit breaker logging', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    mockWarn.mockClear();
    vi.spyOn(trailingSizing, 'trailingStopSizingFromMomentumConfig').mockReturnValue(
      legacyTrailSizing,
    );
    dbPath = join(tmpdir(), `mp-gapup-${Date.now()}.db`);
    process.env.DATABASE_PATH = dbPath;
    db = getDb({ path: dbPath });
    migrate(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    closeDb();
    try {
      rmSync(dbPath);
    } catch {
      /* best effort */
    }
  });

  function seedNifty(...dates: string[]): void {
    upsertQuotes(
      dates.map((d) => q('NIFTY_50', d, 100, 101, 99, 100)),
      db,
    );
  }

  function seedAtr14(symbol: string, dates: string[], value = 3): void {
    const sym = symbol.toUpperCase();
    upsertSignals(
      dates.map((dt) => ({
        symbol: sym,
        date: dt,
        name: 'atr_14',
        value,
        source: 'technical' as const,
      })),
      db,
    );
  }

  it('suppresses highest_close update, allows TARGET_HIT, and logs circuit breaker', () => {
    const src = '2026-08-01';
    const dPrev = '2026-08-02';
    const dGap = '2026-08-03';
    seedNifty(dPrev, dGap);
    upsertQuotes([q('GAPUP', dPrev, 100, 100, 100, 100), q('GAPUP', dGap, 135, 145, 130, 140)], db);
    seedAtr14('GAPUP', [src, dPrev, dGap], 3);
    insertPaperTradeIfAbsent(
      {
        symbol: 'GAPUP',
        signalType: 'AI_PICK',
        sourceDate: src,
        entryPrice: 100,
        stopLoss: 85,
        target: 120,
        timeHorizon: 'medium',
        maxHoldDays: 90,
      },
      db,
    );
    const rowId = (
      db.prepare('SELECT id FROM paper_trades WHERE symbol = ?').get('GAPUP') as { id: number }
    ).id;
    db.prepare(
      'UPDATE paper_trades SET highest_close_since_entry = 105, atr14_at_entry = 3 WHERE id = ?',
    ).run(rowId);

    const t = getOpenPaperTrades(db)[0];
    if (t === undefined) throw new Error('missing trade');
    expect(evaluateOnePaperTrade(t, db, dGap, { skipAi: true })).toBe('CLOSED_WIN');

    const closed = db
      .prepare('SELECT exit_reason, status FROM paper_trades WHERE id = ?')
      .get(rowId) as { exit_reason: string | null; status: string };
    expect(closed.status).toBe('CLOSED_WIN');
    expect(closed.exit_reason).toBe('TARGET_HIT');

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'GAPUP',
        barDate: dGap,
        prevClose: 100,
        open: 135,
      }),
      expect.stringContaining('CIRCUIT BREAKER (gap-up)'),
    );
  });
});
