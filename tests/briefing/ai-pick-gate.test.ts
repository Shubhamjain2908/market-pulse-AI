import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateAiPickEligibility,
  getTwoSessionsBackDate,
} from '../../src/briefing/ai-pick-gate.js';
import type { ThesisCard } from '../../src/briefing/template.js';
import { closeDb, getDb, migrate } from '../../src/db/index.js';

const SOURCE_DATE = '2026-06-22';
const SESSIONS = ['2026-06-17', '2026-06-18', '2026-06-19', '2026-06-22'];

function thesis(confidence: number): Pick<ThesisCard, 'confidence'> {
  return { confidence };
}

describe('evaluateAiPickEligibility', () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `mp-gate-${Date.now()}.db`);
    process.env.DATABASE_PATH = dbPath;
    db = getDb({ path: dbPath });
    migrate(db);
    for (const d of SESSIONS) {
      db.prepare(
        `INSERT INTO quotes (symbol, exchange, date, open, high, low, close, volume, source)
         VALUES ('NIFTY_50', 'NSE', ?, 100, 100, 100, 100, 1000, 'test')`,
      ).run(d);
    }
  });

  afterEach(() => {
    db.close();
    closeDb();
    try {
      rmSync(dbPath);
    } catch {
      /* best effort */
    }
  });

  function insertRegimeChoppy(date: string): void {
    db.prepare(
      `INSERT INTO regime_daily (
        date, regime, score_total, score_trend, score_vix, score_fii, score_breadth,
        vix_value, nifty_vs_sma200, fii_20d_net, crisis_override, regime_age
      ) VALUES (?, 'CHOPPY', 0, 0, 0, 0, 0, 16, 0, 0, 0, 1)`,
    ).run(date);
  }

  function quote(sym: string, date: string, close: number): void {
    db.prepare(
      `INSERT INTO quotes (symbol, exchange, date, open, high, low, close, volume, source)
       VALUES (?, 'NSE', ?, ?, ?, ?, ?, 1000, 'test')`,
    ).run(sym, date, close, close, close, close);
  }

  function sig(sym: string, date: string, name: string, value: number): void {
    db.prepare(
      `INSERT INTO signals (symbol, date, name, value, source) VALUES (?, ?, ?, ?, 'test')`,
    ).run(sym, date, name, value);
  }

  function screen(sym: string, date: string, screenName: string): void {
    db.prepare(
      `INSERT INTO screens (symbol, date, screen_name, score, matched_criteria) VALUES (?, ?, ?, 1, '{}')`,
    ).run(sym, date, screenName);
  }

  function alert(sym: string, date: string, kind: string): void {
    db.prepare(
      `INSERT INTO alerts (symbol, date, signal, kind, value, message) VALUES (?, ?, 'x', ?, 1, 'x')`,
    ).run(sym, date, kind);
  }

  function seedEarningsBlackoutOk(sym: string, date: string): void {
    sig(sym, date, 'mom_earnings_blackout', 0);
  }

  function seedBhelGoldenCrossElite(rankDate: string): void {
    const sym = 'BHEL';
    insertRegimeChoppy(SOURCE_DATE);
    screen(sym, SOURCE_DATE, 'golden_cross');
    // Earnings blackout seeded on SOURCE_DATE (always fresh) so the staleness
    // test for rank vs T-2 boundary is not short-circuited by stale earnings evidence.
    seedEarningsBlackoutOk(sym, SOURCE_DATE);
    sig(sym, rankDate, 'mom_rank', 2);
    sig(sym, rankDate, 'mom_false_flag', 0);
    sig(sym, rankDate, 'mom_relative_strength_ba', 0.5);
  }

  it('getTwoSessionsBackDate returns T-2 session', () => {
    expect(getTwoSessionsBackDate(db, SOURCE_DATE)).toBe('2026-06-18');
  });

  it('blocks IDEA — confidence_low and false_momentum_flag', () => {
    insertRegimeChoppy(SOURCE_DATE);
    screen('IDEA', SOURCE_DATE, 'golden_cross');
    sig('IDEA', SOURCE_DATE, 'mom_false_flag', 1);
    sig('IDEA', SOURCE_DATE, 'mom_rank', 8);
    const r = evaluateAiPickEligibility('IDEA', SOURCE_DATE, thesis(3), db);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('confidence_low');
  });

  it('blocks ADANIENSOL — confidence_low', () => {
    insertRegimeChoppy(SOURCE_DATE);
    screen('ADANIENSOL', SOURCE_DATE, 'golden_cross');
    const r = evaluateAiPickEligibility('ADANIENSOL', SOURCE_DATE, thesis(4), db);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual(['confidence_low']);
  });

  it('blocks TIPSMUSIC — golden_cross_rejected rank > 10', () => {
    insertRegimeChoppy(SOURCE_DATE);
    screen('TIPSMUSIC', SOURCE_DATE, 'golden_cross');
    seedEarningsBlackoutOk('TIPSMUSIC', SOURCE_DATE);
    sig('TIPSMUSIC', SOURCE_DATE, 'mom_rank', 51);
    sig('TIPSMUSIC', SOURCE_DATE, 'mom_false_flag', 0);
    sig('TIPSMUSIC', SOURCE_DATE, 'mom_relative_strength_ba', 0.3);
    const r = evaluateAiPickEligibility('TIPSMUSIC', SOURCE_DATE, thesis(8), db);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('golden_cross_rejected');
  });

  it('blocks HINDALCO — no_confirmation_path', () => {
    insertRegimeChoppy(SOURCE_DATE);
    screen('HINDALCO', SOURCE_DATE, 'golden_cross');
    seedEarningsBlackoutOk('HINDALCO', SOURCE_DATE);
    sig('HINDALCO', SOURCE_DATE, 'mom_rank', 15);
    sig('HINDALCO', SOURCE_DATE, 'mom_false_flag', 0);
    sig('HINDALCO', SOURCE_DATE, 'mom_relative_strength_ba', -0.1);
    const r = evaluateAiPickEligibility('HINDALCO', SOURCE_DATE, thesis(8), db);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('golden_cross_rejected');
  });

  it('allows BHARATFORG — path_b_alert_breakout', () => {
    const sym = 'BHARATFORG';
    insertRegimeChoppy(SOURCE_DATE);
    screen(sym, SOURCE_DATE, 'golden_cross');
    quote(sym, SOURCE_DATE, 2022);
    seedEarningsBlackoutOk(sym, SOURCE_DATE);
    sig(sym, SOURCE_DATE, 'sma_50', 1900);
    sig(sym, SOURCE_DATE, 'sma_200', 1800);
    sig(sym, SOURCE_DATE, 'volume_ratio_20d', 1.6);
    alert(sym, SOURCE_DATE, 'near_52w_high');
    const r = evaluateAiPickEligibility(sym, SOURCE_DATE, thesis(8), db);
    expect(r.eligible).toBe(true);
    expect(r.path).toBe('path_b_alert_breakout');
  });

  it('allows TATASTEEL — path_a_non_generic_screen', () => {
    insertRegimeChoppy(SOURCE_DATE);
    seedEarningsBlackoutOk('TATASTEEL', SOURCE_DATE);
    screen('TATASTEEL', SOURCE_DATE, 'rsi_oversold_bounce');
    const r = evaluateAiPickEligibility('TATASTEEL', SOURCE_DATE, thesis(7), db);
    expect(r.eligible).toBe(true);
    expect(r.path).toBe('path_a_non_generic_screen');
  });

  it('BHEL_same_day — fresh rank on T allows elite tier', () => {
    seedBhelGoldenCrossElite(SOURCE_DATE);
    const r = evaluateAiPickEligibility('BHEL', SOURCE_DATE, thesis(9), db);
    expect(r.eligible).toBe(true);
    expect(r.path).toBe('golden_cross_elite');
  });

  it('BHEL_prev_session — fresh rank on T-1 allows elite tier', () => {
    seedBhelGoldenCrossElite('2026-06-19');
    const r = evaluateAiPickEligibility('BHEL', SOURCE_DATE, thesis(9), db);
    expect(r.eligible).toBe(true);
    expect(r.path).toBe('golden_cross_elite');
  });

  it('BHEL_two_sessions_back — fresh rank on T-2 boundary allows elite tier', () => {
    seedBhelGoldenCrossElite('2026-06-18');
    const r = evaluateAiPickEligibility('BHEL', SOURCE_DATE, thesis(9), db);
    expect(r.eligible).toBe(true);
    expect(r.path).toBe('golden_cross_elite');
  });

  it('BHEL_three_sessions_back — stale rank blocks', () => {
    seedBhelGoldenCrossElite('2026-06-17');
    const r = evaluateAiPickEligibility('BHEL', SOURCE_DATE, thesis(9), db);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('golden_cross_stale_rank');
  });

  it('OUT_OF_UNIVERSE_PATH_A — non-generic screen allows without rank', () => {
    seedEarningsBlackoutOk('RANDOMCO', SOURCE_DATE);
    screen('RANDOMCO', SOURCE_DATE, 'rsi_oversold_bounce');
    const r = evaluateAiPickEligibility('RANDOMCO', SOURCE_DATE, thesis(7), db);
    expect(r.eligible).toBe(true);
    expect(r.path).toBe('path_a_non_generic_screen');
  });

  it('OUT_OF_UNIVERSE_PATH_C_BLOCKED — golden_cross only without rank blocks', () => {
    insertRegimeChoppy(SOURCE_DATE);
    seedEarningsBlackoutOk('RANDOMCO', SOURCE_DATE);
    screen('RANDOMCO', SOURCE_DATE, 'golden_cross');
    const r = evaluateAiPickEligibility('RANDOMCO', SOURCE_DATE, thesis(7), db);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('golden_cross_stale_rank');
  });

  it('blocks IDEA false_momentum_flag even at high confidence', () => {
    insertRegimeChoppy(SOURCE_DATE);
    screen('IDEA', SOURCE_DATE, 'rsi_oversold_bounce');
    seedEarningsBlackoutOk('IDEA', SOURCE_DATE);
    sig('IDEA', SOURCE_DATE, 'mom_false_flag', 1);
    const r = evaluateAiPickEligibility('IDEA', SOURCE_DATE, thesis(8), db);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('false_momentum_flag');
  });

  it('allows Path A when false_momentum_flag=1 is stale', () => {
    insertRegimeChoppy(SOURCE_DATE);
    screen('TATASTEEL', SOURCE_DATE, 'rsi_oversold_bounce');
    seedEarningsBlackoutOk('TATASTEEL', SOURCE_DATE);
    sig('TATASTEEL', '2026-06-17', 'mom_false_flag', 1);
    const r = evaluateAiPickEligibility('TATASTEEL', SOURCE_DATE, thesis(8), db);
    expect(r.eligible).toBe(true);
    expect(r.path).toBe('path_a_non_generic_screen');
    expect(r.facts.falseFlagFresh).toBe(false);
  });

  it('allows Path B when false_momentum_flag=1 is stale', () => {
    const sym = 'BHARATFORG';
    insertRegimeChoppy(SOURCE_DATE);
    screen(sym, SOURCE_DATE, 'golden_cross');
    quote(sym, SOURCE_DATE, 2022);
    seedEarningsBlackoutOk(sym, SOURCE_DATE);
    sig(sym, SOURCE_DATE, 'sma_50', 1900);
    sig(sym, SOURCE_DATE, 'sma_200', 1800);
    sig(sym, SOURCE_DATE, 'volume_ratio_20d', 1.6);
    sig(sym, '2026-06-17', 'mom_false_flag', 1);
    alert(sym, SOURCE_DATE, 'near_52w_high');
    const r = evaluateAiPickEligibility(sym, SOURCE_DATE, thesis(8), db);
    expect(r.eligible).toBe(true);
    expect(r.path).toBe('path_b_alert_breakout');
    expect(r.facts.falseFlagFresh).toBe(false);
  });

  it('blocks IDEA 2026-07-06 scenario — operating quality guard', () => {
    insertRegimeChoppy(SOURCE_DATE);
    screen('IDEA', SOURCE_DATE, 'golden_cross');
    seedEarningsBlackoutOk('IDEA', SOURCE_DATE);
    sig('IDEA', SOURCE_DATE, 'mom_rank', 4);
    sig('IDEA', SOURCE_DATE, 'mom_false_flag', 0);
    sig('IDEA', SOURCE_DATE, 'mom_relative_strength_ba', 0.5);
    // Fundamentals: poor operating quality despite recent exceptional profit
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, roce, roe, pb, net_profit_ttm, profit_growth_yoy, source)
       VALUES ('IDEA', ?, -1.6, NULL, NULL, 34552, 13, 'yahoo_snapshot')`,
    ).run(SOURCE_DATE);

    const r = evaluateAiPickEligibility('IDEA', SOURCE_DATE, thesis(8), db);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('operating_quality');
    expect(r.facts.operatingQualityBlocked).toBe(true);
    expect(r.facts.operatingQualityReasons).toContain('negative_roce');
    expect(r.facts.operatingQualityReasons).toContain('missing_equity_quality');
    expect(r.facts.operatingQualityReasons).toContain('exceptional_profit_flip');
  });

  it('does not block high-quality momentum names with good fundamentals', () => {
    insertRegimeChoppy(SOURCE_DATE);
    const sym = 'TATASTEEL';
    screen(sym, SOURCE_DATE, 'rsi_oversold_bounce');
    seedEarningsBlackoutOk(sym, SOURCE_DATE);
    // Good fundamentals: positive ROCE, PB present, ROE present
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, roce, roe, pb, net_profit_ttm, profit_growth_yoy, source)
       VALUES (?, ?, 12.5, 15.2, 2.1, 5000, 18, 'yahoo_snapshot')`,
    ).run(sym, SOURCE_DATE);

    const r = evaluateAiPickEligibility(sym, SOURCE_DATE, thesis(7), db);
    expect(r.eligible).toBe(true);
    expect(r.path).toBe('path_a_non_generic_screen');
    expect(r.facts.operatingQualityBlocked).toBe(false);
    expect(r.facts.operatingQualityReasons).toEqual([]);
  });

  it('does not block financial sector names with different semantics', () => {
    insertRegimeChoppy(SOURCE_DATE);
    const sym = 'HDFCBANK';
    screen(sym, SOURCE_DATE, 'rsi_oversold_bounce');
    seedEarningsBlackoutOk(sym, SOURCE_DATE);
    // Bank: has roce but roe present and pb present — passes quality check
    db.prepare(
      `INSERT INTO fundamentals (symbol, as_of, roce, roe, pb, net_profit_ttm, profit_growth_yoy, source)
       VALUES (?, ?, 5.2, 14.1, 2.8, 80000, 12, 'yahoo_snapshot')`,
    ).run(sym, SOURCE_DATE);

    const r = evaluateAiPickEligibility(sym, SOURCE_DATE, thesis(7), db);
    expect(r.eligible).toBe(true);
    expect(r.path).toBe('path_a_non_generic_screen');
    expect(r.facts.operatingQualityBlocked).toBe(false);
  });

  // ---- Earnings blackout gate tests ----

  it('earnings_blackout — fresh=1 blocks admission', () => {
    insertRegimeChoppy(SOURCE_DATE);
    const sym = 'EARNBLK';
    screen(sym, SOURCE_DATE, 'rsi_oversold_bounce');
    sig(sym, SOURCE_DATE, 'mom_earnings_blackout', 1);
    const r = evaluateAiPickEligibility(sym, SOURCE_DATE, thesis(7), db);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual(['earnings_blackout']);
    expect(r.facts.momEarningsBlackout).toBe(1);
    expect(r.facts.momEarningsBlackoutFresh).toBe(true);
  });

  it('earnings_blackout — missing signal blocks as unknown (fail-closed)', () => {
    insertRegimeChoppy(SOURCE_DATE);
    screen('NODATA', SOURCE_DATE, 'rsi_oversold_bounce');
    const r = evaluateAiPickEligibility('NODATA', SOURCE_DATE, thesis(7), db);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual(['earnings_blackout_unknown']);
    expect(r.facts.momEarningsBlackout).toBeNull();
  });

  it('earnings_blackout — stale signal (> T-2) blocks as unknown', () => {
    insertRegimeChoppy(SOURCE_DATE);
    const sym = 'STALEBLK';
    screen(sym, SOURCE_DATE, 'rsi_oversold_bounce');
    // Signal on 2026-06-17 is 3 sessions back (stale, older than T-2)
    sig(sym, '2026-06-17', 'mom_earnings_blackout', 0);
    const r = evaluateAiPickEligibility(sym, SOURCE_DATE, thesis(7), db);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual(['earnings_blackout_unknown']);
    expect(r.facts.momEarningsBlackout).toBe(0);
    expect(r.facts.momEarningsBlackoutFresh).toBe(false);
  });

  it('earnings_blackout — fresh=0 continues to path gates', () => {
    insertRegimeChoppy(SOURCE_DATE);
    const sym = 'CLEARBLK';
    screen(sym, SOURCE_DATE, 'rsi_oversold_bounce');
    seedEarningsBlackoutOk(sym, SOURCE_DATE);
    const r = evaluateAiPickEligibility(sym, SOURCE_DATE, thesis(7), db);
    expect(r.eligible).toBe(true);
    expect(r.path).toBe('path_a_non_generic_screen');
    expect(r.facts.momEarningsBlackout).toBe(0);
    expect(r.facts.momEarningsBlackoutFresh).toBe(true);
  });

  it('earnings_blackout — blackout check fires before false_momentum_flag', () => {
    insertRegimeChoppy(SOURCE_DATE);
    const sym = 'BLKFIRST';
    screen(sym, SOURCE_DATE, 'rsi_oversold_bounce');
    // Both blackout=1 and false_flag=1 are set
    sig(sym, SOURCE_DATE, 'mom_earnings_blackout', 1);
    sig(sym, SOURCE_DATE, 'mom_false_flag', 1);
    const r = evaluateAiPickEligibility(sym, SOURCE_DATE, thesis(8), db);
    // Should block for earnings_blackout, not false_momentum_flag
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual(['earnings_blackout']);
  });

  it('LTF regression — rank 19, volume breakout, blackout=1 blocks AI_PICK', () => {
    insertRegimeChoppy(SOURCE_DATE);
    const sym = 'LTF';
    // Golden cross screen (Path C requires golden_cross screen)
    screen(sym, SOURCE_DATE, 'golden_cross');
    // Volume breakout path signals
    quote(sym, SOURCE_DATE, 2022);
    sig(sym, SOURCE_DATE, 'sma_50', 1900);
    sig(sym, SOURCE_DATE, 'sma_200', 1800);
    sig(sym, SOURCE_DATE, 'volume_ratio_20d', 1.6);
    sig(sym, SOURCE_DATE, 'mom_rank', 19);
    sig(sym, SOURCE_DATE, 'mom_false_flag', 0);
    sig(sym, SOURCE_DATE, 'mom_relative_strength_ba', 0.5);
    // Earnings blackout active
    sig(sym, SOURCE_DATE, 'mom_earnings_blackout', 1);

    const r = evaluateAiPickEligibility(sym, SOURCE_DATE, thesis(8), db);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toEqual(['earnings_blackout']);
    expect(r.facts.momEarningsBlackout).toBe(1);
    expect(r.facts.momEarningsBlackoutFresh).toBe(true);
  });
});
