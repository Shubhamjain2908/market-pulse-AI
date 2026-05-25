# Market Pulse AI — Quality Sprint> Scope: Code quality, maintainability, stability. No new features.> Source: Codebase review May 22, 2026.
---
## Execution Order
Work top-to-bottom. Each item is self-contained and non-breaking.
---
## 1. Pre-commit hooks — husky + lint-staged
**Why:** CI catches issues in 2-3 min. Pre-commit catches them in ~50ms. The `prepare` script already has a placeholder comment.
**Files to touch:**- `package.json`- `.husky/pre-commit` (create)- `.lintstagedrc.json` (create)
**Steps:**
```bashpnpm add -D husky lint-stagedpnpm exec husky init```
`.husky/pre-commit`:```sh#!/usr/bin/env sh. "$(dirname -- "$0")/_/husky.sh"pnpm exec lint-staged```
`.lintstagedrc.json`:```json{ "*.ts": ["biome check --apply", "biome format --write"], "*.json": ["biome format --write"]}```
`package.json` — replace the existing `prepare` placeholder:```json"prepare": "husky"```
**Verify:** Make a trivial lint violation in any `.ts` file, `git commit` — should be blocked.
---
## 2. Promote `noExplicitAny` from `warn` → `error`
**Why:** 6 `any` casts were cleaned up in PR #46. One config line prevents future drift.
**File:** `biome.json`
Find the existing rule (currently `"warn"`):```json"noExplicitAny": "warn"```
Change to:```json"noExplicitAny": "error"```
**Then run:**```bashpnpm biome check src/```
Fix any remaining violations before committing. There should be zero after PR #46, but verify.
---
## 3. Code coverage threshold in CI
**Why:** Coverage is collected and uploaded to Codecov but never enforced. Uncovered code accumulates silently.
**File:** `.github/workflows/ci.yml`
Find the `vitest` run step. Add `--coverage.thresholds` flags (or add to `vitest.config.ts`):
Option A — `vitest.config.ts` (preferred, keeps CI clean):```tsexport default defineConfig({ test: { coverage: { provider: 'v8', thresholds: { lines: 60, functions: 60, branches: 55, }, }, },});```
Option B — inline in CI step if config is not managed centrally:```yaml- name: Test with coverage run: pnpm test --coverage --coverage.thresholds.lines=60 --coverage.thresholds.functions=60```
**Note:** Set thresholds at or just below current coverage to avoid immediate failures. Run `pnpm test --coverage` first to check current baseline, then set thresholds 2-3% below it.
---
## 4. Enable `exactOptionalPropertyTypes` in `tsconfig.json`
**Why:** The only strict-mode flag still off. Catches `undefined` assignments to optional properties — the same class of bug as the `primeCandidate` null guard fixed in PR #46.
**File:** `tsconfig.json`
Add to `compilerOptions`:```json"exactOptionalPropertyTypes": true```
**Then run:**```bashpnpm typecheck```
This will surface genuine bugs. Fix each one — do not use non-null assertions to silence them. Common pattern to watch for: `property: value | undefined` assigned where `property?: value` is declared. These are different types under this flag.
Expect 10-30 fixes across the codebase. Prioritise `src/` over `scripts/` and `deploy/`.
---
## 5. Add `pnpm audit` to CI
**Why:** `nodemailer`, `got`, `pino`, `better-sqlite3` have all had CVEs historically. No gate currently prevents shipping with known vulnerabilities.
**File:** `.github/workflows/ci.yml`
Add as a separate step, before the test step:```yaml- name: Audit dependencies run: pnpm audit --audit-level=high```
`--audit-level=high` blocks on HIGH and CRITICAL only. `moderate` is too noisy for a personal project. If a known false-positive fires, add it to `.npmrc`:```audit-ignore[]=<advisory-id>```
---
## 6. TypeScript project references
**Why:** `tsc --noEmit` currently type-checks all 20K LOC (src + tests + scripts + deploy) on every run. Project references enable incremental type-checking per sub-project.
**Files to create/modify:**- `tsconfig.json` (root — references only, no `include`)- `tsconfig.src.json` (source)- `tsconfig.test.json` (tests)- `tsconfig.scripts.json` (scripts + deploy)
`tsconfig.json` (root):```json{ "files": [], "references": [ { "path": "./tsconfig.src.json" }, { "path": "./tsconfig.test.json" }, { "path": "./tsconfig.scripts.json" } ]}```
`tsconfig.src.json`:```json{ "extends": "./tsconfig.base.json", "compilerOptions": { "composite": true, "outDir": "./dist", "rootDir": "./src" }, "include": ["src/**/*"]}```
`tsconfig.test.json`:```json{ "extends": "./tsconfig.base.json", "compilerOptions": { "composite": true, "noEmit": true }, "include": ["src/**/*", "tests/**/*"], "references": [{ "path": "./tsconfig.src.json" }]}```
`tsconfig.scripts.json`:```json{ "extends": "./tsconfig.base.json", "compilerOptions": { "composite": true, "noEmit": true }, "include": ["scripts/**/*", "deploy/**/*"], "references": [{ "path": "./tsconfig.src.json" }]}```
Move shared `compilerOptions` from the current `tsconfig.json` into a new `tsconfig.base.json`.
**Update CI typecheck step:**```yaml- name: Typecheck run: pnpm exec tsc --build --noEmit```
`--build` uses project references for incremental compilation.
**Note:** This is the most invasive item. Do it last, or in a dedicated PR. Verify `pnpm build` still works after the split.
---
## 7. E2E pipeline smoke test
**Why:** `daily-workflow.ts` has zero integration tests. A single end-to-end run through mock data would catch orchestration regressions — stage ordering bugs, missing await, config misreads.
**File to create:** `tests/integration/daily-workflow.smoke.test.ts`
Pattern:```tsimport { describe, it, expect, beforeAll } from 'vitest';import { createTestDb } from '../helpers/db.js';import { MockLlmProvider } from '../helpers/mock-llm.js';import { runDailyWorkflow } from '../../src/agents/daily-workflow.js';
describe('daily-workflow smoke', () => { let db: ReturnType<typeof createTestDb>;
 beforeAll(() => { db = createTestDb(); // seed with minimal quote/signal fixtures });
 it('completes without throwing for a minimal market day', async () => { await expect( runDailyWorkflow({ db, llm: new MockLlmProvider(), date: '2026-01-15' }) ).resolves.not.toThrow(); });
 it('writes a briefings row on completion', async () => { const rows = db.prepare('SELECT * FROM briefings WHERE date = ?').all('2026-01-15'); expect(rows.length).toBe(1); });});```
