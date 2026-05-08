-- Extra fields for momentum briefing card (ranker + entry-thesis outcome).
ALTER TABLE momentum_rebalance_briefing ADD COLUMN thesis_failed INTEGER;
ALTER TABLE momentum_rebalance_briefing ADD COLUMN ranker_universe_size INTEGER;
ALTER TABLE momentum_rebalance_briefing ADD COLUMN ranker_eligible_count INTEGER;
