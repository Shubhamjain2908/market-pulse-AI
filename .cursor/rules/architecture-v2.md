## Market Pulse AI — State of the Union
---

## 1. Core Stack & Philosophy
**Runtime:** Node.js 22 + TypeScript (ESM), `better-sqlite3`, `croner`, PM2 for process management

**Broker:** Zerodha Kite Connect API — portfolio sync, GTT orders (manual trigger only). Daily OAuth token expires ~6 AM IST. **Auto-refresh:** Playwright + TOTP at **08:30 IST Mon–Fri** on the Oracle VM (PM2 `kite-auth` cron) when redirect URL is colocated with the auth server. **Manual fallback:** `pnpm kite-login` or `https://[duckdns]/auth/kite` before the **08:45** pipeline if auto-login fails.

**LLM:** Currently DeepSeek-V3 via OpenAI-compatible SDK (`baseURL: https://api.deepseek.com`). Provider abstraction in `src/llm/provider.ts` — switchable via `LLM_PROVIDER` env var (`anthropic` | `deepseek` | `gemini` | `openai`). All LLM calls go through `generateJson()` with Zod schema validation + 1 retry on parse failure.

**Data:** NSE public JSON endpoints + Yahoo Finance (EOD). India VIX from NSE index feed. News via ET Markets + Moneycontrol RSS. Benchmark symbol: `NIFTY_50` (canonical, from `src/market/benchmarks.ts`).

**Deployment:** Oracle Cloud Always Free VM (`VM.Standard.E2.1.Micro`, 1 OCPU, ap-hyderabad-1). SQLite file on persistent disk. Nginx reverse proxy for Kite auth endpoint. DuckDNS free subdomain for HTTPS.

**Pipeline schedule:**
- `8:30 AM IST Mon–Fri` — Kite OAuth auto-login (PM2 `kite-auth`; fail-open — logs only, pipeline still runs at 08:45)
- `8:45 AM IST Mon–Fri` — full daily pipeline (PM2 `market-pulse` / `cli schedule`)
- `8:00 AM IST Sunday` — momentum rebalance job
- `10:15 AM IST Mon–Fri` — healthcheck cron (email alert on failure)

**Philosophy:**
- Every strategy gated by Regime Filter before firing
- ATR-based trailing stops replace static stops
- Signal quality measured empirically via paper trades ledger
- No hallucinated financials — LLM output grounded in provided data only
- Positive expectancy over 30+ closed trades required before GTT activation
- SEBI-compliant: AI is research assistant only, all orders placed manually

---

## 2. Pipeline Flow (Sequential, EOD, Daily 8:45 AM IST)

```
Ingest → Corporate actions → Enrich → Yahoo snapshot → Momentum rank → External signals → NSE ETF iNAV → Regime Classify → Screen → AI Thesis → Portfolio Evaluate → Briefing
```

Orchestration: `src/agents/daily-workflow.ts` (weekday path). Paper trade evaluation runs **before** the briefing composer so closed trades appear in the brief.

**Pipeline audit (`pipeline_runs`, migration `0022`):** Most stages in `daily-workflow.ts` append `started` / `success` / `failed` / `skipped` through `runStage` in `src/agents/stage-runner.ts`, which delegates persistence to `recordPipelineStage` in `src/db/pipeline-queries.ts`. Fail-open stages (portfolio sync, corporate actions, Yahoo snapshot, **momentum-rank**, ext-signal, iNAV, Sunday earnings) log `failed` but do not abort; fatal stages rethrow. Stage names match the table (`ingest`, `enrich`, `regime`, `screen`, `evaluate`, `briefing`, etc.). `getPipelineHealth(run_date)` uses the **latest row per stage** (`ROW_NUMBER` over `id DESC`) for **`enrich`**, **`regime`**, **`screen`** — a successful retry on the same `run_date` clears degraded mode and controls whether the degraded briefing may still show the regime card.

