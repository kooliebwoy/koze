# RFC: Async Template Patterns

**Status:** Partially Implemented / Historical — the workflow-status portion of this RFC has shipped under a different API. Workflow polling now lives in the `koze:workflow` virtual module as `workflowStatus(name, id, { poll })` rather than per-workflow auto-generated `*WorkflowStatus` functions, and polling refreshes the whole route instead of individual elements. See `framework/workflows` in the docs for the current behavior. The rest of this document is preserved for historical context.

**Author:** Kuratchi Team  
**Created:** 2026-03-31  
**Updated:** 2026-04-01

## Summary

Replace `data-*` attributes (`data-poll`, `data-get`, `data-post`, `data-refresh`, `data-action`) with native JavaScript syntax in templates for async operations. This aligns with the framework's JS-in-template philosophy where `if`, `for`, and other control flow already work inline.

## Motivation

Current state:
- `data-poll`, `data-get`, `data-post` work but feel like magic attributes
- Inconsistent mental model: some JS is native (`if`, `for`), some is attribute-based
- Hard to compose and reason about

Proposed direction:
- All async patterns use native JS syntax
- Cleaner, more predictable API
- Better alignment with how developers think about async code

## Core Concept: Two Patterns

The developer chooses how to handle async based on their needs:

| Pattern | Returns | Behavior |
|---------|---------|----------|
| `const x = fn()` | `AsyncValue<T>` | Non-blocking. Has `.pending`, `.error`, `.success` metadata. |
| `const x = await fn()` | `T` | Blocking. Waits until resolved. No metadata. |

**Need loading/error states?** → Don't await, use the metadata  
**Just need the value?** → Await it

## AsyncValue API

When you call an async function without `await`, it returns an `AsyncValue<T>` that extends `T` with metadata:

```ts
interface AsyncValue<T> extends T {
  pending: boolean;   // true while loading
  error: string | null; // error message if failed, null otherwise
  success: boolean;   // true when resolved successfully
}
```

The `AsyncValue` **is** the value — you access properties and iterate directly. No `.data` wrapper needed.

### Usage patterns

**Basic async read:**
```html
<div>
const user = getUser(userId);

if (user.pending) {
  <ProfileSkeleton />
}

if (user.error) {
  <p>Failed: {user.error}</p>
}

<Profile name={user.name} avatar={user.avatar} />
</div>
```

**Async list:**
```html
<div>
const todos = getTodos();

if (todos.pending) {
  <TodoListSkeleton />
}

if (todos.error) {
  <p>Failed to load: {todos.error}</p>
}

for (const todo of todos) {
  <TodoItem todo={todo} />
}
</div>
```

**With success guard:**
```html
<div>
const todos = getTodos();

if (todos.pending) {
  <TodoListSkeleton />
}

if (todos.error) {
  <p>Failed: {todos.error}</p>
}

if (todos.success) {
  for (const todo of todos) {
    <TodoItem todo={todo} />
  }
}
</div>
```

**Multiple async values:**
```html
<div>
const user = getUser();
const notifications = getNotifications();

if (user.pending || notifications.pending) {
  <DashboardSkeleton />
}

<Dashboard user={user} notifications={notifications} />
</div>
```

**Blocking when you don't need states:**
```html
<script>
const todos = await getTodos(); // blocks, returns Todo[] directly
</script>

for (const todo of todos) {
  <TodoItem todo={todo} />
}
```

## Polling / Reactive Updates

For workflow status that updates over time, use the auto-generated `*WorkflowStatus` functions. These are generated for each `.workflow.ts` file:

- `migration.workflow.ts` → `migrationWorkflowStatus(instanceId, options)`
- `data-sync.workflow.ts` → `dataSyncWorkflowStatus(instanceId, options)`

```html
<div>
const status = migrationWorkflowStatus(instanceId, { poll: '2s' });

if (status.pending) {
  <p>Checking status...</p>
}

if (status.status === 'running') {
  <ProgressBar progress={status.output?.progress} />
}

if (status.status === 'complete') {
  <CompletedBanner />
}
</div>
```

### Polling options

```ts
interface PollOptions {
  poll: string;           // interval: '2s', '500ms', '1m'
  backoff?: boolean;      // exponential backoff (default: true)
  maxInterval?: string;   // cap for backoff (default: '5m')
  until?: (value: T) => boolean; // stop polling when true
}
```

