import { describe, expect, it } from 'vitest';
import {
  applyDay1InitialStop,
  candidateStopFloor,
  computeNewStop,
} from '../../src/scripts/trailing-stop-engine.js';

const base = {
  entryPrice: 500,
  highestCloseSinceEntry: 518,
  currentStopLoss: 476,
  atr14Today: 11,
} as const;

describe('trailing-stop-engine/computeNewStop', () => {
  it('raises stop when candidate is above current (golden rule allows up)', () => {
    const r = computeNewStop({ ...base, currentMultiplier: 2 });
    const expectedCandidate = 518 - 2 * 11; // 496
    expect(r.candidateStop).toBeCloseTo(expectedCandidate, 8);
    expect(r.newStop).toBeCloseTo(expectedCandidate, 8);
    expect(r.wasRaised).toBe(true);
    expect(r.action).toBe('RAISED');
    expect(r.multiplier).toBe(2);
  });

  it('holds stop when candidate is below current (golden rule)', () => {
    const r = computeNewStop({
      entryPrice: 500,
      highestCloseSinceEntry: 510,
      currentStopLoss: 495,
      atr14Today: 12.2,
      currentMultiplier: 2,
    });
    const raw = 510 - 2 * 12.2; // 485.6
    expect(r.candidateStop).toBeCloseTo(Math.max(raw, candidateStopFloor(500)), 8);
    expect(r.newStop).toBe(495);
    expect(r.wasRaised).toBe(false);
    expect(r.action).toBe('HELD');
  });

  it('treats candidate equal to current as not raised (HELD)', () => {
    const atr = 12;
    const high = 524;
    const candidate = high - 2 * atr; // 500
    const r = computeNewStop({
      entryPrice: 500,
      highestCloseSinceEntry: high,
      currentStopLoss: candidate,
      atr14Today: atr,
      currentMultiplier: 2,
    });
    expect(r.newStop).toBeCloseTo(candidate, 8);
    expect(r.wasRaised).toBe(false);
    expect(r.action).toBe('HELD');
  });

  it('uses 2x multiplier when unrealised gain is just below 15%', () => {
    const entry = 10_000;
    const high = 11_499; // +1499/10000 = 14.99% exactly
    const r = computeNewStop({
      entryPrice: entry,
      highestCloseSinceEntry: high,
      currentStopLoss: 8900,
      atr14Today: 5,
      currentMultiplier: 2,
    });
    expect(r.multiplier).toBe(2);
    expect(r.wasTightened).toBe(false);
  });

  it('uses 1.5x and TIGHTENED at exactly 15.0% when stop rises and mult was 2', () => {
    const entry = 500;
    const high = 575; // +15%
    const atr = 10;
    const candidate = high - 1.5 * atr; // 560
    const r = computeNewStop({
      entryPrice: entry,
      highestCloseSinceEntry: high,
      currentStopLoss: 550,
      atr14Today: atr,
      currentMultiplier: 2,
    });
    expect(r.multiplier).toBe(1.5);
    expect(r.wasTightened).toBe(true);
    expect(r.wasRaised).toBe(true);
    expect(r.action).toBe('TIGHTENED');
    expect(r.newStop).toBeCloseTo(candidate, 8);
  });

  it('mult transitions 2→1.5 on first ≥15% bar but golden rule keeps action HELD', () => {
    const entry = 500;
    const high = 600; // +20%
    const atr = 80; // 600 - 120 = 480 < current stop 520
    const r = computeNewStop({
      entryPrice: entry,
      highestCloseSinceEntry: high,
      currentStopLoss: 520,
      atr14Today: atr,
      currentMultiplier: 2,
    });
    expect(r.multiplier).toBe(1.5);
    expect(r.wasTightened).toBe(true);
    expect(r.wasRaised).toBe(false);
    expect(r.action).toBe('HELD');
  });

  it('keeps 1.5 multiplier after gain dips back below 15% (DB already tightened)', () => {
    const entry = 500;
    const high = 510; // +2% from entry
    const r = computeNewStop({
      entryPrice: entry,
      highestCloseSinceEntry: high,
      currentStopLoss: 480,
      atr14Today: 8,
      currentMultiplier: 1.5,
    });
    expect(r.multiplier).toBe(1.5);
    expect(r.wasTightened).toBe(false);
  });

  it('floors absurd negative candidate at 50% of entry', () => {
    const entry = 100;
    const r = computeNewStop({
      entryPrice: entry,
      highestCloseSinceEntry: 110,
      currentStopLoss: 95,
      atr14Today: 500,
      currentMultiplier: 2,
    });
    expect(r.candidateStop).toBe(candidateStopFloor(entry));
    expect(r.newStop).toBe(95);
    expect(r.wasRaised).toBe(false);
    expect(r.action).toBe('HELD');
  });

  it('after floor, can still raise when current stop is below floored candidate', () => {
    const entry = 100;
    const r = computeNewStop({
      entryPrice: entry,
      highestCloseSinceEntry: 200,
      currentStopLoss: 40,
      atr14Today: 300,
      currentMultiplier: 2,
    });
    expect(r.candidateStop).toBe(50);
    expect(r.newStop).toBe(50);
    expect(r.wasRaised).toBe(true);
  });
});

describe('trailing-stop-engine/applyDay1InitialStop', () => {
  it('keeps LLM stop when it is tighter (higher) than ATR-based stop', () => {
    const entry = 500;
    const atr = 12; // 500 - 24 = 476
    expect(applyDay1InitialStop(entry, 480, atr)).toBe(480);
  });

  it('tightens to ATR-based stop when LLM was looser (lower)', () => {
    const entry = 500;
    const atr = 12; // atr stop 476
    expect(applyDay1InitialStop(entry, 460, atr)).toBe(476);
  });

  it('passes through LLM stop when ATR at entry is missing', () => {
    expect(applyDay1InitialStop(500, 470, null)).toBe(470);
  });
});
