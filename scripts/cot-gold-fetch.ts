/**
 * Weekly COMEX gold COT ingest from CFTC disaggregated futures file.
 * Run: pnpm cot:gold
 */

import { fetchGoldCot } from '../src/cot/fetch-gold-cot.js';
import { closeDb, getDb, migrate } from '../src/db/index.js';

migrate();
const result = await fetchGoldCot(getDb());
if (result.ok && result.row) {
  console.log(
    `cot_gold ${result.row.reportDate}: mm_net=${result.row.mmNet} ratio=${result.row.mmNetOiRatio.toFixed(3)} ${result.row.classification}${result.inserted ? '' : ' (already stored)'}`,
  );
} else if (result.ok) {
  console.log('cot_gold: no COMEX gold row parsed');
} else {
  console.log('cot_gold: fetch failed (see logs)');
  process.exitCode = 0;
}
closeDb();
