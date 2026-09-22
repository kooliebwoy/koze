# Koze

> Koze is the HTML-first full-stack framework where the application is a native Cloudflare Worker from the first dev request to production.

Koze owns the application language and HTTP experience: `.koze` pages and components, routing, SSR, forms, progressive enhancement, hydration, streaming, middleware, and browser-to-Worker RPC. Cloudflare owns the Worker runtime, bindings, product configuration, local simulation, and deployment.

That boundary is visible in every project:

```ts
// vite.config.ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { koze } from '@kuratchi/koze/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    koze(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
  ],
});
```

```ts
// src/worker.ts
import { handleRequest } from 'koze:worker';

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
```

`koze()` and `cloudflare()` are peer plugins. Koze does not call or wrap the Cloudflare plugin, parse or write Wrangler configuration, provision resources, or synthesize Worker exports.

## Create an application

```bash
npm create kuratchi@latest my-app
cd my-app
npm run dev
```

The generated application includes:

```text
src/
  app.koze            optional document shell
  routes/
    layout.koze       optional shared layout
    index.koze        /
  server/             ordinary server-only TypeScript modules
  lib/                shared and browser helpers
  middleware.ts       request lifecycle middleware
  worker.ts           application-owned native Worker entrypoint
vite.config.ts
wrangler.jsonc        application-owned Cloudflare configuration
```

Useful commands:

```bash
npm run dev
npm run build
npm run preview
npm run test
npm run types
npm run deploy
```

Development and preview run through Cloudflare's official Vite integration in `workerd`, not a Koze emulator.

## Pages

Files below `src/routes/` use the `.koze` extension. The file path determines the URL:

```text
src/routes/index.koze          /
src/routes/about.koze          /about
src/routes/blog/[slug].koze    /blog/:slug
src/routes/docs/[...path].koze /docs/*
```

A route contains one optional top-level `<script>` followed by HTML-first template content:

```html
<script>
  import { params } from 'koze:request';
  import { getArticle } from '$server/articles';

  const article = await getArticle(params.slug);
</script>

if (!article) {
  <h1>Not found</h1>
} else {
  <article>
    <h1>{article.title}</h1>
    <p>{article.summary}</p>
  </article>
}
```

Koze supports native JavaScript-shaped `if`, `else`, and `for` control flow, `{expression}` interpolation, components, event handlers, reactive assignments, async rendering boundaries, and scoped component styles.

A second route script or a document shell inside `layout.koze` is a compiler error. Put the document frame in `src/app.koze`, shared page structure in `layout.koze`, and longer browser helpers in `src/lib/`.

## API routes

API routes follow one fixed convention: TypeScript or JavaScript files below `src/routes/api/` are mounted below `/api`. There is no Vite option for changing the source root or URL prefix.

```text
src/routes/api/index.ts          /api
src/routes/api/health.ts         /api/health
src/routes/api/users/[id].ts     /api/users/:id
src/routes/api/files/[...path].ts /api/files/*
```

An API route is an ordinary module that exports HTTP method handlers:

```ts
export function GET() {
  return Response.json({ ok: true });
}
```

Files outside `src/routes/api/` are not auto-exposed as API routes. Authentication and authorization remain application concerns inside the handler or middleware. Applications that need another source tree or URL prefix should route it explicitly from `src/worker.ts`.

## Components

Components also use `.koze` and may live anywhere outside `src/routes/`:

```html
<!-- src/lib/card.koze -->
<script>
  import { props } from 'koze:component';
  const { title, tone = 'normal' } = props<{
    title: string;
    tone?: 'normal' | 'success';
  }>();
</script>

<section class="card {tone}">
  <h2>{title}</h2>
  <slot></slot>
</section>

<style>
  .card { padding: 1rem; }
  .success { border-color: green; }
</style>
```

```html
<script>
  import Card from '$lib/card.koze';
</script>

<Card title="Saved" tone="success">Your changes are live.</Card>
```

Components under `src/routes/` are rejected because route ownership would be ambiguous.

## Server modules and browser RPC

