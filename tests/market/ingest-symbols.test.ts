import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, migrate } from '../../src/db/index.js';
import { getIngestAllEquitySymbolsUnion } from '../../src/market/ingest-symbols.js';

describe('getIngestAllEquitySymbolsUnion', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-ingest-sym-${Date.now()}-${Math.random()}.db`);
    const db = getDb({ path: dbPath });
    migrate(db);
  });

  afterEach(() => {
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      // ignore
    }
  });

  it('returns deduped sorted symbols from watchlist, momentum universe, and portfolio config', () => {
    const db = getDb({ path: dbPath });
    const syms = getIngestAllEquitySymbolsUnion(db);
    expect(syms.length).toBeGreaterThan(0);
    expect(syms).toEqual([...syms].sort((a, b) => a.localeCompare(b)));
    expect(new Set(syms).size).toBe(syms.length);
    expect(syms).toContain('KOTAKBANK');
  });
});
