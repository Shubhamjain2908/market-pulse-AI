## Market Pulse AI — State of the Union
---

## 1. Core Stack & Philosophy
**Runtime:** Node.js 22 + TypeScript (ESM), `better-sqlite3`, `node-cron`, PM2 for process management

**Broker:** Zerodha Kite Connect API — portfolio sync, GTT orders (manual trigger only). Daily OAuth token expires 6 AM IST — refreshed manually via `/auth/kite` endpoint before 8:45 AM pipeline run.

**LLM:** Currently DeepSeek-V3 via OpenAI-compatible SDK (`baseURL: https://api.deepseek.com`). Provider abstraction in `src/llm/provider.ts` — switchable via `LLM_PROVIDER` env var (`anthropic` | `deepseek` | `gemini` | `openai`). All LLM calls go through `generateJson()` with Zod schema validation + 1 retry on parse failure.

**Data:** NSE public JSON endpoints + Yahoo Finance (EOD). India VIX from NSE index feed. News via ET Markets + Moneycontrol RSS. Benchmark symbol: `NIFTY_50` (canonical, from `src/market/benchmarks.ts`).

**Deployment:** Oracle Cloud Always Free VM (`VM.Standard.E2.1.Micro`, 1 OCPU, ap-hyderabad-1). SQLite file on persistent disk. Nginx reverse proxy for Kite auth endpoint. DuckDNS free subdomain for HTTPS.

**Pipeline schedule:**
- `8:45 AM IST Mon–Fri` — full daily pipeline (PM2 managed)
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
Ingest → Enrich → Regime Classify → Screen → AI Thesis → Portfolio Evaluate → Briefing
```

| Stage | File | What it does |
|---|---|---|
| **Ingest** | `src/ingestors/nse-eod.ts` | OHLCV for momentum universe (~150 symbols), FII/DII flows, India VIX, AD ratio, news RSS. Rate-limited 2 req/sec. Earnings calendar refresh (Yahoo `quoteSummary`). |
| **Enrich** | `src/enrichers/technical.ts` + `momentum-signals.ts` | SMA20/50/200, EMA9/21, RSI14, ATR14, Volume Ratio, 52W High/Low%. Plus daily momentum factors: `mom_12_1_return`, `mom_relative_strength_ba`, `mom_volume_breakout_flag`. |
| **Regime Classify** | `src/agents/regime-agent.ts` | 8 signals scored −2 to +2. 3-day persistence. CRISIS fires immediately. Writes to `regime_daily`. Runs before all strategies. |
| **Screen** | `src/analysers/stock-screener.ts` | Loads `config/screens.json`. Checks `regime_strategy_gate`. Writes passing symbols to `screens`. |
| **AI Thesis** | `src/agents/thesis-generator.ts` | Per screen pass: sends technicals + fundamentals + news + regime context to LLM. Returns structured JSON. Skips `alreadyOwned` symbols. |
| **Portfolio Evaluate** | `src/scripts/evaluate-trades.ts` | Runs 7-step trailing stop algorithm on all OPEN paper_trades. Then portfolio analyser on Kite holdings. |
| **Briefing** | `src/briefing/composer.ts` | Assembles HTML email + browser HTML. Two render paths: `renderEmailHtml()` (table-based, inline CSS, 600px, Gmail-safe) and `renderBrowserHtml()` (full CSS variables, beautiful UI). Delivered via Nodemailer → Gmail SMTP. |

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

**Current state (May 11):** BEAR_TRENDING Day 1. Score −7.0. FII −3.0, Breadth −4.0. 5 of 11 strategies active.

**Strategy gate table:** `regime_strategy_gate(strategy_id, regime, allowed, size_multiplier)`. Momentum_mf: BULL_TRENDING only.

### 3.2 Adaptive Trailing Stop

**Core math:**
```
initial_stop = MAX(llm_suggested_stop, entry_price − 2.0 × ATR14_at_entry)