Every TypeScript or JavaScript file in `src/server/` is an ordinary server module. Koze assigns no Cloudflare meaning to its filename.

```ts
// src/server/todos.ts
export async function listTodos() {
  return [{ id: '1', title: 'Ship it' }];
}

export async function renameTodo(id: string, title: string) {
  // authorize and write
  return { id, title };
}

function internalHelper() {
  // not exported, therefore not callable through $server
}
```

Routes import the same module through `$server/*`:

```html
<script>
  import { listTodos, renameTodo } from '$server/todos';

  const todos = await listTodos();
</script>
```

In SSR, Koze calls the server module directly. In the browser, the import becomes a typed Cap'n Web RPC client returning a thenable `AsyncValue` with `.pending`, `.success`, and `.error` state.

Only exported values are reachable. Authorization still belongs inside the server function. Koze enforces same-origin RPC and action requests, but same-origin is not authentication.

Former names such as `thing.do.ts`, `job.workflow.ts`, or `events.pipeline.ts` have no special behavior. Rename them for clarity or leave them as ordinary module names; Koze will not inspect them or create infrastructure from them.

## Forms and actions

Forms use native HTML and work without client JavaScript:

```ts
// src/server/account.ts
export async function updateProfile({ formData }: { formData: FormData }) {
  const displayName = String(formData.get('displayName') ?? '').trim();
  if (!displayName) throw new Error('Display name is required');
  await saveProfile(displayName);
}
```

```html
<script>
  import { updateProfile } from '$server/account';
</script>

<form action={updateProfile} method="POST">
  <label>
    Display name
    <input name="displayName" required />
  </label>
  <button type="submit">Save</button>
</form>
```

The server calling convention is `fn(...args, ctx)`. Native forms pass only the context object; button-triggered actions pass their explicit arguments before it. The context includes `formData`, `request`, `url`, `params`, `env`, `ctx`, and `locals`.

Successful native actions follow POST-Redirect-GET. Enhanced actions use the same server function and preserve the native fallback.

## Middleware

Request-time composition lives in `src/middleware.ts`:

```ts
import { defineMiddleware } from '@kuratchi/koze';

export default defineMiddleware({
  session: {
    async request(ctx, next) {
      ctx.locals.user = await loadUser(ctx.request);
      return next();
    },
  },
});
```

Middleware may participate in request, route, response, and error phases. Auth, database migration, and application-specific integrations compose here through their owning packages. Koze core does not contain a Cloudflare Access product wrapper.

Response security headers may be configured on the Koze plugin because they apply to Koze-generated HTTP responses:

```ts
koze({
  security: {
    contentSecurityPolicy: "default-src 'self'; script-src 'self' 'nonce-{NONCE}'",
    strictTransportSecurity: 'max-age=63072000; includeSubDomains',
    permissionsPolicy: 'camera=(), microphone=()',
  },
})
```

## Native Cloudflare primitives

Use Cloudflare primitives directly. Export their classes or handlers from `src/worker.ts`, bind them in `wrangler.jsonc` or the official plugin's programmatic configuration, and use Wrangler-generated types.

### Durable Objects

```ts
// src/server/counter-object.ts
import { DurableObject } from 'cloudflare:workers';

export class CounterObject extends DurableObject<Env> {
  increment(): number {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value INTEGER NOT NULL)
    `);
    this.ctx.storage.sql.exec(`
      INSERT INTO state (key, value) VALUES ('counter', 1)
      ON CONFLICT(key) DO UPDATE SET value = value + 1
    `);
    return this.ctx.storage.sql.exec<{ value: number }>(
      "SELECT value FROM state WHERE key = 'counter'"
    ).one().value;
  }

  #internalHelper() {
    // JavaScript private methods are not exposed over RPC.
  }
}
```

```ts
// src/worker.ts
import { handleRequest } from 'koze:worker';
export { CounterObject } from './server/counter-object';

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
```

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "main": "src/worker.ts",
  "durable_objects": {
    "bindings": [
      { "name": "COUNTER", "class_name": "CounterObject" }
    ]
  },
  "exports": {
    "CounterObject": {
      "type": "durable-object",
      "storage": "sqlite"
    }
  }
}
```

