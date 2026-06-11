import type { Database as DatabaseType } from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockComputeRegimeSignals = vi.hoisted(() => vi.fn());
const mockGetTodayRegime = vi.hoisted(() => vi.fn());
const mockInsertRegimeRow = vi.hoisted(() => vi.fn());

vi.mock('../../src/enrichers/regime-signals.js', () => ({
  computeRegimeSignals: mockComputeRegimeSignals,
}));

vi.mock('../../src/db/regime-queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/regime-queries.js')>();
  return {
    ...actual,
    getTodayRegime: mockGetTodayRegime,
    insertRegimeRow: mockInsertRegimeRow,
  };
});

vi.mock('../../src/logger.js', () => {
  const stub = () => ({
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: stub,
  });
  return { child: stub, logger: stub() };
});

import { prepareRegimeDaily, runRegimeClassifier } from '../../src/analysers/regime-classifier.js';
import type { RegimeSignals } from '../../src/types/regime.js';

/** Open NSE session (2026-05-01 is Maharashtra Day holiday). */
const SESSION = '2026-04-30';
const PREV_SESSION = '2026-04-29';
const fakeDb = {} as DatabaseType;

function fullRegimeSignals(date: string, partial: Partial<RegimeSignals> = {}): RegimeSignals {
  return {
    date,
    niftyVsSma200Pct: 2.5,
    sma200Slope10dPct: 0.2,
    vixCurrent: 15,
    vix5dChangePct: 1.2,
    fii20dRollingCr: 1200,
    fii5dTrend: 'POSITIVE',
    adRatio: 1.4,
    pctAboveSma200: 55,
    niftyGapPct: 0.1,
    scoreNiftySma: 1,
    scoreSma200Slope: 1,
    scoreVixLevel: 1,
    scoreVix5d: 0,
    scoreFii20d: 1,
    scoreFii5dTrend: 0,
    scoreAdRatio: 0,
    scorePctAboveSma200: 1,
    scoreTrend: 2,
    scoreVix: 1,
    scoreFii: 1,
    scoreBreadth: 1,
    scoreTotal: 2,
    warnings: [],
    ...partial,
  };
}

describe('prepareRegimeDaily quorum', () => {
  beforeEach(() => {
    mockComputeRegimeSignals.mockReset();
    mockGetTodayRegime.mockReset();
    mockInsertRegimeRow.mockReset();
    mockGetTodayRegime.mockReturnValue(null);
    mockComputeRegimeSignals.mockImplementation((_db, date) => fullRegimeSignals(date));
  });

  it('throws when niftyVsSma200Pct is null — no regime_daily row', () => {
    mockComputeRegimeSignals.mockImplementation((_db, date) =>
      fullRegimeSignals(date, date === SESSION ? { niftyVsSma200Pct: null } : {}),
    );
    expect(() => runRegimeClassifier({ date: SESSION }, fakeDb)).toThrow(/niftyVsSma200Pct/);
    expect(mockInsertRegimeRow).not.toHaveBeenCalled();
  });

  it('throws when fii20dRollingCr is null', () => {
    mockComputeRegimeSignals.mockImplementation((_db, date) =>
      fullRegimeSignals(date, date === SESSION ? { fii20dRollingCr: null } : {}),
    );
    expect(() => runRegimeClassifier({ date: SESSION }, fakeDb)).toThrow(/fii20dRollingCr/);
    expect(mockInsertRegimeRow).not.toHaveBeenCalled();
  });

  it('throws when pctAboveSma200 is null', () => {
    mockComputeRegimeSignals.mockImplementation((_db, date) =>
      fullRegimeSignals(date, date === SESSION ? { pctAboveSma200: null } : {}),
    );
    expect(() => runRegimeClassifier({ date: SESSION }, fakeDb)).toThrow(/pctAboveSma200/);
    expect(mockInsertRegimeRow).not.toHaveBeenCalled();
  });

  it('does not throw when vix5dChangePct is null (allowed optional)', () => {
    mockComputeRegimeSignals.mockImplementation((_db, date) =>
      fullRegimeSignals(date, date === SESSION ? { vix5dChangePct: null } : {}),
    );
    const classification = runRegimeClassifier({ date: SESSION }, fakeDb);
    expect(classification.regime).toBe('BULL_TRENDING');
    expect(mockInsertRegimeRow).toHaveBeenCalledOnce();
  });

  it('does not throw when adRatio is null (allowed optional)', () => {
    mockComputeRegimeSignals.mockImplementation((_db, date) =>
      fullRegimeSignals(date, date === SESSION ? { adRatio: null } : {}),
    );
    const classification = runRegimeClassifier({ date: SESSION }, fakeDb);
    expect(classification.regime).toBe('BULL_TRENDING');
    expect(mockInsertRegimeRow).toHaveBeenCalledOnce();
  });

  it('writes regime_daily when all required signals are present', () => {
    const classification = runRegimeClassifier({ date: SESSION }, fakeDb);
    expect(classification.regime).toBe('BULL_TRENDING');
    expect(mockInsertRegimeRow).toHaveBeenCalledOnce();
    expect(mockInsertRegimeRow.mock.calls[0]?.[0]?.date).toBe(SESSION);
  });

  it('does not quorum-fail when prev1 baseline has nulls but today is complete', () => {
    mockComputeRegimeSignals.mockImplementation((_db, date) => {
      if (date === PREV_SESSION) {
        return fullRegimeSignals(date, {
          niftyVsSma200Pct: null,
          sma200Slope10dPct: null,
          vixCurrent: null,
          fii20dRollingCr: null,
          pctAboveSma200: null,
        });
      }
      return fullRegimeSignals(date);
    });
    const prepared = prepareRegimeDaily({ date: SESSION }, fakeDb);
    expect(prepared.classification.regime).toBe('BULL_TRENDING');
    runRegimeClassifier({ date: SESSION }, fakeDb);
    expect(mockInsertRegimeRow).toHaveBeenCalled();
  });
});