| Stage | File | What it does |
|---|---|---|
| **Ingest** | `src/agents/daily-ingestor.ts` | Directly wires Yahoo/NSE/RSS/Screener ingestors for the fixed free tier; failures per capability are logged and do not abort the run. |
| **Corporate actions** | `src/ingestors/corporate-actions.ts` | After ingest, before enrich: for symbols with OPEN `paper_trades`, pull Yahoo split events (`chart`, `events: 'split'` — same ratios as bonus-as-split). Last 5 IST calendar days → `corporate_actions` row + divide OPEN notionals (`entry_price`, `stop_loss`, `target`, `highest_close_since_entry`, `atr14_at_entry`); append one-time SPLIT audit to `trailing_stop_log.notes` per trade. Idempotent via `INSERT OR IGNORE` + `run().changes`. |
| **Enrich** | `src/enrichers/technical.ts` + `momentum-signals.ts` | SMA20/50/200, EMA9/21, RSI14, ATR14, Volume Ratio, 52W High/Low%. Plus daily momentum factors: `mom_12_1_return`, `mom_relative_strength_ba`, `mom_volume_breakout_flag`. |
| **Yahoo snapshot** | `src/ingestors/yahoo-snapshot-ingestor.ts` | After enrich: batched `quoteSummary` valuation fields → `fundamentals` (`source = yahoo_snapshot` on insert; `ON CONFLICT` updates valuation columns only, preserving screener-owned fields and existing `source`). Fail-open. Records `{ attempted, written, failed }` into `pipeline_runs.metadata`; query trailing window via `pnpm cli snapshot-health` (default 7 days). |
| **Momentum rank** | `src/rankers/momentum-ranker.ts` | After Yahoo snapshot, before thesis context: refreshes `mom_rank`, `mom_composite_score`, and `mom_false_flag` for `config/momentum-universe.json`. Fail-open; weekly `momentum_mf` rebalance remains separately scheduled/gated. |
| **External signal holdings** | `src/ingestors/ext-signal-holdings-ingestor.ts` | After momentum rank, before regime: JSON-RPC `get_holdings` with `{ strategy_name }` per strategy in `config/ext-signal-provider.json` → `ext_signal_holdings`. ftInvstr MCP returns `{ data: { positions } }` (flat `{ positions }` still supported via `unwrapHoldingsPayload`). Skipped when `enabled: false`, `EXT_SIGNAL_ENDPOINT` unset, or `EXT_SIGNAL_API_KEY` unset. Diagnostics: `pnpm cli ext-signal-smoke`, `pnpm cli ext-signal-cross-ref`. Read by thesis generator (optional context) and cross-ref script. Fail-open. |
| **ETF iNAV** | `src/ingestors/inav-fetcher.ts` | After external signals, before regime: NSE `/api/etf` → `inav_snapshots` for symbols in `config/etf-exclusions.json`. Fail-open (warn + skip on NSE failure). |
| **COMEX gold COT** | `src/cot/fetch-gold-cot.ts`, `scripts/cot-gold-fetch.ts` | Weekly CFTC `f_disagg.txt` → `cot_gold`; Sunday 07:45 IST cron + `pnpm cot:gold`. Regime briefing line when crowded long/short only. |
| **Regime Classify** | `src/agents/regime-agent.ts` | 8 signals scored −2 to +2. 3-day persistence. CRISIS fires immediately. **Quorum:** refuses `regime_daily` write when any of five required inputs is null (Nifty vs SMA200, SMA200 slope, VIX, FII 20d, % above SMA200). Runs before all strategies. |
| **Weekly cleanup** | `src/agents/weekly-cleanup.ts` | Sunday 07:30 IST: prune `briefings` &gt; 90d, `signals` &gt; 730d. Fail-open (logged; does not block rebalance). |
| **Screen** | `src/analysers/stock-screener.ts` | Loads `config/screens.json`. DSL screens via `engine.ts`; **`quality_garp`** and **`catalyst_entry`** use dedicated dispatchers (`getQualityGarpFundamentals` + **13 gates** including OPM stability, pledge shadow, and QDS; `runCatalystScreener`). Checks `regime_strategy_gate`. Writes passing symbols to `screens`. Gates 4/9/10/11 are **regime-aware** via `resolveGarpThresholds(regime)` in `quality-garp.ts`. |
| **AI Thesis** | `src/agents/thesis-generator.ts` | Candidate pool: today's `screens` hits ∪ watchlist, minus holdings and OPEN `paper_trades`. Ranks by enriched signals + screen/alert matches; sends technicals + fundamentals + news + regime context to LLM. Parallel via `p-limit` (`THESIS_CONCURRENCY`, default 3). |
| **Concall fetch** | `src/ingestors/nse/announcements-fetcher.ts` | After pledge, before enrich: fail-open pipeline stage `concall-fetch`. For holdings ∪ open paper trades ∪ watchlist, fetches NSE corporate announcements (`from_date`/`to_date` bounded), filters to concall transcript PDFs, downloads via `got` (no cookies needed on `nsearchives.nseindia.com`), extracts text via `unpdf`, inserts into `concall_transcripts`. Skips PDFs with <2000 chars (likely image-only). Gated by `CONCALL_ANALYSIS_ENABLED='1'` (default). Never throws — returns result counters. |
| **Concall analysis** | `src/agents/concall-analyser.ts` | After thesis, before portfolio review: fail-open pipeline stage `concall-analysis` (skipped with `--skip-ai` or market-closure mode). For each unanalysed transcript with extracted text ≥2000 chars, calls LLM with `ConcallIntelSchema` zod-validation. Passes prior concall intel for delivery tracking. Uses `p-limit` with `THESIS_CONCURRENCY`, respects `src/llm/budget.ts`. Gated by `CONCALL_ANALYSIS_ENABLED='1'`. Never throws. |
| **Portfolio review** | `src/agents/portfolio-sync.ts` + `portfolio-analyser.ts` | When AI is enabled and portfolio is not skipped: after thesis, optional Kite sync feeds `portfolio_holdings`. Analyser partitions **allocation instruments** (`etf-exclusions.json` → `model='none'` carry rows) vs **equity** (lite snapshot or full LLM with regime context + invested-book concentration). **Structural layer:** technical enrich writes Weinstein stage signals; `portfolio-structure.ts` + `portfolio-trigger.ts` format `quality_bias` / `timing_state` separately from `action`. Post-LLM guardrails: strategy rules, technical TRIM escalation, concentration TRIM (15% hard), universal QG deterioration (unknown → TRIM-only). Stale Kite snapshots → `STALE_HOLDINGS` placeholders. |
| **Portfolio Evaluate** | `src/scripts/evaluate-trades.ts` | Runs SL/TP/time-stop on OPEN `paper_trades` (multi-bar walk vs `quotes`). `stop_type='trailing'` follows adaptive ATR trailing; `stop_type='fixed'` bypasses trailing math/logs and evaluates stops/targets at static levels. New bars only after the latest non-`STOPPED_OUT` `trailing_stop_log` row (exclusive `source_date` bound via `getSymbolBars`), so a raised persisted stop is not replayed against already-evaluated history. **Gap-down CB:** if `bar.open < 0.7 ×` prior NSE `close` (`getPrevClose`), skip stop-out and target for **that bar only**; structured `CIRCUIT BREAKER` log includes recent `corporate_actions` flag (`hasCorporateActionInRange`). **Gap-up CB:** if `bar.open > 1.3 ×` prior close, suppress `highest_close_since_entry` update for that bar (stop/target still run); mitigates fake highs after post-resolution gaps. Day-1 ATR latch snaps `sourceDate` via `nextOpenOnOrAfter` when it falls on a non-session day. |
| **Briefing** | `src/briefing/composer.ts` | Records `briefing` / `started` first, then reads `getPipelineHealth` (latest status per required stage). Normal path: `renderBriefing()` → `juice()` for Gmail-safe inline CSS (600px table layout). Regime card + change banner; **FII/DII flow attribution**; **ETF iNAV pricing** block for held ETFs (`etf-pricing-card.ts`, WARN/NOTE thresholds). **Degraded path:** partial-pipeline banner listing failed required stages; screens / AI picks / portfolio / momentum omitted. **`brief --skip-ai`:** skips mood LLM; still shows persisted `theses` when present (`resolveAiPicksStatus` checks thesis count before skip flag). Delivered via Nodemailer → Gmail SMTP (`delivered_at` persisted only after ≥1 SMTP recipient accepted). |

NOTE: Fundamentals refresh is operational via `pnpm fundamentals:refresh` (Python annual + screener + Yahoo snapshot; see §3.5).

---

## 3. Completed Extension Modules

### 3.1 Market Regime Filter

**Four states:**

| Label | Score | Strategy mode |
|---|---|---|
| `BULL_TRENDING` | ≥ +2 | All strategies active, full size |
| `CHOPPY` | −2 to +1 | Momentum gated; others 50–75% size |
| `BEAR_TRENDING` | ≤ −3 | EXIT/defensive signals only |
| `CRISIS` | VIX > 28 OR Nifty gap < −3% | All entries paused immediately |

**8 input signals** (each −2 to +2): Nifty % vs SMA200, SMA200 slope (10d), VIX level, VIX 5d change, FII 20d rolling net, FII 5d trend, Advance-Decline ratio, % NSE500 above SMA200.

