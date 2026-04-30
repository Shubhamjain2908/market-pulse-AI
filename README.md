# Market Pulse AI

A personal morning-briefing agent for Indian stock markets (NSE/BSE).
**Not** an auto-trader — every order is still placed by you. The system is a
modular pipeline that runs every weekday at 7:30 AM IST and emails you a
short, actionable briefing before market open.

> **Status:** Phases 0–3 shipped. Phase 2 added a JSON-driven screen engine
> (Momentum Breakout, Quality at Value, FII Accumulation), first-class
> watchlist alerts, and a backtest harness that replays historical EOD data
> to give every screen a hit-rate / drawdown profile. The full AI-enhanced
> pipeline runs end-to-end: Yahoo/NSE/Screener/RSS data ingestion, technical
> indicators (SMA/EMA/RSI/ATR/volume/52W), LLM sentiment scoring on news
> headlines, AI thesis generation for top-signal stocks, and an AI-composed
> HTML briefing with market mood narrative, thesis cards, and a "screens
> fired today" section. Supports Cursor Agent, Anthropic, OpenAI, and
> Vertex AI (Gemini) as LLM backends. See [the roadmap](#roadmap).

---

## Why this exists

Most retail dashboards either drown you in data or hide behind a paywall.
Market Pulse AI takes the opposite approach: it pulls only the inputs that
actually move your decisions, runs them through repeatable screens, and asks
an LLM to write a short thesis for the 3–5 most interesting setups. You get
one focused email per morning.

What it does daily:

- Pulls overnight F&O data, FII/DII activity, and global cues
- Screens your watchlist against rules you control (`config/screens.json`)
- Summarises any earnings or news for your holdings
- Surfaces 3–5 actionable ideas, each with a thesis, entry zone, stop, and target

Full product spec: regenerate `market-pulse-ai-spec.docx` by running
`node new.cjs` (the source of truth for requirements lives in that script).

---

## Architecture

A four-stage pipeline. Each stage writes its output to SQLite, so any stage
can be re-run independently for debugging or backtesting.

```mermaid
flowchart LR
    Cron["croner 7:30 IST"] --> Ingest
    subgraph Ingest [Stage 1 - Ingestors]
        NSE[NseIngestor]
        Yahoo[YahooIngestor]
        Screener[ScreenerIngestor]
        RSS[RssNewsIngestor]
    end
    Ingest --> DB[("SQLite<br/>quotes, fundamentals,<br/>news, fii_dii")]
    DB --> Enrich["Stage 2 - Enricher<br/>(pure TS math)"]
    Enrich --> SignalsDB[("signals table")]
    SignalsDB --> Analyse["Stage 3 - Analyser<br/>screens.json + Thesis LLM"]
    Analyse --> ScreensDB[("screens table")]
    ScreensDB --> Brief["Stage 4 - Briefing Composer<br/>(LLM HTML)"]
    Brief --> Deliver{{"file / email / slack / telegram"}}
    LlmAbstraction["LlmProvider<br/>(Cursor / Anthropic / Vertex / OpenAI)"] -.-> Analyse
    LlmAbstraction -.-> Brief
```

Two abstractions keep the system portable:

| Interface       | Purpose                                                   | Default                                           |
| --------------- | --------------------------------------------------------- | ------------------------------------------------- |
| `Ingestor`      | Pluggable data sources (`NSE`, `Yahoo`, `Screener`, `Kite`) | Yahoo + NSE + Screener + RSS (free tier)          |
| `LlmProvider`   | Pluggable LLM backend (`cursor-agent`, `anthropic`, `vertex`, `openai`) | `cursor-agent` (uses your existing subscription)  |

---

## Tech stack

- **Runtime:** Node.js 20 + TypeScript (strict, ESM)
- **Package manager:** pnpm 10
- **Storage:** SQLite via `better-sqlite3`
- **Scheduling:** `croner` (timezone-aware)
- **Validation:** `zod` everywhere — env, configs, LLM outputs
- **Logging:** `pino` (pretty in dev, JSON in prod)
- **CLI:** `commander`
- **Lint + format:** Biome
- **Tests:** Vitest

---

## Quickstart

```bash
# 1. Install dependencies
pnpm install

# 2. Configure
cp .env.example .env
# edit .env - the defaults work, but set BRIEFING_DELIVERY etc. to taste

# 3. Initialise the database
pnpm migrate

# 4. Sanity-check your runtime/config (no secrets are printed)
pnpm cli doctor

# 5. Run the full pipeline (ingest → enrich → sentiment → thesis → brief)
pnpm run-all
# -> writes briefings/briefing-YYYY-MM-DD.html

# Run without LLM calls (Phase 1 mode)
pnpm cli run-all --skip-ai
```

### CLI reference

```bash
pnpm cli --help            # top-level help

pnpm cli migrate           # apply DB migrations
pnpm cli ingest            # stage 1 - pull data
pnpm cli ingest -s RELIANCE,INFY
pnpm cli enrich            # stage 2 - compute signals
pnpm cli screen            # stage 3 - run screens + alert scan
pnpm cli screen -n momentum_breakout
pnpm cli backtest -s 2025-10-01 -e 2026-04-30 -h 10  # historical replay
pnpm cli backtest -s 2025-10-01 -e 2026-04-30 -n momentum_breakout
pnpm cli sentiment         # score news headlines via LLM
pnpm cli thesis            # generate AI theses for top-signal stocks
pnpm cli thesis -n 3       # limit to 3 theses
pnpm cli brief             # stage 4 - compose + deliver briefing
pnpm cli brief --skip-ai   # compose without LLM narrative
pnpm cli run-all           # full pipeline (ingest → thesis → brief)
pnpm cli run-all --skip-ai # skip all AI stages
pnpm cli doctor            # config diagnostics
```

All commands accept `-d 2026-04-30` to target a specific trading date
(useful for backtesting and replay).

---

## Configuration

Three places, in order of precedence:

1. **`.env`** — secrets and runtime knobs (see `.env.example`).
   Validated via `zod` at process start; bad values fail fast.
2. **`config/*.json`** — committed configuration:
   - [`watchlist.json`](config/watchlist.json) — symbols to highlight
   - [`screens.json`](config/screens.json) — screen criteria DSL
   - [`portfolio.json`](config/portfolio.json) — manual holdings (Phase 1–4;
     replaced by Kite sync in Phase 5)
3. **CLI flags** — per-invocation overrides like `-d` or `--delivery`.

### Switching the LLM provider

Set `LLM_PROVIDER` in `.env`:

| Value          | Requires                                                  | Notes                                       |
| -------------- | --------------------------------------------------------- | ------------------------------------------- |
| `cursor-agent` | `cursor-agent` CLI installed and signed in (default)      | Uses your Cursor subscription, no API key   |
| `anthropic`    | `ANTHROPIC_API_KEY`                                       | Adapter implemented in Phase 3              |
| `vertex`       | `GOOGLE_VERTEX_PROJECT` + `GOOGLE_APPLICATION_CREDENTIALS` | Gemini via Vertex AI, implemented in Phase 3 |
| `openai`       | `OPENAI_API_KEY`                                          | Adapter implemented in Phase 3              |
| `mock`         | Nothing                                                   | Deterministic stub for tests                |

Adding a new provider: implement [`LlmProvider`](src/llm/types.ts) and
register it in [`src/llm/factory.ts`](src/llm/factory.ts). Nothing else
changes.

### Screen DSL

Screens are evaluated against a unified signal lookup that pulls from three
sources transparently:

| Source                    | Signals                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `signals` table (technical) | `close`, `sma_20`, `sma_50`, `sma_200`, `ema_9`, `ema_21`, `rsi_14`, `atr_14`, `volume_ratio_20d`, `pct_from_52w_high`, `pct_from_52w_low` |
| `fundamentals` table      | `pe`, `pb`, `peg`, `roe`, `roce`, `debt_to_equity`, `revenue_growth_yoy`, `profit_growth_yoy`, `promoter_holding_pct`, `promoter_holding_change_qoq`, `dividend_yield`, `market_cap` |
| `fii_dii` table (computed) | `fii_net`, `dii_net`, `fii_net_5d_sum`, `dii_net_5d_sum`, `fii_net_streak_days`, `dii_net_streak_days` |

Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between` (tuple value),
`gt_signal` / `lt_signal` (compares two signals — e.g. `close > sma_50`).

Edit [`config/screens.json`](config/screens.json) and re-run
`pnpm cli screen`. No code changes required.

### Backtest

`pnpm cli backtest -s 2025-10-01 -e 2026-04-30 -h 10` replays every
configured screen against historical EOD data:

- Each session in the window where a screen matches becomes a trade.
- Entry = next-day close. Exit = close after `holdDays` sessions.
- Per run we record total trades, winning/losing, hit rate, mean/median
  return, max return, min return, and worst single-trade drawdown.
- Results land in `backtest_runs` and `backtest_trades` tables for ad-hoc
  SQL analysis (`sqlite3 data/market-pulse.db`).

### Switching the market data provider

Set `MARKET_DATA_PROVIDER`:

- `free` (default) — NSE public JSON endpoints + Yahoo Finance + Screener.in
- `kite` — Zerodha Kite Connect (requires `KITE_API_KEY` / `KITE_API_SECRET`
  / `KITE_ACCESS_TOKEN`; ingestor implemented in Phase 5)

---

## Repo layout

```
market-pulse-ai/
  src/
    agents/         # one module per pipeline stage
    ingestors/      # data-source connectors (NSE, Yahoo, Screener, Kite, ...)
    enrichers/      # signal computation: technical (Phase 1), sentiment (Phase 3)
    analysers/      # screen engine (Phase 2)
    briefing/       # HTML composer + delivery; AI narrative (Phase 3)
    db/             # schema.sql + migrations + prepared queries
    llm/            # LlmProvider interface + adapters
    config/         # env loader (zod-validated)
    portfolio/      # holdings tracker (Phase 4)
    backtest/       # historical replay (Phase 2)
    types/          # shared domain types
    cli.ts          # CLI entry
    constants.ts    # SEBI disclaimer, rate limits, etc.
    logger.ts       # pino logger
  config/           # committed JSON configs (watchlist, screens, portfolio)
  scripts/          # build helpers + ops scripts
  tests/            # vitest unit/integration tests
  data/             # SQLite DB + caches (git-ignored)
  briefings/        # generated HTML briefings (git-ignored)
```

---

## Development

```bash
pnpm dev                # tsx watch on src/cli.ts (passes args after --)
pnpm typecheck          # tsc --noEmit
pnpm lint               # biome check
pnpm lint:fix           # biome check --write
pnpm format             # biome format --write
pnpm test               # vitest run
pnpm test:watch         # vitest --watch
pnpm test:coverage      # vitest run --coverage
pnpm build              # tsc -> dist/  (also copies SQL assets)
```

### Conventions

- **Strict TypeScript everywhere.** `noUncheckedIndexedAccess` is on.
- **Named exports only.** Default exports are banned.
- **No business logic in `cli.ts`.** It is a thin orchestrator.
- **All env access through `config`.** Never read `process.env` directly.
- **All LLM JSON validated by zod.** `LlmJsonValidationError` makes failures
  loud.

---

## Roadmap

| Phase | Theme                | Status        | Highlights                                                                 |
| ----- | -------------------- | ------------- | -------------------------------------------------------------------------- |
| 0     | Foundation           | ✅ shipped    | Repo scaffold, types, DB schema, CLI, LLM provider abstraction             |
| 1     | Ingest + enrich      | ✅ shipped    | NSE/Yahoo/Screener/RSS ingestors; SMA/EMA/RSI/ATR/volume/52W signals; HTML briefing |
| 2     | Screening + backtest | ✅ shipped    | JSON screen DSL; momentum / value / FII screens; first-class watchlist alerts; backtest harness with hit-rate / drawdown |
| 3     | AI layer             | ✅ shipped    | Anthropic/OpenAI/Cursor providers; sentiment enricher; thesis generator; LLM briefing narrative |
| 4     | Delivery             | planned       | Cron schedule (7:30 / 15:30 / Sat 8:00); Gmail / Slack / Telegram delivery |
| 5     | Real-time + Kite     | planned       | Kite Connect ingestor; intraday watchlist alerts; portfolio sync           |

---

## Disclaimer

> This software is provided for **personal research and educational use
> only**. It is **not** investment advice and is **not** a SEBI-registered
> research analyst product. The authors are not responsible for any
> financial decisions made using this software. **All trading decisions and
> their consequences are solely the user's responsibility.**

The system is designed to stay outside the SEBI Algo Trading framework: no
automated order routing, no signal redistribution, no third-party hosting of
your recommendations. Keep it that way.

---

## License

[MIT](LICENSE).
