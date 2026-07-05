# koze

Cloudflare Workers-native web framework with file-based routing, server actions, and Durable Object support.

## Install

```bash
npm install @kuratchi/koze
```

## Quick start

```bash
npx koze create my-app
cd my-app
bun run dev
```

## How it works

The `koze()` Vite plugin scans `src/routes/` during `vite build` and `vite dev`, then generates framework output:

| File | Purpose |
|---|---|
| `.koze/routes.ts` | Compiled routes, actions, RPC handlers, and render functions |
| `.koze/worker.ts` | Stable wrangler entry - re-exports the fetch handler plus all Durable Object and Agent classes |
| `.koze/do/*.ts` | Generated Durable Object RPC proxy modules for `.do.ts` file imports |

Point wrangler at the entry and you're done. **No `src/index.ts` needed.**

For the framework's internal compiler/runtime orchestration and tracked implementation roadmap, see [ARCHITECTURE.md](./ARCHITECTURE.md).

```jsonc
// wrangler.jsonc
{
  "main": ".koze/worker.ts"
}
```

## Routes

Place `.koze` files inside `src/routes/`. The file path becomes the URL pattern.

```
src/app.koze                 → document shell (optional)
src/routes/index.koze          → /
src/routes/items/index.koze    → /items
src/routes/blog/[slug]/index.koze → /blog/:slug
src/routes/layout.koze        → shared layout wrapping all routes
```

> **File extension:** Every Koze source file uses the `.koze` extension — both routes (`src/routes/`) and components (anywhere else). The compiler only discovers files ending in `.koze`; plain `.html` files in `src/routes/` are ignored. Use `.html` only for genuine static-HTML assets served from `src/assets/`.

### Execution model

Koze routes are SSR by default, with a client-first authored `<script>` model.

- `src/routes` defines server-rendered route modules.
- Top-level `<script>` blocks in `app.koze`, `layout.koze`, and pages are authored as client-first code.
- `$server/*` imports are the explicit server/RPC escape hatch.
- `const x = await serverFn()` blocks SSR until the value resolves, then hydrates that value into the browser copy.
- `const x = serverFn()` returns an async value with `.pending`, `.error`, and `.success` for non-blocking SSR + streaming.
- Template expressions, reactive attributes, `if`, and `for` blocks render on the server for the initial response and update in the browser when they read reactive state.
- `src/server` is for private server-only modules and reusable backend logic.
- `src/middleware.ts` is the request middleware entrypoint for interception and guards.
- Reactive `$:` code runs in the client copy of the top script.

Route files still render on the server, but the authored script model matches the web: keep top-level script logic browser-friendly, and use `$server/*` when you need the framework to cross into server execution.

### Client reactivity

Koze uses `$:` as the reactive primitive:

