import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockLlmProvider } from '../../src/llm/providers/mock.js';
import { ThesisSchema } from '../../src/types/domain.js';

describe('MockLlmProvider', () => {
  it('generateText returns a narrative for general prompts', async () => {
    const llm = new MockLlmProvider();
    const result = await llm.generateText({
      system: 'You are a market analyst.',
      user: 'Summarise today.',
    });
    expect(result.text).toBeTruthy();
    expect(result.model).toBe('mock-model');
  });

  it('generateJson returns valid thesis for investment prompts', async () => {
    const llm = new MockLlmProvider();
    const result = await llm.generateJson({
      system: 'You are a senior Indian equity research analyst.',
      user: 'Analyse RELIANCE as of 2026-04-30.',
      schema: ThesisSchema,
    });

    expect(result.data.symbol).toBe('RELIANCE');
    expect(result.data.thesis.length).toBeGreaterThanOrEqual(20);
    expect(result.data.bullCase.length).toBeGreaterThanOrEqual(1);
    expect(result.data.bearCase.length).toBeGreaterThanOrEqual(1);
    expect(result.data.confidenceScore).toBeGreaterThanOrEqual(1);
    expect(result.data.confidenceScore).toBeLessThanOrEqual(10);
  });

  it('generateJson returns valid sentiment batch for sentiment prompts', async () => {
    const SentimentSchema = z.array(
      z.object({ id: z.number(), sentiment: z.number().min(-1).max(1) }),
    );

    const llm = new MockLlmProvider();
    const result = await llm.generateJson({
      system: 'You are a financial news sentiment classifier.',
      user: '{ "id": 42, "headline": "Test news" }\n{ "id": 43, "headline": "Other news" }',
      schema: SentimentSchema,
    });

    expect(result.data).toHaveLength(2);
    expect(result.data[0]?.id).toBe(42);
    expect(result.data[1]?.id).toBe(43);
    for (const item of result.data) {
      expect(item.sentiment).toBeGreaterThanOrEqual(-1);
      expect(item.sentiment).toBeLessThanOrEqual(1);
    }
  });

  it('tracks all calls for test assertions', async () => {
    const llm = new MockLlmProvider();
    await llm.generateText({ system: 's', user: 'u' });
    await llm.generateJson({ system: 's2', user: 'u2', schema: z.any() });

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0]?.method).toBe('generateText');
    expect(llm.calls[1]?.method).toBe('generateJson');
  });
});