**3-day persistence:** Regime change requires 3 consecutive days at new band. CRISIS exception: fires immediately, requires 5 days to clear.

**Regime quorum (safety):** Before scoring, `prepareRegimeDaily` validates five required signal fields are non-null. Missing data throws — `regime` pipeline stage fails; no silent null-as-zero scoring.

**Current state (May 14):** BEAR_TRENDING Day 4. Score −7.0. FII −3.0, Breadth −4.0. 5 of 11 strategies active.

**Strategy gate table:** `regime_strategy_gate(strategy_id, regime, allowed, size_multiplier)`. Momentum_mf: BULL_TRENDING only.

**Gate lookup (fail-closed):** [`isStrategyAllowed`](src/db/regime-queries.ts) returns **false** when no row exists for `(strategy_id, regime)` — missing seed data must not allow strategies through. Run `pnpm regime:seed-gates` after migrate.

### 3.2 Adaptive Trailing Stop

**Core math:**
```
# All paths read position_sizing from momentum-config.json via trailing-stop-sizing.ts:
#   atr_multiplier 2.5, lock_in_threshold_pct 18, tightened_multiplier 1.5

initial_stop = MAX(hard_floor, entry_price − atr_multiplier × ATR14_at_entry)  # hard_floor = entry × 0.92
day1_stop    = MAX(llm_stop, entry − atr_multiplier × ATR14_at_entry)       # evaluate-trades day-1 latch; ATR14_at_entry from getAtr14(symbol, nextOpenOnOrAfter(sourceDate) ?? sourceDate)

unrealised_pct = ((highest_close_since_entry − entry_price) / entry_price) × 100
multiplier = (unrealised_pct ≥ lock_in_threshold_pct OR already_tightened_band)
  ? tightened_multiplier : atr_multiplier
# Legacy DB trailing_multiplier 2.0 → initial band (2.5); 1.5 → tightened band
candidate_stop = highest_close_since_entry − (multiplier × ATR14_today)

new_stop = MAX(candidate_stop, current_stop_loss)  // GOLDEN RULE — never moves down
```

**Gap-down fill ruling (global, all signal types):**
```typescript
exit_price = bar.open < stop_loss ? bar.open : stop_loss
// Never record theoretical stop when open gaps through it
```

**7-step EOD evaluation order (strict, never resequence):**
1. Reset `stop_raised_today = 0` for all OPEN trades
2. Fetch today's OHLCV + ATR14
3. Update `highest_close_since_entry = MAX(prev, today_close)` *(skipped when gap-up CB fires — see below; persist the real watermark `highestClose`, not the stop-math fallback)*
4. Run `computeNewStop()` → golden rule → persist if raised
5. Stop-out check: `today_low ≤ updated_stop` → close trade *(skipped for the bar when the gap-down circuit breaker fires — see below)*
6. Target check: `today_close ≥ target` → close as `TARGET_HIT` *(gap-down skip only; gap-up CB does **not** skip target)*
7. Persist all changes

**Prior close lookup:** `getPrevClose(symbol, bar.date)` in `src/db/queries.ts` — latest NSE `close` with `date < bar.date`. Shared by both circuit breakers.

**Gap-down circuit breaker (code, per bar):** After hard floor, before SL/TP: if prior NSE `close` exists and `open < 0.7 × that close`, do not run stop-out or target for that bar; max-hold and persistence still run. Mitigates false stop-outs on extreme opens (e.g. around corporate events). Recent `corporate_actions` in a 5-day lookback window are flagged in the log via `hasCorporateActionInRange`.

**Gap-up circuit breaker (code, per bar):** At step 3, before updating `highest_close_since_entry`: if prior NSE `close` exists and `open > 1.3 × that close`, skip the watermark update for that bar; downstream stop math uses the prior watermark (or `entry_price` when unset). Stop-out, target, and persistence still run — a genuine gap-up to target remains a valid `TARGET_HIT`.

**Hard stop for momentum_mf:** −8% floor from entry. `effectiveStop = MAX(computedNewStop, entry × 0.92)`. Trailing stop cannot trail below this floor.

**Exit reasons:** `TRAILING_STOP | INITIAL_STOP | TARGET_HIT | TIME_EXIT | MANUAL`

**Audit table:** `trailing_stop_log` — append-only, `UNIQUE(trade_id, log_date, action)`. Split/bonus adjustments append a one-time `SPLIT …` note (guarded by `notes NOT LIKE '%SPLIT%'`). **`corporate_actions`** — one row per applied `(symbol, ex_date, type)`; source of truth for “CA applied recently” in circuit-breaker logs.

### 3.3 Paper Trades Ledger

**Signal types currently active:**
- `AI_PICK` — from thesis generator on screened candidates. **Admission gate** ([`ai-pick-gate.ts`](src/briefing/ai-pick-gate.ts)): deterministic eligibility before `paper_trades` insert (`confidence ≥ 6`, or `rubricTotal ≥ AI_PICK_RUBRIC_MIN` when `AI_PICK_RUBRIC_GATE=1`; fresh false-momentum flag is not set, confirmation path). The rubric is a composite 0–100 score combining deterministic anchors (earnings trajectory, balance sheet, valuation percentile, Weinstein stage) with LLM-scored qualitative dimensions (moat, sector tailwind, competitive position, news catalyst). Stale false-flag values are logged as facts and do not overblock Path A/B; rank-dependent `golden_cross` tiers still fail closed on stale/missing rank or false-flag data. **Stop distance** ([`ai-pick-stop.ts`](src/briefing/ai-pick-stop.ts)): normalize-then-kill — widen stops tighter than `max(2%, 1×ATR)`; block when that minimum exceeds 8% risk; emit `ai_pick_stop_floor_applied` when the final 8% floor changes an overly wide thesis stop. Thesis cards still appear in briefing when blocked. Reject when `stopLoss ≥ entryPrice` (`log.error`).
- `PORTFOLIO_ADD` — from portfolio analyser ADD recommendations
- `momentum_mf` — from Sunday momentum rebalance (**requires `atr_14` at entry**; no 2% proxy)
- `catalyst_entry` — from catalyst-driven screen hits (fixed stop)

**Cross-strategy entry dedup:** `hasOpenPaperTradeForSymbol` blocks new inserts (all active signal types + momentum rebalance) when any OPEN row exists for the symbol, regardless of `signal_type`. CLOSED rows do not block.

