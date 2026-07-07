/**
 * Tests for computeRubricAnchors and computeRubricTotal.
 *
 * Tests deterministic anchors against seeded quarterly_fundamentals,
 * fundamentals, and signals data.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeRubricAnchors,
  computeRubricTotal,
  type RubricAnchors,
} from '../../src/analysers/thesis-rubric.js';

// ---------------------------------------------------------------------------
// Helpers — in-memory SQLite database with minimal schema
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE IF NOT EXISTS quarterly_fundamentals (
      symbol      TEXT NOT NULL,
      quarter_end TEXT NOT NULL,
      net_profit  REAL,
      source      TEXT NOT NULL DEFAULT 'screener',
      PRIMARY KEY (symbol, quarter_end)
    );

    CREATE TABLE IF NOT EXISTS fundamentals (
      symbol          TEXT NOT NULL,
      as_of           TEXT NOT NULL,
      pe              REAL,
      peg             REAL,
      debt_to_equity  REAL,
      roe             REAL,
      source          TEXT NOT NULL,
      PRIMARY KEY (symbol, as_of)
    );

    CREATE TABLE IF NOT EXISTS signals (
      symbol     TEXT NOT NULL,
      date       TEXT NOT NULL,
      name       TEXT NOT NULL,
      value      REAL NOT NULL,
      source     TEXT NOT NULL,
      PRIMARY KEY (symbol, date, name)
    );

    CREATE INDEX IF NOT EXISTS idx_qf_symbol ON quarterly_fundamentals(symbol);
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seedStrongEarnings(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT INTO quarterly_fundamentals (symbol, quarter_end, net_profit, source) VALUES (?, ?, ?, 'screener')`,
  );
  stmt.run('STRONG', '2026-06-30', 1200);
  stmt.run('STRONG', '2026-03-31', 900);
  stmt.run('STRONG', '2025-12-31', 700);
  stmt.run('STRONG', '2025-09-30', 500);
  stmt.run('STRONG', '2025-06-30', 600);
  stmt.run('STRONG', '2025-03-31', 500);
  stmt.run('STRONG', '2024-12-31', 400);
  stmt.run('STRONG', '2024-09-30', 300);
}

function seedMixedEarnings(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT INTO quarterly_fundamentals (symbol, quarter_end, net_profit, source) VALUES (?, ?, ?, 'screener')`,
  );
  stmt.run('MIXED', '2026-06-30', 800);
  stmt.run('MIXED', '2026-03-31', -100);
  stmt.run('MIXED', '2025-12-31', 700);
  stmt.run('MIXED', '2025-09-30', -50);
  stmt.run('MIXED', '2025-06-30', 500);
  stmt.run('MIXED', '2025-03-31', 200);
  stmt.run('MIXED', '2024-12-31', 400);
  stmt.run('MIXED', '2024-09-30', 100);
}

function seedDecliningEarnings(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT INTO quarterly_fundamentals (symbol, quarter_end, net_profit, source) VALUES (?, ?, ?, 'screener')`,
  );
  stmt.run('DECLINE', '2026-06-30', 200);
  stmt.run('DECLINE', '2026-03-31', 300);
  stmt.run('DECLINE', '2025-12-31', 400);
  stmt.run('DECLINE', '2025-09-30', 500);
  stmt.run('DECLINE', '2025-06-30', 600);
  stmt.run('DECLINE', '2025-03-31', 700);
  stmt.run('DECLINE', '2024-12-31', 800);
  stmt.run('DECLINE', '2024-09-30', 200);
}

function seedInsufficientEarnings(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT INTO quarterly_fundamentals (symbol, quarter_end, net_profit, source) VALUES (?, ?, ?, 'screener')`,
  );
  stmt.run('INSUF', '2026-06-30', 100);
}

/**
 * Seed P/E history using INSERT OR REPLACE to allow later PEG updates.
 */
