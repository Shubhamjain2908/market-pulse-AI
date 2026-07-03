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

/** Symbol with strong earnings (4 quarters positive YoY PAT, accelerating). */
function seedStrongEarnings(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT INTO quarterly_fundamentals (symbol, quarter_end, net_profit, source) VALUES (?, ?, ?, 'screener')`,
  );
  // Growth rates (oldest to newest): 67%, 75%, 80%, 100% — monotonically accelerating
  stmt.run('STRONG', '2026-06-30', 1200); // vs 600 = +100%
  stmt.run('STRONG', '2026-03-31', 900); // vs 500 = +80%
  stmt.run('STRONG', '2025-12-31', 700); // vs 400 = +75%
  stmt.run('STRONG', '2025-09-30', 500); // vs 300 = +67%
  stmt.run('STRONG', '2025-06-30', 600);
  stmt.run('STRONG', '2025-03-31', 500);
  stmt.run('STRONG', '2024-12-31', 400);
  stmt.run('STRONG', '2024-09-30', 300);
}

/** Symbol with mixed earnings (2 positive, 2 negative). */
function seedMixedEarnings(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT INTO quarterly_fundamentals (symbol, quarter_end, net_profit, source) VALUES (?, ?, ?, 'screener')`,
  );
  stmt.run('MIXED', '2026-06-30', 800);
  stmt.run('MIXED', '2026-03-31', -100);
  stmt.run('MIXED', '2025-12-31', 700);
  stmt.run('MIXED', '2025-09-30', -50);
  stmt.run('MIXED', '2025-06-30', 500); // T-4 for 2026-06-30: 500→800 positive
  stmt.run('MIXED', '2025-03-31', 200); // T-4 for 2026-03-31: 200→-100 negative
  stmt.run('MIXED', '2024-12-31', 400); // T-4 for 2025-12-31: 400→700 positive
  stmt.run('MIXED', '2024-09-30', 100); // T-4 for 2025-09-30: 100→-50 negative
}

/** Symbol with declining earnings (3+ consecutive YoY declines). */
function seedDecliningEarnings(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT INTO quarterly_fundamentals (symbol, quarter_end, net_profit, source) VALUES (?, ?, ?, 'screener')`,
  );
  stmt.run('DECLINE', '2026-06-30', 200);
  stmt.run('DECLINE', '2026-03-31', 300);
  stmt.run('DECLINE', '2025-12-31', 400);
  stmt.run('DECLINE', '2025-09-30', 500);
  stmt.run('DECLINE', '2025-06-30', 600); // 600→200 = negative
  stmt.run('DECLINE', '2025-03-31', 700); // 700→300 = negative
  stmt.run('DECLINE', '2024-12-31', 800); // 800→400 = negative
  stmt.run('DECLINE', '2024-09-30', 200); // 200→500 = positive
}

/** Symbol with < 2 quarters (should produce null). */
function seedInsufficientEarnings(db: Database.Database): void {
  const stmt = db.prepare(
    `INSERT INTO quarterly_fundamentals (symbol, quarter_end, net_profit, source) VALUES (?, ?, ?, 'screener')`,
  );
  stmt.run('INSUF', '2026-06-30', 100);
  // Only 1 quarter — need at least 5 for YoY comparison
}

// ---------------------------------------------------------------------------
// Tests
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
    // 2 positive out of 4 → 5
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

describe('computeRubricAnchors - balanceSheet', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, debt_to_equity, roe, source) VALUES (?, ?, ?, ?, ?)`,
    );
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
      `INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, ?, ?, ?)`,
    ).run('STAGE2B', '2026-07-01', 'weinstein_stage_code', 22, 'technical');
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, ?, ?, ?)`,
    ).run('STAGE2B', '2026-07-01', 'weinstein_stage_score', 30, 'technical');
    const anchors = computeRubricAnchors('STAGE2B', '2026-07-01', db);
    expect(anchors.technicalStage).toBe(30);
  });

  it('returns null when weinstein_stage_code is 0 (insufficient data)', () => {
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, ?, ?, ?)`,
    ).run('INSUF', '2026-07-01', 'weinstein_stage_code', 0, 'technical');
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, ?, ?, ?)`,
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
      `INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, ?, ?, ?)`,
    ).run('STAGE4', '2026-07-01', 'weinstein_stage_code', 4, 'technical');
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, ?, ?, ?)`,
    ).run('STAGE4', '2026-07-01', 'weinstein_stage_score', 0, 'technical');
    const anchors = computeRubricAnchors('STAGE4', '2026-07-01', db);
    expect(anchors.technicalStage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeRubricTotal
// ---------------------------------------------------------------------------

describe('computeRubricTotal', () => {
  it('computes correct total when all values present', () => {
    const anchors: RubricAnchors = {
      earningsTrajectory: 10,
      balanceSheet: 10,
      technicalStage: 30, // Stage 2B
    };
    const llmRubric = {
      moat: 8,
      sectorTailwind: 7,
      competitivePosition: 9,
      newsCatalyst: 6,
    };
    // Subtotals: 10+10+8+7+9+6 = 50, + technical 30 = 80
    expect(computeRubricTotal(anchors, llmRubric)).toBe(80);
  });

  it('uses neutral defaults (4) for null anchors and null LLM rubric', () => {
    const anchors: RubricAnchors = {
      earningsTrajectory: null,
      balanceSheet: null,
      technicalStage: null,
    };
    // Subtotal: 4+4+4+4+4+4 = 24, + technical neutral 15 = 39
    expect(computeRubricTotal(anchors, null)).toBe(39);
  });

  it('uses neutral defaults for partial anchors', () => {
    const anchors: RubricAnchors = {
      earningsTrajectory: 8,
      balanceSheet: null,
      technicalStage: 15,
    };
    const llmRubric = {
      moat: 7,
      sectorTailwind: 6,
      competitivePosition: null as unknown as number,
      newsCatalyst: null as unknown as number,
    };
    // Subtotal: 8+4+7+6+4+4 = 33, + technical 15 = 48
    expect(computeRubricTotal(anchors, llmRubric)).toBe(48);
  });

  it('handles edge case: all zeros for anchors', () => {
    const anchors: RubricAnchors = {
      earningsTrajectory: 0,
      balanceSheet: 0,
      technicalStage: 0,
    };
    const llmRubric = {
      moat: 0,
      sectorTailwind: 0,
      competitivePosition: 0,
      newsCatalyst: 0,
    };
    // Subtotal: 0+0+0+0+0+0 = 0, + technical 0 = 0
    expect(computeRubricTotal(anchors, llmRubric)).toBe(0);
  });
});
