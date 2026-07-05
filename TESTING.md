# Testing — `koze`

Reference for how tests are organized, run, and extended in this package.
This document is normative: when something here disagrees with code or
`AGENTS.md`, fix the disagreement before landing the change.

## Stack

- **Runner:** [Vitest](https://vitest.dev/) v4.1+
- **Generated app tests:** `koze/create` scaffolds app-level
  Workers-runtime tests by default. New apps get `vitest.config.ts`,
  `test/worker.test.ts`, and feature-specific D1 / Durable Object tests
  that run in `workerd` through `@cloudflare/vitest-pool-workers`.
- **Pool:** Node (default). The compiler / parser / runtime / Vite-plugin
  tests are all pure JS that run in the host Node process; they do not
  need a Workers isolate.
- **Workers-runtime tests:** not currently wired.
  `@cloudflare/vitest-pool-workers` is installed and ready for plugin-
  output integration tests. When needed, add a vitest project under
  `test/vite/integration/` against a fixture worker — don't bypass that
  by importing `dist/` output into a Workers test directly.

Why vitest and not `bun:test`:

1. The Cloudflare meta-framework story we ship to users is built on Vite +
   `@cloudflare/vitest-pool-workers`. Using vitest in the framework
   package keeps our runner aligned with what apps built on Koze
   will use.
2. One runner across the monorepo — and now one package, after the
   `@kuratchi/vite` merge into this package. The Workers pool is only
   available as a vitest pool, so vitest is the only viable runner if we
   ever wire it up.
3. Vitest's async matcher semantics (`rejects.toThrow`,
   `resolves.toEqual`) caught a real test bug during migration that
   `bun:test` had silently accepted (see *Known caveats* below).

## Commands

Run from this package directory unless noted.

| Command | What it does |
|---|---|
| `bun run test` | One-shot run. Equivalent to `vitest run`. CI default. |
| `bun run test:watch` | Watch mode. Equivalent to bare `vitest`. |
| `bun run check` | Type-check the package (`tsc --noEmit`). Not a test, but part of the verification gate below. |

From the repo root, `bun run test` runs this package's test suite,
which now includes both compiler/runtime tests AND the Vite plugin
tests (formerly in `@kuratchi/vite`).

## Layout

```
packages/koze/
├── vitest.config.ts        # Node pool, setupFiles → ./test/setup.ts
└── test/
    ├── setup.ts            # Global test bootstrap (sets __koze_DEV__)
    ├── *.test.ts           # Compiler / parser / runtime tests (one per surface)
    └── vite/
        └── *.test.ts       # Vite plugin tests
```

### Naming

Files follow `<area>-<topic>.test.ts`:

- `compiler-*.test.ts` — compiler pipeline (parser, codegen, integration).
- `parser-*.test.ts` — parser-only tests that don't touch codegen.
- `template-*.test.ts` — template / reactivity AST behavior.
- `runtime-*.test.ts` — runtime helpers (router, request, navigation,
  workflow, security, generated-worker harness).
- `render-*.test.ts` — section/render-pipeline output.
- `virtual-modules.test.ts`, `desktop-manifest.test.ts`,
  `client-script-environment.test.ts`, `server-module-virtual-imports.test.ts` —
  cross-cutting features.
- `vite/<topic>.test.ts` — Vite plugin tests. The subdirectory keeps
  plugin-specific tests scoped, but they run in the same Node pool as
  the rest of the suite (the plugin is plain JS, not Worker code).

Add new tests under the closest-matching prefix. Don't invent a new
prefix unless the surface is genuinely new.

### Test setup

`test/setup.ts` runs once per worker before any test:

```ts
(globalThis as Record<string, unknown>).__koze_DEV__ = true;
```

The compiler and runtime check this global to branch dev/prod behavior.
Tests that need to validate prod-only output flip the flag locally inside
the test (see `client-script-environment.test.ts` for the canonical
pattern: `beforeEach` snapshots, `afterEach` restores).

If you need a new global default, prefer extending `setup.ts` over adding
a per-test bootstrap.

## Conventions

### Imports

```ts
import { describe, expect, test } from 'vitest';
// or
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
```

Prefer `test` over `it` for new tests. The codebase has both because the
import was migrated mechanically from `bun:test`; either is fine, just
don't mix them inside a single `describe`.

Never import from `bun:test`. There is no `bun:test` polyfill — the test
will fail to load in vitest and CI will break.

### Async assertions

**Always use the dedicated async matchers.** Vitest does not unwrap
promises passed to `.toThrow()` (this is a real semantic difference from
`bun:test` and was the only behavioral break during migration).

```ts
// Correct — async function that should reject
await expect(compile({ projectDir, isDev: true })).rejects.toThrow(
  'Client <script> blocks cannot import env from cloudflare:workers.',
);

// Correct — async function that should resolve to a value
await expect(loadConfig(path)).resolves.toEqual({ ... });

// Wrong — silently passes when the promise rejects asynchronously
expect(async () => compile(...)).toThrow('...');
```

