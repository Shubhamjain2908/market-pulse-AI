import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderCotGoldMacroLine } from '../../src/briefing/cot-gold-line.js';
import { closeDb, getDb, migrate } from '../../src/db/index.js';
import { insertCotGoldIgnore } from '../../src/db/queries.js';

describe('renderCotGoldMacroLine', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-cot-line-${Date.now()}-${Math.random()}.db`);
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

  it('suppresses NEUTRAL classification', () => {
    insertCotGoldIgnore(
      {
        reportDate: '2026-05-26',
        mmLong: 100,
        mmShort: 40,
        mmNet: 60,
        openInterest: 200,
        mmNetOiRatio: 0.3,
        ingestedAt: '2026-05-26T07:45:00.000Z',
      },
      db,
    );
    expect(renderCotGoldMacroLine(db)).toBe('');
  });

  it('renders crowded long line', () => {
    insertCotGoldIgnore(
      {
        reportDate: '2026-05-20',
        mmLong: 100,
        mmShort: 10,
        mmNet: 90,
        openInterest: 200,
        mmNetOiRatio: 0.45,
        ingestedAt: '2026-05-20T07:45:00.000Z',
      },
      db,
    );
    const html = renderCotGoldMacroLine(db);
    expect(html).toContain('CROWDED LONG');
    expect(html).toContain('2026-05-20');
    expect(html).toContain('45.0%');
  });
});
