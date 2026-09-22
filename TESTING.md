# Testing Koze

Koze uses Vitest in both the Node pool and Cloudflare's `workerd` integration. Tests import from `vitest`, never `bun:test`.

## Required package checks

Run from this package:

```bash
bun run build
bun run check
bun run test
```

- `build` emits the package and copies `src/vite/runtime/*.js`.
- `check` type-checks compiler, runtime, scaffolder, and Vite integration together.
- `test` runs the Node suite and then the native Worker integration suite in `workerd`.

There is no legacy CLI build gate. `koze create` is a scaffolder, and Vite is the only application build path.

## Test ownership

- `test/vite/`: route transforms, virtual modules, HMR, action invocation, the Koze HTTP handler, and native Worker integration.
- Compiler tests: parsers, templates, components, reactivity, source maps, diagnostics, and type generation.
- Runtime tests: request helpers, router, channel, security primitives, async values, and streams.
- `test/fixtures/`: explicit source fixtures and parity inventories.

Tests for removed whole-project compiler output, `.koze/routes.ts`, `.koze/worker.ts`, `createApp()`, and `createGeneratedWorker()` do not belong in the suite.

## Async assertions

Use:

```ts
await expect(promise).rejects.toThrow('message');
await expect(promise).resolves.toEqual(value);
```

Vitest does not unwrap promises passed to `.toThrow()`.

## Worker integration

`vitest.workerd.config.ts` executes `test/vite/integration/native-worker/` through Cloudflare's current Vitest plugin. It proves SSR, a native Durable Object export/RPC, and a non-fetch handler inside `workerd`. Extend that fixture for Worker-runtime regressions; do not restore a generated-worker harness.
