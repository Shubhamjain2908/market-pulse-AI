-- Migration 0027: Thesis rubric & context references
-- Adds columns for the anchored AI_PICK confidence rubric (Task A) and
-- data provenance references (Task C, shares this migration).

ALTER TABLE theses ADD COLUMN rubric_json TEXT;
-- rubric_json stores the full rubric breakdown as JSON:
-- {
--   "anchors": { "earningsTrajectory": number|null, "balanceSheet": number|null, "technicalStage": number|null },
--   "llm": { "moat": number, "sectorTailwind": number, "competitivePosition": number, "newsCatalyst": number },
--   "total": number  -- 0-90 scale
-- }

ALTER TABLE theses ADD COLUMN context_refs TEXT;
-- context_refs stores data provenance as JSON (Task C):
-- {
--   "quotes": { "from": string, "to": string, "bars": number, "source": string },
--   "fundamentals": { "asOf": string, "source": string },
--   "quarterly": { "quarters": string[], "source": string },
--   "signals": { "count": number, "latestDate": string },
--   "news": [{ "headline": string, "url": string, "publishedAt": string }],
--   "concall": { "announcedAt": string, "pdfUrl": string } | null,
--   "pledge": { "shpDate": string } | null
-- }
