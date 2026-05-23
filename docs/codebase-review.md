# Market Pulse AI — Comprehensive Codebase Review

> **Date:** May 21, 2026
> **Scope:** Full application architecture, design patterns, code quality, alignment with design docs, and improvement roadmap

---

## Table of Contents

1. [What It Does](#1-what-it-does)
2. [Architecture & Design Patterns](#2-architecture--design-patterns)
3. [Design Doc Alignment](#3-design-doc-alignment)
4. [Code Quality Assessment](#4-code-quality-assessment)
5. [Roadmap & What's Next](#5-roadmap--whats-next)
6. [Improvement Suggestions](#6-improvement-suggestions)
7. [Verdict](#7-verdict)

---

## 1. What It Does

Market Pulse AI is a **personal NSE/BSE morning briefing pipeline** — a decision-support system for Indian equity markets. It automates the daily workflow a retail trader would otherwise do manually: collect data, calculate technicals, gauge market regime, screen stocks, get AI analysis, and receive it all in a morning email.

### Core Capabilities

| Capability | Description | Key Files |
|---|---|---|
| **Data Ingestion** | OHLCV quotes (Yahoo/NSE), fundamentals (Screener.in), news (RSS), FII/DII flows (NSE), corporate actions (Yahoo), earnings calendar (Yahoo) | `src/ingestors/yahoo/`, `src/ingestors/nse/`, `src/ingestors/screener/`, `src/ingestors/rss/` |
| **Technical Enrichment** | SMA20/50/200, EMA9/21, RSI14, ATR14, volume ratio, 52W high/low, momentum factors (12-1m return, beta-adjusted RS, volume breakout) | `src/enrichers/technical/`, `src/enrichers/momentum-signals.ts` |
| **Regime Classification** | 8-signal deterministic system: Nifty trend, VIX, FII flows, breadth → 4 states with 3-day persistence gates | `src/analysers/regime-classifier.ts`, `src/enrichers/regime-signals.ts`, `src/agents/regime-agent.ts` |
| **Stock Screening** | Configurable multi-criterion screens gated by regime state | `src/analysers/engine.ts`, `src/analysers/evaluator.ts`, `config/screens.json` |
| **AI Thesis Generation** | DeepSeek-powered fundamental+technical analysis on screened candidates (skips already-owned and open paper trades) | `src/agents/thesis-generator.ts` |
| **Paper Trade Ledger** | 3 active signal types (AI_PICK, PORTFOLIO_ADD, momentum_mf) with full lifecycle management | `src/db/`, `src/scripts/evaluate-trades.ts` |
| **Adaptive Trailing Stops** | Configurable ATR-multiplier stops (2.5× / 18% / 1.5×), gap-down circuit breaker, hard −8% floor | `src/scripts/evaluate-trades.ts`, `src/config/trailing-stop-sizing.ts` |
| **Briefing Composition** | Dual-render path (email HTML + browser HTML), delivered via Nodemailer Gmail SMTP | `src/briefing/`, `src/briefing/template.ts` |
| **Momentum Rebalance** | 4-factor quant screen on ~150 symbol universe, top-10 entry, rank-decay exit, sector cap, earnings blackout | `src/strategies/momentum-rebalance.ts`, `src/rankers/momentum-ranker.ts` |
| **Backtest Engine** | Walk-forward signal replay (Option A) using quotes-only proxy regime; ATR sweep + lock-in joint sweep completed | `src/backtest/`, `src/backtest/runner.ts` |
| **Scheduling** | Croner-based: weekdays 08:45/16:30, Saturday 08:00, Sunday 06:00/08:00 IST | `src/scheduler/market-scheduler.ts` |

### Pipeline Flow

```
Ingest → Corporate Actions → Enrich → Regime Classify → Screen → AI Thesis → Portfolio Evaluate → Briefing
```

Orchestration: `src/agents/daily-workflow.ts` (weekday path). Paper trade evaluation runs before the briefing composer so closed trades appear in the brief.

---

## 2. Architecture & Design Patterns

### Architecture Style: Pipeline + Plugin

The system follows a **sequential pipeline architecture** with plugin points for data sources and LLM providers. It's modular but orchestrated in a single linear flow.

### Design Patterns Observed

| Pattern | Where | Assessment |
|---|---|---|
| **Strategy** | `LlmProvider` interface with 6 implementations (Anthropic, OpenAI/DeepSeek, Vertex, Google Studio, Cursor Agent, Mock) | ✅ Excellent — single env var to switch providers |
| **Strategy** | `Ingestor` interface with 4 implementations (Yahoo, NSE, Screener, RSS) | ✅ Good; `registry.ts` could be cleaner |
| **Repository** | `src/db/queries.ts` — explicit prepared statements encapsulating all SQL | ✅ Strong — no ORM, no leaky abstractions |
| **Factory** | `LlmProviderFactory` (`src/llm/factory.ts`), DB connection management | ✅ Clean singleton pattern |
| **Value Object** | Zod schemas in `src/types/` — validated at every system boundary | ✅ Excellent — `src/config/env.ts` validates everything |
| **Template Method** | Briefing cards (`regime-card.ts`, `momentum-card.ts`, `trailing-stop-card.ts`, `paper-trade-writer.ts`) | ✅ Consistent rendering API with shared template |
| **Builder/Prep** | `prepareRegimeDaily()` separates computation from persistence | ✅ Clean pattern used across codebase |
| **Chain of Resp.** | Pipeline stages in `daily-workflow.ts` | ⚠️ Works, but orchestration is a single large function |
| **Adapter** | Yahoo ticker overrides in `benchmarks.ts` mapping canonical → real tickers | ✅ Clean mapping |

### Well-Executed Design Decisions

1. **SQLite as integration bus** — All written data goes through a single DB with append-only migrations. Ensures replayability and debugging without complexity of a message queue.

2. **Zod-first validation** — Config, env vars, LLM JSON output, domain types — everything validated at the boundary, never trusting external input. Example: `src/config/env.ts` validates every env var against Zod schemas; `src/config/loaders.ts` validates JSON config files.

3. **Regime gating** — All strategies consult `regime_strategy_gate` before acting. Enforced at execution point, not just in design docs. The `momentum-rebalance.ts` pre-check throws if regime ≠ `BULL_TRENDING`.

4. **Signal 90-day read window** — Technical lookups in `DbSignalProvider` and `getLatestSignalsMap` are bounded by `date >= date(as_of, '-90 days')`. No silent fallback to ancient data.

5. **Dual render path** — Email HTML (table-based, 600px, Gmail-safe via `juice`) + browser HTML (CSS variables, modern UI). Pragmatic: one for delivery, one for the user's own viewing on desktop.

6. **Defensive circuit breakers** — Gap-down fill ruling (if `open < prior close × 0.7`, skip stop-out for that bar), stale holdings detection (skip LLM if Kite snapshot is stale), deep-loss full review mandate (unrealised loss > 20% → mandatory full LLM review).

7. **Append-only DB migrations** — Files in `src/db/migrations/` are never edited. Migration `0015` is the latest, preserving full schema evolution history.

8. **Corporate action auto-handling** — For OPEN paper trades, Yahoo split events are pulled over 5 IST days, nominal adjustments applied once via `INSERT OR IGNORE` + `run().changes`, with audit trail in `trailing_stop_log.notes`.

---

## 3. Design Doc Alignment

### ✅ Fully Aligned

| Design Doc | Verification |
|---|---|
| **Architecture (`architecture-v2.md`)** | Pipeline stages match exactly; all described modules exist |
| **DB Schema (`db-schema.md`)** | All tables present; migrations are append-only; schema.sql is base + migrations overlay |
| **Guardrails (`guardrails.md`)** | All 14+ guardrails are implemented and enforced at code level, not just documented |
| **Regime system** | 4-state with 3-day persistence, CRISIS override, strategy gate table — exact match |
| **Trailing stops** | ATR-based with lock-in mechanics, gap-down circuit breaker, hard −8% floor — all present |
| **LLM abstraction** | Interface-based with factory selection — `LlmProvider` + `generateJson()` with Zod validation |
| **Paper trades** | 3 signal types, unique constraints, trailing_stop_log append-only audit |

### ⚠️ Partially Aligned

| Item | Status | Notes |
|---|---|---|
| **README.md** | ⚠️ Missing | `AGENTS.md` references `docs/README.md` as operations manual — file doesn't exist. Root `README.md` exists but is basic. |
| **Delivery channels** | ⚠️ 2/4 done | Only `file` and `email` implemented. `dispatch.ts` logs a warning for `slack` / `telegram`. |
| **Intraday scanning** | ⚠️ Not wired | `live-scanner.ts` exists but doesn't appear in the main pipeline. Kite auth server is separate. |
| **Momentum Factor 2** | ⚠️ Proxy | Uses `profit_growth_yoy` as EPS momentum proxy (not quarterly EPS). Design docs acknowledge this. |
| **PM2 process names** | ⚠️ Docs drift | Some script names in `ecosystem.config.cjs` may not match latest `package.json` scripts |

### ❌ Not Yet Present / Deferred

| Feature | Status | Blocker |
|---|---|---|
| **GTT Execution Module** | ❌ Gated | Requires 30+ post-fix closed trades with positive expectancy (not met; AI_PICK −0.37%, PORTFOLIO_ADD −3.27%, momentum_mf −0.59%) |
| **Liquidity filter** | ❌ Stub only | Log line in `momentum-ranker.ts`, no implementation |
| **NSE 500 universe** | ❌ Deferred | Currently ~150 symbols; `ingest-symbols.ts` has scaffolding |
| **Catalyst-Driven Entry** | ❌ Not built | No data blocker (earnings + news exist); highest-priority unbuilt strategy |
| **Quality-GARP Screener** | ❌ Not built | Needs `fundamentals` history depth verification |
| **Earnings Reversal Play** | ❌ Blocked | Needs historical quarterly EPS data (TickerTape/Screener) + Concall Engine |
| **Sector Rotation** | ❌ Blocked | Needs sector-level FII flow data |
| **Concall Intelligence Engine** | ❌ Blocked | Needs BSE PDF scraper or Screener.in source |
| **Dynamic Position Sizer** | ❌ Gated | Requires GTT module active first |
| **Quarterly EPS scraper** | ❌ Deferred to v2 | True Factor 2 for momentum accuracy |
| **Survivorship bias handling** | ❌ Not implemented | Backtest results are ~0.3-0.5% optimistic |
| **CI/CD pipeline** | ❌ Not set up | No GitHub Actions or equivalent |

---

## 4. Code Quality Assessment

### Strengths

- **TypeScript strictness** — No `any` casts observed; exhaustive switch statements on union types (see `evaluateCriterion` in `evaluator.ts`)
- **Error handling** — Ingest failures per capability don't abort the entire pipeline. Logged with structured pino context, then continue.
- **Logging** — Pino structured logging with `child({ component: '...' })` context throughout. Consistent log levels (info/warn/error).
- **Immutability** — Pure evaluation functions (`evaluateCriterion`, `evaluateScreen`) with no side effects.
- **Test infrastructure** — Mock LLM provider, Vitest setup with in-memory or test DB, typed test helpers.
- **Configuration management** — All config Zod-validated; `process.env` never read in feature code.
- **DB transactions** — Explicit `db.transaction()` in critical persistence paths.
- **No default exports** — Named exports everywhere, making imports traceable and IDE-friendly.
- **Source maps for production** — `tsconfig.build.json` emits source maps for error stack traces.

### Weaknesses

- **Test coverage gaps** — Several core modules have no dedicated tests:
  - `portfolio-analyser.ts` — Complex LLM integration, 0 tests
  - `thesis-generator.ts` — Core AI pipeline stage, 0 tests
  - `daily-workflow.ts` — Main orchestrator, 0 integration tests
  - `briefing/composer.ts` — No tests despite complex rendering logic
  - `backtest/runner.ts` — No direct tests (coverage through sweep-metrics only)

- **`runDailyWorkflow` is monolithic** — ~200+ lines orchestrating 10+ stages with nested conditionals, flags, and error handling inline. Difficult to test individual stage behavior.

- **CLI is the only interface** — No web UI, no API, no desktop app. The beautiful browser HTML render path requires file system access to view.

- **No retry mechanism** — Network calls to Yahoo/NSE/Screener have no retry logic. A single transient API failure degrades the pipeline for that day.

- **Config load path indirection** — `src/config/trailing-stop-sizing.ts` loads from `momentum-config.json` but the resolution chain involves multiple hops (loader → config → function parameter).

- **DB query overlap** — `momentum-queries.ts` has queries overlapping with `queries.ts`. Could benefit from consolidation.

- **Some CLI command descriptions are terse** — `cli.ts` has many commands but some lack detailed help text or argument descriptions.

---

## 5. Roadmap & What's Next

### Gate-Dependent (must have positive paper trade expectancy first)

| Priority | Feature | Effort | Blocker |
|---|---|---|---|
| 1 | **GTT Execution Module** — Automated order routing via Kite GTT | Medium | 30+ post-fix closed trades with positive net expectancy per signal type |
| 2 | **Dynamic Position Sizer** — Formula-based position sizing | Easy | GTT module must be active |
| 3 | **Catalyst-Driven Entry** — Enter ahead of earnings/events | Easy | None (data already present) |

### Not Gate-Dependent (can build anytime)

| Priority | Feature | Effort | Notes |
|---|---|---|---|
| 4 | **Liquidity filter** for momentum | ~1 day | Stub already exists in `momentum-ranker.ts` |
| 5 | **CI/CD pipeline** (GitHub Actions) | ~2 hours | `pnpm typecheck && pnpm test && pnpm lint` on push |
| 6 | **NSE 500 universe expansion** | ~1 week | Scaffolding exists in `ingest-symbols.ts` |
| 7 | **Quality-GARP Screener** | ~2 weeks | Verify `fundamentals` history depth first |
| 8 | **Concall Intelligence Engine** | 2-3 weeks | Blocked on PDF source; high alpha potential |
| 9 | **Sector Rotation** | 3-4 weeks | Most complex; needs FII sector flow data |
| 10 | **Quarterly EPS scraper** | ~1 week | True Factor 2 for momentum |

### Experimental / Low Priority

| Feature | Notes |
|---|---|
| Earnings Reversal Play | Blocked on quarterly EPS data + concall engine |
| Slack/Telegram delivery | ~30 min each via SDKs |
| Web UI for briefings | Static site over `briefings` table |
| Paper trade CSV export | Simple `SELECT ...` CLI command |
| Live-vs-backtest comparison | Validate backtest realism |

---

## 6. Improvement Suggestions

### 🔴 Critical (Affects Reliability)

| # | Suggestion | Rationale | Estimated Effort |
|---|---|---|---|
| 1 | **Add retry with exponential backoff to HTTP client** (`src/ingestors/base/http-client.ts`) | Transient Yahoo/NSE failures degrade entire pipeline. 2-3 retries with backoff significantly improves reliability. | ~4 hours |
| 2 | **Add data freshness alerting** | No warning if fundamentals >1 quarter stale, or FII/DII data missing >2 days. Threshold check in `runDailyWorkflow` or `cli.ts doctor`. | ~2 hours |
| 3 | **Add regression tests for core stages** | `portfolio-analyser.ts`, `thesis-generator.ts`, `daily-workflow.ts` have zero tests — highest-risk modules. | ~1 week |
| 4 | **Add structured non-fatal error aggregation** | Currently ingestion failures are logged but invisible in final output. Surface a `warnings[]` array in the briefing to catch silent degradation. | ~4 hours |

### 🟡 Important (Maintainability & DX)

| # | Suggestion | Rationale | Estimated Effort |
|---|---|---|---|
| 5 | **Break up `runDailyWorkflow`** | Extract into a `PipelineStage[]` array or state machine. Each stage should be independently testable. | ~1 day |
| 6 | **Add GitHub Actions CI** | `pnpm typecheck && pnpm test && pnpm lint` on every push. Catches regressions early. | ~2 hours |
| 7 | **Implement Slack/Telegram delivery** | Currently stubbed. Telegram with `node-telegram-bot-api` is straightforward. | ~30 min each |
| 8 | **Create `docs/README.md` operations manual** | Referenced in `AGENTS.md` but doesn't exist. Would help with deployment and debugging. | ~2 hours |

### 🟢 Nice to Have

| # | Suggestion | Rationale | Estimated Effort |
|---|---|---|---|
| 9 | **Briefing web viewer** | Browser HTML render path exists but no easy way to view old briefings without file system access. | ~1 week |
| 10 | **Paper trade CSV export** | CLI command for external analysis in spreadsheets/notebooks. | ~2 hours |
| 11 | **Live-vs-backtest comparison** | Automated comparison of live outcomes vs backtest projections for same period. | ~2 days |
| 12 | **Enhance `pnpm doctor`** | Add data freshness checks, config validation, Kite token status to make it a proper diagnostic tool. | ~4 hours |
| 13 | **Consolidate DB query modules** | Merge overlapping queries between `momentum-queries.ts` and `queries.ts`. | ~2 hours |

---

## 7. Verdict

**Overall: Well-architected, production-quality personal project with strong engineering discipline.**

The codebase shows clear evidence of an experienced developer who values:
- **Type safety and validation** — Zod enforced at every boundary
- **Testability** — Dependency injection via function parameters, no globals
- **Maintainability** — Append-only migrations, named exports, no default exports, consistent project structure
- **Operational robustness** — Circuit breakers, defensive guards, structured logging, market-closure awareness
- **Documentation discipline** — Design docs (`architecture-v2.md`, `db-schema.md`, `guardrails.md`) are exceptionally well-maintained and accurately reflect the codebase

### Key Risks

1. **Test coverage gaps in highest-value modules** — The AI pipeline stages (portfolio-analyser, thesis-generator) and main orchestrator (daily-workflow) have no tests
2. **No retry logic for external APIs** — Single transient failures degrade the entire day's pipeline
3. **`runDailyWorkflow` monolithic function** — Difficult to test, extend, or reason about individual stage behavior
4. **Negative paper trade expectancy** — GTT gate remains closed; all unbuilt strategies depend on it

### Signal-by-Signal Status (as of May 14, 2026)

| Signal Type | Trades | Win Rate | Avg Return | Gate |
|---|---|---|---|---|
| AI_PICK | 33 | 30.3% | −0.37% | ❌ Negative |
| PORTFOLIO_ADD | 22 | 9.1% | −3.27% | ❌ Negative |
| momentum_mf | 10 | 40% | −0.59% | ❌ Negative |

> **Note:** All closed trades are pre-fix cohorts (duplicate blocks, `alreadyOwned` fixes deployed May 12-14). Clean baseline starts from next full BULL_TRENDING cycle.

### Backtest Validation (2023-01-01 to 2026-05-21)

| Strategy | Trades | Hit Rate | Avg Net Return | Profit Factor |
|---|---|---|---|---|
| momentum_mf | 689 | 52.8% | +1.62% | 1.79 |
| ai_pick (proxy) | 313 | 56.5% | +1.98% | 1.76 |

---

*Review generated by Codebuff AI agent (Buffy) on May 21, 2026.*
