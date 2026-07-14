import { describe, expect, it } from 'vitest';
import { scheduledWorkflowOptions } from '../../src/scheduler/market-scheduler.js';

describe('scheduledWorkflowOptions', () => {
  it('keeps the Decision Run admission-enabled by default', () => {
    expect(scheduledWorkflowOptions('weekday-0845')).toEqual({});
  });

  it('disables AI and new admissions for EOD reconciliation', () => {
    expect(scheduledWorkflowOptions('weekday-1630')).toEqual({
      skipAi: true,
      admitNewPaperTrades: false,
    });
  });
});
