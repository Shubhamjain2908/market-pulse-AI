import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCompleteRegimeNarrative, runRegimeAgent } from '../../src/agents/regime-agent.js';
import { migrate } from '../../src/db/migrate.js';
import { getTodayRegime } from '../../src/db/regime-queries.js';
import { resetLlmProvider, setLlmProvider } from '../../src/llm/factory.js';
import { MockLlmProvider } from '../../src/llm/providers/mock.js';

describe('runRegimeAgent', () => {
  beforeEach(() => {
    resetLlmProvider();
    setLlmProvider(new MockLlmProvider());
  });

  afterEach(() => {
    resetLlmProvider();
  });

  it('writes regime_daily with mock LLM narrative JSON', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const out = await runRegimeAgent({}, db);
    const row = getTodayRegime(out.sessionDate, db);
    expect(row).toBeTruthy();
    expect(row?.narrative).toMatch(/Mock regime line:|VIX/);
    expect(typeof out.changed).toBe('boolean');
    expect(out.usedFallbackNarrative).toBe(false);
    db.close();
  });

  it('skipLlm uses templated fallback and still persists', async () => {
    const db = new Database(':memory:');
    migrate(db);
    const out = await runRegimeAgent({ skipLlm: true }, db);
    const row = getTodayRegime(out.sessionDate, db);
    expect(row?.narrative).toMatch(/^Regime: /);
    expect(out.usedFallbackNarrative).toBe(true);
    db.close();
  });

  it('isCompleteRegimeNarrative rejects truncated sentences', () => {
    expect(isCompleteRegimeNarrative('The market remains choppy, with strong breadth (A/D ratio 3.7')).toBe(
      false,
    );
    expect(
      isCompleteRegimeNarrative(
        'The market remains choppy, with strong breadth (A/D ratio 3.7) and steady flows.',
      ),
    ).toBe(true);
  });
});