unrealised_pct = ((highest_close_since_entry − entry_price) / entry_price) × 100
multiplier = (unrealised_pct ≥ 15.0 OR current_multiplier = 1.5) ? 1.5 : 2.0
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
3. Update `highest_close_since_entry = MAX(prev, today_close)`
4. Run `computeNewStop()` → golden rule → persist if raised
5. Stop-out check: `today_low ≤ updated_stop` → close trade
6. Target check: `today_close ≥ target` → close as `TARGET_HIT`
7. Persist all changes

**Hard stop for momentum_mf:** −8% floor from entry. `effectiveStop = MAX(computedNewStop, entry × 0.92)`. Trailing stop cannot trail below this floor.

**Exit reasons:** `TRAILING_STOP | INITIAL_STOP | TARGET_HIT | TIME_EXIT | MANUAL`

**Audit table:** `trailing_stop_log` — append-only, `UNIQUE(trade_id, log_date, action)`.

### 3.3 Paper Trades Ledger

**Three signal types currently active:**
- `AI_PICK` — from thesis generator on screened candidates
- `PORTFOLIO_ADD` — from portfolio analyser ADD recommendations
- `momentum_mf` — from Sunday momentum rebalance

**Unique constraint:** `UNIQUE INDEX uq_paper_trades_signal_day ON paper_trades(symbol, signal_type, source_date)`

**Current performance (May 11, 30-day window, 41 closed trades):**

| signal_type | Trades | Win Rate | Avg Outcome | Avg Win | Avg Loss |
|---|---|---|---|---|---|
| AI_PICK | 18 | 50% | **+1.13%** | +5.52% | −3.25% |
| PORTFOLIO_ADD | 13 | 15.4% | **−3.07%** | +1.0% | −3.81% |
| momentum_mf | 10 | 30% | **−8.07%** | +1.84% | −12.32% |

**Phase gate:** GTT execution activates only when overall expectancy > 0 over 30+ closed trades. Currently NOT met — PORTFOLIO_ADD and momentum_mf dragging overall negative. Observe mode only.

**Known issues being fixed:**
- PORTFOLIO_ADD: ADD blocked if symbol already has ≥1 open paper trade (Fix 1 — in progress)
- PORTFOLIO_ADD: ADD requires ≥1 ATR pullback from prior entry price (Fix 2 — in progress)
- momentum_mf poor performance: 10 trades all opened Apr 29 (BULL) and stopped out in BEAR transition — not representative; observe next full BULL cycle

### 3.4 Multi-Factor Momentum Screener

**Universe:** ~150 symbols (`config/momentum-universe.json`) — existing watchlist + Nifty 100 + Midcap 50.

**Four factors:**

| Factor | Signal name | Weight | Source |
|---|---|---|---|
| 12-1 month price return | `mom_12_1_return` | 40% | `quotes` table |
| EPS momentum (TTM YoY proxy) | `mom_eps_revision_3m` | 25% | `fundamentals.profit_growth_yoy` |
| Beta-adjusted RS vs Nifty50 | `mom_relative_strength_ba` | 25% | `quotes` + `NIFTY_50` |
| Volume-confirmed breakout flag | `mom_volume_breakout_flag` | 10% + 0.5 bonus | Existing `volume_ratio` signal |

**Composite:** z-score normalised cross-sectionally, winsorised ±3.0, weighted sum + breakout bonus.

**False momentum flag:** `mom_false_flag = 1` when z_12_1 > 0.674 (top quartile) AND `profit_growth_yoy` < −5%. Confidence capped at 5/10 when flagged.

**Lifecycle:**
- Enter: top 10 by composite rank, Sunday EOD
- Exit triggers (priority order): trailing stop → hard −8% stop → rank drops > 20 (daily check) → target hit → regime changes from BULL_TRENDING
- Rebalance: Sunday 8:00 AM IST — entries Sunday only, rank exits evaluated daily
- Sector cap: max 3 stocks per NSE sector
- Earnings blackout: block entries within ±3 trading days of earnings (from `earnings_calendar` table, sourced via Yahoo Finance)

---

## 4. Strict Guardrails

