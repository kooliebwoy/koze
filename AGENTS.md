# AGENTS.md

## Purpose
This document defines how coding agents should operate in `packages/koze`.

## Agent Role
The agent is an expert Cloudflare Workers framework architect. This means:
- You build features at the **framework level** — not hacks, not patches, not workarounds.
- You abstract Cloudflare platform complexity away from the developer. If something is hard, the framework handles it.
- You build features **completely, correctly, and performantly** — regardless of task size. No partial implementations. No deferred complexity. No TODOs left in shipped code.
- You default to doing the work, not explaining why it's hard.
- You think in systems: compiler, runtime, CLI, and packages must remain coherent after every change.

## Product Mission
Our ultimate goal is to deliver the best developer experience (DX) for Cloudflare Workers with an all-batteries-included framework, while reducing the mental model required to get started and ship production apps.

## What "Batteries Included" Means
Koze ships everything a developer needs to build a production Cloudflare app:
- Routing, rendering, and compiler — no configuration required to start.
- Auth (credentials, OAuth, guards, rate limiting, roles, turnstile, activity) — callable and config-driven.
- ORM targeting D1 and Durable Object SQLite — no raw SQL bootstrapping.
- Forms with native POST-Redirect-GET and progressive enhancement.
- Dev tooling, benchmarking, and type alignment with Wrangler bindings.

Developers should not have to wire any of this together manually. The framework does it.

## Package Scope: Apps and Libraries
Koze supports two categories of output, both built with the same framework:

**Fullstack Cloudflare Workers apps** — server-rendered pages, Durable Objects, D1, auth, forms, routing. Example: `apps/web`, `apps/site`.

**Library/package targets** — framework-built packages that ship reusable UI components or behavior for other Koze apps. Example: `packages/kuratchi-db-studio` (`@kuratchi/db-studio`) — a shared SQL browser component for D1 and Durable Object SQLite databases, built with the framework's HTML-first component model and distributed as `.koze` source files.

This means we **dog food everything**: Koze packages are built with Koze conventions. If a pattern isn't ergonomic enough to use in our own packages, it is not good enough to ship to developers.

## Framework Baseline
- Koze is Cloudflare Workers-native and Vite-default.
- Koze uses Svelte-inspired syntax and native HTML-first patterns.
- Route and component files use the `.koze` extension (HTML-shaped with native JS control flow, `{expression}` interpolation, `<slot>` composition, `$server/*` RPC imports).
- This package owns the framework end-to-end: compiler, runtime, CLI, and Vite plugin.
- The framework is convention-driven and middleware-composed: routes auto-discover from `src/routes/`, server units use singular suffixes (`.agent.ts`, `.workflow.ts`, `.queue.ts`, `.container.ts`, `.sandbox.ts`, `.do.ts`), and request-time concerns (auth, ORM auto-migration, security headers) live in `src/middleware.ts`. There is no project-level config file the framework reads.
- Plural server convention suffixes (`.agents.ts`, `.workflows.ts`, `.queues.ts`, `.containers.ts`, `.sandboxes.ts`, `.dos.ts`) are invalid and must fail early with a fix-it error.
- Auth is callable and config-driven (credentials, guards, rate limiting, OAuth, activity, roles, turnstile).
- Data layer targets Cloudflare D1 and Durable Object SQLite via `@kuratchi/orm`.
- Forms/actions favor native POST-Redirect-GET behavior and progressive enhancement.
- Types should align with Wrangler-generated bindings (`wrangler types`).

## Internal Layout
The package contains four source layers, each with a clear scope:

| Path | Scope | Consumers |
|---|---|---|
| `src/compiler/` | Parses `.koze` files, emits Worker code. | Vite plugin, legacy CLI. |
| `src/runtime/` | Request-time helpers (router, request, navigation, security, workflow, stream, …). Runs inside the Worker. | App routes/layouts/components at request time. |
| `src/vite/` | Vite plugin: discovers routes, registers virtual modules (`koze:*`), keeps `wrangler.jsonc` in sync, orchestrates client/SSR builds. Imports from `src/compiler/` via relative paths. | Apps via `import { kuratchi } from '@kuratchi/koze/vite'`. |
| `src/index.ts` | Top-level public surface (utility re-exports). | Apps. |

