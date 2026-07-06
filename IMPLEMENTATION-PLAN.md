# Market Pulse AI — Signal Quality & Investment Improvement Plan

**Owner:** Shubham  
**Status:** Ready for implementation  
**Last updated:** 2026-07-05  
**For:** Junior developer onboarding — all context is self-contained in this document.

---

## Background: Why this plan exists

We ran a research cycle using ftinvstr (a quantitative backtesting MCP) to stress-test the existing
`quality_garp` screen logic against live strategy data. Three backtests were run:

| Backtest | Expression | Universe | CAGR | Sharpe | Max DD | Verdict |
|---|---|---|---|---|---|---|
| **v1** | Hard-AND gates, ROCE rank only | NIFTY500 | ~2% | −0.2 | −45% | Broken — universe starvation |
| **v2** | Hard-AND gates + 14d RSI proxy | NIFTY500 | 2.6% | −0.22 | −45% | Broken — same root cause |
| **v3** | Soft rank: ROCE+ROE+FCF+60d reversal | NIFTY200 | 13.6% | 0.46 | −34% | Directionally correct, 3 fixable issues |

Key finding from v3: the strategy **beat DCF_Compounder_Stack** (Sharpe 1.06) in 7 of 12 months in
2024, beat it in 2023/2024/2025 year-on-year, but dragged on full-period CAGR due to:
1. 2018–2019 structural decliners passing the dip gate (NBFC-era names)
2. 2020 missing the quality-growth rip (+22.9% vs +52.9%)
3. Two micro-cap leakages (RNBDENIMS, DRC Systems) inside NIFTY200

These findings map directly to three concrete pipeline improvements below.

---

## System map — read this first

```
daily-workflow.ts (orchestrator)
├── ingest          → quotes, fundamentals, quarterly_fundamentals, news, fii_dii
├── enrich          → signals table (technical + momentum enrichers)
│   ├── technical/enricher.ts → sma_20/50/200, ema_9/21, rsi_14, atr_14,
│   │                           volume_ratio_20d, pct_from_52w_high/low,
│   │                           pct_above_sma200, sma200_slope_30d_pct,
│   │                           weinstein_stage_code, weinstein_stage_score, close
│   └── momentum-signals.ts  → mom_121_return_pct, rs_beta_adjusted_63d,
│                              volume_breakout_flag, earnings_blackout_flag
├── regime          → regime_daily table
│   └── regime-classifier.ts → BULL_TRENDING | CHOPPY | BEAR_TRENDING | CRISIS
│                              via 8 sub-scores (trend/VIX/FII/breadth)
│                              + 3-day persistence rule
├── screens         → screens table (screen_name = 'quality_garp')
│   └── quality-garp-screen.ts → 12 sequential hard-AND gates
│       Thresholds in quality-garp.ts:
│         PE ≤ 35, PB ≤ 6, ROE ≥ 18% (3yr), ROCE ≥ 20%, D/E < 0.5,
│         PEG ≤ 1.2, RSI ≤ 45, SMA50 ±5%, pledge ≤ 15%, OPM stddev ≤ 5%
└── briefing        → reads screens + signals + regime → markdown output
```

**Key tables:**

| Table | Written by | Key columns |
|---|---|---|
| `signals` | technical/momentum enrichers | symbol, date, name, value, source |
| `fundamentals` | yahoo/screener ingestor | pe, pb, peg, roe, roce, debt_to_equity, market_cap, profit_growth_yoy |
| `quarterly_fundamentals` | screener ingestor | quarter_end, revenue, operating_profit, opm_pct, net_profit, eps, operating_cash_flow, free_cash_flow |
| `regime_daily` | regime-classifier | regime, scoreTotal, scoreTrend, scoreVix, scoreFii, scoreBreadth |
| `screens` | quality-garp-screen, engine | symbol, date, screen_name, score, matched_criteria JSON |

**Key files you will touch:**

| File | What it does |
|---|---|
| `src/analysers/quality-garp.ts` | Gate threshold constants + funnel types |
| `src/analysers/quality-garp-screen.ts` | `evaluateQualityGarpSymbol()` — the 12-gate waterfall |
| `src/db/queries.ts` | All DB query functions |
| `src/db/migrations/` | Append-only SQL migrations (never edit existing files) |
| `src/enrichers/` | Enricher modules — write to `signals` table |
| `src/agents/daily-workflow.ts` | Stage orchestration |
| `strategy-backlog.md` | Keep this updated with decisions |

