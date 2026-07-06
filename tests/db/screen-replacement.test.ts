import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import { replaceScreenResultsForDate } from '../../src/db/queries.js';

describe('replaceScreenResultsForDate', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-sr-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
    db = getDb({ path: dbPath });
    migrate(db);
  });

  afterEach(() => {
    db.close();
    closeDb();
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`);
      rmSync(`${dbPath}-shm`);
    } catch {
      // best effort
    }
  });

  function insertRow(symbol: string, date: string, screenName: string): void {
    db.prepare(
      `INSERT INTO screens (symbol, date, screen_name, score, matched_criteria)
       VALUES (?, ?, ?, 1, '{}')`,
    ).run(symbol, date, screenName);
  }

  function countRows(date: string, screenName: string): number {
    return (
      db
        .prepare('SELECT COUNT(*) AS n FROM screens WHERE date = ? AND screen_name = ?')
        .get(date, screenName) as { n: number }
    ).n;
  }

  function listRows(date: string): Array<{ symbol: string; screenName: string }> {
    return db
      .prepare(
        'SELECT symbol, screen_name AS screenName FROM screens WHERE date = ? ORDER BY symbol',
      )
      .all(date) as Array<{ symbol: string; screenName: string }>;
  }

  it('replaces existing rows for the same date and screen_name', () => {
    // First run: 2 symbols match golden_cross
    insertRow('NYKAA', '2026-07-06', 'golden_cross');
    insertRow('RELIANCE', '2026-07-06', 'golden_cross');
    expect(countRows('2026-07-06', 'golden_cross')).toBe(2);

    // Rerun: only 1 symbol matches golden_cross
    const replaced = replaceScreenResultsForDate(
      [
        {
          symbol: 'RELIANCE',
          date: '2026-07-06',
          screenName: 'golden_cross',
          score: 1,
          matchedCriteria: {},
        },
      ],
      '2026-07-06',
      'golden_cross',
      db,
    );
    expect(replaced).toBe(1);

    const remaining = listRows('2026-07-06').filter((r) => r.screenName === 'golden_cross');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.symbol).toBe('RELIANCE');

    // Other screen_name rows for same date are untouched
    insertRow('NYKAA', '2026-07-06', 'rsi_oversold_bounce');
    const all = listRows('2026-07-06');
    expect(all).toHaveLength(2);
  });

  it('removes all rows for the screen when empty array is passed', () => {
    insertRow('NYKAA', '2026-07-06', 'golden_cross');
    insertRow('RELIANCE', '2026-07-06', 'golden_cross');
    expect(countRows('2026-07-06', 'golden_cross')).toBe(2);

    replaceScreenResultsForDate([], '2026-07-06', 'golden_cross', db);

    expect(countRows('2026-07-06', 'golden_cross')).toBe(0);
  });

  it('is idempotent when called with the same data', () => {
    const rows = [
      {
        symbol: 'NYKAA',
        date: '2026-07-06',
        screenName: 'golden_cross',
        score: 1,
        matchedCriteria: {},
      },
    ];

    const first = replaceScreenResultsForDate(rows, '2026-07-06', 'golden_cross', db);
    const second = replaceScreenResultsForDate(rows, '2026-07-06', 'golden_cross', db);
    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(countRows('2026-07-06', 'golden_cross')).toBe(1);
  });

  it('handles the NYKAA regression scenario from 2026-07-06', () => {
    // First run: NYKAA and RELIANCE pass golden_cross (rsi_14 ~65)
    replaceScreenResultsForDate(
      [
        {
          symbol: 'NYKAA',
          date: '2026-07-06',
          screenName: 'golden_cross',
          score: 1,
          matchedCriteria: {},
        },
        {
          symbol: 'RELIANCE',
          date: '2026-07-06',
          screenName: 'golden_cross',
          score: 1,
          matchedCriteria: {},
        },
      ],
      '2026-07-06',
      'golden_cross',
      db,
    );
    expect(countRows('2026-07-06', 'golden_cross')).toBe(2);

    // Rerun after rsi_14 updates: NYKAA now has rsi_14=70.528 (above band)
    // Only RELIANCE passes
    replaceScreenResultsForDate(
      [
        {
          symbol: 'RELIANCE',
          date: '2026-07-06',
          screenName: 'golden_cross',
          score: 1,
          matchedCriteria: {},
        },
      ],
      '2026-07-06',
      'golden_cross',
      db,
    );
    expect(countRows('2026-07-06', 'golden_cross')).toBe(1);
    const rows = listRows('2026-07-06');
    expect(rows.map((r) => r.symbol)).toEqual(['RELIANCE']);
  });

  it('does not affect rows from other dates', () => {
    replaceScreenResultsForDate(
      [
        {
          symbol: 'NYKAA',
          date: '2026-07-06',
          screenName: 'golden_cross',
          score: 1,
          matchedCriteria: {},
        },
      ],
      '2026-07-06',
      'golden_cross',
      db,
    );
    insertRow('NYKAA', '2026-07-05', 'golden_cross');
    insertRow('RELIANCE', '2026-07-05', 'golden_cross');

    replaceScreenResultsForDate([], '2026-07-06', 'golden_cross', db);

    expect(countRows('2026-07-05', 'golden_cross')).toBe(2);
    expect(countRows('2026-07-06', 'golden_cross')).toBe(0);
  });
});
