/**
 * Parse INR price strings from thesis LLM output (ranges, commas, symbols).
 */

const NUM_RE = /\d+(?:\.\d+)?/g;

/**
 * Extract one numeric price from a string. For ranges or multiple numbers,
 * returns the midpoint of min/max of all numbers found (robust to "₹2,400–₹2,450").
 */
export function parseInrPriceMidpoint(text: string): number | null {
  if (!text?.trim()) return null;
  const cleaned = text
    .replace(/₹|\u20b9|inr/gi, '')
    .replace(/,/g, '')
    .replace(/[–—]/g, '-')
    .trim();
  const matches = cleaned.match(NUM_RE);
  if (!matches?.length) return null;
  const values = matches.map((m) => Number.parseFloat(m)).filter((n) => Number.isFinite(n));
  if (values.length === 0) return null;
  if (values.length === 1) {
    const v = values[0];
    return v == null ? null : v;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  return (min + max) / 2;
}