**Project conventions (non-negotiable):**
- No `process.env` in feature code — use typed `config` from `src/config/env.ts`
- All new env/config fields require Zod validation first
- New DB columns → new migration file in `src/db/migrations/` (e.g. `0029_foo.sql`)
- Named exports only, no default exports
- Before every PR: `pnpm typecheck && pnpm test && pnpm lint`
- Update `architecture-v2.md`, `db-schema.md`, `guardrails.md` for any architectural changes

---

## Work items — priority order

> **Reviewed 2026-07-05** against live code + Claude.ai adversarial review.
> Sequencing and several specifics revised as a result — see notes on each item.

---

### ITEM 1 — Regime-aware GARP screen thresholds

**Priority:** HIGH — split into two sub-tasks (architecture now, numbers later)  
**Effort:** ~2h architecture + ~1h calibration (after audit)  
**Files:** `src/analysers/quality-garp.ts`, `src/analysers/quality-garp-screen.ts`

#### Pre-condition check (do this before any code changes)

The live system has 12 gates. Gate 12 (pledge) is **shadow-only** by default
(`QUALITY_GARP_PLEDGE_GATE=0`). Gate 11 is OPM stability. This matches what the code says.
The gate arithmetic below (adding gate 13 for QDS in Item 2) is therefore correct.

**ITEM 1 is split into two sub-tasks:**

- **1a (ship now):** The `GarpThresholds` interface + `resolveGarpThresholds()` function +
  threading thresholds through `evaluateQualityGarpSymbol`. This is pure architecture —
  zero behaviour change because CHOPPY (default) returns the existing constants unchanged.
- **1b (ship after audit):** Fill in the actual BULL/BEAR/CRISIS threshold values.
  These values **must** come from running `pnpm cli fundamental-screen-audit` across
  6 months of screen history, segmented by regime, to see the empirical pass-rate impact.
  The starting values below are hypotheses from ftinvstr analysis — treat them as placeholders,
  not calibrated numbers. Replace them after the audit.

#### Why

The current screen has static thresholds (RSI ≤ 45, SMA50 ±5%) regardless of market regime.
These thresholds were calibrated for a single regime. When `regime = BEAR_TRENDING`, a stock
needs to be in a DEEPER dip to be a genuine mean-reversion candidate vs noise. When
`regime = BULL_TRENDING`, the RSI gate is too tight — good quality names rarely reach RSI 45
in a bull, so the screen outputs near-zero results on most days.

Backtest evidence: v3 used the same thresholds in all regimes and the 2018–2019 NBFC-era
problem (structural decliners passing the dip gate) is exactly the regime-unaware problem —
in a bear market, "near SMA50" is noise, not a dip.

The `regime` is already passed into `runQualityGarpScreen` as an optional param and is
available on the `opts` object. It just isn't used to modify the thresholds.

#### What to build

Add a helper function `resolveGarpThresholds(regime)` in `quality-garp.ts` that returns
threshold overrides by regime. Call it inside `runQualityGarpScreen` and thread the resolved
thresholds into `evaluateQualityGarpSymbol`.

**Threshold table:**

| Gate | BULL_TRENDING | CHOPPY (current) | BEAR_TRENDING | CRISIS |
|---|---|---|---|---|
| RSI max | 55 | 45 | 40 | 35 |
| SMA50 % max | 8% | 5% | 3% | 0% (at or below SMA50 only) |
| PEG max | 1.4 | 1.2 | 1.0 | 0.9 |
| PE max | 40 | 35 | 28 | 22 |

Rationale for each:
- **RSI in bull:** Quality names trade at higher RSI structurally. RSI 55 in a bull is a
  mild pullback. RSI 45 in a bull means something is wrong — you want RSI 45 as the entry
  signal, but only allow it when market confirms it's not a broad decline.
- **SMA50 in bear:** Being within 5% of SMA50 in a bear means the stock is basically
  tracking the falling SMA. You want it AT or BELOW SMA50, not just "near" it.
- **PEG/PE in bear:** In bear/crisis markets, growth estimates get cut. A PEG of 1.2 on
  stale estimates becomes 1.8+ when estimates are revised down. Tighten PEG to 1.0 in bear.

#### Exact implementation steps

**Step 1a — Architecture (ship now, zero behaviour change):**

In `src/analysers/quality-garp.ts`, add after the existing threshold constants:

```typescript
export interface GarpThresholds {
  peMax: number;
  pbMax: number;    // keep at 6, don't vary
  roeMin: number;   // keep at 0.18, don't vary
  roceMin: number;  // keep at 0.20, don't vary
  deMax: number;    // keep at 0.5, don't vary
  pegMax: number;
  rsiMax: number;
  sma50PctMax: number;
  opmStdDevMax: number; // keep at 5.0, don't vary
}

export function resolveGarpThresholds(regime?: Regime): GarpThresholds {
  switch (regime) {
    case 'BULL_TRENDING':
      return {
        peMax: 40, pbMax: QUALITY_GARP_PB_MAX,
        roeMin: QUALITY_GARP_ROE_MIN, roceMin: QUALITY_GARP_ROCE_MIN,
        deMax: QUALITY_GARP_DE_MAX, pegMax: 1.4,
        rsiMax: 55, sma50PctMax: 8,
        opmStdDevMax: OPM_STD_DEV_MAX_PCT,
      };
    case 'BEAR_TRENDING':
      return {
        peMax: 28, pbMax: QUALITY_GARP_PB_MAX,
        roeMin: QUALITY_GARP_ROE_MIN, roceMin: QUALITY_GARP_ROCE_MIN,
        deMax: QUALITY_GARP_DE_MAX, pegMax: 1.0,
        rsiMax: 40, sma50PctMax: 3,
        opmStdDevMax: OPM_STD_DEV_MAX_PCT,
      };
    case 'CRISIS':
      return {
        peMax: 22, pbMax: QUALITY_GARP_PB_MAX,
        roeMin: QUALITY_GARP_ROE_MIN, roceMin: QUALITY_GARP_ROCE_MIN,
        deMax: QUALITY_GARP_DE_MAX, pegMax: 0.9,
        rsiMax: 35, sma50PctMax: 0,
        opmStdDevMax: OPM_STD_DEV_MAX_PCT,
      };
    default: // CHOPPY or undefined — existing behaviour
      return {
        peMax: QUALITY_GARP_PE_MAX, pbMax: QUALITY_GARP_PB_MAX,
        roeMin: QUALITY_GARP_ROE_MIN, roceMin: QUALITY_GARP_ROCE_MIN,
        deMax: QUALITY_GARP_DE_MAX, pegMax: QUALITY_GARP_PEG_MAX,
        rsiMax: QUALITY_GARP_RSI_MAX, sma50PctMax: QUALITY_GARP_SMA50_PCT_MAX,
        opmStdDevMax: OPM_STD_DEV_MAX_PCT,
      };
  }
}
```

**Step 1b — Calibration (do AFTER running the screen history audit):**

Run `pnpm cli fundamental-screen-audit -d YYYY-MM-DD` for each of the last 6 months.
Segment results by the `regime` column in `regime_daily`. For each regime bucket, look at
how many symbols were eliminated by the `rsi` gate and `sma50` gate. If BULL_TRENDING
days show >80% RSI eliminations (RSI 45 is too tight in bull), raise the threshold.
If BEAR_TRENDING shows symbols passing SMA50 that are clearly in downtrends, tighten it.
Replace the placeholder values in `resolveGarpThresholds` with the audit-derived values.

**Step 2:** In `src/analysers/quality-garp-screen.ts`, in `runQualityGarpScreen`:

Replace the call to `evaluateQualityGarpSymbol` with a version that accepts thresholds.
Add one line before the loop:

```typescript
const thresholds = resolveGarpThresholds(regime);
```

Then thread `thresholds` into `evaluateQualityGarpSymbol(symbol, date, fundamental,
provider, etfExclusions, opmStdDev, db, thresholds)`.

**Step 3:** In `evaluateQualityGarpSymbol`, replace every direct reference to a threshold
constant with the equivalent field from `thresholds`:

- `QUALITY_GARP_PE_MAX` → `thresholds.peMax`
- `QUALITY_GARP_PB_MAX` → `thresholds.pbMax`
- `QUALITY_GARP_ROE_MIN` → `thresholds.roeMin`
- `QUALITY_GARP_ROCE_MIN` → `thresholds.roceMin`
- `QUALITY_GARP_DE_MAX` → `thresholds.deMax`
- `QUALITY_GARP_PEG_MAX` → `thresholds.pegMax`
- `QUALITY_GARP_RSI_MAX` → `thresholds.rsiMax`
- `QUALITY_GARP_SMA50_PCT_MAX` → `thresholds.sma50PctMax`
- `OPM_STD_DEV_MAX_PCT` → `thresholds.opmStdDevMax`

**Step 4:** Add the active thresholds to `matched_criteria` in the output so the briefing
can show which regime-adjusted thresholds fired. In `QualityGarpMatchedCriteria`, add:

```typescript
regime_thresholds: { rsiMax: number; sma50PctMax: number; peMax: number; pegMax: number };
```

**Step 5:** Add a test in `tests/analysers/quality-garp-thresholds.test.ts`:

```typescript
// Verifies the resolver returns correct values per regime.
// No DB needed — pure function.
describe('resolveGarpThresholds', () => {
  it('BULL_TRENDING relaxes RSI to 55 and PE to 40', () => {
    const t = resolveGarpThresholds('BULL_TRENDING');
    expect(t.rsiMax).toBe(55);
    expect(t.peMax).toBe(40);
    expect(t.sma50PctMax).toBe(8);
  });
  it('BEAR_TRENDING tightens RSI to 40 and PEG to 1.0', () => {
    const t = resolveGarpThresholds('BEAR_TRENDING');
    expect(t.rsiMax).toBe(40);
    expect(t.pegMax).toBe(1.0);
  });
  it('CHOPPY (undefined) returns baseline constants', () => {
    const t = resolveGarpThresholds(undefined);
    expect(t.rsiMax).toBe(QUALITY_GARP_RSI_MAX);   // 45
    expect(t.peMax).toBe(QUALITY_GARP_PE_MAX);       // 35
  });
});
```

**Step 6:** Update `strategy-backlog.md` — add a "Shipped" section for this item.

#### What NOT to do

- Do not change the OPM stddev, ROE, ROCE, D/E, or PB thresholds by regime — these are
  fundamental quality floors, not timing signals. Varying them by regime would let junk
  through in bad markets.
- Do not add a new DB migration for this change — no schema changes needed.
- Do not touch `regime_strategy_gate` table — that controls whether the screen RUNS at all
  in a given regime, not what thresholds it uses.

---

### ITEM 2 — Piotroski-style Quality Decay Score (QDS)

**Priority:** HIGH — but sequenced: audit script first, gate second  
**Effort:** ~1h audit script + ~4h gate implementation  
**Files:** `src/db/queries.ts`, `src/analysers/quality-garp-screen.ts`, `src/analysers/quality-garp.ts`

#### Why

The current screen passes/fails on the LATEST annual fundamentals snapshot. A company can
have ROCE 22%, ROE 20% on trailing data while in the current quarter its operating profit
is shrinking, FCF is turning negative, and revenue growth is decelerating. The screen has
no awareness of this trajectory.

Piotroski F-Score (academic, 1990) is a 9-point binary scoring system that detects exactly
this: profitability trend, leverage trend, and operational efficiency trend — all from
quarterly data. We already have all the inputs we need in `quarterly_fundamentals`:
`net_profit`, `revenue`, `opm_pct`, `operating_cash_flow`, `free_cash_flow`.

We cannot compute all 9 Piotroski signals (missing current_ratio, gross_margin separate
from OPM, asset_turnover) but we can compute 6 of the 9 that matter most. Call it
**Quality Decay Score (QDS)**: a 0–6 integer where 6 = healthy trajectory, 0 = all signals
deteriorating.

#### The 6 signals (each scores 1 if condition met, 0 if not)

| Signal | Condition (scores 1) | Data source |
|---|---|---|
| **P1: Net profit positive** | `net_profit_q_latest > 0` | `quarterly_fundamentals.net_profit` |
| **P2: Net profit improving** | `net_profit_q_latest > net_profit_q_4ago` (YoY quarterly) | same |
| **P3: OCF positive** | `operating_cash_flow_latest > 0` | `quarterly_fundamentals.operating_cash_flow` |
| **P4: OCF > Net profit** (accruals check) | `ocf_latest > net_profit_latest` | same |
| **P5: OPM improving** | `opm_pct_q_latest > opm_pct_q_4ago` | `quarterly_fundamentals.opm_pct` |
| **P6: Revenue improving** | `revenue_q_latest > revenue_q_4ago` | `quarterly_fundamentals.revenue` |

**Gate rule (added to GARP screen):**
- QDS ≤ 2 → hard block (fundamental decay, do not pass regardless of price signal)
- QDS 3–4 → soft warning (passes screen but `matched_criteria` includes `qds_warning: true`)
- QDS 5–6 → healthy, proceed normally

**Why these 6 specifically:**
- P1+P2: catches a company that WAS profitable but is deteriorating now
- P3+P4: catches earnings manipulation — if OCF < net profit consistently, profits are
  accrual-based, not cash-backed. This is the strongest single fraud indicator.
- P5: OPM trend catches margin compression before it hits annual ROCE
- P6: revenue trend catches top-line deterioration before it reaches net profit

#### Exact implementation steps

**Step 0 (mandatory first — do not skip):** Write `scripts/audit-qds-coverage.mts` and run it.

This script must output, for every symbol in the `quality_garp` universe (241 symbols):
- How many quarters of `quarterly_fundamentals` data are available
- For symbols with ≥5 quarters: compute the 6 QDS signals and the resulting score
- Print a distribution: how many symbols score 0, 1, 2, 3, 4, 5, 6
- Print coverage: what % of the 241-symbol universe has ≥5 quarters available