**Stop polling on condition:**
```html
const status = migrationWorkflowStatus(instanceId, { 
  poll: '2s',
  until: (s) => s.status === 'complete' || s.status === 'failed'
});
```

## Mutations (replacing `data-post`)

For mutations, use form actions (existing pattern) or explicit mutation calls:

**Form action (preferred for forms):**
```html
<form action={createTodo}>
  <input name="title" />
  <button type="submit">Add</button>
</form>
```

**Button mutation:**
```html
<button onclick={deleteTodo(todo.id)}>Delete</button>
```

After mutation, the page re-renders with fresh data (POST-Redirect-GET pattern). View transitions handle visual continuity.

> **Note:** Optimistic UI patterns are out of scope for this RFC. We may revisit this in a future RFC.

## Compiler Implementation

### Detection

The compiler detects async boundaries by:
1. Function calls without `await` that return `Promise<T>` or `AsyncValue<T>`
2. Usage of `.pending`, `.error`, `.success` properties on the result

### Code generation

For each async boundary, the compiler:
1. Generates a fragment ID
2. Wraps the block in a streamable boundary
3. Injects minimal client JS for hydration
4. Sets up polling if `poll` option is present

### Server rendering

1. Initial render outputs the pending state content (where `.pending` is true)
2. Streams the resolved content when ready (or on next request for polling)

### Client hydration

1. Minimal JS subscribes to fragment updates
2. On update, swaps innerHTML (existing fragment swap mechanism)

## Migration Path

| Old API | New Pattern |
|---------|-------------|
| `data-get={fn()}` | `const x = fn(); if (x.pending) { ... }` |
| `data-poll={fn()} data-interval="2s"` | `const x = fn({ poll: '2s' }); if (x.pending) { ... }` |
| `data-post={fn()}` | `onclick={fn()}` or `action={fn}` |
| `data-refresh` | Automatic after mutations |
| `data-action` | Removed (was internal) |

## Open Questions

1. **Nested async values** — How do nested async values compose?
2. **TypeScript inference** — How do we type `AsyncValue<T> extends T` cleanly for arrays?
3. **SSR streaming** — Do we stream pending content or wait for resolution?

## Design Decisions

### No `.success` guard required for iteration

Developers handle state checks themselves using standard patterns:

```html
const todos = getTodos();

if (todos.pending) {
  <Skeleton />
} else if (todos.error) {
  <p>Failed: {todos.error}</p>
} else if (todos.length > 0) {
  for (const todo of todos) {
    <TodoItem todo={todo} />
  }
} else {
  <p>No todos yet.</p>
}
```

Or with `switch`:

```html
const todos = getTodos();

switch (true) {
  case todos.pending:
    <Skeleton />
    break;
  case !!todos.error:
    <p>Failed: {todos.error}</p>
    break;
  case todos.length === 0:
    <p>No todos yet.</p>
    break;
  default:
    for (const todo of todos) {
      <TodoItem todo={todo} />
    }
}
```

The framework doesn't enforce guards — developers use standard JS patterns they already know.

## Alternatives Considered

### `pending()` keyword

```html
const todos = getTodos();
pending (todos) {
  <Loading />
}
```

**Rejected:** Introduces a new keyword when standard `if (todos.pending)` works fine and is more consistent with JS.

### `await` with loading block

```html
const todos = await getTodos() {
  <Loading />
}
```

**Rejected:** Overloads `await` semantics in a confusing way.

### `defer` keyword

```html
defer const todos = getTodos();
```

**Rejected:** Doesn't provide a place for the loading UI.

### Keep `data-*` attributes

**Rejected:** Inconsistent with JS-in-template philosophy, harder to compose.

## Timeline

1. **Phase 1:** Implement `AsyncValue` type with `.pending`, `.error`, `.success` properties
2. **Phase 2:** Add polling support with inline options
3. **Phase 3:** Deprecate `data-poll`, `data-get`, `data-post`
4. **Phase 4:** Remove deprecated APIs

## References

- React Suspense
- Svelte await blocks
- Solid.js resources
- HTMX (for comparison of attribute-based approach)
