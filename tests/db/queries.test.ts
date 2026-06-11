import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDb,
  getDb,
  getPrevClose,
  getRecentQuotes,
  hasCorporateActionInRange,
  migrate,
  upsertQuotes,
} from '../../src/db/index.js';
import type { RawQuote } from '../../src/types/domain.js';

describe('db/queries - quotes upsert', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-test-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
  });

  afterEach(() => {
    closeDb();
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`);
      rmSync(`${dbPath}-shm`);
    } catch {
      // best effort
    }
  });

  it('inserts and updates quote rows', () => {
    const db = getDb({ path: dbPath });
    migrate(db);

    const baseRow: RawQuote = {
      symbol: 'RELIANCE',
      exchange: 'NSE',
      date: '2026-04-30',
      open: 2900,
      high: 2950,
      low: 2880,
      close: 2940,
      volume: 1_000_000,
      source: 'test',
    };
    expect(upsertQuotes([baseRow], db)).toBe(1);

    const updated: RawQuote[] = [{ ...baseRow, close: 2960, volume: 1_100_000 }];
    expect(upsertQuotes(updated, db)).toBe(1);

    const rows = getRecentQuotes('RELIANCE', 10, db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.close).toBe(2960);
    expect(rows[0]?.volume).toBe(1_100_000);
    db.close();
  });
});

describe('db/queries - getPrevClose and hasCorporateActionInRange', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-test-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
  });

  afterEach(() => {
    closeDb();
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`);
      rmSync(`${dbPath}-shm`);
    } catch {
      // best effort
    }
  });

  it('getPrevClose returns the prior session close', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    upsertQuotes(
      [
        {
          symbol: 'GAPTEST',
          exchange: 'NSE',
          date: '2026-06-02',
          open: 100,
          high: 105,
          low: 99,
          close: 102,
          volume: 1,
          source: 'test',
        },
      ],
      db,
    );
    expect(getPrevClose('GAPTEST', '2026-06-03', db)).toBe(102);
    db.close();
  });

  it('getPrevClose returns undefined when no prior quote exists', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    expect(getPrevClose('NOHIST', '2026-06-03', db)).toBeUndefined();
    db.close();
  });

  it('hasCorporateActionInRange is true when ex_date falls in range', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    db.prepare(
      `INSERT INTO corporate_actions (symbol, ex_date, type, factor, source)
       VALUES (?, ?, 'split', 2, 'test')`,
    ).run('SPLITCO', '2026-07-03');
    expect(hasCorporateActionInRange('SPLITCO', '2026-07-01', '2026-07-05', db)).toBe(true);
    db.close();
  });

  it('hasCorporateActionInRange is false when ex_date is outside range', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    db.prepare(
      `INSERT INTO corporate_actions (symbol, ex_date, type, factor, source)
       VALUES (?, ?, 'split', 2, 'test')`,
    ).run('SPLITCO', '2026-07-10');
    expect(hasCorporateActionInRange('SPLITCO', '2026-07-01', '2026-07-05', db)).toBe(false);
    db.close();
  });
});
