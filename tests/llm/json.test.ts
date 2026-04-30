import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmJsonValidationError, extractJson, parseAndValidate } from '../../src/llm/json.js';

describe('llm/json', () => {
  describe('extractJson', () => {
    it('returns body of fenced ```json block', () => {
      const input = 'Here is the result:\n```json\n{"a":1,"b":2}\n```\nThanks!';
      expect(extractJson(input)).toBe('{"a":1,"b":2}');
    });

    it('returns body of generic ``` block', () => {
      const input = 'pre\n```\n{"x":42}\n```\npost';
      expect(extractJson(input)).toBe('{"x":42}');
    });

    it('strips leading prose before first { or [', () => {
      const input = 'Sure, here you go: {"only":true}';
      expect(extractJson(input)).toBe('{"only":true}');
    });

    it('handles arrays', () => {
      const input = 'Sure: [1,2,3]';
      expect(extractJson(input)).toBe('[1,2,3]');
    });
  });

  describe('parseAndValidate', () => {
    const schema = z.object({ symbol: z.string(), score: z.number() });

    it('parses valid JSON against the schema', () => {
      const result = parseAndValidate('{"symbol":"RELIANCE","score":7}', schema);
      expect(result).toEqual({ symbol: 'RELIANCE', score: 7 });
    });

    it('throws LlmJsonValidationError for malformed JSON', () => {
      expect(() => parseAndValidate('not json', schema)).toThrow(LlmJsonValidationError);
    });

    it('throws LlmJsonValidationError for schema mismatch', () => {
      expect(() => parseAndValidate('{"symbol":"X"}', schema)).toThrow(LlmJsonValidationError);
    });
  });
});