**Position sizing (v1, 2026-07-02):** Every new insert stamps `position_weight_pct` via vol-target sizing (`src/strategies/position-sizer.ts`): book = `resolveBookValueInr()` (latest `portfolio_holdings` mark-to-market sum), `risk_pct` and `max_single_stock_pct` from `momentum-config.json` → `position_sizing`. Null weight when inputs are degenerate (excluded from weighted expectancy). Cross-sleeve `max_sector_aggregate` is **shadow-only** (log + count, insert proceeds) until next GTT cohort boundary; momentum `max_per_sector` still blocks live. `getPaperTradeStats` exposes `weightedExpectancyPct`; healthcheck logs weighted GTT tranche in shadow — **GTT gate still uses unweighted** `AVG(pnl_pct)`.

**Unique constraint:** `UNIQUE INDEX uq_paper_trades_signal_day ON paper_trades(symbol, signal_type, source_date)`

**Current performance (May 14, deduplicated baseline, 65 closed trades):**

| signal_type | Trades | Win Rate | Avg Outcome | Avg Win | Avg Loss |
|---|---|---|---|---|---|
| AI_PICK | 33 | 30.3% | **−0.37%** | +3.18% | −1.92% |
| PORTFOLIO_ADD | 22 | 9.1% | **−3.27%** | +1.02% | −3.70% |
| momentum_mf | 10 | 40% | **−0.59%** | +2.16% | −2.42% |

**Phase gate:** GTT execution is **gated observe mode** until all three gates in [`docs/gtt-activation-criteria.md`](../../docs/gtt-activation-criteria.md) pass sequentially (≥30 post-fix closed trades with `source_date >= 2026-05-14`, net expectancy floors per signal type, live `regime_daily = BULL_TRENDING` at activation). Pre-fix dedup baseline expectancy remains negative — not comparable to backtest.

**Fix status and caveats (May 14):**
- PORTFOLIO_ADD duplicate block (symbol with ≥1 OPEN paper trade) — **fixed (May 12)**.
- AI_PICK `alreadyOwned` exclusion now merges live Kite holdings + `SELECT DISTINCT symbol FROM paper_trades WHERE status = 'OPEN'` (all signal types) — **fixed (May 14)**.
- ADD pullback requirement (>= 1 ATR pullback from prior entry, else explicit high-volume breakout) — **deployed**.
- Performance caveat: all currently CLOSED trades are pre-fix cohorts; no post-fix CLOSED trades yet. Clean baseline starts from the next full `BULL_TRENDING` cycle.

### 3.4 Multi-Factor Momentum Screener

**Universe:** ~150 symbols (`config/momentum-universe.json`) — existing watchlist + Nifty 100 + Midcap 50.

**Four factors:**

| Factor | Signal name | Weight | Source |
|---|---|---|---|
| 12-1 month price return | `mom_12_1_return` | 40% | `quotes` table |
| EPS momentum (TTM YoY proxy) | `mom_eps_revision_3m` | 25% | `fundamentals.profit_growth_yoy` (default) or quarterly EPS YoY via `quarterly_fundamentals.eps` when `BACKTEST_EPS_SOURCE=quarterly` — temporary A/B gate (B-ENG-12); remove after cut-over decision |
| Beta-adjusted RS vs Nifty50 | `mom_relative_strength_ba` | 25% | `quotes` + `NIFTY_50` |
| Volume-confirmed breakout flag | `mom_volume_breakout_flag` | 10% + 0.5 bonus | Existing `volume_ratio` signal |

**Composite:** z-score normalised cross-sectionally, winsorised ±3.0, weighted sum + breakout bonus.

**False momentum flag:** `mom_false_flag = 1` when z_12_1 > 0.674 (top quartile) AND (`profit_growth_yoy` < −5% OR `net_profit_ttm` < 0). The `net_profit_ttm` condition blocks loss-making companies that show positive YoY due to loss-narrowing base effect. `net_profit_ttm` sourced from Yahoo snapshot (`netIncomeToCommon` when present; NSE `.NS` fallback: `fundamentalsTimeSeries` trailing TTM, preferring `normalizedIncome` over distorted `netIncome`). NULL → fail-open (condition treated as false). Confidence capped at 5/10 when flagged. **Rebalance entry block:** flagged symbols are skipped before paper-trade insert (`falseFlagBlocked` counter); confidence cap in entry thesis path is unchanged.

**Lifecycle:**
- Enter: top 10 by composite rank, Sunday EOD
- Exit triggers (priority order): trailing stop → hard −8% stop → rank drops > 20 (daily check) → target hit → regime changes from BULL_TRENDING
- Portfolio analyser mirror: strategy-aware guardrails in `portfolio-strategy-guardrails.ts`. `momentum_mf` origins: rank-decay routing (`TRIM` then `EXIT` at `threshold + 5`). `quality_garp` origins: fundamental deterioration flags → `TRIM`/`EXIT`. `catalyst_entry` origins: hold-window / post-earnings → `TRIM`/`EXIT`. Entry origin resolved in the same module (paper ledger, screens, thesis text). Non-matching origins do not exit on rank alone.
- Rebalance: Sunday 8:00 AM IST — entries Sunday only, rank exits evaluated daily
- Sector cap: max 3 stocks per NSE sector
- Earnings blackout: block entries within ±3 calendar days of earnings (from `earnings_calendar` table, sourced via Yahoo Finance). **Sunday sync:** [`replaceMomentumEarningsCalendarForSymbol`](src/db/momentum-queries.ts) replaces rows per symbol when Yahoo returns data; **empty Yahoo response retains** existing calendar rows (fail-closed against outage clearing blackouts).

### 3.5 Fundamentals backfill & Quality-GARP v3
Status: **v3 shipped (2026-07-06)** — `pnpm fundamentals:refresh` orchestrates Python annual backfill (241 symbols), screener ingest, then Yahoo snapshot (yahoo wins on `(symbol, as_of)` conflict). **`quality_garp`** has **13 gates**: 3yr ROE≥18%, ROCE≥20%, D/E<0.5, PEG<1.2, PE/PB ceilings (gates 4–9); **regime-aware** RSI+SMA50 (gates 10–11) via `resolveGarpThresholds(regime)` — CHOPPY=existing constants, BULL RSI 55/SMA50 8%, BEAR RSI 40/SMA50 3%, CRISIS RSI 35/SMA50 0%; promoter selling block; **OPM stability** (gate 11 — trailing 4Q std-dev ≤5%, fail-open <4Q); **promoter pledge ≤15%** (gate 12 — shadow by default, `QUALITY_GARP_PLEDGE_GATE=0`); **Quality Decay Score** (gate 13 — 6-signal trajectory score 0–6 from `quarterly_fundamentals`; hard block ≤3, soft warn =4, fail-open <5Q, bypassed in CRISIS). Funnel counters: `qds`/`qds_warning`/`qds_skipped`/`pledge_shadow`/`opm_skipped`.

