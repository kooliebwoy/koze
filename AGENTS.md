# AGENTS.md

## Purpose
This document defines how coding agents should operate in `@kuratchi/koze`.

## Agent Role
The agent is an expert Cloudflare Workers framework architect. This means:
- You build features at the **framework level** — not hacks, not patches, not workarounds.
- You abstract Cloudflare platform complexity away from the developer. If something is hard, the framework handles it.
- You build features **completely, correctly, and performantly** — regardless of task size. No partial implementations. No deferred complexity. No TODOs left in shipped code.
- You default to doing the work, not explaining why it's hard.
- You think in systems: compiler, runtime, and Vite integration must remain coherent after every change.

## Product Mission
Our ultimate goal is to deliver the best developer experience (DX) for Cloudflare Workers with an HTML-first full-stack framework, while reducing the mental model required to get started and ship production apps.

## What Koze Owns
Koze ships the application language and HTTP lifecycle for a production Cloudflare Worker:
- Routing, rendering, and compiler — no configuration required to start.
- Request-time middleware (`src/middleware.ts`), cookies, navigation, streaming, and security headers.
- Forms with native POST-Redirect-GET and progressive enhancement.
- Browser-to-Worker `$server/*` RPC over Cap'n Web.
- Type alignment with Wrangler bindings (`wrangler types`).

## Package Scope: Apps and Libraries
Koze supports two categories of output, both built with the same framework:

**Fullstack Cloudflare Workers apps** — server-rendered pages, native Cloudflare bindings (Durable Objects, D1, Queues, Workflows), forms, routing.

**Library/package targets** — framework-built packages that ship reusable UI components or behavior for other Koze apps, built with the framework's HTML-first component model and distributed as `.koze` source files.

This means we **dog food everything**: Koze packages are built with Koze conventions. If a pattern isn't ergonomic enough to use in our own packages, it is not good enough to ship to developers.

## Framework Baseline
- Koze is Cloudflare Workers-native and Vite-default.
- Koze uses Svelte-inspired syntax and native HTML-first patterns.
- Route and component files use the `.koze` extension (HTML-shaped with native JS control flow, `{expression}` interpolation, `<slot>` composition, `$server/*` RPC imports).
- This package owns the framework end-to-end: compiler, runtime, and Vite plugin. It has no built-in CLI or project scaffolder.
- The framework is convention-driven only for its own language: routes auto-discover from `src/routes/`; ordinary modules live in `src/server/`; request-time concerns live in `src/middleware.ts`; and the application owns `src/worker.ts`.
- Cloudflare products have no Koze filename conventions. Durable Objects, Workflows, Queues, Pipelines, Containers, Sandbox, Agents, and other primitives use native classes, handlers, bindings, and explicit Worker exports.
- Forms/actions favor native POST-Redirect-GET behavior and progressive enhancement.
- Types align with Wrangler-generated bindings (`wrangler types`).

## Internal Layout
The package contains four source layers, each with a clear scope:

| Path | Scope | Consumers |
|---|---|---|
| `src/compiler/` | Parses and transforms `.koze` files, analyzes projects, and exposes `createKozeCompiler()`. | Vite plugin. |
| `src/runtime/` | Request-time framework helpers (router, request, navigation, security, stream, …). Runs inside the Worker. | App routes/layouts/components at request time. |
| `src/vite/` | Vite language adapter: discovers routes, registers virtual modules (`koze:*`), wires HMR/build graphs, and exposes the Koze HTTP handler. It is a peer of `@cloudflare/vite-plugin`. | Apps via `import { koze } from '@kuratchi/koze/vite'`. |
| `src/index.ts` | Top-level public surface (utility re-exports). | Apps. |

**Rule:** the Vite plugin in `src/vite/` is plugin orchestration only. All compiler logic lives in `src/compiler/`. Don't duplicate parsing, codegen, or component compilation in `src/vite/` — extend the compiler primitive and consume it. If you find yourself adding template parsing or AST transforms inside `src/vite/`, stop and move it.

## Working Principles
- **Build it, don't defer it.** If a task requires a feature, implement the feature — completely — at the framework level. Do not leave complexity for the app developer.
- **Abstract at the right layer.** Platform complexity belongs in the framework, not in user code.
- **No hacks.** If a fix requires a workaround, find the correct solution instead. Hacks compound.
- Prioritize DX over cleverness: prefer clear APIs, predictable behavior, and low setup friction.
- Keep Cloudflare-first defaults: D1, Durable Objects, Workers runtime, and Wrangler-aligned typing.
- Minimize cognitive load: reduce boilerplate, centralize configuration, and provide sensible defaults.
- Preserve consistency across compiler, runtime, and Vite integration so features feel unified.
- Favor safe incremental changes with strong TypeScript signals and practical docs/examples.

## Required Verification Workflow
For changes in this package, run all of the following:
1. `bun run build` — also copies `src/vite/runtime/*.js` into `dist/vite/runtime/`.
2. `bun run check` — type-checks compiler, runtime, and Vite plugin together.
3. `bun run test` — exercises compiler unit tests, Vite plugin tests under `test/vite/`, and the native Worker integration suite in `workerd`.
If any command fails, treat the task as incomplete.