- Top-level `let` bindings become reactive when they are read by `$:`, `bind:value`, or a live template expression.
- `$: name = expression` defines derived state (and auto-declares `name` if you didn't write `let name` already).
- `$: statement` and `$: { ... }` define effects.
- Template text, normal attributes, `if` blocks, and `for` blocks that read reactive state update in the browser.
- `bind:value={state.path}` wires form controls back into reactive state.
- Bindings inside template loops can use loop locals directly, like `bind:value={forms[item.id].selected}`.

```html
<script>
  const allCells = await listCells();

  let selectedLocationId = '';
  let selectedCellId = '';
  let selectOptions = [];

  $: selectOptions = allCells.filter(
    cell => cell.locationId === selectedLocationId,
  );

  $: if (!selectOptions.some(cell => cell.id === selectedCellId)) {
    selectedCellId = '';
  }
</script>

<select bind:value={selectedLocationId}>
  <option value="">Choose...</option>
  for (const location of locations) {
    <option value={location.id}>{location.name}</option>
  }
</select>

<select bind:value={selectedCellId}>
  <option value="">Choose...</option>
  for (const cell of selectOptions) {
    <option value={cell.id}>{cell.name}</option>
  }
</select>
```

Route files use one top-level `<script>` block. Do not add browser-only script blocks after the template; move long helpers into `$lib/*` modules and keep direct DOM work inside browser-called functions.

### Route file structure

```html
<script>
  import { getItems, addItem, deleteItem } from '$server/items';

  const items = await getItems();
  const suggestions = addItem();
</script>

<!-- Template — plain HTML with minimal extensions -->
if (suggestions.pending) {
  <p>Saving…</p>
} else if (suggestions.error) {
  <p>{suggestions.error}</p>
}

<ul>
  for (const item of items) {
    <li>{item.title}</li>
  }
</ul>
```

The `$server/` alias resolves to `src/server/`. Use that as the canonical home for reusable server-only modules.
Private server logic should live in `src/server/` and be imported into routes explicitly.

### Static assets (`src/assets`)

Put plain CSS, images, and other static files in `src/assets/`.

Koze mirrors that directory into the generated public assets output and keeps Wrangler's `assets.directory` in sync automatically, so you can reference files with `/assets/...` by default.

```html
<link rel="stylesheet" href="/assets/app.css" />
```

If you want a different public URL prefix, pass `assetsPrefix` as a Vite plugin option (or to `compile()` directly when using the legacy CLI):

```ts
// vite.config.ts
import { koze } from '@kuratchi/koze/vite';
export default defineConfig({
  plugins: [koze({ /* assetsPrefix: '/static/' coming from compile() */ })],
});
```

The `koze()` plugin currently ships `routesDir`, `serverDir`, `libDir`, and `security` options; `assetsPrefix` is wired through `compile()` for the legacy CLI path and inherits the default `/assets/` for the Vite path.

### Server-side asset access

Use the `koze:assets` virtual module when server code needs to read a static asset through the app's configured `ASSETS` binding.

```ts
import { fetchAsset } from 'koze:assets';

const response = await fetchAsset('/reports/q126_breakdown_by_product_devplat.csv');
if (!response.ok) return null;
const csv = await response.text();
```

Pass the same public URL path you would use in markup, not the source file path. For example, if the asset is reachable in the browser at `/reports/data.csv`, pass `/reports/data.csv`.

Behavior:

- Uses the current request origin in dev so asset fetches behave the same way as the running app.
- Falls back to an internal asset hostname when there is no active request context.
- Returns the raw `Response` so your code controls parsing (`text()`, `json()`, `arrayBuffer()`, headers, status handling).

Failure behavior:

- Throws if the app does not have an `ASSETS` binding configured.
- Does not coerce missing assets into `null`; check `response.ok` yourself and handle 404/403/other statuses explicitly.

### CSS processing

CSS files in `src/assets/` can be processed during build. All CSS tooling is **opt-in** — install only what you need.

#### Minification

To enable CSS minification via [Lightning CSS](https://lightningcss.dev/):

```bash
npm install lightningcss
```

Minification is automatic in production builds when `lightningcss` is installed.

#### Tailwind CSS

To enable Tailwind, install the required packages and pass the `css` option to `compile()` (legacy CLI) or wire Tailwind directly into your Vite config (Vite path):

```bash
npm install tailwindcss @tailwindcss/postcss postcss
```

For the Vite path, the standard PostCSS / Tailwind v4 setup works (`postcss.config.js` + a CSS file with `@import 'tailwindcss';`).

Then use Tailwind's CSS-first configuration in your CSS file:

```css
/* src/assets/app.css */
@import "tailwindcss";
@plugin "daisyui";
```

#### CSS config options

```ts
css: {
  tailwind: boolean;     // Enable Tailwind processing (default: false)
  plugins: string[];     // Tailwind plugins to load (default: [])
  minify: boolean;       // Enable minification (default: true in production, requires lightningcss)
}
```

### App shell and layout

`src/app.koze` owns the document shell. It contains `<!DOCTYPE html>`, `<html>`, `<head>`, and `<body>` and renders the composed layout/page output through exactly one `<slot></slot>`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>My App</title>
</head>
<body>
  <slot></slot>
</body>
</html>
```

`src/routes/layout.koze` wraps every page as a fragment. Use `<slot></slot>` where page content renders:

```html
<script>
  import { url } from 'koze:request';

  const currentPath = url.pathname;
</script>

<nav>
  <a href="/" class={currentPath === '/' ? 'active' : ''}>Home</a>
  <a href="/items" class={currentPath.startsWith('/items') ? 'active' : ''}>Items</a>
</nav>

<main>
  <slot></slot>
</main>
```

## Template syntax

### Interpolation

```html
<p>{title}</p>
<p>{@html bodyHtml}</p>  <!-- sanitized HTML -->
<p>{@raw trustedHtml}</p> <!-- unescaped, unsafe -->
```

### Conditionals

```html
if (items.length === 0) {
  <p>Nothing here yet.</p>
} else {
  <p>{items.length} items</p>
}
```

### Loops

```html
for (const item of items) {
  <li>{item.title}</li>
}
```

### Attribute expressions

Use `{expression}` in attribute values for dynamic content:

```html
<!-- Ternary expressions -->
<div class={isActive ? 'active' : 'inactive'}>...</div>
<button class={count > 0 ? 'has-items' : ''}>View ({count})</button>

<!-- Any JS expression -->
<a href={`/items/${item.id}`}>{item.name}</a>
<img src={user.avatar} alt={user.name} />
```

### Boolean attributes

Boolean attributes like `disabled`, `checked`, `selected`, etc. are conditionally rendered based on the expression value:

```html
<!-- Renders: <button disabled> or <button> -->
<button disabled={isLoading}>Submit</button>

<!-- Form elements -->
<input type="checkbox" checked={todo.completed} />
<option selected={item.id === selectedId}>{item.name}</option>

<!-- Other boolean attributes -->
<details open={showDetails}>...</details>
<input readonly={!canEdit} />
<input required={isRequired} />
```

Supported boolean attributes: `disabled`, `checked`, `selected`, `readonly`, `required`, `hidden`, `open`, `autofocus`, `autoplay`, `controls`, `default`, `defer`, `formnovalidate`, `inert`, `loop`, `multiple`, `muted`, `novalidate`, `reversed`, `async`.

### Components

Components are `.koze` files imported by name. Three resolution rules cover every common case:

```html
<script>
  // 1. $lib alias  → src/lib/<name>.koze
  import Card from '$lib/card.koze';

  // 2. Package     → node_modules/@scope/pkg/src/lib/<name>.koze
  import Badge from '@kuratchi/kuzan/badge.koze';

  // 3. Relative    → resolved against the importer's directory
  import Chart from './widgets/chart.koze';
</script>

<Card title="Stack">
  <Badge variant="success">Live</Badge>
  <Chart series={data} />
</Card>
```

**Components can live anywhere** in your project — `src/lib/` is the conventional default for shared components, but co-location (`src/lib/widgets/chart.koze`, etc.) is fully supported via relative imports.

**One hard rule:** components cannot live under `src/routes/`. The compiler throws a clear error if you try to import a route file as a component. Route files are routes; components are components. If you need to share markup between routes, move it to `$lib/`.

### Component props (`koze:component`)

Components declare their props with an explicit import — no ambient `props` reference:

```html
<!-- src/lib/card.koze -->
<script>
  import { props } from 'koze:component';

  const { title, variant = 'default' } = props<{
    title?: string;
    variant?: 'default' | 'success';
  }>();
</script>

<div class="card card-{variant}">
  if (title) {
    <h2>{title}</h2>
  }
  <slot></slot>
</div>

<style>
  .card { border: 1px solid; padding: 1rem; }
  .card-success { border-color: green; }
</style>
```

**`props<T>()` is callable AND indexable.** Both styles work and reference the same data:

```html
<!-- Destructure (recommended) -->
<script>
  import { props } from 'koze:component';
  const { title } = props<{ title: string }>();
</script>
<h2>{title}</h2>

<!-- Property access (also valid) -->
<script>
  import { props } from 'koze:component';
</script>
<h2>{props.title}</h2>
```

**Slots** use the platform-native `<slot></slot>` element. Children passed between a component's open and close tags render at the slot site. The corresponding JS-level access (`props.children`) is available inside the script if you need it programmatically.

**Migration note:** the old "ambient props" pattern (referencing `props` without an import) is gone. Every component must `import { props } from 'koze:component'` if it touches the identifier.

### Client Reactivity (`$:`)

Inside the top `<script>` block, Koze supports Svelte-style reactive labels for the browser copy of the route/layout/app script:

```html
<script>
  let users = ['Alice'];

  $: console.log(`Users: ${users.length}`);

  function addUser() {
    users.push('Bob'); // reactive update, no reassignment required
  }
</script>
```

Block form is also supported:

```html
<script>
  let form = { first: '', last: '' };

  $: {
    const fullName = `${form.first} ${form.last}`.trim();
    console.log(fullName);
  }
</script>
```

Notes:
- Route files are server-rendered by default.
- Top-level `<script>` blocks are authored as client-first code; `$:` runs in the browser copy of that script.
- Object/array `let` bindings are proxy-backed automatically when `$:` is used.
- `$: name = expr` works; when replacing proxy-backed values, the compiler preserves reactivity under the hood.
- You do **not** need to predeclare derived aliases: `$: showDetails = selected === 'x'` is valid on its own.
- Do not run direct `document` / `window` access at top level. Keep browser-only DOM work inside event handlers or lazily called functions.
- You should not need `if (browser)` style guards in normal Koze top-script code. If a third-party module touches browser globals during import, wrap it in a lazy `$lib/*` helper.

### `$lib/` Shared Imports

Use `$lib/*` for shared browser-safe code that can execute during SSR and in the browser copy of the top script. The `$lib/` alias resolves to `src/lib/`.

```ts
// src/lib/format.ts
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}
```

```html
<script>
  import { formatBytes } from '$lib/format';
  import { getFiles } from '$server/files';
  
  const files = await getFiles();
</script>

for (const file of files) {
  <div>{file.name} - {formatBytes(file.size)}</div>
}
```

**Key behavior:**
- `$lib/` imports work in server templates (SSR) and the browser copy of the top script.
- Use for utilities, formatters, validators, and DOM helpers that are safe at import time.
- Route files allow one top-level `<script>` block. Additional `<script>` blocks are rejected so client/server execution stays predictable.

### Browser-only DOM Manipulation

For browser-only code, keep the DOM work inside a function that runs in
the browser. The route still has exactly one `<script>` block:

```html
<script>
  import { getMessages } from '$server/chat';
  import { initChatUI } from '$lib/chat-ui';

  const messages = await getMessages(chatId);

  function enableChatUI() {
    const chatId = window.location.pathname.split('/').pop();
    initChatUI(chatId);
  }
</script>

<div id="messages">
  for (const msg of messages) {
    <div>{msg.content}</div>
  }
</div>

<button onclick={enableChatUI()}>Enable chat UI</button>
```

Behavior:
- Koze adds `type="module"` for you when the top script contains ES module imports.
- `$lib/` imports are resolved for SSR and the browser bundle.
- `$server/` imports in the browser copy become RPC stubs backed by the Koze channel.

Failure and edge behavior:
- Namespace imports like `import * as api from '$server/foo'` are currently rejected in browser code.
- Remote call failures reject with the server error message when available, otherwise `HTTP <status>`.
- Additional route `<script>` blocks are compile errors. Move long code into `$lib/*` modules.

### Awaited remote reads

For renderable remote reads, use direct `await fn(args)` markup. Koze lowers it to a route query, renders it on the server, and refreshes it after successful remote calls.

```html
<script>
  import { getMigrationConnectionStatus } from '$server/incus';
</script>

<p>{await getMigrationConnectionStatus(sourceIp)}</p>
```

Behavior:
- The read runs during the initial server render.
- Koze emits refresh metadata so the same block can be re-fetched without a full page reload.
- Successful remote calls automatically invalidate awaited reads on the current page.

Failure and edge behavior:
- The supported syntax is direct markup form: `{await fn(args)}`.
- Awaited reads are intended for values that render cleanly to text/HTML output.
- Complex promise expressions or chained property access should be wrapped in a dedicated server helper that returns the render-ready value.

## Form actions

Export server functions from a route's `<script>` block and reference them with `action={fn}`. The compiler automatically registers them as dispatchable actions.

```html
<script>
  import { addItem, deleteItem } from '$server/items';
</script>

<!-- Standard form — POST-Redirect-GET -->
<form action={addItem} method="POST">
  <input type="text" name="title" required />
  <button type="submit">Add</button>
</form>
```

The action function receives a context object. Throw `ActionError` to surface a message back to the form - see [Error handling](#error-handling).

```ts
// src/server/items.ts
import { ActionError, type ActionContext } from '@kuratchi/koze';

export async function addItem({ formData, env, locals }: ActionContext): Promise<void> {
  const title = (formData.get('title') as string)?.trim();
  if (!title) throw new ActionError('Title is required');
  // write to DB...
}
```

The context carries `{ formData, request, url, params, env, ctx, locals }`.
For button-triggered actions, positional call arguments come first and
the same context object is appended as the final argument.

### Augmented Forms

Native POST forms work without JavaScript. Add the `augment` attribute
when you want the client bridge to augment the native form with Koze
action state:

```html
<form action={saveSettings} method="POST" augment>
  ...
</form>
```

Augmented forms:

- submits through `fetch()` with the compiler-injected `_action` field
- sets `form[data-action-pending="<name>"]` while pending
- disables submit buttons while pending
- follows redirects
- replaces the document with returned HTML for validation/error rerenders

### Redirect after action

Call `redirect()` inside an action or `load()` to immediately exit and send the user to a different URL. `throw redirect()` also works, but is redundant because `redirect()` already throws:

```ts
import { redirect } from 'koze:navigation';

export async function createItem({ formData }: FormData): Promise<void> {
  const id = await db.items.insert({ title: formData.get('title') });
  redirect(`/items/${id}`);
}
```

## Error handling

### Action errors

Throw `ActionError` from a form action to surface a user-facing message in the template. The error message is bound directly to the action by name — if you have multiple forms on the same page, each has its own isolated error state.

```ts
import { ActionError } from '@kuratchi/koze';

export async function signIn({ formData }: FormData) {
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;

  if (!email || !password) throw new ActionError('Email and password are required');

  const user = await db.findUser(email);
  if (!user || !await verify(password, user.passwordHash)) {
    throw new ActionError('Invalid credentials');
  }
}
```

In the template, the action's state object is available under its function name:

```html
<script>
  import { signIn } from '$server/auth';
</script>

<form action={signIn}>
  (signIn.error ? `<p class="error">${signIn.error}</p>` : '')
  <input type="email" name="email" />
  <input type="password" name="password" />
  <button type="submit">Sign in</button>
</form>
```

The state object shape: `{ error?: string, pending: boolean, success: boolean }`.

- `actionName.error` — set on `ActionError` throw, cleared on next successful action
- `actionName.pending` — set while the action is pending (CSS target: `form[data-action-pending]`)
- `actionName.success` — set after an augmented form action completes without redirecting

Thrown action errors re-render the page with `actionName.error`. Errors with a 5xx status are sanitized before reaching the browser.

### Load errors

Throw `PageError` from a route's load scope to return the correct HTTP error page. Without it, any thrown error becomes a 500.

```ts
import { PageError } from '@kuratchi/koze';

// In src/routes/posts/[id]/index.koze <script> block:
import { params } from 'koze:request';

const post = await db.posts.findOne({ id: params.id });
if (!post) throw new PageError(404);
if (!post.isPublished && !currentUser?.isAdmin) throw new PageError(403);
```

`PageError` accepts any HTTP status. The framework renders the matching custom error page (`src/routes/404.koze`, `src/routes/500.koze`, etc.) if one exists, otherwise falls back to the built-in error page.

```ts
throw new PageError(404);                          // → 404 page
throw new PageError(403, 'Admin only');            // → 403 page, message shown in dev
throw new PageError(401, 'Login required');        // → 401 page
```

For soft load failures where the page should still render (e.g. a widget that failed to fetch), return the error as data from `load()` and handle it in the template:

```html
<script>
  const { data: recommendations, error: recError } = await safeGetRecommendations();
</script>

(recError ? '<p class="notice">Could not load recommendations.</p>' : '')
for (const rec of (recommendations ?? [])) {
  <article>{rec.title}</article>
}
```

## Async Values

Koze provides a native JS pattern for handling async data with loading, error, and success states.

### Two Patterns

| Pattern | Returns | Use case |
|---------|---------|----------|
| `const x = fn()` | `AsyncValue<T>` | Need loading/error states |
| `const x = await fn()` | `T` | Just need the value (blocks) |

### AsyncValue API

When you call an async function without `await`, it returns an `AsyncValue<T>` with metadata:

```ts
interface AsyncValue<T> extends T {
  pending: boolean;   // true while loading
  error: string | null; // error message if failed
  success: boolean;   // true when resolved
}
```

Browser `$server/*` calls return the same thenable `AsyncValue` shape
through the Koze Capn Web channel. When a browser RPC succeeds or
fails, the runtime dispatches `koze:invalidate-reads` so hydrated
reactive effects can rerun against the latest server state.

Koze intentionally does not copy Svelte's `{#await}` block syntax.
Async state stays plain JavaScript: call without `await`, branch on
`.pending`, `.success`, or `.error`, and the compiler turns that
if-chain into the streaming boundary.

### Usage

```html
<div>
const todos = getTodos();

if (todos.pending) {
  <div class="skeleton">Loading...</div>
}

if (todos.error) {
  <p class="error">Failed: {todos.error}</p>
}

for (const todo of todos) {
  <TodoItem todo={todo} />
}
</div>
```

With `if/else`:

```html
<div>
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
</div>
```

### Live Workflow Status (`koze:workflow`)

Import `workflowStatus` from the `koze:workflow` virtual module to read a Cloudflare Workflow's status. The first argument is a compile-time-typed string-literal union of your discovered `*.workflow.ts` basenames; passing an unknown name is a type error.

```html
<script>
  import { params } from 'koze:request';
  import { workflowStatus } from 'koze:workflow';

  // Name is typed: only 'migration' | 'data-sync' | ... (whatever *.workflow.ts files exist)
  const status = await workflowStatus('migration', params.id, { poll: '2s' });
</script>

if (status.error) {
  <ErrorBanner error={status.error} />
} else if (status.status === 'running') {
  <ProgressBar progress={status.output?.progress} />
} else if (status.status === 'complete') {
  <CompletedBanner result={status.output} />
}
```

When you pass `{ poll }`, the framework injects a tiny directive script that re-fetches the URL every `interval` and swaps `<body>` with the freshly rendered HTML. Every `{status.*}` reference re-evaluates server-side on each tick — no client reactivity to wire up.

**Options:**

- `poll` — interval as string (`'2s'`, `'500ms'`, `'1m'`) or number of milliseconds. Omit for a one-shot read.
- `until(value)` — override the default terminal predicate. Default stops on `'complete'`, `'completed'`, `'errored'`, or `'terminated'`.

**Multiple polls on one page** — call `workflowStatus(..., { poll })` as many times as you like. The shortest interval wins, and polling only stops when every call reports terminal:

```html
<script>
  const statuses = Object.fromEntries(await Promise.all(
    activeJobs.map(async (j) => [j.id, await workflowStatus('migration', j.id, { poll: '2s' })])
  ));
</script>
```

### Blocking (await)

When you don't need loading states, use `await`:

```html
<script>
const todos = await getTodos(); // blocks until resolved
</script>

for (const todo of todos) {
  <TodoItem todo={todo} />
}
```

## Progressive Enhancement

### Button Actions

Use `onclick={fn(args)}` for button-style server actions:

```html
<button onclick={deleteItem(item.id)} type="button">Delete</button>
<button onclick={toggleItem(item.id, true)} type="button">Done</button>
```

### `data-select-all` / `data-select-item` — checkbox groups

Sync a "select all" checkbox with a group of item checkboxes:

```html
<input type="checkbox" data-select-all="todos" />

for (const todo of todos) {
  <input type="checkbox" data-select-item="todos" value={todo.id} />
}
```

## RPC

For Durable Objects, RPC is file-driven and automatic.

- Put handler logic in a `.do.ts` file in `src/server/`.
- Exported functions in that file become RPC methods.
- Import the `.do.ts` file directly — the framework auto-generates RPC proxies.
- RPC methods are still server-side code. They are exposed intentionally by the framework runtime, not because route files are client-side.

```html
<script>
  import { getOrgUsers, createOrgUser } from '$server/auth.do';
  const users = await getOrgUsers();
</script>

<form action={createOrgUser} method="POST">
  <input type="email" name="email" required />
  <button type="submit">Create</button>
</form>
```

### RPC Validation Without Dependencies

Koze ships a small built-in schema API for route RPCs and Durable Object RPC methods, so you do not need `zod`, `valibot`, or any other runtime dependency just to validate client-callable input.

Declare schemas in a companion `schemas` object. Keys must match the public RPC function or method names:

```ts
import { schema, type InferSchema } from '@kuratchi/koze';

export const schemas = {
  createSite: schema({
    name: schema.string().min(1),
    slug: schema.string().min(1),
    publish: schema.boolean().optional(false),
  }),
};

export async function createSite(data: InferSchema<typeof schemas.createSite>) {
  return { id: `${data.slug}-1`, publish: data.publish };
}
```

This works for normal exported route RPC functions without changing the function declaration style. The schema lives alongside the function instead of wrapping it.

Durable Object classes use the same convention via `static schemas`:

```ts
import { DurableObject } from 'cloudflare:workers';
import { schema, type InferSchema } from '@kuratchi/koze';

export default class SitesDO extends DurableObject {
  static schemas = {
    saveDraft: schema({
      title: schema.string().min(1),
      content: schema.string().min(1),
    }),
  };

  async saveDraft(data: InferSchema<(typeof SitesDO.schemas).saveDraft>) {
    return { ok: true, slug: data.title.toLowerCase().replace(/ /g, '-') };
  },
}
```

If the payload does not match the schema, Koze returns `400` with a validation error instead of executing the RPC. Schema-backed RPCs accept a single object argument.

Rules:
- Route RPC modules use `export const schemas = { ... }`.
- Durable Object classes use `static schemas = { ... }`.
- Schema keys must match public function or method names exactly.
- Schema-backed RPC entrypoints take one object argument.
- Today, the typed handler pattern is `InferSchema<typeof schemas.name>` or `InferSchema<(typeof MyDO.schemas).methodName>`.

Available schema builders:
- `schema({ ... })`
- `schema.string()`
- `schema.number()`
- `schema.boolean()`
- `schema.file()`
- `.optional(defaultValue)`
- `.list()`
- `.min(value)`

Example with nested objects, arrays, and defaults:

```ts
import { schema, type InferSchema } from '@kuratchi/koze';

export const schemas = {
  createProfile: schema({
    name: schema.string().min(1),
    info: schema({
      height: schema.number(),
      likesDogs: schema.boolean().optional(false),
    }),
    attributes: schema.string().list(),
  }),
};

export async function createProfile(data: InferSchema<typeof schemas.createProfile>) {
  return { ok: true, profile: data };
}
```

## Durable Objects

Durable Object behavior is enabled by filename suffix.

- Any file ending in `.do.ts` is treated as a Durable Object handler file.
- Any file not ending in `.do.ts` is treated as a normal server module.
- No required folder name. `src/server/auth.do.ts`, `src/server/foo/bar/sites.do.ts`, etc. all work.

### Writing a Durable Object

Extend the native Cloudflare `DurableObject` class. Public methods automatically become RPC-accessible:

```ts
// src/server/user.do.ts
import { DurableObject } from 'cloudflare:workers';

export default class UserDO extends DurableObject {
  async getName() {
    return await this.ctx.storage.get('name');
  }

  async setName(name: string) {
    this._validate(name);
    await this.ctx.storage.put('name', name);
  }

  // NOT RPC-accessible (underscore prefix)
  _validate(name: string) {
    if (!name) throw new Error('Name required');
  }

  // NOT RPC-accessible (lifecycle method)
  async alarm() {
    // Handle alarm
  }
}
```

**RPC rules:**
- **Public methods** (`getName`, `setName`) → RPC-accessible
- **Underscore prefix** (`_validate`) → NOT RPC-accessible
- **Private/protected** (`private foo()`) → NOT RPC-accessible
- **Lifecycle methods** (`constructor`, `fetch`, `alarm`, `webSocketMessage`, etc.) → NOT RPC-accessible

### Using from routes

Import from the `.do.ts` file directly using `$server/`:

```html
<script>
import { getName, setName } from '$server/user.do';

const name = await getName();
</script>

<h1>Hello, {name}</h1>
```

The framework handles RPC wiring automatically.

### Auto-Discovery

Durable Objects are auto-discovered from `.do.ts` files. **No config needed.**

**Naming convention:**
- `user.do.ts` → binding `USER_DO`
- `org-settings.do.ts` → binding `ORG_SETTINGS_DO`

**Override binding name** with `static binding`:
```ts
export default class UserDO extends DurableObject {
  static binding = 'CUSTOM_BINDING';  // Optional override
  // ...
}
```

The framework auto-syncs discovered DOs to `wrangler.jsonc`.

### Custom DO stub resolution

By default the framework's auto-discovered DO classes resolve via `idFromName('global')` (singleton instance per binding). Apps that need per-user / per-tenant routing register their own resolver at runtime:

```ts
// src/server/do-routing.ts
import { __registerDoResolver } from '@kuratchi/koze/runtime/do.js';
import { getCurrentUser } from '@kuratchi/kyzen';
import { env } from 'cloudflare:workers';

__registerDoResolver('USER_DO', async () => {
  const user = await getCurrentUser();
  if (!user?.organizationId) return null;
  const ns = (env as any).USER_DO;
  return ns.get(ns.idFromName(user.organizationId));
});
```

For auth-integrated routing specifically, `kyzen` exposes `getOrgStubByName(doName)` (sync — pass the routing key directly) and `getOrgClient(organizationId)` (async — resolves the routing key from the admin DB first). The package wires these internally during signin/signup so most apps just call `getCurrentUser()` and let the auth middleware handle routing.

## Agents

Koze treats `src/server/**/*.agent.ts` as a first-class Worker export convention.

- Any `.agent.ts` file under `src/server/` is scanned during build.
- The file must export a class with either `export class MyAgent` or `export default class MyAgent`.
- The compiler re-exports that class from `.koze/worker.js`, so Wrangler can bind it directly.
- `.agent.ts` files are not route modules and are not converted into Durable Object RPC proxies.

```ts
// src/server/ai/session.agent.ts
import { Agent } from 'agents';

export class SessionAgent extends Agent {
  async onRequest() {
    return Response.json({ ok: true });
  }
}
```

```jsonc
// wrangler.jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "AI_SESSION", "class_name": "SessionAgent" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["SessionAgent"] }
  ]
}
```

Failure and edge behavior:

- If a `.agent.ts` file does not export a class, the build fails.
- Koze only auto-discovers `.agent.ts` files under `src/server/`.
- You still need Wrangler Durable Object bindings and migrations because Agents run as Durable Objects.

## Workflows

Koze auto-discovers `.workflow.ts` files in `src/server/`. **No config needed.**

```ts
// src/server/migration.workflow.ts
import { WorkflowEntrypoint, WorkflowStep } from 'cloudflare:workers';
import type { WorkflowEvent } from 'cloudflare:workers';