**Briefing ext-signal annotation:** Composer queries `ext_signal_holdings` for GARP passes within 3-day window → `[ext: confirmed by DCF_Compounder_Stack]`. Graceful degradation. Active strategy: `DCF_Compounder_Stack` only.

**Promoter pledge ingest:** Daily fail-open `pledge` stage after `corporate-actions` fetches NSE `/api/corporate-pledgedata?index=equities`, resolves `comName` → symbol via `symbols.name`, persists `promoter_pledge`. Portfolio pledge TRIM/EXIT flags gated behind `QUALITY_GARP_PLEDGE_GATE=1`; funnel `pledge_shadow` is the observe path until boundary.

**Quarterly fundamentals:** Quarterly time-series (`revenue`, `operating_profit`, `opm_pct`, `net_profit`, `eps`, `operating_cash_flow`, `free_cash_flow`) ingested from Screener.in `#quarters` + `#cash-flow` tables via the same HTML page as snapshot fundamentals (zero additional HTTP requests). Fetched automatically in `runDailyIngestor`; backfill via `pnpm backfill:quarterly`. Coverage audit for EPS gating: `pnpm eps:audit-coverage` (B-ENG-12 go/no-go gate).

**Item 1b deferred:** BULL/BEAR/CRISIS threshold values in `resolveGarpThresholds` are placeholder hypotheses. Calibration requires 6-month screen-history regime audit after 30+ post-fix closed trades. Cmd: `pnpm cli fundamental-screen-audit -d YYYY-MM-DD`.

---

## 4. Strict Guardrails

| Guardrail | Rule | Enforced In |
|---|---|---|
| **Deep loss full review** | Unrealised loss > 20% → mandatory full LLM review, never lite path | `evaluate-trades.ts` threshold check |
| **RSI overbought ADD block** | RSI_14 > 70 OR price within 3% of 52W high → block ADD, output HOLD | Portfolio analyser system prompt Rule 6 + code guard |
| **Low volume ADD block** | `volume_ratio` < 0.5 → block ADD | Portfolio analyser system prompt Rule 7 |
| **No duplicate ADD** | Symbol has ≥1 open paper trade → block ADD, output HOLD with note | `portfolio-analyser.ts` pre-check (**fixed May 12**) |
| **ADD pullback requirement** | ADD requires ≥1 ATR pullback from prior entry OR confirmed breakout on vol > 1.5× | Portfolio analyser system prompt Rule 9 (**deployed**) |
| **Averaging-down disclosure** | If position at loss: state (a) % gain to breakeven, (b) whether stop allows recovery room | Portfolio analyser system prompt Rule 8 |
| **No macro hallucination** | No FII/DII/USD/crude in stock-specific thesis unless directly tied to that stock's economics | All agent prompts |
| **No financial hallucination** | Never invoke data not present in provided context | All agent prompts |
| **Confidence range** | Full 1–10 scale. Strong tech + fundamentals = 7–8. Pure tech, weak fundamentals = 3–4. False momentum flag = max 5. Catalyst-event theses are hard-capped in code at max 6. | Thesis generator system prompt + post-LLM clamp |
| **ETF/SGB RSI exclusion** | LIQUIDCASE, GOLDBEES, GOLDCASE, SILVERBEES, NIFTYBEES, JUNIORBEES, SGBs — skip RSI/volume signals entirely | `config/etf-exclusions.json` + portfolio analyser (newly added) |
| **Regime gate absolute** | momentum_mf: no entries if regime ≠ BULL_TRENDING. No exception. | `momentum-rebalance.ts` pre-check |
| **Regime strategy gate fail-closed** | Missing `regime_strategy_gate` row → strategy disallowed (`isStrategyAllowed` returns false). | `src/db/regime-queries.ts` |
| **mom_false_flag entry block** | `momentum_mf` rebalance skips insert when `mom_false_flag = 1`. | `src/strategies/momentum-rebalance.ts` |
| **Earnings calendar retain on empty** | Empty Yahoo earnings rows → retain existing `earnings_calendar` per symbol. | `src/db/momentum-queries.ts` |
| **AI_PICK stop distance** | Reject `stopLoss ≥ entryPrice`; normalize-then-kill via `ai-pick-stop.ts` (min `max(2%, 1×ATR)`; block when min > 8%; widen tight stops with `ai_pick_stop_normalized` warn). | `src/briefing/ai-pick-stop.ts`, `paper-trade-writer.ts` |
| **alreadyOwned filter** | Skip symbol in AI Picks if currently held in Kite portfolio **or** symbol has any OPEN `paper_trades` row (any `signal_type`) | Thesis generator input preprocessing (**extended May 14**) |
| **Stale Kite holdings** | If any analysed row is `source=kite` and `portfolio_holdings.as_of` is **before** the last open NSE session on or before the run date (`lastOpenOnOrBefore`), skip **all** portfolio LLM + lite paths; upsert per-symbol `HOLD` rows (`model=none`, `trigger_reason` prefix `STALE_HOLDINGS — …`); structured `log.warn` with `briefingPortfolio: true`; briefing **My Portfolio** shows a yellow banner (`staleHoldingsWarning`). Manual-only portfolios skip this gate. | `portfolio-analyser.ts`, `briefing/composer.ts` + `template.ts` |
| **Signals read window (90d)** | Technical lookups from `signals` only consider rows with `date >= date(as_of, '-90 days')` (anchored on the evaluation / screen date). If nothing falls in the window, callers see **empty** maps / nulls — **no** silent fallback to older history. Same window on the `MAX(date)` subquery in `DbSignalProvider` so “latest session” cannot be outside the window. | `analysers/signal-provider.ts`, `agents/portfolio-trigger.ts` (`getLatestSignalsMap`, `getLatestSignalsMapsForSymbols`) |
| **Fundamentals percent normalization** | Yahoo snapshot stores `roe` / `roce` / `dividend_yield` as decimals; Screener as percent. `normalizeFundamentalForScreen` in `DbSignalProvider` scales `|v| < 1` × 100 at read time so screen DSL thresholds (e.g. `roe >= 15`) evaluate correctly across mixed `fundamentals.source` rows. | `analysers/signal-provider.ts`, `scripts/fundamental-screen-audit.ts` |

---

## 10. Advice-Accuracy Scorer (`advice-review`)

**OBSERVE-SAFE diagnostic** — read-only CLI command that scores past `portfolio_analysis` HOLD/ADD/TRIM/EXIT calls against forward returns from `quotes`. Zero LLM, zero schema change, zero gating impact.

