# AGENTS.md

## Mission and Boundaries
- Build and maintain a personal NSE/BSE morning-briefing pipeline; this repo is **decision support only** (no order routing; preserve the safety boundary documented in `README.md`).
- Keep stage outputs DB-backed and rerunnable for replay/debug (`src/db/schema.sql`, `src/cli.ts`).

## Core Architecture
- Main orchestration is `runDailyWorkflow` in `src/agents/daily-workflow.ts`: optional portfolio sync + stop-loss -> ingest -> enrich -> regime -> gated screens -> sentiment/thesis (if AI enabled) -> briefing -> paper-trade evaluation.
- `src/cli.ts` stays thin command wiring; domain logic belongs under `src/agents`, `src/analysers`, `src/enrichers`, `src/strategies`.
- Market-closure mode is first-class: weekends/holidays skip ingest and fresh LLM calls but still compose a persisted-data briefing.

## Data and Integration Boundaries
- SQLite is the integration bus: ingestors write `quotes`/`fundamentals`/`news`/`fii_dii`, enrichers write `signals`, analysers write `screens`.
- DB pattern is explicit prepared statements + transactions (no ORM) in `src/db/queries.ts`.
- Migrations are append-only SQL in `src/db/migrations`; `schema.sql` is base migration in `src/db/migrate.ts`.
- LLM abstraction is `LlmProvider` (`src/llm/types.ts`); provider selection is centralized in `src/llm/factory.ts`.
- External surfaces: market data (`free` Yahoo/NSE/Screener or Kite), delivery (`file`/`email`/`slack`/`telegram`), providers (`cursor-agent`, `vertex`, `anthropic`, `openai`, `google-studio`, `mock`).

## Project Conventions
- Validate env/config/LLM JSON with zod (`src/config/env.ts`, `src/config/loaders.ts`); avoid unvalidated parsing paths.
- Never read `process.env` in feature code; use typed `config`.
- Keep named exports (no default exports).
- Respect regime gates (`regime_strategy_gate`) when changing screen/thesis/strategy behavior.
- For mixed-frequency signals (daily technical + weekly momentum), preserve latest-per-signal-name lookups (see momentum notes in `README.md`).

## Change Checklist for Agents
- Keep `src/cli.ts` thin; put behavior changes in stage/agent modules, not command handlers.
- If adding config/env/LLM JSON fields, add zod validation in `src/config/env.ts` or `src/config/loaders.ts` first.
- If changing screen/thesis/strategy behavior, verify regime-gated behavior still honors `regime_strategy_gate`.
- If changing schedules in `src/scheduler/market-scheduler.ts`, mirror timing/docs updates in `README.md`.
- If changing persistence, add an append-only SQL migration in `src/db/migrations` (do not edit historical migration files).
- Before handoff: run `pnpm typecheck && pnpm test && pnpm lint`.

## High-Value Workflows
- Bootstrap: `pnpm install`, `pnpm migrate`, `pnpm cli doctor`.
- Main runs: `pnpm daily`, `pnpm daily --skip-ai`, `pnpm cli run-all`.
- Stage debugging: `pnpm cli ingest -d YYYY-MM-DD`, `pnpm cli enrich -d YYYY-MM-DD`, `pnpm cli regime -d YYYY-MM-DD --no-narrative`, `pnpm cli screen -d YYYY-MM-DD`, `pnpm cli brief -d YYYY-MM-DD --skip-ai`.
- Quality gate before handoff: `pnpm typecheck && pnpm test && pnpm lint`.

## Scheduler and Tests
- Scheduler in `src/scheduler/market-scheduler.ts` (Asia/Kolkata): weekdays 09:15/15:30, Saturday 08:00, Sunday 06:00 earnings refresh, Sunday 08:00 momentum rebalance + skip-AI briefing delivery.
- Keep schedule changes synchronized between code and docs in `README.md`.
- Tests default to `NODE_ENV=test` and `LLM_PROVIDER=mock` (`tests/setup.ts`); add tests in the nearest domain folder for gating/briefing-sensitive changes.
