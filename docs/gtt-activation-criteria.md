# GTT Activation Criteria

## Status

**No order routing exists today.** This document defines the gates that must pass
before any live Good-Till-Triggered (GTT) order routing can be enabled. The system
remains in observe-only mode until all gates pass.

## Activation Gates

### Gate 1: Post-fix Cohort Maturity

- At least **30 closed paper trades** with `source_date >= 2026-05-14` (post-fix cohort).
- Evaluation is per `signal_type`, not pooled across types.
- The cohort must contain trades from at least 2 distinct `signal_type` values.

### Gate 2: Positive Expectancy

- **Average return after estimated costs** (20 bps round-trip) must be **positive**
  for the candidate `signal_type`.
- **Profit factor** must exceed **1.2** for the candidate `signal_type`.

### Gate 3: No Unresolved Contradictions

- No open critical thesis/action contradictions in the portfolio analysis ledger.
- Sample audit must show **no stale-price admissions** — all candidates in the
  post-fix cohort had `PRICED` status at entry.
- Sample audit must show **no event-blackout admissions** — no AI_PICK was
  admitted while `mom_earnings_blackout = 1` or `mom_earnings_blackout` was stale.

### Gate 4: Regime Condition

- Activation occurs only when `regime_daily` reports **BULL_TRENDING**.
- First activation uses a **capped experimental sleeve** (e.g., max 20% of
  paper portfolio value).
- A failed gate returns the system to **observe-only mode** — no automatic retry.

## Monitoring

`deploy/healthcheck.ts` currently reports per-signal-type metrics on every run
but does **not** enforce activation. See healthcheck logs for:

- Post-fix closed trade counts per `signal_type`
- Weighted and unweighted expectancy
- Profit factor per signal type
