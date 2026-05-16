/**
 * One-off: fetch Screener consolidated pages and print parsed fundamentals JSON.
 * Usage: pnpm exec tsx src/ingestors/screener/debug-parse.ts KOTAKBANK ESABINDIA
 */

import { parseScreenerHtml } from './parser.js';

const symbols = process.argv.slice(2);
if (symbols.length === 0) {
  console.error('Usage: pnpm exec tsx src/ingestors/screener/debug-parse.ts SYM1 [SYM2 ...]');
  process.exit(1);
}

const UA = 'Mozilla/5.0 (compatible; market-pulse-ai/1.0)';

async function main(): Promise<void> {
  for (const symbol of symbols) {
    const url = `https://www.screener.in/company/${symbol.toUpperCase()}/consolidated/`;
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    if (!res.ok) {
      console.error(`${symbol}: HTTP ${res.status}`);
      continue;
    }
    const html = await res.text();
    const parsed = parseScreenerHtml(html, { symbol, source: 'debug-parse' });
    console.log(JSON.stringify(parsed, null, 2));
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