Use this distribution to pick the hard-block threshold. If the median score is 4,
then `≤ 2` as a block leaves a reasonable margin. If the median is 3, blocking at `≤ 2`
might pass very few symbols. Adjust the threshold to be the P10 of the actual distribution
(meaning only the bottom 10% of the universe gets blocked — equivalent to what B-ENG-11
did with OPM at P80). Do not pick `≤ 2` without this data.

**Step 1:** Add `getQualityDecayScore` in `src/db/queries.ts`:

```typescript
export interface QualityDecayResult {
  score: number;        // 0–6
  signals: {
    netProfitPositive: boolean;
    netProfitImproving: boolean;
    ocfPositive: boolean;
    ocfExceedsNetProfit: boolean;
    opmImproving: boolean;
    revenueImproving: boolean;
  };
  quartersAvailable: number; // how many quarters we had (for audit)
}

export function getQualityDecayScore(
  symbol: string,
  asOf: string,
  db: DatabaseType = getDb(),
): QualityDecayResult | null {
  // Need at least 5 quarters to compute YoY comparisons (current + 4 quarters ago)
  const rows = db.prepare(`
    SELECT quarter_end, net_profit, operating_cash_flow, opm_pct, revenue
    FROM quarterly_fundamentals
    WHERE symbol = ? AND quarter_end <= ?
    ORDER BY quarter_end DESC
    LIMIT 5
  `).all(symbol, asOf) as Array<{
    quarter_end: string;
    net_profit: number | null;
    operating_cash_flow: number | null;
    opm_pct: number | null;
    revenue: number | null;
  }>;

  if (rows.length < 5) return null;  // fail-open: skip gate if insufficient data

  const latest = rows[0];
  const yearAgo = rows[4];   // index 4 = 4 quarters back = YoY

  const netProfitPositive = latest.net_profit != null && latest.net_profit > 0;
  const netProfitImproving =
    latest.net_profit != null && yearAgo.net_profit != null
      ? latest.net_profit > yearAgo.net_profit
      : false;
  const ocfPositive = latest.operating_cash_flow != null && latest.operating_cash_flow > 0;
  const ocfExceedsNetProfit =
    latest.operating_cash_flow != null && latest.net_profit != null
      ? latest.operating_cash_flow > latest.net_profit
      : false;
  const opmImproving =
    latest.opm_pct != null && yearAgo.opm_pct != null
      ? latest.opm_pct > yearAgo.opm_pct
      : false;
  const revenueImproving =
    latest.revenue != null && yearAgo.revenue != null
      ? latest.revenue > yearAgo.revenue
      : false;

  const signals = {
    netProfitPositive, netProfitImproving,
    ocfPositive, ocfExceedsNetProfit,
    opmImproving, revenueImproving,
  };
  const score = Object.values(signals).filter(Boolean).length;

  return { score, signals, quartersAvailable: rows.length };
}
```

**Step 2:** Add `'qds'` to `QualityGarpFailGate` union type in `quality-garp.ts`:

```typescript
export type QualityGarpFailGate =
  | 'etf_exclusion' | 'no_fundamentals' | 'valuation_null' | 'valuation'
  | 'roe_3yr' | 'roce' | 'debt' | 'peg_null' | 'peg' | 'rsi' | 'sma50'
  | 'promoter' | 'pledge' | 'opm_stability'
  | 'qds';   // ← add this
```

Add to `QualityGarpFunnelCounts`:

```typescript
qds: number;           // hard fail (QDS ≤ 2)
qds_warning: number;   // soft warn (QDS 3–4)
qds_skipped: number;   // insufficient quarters (< 5)
```

Add to `createEmptyQualityGarpFunnel()`:

```typescript
qds: 0,
qds_warning: 0,
qds_skipped: 0,
```

**Step 3:** In `quality-garp-screen.ts`, inside `evaluateQualityGarpSymbol`, add the QDS
gate AFTER the OPM stability gate (it is the last gate — most expensive, run last):

```typescript
// Gate 13: Quality Decay Score
const qdsResult = getQualityDecayScore(symbol, date, db);
if (qdsResult == null) {
  funnel.qds_skipped++;
  // fail-open: insufficient data, don't penalise
} else if (qdsResult.score <= 2) {
  return {
    passed: false,
    score: gateScore(matchedCount),
    matchedCount,
    failedGate: 'qds',
  };
} else {
  matchedCount++;
  if (qdsResult.score <= 4) {
    // soft warning — passes but flags
    return {
      ...passResult,
      matchedCriteria: {
        ...passResult.matchedCriteria,
        qds_score: qdsResult.score,
        qds_warning: true,
        qds_signals: qdsResult.signals,
      },
    };
  }
}
```

