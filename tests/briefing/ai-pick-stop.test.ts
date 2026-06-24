import { describe, expect, it } from 'vitest';
import { resolveAiPickStop } from '../../src/briefing/ai-pick-stop.js';

describe('resolveAiPickStop', () => {
  it('widens BHARATFORG-like tight thesis stop to minimum distance', () => {
    const entry = 2022.5;
    const parsedStop = 2016.79;
    const atr14 = 40;
    const r = resolveAiPickStop(entry, parsedStop, atr14);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.normalized).toBe(true);
    expect(r.effectiveStop).toBeCloseTo(entry - Math.max(entry * 0.02, atr14), 2);
  });

  it('keeps thesis stop when already wide enough', () => {
    const entry = 100;
    const r = resolveAiPickStop(entry, 95, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.normalized).toBe(false);
    expect(r.effectiveStop).toBe(95);
  });

  it('applies 8% floor backstop for overly wide LLM stops', () => {
    const entry = 100;
    const r = resolveAiPickStop(entry, 88, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.effectiveStop).toBe(92);
  });

  it('blocks when min distance exceeds 8% cap', () => {
    const entry = 100;
    const r = resolveAiPickStop(entry, 90, 15);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('stop_distance_conflict');
  });
});
