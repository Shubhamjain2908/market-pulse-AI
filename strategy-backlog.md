# Strategy Backlog — Market Pulse AI

**Gate:** No strategy moves to implementation until overall paper trade expectancy is positive over 30+ deduped closed
trades. Currently NOT met.

**Built:** Market Regime Filter · Adaptive Trailing Stop · Multi-Factor Momentum (momentum_mf) · Quality-GARP (`quality_garp`, v3) · Catalyst-Driven Entry (`catalyst_entry`, v1)

**Fundamentals backfill:** COMPLETE (2026-06-06). 241 symbols annual, Yahoo snapshot + screener refresh via `pnpm fundamentals:refresh`. **Quarterly fundamentals** backfill COMPLETE (2026-06-29): `revenue`, `operating_profit`, `opm_pct`, `net_profit`, `eps`, `operating_cash_flow`, `free_cash_flow` from Screener.in `#quarters` + `#cash-flow` tables for 166 symbols (3,222 rows). Backfill: `pnpm backfill:quarterly`.

---

## Shipped — Quality-GARP (v2, 2026-06-06)

**Live:** `quality_garp` dispatcher in [`stock-screener.ts`](src/analysers/stock-screener.ts) + [`getQualityGarpFundamentals`](src/db/queries.ts) (yahoo annual ×3 + snapshot/screener coalesce + promoter join). **13 gates** (`QUALITY_GARP_TOTAL_GATES = 13`): ETF exclusion → fundamentals present → PE/PB non-null → PE≤35/PB≤6 → 3yr ROE≥18% → ROCE≥20% → D/E<0.5 → PEG<1.2 → RSI<threshold (regime-aware) → SMA50 proximity (regime-aware) → promoter no-selling → pledge≤15% (shadow) → OPM stability (std-dev≤5%, fail-open) + post-gate QDS (score>3, fail-open). Regime **BULL 1.0× / CHOPPY 0.75×**. Refresh: `pnpm fundamentals:refresh`. README: [Quality-GARP screener](README.md#quality-garp-screener).

**v2 backlog (deferred):** Dec-FY `as_of` edge cases.

---

## Shipped — Catalyst-Driven Entry (v1, 2026-05-28)

**Live:** `catalyst_entry` screen + [`catalyst-screener.ts`](src/analysers/catalyst-screener.ts); earnings 5–14 days out; `close > sma_50` OR within 15% of 52W low; `BULL_TRENDING` gate only; thesis catalyst block + **confidence ≤ 6**; `paper_trades` `stop_type='fixed'` at 96%/108%; `max_hold_days = days_to_earnings + 2` (**calendar** days). README: [Catalyst-driven entry](README.md#catalyst-driven-entry-pre-earnings).

**v2 backlog:** analyst estimate revision feed; concall keyword triggers; sector-event proximity; trading-session `max_hold_days` from `quotes` (fixes holiday/weekend early `TIME_EXIT`).

---

## Shipped — OPM stability gate (B-ENG-11, 2026-06-30)

**Gate added:** Trailing 4-quarter OPM std-dev > 5% → hard block.
Fail-open when <4 quarters of `quarterly_fundamentals.opm_pct` data.

- Data source: `quarterly_fundamentals.opm_pct` (166 symbols, 3,222 rows)
- Coverage audit: 113/241 yahoo_annual symbols have ≥4 quarters (46.9%)
- Threshold: `OPM_STD_DEV_MAX_PCT = 5.0` in `quality-garp.ts`
- Distribution: median 2.33%, P75 4.21% — 5.0× is 1.7× median, not aggressive
- Implementation: `getTrailingOpmStdDev` in `queries.ts`, gate 11 in `evaluateQualityGarpSymbol`

---

## Shipped — Quality Decay Score gate (QDS, 2026-07-06)

**Gate added (gate 13):** 6-signal Piotroski-style Quality Decay Score (0–6) computed
from `quarterly_fundamentals` at screen time. Hard block at QDS ≤ 3 (P10 of distribution).
Soft warning at QDS = 4 (passes with `qds_warning: true` flag in matched criteria).
Fail-open when <5 quarters of data available. Bypassed entirely in CRISIS regime.

**Threshold calibration:**
- Audit script: `scripts/audit-qds-coverage.mts` — 131/241 symbols (54.4%) with ≥5 quarters
- Distribution: median 5, mean 4.66, P10 at score 3
- Hard block: ≤ 3 (blocks ~18.3% of scored = ~10% of total universe, matching OPM's P80 precedent)
- Soft warn: score = 4

**The 6 signals:**
| Signal | Condition | Data source |
|---|---|---|
| P1: Net profit positive | `net_profit_latest > 0` | `quarterly_fundamentals.net_profit` |
| P2: Net profit improving | `net_profit_latest > net_profit_4ago` | same |
| P3: OCF positive | `operating_cash_flow_latest > 0` | `quarterly_fundamentals.operating_cash_flow` |
| P4: OCF > Net profit | `ocf_latest > net_profit_latest` | same |
| P5: OPM improving | `opm_pct_latest > opm_pct_4ago` | `quarterly_fundamentals.opm_pct` |
| P6: Revenue improving | `revenue_latest > revenue_4ago` | `quarterly_fundamentals.revenue` |

**Implementation:** `getQualityDecayScore` in `src/db/queries.ts`, gate 13 in
evaluateQualityGarpSymbol, `qds`/`qds_warning`/`qds_skipped` funnel counters.

---

---

## Shipped — Regime-aware GARP thresholds (Item 1a, 2026-07-06)

**Architecture shipped (zero behaviour change):** `GarpThresholds` interface + `resolveGarpThresholds(regime?)` in
`quality-garp.ts`; all threshold constants threaded through `evaluateQualityGarpSymbol` via thresholds struct.
`regime_thresholds` persisted to `matched_criteria` JSON on every pass. 6 tests in
`tests/analysers/quality-garp-thresholds.test.ts` (all passing).

**CHOPPY branch returns existing constants** — production behaviour unchanged.

**Item 1b (calibration) deferred:** BULL/BEAR/CRISIS threshold values are placeholder hypotheses. Requires running
`pnpm cli fundamental-screen-audit` across 6 months of screen history segmented by regime before filling in real numbers.
Gate: ≥30 post-fix paper trades closed first (need enough BULL days to measure pass-rate sensitivity).

---

## Shipped — AI_PICK confidence rubric (shadow, 2026-07-07)

**Live (shadow):** `computeRubricTotal` expanded from 0–90 to 0–100 with a new `valuation` anchor scoring percentile rank vs own trailing P/E history, with PEG fallback. `AI_PICK_RUBRIC_MIN` moved 54→60 (same 60% ratio). `valuationBasis` (`'pe_percentile' | 'peg' | null`) recorded in `rubric_json.anchors` for calibration separation.

**4 gate-boundary preconditions** before `AI_PICK_RUBRIC_GATE` can flip from 0 to 1:

1. **Calibration cohort:** ≥ 30 shadow-logged theses with rubric totals for calibration.
2. **Fundamentals coverage:** < 30% of thesis candidates with `earningsTrajectory = null`.
3. **Stage-4 hard cap:** when the gate goes live, an AI_PICK with `weinstein_stage_code = 4` (Stage 4; `WEINSTEIN_STAGE.STAGE_4` constant) must be rejected regardless of `rubricTotal` — **GATING-CHANGE, do not build now**.
4. **Clean cohort boundary:** flip only at next BULL_TRENDING / GTT re-baseline.

---

## Shipped — ftinvstr cross-validation in briefing (Item 3, 2026-07-06)

**Live:** GARP screen passes annotated with `[ext: confirmed by DCF_Compounder_Stack]` when symbol appears in
`ext_signal_holdings` within a 3-day window. Ingest stage already runs daily. Graceful degradation when table empty.
Arch: briefing composer queries `ext_signal_holdings` directly — no writes to `screens.matched_criteria`.

**Active strategy:** `DCF_Compounder_Stack` only. Holdings verified 2026-07-06: TCS, INFY, ITC, BAJAJ-AUTO,
HDFCBANK, WIPRO — all large-cap liquid.

**HUNT2_FCF_Acceleration excluded permanently:** Holdings contained penny stocks (BESTAGRO ₹15.98, RAJMET ₹3.69,
KHANDSE ₹17.65) — verified 2026-07-05. Any new strategy addition requires manual `get_holdings` check first.
Trigger for next ext-signal review: 90 days (2026-09-28) or DCF_Compounder DD >15% from 2026-07-06 level.

---

**Backlog:**

### B-ENG-13: Infra — rebuild better-sqlite3 for Node 26

`quality-decay-score.test.ts` fails with `NODE_MODULE_VERSION 127 vs 147` because `better-sqlite3` was compiled
against Node 22. Fix: `pnpm rebuild better-sqlite3` on the dev machine (not the Oracle VM which stays on Node 22).
Not a logic bug — gate logic is correct, only test harness affected.

### B-ENG-14: Clean stale HUNT2 rows from ext_signal_holdings

```sql
DELETE FROM ext_signal_holdings WHERE strategy_name = 'HUNT2_FCF_Acceleration';
```

Run this before GARP starts passing symbols regularly (currently 0 passes/day in CHOPPY).
Stale July 3rd HUNT2 rows won't show in briefing today (GARP passed 0), but will when a
GARP symbol overlaps with HUNT2's prior holdings within the 3-day window.

### B-ENG-12: EPS momentum factor upgrade — REJECTED (2026-06-30)

Backtest result: quarterly-derived EPS growth (PR #134 audit branch)
underperformed the existing profit_growth_yoy annual proxy on momentum_mf.

| Metric        | Baseline (annual) | Quarterly EPS | Delta   |
|---------------|--------------------|--------------|---------|
| Total trades  | 651                | 639          | -12     |
| Hit rate      | 55.91%             | 56.34%       | +0.43pp |
| Avg return    | 2.10%              | 2.07%        | -0.03pp |
| Profit factor | 1.98               | 1.944        | -0.036  |

Root cause: 5-consecutive-non-null-quarter requirement for QoQ YoY
computation reduces effective coverage below the 63.3% headline EPS
coverage figure. Symbols without 5 quarters fall back to null →
z=0 neutral, diluting whatever genuine signal exists in the covered
subset. The annual profit_growth_yoy proxy, despite its known
staleness problem (Anomaly 6.2, original adversarial review),
is not displaced by this implementation.

Decision: keep profit_growth_yoy as Factor 2. Do not pursue further
without either (a) a denser EPS data source with full quarterly
coverage, or (b) a relaxed eligibility threshold (e.g. 3 quarters
instead of 5) — flagged as a possible future retry, not scheduled.

`getTrailingEpsGrowth` retained in src/db/queries.ts (unused) —
may be reusable for Earnings Reversal Play once estimate-revision
feed is available.

---

## Portfolio parity backlog (deferred ingest — 2026-06-28)

**Shipped (interpretability, no new ingest):** Weinstein stage/structure signals in technical enrich; portfolio cards + `trigger_reason` distinguish structural quality from ADD timing; held names without `mom_*` use stage signals as fallback context. Momentum sleeve cold-start rules unchanged.

**Shipped (2026-07-02):** Promoter pledge % ingest (`pledge` pipeline stage, NSE API → `promoter_pledge`); quality_garp gate 12 at 15% (**shadow** until `QUALITY_GARP_PLEDGE_GATE=1`); portfolio pledge flags gated same env (funnel `pledge_shadow` until boundary).

**Deferred (data coverage):**
- Concall / transcript ingest for management-tone enrichment
- Quarterly estimate-revision history for earnings-momentum logic (quarterly EPS now ingested via `quarterly_fundamentals.eps` — estimate-revision feed still needed)
- Sector-relative valuation aggregates
- In-app benchmark comparison (NIFTY 500 / SMLCAP vs portfolio) — parity with kite-portfolio Module 1

---

## Unbuilt Strategies

### 1. Earnings Reversal Play

**Category:** Stock picking + Quantitative | **Effort:** Medium | **Horizon:** Medium–long | **Build time:** 2–3 weeks
**Stack needed:** Historical quarterly EPS data (now partially ingested via `quarterly_fundamentals.eps` — estimate-revision feed still needed for consensus beats/misses)

**Entry signals:**

- Beat consensus EPS 2+ consecutive quarters
- After 2+ consecutive miss quarters (the turnaround signal)
- Analyst estimates still below management guidance
- Stock still trading near 52-week lows

**Lifecycle:** Enter after second consecutive beat. Hold 2–4 quarters. Exit if next quarter misses again.

**AI role:** Read last two concall transcripts. Classify as genuine turnaround vs one-off. Identify what management says
changed operationally.

**Notes:** Partial data now available via `quarterly_fundamentals.eps` (Screener.in quarterly table). Full implementation still needs estimate-revision feed for consensus beat/miss signals and Concall Intelligence Engine (item 5 below) for qualitative turnaround confirmation. Progress from "blocked" to "needs one more data source".

---

### 2. Sector Rotation

**Category:** Stock picking + Quantitative + AI | **Effort:** Hard | **Horizon:** Medium | **Build time:** 3–4 weeks
**Stack needed:** Sector-level price series (derivable from `quotes` + `symbols.sector`), FII sector-level flow data (
not currently ingested)

**Entry signals:**

- Sector RS vs Nifty 50 turning positive after 3+ months underperformance
- FII flows rotating into sector (sector-level, not aggregate)
- Breadth within sector: > 60% of stocks above SMA50
- Macro alignment: rate cycle, commodity cycle, government capex direction

**Lifecycle:** Buy top 2–3 stocks in rotating sector. Hold until sector RS turns negative. Stop: −6% from entry.

**AI role:** Cross-reference sector rotation with macro context. Explain why this sector should outperform now.

**Notes:** Sector-level FII data is not in current ingest pipeline — would need NSE sector index data or a proxy.
`symbols.sector` exists but coverage may be incomplete. Most complex build on the list.

---

### 3. Concall Intelligence Engine

**Category:** Stock picking + AI | **Effort:** Medium | **Horizon:** Long-term alpha enrichment | **Build time:** 2–3
weeks
**Stack needed:** Concall PDF source — BSE filing scraper or Screener.in (not currently ingested)

**Signals extracted:**

- Management tone shift: more hedging language than last quarter (flag)
- Confident language: "record", "unprecedented", "strong pipeline" (positive)
- Guidance delta: raised / maintained / lowered (quantify)
- Analyst question themes: what sell-side is most concerned about

**Lifecycle:** Not a direct entry signal — enriches thesis quality. HOLD → ADD upgrades should reference concall tone as
supporting signal.

**AI role:** Core AI task. Read 8–12 pages of dense financial language, extract 5 things that matter, compare tone to
last quarter. Feeds into thesis_json in `screens` and `theses` tables.

**Notes:** Already listed as deferred in architecture-v2.md. Unblocks Earnings Reversal Play (item 3) for full quality.
High alpha potential, medium data engineering effort.

---

### 4. Dynamic Position Sizer

**Category:** Position lifecycle | **Effort:** Easy | **Horizon:** Ongoing / portfolio-wide | **Build time:** 1 week
**Stack needed:** ATR from `signals` table (present) + portfolio value from Kite (present)

**Sizing rules:**

- Initial size = (portfolio × 1%) ÷ (ATR14 × 2)
- Add tranche when +1 ATR in favour (conviction add)
- Trim tranche when RSI > 75 or price +15% in < 10 days
- Hard cap: no single stock > 5% of portfolio

**Lifecycle:** Governs every other strategy's entry/exit size automatically. Plugs into GTT module.

**AI role:** Daily flag any position where size has drifted above 5% due to price appreciation. Suggest trim qty.

**Notes:** Initial vol-target sizing **shipped** (2026-07-02): `position_weight_pct` on insert, book from Kite holdings, cross-sleeve sector cap. Add-tranche/trim lifecycle and GTT wiring remain deferred.

---

## Build Priority Order (updated 2026-07-06)

| Priority | Item                                           | Status                  | Blocker / Next action                                        |
|----------|------------------------------------------------|-------------------------|--------------------------------------------------------------|
| 1        | Quality-GARP v3 (QDS + regime thresholds)      | **Shipped** (PRs 144/151/152) | Item 1b calibration after 30+ post-fix closed trades    |
| 2        | Infra: `pnpm rebuild better-sqlite3` (Node 26) | **Needed now**          | Test suite failures (B-ENG-13)                               |
| 3        | Clean stale HUNT2 rows                         | **Needed now**          | `DELETE FROM ext_signal_holdings WHERE strategy_name='HUNT2_FCF_Acceleration'` (B-ENG-14) |
| 4        | Pledge gate activation (`QUALITY_GARP_PLEDGE_GATE=1`) | **Shadow mode** | Wait for ≥30 post-fix closed trades + BULL_TRENDING cycle |
| 5        | Catalyst-Driven Entry v2 (trading-session hold) | **Backlog**            | Calendar-day hold → trading-session count via `quotes`       |
| 6        | Item 1b: regime threshold calibration          | **Blocked**             | Need 30+ post-fix trades, 6-mo screen history audit by regime |
| 7        | ftinvstr Slot 6 backtest (Aug)                 | **Reserve**             | Do not spend until August; see IMPLEMENTATION-PLAN.md        |
| 8        | Dynamic Position Sizer (add-tranche/GTT wiring) | **Partial**            | Vol-target sizing shipped; GTT wiring after GTT gate opens   |
| 9        | Concall Intelligence Engine                    | **Blocked**             | BSE/Screener PDF scraper needed                              |
| 10       | Earnings Reversal Play                         | **Blocked**             | Quarterly EPS + estimate-revision feed + concall engine      |
| 11       | Sector Rotation                                | **Blocked**             | Sector-level FII flow data source                            |