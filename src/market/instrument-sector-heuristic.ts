/**
 * Deterministic instrument-type labels from ticker shape (India NSE-style).
 * Used before DB/Yahoo sector lookup so ETFs and SGBs stay correctly bucketed.
 */

export function heuristicInstrumentSector(symbol: string): string | null {
  const s = symbol.toUpperCase();
  if (/-GB$/.test(s)) return 'Sovereign Gold Bond';
  if (s === 'GOLDBEES' || s === 'GOLDCASE') return 'Gold ETF';
  if (s === 'SILVERBEES') return 'Silver ETF';
  if (s === 'LIQUIDCASE' || s === 'LIQUIDBEES') return 'Liquid Fund';
  if (s === 'JUNIORBEES' || s === 'NIFTYBEES' || s === 'BANKBEES') return 'Index ETF';
  if (/BEES$/.test(s) || /ETF$/.test(s)) return 'Index ETF';
  return null;
}
