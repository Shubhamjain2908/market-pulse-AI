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
      const ids = [...opts.user.matchAll(/"id":\s*(\d+)/g)].map((m) => Number(m[1]));
      const batch = ids.length > 0 ? ids.map((id) => ({ id, sentiment: 0.1 })) : MOCK_SENTIMENT;
      raw = JSON.stringify(batch);
    } else if (opts.system.includes('portfolio review')) {
      const symbolMatch = opts.user.match(/# Position:\s+(\w+)/);
      raw = JSON.stringify({
        symbol: symbolMatch?.[1] ?? 'MOCK',
        action: 'HOLD',
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
