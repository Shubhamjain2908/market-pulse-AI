import { describe, expect, it } from 'vitest';
import { renderTrailingStopSection } from '../../src/briefing/trailing-stop-card.js';
import {
  GAP_DOWN_THROUGH_STOP_NOTE,
  TRAILING_STOP_ANALYSIS_PENDING,
} from '../../src/types/trailing-stop.js';
import type {
  NearStopOpenRow,
  TrailingStopLogBriefingRow,
  TrailingStopLogRow,
} from '../../src/types/trailing-stop.js';

function logRow(
  partial: Partial<TrailingStopLogBriefingRow> & Pick<TrailingStopLogRow, 'action'>,
): TrailingStopLogBriefingRow {
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
    tradeEntryPrice: partial.tradeEntryPrice,
    tradeExitPrice: partial.tradeExitPrice,
    tradePnlPct: partial.tradePnlPct,
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

  it('shows Analysis pending when STOPPED_OUT has no narrative yet', () => {
    const html = renderTrailingStopSection(
      [
        logRow({
          action: 'STOPPED_OUT',
          symbol: 'NONAR',
          narrative: null,
        }),
      ],
      [],
      '2026-05-05',
    );
    expect(html).toContain(TRAILING_STOP_ANALYSIS_PENDING);
  });

  it('omits sub-threshold RAISED noise from EOD log', () => {
    const html = renderTrailingStopSection(
      [
        logRow({
          action: 'RAISED',
          symbol: 'VBL',
          tradeId: 59,
          prevStop: 478,
          newStop: 478.03,
          stopDelta: 0.03,
        }),
      ],
      [],
      '2026-05-06',
    );
    expect(html).toBe('');
  });

  it('still renders material RAISED after filtering', () => {
    const html = renderTrailingStopSection(
      [
        logRow({
          action: 'RAISED',
          symbol: 'IRCTC',
          tradeId: 84,
          prevStop: 800,
          newStop: 804.82,
          stopDelta: 4.82,
        }),
      ],
      [],
      '2026-05-06',
    );
    expect(html).toContain('IRCTC');
    expect(html).toContain('Raised');
    expect(html).toContain('+4.82');
  });

  it('STOPPED_OUT shows trade P&amp;L separately from stop delta vs session open', () => {
    const html = renderTrailingStopSection(
      [
        logRow({
          action: 'STOPPED_OUT',
          symbol: 'NTPC',
          tradeId: 28,
          prevStop: 393,
          newStop: 393,
          stopDelta: 0,
          tradeEntryPrice: 393,
          tradeExitPrice: 393,
          tradePnlPct: 0,
          narrative: null,
        }),
      ],
      [],
      '2026-05-06',
    );
    expect(html).toContain('trade P&amp;L +0.00%');
    expect(html).toContain('entry ₹393.00 → exit ₹393.00');
    expect(html).toContain('vs session open');
    expect(html).toContain('fill at stop without intraday raise');
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

  describe('§9.3 briefing card (spec)', () => {
    it('9.3.1 — STOPPED_OUT narrative shows post-mortem text, not pending placeholder', () => {
      const html = renderTrailingStopSection(
        [
          logRow({
            action: 'STOPPED_OUT',
            symbol: 'POST1',
            narrative:
              'Volatility expanded into the exit; the trail had tightened before the session flushed through the level.',
          }),
        ],
        [],
        '2026-06-10',
      );
      expect(html).toContain('Volatility expanded');
      expect(html).not.toContain(TRAILING_STOP_ANALYSIS_PENDING);
    });

    it('9.3.2 — EOD log and Near stop blocks both appear when each has rows', () => {
      const near: NearStopOpenRow[] = [
        {
          kind: 'NEAR_STOP',
          tradeId: 2,
          symbol: 'NEAR2',
          stopLoss: 200,
          todayClose: 201,
          atr14Today: 1.5,
          cushion: 1,
        },
      ];
      const html = renderTrailingStopSection(
        [
          logRow({
            id: 3,
            action: 'RAISED',
            symbol: 'LOG2',
            tradeId: 9,
            prevStop: 90,
            newStop: 95,
            stopDelta: 5,
          }),
        ],
        near,
        '2026-06-11',
      );
      expect(html).toContain('EOD log');
      expect(html).toContain('Near stop (open positions)');
      expect(html).toContain('LOG2');
      expect(html).toContain('NEAR2');
    });

    it('9.3.3 — TIGHTENED renders as its own event badge', () => {
      const html = renderTrailingStopSection(
        [
          logRow({
            action: 'TIGHTENED',
            symbol: 'TIGHT1',
            prevStop: 100,
            newStop: 102,
            stopDelta: 2,
          }),
        ],
        [],
        '2026-06-12',
      );
      expect(html).toContain('Tightened');
      expect(html).toContain('TIGHT1');
    });
  });
});