| Guardrail | Rule | Enforced In |
|---|---|---|
| **Deep loss full review** | Unrealised loss > 20% → mandatory full LLM review, never lite path | `evaluate-trades.ts` threshold check |
| **RSI overbought ADD block** | RSI_14 > 70 OR price within 3% of 52W high → block ADD, output HOLD | Portfolio analyser system prompt Rule 6 + code guard |
| **Low volume ADD block** | `volume_ratio` < 0.5 → block ADD | Portfolio analyser system prompt Rule 7 |
| **No duplicate ADD** | Symbol has ≥1 open paper trade → block ADD, output HOLD with note | `portfolio-analyser.ts` pre-check (newly added) |
| **ADD pullback requirement** | ADD requires ≥1 ATR pullback from prior entry OR confirmed breakout on vol > 1.5× | Portfolio analyser system prompt Rule 9 (newly added) |
| **Averaging-down disclosure** | If position at loss: state (a) % gain to breakeven, (b) whether stop allows recovery room | Portfolio analyser system prompt Rule 8 |
| **No macro hallucination** | No FII/DII/USD/crude in stock-specific thesis unless directly tied to that stock's economics | All agent prompts |
| **No financial hallucination** | Never invoke data not present in provided context | All agent prompts |
| **Confidence range** | Full 1–10 scale. Strong tech + fundamentals = 7–8. Pure tech, weak fundamentals = 3–4. False momentum flag = max 5 | Thesis generator system prompt |
| **ETF/SGB RSI exclusion** | LIQUIDCASE, GOLDBEES, GOLDCASE, SILVERBEES, NIFTYBEES, JUNIORBEES, SGBs — skip RSI/volume signals entirely | `config/etf-exclusions.json` + portfolio analyser (newly added) |
| **Regime gate absolute** | momentum_mf: no entries if regime ≠ BULL_TRENDING. No exception. | `momentum-rebalance.ts` pre-check |
| **alreadyOwned filter** | Skip symbol in AI Picks if currently held in Kite portfolio | Thesis generator input preprocessing |

---

## 5. Key SQLite Tables

### Core market data
- **`quotes`** — `(symbol, exchange, date)` PK. OHLCV + `adj_close`, `source`.
  Indexes: `date`, `symbol`.
- **`signals`** — `(symbol, date, name)` PK. All technical + momentum signals,
  long format. `source` = `'technical' | 'momentum_ranker' | etc`.
  Key signal names: `sma_20, sma_50, sma_200, ema_9, ema_21, rsi_14, atr_14, 
  volume_ratio_20d, mom_12_1_return, mom_relative_strength_ba, 
  mom_volume_breakout_flag, mom_composite_score, mom_rank, mom_false_flag,
  mom_liquidity_pass, mom_earnings_blackout`
- **`fundamentals`** — `(symbol, as_of)` PK. Time-series. Key columns: `pe, pb, 
  peg, roe, roce, revenue_growth_yoy, profit_growth_yoy, debt_to_equity, 
  promoter_holding_pct, promoter_holding_change_qoq, dividend_yield`.
  ⚠️ No sector column — sector is in `symbols` table.
- **`fii_dii`** — `(date, segment)` PK. Segments: `cash | fno | fno_index_fut | 
  fno_stock_fut`. Columns: `fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net`.
- **`news`** — `(id)` PK, `UNIQUE(url)`. Columns: `symbol, headline, summary, 
  source, url, published_at, sentiment`.
- **`symbols`** — `(symbol)` PK. Master list. Columns: `name, exchange, sector, 
  industry, is_index, is_active`. ⚠️ Sector data lives here, not in fundamentals.
- **`earnings_calendar`** — `(symbol, expected_date)` PK. Source: Yahoo Finance
  quoteSummary. Used for momentum entry blackout gate.
- **`intraday_quotes`** — `(symbol, captured_at)` PK. LTP snapshots from Kite.

### AI & screening outputs
- **`screens`** — `(symbol, date, screen_name)` PK. `matched_criteria` JSON,
  `thesis_json` populated after AI pass.
