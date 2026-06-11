import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, migrate } from '../../src/db/index.js';

const mockWarn = vi.hoisted(() => vi.fn());
const noop = vi.hoisted(() => vi.fn());

vi.mock('../../src/logger.js', () => {
  const stub = () => ({
    warn: mockWarn,
    info: noop,
    debug: noop,
    error: noop,
    child: stub,
  });
  const logger = stub();
  return { child: stub, logger };
});

import { isStrategyAllowed } from '../../src/db/regime-queries.js';

describe('db/regime-queries isStrategyAllowed', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-regime-q-${Date.now()}-${Math.random()}.db`);
    process.env.DATABASE_PATH = dbPath;
    mockWarn.mockClear();
  });

  afterEach(() => {
    closeDb();
    try {
      rmSync(dbPath);
      rmSync(`${dbPath}-wal`);
      rmSync(`${dbPath}-shm`);
    } catch {
      // ignore
    }
  });

  it('fails closed without a gate row; honors allowed flag when row exists', () => {
    const db = getDb({ path: dbPath });
    migrate(db);

    expect(isStrategyAllowed('momentum_mf', 'CRISIS', db)).toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(
      { strategyId: 'momentum_mf', regime: 'CRISIS' },
      'no gate row found — failing closed (DISALLOWED)',
    );
    mockWarn.mockClear();

    db.prepare(
      `INSERT INTO regime_strategy_gate (strategy_id, regime, allowed, size_multiplier)
       VALUES ('momentum_mf', 'CRISIS', 1, 1.0)`,
    ).run();
    expect(isStrategyAllowed('momentum_mf', 'CRISIS', db)).toBe(true);
    expect(mockWarn).not.toHaveBeenCalled();

    db.prepare(
      `UPDATE regime_strategy_gate SET allowed = 0
       WHERE strategy_id = 'momentum_mf' AND regime = 'CRISIS'`,
    ).run();
    expect(isStrategyAllowed('momentum_mf', 'CRISIS', db)).toBe(false);

    db.close();
  });
});