**Methodology (`src/analysers/advice-review.ts`):**
1. Loads `portfolio_analysis` rows with `date <= asOf`
2. Deduplicates to action-transitions (first call of a streak per symbol — repeated HOLDs collapsed)
3. For each transition computes 30/60/90-calendar-day raw and excess returns vs NIFTY_50
4. Entry price = first NSE `close` on or after call date (within 7 calendar days)
5. Horizon close = latest NSE `close` on or before `callDate + H`; horizon is `pending` when target date exceeds symbol's latest quote date
6. Correctness rules: EXIT/TRIM correct when x90<0, ADD correct when x90>0, HOLD correct when x90>-5

**Output:** by-action stats table, conviction-band cuts (90d hit rate by `{<0.5, 0.5–0.7, >0.7}`), 10 worst calls. `--json` for machine consumption. ADD row annotated as advisory only.

**CLI:** `pnpm cli advice-review [-d YYYY-MM-DD] [--json]`. No persistence — rerunnable, same DB state → same output.

## 5. Key SQLite Tables

### Core market data
- **`quotes`** — `(symbol, exchange, date)` PK. OHLCV + `adj_close`, `source`.
  Indexes: `date`, `symbol`.
- **`signals`** — `(symbol, date, name)` PK. All technical + momentum signals,
  long format. `source` = `'technical' | 'momentum_ranker' | etc`.
  **Read contract:** screen evaluation (`DbSignalProvider` technical branch) and portfolio/thesis merges (`getLatestSignalsMap` / `getLatestSignalsMapsForSymbols`) only load rows on or before the as-of date **and** on or after `date(as_of, '-90 days')`; empty window → empty map / null (no deep-history fallback). Latest row **per `name`** still wins inside that window (mixed daily technical + weekly `mom_*` dates).
  Key signal names: `sma_20, sma_50, sma_200, ema_9, ema_21, rsi_14, atr_14, 
  volume_ratio_20d, pct_from_52w_high, pct_from_52w_low, close,
  pct_above_sma200, sma200_slope_30d_pct, weinstein_stage_code, weinstein_stage_score,
  mom_12_1_return, mom_relative_strength_ba, 
  mom_volume_breakout_flag, mom_composite_score, mom_rank, mom_false_flag,
  mom_liquidity_pass, mom_earnings_blackout`
- **`fundamentals`** — `(symbol, as_of)` PK. Time-series. Key columns: `pe, pb, 
  peg, roe, roce, revenue_growth_yoy, profit_growth_yoy, debt_to_equity, 
  promoter_holding_pct, promoter_holding_change_qoq, dividend_yield`.
  ⚠️ No sector column — sector is in `symbols` table.
  ⚠️ **Unit mix:** Yahoo snapshot may store `roe`/`roce`/`dividend_yield` as decimals; Screener as percent — normalized at screen read in `DbSignalProvider`.
- **`quarterly_fundamentals`** — `(symbol, quarter_end)` PK. Quarterly time-series from Screener.in `#quarters` + `#cash-flow` tables. Columns: `revenue, operating_profit, opm_pct, net_profit, eps, operating_cash_flow, free_cash_flow`. Populated daily by `runDailyIngestor` (same page as `fundamentals` — zero extra HTTP requests). Backfill: `pnpm backfill:quarterly`. Banks (`Net Interest Income`) have nulls for revenue/OPM/OCF.
- **`fii_dii`** — `(date, segment)` PK. Segments: `cash | fno | fno_index_fut | 
  fno_stock_fut`. Columns: `fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net`.
- **`news`** — `(id)` PK, `UNIQUE(url)`. Columns: `symbol, headline, summary, 
  source, url, published_at, sentiment`.
- **`symbols`** — `(symbol)` PK. Master list. Columns: `name, exchange, sector, 
  industry, is_index, is_active`. ⚠️ Sector data lives here, not in fundamentals.
- **`earnings_calendar`** — `(symbol, expected_date)` PK. Source: Yahoo Finance
  quoteSummary. Used for momentum entry blackout gate. Replace helper:
  `replaceMomentumEarningsCalendarForSymbol(db, symbol, rows[])` — empty `rows`
  is a no-op (retains existing dates).
- **`intraday_quotes`** — `(symbol, captured_at)` PK. LTP snapshots from Kite.

### AI & screening outputs
- **`screens`** — `(symbol, date, screen_name)` PK. `matched_criteria` JSON,
  `thesis_json` populated after AI pass.
- **`theses`** — `(symbol, date)` PK. Full thesis store: `bull_case, bear_case, 
  entry_zone, stop_loss, target, time_horizon, confidence (1–10), trigger_reason, 
  model, raw_response, rubric_json (JSON: {anchors, llm, total} — Task A),
  context_refs (JSON: data provenance — Task C)`.
- **`portfolio_analysis`** — `(symbol, date)` PK. Per-holding LLM output:
  `action (HOLD|ADD|TRIM|EXIT), conviction (0..1), thesis, bull_points JSON, 
  bear_points JSON, trigger_reason, suggested_stop, suggested_target, pnl_pct, model`.
  When stale Kite holdings fire, rows are deterministic placeholders (`model=none`, `conviction=0`, `STALE_HOLDINGS` trigger text) — not LLM output.
- **`alerts`** — `(symbol, date, kind)` PK. Kinds: `rsi_overbought | rsi_oversold | 
  volume_spike | near_52w_high | near_52w_low`. Feeds briefing watchlist section.

### Portfolio & execution
- **`portfolio`** — `(symbol)` PK. Simple manual store: `qty, avg_price, stop_loss, 
  target, notes`.
- **`portfolio_holdings`** — `(symbol, as_of)` PK. Full Kite-synced time-series:
  `qty, avg_price, last_price, pnl, pnl_pct, day_change, day_change_pct, product, 
  source, raw JSON`. Portfolio analyser reads from here, not from `portfolio`.
- **`paper_trades`** — `(id)` PK. UNIQUE `(symbol, signal_type, source_date)`.
  Base columns: `symbol, signal_type, entry_price, stop_loss, target, time_horizon, 
  max_hold_days, status, outcome_date, exit_price, pnl_pct, notes`.
  ALTER-added columns (schema evolved via migrations): `highest_close_since_entry, 
  atr14_at_entry, trailing_multiplier (default 2.0), stop_raised_today, exit_reason, stop_type (default 'trailing')`.
  Status values: `OPEN | CLOSED_WIN | CLOSED_LOSS | CLOSED_TIME`.
  Exit reasons: `TRAILING_STOP | INITIAL_STOP | TARGET_HIT | TIME_EXIT | MANUAL`.
