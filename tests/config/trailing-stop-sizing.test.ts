import { describe, expect, it } from 'vitest';
import { loadMomentumConfig } from '../../src/config/loaders.js';
import {
  normalizePersistedTrailingMult,
  trailingStopSizingFromMomentumConfig,
} from '../../src/config/trailing-stop-sizing.js';

describe('trailingStopSizingFromMomentumConfig', () => {
  it('loads Phase 2 production values from momentum-config.json', () => {
    const s = trailingStopSizingFromMomentumConfig(loadMomentumConfig({ fresh: true }));
    expect(s.initialMultiplier).toBe(2.5);
    expect(s.lockInThresholdPct).toBe(18);
    expect(s.tightenedMultiplier).toBe(1.5);
  });

  it('maps legacy DB trailing_multiplier 2.0 to current initial band', () => {
    const s = trailingStopSizingFromMomentumConfig();
    expect(normalizePersistedTrailingMult(2, s)).toBe(2.5);
    expect(normalizePersistedTrailingMult(1.5, s)).toBe(1.5);
    expect(normalizePersistedTrailingMult(null, s)).toBe(2.5);
  });
});