The goal is not 100% coverage — it is that the pipeline runs end-to-end on known-good fixture data without throwing. Seed data should include: 5 symbols in `quotes`, corresponding `signals` rows, one `regime_daily` row, and one `portfolio_holdings` row.
---
## 8. Enable `verbatimModuleSyntax: true`
**Why:** Forces `import type` at syntax level for type-only imports. Prevents accidental runtime imports of type-only modules. Biome currently enforces this as a lint rule post-hoc; the compiler flag makes it a build error.
**File:** `tsconfig.base.json` (after item 6) or `tsconfig.json` if project references not yet split.
```json"verbatimModuleSyntax": true```
**Then run:**```bashpnpm typecheck```
This will flag any `import { Foo }` where `Foo` is only used as a type. Change those to `import type { Foo }`. The PR #46 diff already does this correctly (`import type { GenerateContentResponse }`) — enforce it everywhere.
Expect ~20-40 import fixes across `src/`. Can be auto-fixed with:```bashpnpm exec tsc --noEmit 2>&1 | grep "TS1484" | ...```Or just let the IDE highlight them.
---
## 9. Dependabot / Renovate config
**Why:** Dependencies drift silently. `@google-cloud/vertexai` was deprecated and required a manual migration PR. Automated weekly bump PRs with CI blocking catches this earlier with less effort.
**Option A — Dependabot (zero config, already supported by GitHub):**
Create `.github/dependabot.yml`:```yamlversion: 2updates: - package-ecosystem: npm directory: / schedule: interval: weekly day: monday time: "06:00" timezone: Asia/Kolkata open-pull-requests-limit: 5 groups: typescript-toolchain: patterns: - "typescript" - "@biomejs/*" - "vitest" - "@vitest/*" google-ai: patterns: - "@google/*" - "@google-cloud/*" ignore: - dependency-name: "better-sqlite3" update-types: ["version-update:semver-major"]```
**Why ignore `better-sqlite3` major?** Schema-level dependency; major bumps need manual validation against SQLite WAL behaviour.
**Option B — Renovate:** More configurable but requires the Renovate GitHub App. Dependabot is sufficient for this project's size.
---
## Completion Checklist
| # | Item | Branch suggestion | Risk ||---|---|---|---|| 1 | Pre-commit hooks | `chore/husky-lint-staged` | None || 2 | `noExplicitAny` → error | `chore/strict-no-any` | None || 3 | Coverage threshold CI | `chore/coverage-threshold` | None || 4 | `exactOptionalPropertyTypes` | `chore/exact-optional-props` | Low — may surface real bugs || 5 | `pnpm audit` in CI | `chore/dep-audit-ci` | None || 6 | TS project references | `chore/ts-project-refs` | Medium — invasive, do last || 7 | Smoke test daily-workflow | `test/daily-workflow-smoke` | None || 8 | `verbatimModuleSyntax` | `chore/verbatim-module-syntax` | Low — import fixes only || 9 | Dependabot config | `chore/dependabot` | None |
**Suggested PR order:** 1 → 2 → 3 → 5 → 9 → 8 → 4 → 7 → 6
Items 1-3 and 5 are each under 30 minutes and merge-safe. Items 4, 7, 8 touch more files. Item 6 (project references) is the only one that could break the build if done carelessly — do it in isolation.