import { describe, expect, it } from 'vitest';
import { scheduledWorkflowOptions } from '../../src/scheduler/market-scheduler.js';

describe('scheduledWorkflowOptions', () => {
  it('Decision Run explicitly enables admission', () => {
    expect(scheduledWorkflowOptions('weekday-0845')).toEqual({
      admitNewPaperTrades: true,
    });
  });

  it('Saturday Decision Run explicitly enables admission', () => {
    expect(scheduledWorkflowOptions('sat-0800')).toEqual({
      admitNewPaperTrades: true,
    });
  });

  it('EOD Reconciliation disables AI and new admissions', () => {
    expect(scheduledWorkflowOptions('weekday-1630')).toEqual({
      skipAi: true,
      admitNewPaperTrades: false,
    });
  });

  it('unknown tags default to non-admitting read-only run', () => {
    expect(scheduledWorkflowOptions('unknown')).toEqual({
      skipAi: true,
      admitNewPaperTrades: false,
    });
  });
});
