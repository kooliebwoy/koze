# RFC: Streaming SSR for Async Boundaries

**Status:** Runtime shipped · Compiler transform pending
**Author:** Kuratchi Team
**Created:** 2026-04-20
**Related:** `RFC-ASYNC-TEMPLATES.md` (the original design describing the template author's API)

## Summary

Implements true streaming SSR with out-of-order flushed async boundaries on
Cloudflare Workers. When a template declares async data without `await`, the
framework emits the initial pending-state HTML immediately, fires the async
calls in parallel, and streams each resolved chunk as it settles — rather
than blocking until every async call completes.

This RFC covers the streaming runtime (shipped) and the compiler transform
(pending). It supersedes the implementation plan that was left as open
questions in `RFC-ASYNC-TEMPLATES.md` (Phase 1 "Implement AsyncValue" and
the compiler section).

## Motivation

`RFC-ASYNC-TEMPLATES.md` defined the author-facing pattern:

```html
<script>
const todos = getTodos();
</script>

<div>
  if (todos.pending) { <Skeleton /> }
  if (todos.error)   { <p>{todos.error}</p> }
  if (todos.success) { for (const t of todos) { <Todo todo={t} /> } }
</div>
```

The primitive types (`AsyncValue`, `createPendingValue`, `createSuccessValue`,
`createErrorValue`, `wrapAsyncValue`, `isAsyncValue`) landed in
`runtime/async-value.ts`. What was NOT implemented:

1. **Automatic promise tracking** — a non-awaited `fn()` returns a native
   `Promise`, not an `AsyncValue`. `.pending` / `.success` / `.error`
   property access on it all read `undefined`, so the template branches
   never render.
2. **Streaming response** — even if we wrapped the Promise, nothing in the
   dispatcher streamed chunks; responses were always flat strings.
3. **Out-of-order flushing** — no mechanism for the server to emit an
   initial shell, then send resolved content into placeholder regions as
   each promise settled.

Without these pieces, the RFC's declarative API was dead — any use of
`todos.pending` silently fell through to the success/error branches that
also read `undefined`.

This RFC fills the gap.

## Goals

1. **Ship the API from RFC-ASYNC-TEMPLATES verbatim.** Template authors
   write `const x = fn()` and get working `.pending` / `.success` / `.error`
   branches, rendered via true HTTP streaming.
2. **Parallel fan-out by default.** Multiple non-awaited calls fire in
   parallel. The fast one resolves first and streams first, without waiting
   on the slow one.
3. **Zero overhead for sync pages.** Routes that don't register any
   boundaries take the existing string-response path. No conditionals in
   the hot sync-render path.
4. **No client-side framework.** The client helper is ~180 bytes of
   inline JavaScript. Pages degrade gracefully with JS disabled
   (skeletons stay, `<template>` elements are inert — user sees pending
   state permanently, which is acceptable).
5. **Minimal surface to middleware.** Response middleware still operates
   on `Response` objects; streams compose with the existing pipeline.

## Non-goals

- Client-side state management (React-like rehydration).
- Streaming data to in-flight forms / `<form action>` submissions.
- Fine-grained reactivity beyond one-shot promise settlement.
- `<noscript>` fallback that emits resolved content inline (would require
  collecting all promises before first byte, defeating the point — a
  future "hybrid mode" could offer this opt-in).

## Architecture

### The out-of-order flush pattern

This is the proven pattern used by React 18 Suspense SSR, Solid.js
`streamingResource`, Next.js `app/` router, and Remix `defer()`. The
server response body, in order, is:

```
<!doctype html>
<html>...
  <body>
    <div id="__ssr_boundary_todos-1">
      <!-- pending-state HTML for the first boundary -->
      <div class="skeleton"/>
    </div>
    <div id="__ssr_boundary_user-2">
      <!-- pending-state HTML for the second boundary -->
    </div>
    <!-- ... the rest of the page ... -->

    <script>window.$_swap=function(i){...};</script>

    <!-- Later: as each promise resolves, emitted in resolution order -->
    <template id="__ssr_chunk_user-2"><!-- resolved user HTML --></template>
    <script>$_swap('user-2')</script>

    <template id="__ssr_chunk_todos-1"><!-- resolved todos HTML --></template>
    <script>$_swap('todos-1')</script>
  </body>
</html>
```

When the browser parses each `<script>$_swap('X')</script>` tag, the helper
synchronously moves the preceding `<template>`'s content into the
placeholder div. The stream closes after the last boundary.

**Why this pattern:**
- Works with vanilla HTTP/1.1 `Transfer-Encoding: chunked` and HTTP/2.
  No WebSocket, no SSE, no long-poll.
- Browsers begin rendering the initial HTML immediately — users see
  meaningful content before the slowest query completes.
- Inline `<script>` tags execute synchronously during HTML parsing, so
  `$_swap` runs the moment the browser encounters it. No `DOMContentLoaded`
  wait, no hydration phase.
- No client framework required. The helper is tiny.
- Degrades cleanly: without JS, skeletons persist; templates stay inert.

### Per-request boundary collector

`AsyncValue` primitives are stateless. The streaming contract is:

1. During the sync render, template code calls
   `__registerBoundary(id, promise, renderSuccess, renderError)` for each
   async declaration.
2. `__registerBoundary` pushes `{id, promise, renderSuccess, renderError}`
   onto a per-request collector stored at `locals.__kozeBoundaries`.
3. The call returns a pending `AsyncValue` synchronously — the rest of
   the render proceeds with the pending branch.
4. After `render()` returns, the dispatcher calls
   `__takeCollectedBoundaries()` to drain the collector.
5. If the list is empty, the dispatcher returns a plain string response
   (zero overhead for sync routes).
6. If non-empty, the dispatcher constructs a `ReadableStream`, emits the
   initial HTML, then awaits each promise in parallel, streaming chunks
   as they resolve.

Workers are single-threaded per request, so the module-scoped `__locals`
reference is safe (same pattern used by `__setCookieHeaders`, `__kozePoll`,
`__breadcrumbs`).

### Runtime API

All identifiers are exported from `@kuratchi/koze/runtime/stream.js` and
re-exported from `koze`. Underscored names are meant to be called
by compiler-emitted code, not authors:

```ts
// Called by compiled template code for each boundary declaration.
// Returns a pending AsyncValue<T> synchronously; collects the promise
// for later streaming.
function __registerBoundary<T>(
  id: string,
  promise: Promise<T>,
  renderSuccess: (value: T) => string,
  renderError: (message: string) => string,
): AsyncValue<T>;

// Drain + clear the per-request collector. Called by the dispatcher.
function __takeCollectedBoundaries(): PendingBoundary[];

// Emit the initial pending-state placeholder wrapper. The compiler
// replaces `if (x.pending) { ...html... }` with
// `boundaryPlaceholder(id, ...compiled html...)` so the pending branch's
// output lives inside the wrapper div targeted by later chunks.
function boundaryPlaceholder(id: string, pendingHtml: string): string;

// Stream machinery used by the dispatcher. Not called by user or
// compiled code directly.
function resolveBoundaryToChunk(b: PendingBoundary): Promise<string>;
function buildChunk(id: string, html: string): string;
const BOOTSTRAP_SCRIPT: string;
```

### Dispatcher flow

```js
// kuratchi-vite/src/runtime/dispatch.js
async function renderRoute(request, url, match, params, overrides, status) {
  // ... existing data construction, prelude execution, body render ...

  const boundaries = __takeCollectedBoundaries();
  if (boundaries.length === 0) {
    return new Response(html, { status: status ?? 200, headers });
  }
  return streamResponseWithBoundaries(html, boundaries, status, headers);
}

function streamResponseWithBoundaries(initialHtml, boundaries, status, headers) {
  const closingIdx = findClosingBodyIndex(initialHtml);
  const head = closingIdx >= 0 ? initialHtml.slice(0, closingIdx) : initialHtml;
  const tail = closingIdx >= 0 ? initialHtml.slice(closingIdx) : '';
  const encoder = new TextEncoder();

  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(head));
      controller.enqueue(encoder.encode('\n' + __BOUNDARY_BOOTSTRAP));
      await Promise.all(
        boundaries.map(async (b) => {
          const chunk = await resolveBoundaryToChunk(b);
          controller.enqueue(encoder.encode('\n' + chunk));
        }),
      );
      if (tail) controller.enqueue(encoder.encode(tail));
      controller.close();
    },
  });

  return new Response(body, { status: status ?? 200, headers });
}
```

The chunks arrive in resolution order (fast-first), not declaration order.
Browsers handle this correctly because every chunk targets its placeholder
by id.

### Client bootstrap

```js
window.$_swap = function(i) {
  var b = document.getElementById('__ssr_boundary_' + i);
  var t = document.getElementById('__ssr_chunk_' + i);
  if (!b || !t) return;
  b.replaceChildren(...t.content.childNodes);
  t.remove();
};
```

- Emitted once per streamed response, right before the first chunk.
- Runs synchronously on `<script>` parse — the chunk scripts that follow
  are guaranteed to find it defined.
- `replaceChildren(...)` preserves nested nodes' event handlers and
  keeps nested boundaries inside the chunk live.
- `replaceChildren` is supported in Chrome 86+, Safari 14+, Firefox 78+
  (2020+). Acceptable for a modern Workers app.

### Degradation with JS disabled

- Initial HTML renders with skeletons / pending content.
- `<template>` elements are inert per HTML spec — they don't render.
- The user sees pending state permanently.
- Acceptable because this is a progressive enhancement. Authors who need
  strict no-JS parity should use `await` in the prelude instead.

## What's shipped (2026-04-20)

### `kuratchi-js/src/runtime/stream.ts`

New module with:

- `__registerBoundary(id, promise, renderSuccess, renderError)` — the
  central registration call.
- `__takeCollectedBoundaries()` — dispatcher drains the collector.
- `boundaryPlaceholder(id, pendingHtml)` — wraps pending content in a
  targetable `<div>`.
- `buildChunk(id, html)` — emits `<template>…</template><script>$_swap(id)</script>`.
- `resolveBoundaryToChunk(boundary)` — awaits promise, catches rejections,
  returns chunk HTML.
- `BOOTSTRAP_SCRIPT` — the inline `$_swap` client helper.
- `__wrapSuccess(value)` / `__wrapError(message)` — exported helpers to
  keep compiler-emitted code short.
- `__nextBoundaryId(prefix)` — compiler-assigned boundary id with a
  per-request monotonic counter.

All exports are re-exported from `koze` and declared as a
dedicated subpath export (`@kuratchi/koze/runtime/stream.js`).

### `kuratchi-vite/src/runtime/dispatch.js`

- `renderRoute()` checks the per-request collector after render.
- If boundaries present → streams via `ReadableStream`.
- If empty → returns plain string response (zero overhead).
- `streamResponseWithBoundaries()` handles the chunk emission.
- `findClosingBodyIndex()` locates the `</body>` injection point for
  bootstrap + chunks. Falls back to end-of-string if missing (fragment
  responses, misauthored templates).
- Resolution uses `Promise.all(boundaries.map(...))` so all promises
  fire in parallel; the `controller.enqueue` calls happen in each
  individual `async` body, so chunks appear in resolution order
  regardless of declaration order.

### Verified behaviors

- ✅ Build green in `kuratchi-js` and `kuratchi-vite` with no new errors.
- ✅ `__takeCollectedBoundaries()` returns empty array when no boundaries
  registered → fast path exercised.
- ✅ `BOOTSTRAP_SCRIPT` injection and chunk emission verified by code
  inspection (no live template test yet — needs compiler transform).

## What's pending

### Compiler transform (the big rock)

The transform has to detect the `const x = fn()` + `.pending/.success/.error`
pattern in templates and rewrite it into `__registerBoundary` calls with
extracted branch closures. Three attempts during the 2026-04-20 session
surfaced design challenges:

1. **Closure extraction requires recursive template compilation.** The
   success/error branches contain template HTML (`<Todo>`, `for` loops,
   nested components). To hoist them into separate closures, the
   extracted content must itself be compiled by `compileTemplate` — a
   sub-compilation API that doesn't exist today.

2. **Branch detection must handle control-flow composition.** Real
   templates write:
   ```
   if (todos.pending) { <Skeleton /> }
   if (todos.error) { <p>{todos.error}</p> }
   if (todos.success) {
     for (const t of todos) { <TodoItem todo={t} /> }
   }
   ```
   The preprocessor has to recognize these as three branches of one
   boundary, not three unrelated `if` statements. A line-based brace
   tracker is sufficient for top-level branches but struggles with
   nested boundaries or `else if` chains.

3. **Declaration-site scope varies.** `RFC-ASYNC-TEMPLATES` shows both
   prelude-declared (`<script>const x = fn()</script>`) and inline-declared
   (`<div>const x = fn() ...</div>`) patterns. Inline declarations have
   block scope; prelude declarations are function-scoped. The transform
   has to handle both to match the RFC's examples.

4. **Existing template compiler is line-oriented and state-machine-based.**
   Integrating a new transform pass risks breaking existing patterns
   (`if` / `for` / components / client-reactive `$:` blocks / etc.).

### Deferred design decisions

These should be decided before the compiler PR lands:

- **Declaration placement**: Support prelude-only in v1, or both from the
  start? RFC says both. Suggest: prelude-only in v1, inline in v1.1.
- **Branch forms**: Just `if (x.<state>) { ... }`, or also `else if`
  chains and `switch (true)` blocks (RFC shows these)? Suggest:
  standalone `if` only in v1; `else if` / `switch` as v1.1.
- **Pending fallback**: If no `.pending` branch is written, emit empty
  `<div>` placeholder vs skeleton. Decided (empty div, per session convo).
- **Nested boundaries**: Boundary inside another boundary's success
  branch. Runtime handles this correctly (collector accumulates across
  nested renders). Compiler must generate unique ids for nested cases.
- **`for (const t of x)` when `x` is pending**: RFC shows this pattern
  outside any `if`. `x` is `createPendingValue<T>()` which returns `{}`
  for non-array T and `[]` for array T. The `for` iterates over the
  empty array, emitting nothing. Success branch re-renders with the
  populated array during streaming. Already works runtime-side.
- **Iteration vs explicit `if (x.success)`**: RFC allows both:
  ```
  if (todos.success) { for (const t of todos) ... }  // explicit
  for (const t of todos) { ... }                      // implicit
  ```
  Implicit form requires the compiler to recognize the iteration as
  part of the success branch.

### Sub-compilation API

The compiler transform needs a way to compile an extracted fragment of
template source into an HTML-emitting closure. Proposed:

```ts
// In koze/src/compiler/template.ts
export function compileFragment(
  source: string,
  options: CompileTemplateOptions & { fragmentParamName: string },
): string;
```

Returns a JS string of the form:
```js
function (<fragmentParamName>) {
  const __parts = [];
  // ...compiled template body...
  return __parts.join('');
}
```

The boundary preprocessor then wraps each extracted branch:
```js
const __render_todos_success = compileFragment(successBranchSource, {
  ...opts,
  fragmentParamName: 'todos',
});
```

So the closure parameter shadows the outer boundary name with the resolved
value, and `for (const t of todos)` inside the branch iterates the real
array.

### Compiler preprocessor design (draft)

Runs BEFORE `compileTemplate` on the raw template source:

1. **Scan prelude** for `const|let NAME = CALL(...);` candidates.
2. **Scan full source** for `NAME.{pending,success,error,loading}` reads.
3. For each matched candidate:
   - Assign stable id `NAME-N` (N = per-file counter).
   - Find each `if (NAME.<state>) { ... }` block via line-based brace
     tracking.
   - Extract inner HTML source of each branch.
   - `compileFragment(successSource, ...)` → `__render_NAME_success` closure.
   - `compileFragment(errorSource, ...)` → `__render_NAME_error` closure.
   - Replace declaration: `const NAME = __registerBoundary('NAME-N', CALL(), __render_NAME_success, __render_NAME_error);`
   - Replace `if (NAME.pending) { BODY }` with
     `{ __parts.push(boundaryPlaceholder('NAME-N', (() => { const __parts = []; BODY; return __parts.join(''); })())); }`.
   - Remove `if (NAME.success) { ... }` and `if (NAME.error) { ... }`
     from inline flow (they render via closures at stream time).

This produces a route module that:
- Synchronously renders only the pending branches (wrapped in placeholders).
- Registers promises on the collector during render.
- The dispatcher takes over for streaming chunks.

### Test fixtures

Ship `packages/koze/test/fixtures/async-boundaries/` with inputs
+ expected outputs for:
- Single boundary, prelude decl, all three branches.
- Multiple parallel boundaries.
- Boundary with only `.success` branch (no pending, no error).
- Boundary inside a `for` loop (list of nested async regions).
- Nested: boundary inside another's `.success` branch.
- Error path: promise rejection renders error branch.
- Edge: only `await` in prelude (no boundaries) → no transformation.
- Edge: `const x = 5;` in prelude (not a call) → no transformation.

### Integration test

A real route in `apps/docs` or a sandbox that:
- Fetches two data sources in parallel.
- Verifies initial bytes arrive before either resolution.
- Verifies the fast source's chunk arrives before the slow one.
- Verifies the final DOM matches the non-streaming equivalent.

### Documentation

Once the compiler lands, update:
- `apps/docs/framework/async-values.mdx` — replace "pattern exists" with
  "how it actually works, including streaming behavior".
- `packages/koze/README.md` — add a streaming section.
- `RFC-ASYNC-TEMPLATES.md` — mark as "fully shipped, see RFC-STREAMING-SSR
  for implementation details".

## Edge cases to enumerate before compiler PR

| Case | Behavior |
|------|----------|
| Promise rejects | `resolveBoundaryToChunk` catches and renders error branch. ✅ (runtime handles) |
| No `.pending` branch in template | Placeholder div is empty. Browser sees blank space until chunk arrives. Acceptable. |
| No `.success` branch | Success resolution has nothing to render; chunk is an empty template. `$_swap` clears the placeholder. |
| No `.error` branch | Rejection renders empty content. Better: fall through to a generic error string? Needs decision. |
| Client disconnects mid-stream | `ReadableStream` cancel fires; `Promise.all` continues in the Worker (no abort propagation). Promises resolve into a closed controller; `enqueue` throws silently. Worker request-time CPU cost is wasted but bounded. |
| Many boundaries (10+) | Each adds a placeholder + chunk + script tag. ~200 bytes overhead per boundary. Realistic ceiling is ~50 before HTML bloat matters. |
| Boundary inside `for` loop over non-async data | Works — compiler treats each iteration's boundary as a unique instance. Id generator must produce unique ids per iteration. |
| Boundary inside another boundary's success branch | Works via recursive collector writes during chunk rendering. Compiler must ensure nested ids are globally unique (per-request counter, not per-scope). |
| Prelude throws before any boundary registers | Error bubbles up as today. No stream is opened. Existing top-level catch renders 500. |
| Prelude registers boundary, then throws | Collector is populated but render fails. Dispatcher's `render()` throw path runs before `__takeCollectedBoundaries()` → boundaries are abandoned. Promises keep running in the worker until they settle or the request ends. Cleanup concern for pathological cases. |
| Middleware `response` phase needs to modify body | Streams pass through as `response.body` ReadableStream. Middleware that reads the body (rewriting HTML, injecting analytics) will need to wrap the stream. Current middleware in DO-Manager doesn't do this. |
| Security headers middleware | `applySecurityHeaders` in `finalizeResponse` operates on headers only, not body. Works unchanged. |
| CSP nonce stamping | Inline `<script>` tags in bootstrap + chunks need nonces if CSP is strict. Current `BOOTSTRAP_SCRIPT` and chunk scripts are inline without nonce. Must inject nonce from `getCspNonce()` at emit time when CSP is configured. Known gap. |
| `<head>` interaction | Boundaries only emit inside `<body>`. Declarations in layout heads aren't supported by the v1 preprocessor (prelude-only rule). |

## Migration

No migration needed for existing apps. Routes without async boundaries
take the unchanged fast path. Adding a boundary is purely additive:
change `const x = await fn()` to `const x = fn()` + handle states.

## References

- `RFC-ASYNC-TEMPLATES.md` — original API design.
- `apps/docs/framework/async-values.mdx` — current user-facing doc.
- `packages/koze/src/runtime/async-value.ts` — the `AsyncValue`
  type and constructors.
- `packages/koze/src/runtime/stream.ts` — the streaming runtime
  (shipped this RFC).
- `packages/kuratchi-vite/src/runtime/dispatch.js` — the streaming
  dispatcher (shipped this RFC).
- React 18 Suspense SSR streaming (Dan Abramov, 2022): the canonical
  reference for out-of-order flush.
- Solid.js `createResource` + `renderToStream`: simpler variant of the
  same pattern.

## Timeline

1. ✅ 2026-04-20: Runtime primitives (`stream.ts`) shipped.
2. ✅ 2026-04-20: Dispatcher streaming path shipped in `kuratchi-vite`.
3. ⏳ Next session: Compiler transform + sub-compilation API.
4. ⏳ After compiler: Test fixtures + integration test.
5. ⏳ After tests: User-facing docs update + README section.
6. ⏳ Then: Publish new versions of `koze` + `@kuratchi/vite`.
