import { describe, expect, it } from 'vitest';
import { ConcallIntelSchema } from '../../src/types/domain.js';

describe('ConcallIntelSchema delivery catch', () => {
  it('catches missing priorGuidance and invalid outcome', () => {
    const raw = {
      symbol: 'NAM-INDIA',
      announcedAt: '2026-07-01',
      sentiment: 'neutral',
      credibilityStars: 3,
      guidance: [],
      delivery: [
        { priorGuidance: 'NIM 3.5%', outcome: 'met' },
        { outcome: 'missed' }, // missing priorGuidance
        { priorGuidance: 'NIM 3.75%', outcome: 'invalid_value' }, // bad outcome
      ],
      summary: 'Test summary',
    };
    const parsed = ConcallIntelSchema.parse(raw);
    expect(parsed.delivery).toHaveLength(3);
    expect(parsed.delivery?.[0]?.priorGuidance).toBe('NIM 3.5%');
    expect(parsed.delivery?.[0]?.outcome).toBe('met');
    // Missing priorGuidance → caught to ''
    expect(parsed.delivery?.[1]?.priorGuidance).toBe('');
    expect(parsed.delivery?.[1]?.outcome).toBe('missed');
    // Invalid outcome → caught to 'unverifiable'
    expect(parsed.delivery?.[2]?.outcome).toBe('unverifiable');
  });

  it('catches entire delivery array when non-array provided', () => {
    const raw = {
      symbol: 'TEST',
      announcedAt: '2026-07-01',
      sentiment: 'neutral',
      credibilityStars: 3,
      guidance: [],
      delivery: 'not-an-array',
      summary: 'Test',
    };
    const parsed = ConcallIntelSchema.parse(raw);
    expect(parsed.delivery).toEqual([]);
  });
});

describe('concall invitation regex', () => {
  const INVITE_RE =
    /\b(invitation|cordially\s+invited|notice\s+of\s+(conference|earnings|board)|you\s+are\s+(cordially\s+)?invited|intimation\s+(of\s+)?(conference|earnings|board))\b/i;

  it('matches invitation text', () => {
    expect(INVITE_RE.test('You are cordially invited to the earnings call')).toBe(true);
    expect(INVITE_RE.test('Invitation for Q1 FY27 Earnings Call')).toBe(true);
    expect(INVITE_RE.test('Notice of Board Meeting')).toBe(true);
    expect(INVITE_RE.test('Intimation of Conference Call')).toBe(true);
    expect(INVITE_RE.test('you are invited to the conference')).toBe(true);
    expect(INVITE_RE.test('This is an invitation for analysts')).toBe(true);
  });

  it('does not match transcript text', () => {
    expect(INVITE_RE.test('Good morning and welcome to the Q1 FY27 earnings call')).toBe(false);
    expect(INVITE_RE.test('Thank you all for joining today')).toBe(false);
    expect(INVITE_RE.test('Our revenue grew 15% this quarter')).toBe(false);
    expect(INVITE_RE.test('We are pleased to report strong operating performance')).toBe(false);
    expect(INVITE_RE.test('Let me walk you through the financial highlights')).toBe(false);
    expect(INVITE_RE.test('Operator: Ladies and gentlemen, good morning')).toBe(false);
  });
});