function seedPeHistory(
  db: Database.Database,
  symbol: string,
  values: Array<{ asOf: string; pe: number | null }>,
): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO fundamentals (symbol, as_of, pe, debt_to_equity, roe, source) VALUES (?, ?, ?, 0.5, 15, 'test')`,
  );
  for (const v of values) {
    stmt.run(symbol.toUpperCase(), v.asOf, v.pe);
  }
}

// ---------------------------------------------------------------------------
// Tests: Valuation
// ---------------------------------------------------------------------------

describe('computeRubricAnchors - valuation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('percentile bands: current P/E at min of history → score 10', () => {
    // 12 rows across 2 years. P/E DECREASES over time so current (latest) = min.
    const rows: Array<{ asOf: string; pe: number | null }> = [];
    for (let month = 0; month < 12; month++) {
      const d = new Date(2024, month, 1);
      const iso = d.toISOString().slice(0, 10);
      rows.push({ asOf: iso, pe: 42 - month * 2 }); // 42, 40, 38, ... 20
    }
    // Current P/E = 20 (lowest) → percentile ≈ 0/12 = 0 ≤ 0.10 → score 10
    seedPeHistory(db, 'CHEAP', rows);

    const anchors = computeRubricAnchors('CHEAP', '2026-01-01', db);
    expect(anchors.valuation).toBe(10);
    expect(anchors.valuationBasis).toBe('pe_percentile');
  });

  it('percentile bands: current P/E at max of history → score 0', () => {
    // P/E INCREASES over time so current (latest) = max.
    const rows: Array<{ asOf: string; pe: number | null }> = [];
    for (let month = 0; month < 12; month++) {
      const d = new Date(2024, month, 1);
      const iso = d.toISOString().slice(0, 10);
      rows.push({ asOf: iso, pe: 20 + month * 2 }); // 20, 22, 24, ... 42
    }
    // Current P/E = 42 (highest) → percentile ≈ 11/12 = 0.917 > 0.90 → score 0
    seedPeHistory(db, 'DEAR', rows);

    const anchors = computeRubricAnchors('DEAR', '2026-01-01', db);
    expect(anchors.valuation).toBe(0);
    expect(anchors.valuationBasis).toBe('pe_percentile');
  });

  it('percentile bands: current P/E at median → score 6', () => {
    // P/E goes up then down, ending near the middle.
    const rows: Array<{ asOf: string; pe: number | null }> = [];
    const peValues = [20, 25, 30, 35, 40, 35, 30, 25, 30, 28, 26, 30];
    for (let month = 0; month < 12; month++) {
      const d = new Date(2024, month, 1);
      const iso = d.toISOString().slice(0, 10);
      const v = peValues[month];
      if (v == null) continue;
      rows.push({ asOf: iso, pe: v });
    }
    // Current P/E = 30. Values < 30: 20,25,25,28 = 4. total=12, pct≈0.333 ≤0.50 → 6
    seedPeHistory(db, 'MID', rows);

    const anchors = computeRubricAnchors('MID', '2026-01-01', db);
    expect(anchors.valuation).toBe(6);
    expect(anchors.valuationBasis).toBe('pe_percentile');
  });

  it('insufficient history (5 rows) with valid PEG → scores 8 via peg basis', () => {
    // Only 5 rows, span < 180 days → P/E percentile fails
    seedPeHistory(db, 'PEGSYM', [
      { asOf: '2025-12-01', pe: 20 },
      { asOf: '2025-12-08', pe: 22 },
      { asOf: '2025-12-15', pe: 19 },
      { asOf: '2025-12-22', pe: 21 },
      { asOf: '2025-12-29', pe: 23 },
    ]);
    // Use a different date so INSERT OR REPLACE adds a separate row with peg
    db.prepare(
      `INSERT OR REPLACE INTO fundamentals (symbol, as_of, peg, debt_to_equity, roe, source) VALUES (?, ?, ?, 0.5, 15, 'test')`,
    ).run('PEGSYM', '2025-12-30', 0.9);

    const anchors = computeRubricAnchors('PEGSYM', '2025-12-31', db);
    expect(anchors.valuation).toBe(8);
    expect(anchors.valuationBasis).toBe('peg');
  });

  it('insufficient history (90-day span, >8 rows) with valid PEG → scores via peg', () => {
    // > 8 rows but span only ~89 days → P/E percentile fails
    seedPeHistory(db, 'SHORTSPAN', [
      { asOf: '2025-10-01', pe: 20 },
      { asOf: '2025-10-15', pe: 19 },
      { asOf: '2025-11-01', pe: 21 },
      { asOf: '2025-11-15', pe: 22 },
      { asOf: '2025-12-01', pe: 20 },
      { asOf: '2025-12-08', pe: 19 },
      { asOf: '2025-12-15', pe: 21 },
      { asOf: '2025-12-22', pe: 22 },
      { asOf: '2025-12-29', pe: 23 },
    ]);
    // Separate row for PEG (different date from the P/E rows)
    db.prepare(
      `INSERT OR REPLACE INTO fundamentals (symbol, as_of, peg, debt_to_equity, roe, source) VALUES (?, ?, ?, 0.5, 15, 'test')`,
    ).run('SHORTSPAN', '2025-12-30', 1.5);

    const anchors = computeRubricAnchors('SHORTSPAN', '2025-12-31', db);
    // PEG = 1.5 → ≤ 2 → score 5
    expect(anchors.valuation).toBe(5);
    expect(anchors.valuationBasis).toBe('peg');
  });

  it('negative/null P/E and no PEG → null valuation', () => {
    // Only negative and null P/E rows → no valid pe > 0 rows → no PEG → null
    seedPeHistory(db, 'NOPEG', [
      { asOf: '2023-01-01', pe: -10 },
      { asOf: '2024-01-01', pe: -5 },
    ]);
    // No PEG either
    const anchors = computeRubricAnchors('NOPEG', '2026-01-01', db);
    expect(anchors.valuation).toBeNull();
    expect(anchors.valuationBasis).toBeNull();
  });

  it('point-in-time: rows with as_of > date are excluded from distribution', () => {
    // Seed history through end of 2024
    const rows: Array<{ asOf: string; pe: number | null }> = [];
    for (let month = 0; month < 12; month++) {
      const d = new Date(2024, month, 1);
      const iso = d.toISOString().slice(0, 10);
      rows.push({ asOf: iso, pe: 20 + month * 2 }); // 20, 22, ... 42
    }
    seedPeHistory(db, 'PIT', rows);
    // Future row with lower P/E — should be excluded from distribution
    db.prepare(
      `INSERT OR REPLACE INTO fundamentals (symbol, as_of, pe, debt_to_equity, roe, source) VALUES (?, ?, ?, 0.5, 15, 'test')`,
    ).run('PIT', '2026-06-01', 10);

    // Analyze as of 2026-01-01 — future row excluded
    // Current P/E = 42 (last of 12 rows, highest) → score 0
    const anchors = computeRubricAnchors('PIT', '2026-01-01', db);
    expect(anchors.valuation).toBe(0);
    expect(anchors.valuationBasis).toBe('pe_percentile');
  });
});

// ---------------------------------------------------------------------------
// Tests: Earnings trajectory
// ---------------------------------------------------------------------------

describe('computeRubricAnchors - earningsTrajectory', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('scores 10 for 4 quarters positive and accelerating', () => {
    seedStrongEarnings(db);
    const anchors = computeRubricAnchors('STRONG', '2026-07-01', db);
    expect(anchors.earningsTrajectory).toBe(10);
  });

  it('scores 5 for 2 positive quarters', () => {
    seedMixedEarnings(db);
    const anchors = computeRubricAnchors('MIXED', '2026-07-01', db);
    expect(anchors.earningsTrajectory).toBe(5);
  });

  it('scores 0 for 3+ consecutive declines', () => {
    seedDecliningEarnings(db);
    const anchors = computeRubricAnchors('DECLINE', '2026-07-01', db);
    expect(anchors.earningsTrajectory).toBe(0);
  });

  it('returns null when fewer than 5 quarters of data exist', () => {
    seedInsufficientEarnings(db);
    const anchors = computeRubricAnchors('INSUF', '2026-07-01', db);
    expect(anchors.earningsTrajectory).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: Balance sheet
// ---------------------------------------------------------------------------

describe('computeRubricAnchors - balanceSheet', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('scores 10 for D/E < 0.3 and ROE > 20', () => {
    db.prepare(
      'INSERT INTO fundamentals (symbol, as_of, debt_to_equity, roe, source) VALUES (?, ?, ?, ?, ?)',
    ).run('QUAL', '2026-07-01', 0.2, 25, 'screener');
    const anchors = computeRubricAnchors('QUAL', '2026-07-01', db);
    expect(anchors.balanceSheet).toBe(10);
  });

  it('scores 8 for D/E < 0.5 and ROE > 15', () => {
    db.prepare(
      'INSERT INTO fundamentals (symbol, as_of, debt_to_equity, roe, source) VALUES (?, ?, ?, ?, ?)',
    ).run('OK', '2026-07-01', 0.4, 18, 'screener');
    const anchors = computeRubricAnchors('OK', '2026-07-01', db);
    expect(anchors.balanceSheet).toBe(8);
  });

  it('scores 6 for D/E < 1.0', () => {
    db.prepare(
      'INSERT INTO fundamentals (symbol, as_of, debt_to_equity, roe, source) VALUES (?, ?, ?, ?, ?)',
    ).run('MODERATE', '2026-07-01', 0.8, 12, 'screener');
    const anchors = computeRubricAnchors('MODERATE', '2026-07-01', db);
    expect(anchors.balanceSheet).toBe(6);
  });

  it('scores 2 for D/E >= 1.0 but < 2.0', () => {
    db.prepare(
      'INSERT INTO fundamentals (symbol, as_of, debt_to_equity, roe, source) VALUES (?, ?, ?, ?, ?)',
    ).run('HIGH_DE', '2026-07-01', 1.5, 10, 'screener');
    const anchors = computeRubricAnchors('HIGH_DE', '2026-07-01', db);
    expect(anchors.balanceSheet).toBe(2);
  });

  it('scores 0 for D/E >= 2.0', () => {
    db.prepare(
      'INSERT INTO fundamentals (symbol, as_of, debt_to_equity, roe, source) VALUES (?, ?, ?, ?, ?)',
    ).run('LEVERED', '2026-07-01', 2.5, 8, 'screener');
    const anchors = computeRubricAnchors('LEVERED', '2026-07-01', db);
    expect(anchors.balanceSheet).toBe(0);
  });

  it('returns null when D/E is null', () => {
    db.prepare(
      'INSERT INTO fundamentals (symbol, as_of, debt_to_equity, roe, source) VALUES (?, ?, ?, ?, ?)',
    ).run('NO_DE', '2026-07-01', null, 15, 'screener');
    const anchors = computeRubricAnchors('NO_DE', '2026-07-01', db);
    expect(anchors.balanceSheet).toBeNull();
  });

  it('returns null when ROE is null', () => {
    db.prepare(
      'INSERT INTO fundamentals (symbol, as_of, debt_to_equity, roe, source) VALUES (?, ?, ?, ?, ?)',
    ).run('NO_ROE', '2026-07-01', 0.5, null, 'screener');
    const anchors = computeRubricAnchors('NO_ROE', '2026-07-01', db);
    expect(anchors.balanceSheet).toBeNull();
  });

  it('returns null when no fundamentals row exists', () => {
    const anchors = computeRubricAnchors('NODATA', '2026-07-01', db);
    expect(anchors.balanceSheet).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: Technical stage
// ---------------------------------------------------------------------------

describe('computeRubricAnchors - technicalStage', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns score from weinstein_stage_score when code is non-zero', () => {
    db.prepare(
      'INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, ?, ?, ?)',
    ).run('STAGE2B', '2026-07-01', 'weinstein_stage_code', 22, 'technical');
    db.prepare(
      'INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, ?, ?, ?)',
    ).run('STAGE2B', '2026-07-01', 'weinstein_stage_score', 30, 'technical');
    const anchors = computeRubricAnchors('STAGE2B', '2026-07-01', db);
    expect(anchors.technicalStage).toBe(30);
  });

  it('returns null when weinstein_stage_code is 0 (insufficient data)', () => {
    db.prepare(
      'INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, ?, ?, ?)',
    ).run('INSUF', '2026-07-01', 'weinstein_stage_code', 0, 'technical');
    db.prepare(
      'INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, ?, ?, ?)',
    ).run('INSUF', '2026-07-01', 'weinstein_stage_score', 15, 'technical');
    const anchors = computeRubricAnchors('INSUF', '2026-07-01', db);
    expect(anchors.technicalStage).toBeNull();
  });

  it('returns null when no stage signals exist', () => {
    const anchors = computeRubricAnchors('NODATA', '2026-07-01', db);
    expect(anchors.technicalStage).toBeNull();
  });

  it('returns Stage 4 score of 0', () => {
    db.prepare(
      'INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, ?, ?, ?)',
    ).run('STAGE4', '2026-07-01', 'weinstein_stage_code', 4, 'technical');
    db.prepare(
      'INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, ?, ?, ?)',
    ).run('STAGE4', '2026-07-01', 'weinstein_stage_score', 0, 'technical');
    const anchors = computeRubricAnchors('STAGE4', '2026-07-01', db);
    expect(anchors.technicalStage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeRubricTotal (0–100 scale after valuation dimension added)
// ---------------------------------------------------------------------------

describe('computeRubricTotal', () => {
  it('computes correct total when all values present (0–100 scale)', () => {
    const anchors: RubricAnchors = {
      earningsTrajectory: 10,
      balanceSheet: 10,
      valuation: 10,
      valuationBasis: 'pe_percentile',
      technicalStage: 30,
    };
    const llmRubric = {
      moat: 8,
      sectorTailwind: 7,
      competitivePosition: 9,
      newsCatalyst: 6,
    };
    // 10+10+10+8+7+9+6 = 60 subtotal, + 30 technical = 90
    expect(computeRubricTotal(anchors, llmRubric)).toBe(90);
  });

  it('uses neutral defaults (4) for null anchors and null LLM rubric', () => {
    const anchors: RubricAnchors = {
      earningsTrajectory: null,
      balanceSheet: null,
      valuation: null,
      valuationBasis: null,
      technicalStage: null,
    };
    // 7×4 = 28 subtotal, + 15 technical = 43
    expect(computeRubricTotal(anchors, null)).toBe(43);
  });

  it('uses neutral defaults for partial anchors', () => {
    const anchors: RubricAnchors = {
      earningsTrajectory: 8,
      balanceSheet: null,
      valuation: null,
      valuationBasis: null,
      technicalStage: 15,
    };
    const llmRubric = {
      moat: 7,
      sectorTailwind: 6,
      competitivePosition: null as unknown as number,
      newsCatalyst: null as unknown as number,
    };
    // 8+4+4+7+6+4+4 = 37 subtotal, + 15 technical = 52
    expect(computeRubricTotal(anchors, llmRubric)).toBe(52);
  });

  it('handles edge case: all zeros for anchors', () => {
    const anchors: RubricAnchors = {
      earningsTrajectory: 0,
      balanceSheet: 0,
      valuation: 0,
      valuationBasis: null,
      technicalStage: 0,
    };
    const llmRubric = {
      moat: 0,
      sectorTailwind: 0,
      competitivePosition: 0,
      newsCatalyst: 0,
    };
    // 0+0+0+0+0+0+0 = 0 subtotal, + 0 technical = 0
    expect(computeRubricTotal(anchors, llmRubric)).toBe(0);
  });

  it('handles max possible score: all 10s + stage 30', () => {
    const anchors: RubricAnchors = {
      earningsTrajectory: 10,
      balanceSheet: 10,
      valuation: 10,
      valuationBasis: 'pe_percentile',
      technicalStage: 30,
    };
    const llmRubric = {
      moat: 10,
      sectorTailwind: 10,
      competitivePosition: 10,
      newsCatalyst: 10,
    };
    // 10+10+10+10+10+10+10 = 70 subtotal, + 30 technical = 100
    expect(computeRubricTotal(anchors, llmRubric)).toBe(100);
  });
});
