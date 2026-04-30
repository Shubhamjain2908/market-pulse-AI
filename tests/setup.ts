/**
 * Vitest global setup. Forces NODE_ENV=test and isolates the DB so tests
 * don't clobber the developer's local data file.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER ?? 'mock';
