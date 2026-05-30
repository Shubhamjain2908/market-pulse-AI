import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import { getFlowAttribution, upsertFiiDii } from '../../src/db/queries.js';
import type { FiiDiiRow } from '../../src/types/domain.js';

describe('getFlowAttribution', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-flow-attr-${Date.now()}-${Math.random()}.db`);
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
      /* ignore */
    }
  });

  it('sums up to five cash sessions on or before asOf', () => {
    const rows: FiiDiiRow[] = [
      {
        date: '2026-05-01',
        segment: 'cash',
        fiiBuy: 0,
        fiiSell: 0,
        fiiNet: -100,
        diiBuy: 0,
        diiSell: 0,
        diiNet: 50,
        source: 'test',
      },
      {
        date: '2026-05-02',
        segment: 'cash',
        fiiBuy: 0,
        fiiSell: 0,
        fiiNet: -200,
        diiBuy: 0,
        diiSell: 0,
        diiNet: 100,
        source: 'test',
      },
      {
        date: '2026-05-05',
        segment: 'cash',
        fiiBuy: 0,
        fiiSell: 0,
        fiiNet: -300,
        diiBuy: 0,
        diiSell: 0,
        diiNet: 200,
        source: 'test',
      },
      {
        date: '2026-05-06',
        segment: 'fno',
        fiiBuy: 0,
        fiiSell: 0,
        fiiNet: 9999,
        diiBuy: 0,
        diiSell: 0,
        diiNet: 9999,
        source: 'test',
      },
    ];
    upsertFiiDii(rows, db);

    const snap = getFlowAttribution(db, '2026-05-10');
    expect(snap).toEqual({
      fiiNetSum: -600,
      diiNetSum: 350,
      sessionCount: 3,
    });
  });

  it('returns null when no cash rows exist', () => {
    expect(getFlowAttribution(db, '2099-01-01')).toBeNull();
  });
});
