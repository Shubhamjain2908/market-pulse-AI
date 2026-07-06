# Daily Run Review Implementation Plan - 2026-07-06

## Goal

Turn the 2026-07-06 daily-run review into small, safe PRs that improve signal integrity, paper-trade admission, briefing accuracy, and ingestion reliability.

The pipeline is decision-support only. Do not add live order routing, auto-GTT activation, or execution behavior. All changes must preserve the research/paper-trade boundary.

## Baseline findings

- The daily pipeline completed successfully, but `pnpm daily` ran twice for `2026-07-06`.
- Same-date outputs were mixed across runs:
  - latest screen stage logged `matchCount=7`
  - final briefing showed 8 `golden_cross` rows because old same-date `screens` rows remained
  - DB had 6 theses for the date while the briefing rendered Top 5
- `NYKAA` appeared as `golden_cross` even though latest `rsi_14 = 70.528`, above the `[45, 70]` screen cap.
- `IDEA` false-momentum protection failed open after `net_profit_ttm` flipped from negative to a large positive value, likely from exceptional accounting gain; operating quality remained poor (`roce = -1.6`, `pb/roe = NULL`).
- `ADANIENSOL` was re-entered as a same-day AI_PICK after an earlier ADANIENSOL paper trade hit target.
- `SGBJUN31I-GB` was reviewed by Gemini instead of being treated as an allocation instrument.
- Concall fetch found 9 PDFs but extracted 0 usable transcripts.
- Screener ingest recovered from a 429 storm but needs safer throttling.
- Stale inactive external strategy rows remain in `ext_signal_holdings`.

## Non-negotiable guardrails

- Keep `src/cli.ts` thin; put behavior in domain modules.
- Use existing DB helpers and prepared statements; no ORM.
- Add append-only migrations only when schema changes are required.
- Do not read `process.env` directly outside config loaders.
- Preserve fail-closed strategy gating.
- Preserve market-closure mode and degraded-briefing behavior.
- Do not loosen AI_PICK admission or GTT activation gates.
- Every PR must include targeted tests and run:

```bash
pnpm typecheck && pnpm test && pnpm lint
```

If local Node/better-sqlite3 ABI is broken, first run:

```bash
pnpm rebuild better-sqlite3
```

## Suggested PR order

Implement one PR at a time in this order:

1. Same-date rerun staleness and screen replacement
2. Golden-cross RSI regression
3. IDEA false-momentum v2 guard
4. Same-day AI_PICK re-entry cooldown
5. Allocation instrument/SGB normalization
6. Thesis trigger hygiene
7. Concall coverage visibility and PDF classification
8. Screener 429 throttling
9. External signal stale strategy cleanup

PRs 1-4 are highest priority because they directly affect paper-trade admission and briefing correctness.

---

## PR 1 - Fix same-date rerun staleness

### Problem

Rerunning the pipeline for the same `run_date` leaves stale rows in durable output tables. On 2026-07-06, the latest screen stage reported 7 matches, but briefing showed 8 because old `screens` rows remained from the earlier run.

### Target behavior

For a rerun of the same `run_date`, briefing inputs must represent one coherent latest run, not a union of old and new same-date rows.

Minimum acceptable behavior:

- Before writing screen matches for a screen/date, remove stale rows for that `(date, screen_name)` or replace the complete set transactionally.
- If a screen rerun produces fewer matches, old rows must disappear.
- `pipeline_runs` should remain append-only.
- Briefing should reflect latest screen output after rerun.

### Likely files

- `src/analysers/stock-screener.ts`
- `src/analysers/engine.ts`
- `src/db/queries.ts`
- `src/db/pipeline-queries.ts` if metadata needs improvement
- `tests/analysers/stock-screener.test.ts`
- `tests/briefing/*` if briefing reads need coverage

### Implementation notes

Prefer a DB helper like:

```ts
replaceScreenResultsForDate(db, date, screenName, rows)
```

It should run in a transaction:

1. `DELETE FROM screens WHERE date = ? AND screen_name = ?`
2. Insert current pass rows.

For custom dispatchers (`quality_garp`, `catalyst_entry`) and DSL screens, ensure all paths use the same replacement semantics.

Do not delete `theses` in this PR unless the current code already treats theses as screen-owned. Thesis rerun handling is covered separately if needed.

### Tests

Add a test that:

1. Inserts or generates a `golden_cross` pass for `NYKAA`.
2. Changes latest `rsi_14` to `70.528`.
3. Reruns screen for same date.
4. Asserts `NYKAA` is no longer in `screens`.
5. Asserts `screens` count equals latest run count, not cumulative count.

