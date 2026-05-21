/**
 * Normalise argv for `node:util/parseArgs` when the entry is `tsx path/to/script.mts …`.
 * - Drops a lone `--` used by pnpm/npm to separate runner flags from script flags.
 * - Drops the first token when it is the script path (so it is not treated as a positional).
 */

export function argvForCliParseArgs(argv: string[] = process.argv): string[] {
  let a = argv.slice(2).filter((t) => t !== '--');
  const head = a[0];
  if (
    head != null &&
    !head.startsWith('-') &&
    (head.includes('/') || head.includes('\\') || /\.(m?ts|jsx?|cjs)$/i.test(head))
  ) {
    a = a.slice(1);
  }
  return a;
}
