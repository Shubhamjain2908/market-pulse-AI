import { describe, expect, it } from 'vitest';
import type { TrailingStopSizing } from '../../src/config/trailing-stop-sizing.js';
import {
  applyDay1InitialStop,
  candidateStopFloor,
  computeNewStop,
} from '../../src/scripts/trailing-stop-engine.js';

/** Pre–Phase 2 sizing used in unit tests (2× / 1.5× @ 15%). */
const legacySizing: TrailingStopSizing = {
  initialMultiplier: 2,
  tightenedMultiplier: 1.5,
  lockInThresholdPct: 15,
};

const productionSizing: TrailingStopSizing = {
  initialMultiplier: 2.5,
  tightenedMultiplier: 1.5,
  lockInThresholdPct: 18,
};

const base = {
  entryPrice: 500,
  highestCloseSinceEntry: 518,
  currentStopLoss: 476,
  atr14Today: 11,
  sizing: legacySizing,
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
      sizing: legacySizing,
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
      sizing: legacySizing,
      currentMultiplier: 2,
    });
    expect(r.newStop).toBeCloseTo(candidate, 8);
    expect(r.wasRaised).toBe(false);
    expect(r.action).toBe('HELD');
  });

  it('uses initial mult when unrealised gain is just below lock-in threshold', () => {
    const entry = 10_000;
    const high = 11_499; // +14.99%
    const r = computeNewStop({
      entryPrice: entry,
      highestCloseSinceEntry: high,
      currentStopLoss: 8900,
      atr14Today: 5,
      sizing: legacySizing,
      currentMultiplier: 2,
    });
    expect(r.multiplier).toBe(2);
    expect(r.wasTightened).toBe(false);
  });

  it('uses tightened mult and TIGHTENED at exactly 15.0% when stop rises and mult was initial', () => {
    const entry = 500;
    const high = 575; // +15%
    const atr = 10;
    const candidate = high - 1.5 * atr; // 560
    const r = computeNewStop({
      entryPrice: entry,
      highestCloseSinceEntry: high,
      currentStopLoss: 550,
      atr14Today: atr,
      sizing: legacySizing,
      currentMultiplier: 2,
    });
    expect(r.multiplier).toBe(1.5);
    expect(r.wasTightened).toBe(true);
    expect(r.wasRaised).toBe(true);
    expect(r.action).toBe('TIGHTENED');
    expect(r.newStop).toBeCloseTo(candidate, 8);
  });

  it('mult transitions initial→tightened on first ≥15% bar but golden rule keeps action HELD', () => {
    const entry = 500;
    const high = 600; // +20%
    const atr = 80; // 600 - 120 = 480 < current stop 520
    const r = computeNewStop({
      entryPrice: entry,
      highestCloseSinceEntry: high,
      currentStopLoss: 520,
      atr14Today: atr,
      sizing: legacySizing,
      currentMultiplier: 2,
    });
    expect(r.multiplier).toBe(1.5);
    expect(r.wasTightened).toBe(true);
    expect(r.wasRaised).toBe(false);
    expect(r.action).toBe('HELD');
  });

  it('keeps tightened multiplier after gain dips (DB already tightened)', () => {
    const entry = 500;
    const high = 510; // +2% from entry
    const r = computeNewStop({
      entryPrice: entry,
      highestCloseSinceEntry: high,
      currentStopLoss: 480,
      atr14Today: 8,
      sizing: legacySizing,
      currentMultiplier: 1.5,
    });
    expect(r.multiplier).toBe(1.5);
    expect(r.wasTightened).toBe(false);
  });

  it('uses production 18% lock-in and 2.5× initial when below threshold', () => {
    const entry = 100;
    const high = 117; // +17%
    const r = computeNewStop({
      entryPrice: entry,
      highestCloseSinceEntry: high,
      currentStopLoss: 80,
      atr14Today: 2,
      sizing: productionSizing,
      currentMultiplier: 2.5,
    });
    expect(r.multiplier).toBe(2.5);
  });

  it('uses production tightened mult at 18% peak gain', () => {
    const entry = 100;
    const high = 118; // +18%
    const r = computeNewStop({
      entryPrice: entry,
      highestCloseSinceEntry: high,
      currentStopLoss: 90,
      atr14Today: 2,
      sizing: productionSizing,
      currentMultiplier: 2.5,
    });
    expect(r.multiplier).toBe(1.5);
    expect(r.wasTightened).toBe(true);
  });

  it('floors absurd negative candidate at 50% of entry', () => {
    const entry = 100;
    const r = computeNewStop({
      entryPrice: entry,
      highestCloseSinceEntry: 110,
      currentStopLoss: 95,
      atr14Today: 500,
      sizing: legacySizing,
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
      sizing: legacySizing,
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
    expect(applyDay1InitialStop(entry, 480, atr, 2)).toBe(480);
  });

  it('tightens to ATR-based stop when LLM was looser (lower)', () => {
    const entry = 500;
    const atr = 12; // atr stop 476 @ 2×
    expect(applyDay1InitialStop(entry, 460, atr, 2)).toBe(476);
  });

  it('uses config initial multiplier for day-1 ATR stop', () => {
    const entry = 500;
    const atr = 12; // 500 - 30 = 470 @ 2.5×
    expect(applyDay1InitialStop(entry, 460, atr, productionSizing.initialMultiplier)).toBe(470);
  });

  it('passes through LLM stop when ATR at entry is missing', () => {
    expect(applyDay1InitialStop(500, 470, null, 2.5)).toBe(470);
  });
});