- **`trailing_stop_log`** — append-only audit. UNIQUE `(trade_id, log_date, action)`.
  Columns: `prev_stop, new_stop, stop_delta, candidate_stop, highest_close, 
  atr14_today, multiplier_used, unrealised_pct, action, narrative, notes`.

### Regime & strategy control
- **`regime_daily`** — UNIQUE `date`. Columns: `regime, score_total, score_trend, 
  score_vix, score_fii, score_breadth, vix_value, nifty_vs_sma200, fii_20d_net, 
  ad_ratio, pct_above_sma200, crisis_override, narrative, prev_regime, regime_age`.
- **`regime_strategy_gate`** — `(strategy_id, regime)` PK. Columns: `allowed (0/1), 
  size_multiplier, notes`. Lookup via `isStrategyAllowed` is **fail-closed**
  (missing row = disallowed). Seed from `config/strategy-gates.json`.
- **`momentum_rebalance_briefing`** — `calendar_date` PK. Sunday audit:
  `session_date, regime_allowed, regime, closed_rank_decay, entries_inserted, 
  unchanged_held, sector_cap_blocked, blackout_blocked, skipped_reason, 
  thesis_failed, ranker_universe_size, ranker_eligible_count`. In-memory rebalance
  result also tracks `falseFlagBlocked` (not persisted to this table).

### Infrastructure
- **`briefings`** — `(id)` PK, index on `date`. Columns: `date, html_content, 
  delivery_method, delivered_at`. Delivery methods: `file | email`.
  Email: `delivered_at` is set only when SMTP accepts ≥1 recipient (`src/briefing/delivery/email.ts`).
- **`pipeline_runs`** — append-only stage audit (migration `0022`). Columns: `run_date, stage, status, started_at, finished_at, error_msg, metadata` (JSON). Index `(run_date, stage)`. Multiple rows per `(run_date, stage)` on retries; `getPipelineHealth` uses latest `id` per required stage. Written by `daily-workflow.ts` and `composeBriefing`. Per-stage `metadata` payloads (e.g. yahoo-snapshot `{ attempted, written, failed }`, screen `{ matchCount }`) are read by `getStageHistory(stage, days, db)` and the `mp snapshot-health` CLI.
- **`portfolio_analysis_llm`** — view over `portfolio_analysis` excluding `model = 'none'` (stale-holdings + allocation-instrument placeholders).
- **`config`** — `(key)` PK. Key-value store. Currently holds: `kite_access_token`.
- **`kite_instruments`** — `(exchange, tradingsymbol)` PK. Kite instrument master.
- **`backtest_runs`** + **`backtest_trades`** — Screen harness (`src/backtest/harness.ts`) persists screen-replay runs. **Option A** (`src/backtest/runner.ts`, `mp backtest-option-a`) adds walk-forward `momentum_mf` / `ai_pick` simulations using **quotes-only** on-the-fly signals; extended columns on `backtest_runs` (migration `0014_backtest_runs_option_a.sql`) store `strategy_id`, expectancy, profit factor, etc.; **`equity_curve_max_dd_pct`** (migration `0022`) is portfolio-level equity-curve DD on the run row (distinct from per-trade `max_drawdown_pct` on both `backtest_runs` summary and `backtest_trades` legs — runner write pending). Option A rows on **`backtest_trades`** set **`exit_reason`** (migration `0015_backtest_exit_reason.sql`) from the position sim and strategy-specific exits (`RANK_DECAY`, `REGIME_EXIT`, `WINDOW_END`, …). Default **regime `proxy`** (`src/backtest/regime-proxy.ts`) avoids `regime_daily` and uses a 3-signal NIFTY+breadth coarse label with a **≥252** prior-bar gate on `NIFTY_50`; **`--regime-source daily`** restores the ≥80% `regime_daily` coverage gate. For persisted vs score-only `regime_daily` labels use `scripts/audit-regime-history.mts`.

**Hot-path indexes (migration `0021`):** `idx_signals_symbol_name_date`, `idx_fundamentals_asof`, `idx_fundamentals_source_symbol_asof`, `idx_news_symbol_published`, partial `idx_pt_open` on OPEN `paper_trades` (replaces `idx_paper_trades_status`).

---

## 6. Deployment & Infrastructure

**VM:** Oracle Cloud Always Free, `VM.Standard.E2.1.Micro`, Ubuntu 22.04, `ap-hyderabad-1`. 1 OCPU, 1GB RAM, 50GB disk.

**Process manager:** PM2 — **two** app processes (see `deploy/ecosystem.config.cjs`):

| PM2 name | Entry | Role |
|---|---|---|
| `market-pulse` | `dist/cli.js schedule` | Main croner: 08:45 / 16:30 weekdays, Sat 08:00, Sun jobs |
| `kite-auth` | `dist/auth/kite-auth-server.js` | OAuth callback (`/auth/kite`, `/auth/callback`) + **08:30** auto-login cron |

Kite auto-login cron lives in `kite-auth-server.ts` (Playwright dynamic-import at trigger). `PLAYWRIGHT_BROWSERS_PATH=0` on `kite-auth` in ecosystem config.

**Kite token flow:**
1. **08:30 (automated):** `runKiteAutoLogin()` → Kite Connect login URL → userid/password/TOTP → redirect to `KITE_REDIRECT_URL` (duckdns `/auth/callback`) → `kite-auth` exchanges `request_token` → writes `KITE_ACCESS_TOKEN` to `.env` + SQLite `config.kite_access_token`. Auto-login polls for a **refreshed** row in local sqlite (new token value or new `updated_at`; same host as `kite-auth` only — do not run auto-login on a laptop when redirect points at Oracle).
2. **Manual fallback:** `pnpm kite-login` (interactive) or open `/auth/kite` in browser. Required if auto-login fails before 08:45.
3. **08:45 pipeline:** `portfolio-sync` / live scan read token from sqlite config or `.env`. If token missing/expired: Kite paths skip gracefully; ingest/enrich/screen/brief still run.

**Env (auto-login):** `KITE_USER_ID`, `KITE_PASSWORD`, `KITE_TOTP_SECRET`, `KITE_REDIRECT_URL` (must match Kite Connect app), `KITE_AUTO_LOGIN_HEADLESS=true`. Playwright: `pnpm playwright:install` (browser binary); on Linux VM also `sudo pnpm playwright:install-deps` once (`PLAYWRIGHT_BROWSERS_PATH=0` → `node_modules`).

