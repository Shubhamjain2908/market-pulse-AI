import { describe, expect, it } from 'vitest';
import { ThesisSchema } from '../../src/types/domain.js';

describe('ThesisSchema (LLM repair)', () => {
  it('accepts INR levels as numbers and coerces to strings', () => {
    const raw = {
      symbol: 'TCS',
      thesis: 'x'.repeat(25),
      bullCase: ['a'],
      bearCase: ['b'],
      entryZone: '₹100',
      stopLoss: 3500,
      target: 3800,
      timeHorizon: 'medium',
      confidenceScore: 7,
      triggerScreen: 'momentum_mf',
    };
    const t = ThesisSchema.parse(raw);
    expect(t.stopLoss).toContain('3500');
    expect(t.target).toContain('3800');
  });

  it('accepts stopLoss as {low,high} object', () => {
    const raw = {
      symbol: 'INFY',
      thesis: 'y'.repeat(22),
      bullCase: ['u'],
      bearCase: ['v'],
      entryZone: '₹1',
      stopLoss: { low: 1500, high: 1520 },
      target: { min: 1600, max: 1650 },
      timeHorizon: 'long',
      confidenceScore: '8',
      triggerScreen: 'x',
    };
    const t = ThesisSchema.parse(raw);
    expect(t.stopLoss).toContain('1500');
    expect(t.stopLoss).toContain('1520');
    expect(t.target).toContain('1600');
    expect(t.confidenceScore).toBe(8);
  });

  it('maps prose timeHorizon to enum', () => {
    const base = {
      symbol: 'VEDL',
      thesis: 'z'.repeat(24),
      bullCase: ['a'],
      bearCase: ['b'],
      entryZone: '₹1',
      stopLoss: '₹2',
      target: '₹3',
      confidenceScore: 5,
      triggerScreen: 'm',
    };
    expect(ThesisSchema.parse({ ...base, timeHorizon: '1-3 Months' }).timeHorizon).toBe('medium');
    expect(ThesisSchema.parse({ ...base, timeHorizon: '1-4 weeks' }).timeHorizon).toBe('short');
  });

  it('wraps single-string bull/bear into arrays', () => {
    const raw = {
      symbol: 'MCX',
      thesis: 'w'.repeat(21),
      bullCase: 'One bull point only',
      bearCase: 'Risk note',
      entryZone: '₹5',
      stopLoss: '₹4',
      target: '₹6',
      timeHorizon: 'short',
      confidenceScore: 6,
      triggerScreen: 'momentum_mf',
    };
    const t = ThesisSchema.parse(raw);
    expect(t.bullCase).toEqual(['One bull point only']);
    expect(t.bearCase).toEqual(['Risk note']);
  });
});
