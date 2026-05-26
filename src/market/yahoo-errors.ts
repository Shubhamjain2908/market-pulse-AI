/**
 * Shared helpers for classifying Yahoo Finance API errors.
 */

export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return '';
}

export function isYahooMissingSymbolError(err: unknown): boolean {
  const msg = extractErrorMessage(err).toLowerCase();
  return (
    msg.includes('no data found, symbol may be delisted') ||
    msg.includes('quote not found for symbol')
  );
}
