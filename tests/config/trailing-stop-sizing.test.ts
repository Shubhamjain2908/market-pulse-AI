import { describe, expect, it } from 'vitest';
import { loadMomentumConfig } from '../../src/config/loaders.js';
import { trailingStopSizingFromMomentumConfig } from '../../src/config/trailing-stop-sizing.js';

describe('trailingStopSizingFromMomentumConfig', () => {
  it('loads Phase 2 production values from momentum-config.json', () => {
    const s = trailingStopSizingFromMomentumConfig(loadMomentumConfig());
    expect(s.initialMultiplier).toBe(2.5);
    expect(s.lockInThresholdPct).toBe(18);
    expect(s.tightenedMultiplier).toBe(1.5);
  });
});
