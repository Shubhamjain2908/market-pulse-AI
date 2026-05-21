## Strict Guardrails

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
| **alreadyOwned filter** | Skip symbol in AI Picks if currently held in Kite portfolio **or** symbol has any OPEN `paper_trades` row (any signal type) | Thesis generator input preprocessing |
| **Corporate action nominal adjust** | Daily automated stage runs after ingest and before enrich; for OPEN `paper_trades` pulls Yahoo `splitHistory` over last 5 IST days and applies nominal divide exactly once via `INSERT OR IGNORE` + `run().changes` | `src/ingestors/corporate-actions.ts` |
| **Gap-down circuit breaker** | If session `open < (prior NSE EOD close × 0.70)`, skip stop-out + target checks for **that bar only**; still run persistence/time-stop and log with recent corporate-action context | `src/scripts/evaluate-trades.ts` |
| **Stale Kite holdings** | Kite-backed holdings whose snapshot `as_of` is before the expected NSE session (`lastOpenOnOrBefore(run date)`) → skip all portfolio LLM/lite; persist `HOLD` placeholders with `STALE_HOLDINGS` trigger; warn + briefing banner. Manual-only book skips this. | `src/agents/portfolio-analyser.ts`, `src/briefing/composer.ts`, `src/briefing/template.ts` |
| **Signals 90-day read window** | `signals` technical reads (screener DB provider + `getLatestSignals*`) require `date >= date(as_of, '-90 days')` on outer and inner query parts; zero rows → empty / null — no fallback to older rows | `src/analysers/signal-provider.ts`, `src/agents/portfolio-trigger.ts` |
| **Option A backtest regime gate** | Default **proxy**: quotes-only coarse regime (`regime-proxy.ts`), gate = ≥252 `NIFTY_50` rows before `--from`. **`--regime-source daily`**: ≥80% of benchmark trading days must have `regime_daily` (see `backtest-queries`). Momentum factors use `adj_close`-aligned series. Phase 1 initial-ATR sweep: `--sweep-initial-stop` / `--initial-multiplier` on `momentum-mf`. | `src/backtest/runner.ts`, `src/backtest/regime-proxy.ts` |
| **GTT activation** | No live GTT / order routing until all gates in `docs/gtt-activation-criteria.md` pass (post-fix tranche `source_date >= 2026-05-14`, per-signal expectancy floors, `BULL_TRENDING` at activation). Healthcheck logs tranche metrics daily; empty tranche does not fail the run. | `docs/gtt-activation-criteria.md`, `deploy/healthcheck.ts` |
| **momentum_mf initial stop** | Entry stop uses `position_sizing.atr_multiplier` from `momentum-config.json` (**2.5×** after Phase 1 sweep). Hard −8% floor (`entry × 0.92`) still binds. Re-enrich + `scripts/audit-atr-alignment.mts` before deploy after quote backfill. | `config/momentum-config.json`, `momentum-rebalance.ts` |