- **`theses`** — `(symbol, date)` PK. Full thesis store: `bull_case, bear_case, 
  entry_zone, stop_loss, target, time_horizon, confidence (1–10), trigger_reason, 
  model, raw_response`.
- **`portfolio_analysis`** — `(symbol, date)` PK. Per-holding LLM output:
  `action (HOLD|ADD|TRIM|EXIT), conviction (0..1), thesis, bull_points JSON, 
  bear_points JSON, trigger_reason, suggested_stop, suggested_target, pnl_pct, model`.
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
  atr14_at_entry, trailing_multiplier (default 2.0), stop_raised_today, exit_reason`.
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
  size_multiplier, notes`.
- **`momentum_rebalance_briefing`** — `calendar_date` PK. Sunday audit:
  `session_date, regime_allowed, regime, closed_rank_decay, entries_inserted, 
  unchanged_held, sector_cap_blocked, blackout_blocked, skipped_reason, 
  thesis_failed, ranker_universe_size, ranker_eligible_count`.

### Infrastructure
- **`briefings`** — `(id)` PK, index on `date`. Columns: `date, html_content, 
  delivery_method, delivered_at`. Delivery methods: `file | email | slack | telegram`.
- **`config`** — `(key)` PK. Key-value store. Currently holds: `kite_access_token`.
- **`kite_instruments`** — `(exchange, tradingsymbol)` PK. Kite instrument master.
- **`backtest_runs`** + **`backtest_trades`** — Schema exists, not yet populated.
  `backtest_runs` stores aggregate stats per screen + date range.
  `backtest_trades` stores individual trade records with FK to `backtest_runs`.

---

## 6. Deployment & Infrastructure

**VM:** Oracle Cloud Always Free, `VM.Standard.E2.1.Micro`, Ubuntu 22.04, `ap-hyderabad-1`. 1 OCPU, 1GB RAM, 50GB disk.

**Process manager:** PM2. Two processes: `market-pulse` (main app, `dist/cli.js schedule`) and `kite-auth` (Express auth server, port 3001).

**Kite token flow:** Daily manual refresh. User opens `https://[duckdns-subdomain].duckdns.org/auth/kite` on phone before 8:45 AM, completes OAuth, token written to SQLite `config` table. If token missing at pipeline start: Kite sync skipped gracefully, rest of pipeline runs.

**Nginx:** Reverse proxy on port 443 (Let's Encrypt via Certbot + DuckDNS). Only `/auth/` routes exposed publicly. Everything else returns 403.

**Cron:**
```
45 8 * * 1-5   full daily pipeline (via PM2 schedule, not raw cron)
0  8 * * 0     momentum rebalance
15 10 * * 1-5  healthcheck → email alert on failure
```

**Deploy scripts:** `deploy/sync-env-to-vm.sh`, `deploy/sync-db-to-vm.sh` (rsync with WAL checkpoint), `deploy/setup.sh` (Node 22 + pnpm + PM2 bootstrap), `deploy/ecosystem.config.cjs`.

**Healthcheck (`deploy/healthcheck.ts`):** Verifies `briefings` row delivered, `regime_daily` row present, no pino errors in PM2 logs, optional run-summary JSON thesis failure count. Appends TSV to `deploy/logs/health.log`. Sends alert email on failure.

**config table** note — Kite token stored here

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
- PORTFOLIO_ADD win rate 15.4% — monitor post-fixes to see if quality improves
- momentum_mf cohort (Apr 29) — not representative; next BULL_TRENDING cycle is the real test
- Overall expectancy still negative — GTT execution remains gated until 30+ trades confirm positive

**Deferred to v2:**
- Quarterly EPS scraper (true Factor 2 vs current `profit_growth_yoy` proxy)
- Expanding universe from ~150 to NSE 500
- Backtest infrastructure (walk-forward, transaction cost model, survivorship bias handling)
- Concall Intelligence Engine (BSE PDF scraper + transcript analysis)
- GTT Execution Module (activates when expectancy > 0 over 30+ trades — not yet met)

**Liquidity filter:** Deferred to v1.1. Stub slot exists in `momentum-ranker.ts` Step 2 with log line. Not yet implemented.