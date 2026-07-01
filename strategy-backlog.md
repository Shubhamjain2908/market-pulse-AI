# Strategy Backlog — Market Pulse AI

**Gate:** No strategy moves to implementation until overall paper trade expectancy is positive over 30+ deduped closed
trades. Currently NOT met.

**Built:** Market Regime Filter · Adaptive Trailing Stop · Multi-Factor Momentum (momentum_mf) · Quality-GARP (`quality_garp`, v2) · Catalyst-Driven Entry (`catalyst_entry`, v1)

**Fundamentals backfill:** COMPLETE (2026-06-06). 241 symbols annual, Yahoo snapshot + screener refresh via `pnpm fundamentals:refresh`. **Quarterly fundamentals** backfill COMPLETE (2026-06-29): `revenue`, `operating_profit`, `opm_pct`, `net_profit`, `eps`, `operating_cash_flow`, `free_cash_flow` from Screener.in `#quarters` + `#cash-flow` tables for 166 symbols (3,222 rows). Backfill: `pnpm backfill:quarterly`.

---

## Shipped — Quality-GARP (v2, 2026-06-06)

**Live:** `quality_garp` dispatcher in [`stock-screener.ts`](src/analysers/stock-screener.ts) + [`getQualityGarpFundamentals`](src/db/queries.ts) (yahoo annual ×3 + snapshot/screener coalesce + promoter join). Gates: PE≤35, PB≤6, **3yr ROE≥18%**, **ROCE≥20%**, **D/E<0.5**, **PEG<1.2**, RSI<45, within 5% of SMA50, no promoter selling; ETF exclusion; regime **BULL 1.0× / CHOPPY 0.75×**. Refresh: `pnpm fundamentals:refresh`. README: [Quality-GARP screener](README.md#quality-garp-screener).

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

**Backlog:**

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

**Shipped (2026-07-02):** Promoter pledge % ingest (`pledge` pipeline stage, NSE API → `promoter_pledge`); quality_garp gate 12 at 15% (**shadow** until `QUALITY_GARP_PLEDGE_GATE=1`); portfolio pledge flags shadow-annotated (no TRIM escalation until gate on).

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

## Build Priority Order (updated 2026-06-30)

| Priority | Strategy                                | Status             | Blocker                                     |
|----------|-----------------------------------------|--------------------|---------------------------------------------|
| 1        | Quality-GARP v2 (OPM gate)                 | **Shipped v3**  | —                                           |
| 2        | Catalyst-Driven Entry (v2: session hold) | **Shipped v1**     | Calendar-day hold → trading-session count   |
| 3        | yahoo_snapshot daily refresh monitoring | Operational        | Watch 429 rate first week                   |
| 4        | Dynamic Position Sizer                  | **In build**       | Weights stamped on insert; GTT reads unweighted until cohort flip |
| 5        | Concall Intelligence Engine             | Blocked            | BSE/Screener PDF scraper needed             |
| 6        | Earnings Reversal Play                  | Blocked            | Quarterly EPS data + concall engine         |
| 7        | Sector Rotation                         | Blocked            | Sector-level FII flow data source           |