> Note: `passResult` is how the existing code assembles the passing evaluation object.
> Look at how gate 12 (OPM) currently returns the pass case and follow the same pattern.

**Step 4:** Update `QUALITY_GARP_TOTAL_GATES` from 12 to 13 in `quality-garp.ts`.

**Step 5:** Add `qds_score`, `qds_warning`, `qds_signals` to `QualityGarpMatchedCriteria`
interface (all optional):

```typescript
qds_score?: number;
qds_warning?: boolean;
qds_signals?: Record<string, boolean>;
```

**Step 6:** Add a test in `tests/analysers/quality-decay-score.test.ts`:

```typescript
// Uses a real DB fixture with quarterly data, or mocks getQualityDecayScore.
// The important case: a company with OCF < net_profit for 2 straight quarters
// should score ≤ 4 (missing P4 + likely P1/P2 also weak).
describe('getQualityDecayScore', () => {
  it('returns null for < 5 quarters', () => { ... });
  it('scores 6 for all-healthy signals', () => { ... });
  it('scores 0 when all signals are negative', () => { ... });
  it('OCF < net_profit reduces score by 1', () => { ... });
});
```

**Step 7:** Update `strategy-backlog.md` with a "Shipped" entry.

#### What NOT to do

- Do not add a new DB migration — QDS is computed at screen time from existing data,
  no new column needed. If you want to cache it, add a `signals` row with
  `source='fundamental'` and `name='qds_score'` — but only do this if it shows up as
  slow (it queries 5 rows per symbol, ~241 symbols = 1,205 rows, well within SQLite perf).
- Do not gate on QDS during CRISIS regime — in a crisis, even good companies show OCF
  deterioration. The CRISIS regime should bypass the QDS gate entirely (add
  `if (regime === 'CRISIS') skip QDS` at the top of that block).

---

### ITEM 3 — ftinvstr cross-validation in briefing

**Priority:** MEDIUM — ship first (lowest risk), but rescoped from original plan  
**Effort:** ~3 hours  
**Files:** `src/config/ext-signal-provider.json`, `src/scripts/ext-signal-cross-ref.ts`, briefing template

> **Architecture correction from adversarial review:** The original plan wrote into
> `screens.matched_criteria`, which breaks the isolation principle for third-party
> dependencies. The correct pattern already exists: `ext_signal_holdings` table +
> `ext-signal-holdings-ingestor.ts` + `pnpm cli ext-signal-cross-ref`. Use that.
>
> **Holdings quality correction:** `HUNT2_FCF_Acceleration` was in the original list of 5
> strategies. Its current holdings include penny stocks (BESTAGRO ₹15.98, RAJMET ₹3.69,
> KHANDSE ₹17.65) — the same failure mode that caused prior strategy rejections (2026-06-28).
> It is removed. Do not add it back without a fresh holdings check.
>
> **Starting strategy:** `DCF_Compounder_Stack` only. It has been manually verified:
> current holdings are TCS, INFY, ITC, BAJAJ-AUTO, HDFCBANK, WIPRO — liquid, quality names.
> Any additional strategy requires manual top-10 holdings check before adding to the config.

#### Why

The `ext_signal_holdings` table and `ext-signal-holdings-ingestor.ts` already pull ftinvstr
holdings into an isolated DB table daily. The `pnpm cli ext-signal-cross-ref` script already
computes overlaps. This item wires that existing data into the briefing output — it does not
build new infrastructure.

When a stock passes the GARP screen AND appears in `ext_signal_holdings` for a verified
strategy, the briefing surfaces: `[ext: confirmed by DCF_Compounder_Stack]`.

#### What to build

**Step 1:** In `config/ext-signal-provider.json`, verify `DCF_Compounder_Stack` is the
configured strategy (or add it). This is the only strategy to start with. Any addition
requires a manual `get_holdings` check first — verify the top 10 positions are liquid,
named stocks (not penny stocks or micro-caps).

**Step 2:** The `ext-signal-cross-ref.ts` script already queries `ext_signal_holdings`.
Read it to understand the output shape. The briefing template needs to read from
`ext_signal_holdings` for today's date and the passing GARP symbols, then annotate the
briefing with `[ext: N strategies]` where N > 0.

**Step 3:** In the briefing composer (wherever GARP screen results are rendered), add a
lookup against `ext_signal_holdings`:

```typescript
// After loading today's quality_garp passes:
const extConfirmed = db.prepare(`
  SELECT symbol, strategy_name
  FROM ext_signal_holdings
  WHERE symbol IN (${placeholders}) AND as_of >= date(?, '-3 days')