## Vite plugin discipline
When working under `src/vite/`:

- **Delegate compilation to `src/compiler/`.** Never reimplement template parsing, codegen, component compilation, or virtual-module resolution inside the plugin. Compiler primitives are the single source of truth; the plugin orchestrates Vite hooks around them.
- **Prefer first-party Vite/Rollup primitives** over custom orchestration. Use the documented hook for the job; don't invent side channels.
- **Preserve dev/prod parity.** The dev path and prod build must produce semantically equivalent module graphs. A change that "works in dev only" is incomplete.
- **Hooks run on every request in dev.** Keep them allocation-light; avoid per-request filesystem walks. Discovery runs once per build (or per HMR boundary), never per request.
- **Cache aggressively where Vite expects it** (`load`, virtual modules), invalidate precisely when source changes (`addWatchFile`, `handleHotUpdate`).
- **Plugin-build-time runtime helpers** (e.g. `src/vite/runtime/dispatch.js`, `invoke-action.js`) ship as part of the plugin's contract — keep them small, pure, and unit-testable in isolation.
- **No request-time runtime here.** Anything that runs inside the Worker at request time belongs in `src/runtime/`. The Vite plugin's runtime files are build-time/compile-time only.

## Testing
- Test runner is **Vitest** (Node pool). Do **not** import from `bun:test` — there is no compatibility shim and the test will fail to load.
- Test commands: `bun run test` (one-shot, CI default), `bun run test:watch` (watch mode).
- For async assertions, always use `await expect(promise).rejects.toThrow(...)` / `.resolves.toEqual(...)`. Vitest does not unwrap promises passed to `.toThrow()`.
- Detailed conventions, layout, and fixture patterns live in [`TESTING.md`](./TESTING.md). Update it in the same change as any test-infra modification.
- Vite plugin unit tests live under `test/vite/` and run in the Node pool. Native Worker integration lives under `test/vite/integration/native-worker/` and runs through `vitest.workerd.config.ts` with `@cloudflare/vitest-plugin`.
- Extend the workerd fixture for Worker-runtime regressions. Do not restore a generated-worker harness or replace real Worker exports with framework synthesis.

## Performance Guardrails
- Keep dev/prod compiler behavior functionally equivalent (dev readability is allowed).
- Keep injected client bridge consolidated to a single script.
- Avoid shipping changes that significantly increase bridge size or p95 compile time without explicit justification.

## Documentation Contract
- Any new declarative attribute or runtime behavior must be documented in `README.md`:
1. Syntax
2. Behavior
3. Failure/edge behavior
4. Minimal example

- Remove or update stale docs in the same change; do not leave contradictory guidance.

## Delivery Standard
- Every change should make onboarding, day-1 setup, and day-2 iteration simpler for developers building on Cloudflare Workers.
- Features are complete when they work correctly, perform well, and require no additional developer configuration for the common case.
- If a task is large, build it anyway. Size is not a reason to ship a partial solution.

## Non-Goals
- Do not optimize for generic multi-runtime abstractions at the cost of Cloudflare-first DX.
- Do not introduce patterns that increase cognitive overhead when a simpler convention-based option exists.
- Do not prioritize framework-internal cleverness over predictable behavior, debuggability, and clear escape hatches.
- Do not break native HTML-first workflows by forcing unnecessary client-side JavaScript for core form and page interactions.
- Do not patch symptoms. Fix root causes at the framework level.

## Architectural Decision Log

These decisions shape the framework's structure. Read them before changing anything that touches the same surfaces — they capture WHY current choices exist so a future agent doesn't unwind them on instinct.