**CLI vs package.json:** Pipeline stages are **`pnpm cli <cmd>`** (ingest, enrich, screen, brief, …). `package.json` keeps only deploy/ops shortcuts (`daily`, `schedule`, `migrate`, `deploy`), Kite trio, and scripts **not** wired into `cli.ts` (`fundamentals:refresh`, `cot:gold`, `regime:seed-gates`, `backtest:option-a`, …).

**Nginx:** Reverse proxy on port 443 (Let's Encrypt via Certbot + DuckDNS). Only `/auth/` routes exposed publicly. Everything else returns 403.

**Cron (reference — most jobs use PM2 croner, not raw cron):**
```
30 8 * * 1-5   kite auto-login (PM2 kite-auth)
45 8 * * 1-5   full daily pipeline (PM2 market-pulse schedule)
0  8 * * 0     momentum rebalance (PM2 market-pulse schedule)
15 10 * * 1-5  healthcheck → email alert on failure
30 16 * * 1-5  EOD summary job (PM2 market-pulse schedule)
```

**Deploy scripts:** `deploy/sync-env-to-vm.sh`, `deploy/sync-db-to-vm.sh` (rsync with WAL checkpoint), `deploy/setup.sh` (Node 22 + pnpm + PM2 bootstrap), `deploy/ecosystem.config.cjs`.

**Healthcheck (`deploy/healthcheck.ts`):** When `BRIEFING_DELIVERY=email`, verifies today's `briefings` row with `delivery_method=email` and non-null `delivered_at` (row absent if SMTP accepted zero recipients). Also checks `regime_daily` row present, no pino errors in PM2 logs, optional run-summary JSON thesis failure count. Logs **GTT post-fix tranche** metrics (`paper_trades` closed since `2026-05-14`, grouped by `signal_type`) on every run — empty tranche is logged, not a failure. Appends TSV to `deploy/logs/health.log`. Sends alert email on failure (includes tranche block).

**config table** — `kite_access_token` (+ `updated_at`); written by `kite-auth` callback and/or `kite-auto-login` persistence.

---

## 7. LLM Provider Abstraction

**Interface:** `src/llm/provider.ts` exposes `complete(system, messages, opts)` and typed `generateJson<T>()` / `generateText()` methods.

**Providers implemented:**
- `anthropic` — `src/llm/providers/anthropic.ts` — Anthropic SDK, Claude Sonnet
- `deepseek` / `openai` — `src/llm/providers/openai.ts` — OpenAI SDK, `baseURL` configurable via `OPENAI_BASE_URL` env var (defaults to OpenAI; set to `https://api.deepseek.com` for DeepSeek)
- `vertex` — `src/llm/providers/vertex.ts` — `@google-cloud/vertexai` SDK. **TODO: migrate to `@google/genai` before mid-2026 deprecation.**

**Switch provider:** Single env var change — `LLM_PROVIDER=deepseek` (current production).

**JSON reliability fix:** `response_format: { type: 'json_object' }` passed only when `forceJson: true` (set automatically in `generateJson()`). `generateText()` never forces JSON mode — fixes regime narrative prose calls.

**Current production model:** `deepseek-chat` (DeepSeek-V3). Do NOT use `deepseek-reasoner` — 10× cost, no quality improvement for structured financial JSON.

---

## 8. Known Issues & Next Priorities

**Observation items (do not build, just watch):**
- Paper trade expectancy still negative on deduplicated baseline: AI_PICK −0.37%, PORTFOLIO_ADD −3.27%, momentum_mf −0.59%
- All closed outcomes so far are pre-fix cohorts; evaluate quality only after post-fix trades complete
- Overall expectancy still negative — GTT execution remains gated until 30+ post-fix closed trades confirm positive
- fundamentals table coverage remains uneven; Earnings Reversal and PEG/ROE-CAGR-heavy variants remain deferred until annual backfill widens. OPM stability gate is live on `quarterly_fundamentals` (fail-open on <4Q).

**Deferred to v2:**
- Expanding universe from ~150 to NSE 500
- Backtest infrastructure (walk-forward, transaction cost model, survivorship bias handling)
- GTT Execution Module (activates when expectancy > 0 over 30+ trades — not yet met)
- Strategy backlog (6 unbuilt, prioritised): see strategy-backlog.md

**Liquidity filter:** Deferred to v1.1. Stub slot exists in `momentum-ranker.ts` Step 2 with log line. Not yet implemented.

## 9. Backtest Infrastructure

### Option A — Signal Replay Backtest
Walk-forward simulation from `quotes` only. Does NOT read `signals` table.
Runner: `pnpm backtest:option-a`
Default window: 2023-01-01 → 2026-03-31. Min history: 504 days. Costs: 20bps RT.

**Regime source:** quotes-only 3-signal proxy (see `src/backtest/regime-proxy.ts`).
Historical `regime_daily` is unusable for pre-2025 dates — signals table had no 
history when backfill ran, producing 99.6% CHOPPY. Proxy uses: Nifty vs SMA200, 
SMA200 slope, % universe above SMA200.

**adj_close vs close:** mom_12_1_return uses adj_close (split-consistent). 
RSI/SMA/ATR use close (matches live enricher). `TechnicalEnricher` loads the **trailing** `lookback` window (last N bars). After historical quote backfill, re-run enrich and `pnpm exec tsx scripts/audit-atr-alignment.mts` (≤2% divergence on spot symbols) before trusting live stops vs backtest.

**Survivorship bias:** active. Delisted symbols absent from quotes are excluded.
Results are optimistic by ~0.3–0.5% avg return.

**Results (2023-01-01 to 2026-05-21, 2.0× initial ATR baseline run):**
- momentum_mf: 689 trades, 52.8% hit rate, +1.62% avg net, PF 1.79
- ai_pick (rule proxy): 313 trades, 56.5% hit rate, +1.98% avg net, PF 1.76

**Phase 1 — initial ATR multiplier sweep (momentum_mf, tightened mult held at 1.5):**
- CLI: `pnpm backtest:option-a -- --strategy momentum-mf --sweep-initial-stop --dry-run`
- Single value: `--initial-multiplier 2.5`
- Selected production value: **2.5×** (bear sub-window PF 1.78; 3.0× rejected — floor-dominated)
- Config: `config/momentum-config.json` → `position_sizing.atr_multiplier: 2.5`

**Phase 2 — lock-in joint sweep (completed):** `--sweep-lock-in` over `tightened_multiplier` `[1.25, 1.5, 1.75]` × `lock_in_threshold_pct` `[12, 15, 18]` with initial fixed **2.5×**. Winners deployed to config: **18% / 1.5×**. Live + backtest read [`src/config/trailing-stop-sizing.ts`](../../src/config/trailing-stop-sizing.ts).