### Acceptance criteria

- Latest rerun output replaces stale same-date screen rows.
- `pipeline_runs` remains append-only.
- Briefing screen count matches latest `screen` stage metadata.

---

## PR 2 - Add golden-cross RSI edge regression

### Problem

`NYKAA` appeared in `golden_cross` despite latest `rsi_14 = 70.528` and configured RSI band `[45, 70]`.

This may be caused by stale rows from PR 1, but add a direct regression so the screen engine cannot admit above-threshold RSI.

### Target behavior

For a `between [45, 70]` criterion:

- `45` passes
- `70` passes if the current engine treats bounds as inclusive
- `70.0001` fails
- `70.528` fails

### Likely files

- `src/analysers/engine.ts`
- `tests/analysers/engine.test.ts`
- `tests/analysers/stock-screener.test.ts`

### Tests

Add small unit tests around `between` evaluation and one integration-style test using `golden_cross`.

### Acceptance criteria

- `NYKAA`-style `rsi_14 = 70.528` fails `golden_cross`.
- No unrelated screen behavior changes.

---

## PR 3 - Harden IDEA false-momentum and AI_PICK quality guard

### Problem

`IDEA` was admitted as an AI_PICK because:

- `mom_rank = 4`
- `mom_false_flag = 0`
- `net_profit_ttm` changed from `-612.2` to `34552`

But operating quality was still weak:

- `roce = -1.6`
- `pb = NULL`
- `roe = NULL`
- recent history shows several loss-making quarters before a large one-off-looking profit row

This repeats the known IDEA false-momentum class from the quant log, but through AI_PICK admission rather than only momentum rebalance.

### Target behavior

AI_PICK admission should block or downgrade technical momentum when operating quality is structurally impaired.

Add a deterministic guard such as:

- block AI_PICK when `mom_rank` path is the main confirmation and any of:
  - `roce < 0`
  - `pb IS NULL` and `roe IS NULL` for non-financials or known impaired balance-sheet names
  - `net_profit_ttm` recently flips from negative to large positive while trailing quarterly sequence contains multiple losses
- at minimum, IDEA 2026-07-06 must not be admitted as AI_PICK.

Be careful with financials where `debt_to_equity` and PB semantics differ.

### Likely files

- `src/briefing/ai-pick-gate.ts`
- `src/rankers/momentum-ranker.ts`
- `src/agents/thesis-generator.ts` if context/facts need surfacing
- `src/db/queries.ts` if extra historical fundamental/quarterly helper is needed
- `tests/briefing/ai-pick-gate.test.ts`
- `tests/rankers/momentum-ranker.test.ts`

### Implementation notes

Keep the existing false flag, but add a second "operating quality guard" fact:

```ts
operatingQualityBlocked: boolean
operatingQualityReasons: string[]
```

Suggested reason labels:

- `negative_roce`
- `missing_equity_quality`
- `exceptional_profit_flip`

Log blocked facts using the existing `ai_pick_blocked` event path.

Do not silently cap confidence only. If a paper-trade row would be inserted through a rank-only technical path, block it.

### Tests

Regression fixture:

- symbol `IDEA`
- `mom_rank = 4`
- `mom_false_flag = 0`
- `roce = -1.6`
- `pb = NULL`
- `roe = NULL`
- `net_profit_ttm = 34552`

Expected:

- thesis may render as research
- `evaluateAiPickEligibility()` returns not eligible
- no paper trade insert
- reasons include `negative_roce` or equivalent

### Acceptance criteria

- IDEA 2026-07-06 scenario is blocked.
- Existing high-quality momentum names are not overblocked.
- Block reason appears in logs/facts.

---

## PR 4 - Add same-day AI_PICK re-entry cooldown

### Problem

ADANIENSOL paper trade #267 hit target on 2026-07-06, then a new ADANIENSOL AI_PICK #270 was opened later the same day at a higher entry.

This is allowed because cross-strategy dedup checks only open trades. In CHOPPY, same-day re-entry after closure creates churn risk.

### Target behavior

Block new paper-trade inserts for a symbol if any paper trade for that symbol closed on the same `source_date` / run date.

Suggested default:

- Applies to `AI_PICK` and `PORTFOLIO_ADD`.
- Applies at least in `CHOPPY`, `BEAR_TRENDING`, and `CRISIS`.
- Optional: allow in `BULL_TRENDING` only if there is a distinct non-stale screen and no same-day target hit.

Keep it simple for first PR: same-symbol same-day close blocks same-day re-entry for all regimes unless there is a clear config flag.

### Likely files