export class MigrationWorkflow extends WorkflowEntrypoint<Env, MigrationParams> {
  async run(event: WorkflowEvent<MigrationParams>, step: WorkflowStep) {
    // workflow steps...
  }
}
```

On build, Koze:
1. Scans `src/server/` for `.workflow.ts` files
2. Derives binding from filename: `migration.workflow.ts` → `MIGRATION_WORKFLOW`
3. Infers class name from the exported class
4. Auto-adds/updates the workflow entry in `wrangler.jsonc`

**Zero config required.** Just create the file and the framework handles everything:
- `name`: derived from binding (e.g., `MIGRATION_WORKFLOW` → `migration-workflow`)
- `binding`: derived from filename (e.g., `migration.workflow.ts` → `MIGRATION_WORKFLOW`)
- `class_name`: inferred from the exported class

Examples:
- `migration.workflow.ts` → `MIGRATION_WORKFLOW` binding
- `bond.workflow.ts` → `BOND_WORKFLOW` binding
- `new-site.workflow.ts` → `NEW_SITE_WORKFLOW` binding

### Workflow Status Polling

Use `workflowStatus` from the `koze:workflow` virtual module to read a workflow's live status. The first argument is typed as a compile-time union of your discovered `*.workflow.ts` basenames, so unknown names fail type-check.

```html
<script>
  import { params } from 'koze:request';
  import { workflowStatus } from 'koze:workflow';

  const status = await workflowStatus('migration', params.id, { poll: '2s' });
