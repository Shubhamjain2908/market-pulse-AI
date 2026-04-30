/**
 * Pure DSL evaluator. Given a ScreenCriterion and a SignalProvider, returns
 * whether the criterion is satisfied for the given (symbol, date), along
 * with the actual values used so callers can render diagnostics.
 *
 * Operators:
 *   eq, neq            — equality / inequality (exact match)
 *   gt, gte, lt, lte   — numeric comparison against `value` (number)
 *   between            — value ∈ [min, max] inclusive (`value` is [n, n])
 *   gt_signal          — lhs > rhs where rhs is another signal name (string)
 *   lt_signal          — lhs < rhs where rhs is another signal name (string)
 *
 * A criterion fails (matched=false) whenever the lhs signal isn't
 * available — we never give the benefit of the doubt to missing data.
 */

import type { ScreenCriterion, ScreenDefinition, ScreenResult } from '../types/domain.js';
import type { SignalProvider } from './signal-provider.js';

export interface CriterionEvaluation {
  criterion: ScreenCriterion;
  matched: boolean;
  /** The lhs signal value at evaluation time (null = missing). */
  lhs: number | null;
  /** Right-hand side: a literal (gt/lt/...), tuple (between), or signal value (*_signal). */
  rhs: number | [number, number] | { signal: string; value: number | null } | null;
  /** Human-readable explanation when matched=false (debugging). */
  reason?: string;
}

export interface ScreenEvaluation {
  symbol: string;
  date: string;
  screenName: string;
  /** All criteria evaluated; in input order. */
  criteria: CriterionEvaluation[];
  /** Number of matched criteria. */
  matchedCount: number;
  /** Total number of criteria. */
  totalCriteria: number;
  /** Score in [0, 1]: matchedCount / totalCriteria. */
  score: number;
  /** All criteria matched (i.e. matchedCount == totalCriteria). */
  passed: boolean;
}

export function evaluateCriterion(
  criterion: ScreenCriterion,
  symbol: string,
  date: string,
  provider: SignalProvider,
): CriterionEvaluation {
  const lhs = provider.get(symbol, date, criterion.signal);
  if (lhs == null) {
    return {
      criterion,
      matched: false,
      lhs: null,
      rhs: null,
      reason: `signal "${criterion.signal}" missing`,
    };
  }

  const { op, value } = criterion;

  switch (op) {
    case 'eq':
      return literalCompare(criterion, lhs, value, (a, b) => a === b);
    case 'neq':
      return literalCompare(criterion, lhs, value, (a, b) => a !== b);
    case 'gt':
      return literalCompare(criterion, lhs, value, (a, b) => a > b);
    case 'gte':
      return literalCompare(criterion, lhs, value, (a, b) => a >= b);
    case 'lt':
      return literalCompare(criterion, lhs, value, (a, b) => a < b);
    case 'lte':
      return literalCompare(criterion, lhs, value, (a, b) => a <= b);
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) {
        return invalid(criterion, lhs, `'between' requires a [min, max] tuple`);
      }
      const [min, max] = value;
      const matched = lhs >= min && lhs <= max;
      return {
        criterion,
        matched,
        lhs,
        rhs: [min, max],
        reason: matched ? undefined : `${lhs} not in [${min}, ${max}]`,
      };
    }
    case 'gt_signal':
    case 'lt_signal': {
      if (typeof value !== 'string') {
        return invalid(criterion, lhs, `'${op}' requires a signal name (string)`);
      }
      const rhs = provider.get(symbol, date, value);
      if (rhs == null) {
        return {
          criterion,
          matched: false,
          lhs,
          rhs: { signal: value, value: null },
          reason: `rhs signal "${value}" missing`,
        };
      }
      const matched = op === 'gt_signal' ? lhs > rhs : lhs < rhs;
      return {
        criterion,
        matched,
        lhs,
        rhs: { signal: value, value: rhs },
        reason: matched ? undefined : `${lhs} ${op === 'gt_signal' ? '<=' : '>='} ${rhs}`,
      };
    }
    default: {
      const exhaustive: never = op;
      throw new Error(`Unknown operator: ${exhaustive as string}`);
    }
  }
}

function literalCompare(
  criterion: ScreenCriterion,
  lhs: number,
  value: ScreenCriterion['value'],
  fn: (a: number, b: number) => boolean,
): CriterionEvaluation {
  if (typeof value !== 'number') {
    return invalid(criterion, lhs, `'${criterion.op}' requires a numeric value`);
  }
  const matched = fn(lhs, value);
  return {
    criterion,
    matched,
    lhs,
    rhs: value,
    reason: matched ? undefined : `${lhs} ${criterion.op} ${value} is false`,
  };
}

function invalid(criterion: ScreenCriterion, lhs: number, reason: string): CriterionEvaluation {
  return { criterion, matched: false, lhs, rhs: null, reason };
}

/**
 * Evaluate every criterion of a screen for one (symbol, date). Returns the
 * full evaluation including diagnostics; callers decide whether the
 * `score` is high enough to act on.
 */
export function evaluateScreen(
  screen: ScreenDefinition,
  symbol: string,
  date: string,
  provider: SignalProvider,
): ScreenEvaluation {
  const criteria = screen.criteria.map((c) => evaluateCriterion(c, symbol, date, provider));
  const matchedCount = criteria.filter((c) => c.matched).length;
  const totalCriteria = criteria.length;
  const score = totalCriteria === 0 ? 0 : matchedCount / totalCriteria;
  return {
    symbol,
    date,
    screenName: screen.name,
    criteria,
    matchedCount,
    totalCriteria,
    score,
    passed: matchedCount === totalCriteria,
  };
}

/**
 * Convert an Evaluation into a persistable ScreenResult. Only stores the
 * subset of criteria that matched (saves space; failure diagnostics are
 * already logged at evaluation time).
 */
export function toScreenResult(evaluation: ScreenEvaluation): ScreenResult {
  return {
    symbol: evaluation.symbol,
    date: evaluation.date,
    screenName: evaluation.screenName,
    score: evaluation.score,
    matchedCriteria: evaluation.criteria.filter((c) => c.matched).map((c) => c.criterion),
  };
}
