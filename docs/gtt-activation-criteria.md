# GTT Activation Protocol & Performance Gates

## Operational Context
The system remains in GATED OBSERVE MODE. No live order routing parameters or GTT instructions shall be exposed in the briefing composer until all three chronological and mathematical gates are checked off sequentially.

## Phase Gates

### Gate 1: Post-Fix Tranche Size (Statistical Significance)
* **Rule**: Total closed paper trades must reach $\ge 30$ unique, deduplicated rows.
* **Chronological Filter**: `source_date >= '2026-05-14'`
* **Rationale**: Ensures validation occurs exclusively against data generated after the duplicate-block and array portfolio sync fixes were live.

### Gate 2: Net Expectancy Floor (Quality Constraints)
* **Rule**: Aggregate net expectancy of the post-fix sample must be $> +0.5\%$ per trade.
* **Bps Deductions**: Metrics are calculated net of a $20\text{ bps}$ round-trip cost assumption.
* **Per-Signal Floor Constraints**:
  * `AI_PICK`: Expectancy must be strictly positive ($> 0.0\%$).
  * `momentum_mf`: Expectancy must be strictly positive ($> 0.0\%$).
  * `PORTFOLIO_ADD`: Expectancy cannot drop below $-1.0\%$.

### Gate 3: Structural Regime Interlock
* **Rule**: The live `regime_daily` status must be strictly `BULL_TRENDING` at the exact moment of GTT activation.
* **Rationale**: Prevents accidental live activation inside high-risk or collapsing market regimes.
