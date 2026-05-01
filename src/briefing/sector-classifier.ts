/**
 * Rule-based sector labels when explicit sector-map entries are missing.
 * Covers SGB tickers, gold/silver/liquid BEES, and generic index ETFs.
 */

export function classifySector(symbol: string, explicitMap: Record<string, string>): string {
  const s = symbol.toUpperCase();
  if (explicitMap[s]) return explicitMap[s];
  if (/-GB$/.test(s)) return 'Sovereign Gold Bond';
  if (s === 'GOLDBEES' || s === 'GOLDCASE') return 'Gold ETF';
  if (s === 'SILVERBEES') return 'Silver ETF';
  if (s === 'LIQUIDCASE' || s === 'LIQUIDBEES') return 'Liquid Fund';
  if (s === 'JUNIORBEES' || s === 'NIFTYBEES' || s === 'BANKBEES') return 'Index ETF';
  if (/BEES$/.test(s) || /ETF$/.test(s)) return 'Index ETF';
  return 'Unknown';
}
