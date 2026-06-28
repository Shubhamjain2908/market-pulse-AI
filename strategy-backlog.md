# Strategy Backlog — Market Pulse AI

**Gate:** No strategy moves to implementation until overall paper trade expectancy is positive over 30+ deduped closed
trades. Currently NOT met.

**Built:** Market Regime Filter · Adaptive Trailing Stop · Multi-Factor Momentum (momentum_mf) · Quality-GARP (`quality_garp`, v2) · Catalyst-Driven Entry (`catalyst_entry`, v1)

**Fundamentals backfill:** COMPLETE (2026-06-06). 241 symbols annual, Yahoo snapshot + screener refresh via `pnpm fundamentals:refresh`.

---

## Shipped — Quality-GARP (v2, 2026-06-06)

**Live:** `quality_garp` dispatcher in [`stock-screener.ts`](src/analysers/stock-screener.ts) + [`getQualityGarpFundamentals`](src/db/queries.ts) (yahoo annual ×3 + snapshot/screener coalesce + promoter join). Gates: PE≤35, PB≤6, **3yr ROE≥18%**, **ROCE≥20%**, **D/E<0.5**, **PEG<1.2**, RSI<45, within 5% of SMA50, no promoter selling; ETF exclusion; regime **BULL 1.0× / CHOPPY 0.75×**. Refresh: `pnpm fundamentals:refresh`. README: [Quality-GARP screener](README.md#quality-garp-screener).

**v2 backlog (deferred):** `operating_margin_pct` column + OPM stability gate; Dec-FY `as_of` edge cases.

---

## Shipped — Catalyst-Driven Entry (v1, 2026-05-28)

**Live:** `catalyst_entry` screen + [`catalyst-screener.ts`](src/analysers/catalyst-screener.ts); earnings 5–14 days out; `close > sma_50` OR within 15% of 52W low; `BULL_TRENDING` gate only; thesis catalyst block + **confidence ≤ 6**; `paper_trades` `stop_type='fixed'` at 96%/108%; `max_hold_days = days_to_earnings + 2` (**calendar** days). README: [Catalyst-driven entry](README.md#catalyst-driven-entry-pre-earnings).

**v2 backlog:** analyst estimate revision feed; concall keyword triggers; sector-event proximity; trading-session `max_hold_days` from `quotes` (fixes holiday/weekend early `TIME_EXIT`).

---

## Portfolio parity backlog (deferred ingest — 2026-06-28)

**Shipped (interpretability, no new ingest):** Weinstein stage/structure signals in technical enrich; portfolio cards + `trigger_reason` distinguish structural quality from ADD timing; held names without `mom_*` use stage signals as fallback context. Momentum sleeve cold-start rules unchanged.

**Deferred (data coverage):**
- Promoter pledge % ingest + guardrail
- Concall / transcript ingest for management-tone enrichment
- Quarterly EPS / estimate-revision history for earnings-momentum logic
- Sector-relative valuation aggregates
- In-app benchmark comparison (NIFTY 500 / SMLCAP vs portfolio) — parity with kite-portfolio Module 1

---

## Unbuilt Strategies

### 1. Earnings Reversal Play

**Category:** Stock picking + Quantitative | **Effort:** Medium | **Horizon:** Medium–long | **Build time:** 2–3 weeks
**Stack needed:** Historical quarterly EPS data — needs Tickertape API or Screener scraping (NOT currently ingested)

**Entry signals:**

- Beat consensus EPS 2+ consecutive quarters
- After 2+ consecutive miss quarters (the turnaround signal)
- Analyst estimates still below management guidance
- Stock still trading near 52-week lows

**Lifecycle:** Enter after second consecutive beat. Hold 2–4 quarters. Exit if next quarter misses again.

**AI role:** Read last two concall transcripts. Classify as genuine turnaround vs one-off. Identify what management says
changed operationally.

**Notes:** Blocked on data — no historical quarterly EPS series in current stack. Dependency on Concall Intelligence
Engine (item 5 below) for full signal quality. Lowest priority until data source resolved.

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

**Notes:** Prerequisite: GTT Execution Module must be active first. GTT gate is currently closed (expectancy negative).
This is the natural next build *after* GTT activates. All data dependencies already present.

---

## Build Priority Order (updated 2026-05-28)

| Priority | Strategy                                | Status             | Blocker                                     |
|----------|-----------------------------------------|--------------------|---------------------------------------------|
| 1        | Quality-GARP v2 (OPM gate)                 | **Shipped v2**  | operating_margin_pct migration; Dec-FY as_of edge cases     |
| 2        | Catalyst-Driven Entry (v2: session hold) | **Shipped v1**     | Calendar-day hold → trading-session count   |
| 3        | yahoo_snapshot daily refresh monitoring | Operational        | Watch 429 rate first week                   |
| 4        | Dynamic Position Sizer                  | Waiting            | GTT gate must be active first               |
| 5        | Concall Intelligence Engine             | Blocked            | BSE/Screener PDF scraper needed             |
| 6        | Earnings Reversal Play                  | Blocked            | Quarterly EPS data + concall engine         |
| 7        | Sector Rotation                         | Blocked            | Sector-level FII flow data source           |