- `src/db/queries.ts`
- `src/briefing/paper-trade-writer.ts`
- `src/strategies/momentum-rebalance.ts` if momentum inserts share helper
- `tests/briefing/paper-trade-writer.test.ts`

### Implementation notes

Add helper:

```ts
hasPaperTradeClosedForSymbolOnDate(db, symbol, date): boolean
```

Query:

```sql
SELECT 1
FROM paper_trades
WHERE symbol = ?
  AND outcome_date = ?
  AND status LIKE 'CLOSED%'
LIMIT 1
```

When blocked, increment a counter like `sameDayReentryBlocked` and log event:

```ts
event: "paper_trade_same_day_reentry_blocked"
```

### Tests

- Existing closed `ADANIENSOL` with `outcome_date = 2026-07-06`.
- Attempt insert new `ADANIENSOL` AI_PICK with `source_date = 2026-07-06`.
- Assert no insert and blocked counter increments.

### Acceptance criteria

- Same-day re-entry is blocked.
- Existing cross-strategy open-trade dedup still works.
- Briefing summary can expose blocked count if existing pattern supports it.

---

## PR 5 - Fix allocation instrument / SGB normalization

### Problem

`SGBJUN31I-GB` was reviewed by Gemini instead of being treated as allocation-only. Guardrails require ETFs/SGBs/allocation instruments to skip equity LLM review and persist deterministic `HOLD` rows with `model='none'`.

### Target behavior

All SGB variants and ETF/liquid symbols should be detected as allocation instruments.

Examples that must be allocation-only:

- `SGBDE31III`
- `SGBJUN31I-GB`
- symbols beginning with `SGB`
- configured ETF symbols in `config/etf-exclusions.json`

### Likely files

- `src/agents/portfolio-analyser.ts`
- `src/agents/portfolio-context.ts`
- `src/config/etf-exclusions.json`
- `tests/agents/portfolio-analyser.test.ts`
- `tests/agents/portfolio-context.test.ts`

### Implementation notes

Prefer a shared helper:

```ts
isAllocationInstrument(symbol: string): boolean
```

It should normalize:

- uppercase
- trim
- remove/ignore exchange suffix if existing code uses one

Then check:

- configured exclusions
- `symbol.startsWith("SGB")`

Avoid duplicating logic across analyser/context/briefing.

### Tests

- `SGBJUN31I-GB` returns allocation instrument.
- Portfolio analysis row has:
  - `action = HOLD`
  - `model = none`
  - `trigger_reason` starts with `ALLOCATION_INSTRUMENT`
- No LLM call is attempted for SGB.

### Acceptance criteria

- No SGB enters equity LLM path.
- Existing ETF exclusions still work.

---

## PR 6 - Clean thesis trigger reasons and setup labels

### Problem

Some thesis narratives are numerically grounded but misleading in labels:

- TIPSMUSIC said "High ROE + Low PEG fundamental screener" although only `golden_cross` fired.
- LTF was framed as a "breakout" despite being a near-52W-high stretched pullback entry with no confirmation path.

### Target behavior

Thesis trigger text must only reference actual fired screens and available facts.

Rules:

- Do not mention "fundamental screener" unless a non-technical/fundamental screen fired.
- If only `golden_cross` fired, label as trend-following or technical confirmation, not fundamental screener.
- If current price is above entry zone and RSI is stretched, describe as "pullback entry watch", not "breakout entry".
- If a thesis is blocked by admission gate, briefing should visually distinguish "research thesis" from "paper-trade admitted" if feasible.

### Likely files

- `src/agents/thesis-generator.ts`
- `src/briefing/composer.ts`
- `src/briefing/template.ts`
- `src/briefing/ai-pick-gate.ts`
- tests under `tests/agents` or `tests/briefing`

### Implementation notes

Build trigger reason from structured candidate facts instead of free-form inference where possible.

Add facts:

```ts
firedScreens: string[]
admissionStatus?: "inserted" | "blocked" | "research_only"
admissionReasons?: string[]
```

Prompt hygiene:

- Tell LLM: "Do not claim a screen fired unless listed in firedScreens."
- Tell LLM: "If current price is above entry zone, describe as wait-for-pullback."

### Tests

- TIPSMUSIC with only `golden_cross` should not mention "fundamental screener".
- LTF with near-high alert and entry below current price should include pullback/watch wording.

### Acceptance criteria

- Trigger labels match actual screen facts.
- No prompt-only fix without test coverage.

---

## PR 7 - Improve concall ingest coverage visibility

### Problem

Concall stage found 9 PDFs but extracted 0 usable transcripts. The stage is fail-open and technically successful, but the user-facing output does not clearly show that no concall alpha was available.