</script>

if (status.status === 'running') {
  <div class="spinner">Running...</div>
} else if (status.status === 'complete') {
  <div>✓ Complete</div>
}
```

When you pass `{ poll }`, the framework re-fetches the page on each interval and swaps `<body>` with the fresh server render — no client reactivity code. Polling stops automatically when `until(status)` returns true (default: `status === 'complete' | 'completed' | 'errored' | 'terminated'`).

**Name mapping** (filename basename → `workflowStatus` name):

- `migration.workflow.ts` → `'migration'`
- `james-bond.workflow.ts` → `'james-bond'`
- `site.workflow.ts` → `'site'`

**Multiple polls on one page** — call `workflowStatus(..., { poll })` as many times as you need. The shortest interval wins, and polling stops only when every call reports terminal.

`status` is an `AsyncValue<T>` where `T` is the Cloudflare `InstanceStatus`:

```ts
{
  status: 'queued' | 'running' | 'paused' | 'errored' | 'terminated' | 'complete' | 'waiting' | 'unknown';
  error?: { name: string; message: string; };
  output?: unknown;
}
```

Plus the standard `AsyncValue` flags: `pending`, `error` (string | null), `success`.

## Queue Consumers

Koze auto-discovers `.queue.ts` files in `src/server/` for consuming Cloudflare Queue messages. **No config needed.**

```ts
// src/server/notifications.queue.ts
export default async function(batch: MessageBatch<NotificationPayload>, env: Env, ctx: ExecutionContext) {
  for (const message of batch.messages) {
    console.log('Processing notification:', message.body);
    // Handle the message...
    message.ack();
  }
}
```

On build, Koze:
1. Scans `src/server/` for `.queue.ts` files
2. Derives the expected queue binding from filename: `notifications.queue.ts` → `NOTIFICATIONS`
3. Auto-wires a unified `queue()` handler that dispatches to the correct file based on `batch.queue`

**Filename → Binding mapping:**
- `notifications.queue.ts` → expects `NOTIFICATIONS` queue binding
- `email-jobs.queue.ts` → expects `EMAIL_JOBS` queue binding

**Producer vs Consumer:**
- **Producer** (sending): Just call `env.QUEUE.send()` anywhere — no `.queue.ts` file needed
- **Consumer** (receiving): Create a `.queue.ts` file to handle incoming messages

**Requirements:**
- Define the queue in `wrangler.jsonc` with matching binding name
- Run `wrangler types` to get typed `env.QUEUE` bindings

## Containers

Koze auto-discovers `.container.ts` files in `src/server/`. On every build, the framework writes `containers[]`, `durable_objects.bindings`, and `migrations[].new_sqlite_classes` (when opted-in) into `wrangler.jsonc` — no manual entries required.

```ts
// src/server/wordpress.container.ts
import { Container } from 'cloudflare:workers';