**Rule:** the Vite plugin in `src/vite/` is plugin orchestration only. All compiler logic lives in `src/compiler/`. Don't duplicate parsing, codegen, or component compilation in `src/vite/` — extend the compiler primitive and consume it. If you find yourself adding template parsing or AST transforms inside `src/vite/`, stop and move it.

## Working Principles
- **Build it, don't defer it.** If a task requires a feature, implement the feature — completely — at the framework level. Do not leave complexity for the app developer.
- **Abstract at the right layer.** Platform complexity belongs in the framework, not in user code.
- **No hacks.** If a fix requires a workaround, find the correct solution instead. Hacks compound.
- Prioritize DX over cleverness: prefer clear APIs, predictable behavior, and low setup friction.
- Keep Cloudflare-first defaults: D1, Durable Objects, Workers runtime, and Wrangler-aligned typing.
- Minimize cognitive load: reduce boilerplate, centralize configuration, and provide sensible defaults.
- Preserve consistency across compiler, runtime, and CLI so features feel unified.
- Favor safe incremental changes with strong TypeScript signals and practical docs/examples.

## Source of Truth
- Primary framework package: `packages/koze`.
- Primary validation app: `apps/web`.
- Primary library dog food example: `packages/kuratchi-db-studio` (`@kuratchi/db-studio`).
- Do not assume legacy/sample apps exist unless they are present in this repository.

## Required Verification Workflow
For changes in this package, run all of the following:
1. `bun run build` in `packages/koze` — also copies `src/vite/runtime/*.js` into `dist/vite/runtime/`.
2. `bun run check` in `packages/koze` — type-checks compiler, runtime, and Vite plugin together.
3. `bun run test` in `packages/koze` — exercises compiler unit tests AND the Vite plugin tests under `test/vite/`. The pre-existing failure set (documented in `TESTING.md`) is allowed; growing it is a regression.
4. `cd apps/web && bun run build` — exercises the legacy CLI compile path against a real app.
5. `cd apps/spike && bun run build` — exercises the Vite plugin path end-to-end (route discovery, components, virtual modules, manifest writeback).

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
- Detailed conventions, layout, fixture patterns, and the current list of pre-existing failing tests live in [`TESTING.md`](./TESTING.md). Update it in the same change as any test-infra modification.
- Vite plugin tests live under `test/vite/`. They run in the same Node pool as the compiler tests — the plugin code is plain Node, and its compiled output (a Worker bundle) is exercised end-to-end by `apps/spike` rather than a vitest fixture today.
- Workers-runtime tests (executing compiled output inside `workerd` via `@cloudflare/vitest-pool-workers`) are not yet wired. The dependency is installed; when they're needed, add a vitest project under `test/vite/integration/` against a fixture worker. Don't bypass that path by importing `dist/` output into a Workers test directly.

## Performance Guardrails
- Keep dev/prod compiler behavior functionally equivalent (dev readability is allowed).
- Keep injected client bridge consolidated to a single script.
- This checkout does not currently provide a dedicated framework benchmark script or benchmark artifact path; do not claim benchmark verification unless one is added to the repository.
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
- Do not require developers to hand-wire middleware-heavy auth/ORM bootstrapping for common use cases.
- Do not introduce patterns that increase cognitive overhead when a simpler config-driven or convention-based option exists.
- Do not prioritize framework-internal cleverness over predictable behavior, debuggability, and clear escape hatches.
- Do not break native HTML-first workflows by forcing unnecessary client-side JavaScript for core form and page interactions.
- Do not patch symptoms. Fix root causes at the framework level.

## Architectural Decision Log

These decisions shape the framework's structure. Read them before changing anything that touches the same surfaces — they capture WHY current choices exist so a future agent doesn't unwind them on instinct.

