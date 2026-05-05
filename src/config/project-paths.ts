/**
 * Stable paths from the package root (not `process.cwd()`), so CLI commands
 * and dotenv agree when the shell cwd is not the repo directory.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path to the repository / package root. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Default `.env` at package root (same file `dotenv` should load). */
export const PROJECT_DOTENV_PATH = resolve(PROJECT_ROOT, '.env');