### Filesystem fixtures

Compiler integration tests write fixture projects to `os.tmpdir()` and
clean them up in `afterEach`. The canonical pattern lives in
`compiler-integration-reactivity.test.ts`:

```ts
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempProject(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kuratchi-${name}-`));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src', 'routes'), { recursive: true });
  return dir;
}
```

Reuse this shape. Don't write fixtures into the package source tree, and
don't skip cleanup — vitest will not garbage-collect temp directories
for you.

### Importing source

Tests import directly from `src/` with `.ts` extensions:

```ts
import { compile } from '../src/compiler/index.ts';
import { Router } from '../src/runtime/router.ts';
```

Vitest's Vite-backed transformer handles `.ts` natively. Do not import
from `dist/` — that defeats the test (you'd be testing yesterday's
build) and creates a build-order dependency for `bun run test`.

### Cloudflare runtime references

Some compiler tests assert against the **string contents** of generated
worker code, including `from 'cloudflare:workers'`. These are not runtime
imports — vitest never executes the generated code. Don't move these
tests to a hypothetical Workers pool. They belong in the Node pool
because what's under test is the compiler's output text, not the worker's
behavior.

If you ever need to actually execute compiled output in `workerd`, add a
vitest project under `test/vite/integration/` against a fixture worker.
The dependency (`@cloudflare/vitest-pool-workers`) is already installed.

## Verification gate

Per `AGENTS.md`, changes in this package must pass all of the
following before landing:

1. `bun run build` (in `packages/koze`) — also copies the Vite plugin's runtime helpers into `dist/vite/runtime/`.
2. `bun run check` (in `packages/koze`) — type-checks compiler, runtime, and Vite plugin together.
3. `bun run test` (in `packages/koze`) — exercises compiler/parser/runtime tests and the Vite plugin tests under `test/vite/`. Pre-existing failures (see *Known caveats*) are tolerated; growing the failure set is a regression.
4. `cd apps/web && bun run build` — exercises the legacy CLI compile path.
5. `cd apps/spike && bun run build` — exercises the Vite plugin path end-to-end.

## Known caveats

### Pre-existing failing tests

As of the vitest migration, 9 tests across 7 files fail, plus 2 test
files that fail to load. **All 11 failures pre-date this migration** —
they were also failing under `bun:test`; bun's softer error reporting
just made them less visible. They reference a runtime helper
(`src/runtime/generated-worker.ts`, exporting `createGeneratedWorker`)
that does not exist in the source tree; `createGeneratedWorker` only
lives as a string template inside `src/compiler/routes-module-runtime-shell.ts`.

The currently failing surfaces:

- `test/runtime-security.test.ts` — file fails to load
- `test/runtime-workflow-poll.test.ts` — file fails to load
- `test/runtime-generated-worker.test.ts` — both tests fail
- `test/compiler-middleware-end-to-end.test.ts` — both tests fail
- `test/compiler-typescript-script.test.ts` — three `$lib` event-handler tests fail
- `test/compiler-worker-entrypoints.test.ts` — DO-agent-bindings test fails
- `test/desktop-manifest.test.ts` — desktop manifest test fails

These should be fixed by extracting `createGeneratedWorker` into a real
exported helper at `src/runtime/generated-worker.ts`. Until that lands,
run `bun run test` and visually confirm the failure set has not grown.
**Adding a new failure is a regression**; reducing the set is progress.

### `expect(asyncFn).toThrow()`

The migration fixed one occurrence of this anti-pattern in
`compiler-typescript-script.test.ts:92`. If you see this shape in a
diff, reject it: it silently passes against rejected promises in vitest
and produces false greens. Use `await expect(...).rejects.toThrow(...)`
instead.

## Adding tests

1. Pick the closest prefix from the *Naming* table above. Add a new
   `<prefix>-<topic>.test.ts` file under `test/`.
2. Import `describe`, `test`/`it`, `expect` from `vitest`.
3. If you need filesystem fixtures, copy the `createTempProject` helper
   from `compiler-integration-reactivity.test.ts`. Don't refactor it
   into a shared module until at least three tests need the same shape —
   ad-hoc copies are easier to evolve than a premature abstraction.
4. Run `bun run test:watch` while iterating; run `bun run test` once
   before requesting review.
5. If your change also affects `apps/web`, run the verification gate
   (build + check + apps/web build) before landing.

## Future: Workers-runtime tests

When we need to validate behavior **inside** the Cloudflare runtime
(e.g. RPC against a real Durable Object stub, D1 binding behavior,
`ctx.waitUntil` semantics), wire it as a vitest project under
`test/vite/integration/` with a fixture worker. The
`@cloudflare/vitest-pool-workers` dependency is already installed.
Don't bypass that path by importing `dist/` output into a Workers
test directly — the Workers pool runs inside `workerd`, which doesn't
have Vite's transform pipeline. The fixture exists precisely so the
plugin can run its build first.
