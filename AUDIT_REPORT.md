# Production Audit Report: Market Pulse AI

This report outlines the deviations, gaps, and discrepancies found during a structured audit of the Market Pulse AI codebase against its system design documents.

## 1. Guardrail Enforcement

| Finding | File + Line | Severity | Spec vs. Code | Suggested Fix |
|---|---|---|---|---|
| **Deep loss threshold discrepancy** | `src/agents/portfolio-trigger.ts:16` | WARN | `guardrails.md` specifies a > 20% threshold, but the code (and `architecture-v2.md`) uses 15%. | Sync threshold to 20% in `getPortfolioDeepLossPct()` or update `guardrails.md`. |
| **Missing code-level guard for ADD pullback** | `src/agents/portfolio-analyser.ts` | WARN | `guardrails.md` Rule 9 (ADD pullback requirement) is only in the LLM prompt, whereas other rules have code-level enforcements. | Implement a code-level guard in `applyPortfolioAddGuardrails` to block ADD when price is within 2% of prior entry. |

## 2. Pipeline Ordering

- **Status**: **VERIFIED**.
- The sequence in `src/agents/daily-workflow.ts` exactly matches `Ingest → Corporate Actions → Enrich → Regime Classify → Screen → AI Thesis → Portfolio Evaluate → Briefing`.

## 3. Data Integrity

| Finding | File + Line | Severity | Spec vs. Code | Suggested Fix |
|---|---|---|---|---|
| **Premature Target Hit Exit** | `src/scripts/evaluate-trades.ts:251` | WARN | `architecture-v2.md` (§3.2 Step 6) requires `today_close >= target`, but code uses `bar.high >= trade.target`. | Change `hitTg` condition to use `bar.close >= trade.target`. |

## 4. Error Handling

- **LLM Retries**: **VERIFIED**. All providers use `generateJson` with retries (1-2) on parse failure.
- **Ingest Failures**: **VERIFIED**. Each capability is wrapped in `try/catch` and continues per spec.
- **Kite Token Graceful Skip**: **VERIFIED**. Pipeline continues if token is missing.

## 5. Dead Code & Spec Drift

| Finding | File + Line | Severity | Spec vs. Code | Suggested Fix |
|---|---|---|---|---|
| **Undocumented Feature (Live Scanner)** | `src/agents/live-scanner.ts` | INFO | Intraday scanning is fully implemented but not referenced in the `architecture-v2.md` pipeline flow. | Add "Live Scanner" to the Architecture Stage 3 documentation. |
| **Missing GTT Execution Module** | `architecture-v2.md` | WARN | GTT orders and activation requirements are specified, but no corresponding implementation exists. | Mark GTT module as "Unbuilt" in the roadmap or implement the trigger logic. |
| **Healthcheck Capability Drift** | `deploy/healthcheck.ts` | INFO | Spec says it scans for "pino errors", but implementation only looks for three specific hardcoded failure strings. | Enhance `scanPipelineLogsForTodayErrors` to genericly parse JSON pino levels ≥ 50. |
