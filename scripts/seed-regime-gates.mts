/**
 * Idempotent UPSERT of config/strategy-gates.json into regime_strategy_gate.
 */

import { loadStrategyGates } from '../src/config/loaders.js';
import { closeDb, getDb, migrate, seedStrategyGates } from '../src/db/index.js';

migrate();
const db = getDb();
const file = loadStrategyGates();
const n = seedStrategyGates(file.rows, db);
console.log(`Upserted ${n} regime_strategy_gate rows`);
closeDb();
