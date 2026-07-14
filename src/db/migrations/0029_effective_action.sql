-- Migration 0029: Preserve Proposed Action
-- Adds proposed_action to portfolio_analysis (what the LLM originally proposed
-- before portfolio guardrails modified it) and the deterministic override reason.

ALTER TABLE portfolio_analysis
ADD COLUMN proposed_action TEXT
CHECK (proposed_action IN ('HOLD', 'ADD', 'TRIM', 'EXIT'));

ALTER TABLE portfolio_analysis
ADD COLUMN action_override_reason TEXT;

UPDATE portfolio_analysis
SET proposed_action = action
WHERE proposed_action IS NULL;