### Target behavior

Make concall coverage explicit:

- Count found PDFs.
- Count skipped outcome/invite/image-only PDFs.
- Count extracted usable transcripts.
- Count analysed transcripts.
- Briefing or pipeline warning should state "Concall: 0 usable transcripts extracted" when relevant.

### Likely files

- `src/ingestors/nse/announcements-fetcher.ts`
- `src/agents/concall-analyser.ts`
- `src/agents/daily-workflow.ts`
- `src/briefing/composer.ts`
- `src/briefing/template.ts`
- `src/db/pipeline-queries.ts`
- tests under `tests/briefing` and/or `tests/agents`

### Implementation notes

Do not lower the `<2000 chars` threshold blindly. Most skipped files were likely invites/outcome sheets, not actual transcripts.

Add classification if easy:

- `transcript`
- `invite`
- `outcome`
- `audio_link`
- `unknown_short_pdf`

If schema change is needed, add append-only migration. If not needed, include classification in stage metadata first.

### Acceptance criteria

- Pipeline metadata records found/skipped/extracted counts.
- Briefing or warning section makes zero extracted transcripts visible.
- No thesis claims concall support when no `concall_intel` exists.

---

## PR 8 - Reduce Screener 429 throttling

### Problem

Screener ingestion hit repeated 429 retries for several minutes before recovering. It completed, but this is noisy and fragile.

### Target behavior

Reduce 429 storms with safer request pacing.

### Likely files

- `src/ingestors/screener-*`
- `src/ingestors/http-client*`
- `src/config/env.ts` if adding config
- tests for retry/backoff if existing patterns support it

### Implementation options

Pick one small first step:

1. Add exponential backoff with jitter for Screener 429 responses.
2. Lower Screener concurrency/batch size.
3. Add per-host minimum delay.

Prefer config with zod validation if runtime-tunable:

```env
SCREENER_MIN_DELAY_MS=...
SCREENER_MAX_RETRIES=...
```

### Tests

- Mock 429 responses and verify backoff/retry count.
- Ensure non-429 errors keep existing behavior.

### Acceptance criteria

- 429 retry logs are less dense.
- Ingest still writes fundamentals after transient 429.
- No broad catch/silent success fallback.

---

## PR 9 - Clean stale inactive external signal rows

### Problem

`ext_signal_holdings` contains stale rows for inactive/rejected strategies such as `HUNT2_FCF_Acceleration`. Even if config excludes them, old rows may still overlap with briefing windows unless all reads filter active strategies.

### Target behavior

Only active configured external strategies should be used for briefing annotations and cross-reference diagnostics.

Also clean existing stale rows.

### Likely files

- `config/ext-signal-provider.json`
- `src/ingestors/ext-signal-holdings-ingestor.ts`
- `src/briefing/composer.ts`
- `src/db/queries.ts`
- SQL migration or one-off script if persistent cleanup is required
- tests for briefing annotation filtering

### Implementation notes

Add a migration only if we want durable cleanup in all DBs:

```sql
DELETE FROM ext_signal_holdings
WHERE strategy_name = 'HUNT2_FCF_Acceleration';
```

If avoiding data-delete migration, add a script and ensure read paths filter strategies from active config.

Briefing annotation query should use active strategy names from config, not all rows in the 3-day window.

### Tests

- Insert stale HUNT2 row and active DCF row.
- Assert only DCF can produce `[ext: confirmed ...]`.

### Acceptance criteria

- HUNT2 rows no longer affect briefing annotations.
- Active DCF_Compounder_Stack still works.

---

## Documentation updates per PR

Update docs only when the PR changes behavior:

- `.cursor/rules/guardrails.md`
  - IDEA operating-quality guard
  - same-day re-entry cooldown
  - SGB allocation normalization
- `.cursor/rules/architecture-v2.md`
  - rerun replacement semantics
  - concall coverage metadata if user-visible
- `.cursor/rules/db-schema.md`
  - only if migrations/schema change
- `README.md`
  - only for user-facing CLI/config behavior
- `strategy-backlog.md`
  - mark completed backlog items or add follow-ups

## PR checklist

Before raising each PR:

```bash
pnpm typecheck
pnpm test
pnpm lint
```

Also run the nearest targeted tests, for example:

```bash
pnpm test tests/analysers/stock-screener.test.ts
pnpm test tests/briefing/ai-pick-gate.test.ts
pnpm test tests/agents/portfolio-analyser.test.ts
```

Each PR description should include:

- What broke on 2026-07-06
- What changed
- Which guardrail is now enforced
- Test evidence
- Any remaining follow-up

