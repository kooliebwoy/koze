import { describe, expect, test } from 'vitest';
import { newHttpBatchRpcSession } from 'capnweb';

import { createGeneratedWorker } from '../src/runtime/generated-worker.ts';
import { redirect } from '../src/runtime/context.ts';
import { locals } from '../src/runtime/request.ts';
import { schema } from '../src/runtime/schema.ts';

type ChannelResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

async function callRouteChannel<T = unknown>(
  worker: ReturnType<typeof createGeneratedWorker>,
  route: string,
  op: string,
  args: unknown[] = [],
  headers: HeadersInit = { 'sec-fetch-site': 'same-origin' },
): Promise<ChannelResult<T>> {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', {
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const nextHeaders = new Headers(request.headers);
      new Headers(headers).forEach((value, key) => nextHeaders.set(key, value));
      return worker.fetch(new Request(request, { headers: nextHeaders }), {}, {} as ExecutionContext);
    },
    configurable: true,
    writable: true,
  });

  try {
    const channel = newHttpBatchRpcSession<any>('https://example.com/__koze/channel') as any;
    return await channel.call({ target: 'route', route, op, args });
  } finally {
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    });
  }
}

describe('generated worker runtime', () => {
  test('renders custom 404 pages through the layout wrapper', async () => {
    const worker = createGeneratedWorker({
      routes: [],
      layout: (content) => `<html><body>${content}</body></html>`,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {
        404: () => '<section>Custom 404</section>',
      },
    });

    const response = await worker.fetch(
      new Request('https://example.com/missing'),
      {},
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Custom 404');
  });

  test('serves static assets with etag revalidation', async () => {
    const worker = createGeneratedWorker({
      routes: [],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {
        'app.js': {
          content: 'console.log("ok")',
          mime: 'application/javascript',
          etag: '"v1"',
        },
      },
      errorPages: {},
    });

    const first = await worker.fetch(
      new Request('https://example.com/assets/app.js'),
      {},
      {} as ExecutionContext,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get('etag')).toBe('"v1"');

    const second = await worker.fetch(
      new Request('https://example.com/assets/app.js', {
        headers: { 'if-none-match': '"v1"' },
      }),
      {},
      {} as ExecutionContext,
    );
    expect(second.status).toBe(304);
  });

  test('serves static assets only from the configured prefix', async () => {
    const worker = createGeneratedWorker({
      routes: [],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/base/assets/',
      assets: {
        'app.js': {
          content: 'console.log("base")',
          mime: 'application/javascript',
          etag: '"base-v1"',
        },
      },
      errorPages: {},
    });

    const prefixed = await worker.fetch(
      new Request('https://example.com/base/assets/app.js'),
      {},
      {} as ExecutionContext,
    );
    expect(prefixed.status).toBe(200);
    expect(await prefixed.text()).toBe('console.log("base")');

    const defaultPrefix = await worker.fetch(
      new Request('https://example.com/assets/app.js'),
      {},
      {} as ExecutionContext,
    );
    expect(defaultPrefix.status).toBe(404);
  });

  test('matches page routes regardless of trailing slash', async () => {
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/docs',
          load: () => ({ title: 'Docs' }),
          render: (data) => `<h1>${data.title}</h1>`,
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    const plain = await worker.fetch(
      new Request('https://example.com/docs'),
      {},
      {} as ExecutionContext,
    );
    expect(plain.status).toBe(200);
    expect(await plain.text()).toBe('<h1>Docs</h1>');

    const trailing = await worker.fetch(
      new Request('https://example.com/docs/'),
      {},
      {} as ExecutionContext,
    );
    expect(trailing.status).toBe(200);
    expect(await trailing.text()).toBe('<h1>Docs</h1>');
  });

  test('serves API HEAD requests through GET without a response body', async () => {
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/api/status',
          __api: true,
          GET: () => new Response('healthy', {
            headers: { 'x-api-status': 'ok' },
          }),
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    const head = await worker.fetch(
      new Request('https://example.com/api/status', { method: 'HEAD' }),
      {},
      {} as ExecutionContext,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get('x-api-status')).toBe('ok');
    expect(await head.text()).toBe('');

    const options = await worker.fetch(
      new Request('https://example.com/api/status', { method: 'OPTIONS' }),
      {},
      {} as ExecutionContext,
    );
    expect(options.status).toBe(204);
    expect(options.headers.get('allow')).toBe('GET, HEAD');
  });

  test('dispatches API GET, POST, PUT, PATCH, DELETE handlers with request context', async () => {
    const seen: Array<{ method: string; id: string; body: unknown; search: string }> = [];
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/api/items/:id',
          __api: true,
          GET: (ctx) => Response.json({
            method: ctx.request.method,
            id: ctx.params.id,
            search: ctx.url.searchParams.get('q'),
          }),
          POST: async (ctx) => {
            const body = await ctx.request.json();
            seen.push({ method: ctx.request.method, id: ctx.params.id, body, search: ctx.url.search });
            return Response.json({ created: true, id: ctx.params.id, body }, { status: 201 });
          },
          PUT: async (ctx) => {
            const body = await ctx.request.json();
            seen.push({ method: ctx.request.method, id: ctx.params.id, body, search: ctx.url.search });
            return Response.json({ replaced: true, id: ctx.params.id, body });
          },
          PATCH: async (ctx) => {
            const body = await ctx.request.json();
            seen.push({ method: ctx.request.method, id: ctx.params.id, body, search: ctx.url.search });
            return Response.json({ patched: true, id: ctx.params.id, body });
          },
          DELETE: (ctx) => {
            seen.push({ method: ctx.request.method, id: ctx.params.id, body: null, search: ctx.url.search });
            return new Response(null, { status: 204 });
          },
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    const get = await worker.fetch(
      new Request('https://example.com/api/items/42?q=lookup'),
      {},
      {} as ExecutionContext,
    );
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toEqual({ method: 'GET', id: '42', search: 'lookup' });

    const post = await worker.fetch(
      new Request('https://example.com/api/items/42?source=form', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'alpha' }),
      }),
      {},
      {} as ExecutionContext,
    );
    expect(post.status).toBe(201);
    await expect(post.json()).resolves.toEqual({ created: true, id: '42', body: { name: 'alpha' } });

    const put = await worker.fetch(
      new Request('https://example.com/api/items/42', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'beta' }),
      }),
      {},
      {} as ExecutionContext,
    );
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toEqual({ replaced: true, id: '42', body: { name: 'beta' } });

    const patch = await worker.fetch(
      new Request('https://example.com/api/items/42', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'gamma' }),
      }),
      {},
      {} as ExecutionContext,
    );
    expect(patch.status).toBe(200);
    await expect(patch.json()).resolves.toEqual({ patched: true, id: '42', body: { name: 'gamma' } });

    const del = await worker.fetch(
      new Request('https://example.com/api/items/42', { method: 'DELETE' }),
      {},
      {} as ExecutionContext,
    );
    expect(del.status).toBe(204);
    expect(await del.text()).toBe('');

    expect(seen).toEqual([
      { method: 'POST', id: '42', body: { name: 'alpha' }, search: '?source=form' },
      { method: 'PUT', id: '42', body: { name: 'beta' }, search: '' },
      { method: 'PATCH', id: '42', body: { name: 'gamma' }, search: '' },
      { method: 'DELETE', id: '42', body: null, search: '' },
    ]);
  });

  test('returns method-not-allowed for unimplemented API methods', async () => {
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/api/read-only',
          __api: true,
          GET: () => Response.json({ ok: true }),
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    const response = await worker.fetch(
      new Request('https://example.com/api/read-only', { method: 'POST' }),
      {},
      {} as ExecutionContext,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    await expect(response.json()).resolves.toEqual({ error: 'Method Not Allowed' });
  });

  test('runs middleware in order and lets error middleware handle failures', async () => {
    const calls: string[] = [];
    const middlewareDefinition = {
      trace: {
        request: async (_ctx: any, next: () => Promise<Response>) => {
          calls.push('request');
          return next();
        },
        route: async (_ctx: any, next: () => Promise<Response>) => {
          calls.push('route');
          return next();
        },
        response: async (_ctx: any, response: Response) => {
          calls.push('response');
          const out = new Response(response.body, response);
          out.headers.set('x-runtime', 'yes');
          return out;
        },
        error: async (_ctx: any, error: unknown) => {
          calls.push('error');
          return new Response(`handled:${(error as Error).message}`, { status: 418 });
        },
      },
    };

    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/ok',
          load: () => ({ message: 'ok' }),
          render: (data) => `<p>${data.message}</p>`,
        },
        {
          pattern: '/boom',
          load: () => {
            throw new Error('boom');
          },
          render: () => '<p>never</p>',
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
      middlewareDefinition,
    });

    const ok = await worker.fetch(
      new Request('https://example.com/ok'),
      {},
      {} as ExecutionContext,
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-runtime')).toBe('yes');
    expect(calls).toEqual(['request', 'route', 'response']);

    calls.length = 0;

    const boom = await worker.fetch(
      new Request('https://example.com/boom'),
      {},
      {} as ExecutionContext,
    );
    expect(boom.status).toBe(418);
    expect(await boom.text()).toBe('handled:boom');
    expect(calls).toEqual(['request', 'route', 'error', 'response']);
  });

  test('runs middleware consistently for page, api, rpc, and action routes', async () => {
    const calls: string[] = [];
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/page/:slug',
          load: (params) => {
            return {
              slug: params.slug,
              userId: (locals as any).userId,
              requestPath: (locals as any).requestPath,
              trace: Array.isArray((locals as any).trace) ? (locals as any).trace.join('>') : '',
            };
          },
          render: (data) => `<p>${data.userId}:${data.requestPath}:${data.slug}:${data.trace}</p>`,
        },
        {
          pattern: '/api',
          __api: true,
          GET: async (ctx: any) => new Response(JSON.stringify({
            userId: ctx.locals.userId,
            requestPath: ctx.locals.requestPath,
            trace: ctx.locals.trace,
          }), {
            headers: { 'content-type': 'application/json' },
          }),
        },
        {
          pattern: '/rpc',
          rpc: {
            whoami: async () => {
              return {
                userId: (locals as any).userId,
                requestPath: (locals as any).requestPath,
                trace: (locals as any).trace,
              };
            },
          },
          render: () => '<p>rpc</p>',
        },
        {
          pattern: '/action',
          actions: {
            save: async () => {
              (locals as any).__redirectTo = `/done/${(locals as any).userId}`;
            },
          },
          render: () => '<form method="POST"></form>',
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
      middlewareDefinition: {
        trace: {
          request: async (ctx: any, next: () => Promise<Response>) => {
            calls.push(`request:${ctx.url.pathname}`);
            ctx.locals.userId = 123;
            ctx.locals.requestPath = ctx.url.pathname;
            ctx.locals.trace = [`request:${ctx.url.pathname}`];
            return next();
          },
          route: async (ctx: any, next: () => Promise<Response>) => {
            calls.push(`route:${ctx.url.pathname}`);
            ctx.locals.trace.push(`route:${ctx.url.pathname}`);
            return next();
          },
          response: async (ctx: any, response: Response) => {
            calls.push(`response:${ctx.url.pathname}`);
            const out = new Response(response.body, response);
            out.headers.set('x-middleware-path', ctx.locals.requestPath);
            return out;
          },
        },
      },
    });

    const page = await worker.fetch(
      new Request('https://example.com/page/hello'),
      {},
      {} as ExecutionContext,
    );
    expect(page.status).toBe(200);
    expect(page.headers.get('x-middleware-path')).toBe('/page/hello');
    expect(await page.text()).toContain('123:/page/hello:hello:request:/page/hello>route:/page/hello');

    const api = await worker.fetch(
      new Request('https://example.com/api'),
      {},
      {} as ExecutionContext,
    );
    expect(api.status).toBe(200);
    expect(api.headers.get('x-middleware-path')).toBe('/api');
    expect(await api.json()).toEqual({
      userId: 123,
      requestPath: '/api',
      trace: ['request:/api', 'route:/api'],
    });

    const rpc = await callRouteChannel<{
      userId: number;
      requestPath: string;
      trace: string[];
    }>(worker, '/rpc', 'whoami');
    expect(rpc).toEqual({
      ok: true,
      value: {
        userId: 123,
        requestPath: '/__koze/channel',
        trace: ['request:/__koze/channel', 'route:/__koze/channel'],
      },
    });

    const actionBody = new FormData();
    actionBody.append('_action', 'save');
    const action = await worker.fetch(
      new Request('https://example.com/action', {
        method: 'POST',
        headers: { origin: 'https://example.com' },
        body: actionBody,
      }),
      {},
      {} as ExecutionContext,
    );
    expect(action.status).toBe(303);
    expect(action.headers.get('location')).toBe('/done/123');
    expect(action.headers.get('x-middleware-path')).toBe('/action');

    expect(calls).toEqual([
      'request:/page/hello',
      'route:/page/hello',
      'response:/page/hello',
      'request:/api',
      'route:/api',
      'response:/api',
      'request:/__koze/channel',
      'route:/__koze/channel',
      'response:/__koze/channel',
      'request:/action',
      'route:/action',
      'response:/action',
    ]);
  });

  test('returns success state with redirect metadata for augmented redirect actions', async () => {
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/action',
          actions: {
            save: async () => {
              redirect('/done/123');
            },
          },
          render: () => '<form method="POST"></form>',
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    const body = new FormData();
    body.append('_action', 'save');
    const response = await worker.fetch(
      new Request('https://example.com/action', {
        method: 'POST',
        headers: {
          origin: 'https://example.com',
          'x-koze-action': 'augment',
        },
        body,
      }),
      {},
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toEqual({
      ok: true,
      action: 'save',
      redirectTo: '/done/123',
      redirectStatus: 303,
      state: { error: undefined, pending: false, success: true },
    });
  });

  test('returns success state with redirect metadata when actions set locals redirect', async () => {
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/action',
          actions: {
            save: async () => {
              (locals as any).__redirectTo = '/auth/verify-email?email=ada%40example.com';
            },
          },
          render: () => '<form method="POST"></form>',
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    const body = new FormData();
    body.append('_action', 'save');
    const response = await worker.fetch(
      new Request('https://example.com/action', {
        method: 'POST',
        headers: {
          origin: 'https://example.com',
          'x-koze-action': 'augment',
        },
        body,
      }),
      {},
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      action: 'save',
      redirectTo: '/auth/verify-email?email=ada%40example.com',
      redirectStatus: 303,
      state: { error: undefined, pending: false, success: true },
    });
  });

  test('passes WebSocket upgrade responses through without response mutation', async () => {
    const upgradeResponse = new Response(null);
    Object.defineProperty(upgradeResponse, 'status', { value: 101 });
    const worker = createGeneratedWorker({
      routes: [],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
      middlewareDefinition: {
        websocket: {
          request: async () => upgradeResponse,
          response: async () => {
            throw new Error('response middleware must not run for WebSocket upgrades');
          },
        },
      },
    });

    const response = await worker.fetch(
      new Request('https://example.com/__koze/channel', {
        headers: {
          origin: 'https://example.com',
          upgrade: 'websocket',
        },
      }),
      {},
      {} as ExecutionContext,
    );

    expect(response.status).toBe(101);
    expect(response.headers.get('x-content-type-options')).toBeNull();
  });

  test('passes the documented context object to native form actions', async () => {
    let received: any;
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/items/:id',
          actions: {
            save: async (ctx: any) => {
              received = ctx;
            },
          },
          render: () => '<form method="POST"></form>',
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    const body = new FormData();
    body.append('_action', 'save');
    body.append('title', 'hello');
    const response = await worker.fetch(
      new Request('https://example.com/items/42', {
        method: 'POST',
        headers: { origin: 'https://example.com' },
        body,
      }),
      { DB: 'binding' },
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(303);
    expect(received.formData.get('title')).toBe('hello');
    expect(received.request).toBeInstanceOf(Request);
    expect(received.url).toBeInstanceOf(URL);
    expect(received.url.pathname).toBe('/items/42');
    expect(received.params).toEqual({ id: '42' });
    expect(received.env).toEqual({ DB: 'binding' });
    expect(received.ctx).toBeTruthy();
    expect(received.locals).toBeTruthy();
  });

  test('passes positional args before the context object for fetch-triggered actions', async () => {
    let received: unknown[] = [];
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/items',
          actions: {
            deleteItem: async (...args: unknown[]) => {
              received = args;
            },
          },
          render: () => '<p>items</p>',
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    const body = new FormData();
    body.append('_action', 'deleteItem');
    body.append('_args', JSON.stringify([123, 'archive']));
    const response = await worker.fetch(
      new Request('https://example.com/items', {
        method: 'POST',
        headers: { origin: 'https://example.com' },
        body,
      }),
      {},
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(received).toHaveLength(3);
    expect(received[0]).toBe(123);
    expect(received[1]).toBe('archive');
    expect((received[2] as { formData: FormData }).formData).toBeInstanceOf(FormData);
  });

  test('describes page and api routes with agent-friendly metadata', () => {
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/dashboard',
          load: () => ({ ok: true }),
          actions: {
            save: async () => 'saved',
          },
          rpc: {
            refresh: async () => ({ ok: true }),
          },
          allowedQueries: ['stats'],
          render: () => '<p>dashboard</p>',
        },
        {
          pattern: '/api/reports',
          __api: true,
          manifest: {
            summary: 'List reports',
            auth: 'required',
            tags: ['reports'],
          },
          GET: async () => new Response('ok'),
          POST: async () => new Response('created', { status: 201 }),
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    expect(worker.describeRoutes()).toEqual([
      {
        pattern: '/dashboard',
        type: 'page',
        hasLoad: true,
        actions: ['save'],
        rpc: ['refresh'],
        queries: ['stats'],
      },
      {
        pattern: '/api/reports',
        type: 'api',
        methods: ['GET', 'HEAD', 'POST'],
        manifest: {
          summary: 'List reports',
          auth: 'required',
          tags: ['reports'],
        },
      },
    ]);
  });

  test('resets middleware locals between requests so state does not leak', async () => {
    let requestId = 0;
    const leakedAtRequestStart: boolean[] = [];
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/state',
          load: () => {
            const leakedValue = (locals as any).routeMutation ?? 'none';
            (locals as any).routeMutation = `set-${(locals as any).requestId}`;
            return { requestId: (locals as any).requestId, leakedValue };
          },
          render: (data) => `<p>${data.requestId}:${data.leakedValue}</p>`,
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
      middlewareDefinition: {
        isolate: {
          request: async (ctx: any, next: () => Promise<Response>) => {
            leakedAtRequestStart.push('routeMutation' in ctx.locals);
            ctx.locals.requestId = ++requestId;
            return next();
          },
        },
      },
    });

    const first = await worker.fetch(
      new Request('https://example.com/state'),
      {},
      {} as ExecutionContext,
    );
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('1:none');

    const second = await worker.fetch(
      new Request('https://example.com/state'),
      {},
      {} as ExecutionContext,
    );
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('2:none');
    expect(leakedAtRequestStart).toEqual([false, false]);
  });

  test('passes structured head content into the layout', async () => {
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/head',
          load: () => ({ title: 'Structured Head' }),
          render: (data) => ({
            html: `<main>${data.title}</main>`,
            head: `<title>${data.title}</title>`,
          }),
        },
      ],
      layout: (content, head = '') => `<html><head>${head}</head><body>${content}</body></html>`,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    const response = await worker.fetch(
      new Request('https://example.com/head'),
      {},
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<head><title>Structured Head</title></head>');
  });

  test('does not emit a framework-owned CSRF cookie on any response', async () => {
    // Kuratchi no longer mints its own CSRF cookie — origin integrity is provided
    // by the strict same-origin gate, and session cookies (if any) are set by the
    // user's auth library, not the framework.
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/',
          render: () => '<form method="POST"></form>',
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    for (const url of ['http://127.0.0.1:8787/', 'https://example.com/']) {
      const response = await worker.fetch(new Request(url), {}, {} as ExecutionContext);
      expect(response.status).toBe(200);
      const setCookie = response.headers.get('set-cookie') || '';
      expect(setCookie).not.toMatch(/__koze_csrf/);
    }
  });

  test('validates route RPC arguments with companion schemas', async () => {
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/rpc',
          rpc: {
            saveDraft: async ({ title, content }) => `${title}:${content}`,
          },
          rpcSchemas: {
            saveDraft: schema({
              title: schema.string().min(1),
              content: schema.string().min(1),
            }),
          },
          render: () => '<p>rpc</p>',
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    await expect(callRouteChannel(worker, '/rpc', 'saveDraft', [
      { title: 'hello', content: 'world' },
    ])).resolves.toEqual({ ok: true, value: 'hello:world' });

    await expect(callRouteChannel(worker, '/rpc', 'saveDraft', [
      { title: '', content: 'world' },
    ])).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'data.title must be at least 1 character(s)',
    });
  });

  test('serves route RPC through the Capn Web channel endpoint', async () => {
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/rpc',
          rpc: {
            ping: async (name: string) => `pong:${name}`,
          },
          render: () => '<p>rpc</p>',
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });
    await expect(callRouteChannel(worker, '/rpc', 'ping', ['Ada'])).resolves.toEqual({
      ok: true,
      value: 'pong:Ada',
    });
  });

  test('matches channel route RPC calls regardless of trailing slash', async () => {
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/rpc/:slug',
          rpc: {
            ping: async () => `pong:${(locals as any).params.slug}`,
          },
          render: () => '<p>rpc</p>',
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    await expect(callRouteChannel(worker, '/rpc/hello', 'ping')).resolves.toEqual({
      ok: true,
      value: 'pong:hello',
    });
    await expect(callRouteChannel(worker, '/rpc/hello/', 'ping')).resolves.toEqual({
      ok: true,
      value: 'pong:hello',
    });
  });

  test('rejects multi-argument payloads for schema-backed RPCs', async () => {
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/rpc',
          rpc: {
            saveDraft: async ({ title }) => title,
          },
          rpcSchemas: {
            saveDraft: schema({
              title: schema.string(),
            }),
          },
          render: () => '<p>rpc</p>',
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    await expect(callRouteChannel(worker, '/rpc', 'saveDraft', ['hello', 'world'])).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'validated RPCs must receive exactly one argument object, got 2',
    });
  });

  test('ignores retired query-string RPC payloads during normal page GETs', async () => {
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/rpc',
          rpc: {
            ping: async () => 'pong',
          },
          render: () => '<p>rpc</p>',
        },
      ],
      layout: (content) => content,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    const response = await worker.fetch(
      new Request('https://example.com/rpc?_rpc=ping&_args=%7B%22not%22%3A%22an-array%22%7D', {
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
      {},
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<p>rpc</p>');
  });
});