Call the binding inside an explicit server boundary:

```ts
// src/server/counter.ts
import { env } from 'cloudflare:workers';

export async function incrementCounter(accountId: string) {
  await requireAccountAccess(accountId);
  return env.COUNTER.getByName(accountId).increment();
}
```

Koze does not choose the object identity, create a proxy class, infer RPC privacy, or manage the class lifecycle. TypeScript `private` is erased at runtime; use JavaScript `#private` for methods that must not be callable over native RPC.

### Other handlers

The same Worker can expose any native handler without framework support:

```ts
export default {
  fetch: handleRequest,

  async queue(batch, env, ctx) {
    await consumeMessages(batch, env, ctx);
  },

  scheduled(controller, env, ctx) {
    ctx.waitUntil(runSchedule(controller, env));
  },
} satisfies ExportedHandler<Env>;
```

Workflows, Queues, Pipelines, Containers, Sandbox, Agents, Email, Tail Workers, static assets, and API Shield follow their native Cloudflare documentation. Adding or upgrading one does not require a Koze release.

## Virtual modules

Koze exposes only framework-language and HTTP application modules:

| Module | Purpose |
|---|---|
| `koze:worker` | Named `handleRequest` export for the application Worker |
| `koze:request` | Request URL, parameters, headers, method, and locals |
| `koze:navigation` | Redirect and browser navigation helpers |
| `koze:cookies` | Request-scoped cookie store |
| `koze:middleware` | Middleware definition helper |
| `koze:component` | Typed component props |
| `koze:content` | Typed Markdown content collections |
| `koze:environment` | Compile-time development flag |

There are no `koze:workflow`, `koze:pipeline`, `koze:access`, or `koze:assets` product wrappers.

## Static assets

Configure assets explicitly through Cloudflare. The scaffold uses:

```jsonc
{
  "assets": {
    "directory": "src/assets"
  }
}
```

Use normal public URLs in markup or call the native asset binding when an application needs Worker-side access. Koze does not assume an `ASSETS` binding or modify this block.

## Migration from product conventions

| Previous Koze behavior | Native replacement |
|---|---|
| `.do.ts` discovery and generated facade | Ordinary DO class, explicit Worker export, binding, and `exports` declaration |
| Direct `$server/*.do` import | Ordinary `$server` function that selects identity and authorizes before calling the DO |
| `.workflow.ts` registry | Native Workflow class export and binding |
| `.queue.ts` dispatch switch | Application-owned `queue()` handler |
| `.pipeline.ts` registry/artifacts | Native Pipeline binding and intentional IaC or Wrangler commands |
| `.container.ts` / `.sandbox.ts` discovery | Native class/export/configuration owned by the application |
| `.agent.ts` re-export | Explicit Agent class export |
| Wrangler auto-sync | Application-owned Wrangler or official programmatic configuration |
| API Shield generation | Application-owned OpenAPI and security provisioning |

This is intentionally a breaking boundary. There is no hidden compatibility mode because retaining one would preserve a second Worker construction path.

Run the read-only migration audit in an existing application:

```bash
npx koze audit-native-worker .
```

Add `--json` for machine-readable findings. The audit reports former convention files, direct `.do` browser imports, removed wrapper APIs, synthetic Worker re-exports, and generated `_cloudflare/` artifacts. It never rewrites infrastructure or guesses identity, authorization, retry, or lifecycle decisions.

## Packages

```ts
import { koze } from '@kuratchi/koze/vite';
import { createKozeCompiler } from '@kuratchi/koze/compiler';
```

The compiler API is deterministic and project-local. It parses and transforms Koze source, reports diagnostics and dependencies, and generates framework types. It has no `cloudflare` capability group and performs no infrastructure writes.

## Verification

Framework changes run:

```bash
bun run build
bun run check
bun run test
```

The suite includes Node-based compiler/runtime tests and a Cloudflare Vitest integration project that executes the application-owned Worker, Koze SSR, native Durable Object RPC, and a non-fetch handler inside `workerd`.

## License

MIT
