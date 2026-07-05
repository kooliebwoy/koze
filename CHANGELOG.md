# koze

## 0.0.41

### Added

- Browser `$server/*` calls now run through the Kuratchi Capn Web channel
  and return thenable `AsyncValue`s with `.pending`, `.success`, and
  `.error` state.
- POST form actions are progressively enhanced by the client bridge. Native
  no-JS POST behavior remains the fallback, while enhanced submissions use
  `fetch()`, expose `form[data-action-loading]`, follow redirects, and replace
  returned HTML for validation/error rerenders.
- `ActionContext` is exported for the framework action signature:
  `fn(...args, ctx)` where `ctx` includes `{ formData, request, url, params,
  env, ctx, locals }`.
- `navigateTo()` now performs same-origin client navigation with history
  updates, document replacement, `koze:navigation` events, and native
  browser navigation fallback.
- `refreshRoute()` refetches and replaces the current route through the same
  same-origin client navigation pipeline.
- Vite-generated route modules, layout/app modules, browser client fragments,
  generated worker virtual modules, and legacy compiler `routes.ts` output now
  include inline source maps where doing so does not leak server-only source
  into the browser.
- Runtime route, action, RPC, API route, and app config contracts are now
  generic over the app `Env`, preserving concrete Cloudflare binding types in
  TypeScript.
- Generated `app.d.ts` now includes explicit `$server/*` RPC module
  declarations that preserve server export parameters and awaited return
  types as browser `AsyncValue`s.

### Fixed

- Component browser island scripts now strip TypeScript-only `props<T>()`
  syntax the same way server-rendered component wrappers do.
- Component CSS scoping now preserves nested group at-rules such as `@media`
  and leaves keyframe selectors unscoped instead of corrupting them with the
  component scope class.
- Quoted attribute interpolations now receive the same TypeScript-backed
  syntax diagnostics as whole-value `{expr}` attributes.
- Source maps now map repeated identical template expressions to their own
  generated occurrences instead of only the first matching expression.
- Template parsing now preserves quoted `>` text, comparison expressions in
  attributes, and raw style-block braces without treating them as template
  syntax.
- Browser hydration now covers `bind:checked` updates through the same
  reactive scope pipeline as `bind:value`.

### Breaking Changes

- **Workflow status API unified under `koze:workflow`.** The auto-generated
  `<camel>WorkflowStatus(id, opts)` globals (one per `*.workflow.ts` file) have
  been removed. Import `workflowStatus` from the new `koze:workflow`
  virtual module instead and pass the workflow name as the first argument:

  ```ts
  // Before:
  const status = migrationWorkflowStatus(params.id, { poll: '2s' });

  // After:
  import { workflowStatus } from 'koze:workflow';
  const status = await workflowStatus('migration', params.id, { poll: '2s' });
  ```

  The first argument is typed as a string-literal union (`WorkflowName`) of
  your discovered `*.workflow.ts` basenames, so unknown names fail type-check.

- **`{ poll }` polling now refreshes the whole route**, replacing the
  element-scoped `data-poll={fn()} data-interval="..."` fragment mechanism for
  live workflow status. The framework injects a small directive script when
  polling is active, re-fetches the URL on each tick, and swaps `<body>`
  with the freshly rendered HTML. Stops automatically when `until(status)`
  returns true. Default `until` treats `'complete'`, `'completed'`,
  `'errored'`, or `'terminated'` as terminal.

## 0.0.35

### Patch Changes

- Add stateful `augment(action, hooks)` form actions with reactive
  `.pending`, `.success`, and `.error` state, hook-controlled redirect
  handling, and safer submit-button disabled-state restoration.

## 0.0.34

### Patch Changes

- Publish the latest framework, ORM, auth, and UI package updates for real app testing.

## 0.0.33

### Patch Changes

- Release the latest framework and ORM updates in one coordinated patch bump.

  `koze` now ships the virtual-module runtime cleanup around the
  `koze:*` import surface, including the published runtime entrypoints used by
  middleware, access, and generated worker code.

  `@kuratchi/orm` includes the latest adapter and migration-generator work so the
  ORM package stays aligned with the current framework surface.

## 0.0.14

### Patch Changes

- Consolidate all framework virtual modules under `koze:*` prefix:
  - `koze:environment` — `{ dev }` for build mode detection
  - `koze:request` — `{ url, pathname, params, locals, headers, method, slug }`
  - `koze:navigation` — `{ redirect }`
- All `koze:*` modules work in page routes, runtime hooks, DOs, and server modules
- Type declarations auto-generated in `app.d.ts`
- Legacy `koze/environment` still supported for backwards compatibility

## 0.0.13

### Patch Changes

- Move the runtime hook convention to `src/server/runtime.hook.ts` and fix async route compilation so imported action functions are not leaked into generated load return values.

## 0.0.12

### Patch Changes

- Add explicit MIT license metadata and package license files so both packages can be published and consumed as public open source packages.

## 0.0.10

### Patch Changes

- Publish latest framework and ORM for LLM docs compatibility

## 0.0.9

### Patch Changes

- Add `koze/environment` with a compile-time `dev` flag for server route scripts and reject it in client reactive scripts.

## 0.0.8

### Patch Changes

- Keep compiler code out of the root runtime entry so Worker bundles do not pull in Node-only build tooling.

## 0.0.7

### Patch Changes

- Remove the internal global Cloudflare env bridge and keep request env scoped to framework runtime context.

## 0.0.6

### Patch Changes

- Allow Cloudflare env access in route top-level server scripts while continuing to block env access in client and component scripts.
