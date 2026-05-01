/**
 * Mock LLM provider used by tests and the `LLM_PROVIDER=mock` mode. Returns
 * deterministic fake content so the rest of the pipeline can be exercised
 * without making network calls.
 *
 * generateJson now uses the zod schema to produce a structurally valid
 * placeholder, preventing downstream runtime errors.
 */

import { parseAndValidate } from '../json.js';
import type {
  GenerateJsonOptions,
  GenerateTextOptions,
  LlmJsonResult,
  LlmProvider,
  LlmTextResult,
} from '../types.js';

const MOCK_THESIS = {
  symbol: 'MOCK',
  thesis: 'This is a mock thesis for testing the pipeline end-to-end without LLM calls.',
  bullCase: ['Strong technical setup', 'Sector tailwinds'],
  bearCase: ['Elevated valuation', 'Global headwinds'],
  entryZone: '₹100–₹105',
  stopLoss: '₹95',
  target: '₹120',
  timeHorizon: 'medium',
  confidenceScore: 5,
  triggerScreen: 'mock-signal',
};

const MOCK_SENTIMENT = [{ id: 0, sentiment: 0.0 }];

/** Match enricher batch lines: `{ "id": N, "headline": "..." }` (escaped quotes inside headline). */
function extractSentimentIdHeadlinePairs(user: string): Array<{ id: number; headline: string }> {
  const out: Array<{ id: number; headline: string }> = [];
  const re = /\{\s*"id":\s*(\d+),\s*"headline":\s*"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null = re.exec(user);
  while (m !== null) {
    const headline = (m[2] ?? '').replace(/\\"/g, '"').replace(/\\n/g, ' ');
    out.push({ id: Number(m[1]), headline });
    m = re.exec(user);
  }
  return out;
}

/**
 * Deterministic mock sentiment from headline text — avoids flat 0.1 scores in dev/tests.
 * Exported for unit tests.
 */
export function mockSentimentFromHeadline(headline: string): number {
  const h = headline.toLowerCase();
  if (
    /profit\s+jump|beats\s+street|beat\b|order\s+win|surge|soar|record|pat\s+up|upgrade|strong\s+guidance/i.test(
      h,
    )
  ) {
    return 0.62;
  }
  if (/miss|downgrade|weak\s+guidance|probe|fraud|crash|slump|loss\s+widen|net\s+loss/i.test(h)) {
    return -0.48;
  }
  if (/flat|unchanged|routine|mixed\b/i.test(h)) return 0.02;
  return 0.14;
}

const MOCK_NARRATIVE =
  'Markets are showing mixed signals today. FII flows remain cautious while domestic institutions provide a floor. Key stocks on the watchlist exhibit interesting technical setups worth monitoring.';

export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock-model';

  /** Track calls for test assertions. */
  readonly calls: Array<{ method: string; system: string; user: string }> = [];

  async generateText(opts: GenerateTextOptions): Promise<LlmTextResult> {
    this.calls.push({ method: 'generateText', system: opts.system, user: opts.user });

    let text = MOCK_NARRATIVE;
    if (opts.system.includes('sentiment')) {
      text = JSON.stringify(MOCK_SENTIMENT);
    }

    return {
      text,
      model: this.model,
      usage: { durationMs: 1 },
    };
  }

  async generateJson<T>(opts: GenerateJsonOptions<T>): Promise<LlmJsonResult<T>> {
    this.calls.push({ method: 'generateJson', system: opts.system, user: opts.user });

    let raw: string;

    if (opts.system.includes('sentiment')) {
      const pairs = extractSentimentIdHeadlinePairs(opts.user);
      const batch =
        pairs.length > 0
          ? pairs.map((p) => ({ id: p.id, sentiment: mockSentimentFromHeadline(p.headline) }))
          : MOCK_SENTIMENT;
      raw = JSON.stringify(batch);
    } else if (opts.system.includes('portfolio review')) {
      const symbolMatch = opts.user.match(/# Position:\s+(\w+)/);
      const rsiMatch = opts.user.match(/rsi_14:\s*([\d.]+)/);
      const pctHiMatch = opts.user.match(/pct_from_52w_high:\s*([-.\d]+)/);
      const rsi = rsiMatch ? Number(rsiMatch[1]) : null;
      const pctHi = pctHiMatch ? Number(pctHiMatch[1]) : null;
      /** Default HOLD; use ADD when stretched so tests can assert ADD→HOLD guardrails. */
      let action: 'HOLD' | 'ADD' | 'TRIM' | 'EXIT' = 'HOLD';
      if (rsi != null && rsi > 70) action = 'ADD';
      else if (pctHi != null && pctHi >= -3) action = 'ADD';

      raw = JSON.stringify({
        symbol: symbolMatch?.[1] ?? 'MOCK',
        action,
        conviction: 0.6,
        thesis:
          'The position is in line with the original thesis; technicals remain constructive and there is no fresh news warranting a change in stance.',
        bullPoints: ['Trend intact', 'Volumes supportive'],
        bearPoints: ['Macro uncertainty', 'Valuation getting full'],
        triggerReason: 'No material change since last review.',
        suggestedStop: null,
        suggestedTarget: null,
      });
    } else if (opts.system.includes('equity research') || opts.system.includes('investment')) {
      const symbolMatch = opts.user.match(/Analyse\s+(\w+)/);
      raw = JSON.stringify({
        ...MOCK_THESIS,
        symbol: symbolMatch?.[1] ?? 'MOCK',
      });
    } else {
      raw = JSON.stringify(MOCK_THESIS);
    }

    const data = parseAndValidate(raw, opts.schema);
    return {
      data,
      raw,
      model: this.model,
      usage: { durationMs: 1 },
    };
  }
}
