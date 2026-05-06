import { describe, expect, it } from 'vitest';
import { renderTrailingStopSection } from '../../src/briefing/trailing-stop-card.js';
import { GAP_DOWN_THROUGH_STOP_NOTE } from '../../src/types/trailing-stop.js';
import type { NearStopOpenRow, TrailingStopLogRow } from '../../src/types/trailing-stop.js';

function logRow(
  partial: Partial<TrailingStopLogRow> & Pick<TrailingStopLogRow, 'action'>,
): TrailingStopLogRow {
  return {
    id: partial.id ?? 1,
    tradeId: partial.tradeId ?? 10,
    symbol: partial.symbol ?? 'ABC',
    logDate: partial.logDate ?? '2026-05-01',
    prevStop: partial.prevStop ?? 90,
    newStop: partial.newStop ?? 95,
    stopDelta: partial.stopDelta ?? 5,
    candidateStop: partial.candidateStop ?? 94,
    highestClose: partial.highestClose ?? 100,
    atr14Today: partial.atr14Today ?? 3,
    multiplierUsed: partial.multiplierUsed ?? 2,
    unrealisedPct: partial.unrealisedPct ?? 8,
    action: partial.action,
    narrative: partial.narrative ?? null,
    notes: partial.notes ?? null,
    createdAt: partial.createdAt ?? '2026-05-01T10:00:00',
  };
}

describe('trailing-stop-card HTML', () => {
  it('returns empty string when no events', () => {
    expect(renderTrailingStopSection([], [], '2026-05-01')).toBe('');
  });

  it('renders RAISED row and omits HELD', () => {
    const html = renderTrailingStopSection(
      [
        logRow({
          id: 1,
          action: 'RAISED',
          symbol: 'ABCAPITAL',
          prevStop: 100,
          newStop: 104,
          stopDelta: 4,
          tradeId: 3,
        }),
        logRow({
          id: 2,
          action: 'HELD',
          symbol: 'OTHER',
          prevStop: 50,
          newStop: 50,
          stopDelta: 0,
          tradeId: 4,
        }),
      ],
      [],
      '2026-05-01',
    );
    expect(html).toContain('Paper trades · trailing stops');
    expect(html).toContain('ABCAPITAL');
    expect(html).toContain('#3');
    expect(html).toContain('Raised');
    expect(html).not.toContain('OTHER');
    expect(html).toContain('EOD log');
  });

  it('renders STOPPED_OUT before RAISED by priority', () => {
    const html = renderTrailingStopSection(
      [
        logRow({
          id: 1,
          tradeId: 1,
          action: 'RAISED',
          symbol: 'ZZZ',
          prevStop: 1,
          newStop: 2,
          stopDelta: 1,
        }),
        logRow({
          id: 2,
          tradeId: 2,
          action: 'STOPPED_OUT',
          symbol: 'AAA',
          prevStop: 90,
          newStop: 88,
          stopDelta: -2,
        }),
      ],
      [],
      '2026-05-02',
    );
    const stopIdx = html.indexOf('Stopped out');
    const raisedIdx = html.indexOf('Raised');
    expect(stopIdx).toBeGreaterThan(-1);
    expect(raisedIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeLessThan(raisedIdx);
  });

  it('shows gap-down note when notes flag set', () => {
    const html = renderTrailingStopSection(
      [
        logRow({
          action: 'STOPPED_OUT',
          notes: GAP_DOWN_THROUGH_STOP_NOTE,
          symbol: 'GAPCO',
        }),
      ],
      [],
      '2026-05-03',
    );
    expect(html).toContain('gap-down open through stop');
  });

  it('renders NEAR_STOP subsection', () => {
    const near: NearStopOpenRow[] = [
      {
        kind: 'NEAR_STOP',
        tradeId: 7,
        symbol: 'NEAR1',
        stopLoss: 100,
        todayClose: 101,
        atr14Today: 2,
        cushion: 1,
      },
    ];
    const html = renderTrailingStopSection([], near, '2026-05-04');
    expect(html).toContain('Near stop');
    expect(html).toContain('NEAR1');
    expect(html).toContain('#7');
    expect(html).toContain('₹101.00 vs stop ₹100.00');
  });
});
