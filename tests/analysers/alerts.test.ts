import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAlertsForDate, runAlertScan } from '../../src/analysers/alerts.js';
import { closeDb, getDb, migrate } from '../../src/db/index.js';

describe('alerts: rule-based scan + persistence', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-alerts-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
  });

  afterEach(() => {
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(`${dbPath}${suffix}`);
      } catch {
        // best effort
      }
    }
  });

  it('emits expected alert kinds and persists them, idempotent on re-run', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    const date = '2026-04-30';

    const insert = (name: string, value: number, symbol = 'AAA') => {
      db.prepare(`
        INSERT INTO signals (symbol, date, name, value, source)
        VALUES (?, ?, ?, ?, 'technical')
        ON CONFLICT(symbol, date, name) DO UPDATE SET value = excluded.value
      `).run(symbol, date, name, value);
    };

    insert('rsi_14', 75); // overbought
    insert('volume_ratio_20d', 2.5); // spike
    insert('pct_from_52w_high', -1); // near high
    insert('rsi_14', 25, 'BBB'); // oversold

    const result = runAlertScan({ date, symbols: ['AAA', 'BBB'] }, db);

    const kinds = result.alerts.map((a) => `${a.symbol}:${a.kind}`).sort();
    expect(kinds).toEqual([
      'AAA:near_52w_high',
      'AAA:rsi_overbought',
      'AAA:volume_spike',
      'BBB:rsi_oversold',
    ]);

    const persisted = getAlertsForDate(date, db);
    expect(persisted).toHaveLength(4);

    // Re-running with new values updates rather than duplicates
    insert('rsi_14', 80); // still overbought, new value
    runAlertScan({ date, symbols: ['AAA', 'BBB'] }, db);
    const after = getAlertsForDate(date, db);
    expect(after).toHaveLength(4);
    const aaaRsi = after.find((a) => a.symbol === 'AAA' && a.kind === 'rsi_overbought');
    expect(aaaRsi?.value).toBe(80);
  });

  it('emits no alerts when nothing breaches thresholds', () => {
    const db = getDb({ path: dbPath });
    migrate(db);
    const date = '2026-04-30';
    db.prepare(`
      INSERT INTO signals (symbol, date, name, value, source)
      VALUES ('AAA', ?, 'rsi_14', 50, 'technical')
    `).run(date);

    const result = runAlertScan({ date, symbols: ['AAA'] }, db);
    expect(result.alerts).toEqual([]);
  });
});