| Date | Decision | Reason |
|------|----------|--------|
| 2026-04-19 | Route files use the `.koze` extension, not `.html`. | The files aren't HTML — they contain JS control flow (`if`/`for`), `{expression}` interpolation, `$server/*` RPC imports. A dedicated extension lets Vite/Rollup/Prettier/editors/agents route through the right handler instead of fighting HTML-tooling assumptions. Matches Svelte/Vue/Astro precedent. |
| 2026-04-19 | Compiler primitives are exported from `koze/compiler`. The Vite plugin (and any future tooling) delegates, doesn't duplicate. | Prevents compiler drift and keeps the Vite plugin focused on orchestration. |
| 2026-04-25 | Components also use the `.koze` extension (not `.html`). | Single canonical extension across the codebase. Removes the "is this a route or a component?" file-type ambiguity. Aligns with Svelte (`.svelte`) / Vue (`.vue`) / Astro (`.astro`) — none separate route vs. component by extension. The component file kind is determined by import context, not filename. |
| 2026-04-25 | Components can live anywhere except `src/routes/`. | Co-location works (`src/lib/widgets/chart.koze`), packages work, `$lib/` works. Only `routes/` is forbidden — that's the one footgun strong enough to enforce, prevents accidentally double-rendering a route through `<MyRoute />`. |
| 2026-04-25 | Explicit `import { props } from 'koze:component'` replaces the ambient `props` reference in components. | The pre-import "ghost props" pattern violated explicit > implicit, was untyped without a code generator, and confused new authors. The new pattern is callable + indexable (`props<T>()` AND `props.x`), TypeScript-typed via the generic, and follows the same `koze:*` virtual-module convention as `koze:request` / `koze:navigation`. Slot semantics keep the platform-native `<slot></slot>` element — no `{@render children()}` ceremony. |
| 2026-04-25 | Folded the Vite plugin into `koze` (now lives at `src/vite/`). | There is only one bundler integration (Cloudflare Workers + Vite). Keeping the plugin in the same package eliminates split-version drift while keeping `koze/vite` a separate subpath so Worker bundles tree-shake cleanly. |
| 2026-04-25 | Deleted project-level config file. Request-time composition lives in `src/middleware.ts`, and build-time options live on `koze({ security: {...} })`. | The framework is decoupled from external ORM or auth packages; middleware steps compose explicitly in `src/middleware.ts`. |
| 2026-05-12 | Route files use one top-level `<script>` block. Additional route scripts are errors. | The top script is client-first with explicit server escape hatches and SSR hydration. Allowing extra body scripts created a second compiler path and made route ownership ambiguous. Long client code belongs in `$lib/*`; DOM-only work runs inside browser-called functions. |
| 2026-05-12 | Browser `$server/*` calls go through the Cap'n Web channel and return thenable `AsyncValue`s. | The channel is now the transport source of truth for browser RPC state. It preserves `.pending` / `.success` / `.error`, dispatches `koze:invalidate-reads`, and keeps future HTTP/WebSocket optimization behind one framework-owned surface. |
| 2026-05-12 | Async boundaries use plain `AsyncValue` branches instead of Svelte `{#await}` syntax. | Koze templates already support native `if`/`else` control flow. Treating `.pending` as the compiler signal keeps RPC/loading state composable with normal JavaScript and avoids importing Svelte-only block syntax into the framework API. |
| 2026-05-12 | Form actions use one context-object calling convention everywhere: `fn(...args, ctx)`, where `ctx` includes `{ formData, request, url, params, env, ctx, locals }`. | Native forms, enhanced forms, and button-triggered actions share the same server signature; forms pass no positionals, button actions pass call-site args before the context object. |
| 2026-05-12 | `navigateTo()` and `refreshRoute()` are the client-history navigation APIs. | Same-origin navigation fetches HTML, updates `history`, swaps the document, emits `koze:navigation`, and falls back to native navigation if the response is not an HTML page. `refreshRoute()` reuses the same pipeline for current-route invalidation. Link interception remains intentionally separate; these are explicit helpers for browser event handlers. |
| 2026-07-27 | Vite is the only application build path. Removed the whole-project `compile()` emitter, generated-worker/createApp runtimes, `.kuratchi` inputs, and deprecated compatibility aliases. Build integrations consume `createKozeCompiler()`. | The second compiler duplicated route discovery, Worker emission, and runtime behavior, obscuring which path defined the product. Koze keeps its compiler because the compiler defines the `.koze` language. |
| 2026-08-24 | Removed all Cloudflare product conventions, Wrangler mutation, platform artifact generation, generated DO facades/proxies, and product-specific runtime APIs. `koze:worker` now exports only `handleRequest`; applications own `src/worker.ts` and compose it with the peer `@cloudflare/vite-plugin`. | Koze's defensible center is the HTML-first application language and HTTP lifecycle. Cloudflare's official Vite plugin and native Worker APIs now provide first-request-to-production runtime parity. Mirroring fast-moving product schemas created framework bugs and hid identity, security, storage, and deployment decisions that must remain intentional. |
| 2026-08-25 | API routes use the fixed `src/routes/api/` source root and `/api` URL prefix. Removed the `koze({ api: ... })` option. | `routes` communicates URL addressability, while `public`, `client`, and `server` describe different concerns. Configuring the canonical convention only restated auto-discovery; unusual HTTP routing is clearer when composed explicitly in `src/worker.ts`. |
| 2026-11-07 | Removed the built-in CLI (`src/cli.ts`), scaffolder (`src/create/`), and migration audit (`src/migration-audit.ts`). | Vite and Wrangler own the development, build, preview, types, and deploy CLI lifecycle. Removing the built-in scaffolder decouples `@kuratchi/koze` from external UI/ORM/auth packages and leaves project templates to a separate package if needed later. |

## Open follow-ups

These are tracked in this file, not in a separate spike doc, so they stay visible:

- **Broaden Workers-runtime tests.** The native Worker fixture now covers SSR, native DO RPC, and a Queue handler through `@cloudflare/vitest-plugin`. Extend it for browser RPC transport, streaming, and production-build regressions as concrete cases arise.
- **`wrangler deploy` against a real Cloudflare account.** A real deploy of the Vite-built bundle has not been smoke-tested in this package checkout.
