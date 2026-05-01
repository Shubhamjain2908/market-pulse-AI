import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import { getSymbolSectors, upsertSymbolMetadata } from '../../src/db/queries.js';

describe('symbol sector metadata (DB)', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-symmeta-${Date.now()}-${Math.random()}.db`);
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
      /* best effort */
    }
  });

  it('getSymbolSectors returns cached Yahoo sectors', () => {
    upsertSymbolMetadata(
      [
        { symbol: 'ITC', sector: 'Consumer Defensive', industry: 'Tobacco' },
        { symbol: 'SBIN', sector: 'Financial Services' },
      ],
      db,
    );
    const m = getSymbolSectors(['ITC', 'SBIN', 'ZZZ'], db);
    expect(m.get('ITC')).toBe('Consumer Defensive');
    expect(m.get('SBIN')).toBe('Financial Services');
    expect(m.get('ZZZ')).toBeUndefined();
  });
});
