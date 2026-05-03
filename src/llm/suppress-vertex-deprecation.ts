/**
 * The `@google-cloud/vertexai` package emits a Node DeprecationWarning on load.
 * We still use it until migration to `@google/genai`; silence only that message so
 * logs stay readable. Import this module before `@google-cloud/vertexai`.
 */

const NEEDLE = 'VertexAI class and all its dependencies are deprecated';

const g = globalThis as { __mpVertexDepWarnPatched?: boolean };
if (!g.__mpVertexDepWarnPatched) {
  g.__mpVertexDepWarnPatched = true;
  const orig = process.emitWarning.bind(process);

  process.emitWarning = (warning: string | Error, ...args: unknown[]) => {
    const msg = typeof warning === 'string' ? warning : warning.message;
    if (msg.includes(NEEDLE)) return;
    return (orig as (w: string | Error, ...r: unknown[]) => void)(warning, ...args);
  };
}