export default class WordPress extends Container<Env> {
  static image = './docker/wordpress.Dockerfile';  // REQUIRED — Dockerfile path OR registry reference
  static instanceType = 'standard';                // 'lite' (default) or 'standard'
  static maxInstances = 5;
  static sqlite = true;                            // opt into new_sqlite_classes migration
}
```

**Image** accepts either a local Dockerfile path (wrangler resolves the build context) or a registry reference (`docker.io/library/redis:7.2-alpine`, etc.). If you omit `static image` and a sibling `<basename>.Dockerfile` exists next to the `.container.ts`, it's picked up automatically. Omitting both triggers a compile-time error.

Binding derivation follows the same rule as every other convention:

- `wordpress.container.ts` → `WORDPRESS_CONTAINER`
- `redis.container.ts` → `REDIS_CONTAINER`

Full reference: [Containers](../../apps/docs/src/content/koze/containers.md).

## Sandbox

Koze ships first-class support for [Cloudflare Sandbox](https://github.com/cloudflare/sandbox-sdk) — the Durable Object-backed runtime for ad-hoc shells, untrusted code, and code-interpreter agents — via its own `.sandbox.ts` convention. Sandbox is distinct from `.container.ts` because it's a specialized SDK: the class, image, and SQLite-storage requirement are all supplied by the framework.

```bash
bun add @cloudflare/sandbox
```

```ts
// src/server/shell.sandbox.ts
import { Sandbox } from '@cloudflare/sandbox';

