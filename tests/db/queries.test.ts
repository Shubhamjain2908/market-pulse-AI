import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, getRecentQuotes, migrate, upsertQuotes } from '../../src/db/index.js';
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