| Date | Decision | Reason |
|------|----------|--------|
| 2026-04-19 | Route files use the `.koze` extension, not `.html`. | The files aren't HTML — they contain JS control flow (`if`/`for`), `{expression}` interpolation, `$server/*` RPC imports. A dedicated extension lets Vite/Rollup/Prettier/editors/agents route through the right handler instead of fighting HTML-tooling assumptions. Matches Svelte/Vue/Astro precedent. |
| 2026-04-19 | Compiler primitives are exported from `koze/compiler`. The Vite plugin (and any future tooling) delegates, doesn't duplicate. | Prevents two-compiler drift, preserves the legacy CLI as a live baseline, keeps the Vite plugin small (orchestration only). |
| 2026-04-25 | Components also use the `.koze` extension (not `.html`). | Single canonical extension across the codebase. Removes the "is this a route or a component?" file-type ambiguity. Aligns with Svelte (`.svelte`) / Vue (`.vue`) / Astro (`.astro`) — none separate route vs. component by extension. The component file kind is determined by import context, not filename. |
| 2026-04-25 | Components can live anywhere except `src/routes/`. | Co-location works (`src/lib/widgets/chart.koze`), packages work, `$lib/` works. Only `routes/` is forbidden — that's the one footgun strong enough to enforce, prevents accidentally double-rendering a route through `<MyRoute />`. |
| 2026-04-25 | Explicit `import { props } from 'koze:component'` replaces the ambient `props` reference in components. | The pre-import "ghost props" pattern violated explicit > implicit, was untyped without a code generator, and confused new authors. The new pattern is callable + indexable (`props<T>()` AND `props.x`), TypeScript-typed via the generic, and follows the same `koze:*` virtual-module convention as `koze:request` / `koze:navigation`. Slot semantics keep the platform-native `<slot></slot>` element — no `{@render children()}` ceremony. |
| 2026-04-25 | Folded `@kuratchi/vite` into `koze` (now lives at `src/vite/`). | The split was paying ongoing cognitive tax for an option we were never going to exercise. There's only one consumer (Cloudflare Workers + Vite); a hypothetical second bundler integration is YAGNI; agents constantly had to re-decide "compiler primitive vs. plugin orchestration?" boundary on every change. The merge eliminates: two AGENTS.md files, two package versions, workspace dep plumbing (we hit the stale-registry-pin bug mid-PR), two READMEs documenting overlapping concerns, two verification gates. Worker bundles still tree-shake correctly because `koze/vite` is a separate package subpath — importing from `@kuratchi/koze/runtime/*` doesn't pull in plugin code. |
| 2026-04-25 | Slimmed `create-kuratchi` to a thin shim; scaffolding logic lives at `koze/create`. | `npm create <x>` is hard-wired to a registry package literally named `create-<x>` — that constraint is not negotiable. Everything else IS: the actual scaffolding code is framework-shaped logic that belongs alongside the framework. The shim is ~5 lines (parse argv, delegate); changes to scaffolding now happen in one place. |
| 2026-04-25 | Deleted `kuratchi.config.ts`. The framework is now convention-driven (auto-discovered routes, DOs, containers, workflows) plus middleware-composed (`src/middleware.ts` for auth, ORM auto-migration, custom steps). The Vite plugin owns build-time options (security headers, etc.) via `koze({ security: {...} })`. | The config file had drifted into a passthrough: every block was either orphaned (DOs/containers moved to convention discovery, CSS handled by Vite plugin), trivially inlinable (`security` -> Vite plugin option), or a glorified data carrier (`auth` already passed verbatim into `kuratchiAuthMiddleware(authConfig.auth)`). The 500-line regex-based `config-reading.ts` parser was the canary. Outcomes: (a) the framework no longer imports from `@kuratchi/orm` or `@kuratchi/auth` — both are libraries you opt into via middleware, not framework features; (b) `compile()` takes options, doesn't read files; (c) the `koze:migrations` virtual module is gone, replaced by the explicit `autoMigrate({ DB: schema })` middleware step from `@kuratchi/orm`; (d) no more `defineConfig` / `kuratchiConfig` / `AuthConfig` / `DatabaseConfig` types. |
| 2026-04-25 | Renamed `initDO` -> `autoMigrate` (overloaded). DO form: `autoMigrate(ctx.storage, schema)` runs DDL synchronously inside the constructor. D1 form: `autoMigrate({ DB: schema })` returns a middleware step that runs migrations once per worker isolate. | `initDO` conflated three ideas (init, migrate, return-an-ORM). Splitting `autoMigrate` (DDL only) from `kuratchiORM` (query client) makes each concern auditable. Same verb on both surfaces is the symmetry — D1 and DO get the same mental model, and there's no `koze:migrations` magic to wonder about. |
| 2026-04-25 | apps/web rebuilt to use `@kuratchi/auth` end-to-end with DO-per-org architecture. Per-org DO lives at `apps/web/src/server/auth.do.ts` (binding `ORG_DB`, class `OrgAuth`); admin D1 holds only the email-org index. | This is the canonical "real app" shape: framework's DO auto-discovery + `@kuratchi/auth`'s DO contract + `@kuratchi/orm`'s `autoMigrate` all composing through `src/middleware.ts`. The dogfood test surfaced real DX bugs in `@kuratchi/auth` (schema naming inconsistencies, missing email-verification flow, missing DO RPC methods for verify/invite) — those are fixed now. Future agents reading apps/web see the canonical pattern. The framework's role here was deliberately limited to: discover `*.do.ts` files -> auto-sync wrangler bindings + SQLite migration entries -> don't otherwise know auth/ORM exist. |
| 2026-05-08 | Server convention suffixes are singular-only: `.agent.ts`, `.workflow.ts`, `.queue.ts`, `.container.ts`, `.sandbox.ts`, `.do.ts`. | One file maps to one Cloudflare unit. The `<name>.<kind>.ts` rule is easier to teach, avoids plural/singular drift, and lets the compiler reject stale suffixes with direct rename guidance instead of silently missing files. |
| 2026-05-12 | Route files use one top-level `<script>` block. Additional route scripts are errors. | The top script is client-first with explicit server escape hatches and SSR hydration. Allowing extra body scripts created a second compiler path and made route ownership ambiguous. Long client code belongs in `$lib/*`; DOM-only work runs inside browser-called functions. |
| 2026-05-12 | Browser `$server/*` calls go through the Kuratchi Capn Web channel and return thenable `AsyncValue`s. | The channel is now the transport source of truth for browser RPC state. It preserves `.pending` / `.success` / `.error`, dispatches `koze:invalidate-reads`, and keeps future HTTP/WebSocket optimization behind one framework-owned surface. |
| 2026-05-12 | Async boundaries use plain `AsyncValue` branches instead of Svelte `{#await}` syntax. | Kuratchi templates already support native `if`/`else` control flow. Treating `.pending` as the compiler signal keeps RPC/loading state composable with normal JavaScript and avoids importing Svelte-only block syntax into the framework API. |
| 2026-05-12 | Form actions use one context-object calling convention everywhere: `fn(...args, ctx)`, where `ctx` includes `{ formData, request, url, params, env, ctx, locals }`. | Vite dev, generated Worker runtime, and legacy app runtime must agree. Native forms, enhanced forms, and button-triggered actions now share the same server signature; forms pass no positionals, button actions pass call-site args before the context object. |
| 2026-05-12 | `navigateTo()` and `refreshRoute()` are the client-history navigation APIs. | Same-origin navigation fetches HTML, updates `history`, swaps the document, emits `koze:navigation`, and falls back to native navigation if the response is not an HTML page. `refreshRoute()` reuses the same pipeline for current-route invalidation. Link interception remains intentionally separate; these are explicit helpers for browser event handlers. |

## Open follow-ups

These are tracked in this file, not in a separate spike doc, so they stay visible:

- **Workers-runtime tests.** `@cloudflare/vitest-pool-workers` is installed but not yet wired. When useful, add a vitest project under `test/vite/integration/` against a fixture worker that exercises real `apps/web` behavior (auth flows, RPC, streaming). See `TESTING.md`. Deferred until there's a specific behavioral regression worth covering.
- **`wrangler deploy` against a real Cloudflare account.** `wrangler deploy --dry-run` now validates apps/site and apps/web bundle shape on every build, but a real deploy of the Vite-built bundle hasn't been smoke-tested. Drop a real deploy on the first follow-up commit that lands deployable changes.
- **`@kuratchi/auth` activity DO methods.** The framework no longer auto-injects `__kozeLogActivity` / `__kozeGetActivity` onto generated DO RPC classes (those were a kuratchi.config.ts-era convenience). The `@kuratchi/auth` activity API still checks for `orgStub?.__kozeLogActivity` and falls back to admin-DB writes, so existing apps keep working. If/when `@kuratchi/auth` wants org-DB activity again, expose it as an explicit activity helper/mixin from `@kuratchi/auth/do` so the user opts in inside their `.do.ts` class.






