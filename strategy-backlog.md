# Strategy Backlog — Market Pulse AI

**Gate:** No strategy moves to implementation until overall paper trade expectancy is positive over 30+ deduped closed trades. Currently NOT met.

**Built:** Market Regime Filter · Adaptive Trailing Stop · Multi-Factor Momentum (momentum_mf)

---

## Unbuilt Strategies

### 1. Catalyst-Driven Entry
**Category:** Stock picking + AI | **Effort:** Easy | **Horizon:** Short–medium | **Build time:** 1–2 weeks
**Stack needed:** Earnings calendar + news ingestor — both already present

**Entry signals:**
- Earnings date within 5–14 days
- Analyst estimate revision > 3% up or down
- Concall keyword trigger ("order inflow", "guidance raise")
- Sector event proximity (RBI policy, budget day)

**Lifecycle:** Enter 3–5 days before catalyst. Exit within 2 days post-event. Stop: −4% from entry.

**AI role:** Summarise what consensus expects, flag if setup is contrarian. 2-sentence entry thesis.

**Notes:** Earnings blackout logic already exists in momentum_mf (±3 days block). Catalyst entry is the inverse — enter *because* of the upcoming event. Reuse `earnings_calendar` table. Low data dependency, highest priority to build once gate is met.

---

### 2. Quality-GARP Screener
**Category:** Stock picking + Quantitative | **Effort:** Medium | **Horizon:** Long (6–18 months) | **Build time:** 2 weeks
**Stack needed:** `fundamentals` table (already populated via Screener.in)

**Entry signals:**
- ROE > 18% for 3 consecutive years
- Revenue CAGR > 15% (3-year)
- Operating margin stable or expanding
- PEG < 1.2 (forward earnings)
- Promoter holding stable or increasing

**Lifecycle:** Enter on technical dip (RSI < 45, near SMA50). Hold 6–18 months. TRIM at 2× entry. EXIT if quarterly earnings disappoint 2 consecutive times.

**AI role:** Compare to sector peers on every metric. Identify the moat — what makes this company's margin profile sustainable.

**Notes:** Requires 3-year fundamental time-series. `fundamentals` table has `as_of` dating — verify depth before building. No new data source needed if history is sufficient.

---

### 3. Earnings Reversal Play
**Category:** Stock picking + Quantitative | **Effort:** Medium | **Horizon:** Medium–long | **Build time:** 2–3 weeks
**Stack needed:** Historical quarterly EPS data — needs Tickertape API or Screener scraping (NOT currently ingested)

**Entry signals:**
- Beat consensus EPS 2+ consecutive quarters
- After 2+ consecutive miss quarters (the turnaround signal)
- Analyst estimates still below management guidance
- Stock still trading near 52-week lows

**Lifecycle:** Enter after second consecutive beat. Hold 2–4 quarters. Exit if next quarter misses again.

**AI role:** Read last two concall transcripts. Classify as genuine turnaround vs one-off. Identify what management says changed operationally.

**Notes:** Blocked on data — no historical quarterly EPS series in current stack. Dependency on Concall Intelligence Engine (item 5 below) for full signal quality. Lowest priority until data source resolved.

---

### 4. Sector Rotation
**Category:** Stock picking + Quantitative + AI | **Effort:** Hard | **Horizon:** Medium | **Build time:** 3–4 weeks
**Stack needed:** Sector-level price series (derivable from `quotes` + `symbols.sector`), FII sector-level flow data (not currently ingested)

**Entry signals:**
- Sector RS vs Nifty 50 turning positive after 3+ months underperformance
- FII flows rotating into sector (sector-level, not aggregate)
- Breadth within sector: > 60% of stocks above SMA50
- Macro alignment: rate cycle, commodity cycle, government capex direction

**Lifecycle:** Buy top 2–3 stocks in rotating sector. Hold until sector RS turns negative. Stop: −6% from entry.

**AI role:** Cross-reference sector rotation with macro context. Explain why this sector should outperform now.

**Notes:** Sector-level FII data is not in current ingest pipeline — would need NSE sector index data or a proxy. `symbols.sector` exists but coverage may be incomplete. Most complex build on the list.

---

### 5. Concall Intelligence Engine
**Category:** Stock picking + AI | **Effort:** Medium | **Horizon:** Long-term alpha enrichment | **Build time:** 2–3 weeks
**Stack needed:** Concall PDF source — BSE filing scraper or Screener.in (not currently ingested)

**Signals extracted:**
- Management tone shift: more hedging language than last quarter (flag)
- Confident language: "record", "unprecedented", "strong pipeline" (positive)
- Guidance delta: raised / maintained / lowered (quantify)
- Analyst question themes: what sell-side is most concerned about

**Lifecycle:** Not a direct entry signal — enriches thesis quality. HOLD → ADD upgrades should reference concall tone as supporting signal.

**AI role:** Core AI task. Read 8–12 pages of dense financial language, extract 5 things that matter, compare tone to last quarter. Feeds into thesis_json in `screens` and `theses` tables.

**Notes:** Already listed as deferred in architecture-v2.md ("Concall Intelligence Engine — BSE PDF scraper + transcript analysis"). Unblocks Earnings Reversal Play (item 3) for full quality. High alpha potential, medium data engineering effort.

---

### 6. Dynamic Position Sizer
**Category:** Position lifecycle | **Effort:** Easy | **Horizon:** Ongoing / portfolio-wide | **Build time:** 1 week
**Stack needed:** ATR from `signals` table (present) + portfolio value from Kite (present)

**Sizing rules:**
- Initial size = (portfolio × 1%) ÷ (ATR14 × 2)
- Add tranche when +1 ATR in favour (conviction add)
- Trim tranche when RSI > 75 or price +15% in < 10 days
- Hard cap: no single stock > 5% of portfolio

**Lifecycle:** Governs every other strategy's entry/exit size automatically. Plugs into GTT module.

**AI role:** Daily flag any position where size has drifted above 5% due to price appreciation. Suggest trim qty.

**Notes:** Prerequisite: GTT Execution Module must be active first. GTT gate is currently closed (expectancy negative). This is the natural next build *after* GTT activates. All data dependencies already present — lowest friction build on the list once gate opens.

---

## Build Priority Order (when gate opens)

| Priority | Strategy | Blocker |
|---|---|---|
| 1 | Dynamic Position Sizer | GTT gate must be active |
| 2 | Catalyst-Driven Entry | None — data already present |
| 3 | Quality-GARP Screener | Verify `fundamentals` history depth |
| 4 | Concall Intelligence Engine | BSE/Screener PDF scraper needed |
| 5 | Earnings Reversal Play | Needs quarterly EPS data + concall engine |
| 6 | Sector Rotation | Needs sector FII flow data source |