`).all(...garpSymbols, today);

const confirmationMap = Map<string, string[]>;
for (const row of extConfirmed) {
  // build symbol → [strategy_name, ...] map
}
```

Gate the annotation behind the existing `EXT_SIGNAL_ENDPOINT` / `EXT_SIGNAL_API_KEY`
env vars — if those are unset, ext-signal ingest is skipped and the table will be empty,
so no annotation appears. No new env var needed.

**Step 4:** Test: if `ext_signal_holdings` is empty for today (e.g. ingest failed),
briefing renders normally with no annotation. Never fail-hard on missing ext-signal data.

#### What NOT to do

- **Do not write into `screens.matched_criteria`** — that table is owned by the pipeline's
  own deterministic computation. External signal data belongs in `ext_signal_holdings`.
- **Do not add `HUNT2_FCF_Acceleration`** — its holdings contain penny stocks (verified live
  2026-07-05). Sharpe alone is not a sufficient inclusion criterion.
- **Do not add strategies without a manual holdings check.** The selection criterion is:
  Sharpe > 0.85 AND top-10 holdings are all liquid named stocks. Check holdings live via
  `get_holdings(strategy_name=...)` before adding any name to the config.

---

## ftinvstr backtest slots — what to run next month

We ran 3 backtests this month (v1/v2/v3). 3 slots remain. Here is the allocation plan:

### Slot 4 (queued now): Pure quality baseline on NIFTY200

**Job ID:** `mcp_9adec751adfa42cb`  
**Strategy:** `mcp_u279_mp_pure_quality_nifty200_1783278790`  
**Expression:** `0.40 × ROCE + 0.35 × ROE + 0.25 × FCF` — soft ranking, no dip signal  
**Universe:** NIFTY200, monthly, 20 positions, 2018–2026  
**Question it answers:** Does pure quality on NIFTY200 match DCF_Compounder_Stack (Sharpe
1.06, CAGR 25%)? If yes, it tells us the pipeline's fundamentals-first GARP screen is
directionally correct and the dip signal is the differentiator, not a distraction.

### Slot 5 — COMPLETE: Dip signal on NIFTY100

**Job ID:** `mcp_a088afe1b4bf41b7` — **DONE**  
**Result:** CAGR 11.7%, Sharpe 0.35, Max DD −36.6% — **worse than NIFTY200**

NIFTY100 was expected to eliminate micro-cap leakers. It did not. Current holdings still
include HARIOMPIPE (5.56%), JARO (5.23%), AARON Industries (5.01%), ABINFRA (4.97%),
RNBDENIMS (4.40%). The ftinvstr NIFTY100 universe definition includes more names than the
NSE index and the 3-factor expression selects them regardless of universe restriction.

**Confirmed conclusion: universe restriction is NOT the fix. The 3-factor expression
(ROCE+ROE+FCF) is too easy to game by small companies with inflated ratios from low
capital bases. OPM is the missing factor.**

### Slot 6 — RESERVE for August

**Do NOT spend this month.** The backtesting research has reached a clear conclusion:

| What we proved | Evidence |
|---|---|
| Soft-rank > hard-AND gates | v1/v2 (Sharpe −0.22) vs v3 (Sharpe 0.46) |
| Dip signal adds value over pure quality | v3 beats s4 in 6/9 years; +9.5pp in 2019, +7.5pp in 2024 |
| Universe restriction doesn't fix the ceiling | s5 NIFTY100 Sharpe 0.35 < v3 NIFTY200 Sharpe 0.46 |
| OPM is the missing 4th factor | Asset_Light_Quality uses OPM at 35% weight, Sharpe 1.18 |

**August slot 6 target:** Test quality_garp's own factor logic as soft-rank — PE, PEG,
ROCE, ROE, D/E all as ranked factors with weights. This directly backtests whether the
pipeline's own factor selection is correct, not just the ftinvstr factor stack.

**Non-trading boundary (applies to any live tracker activated from these backtests):**
Any activated strategy must NEVER feed `screens`, `paper_trades`, `theses`, or any
pipeline gate directly. Reference model only — check monthly, flag disagreements for
manual review. The "monthly top-N QARP portfolio sleeve" driving automated paper trades
is explicitly out of scope (rejected 2026-06-06).

If either slot 4 or 5 underperforms:
→ Try `OPM (operating profit margin)` as a 4th quality factor, matching Asset_Light_Quality
which uses OPM at 35% weight and is the highest-Sharpe strategy in the catalog (1.18).

---

## Correct implementation sequence

