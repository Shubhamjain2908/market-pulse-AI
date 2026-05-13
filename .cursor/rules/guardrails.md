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
| **alreadyOwned filter** | Skip symbol in AI Picks if currently held in Kite portfolio | Thesis generator input preprocessing |