export default class ShellSandbox extends Sandbox<Env> {}
```

That is the whole file. On build, Koze writes:

```jsonc
// wrangler.jsonc — auto-synced, do not edit by hand
{
  "containers": [
    { "name": "shell-sandbox", "class_name": "ShellSandbox", "image": "docker.io/cloudflare/sandbox:0.8.11", "instance_type": "lite" }
  ],
  "durable_objects": { "bindings": [{ "name": "SHELL_SANDBOX", "class_name": "ShellSandbox" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShellSandbox"] }]
}
```

No Dockerfile needed — the default image tag tracks the installed `@cloudflare/sandbox` version so the SDK and the container runtime can never drift. Override with `static image = '...'` for Python variants or custom builds.

### Multiple sandboxes in one project

Because binding + class + migration all derive from the filename, a project can host any number of sandboxes:

```
src/server/shell.sandbox.ts          → SHELL_SANDBOX       (default image)
src/server/python.sandbox.ts         → PYTHON_SANDBOX      (static image = '…:0.8.11-python')
src/server/code-interpreter.sandbox.ts → CODE_INTERPRETER_SANDBOX
```

### Usage

```ts
import { env } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';

export async function runCommand(name: string, command: string) {
  const sandbox = getSandbox(env.SHELL_SANDBOX, name);
  const { stdout, stderr, exitCode } = await sandbox.exec(command);
  return { stdout, stderr, exitCode };
}
```

The second argument to `getSandbox()` is a **routing key** (same semantics as `DurableObjectNamespace.idFromName`). Same key → same container; fresh key → fresh container. Treat the filesystem as scratch: `destroy()` wipes it, and Cloudflare may reclaim long-idle sandboxes.

**Healthcheck:** the top-level handle has no `ping()`; use `exec('true')` for a canonical liveness probe.

Full reference: [Sandbox](../../apps/docs/src/content/koze/sandbox.md).

## Convention-Based Auto-Discovery

Koze uses singular file suffixes to auto-discover and register worker classes. **No config needed** — just create the file. Plural suffixes like `.agents.ts`, `.workflows.ts`, or `.queues.ts` are rejected with a fix-it error.

| Suffix | Location | Binding Pattern | Example |
|--------|----------|-----------------|---------|
| `.workflow.ts` | `src/server/**/*.workflow.ts` | `FILENAME_WORKFLOW` | `migration.workflow.ts` → `MIGRATION_WORKFLOW` |
| `.container.ts` | `src/server/**/*.container.ts` | `FILENAME_CONTAINER` | `wordpress.container.ts` → `WORDPRESS_CONTAINER` |
| `.sandbox.ts` | `src/server/**/*.sandbox.ts` | `FILENAME_SANDBOX` | `shell.sandbox.ts` → `SHELL_SANDBOX` |
| `.queue.ts` | `src/server/**/*.queue.ts` | `FILENAME` | `notifications.queue.ts` → `NOTIFICATIONS` |
| `.agent.ts` | `src/server/**/*.agent.ts` | (manual wrangler config) | `session.agent.ts` |
| `.do.ts` | `src/server/**/*.do.ts` | filename or `static binding = '...'` | `auth.do.ts` → `AUTH_DO` |

## Automatic Wrangler Config Sync

Koze automatically syncs `wrangler.jsonc` during every build. This eliminates duplicate configuration for:

- **Workflows** — auto-discovered from `.workflow.ts` files
- **Containers** — auto-discovered from `.container.ts` files (writes `containers[]`, `durable_objects.bindings`, and opt-in SQLite migrations)
- **Sandboxes** — auto-discovered from `.sandbox.ts` files (same as containers plus default image resolution from the installed `@cloudflare/sandbox` version)
- **Queues** — auto-discovered from `.queue.ts` files
- **Durable Objects** — auto-discovered from `.do.ts` files

The sync is additive and non-destructive:
- New entries are added automatically
- Existing entries are updated if the class name changes
- Manually-added wrangler config (D1, KV, R2, vars, etc.) is preserved
- Removed entries are cleaned up from wrangler.jsonc

Requirements:
- Uses `wrangler.jsonc` or `wrangler.json` (TOML is not supported for auto-sync)
- Creates `wrangler.jsonc` if no wrangler config exists

## Runtime APIs

### Virtual Modules

In route `<script>` blocks, use the `koze:` virtual modules:

| Virtual Module | Description |
|----------------|-------------|
| `koze:request` | Request state. Route scripts get the safe subset; server modules also get `request`, `headers`, and `locals` |
| `koze:navigation` | Redirect and client navigation helpers, gated by context |
| `koze:cookies` | Server-only cookie read/write helpers |
| `koze:middleware` | Middleware definition helpers for `src/middleware.ts` |

### Request helpers

Import pre-parsed request state from `koze:request`. The compiler
enforces the safe subset — importing `locals`, `headers`, or any other
server-only value fails the build.

```ts
import { url, pathname, searchParams, params, slug, method } from 'koze:request';

const page = pathname;
const tab = searchParams.get('tab');
const postId = params.id;
const postSlug = slug;
```

- `url` is the parsed `URL` for the current request.
- `pathname` is the full path, like `/blog/hello-world`.
- `searchParams` is `url.searchParams` for the current request.
- `params` is the matched route params object, like `{ slug: 'hello-world' }`.
- `slug` is `params.slug` when the matched route defines a `slug` param.
- `method` is the HTTP method.

Inside `src/server/*.ts`, `koze:request` exposes the fuller server-side
surface:

```ts
import { request, url, headers, params, locals } from 'koze:request';
```

The route compiler still enforces the narrower route-safe subset in top
`<script>` blocks.

### Server Module Helpers

For server modules (`src/server/*.ts`), prefer the `koze:*` virtual modules:

```ts
import {
  redirect,
} from 'koze:navigation';
import { request, headers, locals } from 'koze:request';
import { cookies } from 'koze:cookies';
```

Use `cloudflare:workers` directly for `env`.

### Server-side redirect

Import `redirect` from `koze:navigation` in route scripts and server modules:

```ts
import { redirect } from 'koze:navigation';

// Redirect to another page (throws RedirectError, caught by framework)
redirect('/dashboard');
redirect('/login', 302);
```

`redirect()` works in route scripts and `src/server/*.ts` modules. Browser-only
navigation uses `navigateTo()`.

### Client navigation

Import `navigateTo` from `koze:navigation` inside browser event
handlers:

```html
<script>
  import { navigateTo } from 'koze:navigation';

  function openSettings() {
    navigateTo('/settings');
  }
</script>

<button onclick={openSettings()}>Settings</button>
```

For same-origin URLs, `navigateTo(path, { replace })` fetches the HTML
page, updates browser history, swaps the document, and dispatches a
`koze:navigation` event. If the client fetch fails or the response
is not HTML, it falls back to normal browser navigation.

Use `refreshRoute()` to refetch the current route without adding a new
history entry:

```html
<script>
  import { refreshRoute } from 'koze:navigation';

  async function refresh() {
    await refreshRoute();
  }
</script>

<button onclick={refresh()}>Refresh</button>
```

## Middleware

Optional request middleware file. Export a `MiddlewareDefinition` from
`src/middleware.ts` to intercept requests before they reach the framework router.
Use it for agent routing, pre-route auth, or custom response/error handling.

```ts
import { defineMiddleware } from 'koze:middleware';
import type { MiddlewareDefinition } from '@kuratchi/koze';

const middleware: MiddlewareDefinition = {
  agents: {
    async request(ctx, next) {
      if (!ctx.url.pathname.startsWith('/agents/')) {
        return next();
      }

      return new Response('Agent response');
    },
  },
};

export default defineMiddleware(middleware);
```

`ctx` includes:

- `ctx.url` - parsed URL
- `ctx.request` - raw Request
- `ctx.env` - Cloudflare env bindings
- `next()` - pass control to the next handler

## Environment bindings

Cloudflare env is server-only.

- Route top-level `<script>`, route `load()` functions, server actions, API handlers, and other server modules can read env.
- Templates, components, and client `<script>` blocks cannot read env directly.
- If a value must reach the browser, compute it in the server route script and reference it in the template, or return it from `load()` explicitly.

```html
<script>
  import { env } from 'cloudflare:workers';
  const turnstileSiteKey = env.TURNSTILE_SITE_KEY || '';
</script>

if (turnstileSiteKey) {
  <div class="cf-turnstile" data-sitekey={turnstileSiteKey}></div>
}
```

Server modules can still access env directly:

```ts
import { env } from 'cloudflare:workers';

const result = await env.DB.prepare('SELECT 1').run();
```

## Virtual Modules

Koze provides `koze:*` virtual modules for accessing framework state and utilities. These follow the same pattern as Cloudflare's `cloudflare:workers`.

### koze:environment

```ts
import { dev } from 'koze:environment';

if (dev) {
  // Skip auth checks, enable debug logging, etc.
}
```

- `dev` is `true` during `vite dev`, `false` in production

### koze:request

In route `<script>` blocks, only the compile-time safe subset is allowed.
Server-only state (`locals`, `headers`) must be read inside a `$server/*`
module or other server context via `koze:request`.

```ts
import { url, pathname, searchParams, params, slug, method } from 'koze:request';

console.log(url.href);
console.log(params.slug);
console.log(searchParams.get('tab'));
```

To access `locals` (e.g. `locals.userId`) from a template, wrap it in a
`$server/*` function and read them through `koze:request`:

```ts
// src/server/user.ts
import { locals } from 'koze:request';
export function currentUserId(): number {
  return (locals as App.Locals & { userId: number }).userId;
}
```

```html
<!-- src/routes/settings/index.koze -->
<script>
  import { currentUserId } from '$server/user';
  const userId = await currentUserId();
</script>
```

### koze:navigation

```ts
import { redirect } from 'koze:navigation';

// Server-side redirect (throws RedirectError)
redirect('/login', 303);
```

All `koze:*` modules work in:
- Page route scripts (`index.koze`)
- Middleware (`src/middleware.ts`)
- Durable Objects (`.do.ts`)
- Server modules (`src/server/*.ts`)

## Security

**Philosophy.** Koze enforces exactly two things: **origin integrity** (your server only accepts calls from your own browser code) and **visibility boundaries** (`_`-prefixed exports are unreachable from the outside). Everything else — authentication, authorization, rate limiting, audit logging — is your responsibility. A framework that auto-enforces auth creates a false sense of safety; a framework that enforces the origin boundary frees you to focus on the real question of *who* is allowed to do *what*.

There is no `KURATCHI_SECRET` to configure, no CSRF token in your HTML, no framework-level `requireAuth` toggle. The building blocks are the two unconditional guarantees below plus opt-in response headers.

### Default Security Headers

All responses include these headers automatically:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`

### Strict Same-Origin Gate (unconditional)

Every `?_rpc=…` request is rejected with `403` unless it carries either:

- `Sec-Fetch-Site: same-origin` (every modern browser sends this on same-origin `fetch()`), **or**
- `Origin: <same as request URL origin>`

Non-browser clients (curl, server-to-server scripts, cron jobs) and any cross-origin browser request are blocked before your handler runs. Same-origin form POSTs are accepted under a slightly relaxed rule (top-level navigations may omit `Sec-Fetch-Site`) but reject any cross-origin `Origin`.

Combined with `SameSite=Lax` on any session cookie an auth library sets, this eliminates classic CSRF attacks without the framework having to mint its own token. The gate is always on and cannot be disabled — RPC is designed to be reachable only from your own frontend.

### Public vs. Private Server Functions

One universal rule for what counts as externally reachable:

- **Exports whose name starts with `_` are private.** They cannot be referenced from a route template as an action, await-query, or RPC. They remain importable by other server-side code — `_helper()` called from a public server function still works.
- **Durable Object methods.** Only `public` methods that do not start with `_` are copied onto the generated DO class prototype. TS `private`/`protected` and `_`-prefixed methods are invisible to the Workers RPC binding at runtime, not just to the compiler proxy.
- **Lifecycle names** (`constructor`, `fetch`, `alarm`, `webSocketMessage`, `webSocketClose`, `webSocketError`, `onInit`, `onAlarm`, `onMessage`) are never exposed as RPC.

Referencing a `_` export from a route template is a **compile-time error**.

### Authentication and Authorization are Your Job

The framework populates `locals.user` and `locals.session` from whatever auth hook/library you plug in (e.g. `kyzen`). It never reads those values to decide whether to run your handler. Guard handlers explicitly:

```ts
import { requireAuth } from '@kuratchi/kyzen';

export async function deleteItem(id: string) {
  const user = await requireAuth();           // throws ActionError('Unauthorized') if missing
  if (!user.canDelete(id)) throw new ActionError('Forbidden');
  return db.items.delete(id);
}

// Private helper — framework refuses to expose it as RPC even if a template
// accidentally references it.
export async function _auditDelete(userId: string, itemId: string) {
  await db.audit.insert({ userId, itemId, action: 'delete' });
}
```

This keeps the auth model next to the operation it protects, where it belongs.

### Content Security Policy (with per-request nonces)

Configure response-header security through the Vite plugin's `security` option. To opt into strict CSP with per-request nonces on the framework-injected inline scripts (workflow poll, client bridge, theme init, etc.), use the literal placeholder `{NONCE}` in your policy — Koze generates a fresh nonce per request, substitutes it into the header, and stamps the same nonce onto every emitted `<script>` tag.

```ts
// vite.config.ts
import { koze } from '@kuratchi/koze/vite';

export default defineConfig({
  plugins: [
    koze({
      security: {
        contentSecurityPolicy: "default-src 'self'; script-src 'self' 'nonce-{NONCE}'; object-src 'none'",
        strictTransportSecurity: "max-age=31536000; includeSubDomains",
        permissionsPolicy: "camera=(), microphone=(), geolocation=()",
      },
    }),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
  ],
});
```

Without `{NONCE}`, the CSP is emitted verbatim and no nonce work is done.

### HTML Sanitization

The `{@html}` directive sanitizes output to prevent XSS:

- Removes dangerous elements (`<script>`, `<iframe>`, `<object>`, `<embed>`, `<style>`, `<template>`, …).
- Strips all `on*` event handlers.
- Neutralizes `javascript:` and `vbscript:` URLs.
- Removes `data:` URLs from `src` attributes.

For rich user-generated HTML, reach for DOMPurify on top of this.

### Query Override Protection

Query function calls via `x-koze-query-fn` headers are validated against a per-route allow-list — only functions registered for the current route can be invoked. Unknown names return `403`. Automatic, no configuration.

### Client Bridge Security

Client-side handler dispatch validates route and handler IDs against safe patterns, uses `hasOwnProperty` checks to block prototype-chain traversal, and rejects known pollution targets (`__proto__`, `constructor`, `prototype`). Automatic.

### Error Information Protection

In production, only developer-controlled `ActionError` / `PageError` messages are surfaced to the client. Generic `Error` details are hidden to prevent leaking implementation information. Dev mode shows the full message for debugging.

```ts
throw new ActionError('Invalid email format');          // shown to user
throw new Error('Database connection failed at line 42'); // replaced by "Internal Server Error" in prod
```

## Project layout

The framework is convention-driven. There is no project-level framework config file: request-time concerns (auth, ORM auto-migration, custom middleware) live in `src/middleware.ts`, and build-time concerns (security headers, route/server directory overrides) are passed to the Vite plugin.

```
src/
  routes/                     # auto-discovered route files (.koze)
  server/                     # singular convention files
    *.do.ts                   # → durable_objects.bindings + class re-export
    *.workflow.ts             # → workflows[]
    *.container.ts            # → containers[] + DO bindings + sqlite migrations
    *.queue.ts                # → queues.consumers[]
    *.agent.ts                # → class re-export; add Wrangler DO binding/migration
  middleware.ts               # auth, autoMigrate, custom steps
  app.css                     # global stylesheet (auto-discovered)
vite.config.ts                # plugin options: routesDir, serverDir, libDir, security
wrangler.jsonc                # bindings (auto-synced from server/ conventions)
```

### `src/middleware.ts`

```ts
import { defineMiddleware } from 'koze:middleware';
import { autoMigrate } from '@kuratchi/kunii';
import { kyzenAuthMiddleware } from '@kuratchi/kyzen/middleware';
import { adminSchema } from './server/schemas/admin';
import { authConfig } from './server/auth-config';

export default defineMiddleware({
  // Auto-migrate D1 on cold start (idempotent, runs once per isolate).
  migrate: autoMigrate({ DB: adminSchema }),

  // Auth — credentials, sessions, guards, OAuth, rate-limit, turnstile.
  auth: kyzenAuthMiddleware(authConfig),

  // Custom steps (logging, feature flags, custom routing) go here.
});
```

`autoMigrate` and `kyzenAuthMiddleware` are just middleware steps — there's no special framework slot for either. The same shape lets you compose any third-party auth / ORM / observability tool you want.

### `vite.config.ts`

```ts
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { koze } from '@kuratchi/koze/vite';

export default defineConfig({
  plugins: [
    koze({
      // Optional. All defaults are sensible.
      // routesDir: 'src/routes',
      // serverDir: 'src/server',
      // libDir: 'src/lib',
      // security: { contentSecurityPolicy: "...", strictTransportSecurity: "..." },
    }),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
  ],
});
```

### Tailwind / DaisyUI

The Vite path uses standard PostCSS. Drop a `postcss.config.js` and an `@import 'tailwindcss';` in `src/app.css`:

```css
/* src/app.css */
@import 'tailwindcss';
@plugin 'daisyui';
```

```js
// postcss.config.js
export default {
  plugins: { '@tailwindcss/postcss': {} },
};
```

Then use Tailwind classes in your templates as normal.

### `kuzan` theme

Apps that use `kuzan` import the theme stylesheet via `src/app.css`:

```css
@import '@kuratchi/kuzan/styles/theme.css';
```

…and add `<ThemeInit />` to the layout's `<head>` to prevent flash-of-wrong-theme on hydration.

## CLI

```bash
vite build   # one-shot build
vite dev     # dev server
```

## Vite plugin

The framework ships a Vite plugin that's the default build path going forward. Apps install Vite + the Cloudflare Vite plugin and add one line to their config:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { koze } from '@kuratchi/koze/vite';

export default defineConfig({
  plugins: [
    koze(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
  ],
});
```

That's it. The plugin discovers routes under `src/routes/**/*.koze`, generates a Workers-compatible worker entry, manages virtual modules (`$server/*`, `$lib/*`, `koze:request`, `koze:layout`, `koze:component`, `koze:manifest`, …), and keeps `wrangler.jsonc` in sync with Durable Object / Queue / Workflow / Container / Sandbox conventions discovered in `src/server/`.

The plugin imports cleanly into `vite.config.ts` only. The Vite plugin code never enters the worker bundle — it lives behind a separate package subpath (`koze/vite`) so importing from `@kuratchi/koze/runtime/*` in worker code stays cost-free.

**Components** are first-class. See the [Components](#components) section above for the resolution rules and `koze:component` API. The Vite plugin and the legacy CLI share the same compiler primitives, so component behavior is identical across both build paths.

**HMR**: editing a `.koze` route or component triggers a recompile of every consumer. Editing a `$lib/<name>.koze` component re-emits every route that imports it transitively.

**Required peer deps** (when using the Vite plugin):

```bash
npm install -D vite @cloudflare/vite-plugin wrangler
```

Both `vite` and `@cloudflare/vite-plugin` are declared as optional peer dependencies — they're only required if you actually use `koze/vite`. Apps that build through the legacy CLI don't need them.

## Testing Koze Apps

Generated Koze apps include Cloudflare's Vitest integration by default:

```bash
bun run test
```

The generated `vitest.config.ts` uses `@cloudflare/vitest-pool-workers`
with `wrangler.jsonc`, so tests run inside the Workers runtime through
Miniflare. Test files can import from `cloudflare:workers` to access the
Worker exports and real local bindings:

```ts
import { env, exports as worker } from 'cloudflare:workers';
import { expect, test } from 'vitest';

test('renders through workerd', async () => {
  const response = await worker.default.fetch('http://example.com/');
  expect(response.status).toBe(200);
});

test('uses D1 when configured', async () => {
  const row = await env.DB.prepare('SELECT 1 AS ok').first();
  expect(row).toEqual({ ok: 1 });
});
```

When the scaffold includes D1, it also emits a D1 integration test that
posts through a real route action and verifies the row in the D1 binding.
When it includes Durable Objects, it emits a Workers RPC test against the
generated DO binding. Additional Workers bindings such as Workflows,
Queues, KV, and R2 can be tested the same way after they are present in
`wrangler.jsonc`.

## Testing the Framework

Run framework tests from `packages/koze`:

```bash
bun run test
```

Watch mode:

```bash
bun run test:watch
```

## TypeScript & Worker types

```bash
npx wrangler types
```

Then include the generated types in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["./worker-configuration.d.ts"]
  }
}
```

## License and use

MIT licensed. You can use, copy, modify, merge, publish, distribute,
sublicense, and sell copies of this package for personal, internal, commercial,
or open source projects. Keep the copyright and license notice with substantial
copies of the software. This package is provided as-is, without warranty.
