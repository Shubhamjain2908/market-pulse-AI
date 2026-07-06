# Jules Code Review Rules for market-pulse-ai

## Overview
These rules guide Jules AI in reviewing pull requests for the market-pulse-ai stock analysis pipeline. Focus on architecture integrity, data consistency, security, and maintainability.

---

## 🔴 BLOCKING Issues (Must Fix Before Merge)

### Security & Secrets
- **Hardcoded credentials/secrets**: API keys, passwords, tokens in code → Move to `src/config/env.ts` + zod validation
- **Database security**: SQL injection via string concatenation → Use prepared statements only (`src/db/queries.ts`)
- **Env var leaks**: Reading `process.env` directly in features → Use typed config from `src/config/` instead
- **Sensitive data in logs/errors**: Error messages exposing internal state → Sanitize before returning

### Architecture & Data Integrity
- **Breaking pipeline contract**: Changes to stage inputs/outputs without migration → Pipeline stages must remain composable
- **Regime gate violations**: Changes to screen/thesis/strategy logic that ignore `regime_strategy_gate` → Verify gate is honored
- **Unvalidated DB writes**: Inserting to `quotes`, `fundamentals`, `signals` without atomicity → Use transactions, validate schemas
- **Non-append-only migrations**: Editing historical migrations in `src/db/migrations/` → Only add new migrations (append-only)
- **LLM provider abstraction broken**: Hardcoded LLM calls instead of factory pattern (`src/llm/factory.ts`) → Use `LlmProvider` interface

### Testing & Quality
- **Missing test for new logic**: Feature code without corresponding test → Add tests in nearest domain folder (`tests/agents/`, `tests/enrichers/`, etc.)
- **Test env not mocked**: LLM calls in tests without `LLM_PROVIDER=mock` → Use mock provider in `NODE_ENV=test`
- **Circular dependencies**: Import cycles between modules → Break with dependency injection or reorg

---

## 🟡 HIGH Priority Issues (Should Fix)

### Code Quality
- **Missing TypeScript types**: Any `any` types without justification → Add proper types or zod schemas
- **Unhandled promise rejections**: Async operations without try/catch → Wrap in error boundary
- **No error recovery**: Missing fallback logic for external API failures → Add retry/degraded-mode paths
- **Performance N+1**: Database queries in loops → Batch load or use JOIN
- **Large function**: Functions >50 lines doing multiple things → Extract into smaller functions

### Documentation
- **Config field not documented**: New env/config/LLM JSON fields without zod validation → Add zod schema + comment in `src/config/`
- **Architecture change undocumented**: Changes to pipeline/regime/screen behavior → Update `architecture-v2.md`, `db-schema.md`, or `guardrails.md`
- **No AGENTS.md update**: New agents/strategies added → Update `AGENTS.md` with mission, boundaries, and conventions

### Regime & Strategy Gating
- **Screen logic change**: Modifying screen selection without regime check → Verify `regime_strategy_gate` is respected
- **Thesis or strategy change**: New thesis or strategy logic → Confirm regime gates control its activation
- **Hardcoded regime assumption**: Strategy assuming a particular regime → Make behavior regime-aware

---

## 🟢 MEDIUM Priority Issues (Nice to Have)

### Performance & Efficiency
- **Unused imports**: Clean up dead code
- **Inefficient algorithm**: Prefer native/stdlib methods over custom loops
- **Repeated string/config lookups**: Cache config reads
- **Verbose error handling**: Simplify try/catch patterns

### Style & Naming
- **Named exports only**: No default exports (except for module entry points)
- **Descriptive function names**: `enrichSignal` > `process`, `filterByRegimeGate` > `filter`
- **Consistent comment style**: Only comment non-obvious logic, not every line
- **Kebab-case for IDs/tokens**: `pipeline_run_id`, `regime_strategy_gate` (not camelCase)

### DB Pattern
- **Prepared statements**: ✅ All queries in `src/db/queries.ts` use placeholders
- **Transaction wrapping**: Multi-step DB operations wrapped in transaction
- **Query result validation**: Explicit null/error checks, not silent failures

---

## 🔵 LOW Priority Issues (Consider)

- Suggestion for cleaner variable names
- Simplification opportunities
- Code reuse potential (if obvious)
- Non-critical performance micro-optimizations

---

## ✅ What to Skip

- **Test files**: Separate linting handles test quality
- **Generated/vendored code**: Skip auto-generated files (`dist/`, `.next/`, etc.)
- **Formatting**: Biome handles style; focus on logic
- **Comments**: Only flag missing comments for complex business logic

---

## 📋 Framework Conventions (market-pulse-ai Specific)

### Pipeline Architecture
- **Stage outputs**: Each stage writes to DB and appends to `pipeline_runs`
- **Replay-ready**: All outputs must be queryable by `(run_date, stage_name)`
- **Degradation**: If required stage (enrich, regime, screen) fails, briefing still composes from cached data
- **Closure mode**: Weekends/holidays skip ingest & fresh LLM, use persisted data

### Database Pattern
- **Prepared statements only**: No string interpolation in SQL
- **Transactions**: Multi-statement operations wrap in `BEGIN...COMMIT`
- **Schema validation**: Zod for all parsed data before DB insert
- **Append-only migrations**: `src/db/migrations/` never edited; new stages add new files

### LLM Integration
- **Factory pattern**: `src/llm/factory.ts` selects provider (cursor-agent, vertex, anthropic, openai, google-studio, mock)
- **Config-driven**: Provider selection from `src/config/loaders.ts`, not hardcoded
- **Mock in tests**: `NODE_ENV=test` + `LLM_PROVIDER=mock` for all test runs
- **Error degradation**: LLM failure → use cached/summary data, don't hard-fail

### Signal & Enrichment
- **Latest-per-signal lookup**: For mixed-frequency signals (daily + weekly), query by signal name + date range
- **Regime gates**: Strategy behavior keyed by `regime_strategy_gate`
- **Validation before store**: All enriched data passes zod schema before `INSERT INTO signals`

### Scheduler Consistency
- **Timing in code + docs**: Changes to `src/scheduler/market-scheduler.ts` sync with `README.md`
- **Kite auth at 08:30**: PM2 `kite-auth` auto-login weekdays (see `src/auth/kite-auth-server.ts`)
- **Asia/Kolkata TZ**: All schedule times in this zone

---

## 🎯 Review Focus Areas (Priority Order)

1. **Data Integrity** — Atomicity, schema validation, prepared statements
2. **Architecture** — Pipeline contract, regime gating, stage composition
3. **Security** — No secrets, no injection, sanitized errors
4. **Testing** — Coverage for new logic, LLM mocked in tests
5. **Documentation** — AGENTS.md, architecture docs, env/config validation
6. **Efficiency** — No N+1, no unused code, minimal abstractions

---

## 📝 Verdict Guidance

- **BLOCK** if: Security flaw, data corruption risk, architecture break, unvalidated env, breaking migration
- **WARN** if: High-priority issues, regime gate concern, missing test, doc gap
- **NIT** if: Low-priority style, performance edge case, non-critical cleanup

---

## Resources

- **Architecture**: `architecture-v2.md`, `AGENTS.md`, `guardrails.md`
- **DB**: `src/db/schema.sql`, `src/db/queries.ts`, `src/db/migrations/`
- **Config**: `src/config/env.ts`, `src/config/loaders.ts`
- **LLM**: `src/llm/types.ts`, `src/llm/factory.ts`
- **Scheduler**: `src/scheduler/market-scheduler.ts`