```
1. ITEM 3 (ftinvstr cross-ref in briefing)
   — lowest risk, uses existing infrastructure, no gate changes
   — ships first

2. ITEM 2 — Step 0: write + run audit-qds-coverage.mts
   — measure real score distribution before any gate

3. ITEM 2 — Steps 1–7: implement QDS gate with audit-derived threshold

4. ITEM 1 — Sub-task 1a: GarpThresholds architecture (zero behaviour change)
   — ships the interface + function + threading, CHOPPY branch = existing constants

5. ITEM 1 — Sub-task 1b: run screen history audit by regime, fill in threshold values
   — only after empirical pass-rate data exists
```

## Definition of done per item

| Item | Done when |
|---|---|
| ITEM 1a | `resolveGarpThresholds()` exists, CHOPPY branch returns existing constants, screen uses it, typecheck passes — **no behaviour change** |
| ITEM 1b | Screen history audited by regime, BULL/BEAR/CRISIS threshold values in `resolveGarpThresholds` are audit-derived, briefing shows active thresholds |
| ITEM 2 | `audit-qds-coverage.mts` run + results documented, `getQualityDecayScore()` in queries.ts, gate 13 in evaluator, threshold from P10 of actual distribution, funnel tracks `qds`/`qds_warning`/`qds_skipped`, tests pass |
| ITEM 3 | `ext_signal_holdings` queried at brief time, annotation appears when DCF_Compounder_Stack holds a GARP pass, graceful degradation when table empty |

---

## Open questions (do not implement until resolved)

1. **QDS gate placement:** Gate 13 runs on all 241 symbols × 5-row query = 1,205 rows.
   SQLite handles this comfortably but measure it. If `pnpm cli screen` slows by more than
   500ms, add a `qds_score` signal row written during the enrich stage instead.

2. **FTINVSTR_CROSS_REF_ENABLED in daily scheduler:** Should this run in the 08:45 morning
   run only, or also the 16:30 run? The ftinvstr strategies only rebalance monthly so
   the holdings don't change intraday. Recommend: morning only, cache the result in memory
   for the session.

3. **Threshold calibration source:** The BULL/BEAR threshold values in ITEM 1 are derived
   from the backtest analysis + academic mean-reversion literature (Lo/MacKinlay 1990).
   After 30+ paper trades under the new regime-aware thresholds, run a hit-rate audit per
   regime and recalibrate if bull-mode RSI 55 is too loose (letting in non-dip names).

---

## Appendix: relevant backtest findings (quick reference)

### v3 year-by-year vs catalog

| Year | v3 (quality+dip, NIFTY200) | DCF_Compounder_Stack | Asset_Light_Quality |
|---|---|---|---|
| 2018 | −1.8% | — | — |
| 2019 | +7.1% | — | — |
| 2020 | +22.9% | +52.9% | +81.1% |
| 2021 | +28.0% | +48.5% | +49.3% |
| 2022 | −7.1% | **+9.0%** | −7.6% |
| 2023 | **+36.3%** | +30.6% | +45.0% |
| 2024 | **+34.4%** | +31.0% | +35.5% |
| 2025 | **+12.2%** | +5.7% | −3.2% |
| 2026 YTD | −7.1% | −14.3% | +8.6% |

v3 beat DCF Stack in 2023, 2024, 2025 — the markets we are currently in.
The full-period CAGR gap (13.6% vs 25%) is 2018–2020 drag, not a signal failure.

### v3 current holdings (as of 2026-06-05) — GARP overlap

These 7 of 20 v3 positions directly match our manual GARP screen output:
INFY, BPCL, ITC, TCS, LTTS, BRITANNIA, COLPAL

This confirms the factor stack is finding the right names. The 2 leakers
(RNBDENIMS, DRC Systems) account for ~8.5% of portfolio weight and are the
NIFTY200 edge-case problem that ITEM 1 (regime-aware SMA50 gate) would have
filtered in BEAR mode (both were at/below SMA50 in a downtrend, which is
exactly the signal the tight BEAR threshold should catch).

### Asset_Light_Quality — what it is (for context)

- Factor stack: 35% OPM + 25% ROCE + 20% ML-predicted EBIT growth + 20% inverted asset-turnover
- No dip/price signal at all — pure quality compounder
- Sharpe 1.18, CAGR 28.7%, Max DD −22.9% (best risk-adjusted in the 35-strategy catalog)
- Currently in a −13% drawdown from May 7 peak (still underwater as of 2026-07-05)
- Holds BAJAJ-AUTO and WAAREEENER from our GARP screen — independent confirmation
- The OPM factor at 35% weight is the key differentiator vs our v3 (which has no OPM)
  → This is why ftinvstr slot 6 reserve proposes adding OPM if slots 4+5 underperform
