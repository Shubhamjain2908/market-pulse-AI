-- Migration 0029: Preserve Proposed Action
-- Adds proposed_action to portfolio_analysis (what the LLM originally proposed
-- before portfolio guardrails modified it).
--
-- effective_action on paper_trades was considered but removed from this PR:
-- paper trades are only created for ADD actions, making effective_action=ADD
-- always — no useful signal. Pipe it in a future migration when a use case
-- materialises.

ALTER TABLE portfolio_analysis ADD COLUMN proposed_action TEXT;
