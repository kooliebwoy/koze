/**
 * Core application — the Worker fetch() handler.
 *
 * Takes an AppConfig, returns a standard Cloudflare Worker fetch handler.
 */

import { Router } from './router.js';
import {
  createKuratchiCapnWebHttpResponse,
  createKuratchiCapnWebWebSocketResponse,
  isKuratchiCapnWebWebSocketRequest,
} from './channel-capnweb-host.js';
import { invokeKuratchiChannelHost } from './channel-host.js';
import { KURATCHI_CHANNEL_ENDPOINT } from './channel-protocol.js';
import { validateRpcRequest } from './security.js';
import type { KuratchiChannelCallFrame } from './channel-protocol.js';
import type { AppConfig, Env, RouteContext, RouteModule, ApiRouteModule, LayoutModule, PageRenderOutput, PageRenderResult } from './types.js';

/**
 * Create a Cloudflare Worker fetch handler from an AppConfig.
 */
export function createApp<E = Env>(config: AppConfig<E>) {
  const router = new Router();
  const routes: (RouteModule<E> | ApiRouteModule<E>)[] = config.routes ?? [];
  const layouts: Record<string, LayoutModule> = config.layouts ?? {};
  // Register routes
  for (let i = 0; i < routes.length; i++) {
    router.add(routes[i].pattern, i);
  }

  // The Worker fetch handler
  return {
    async fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);

      // Build base context (params filled in after routing)
      const context: RouteContext<E> = {
        request,
        env,
        ctx,
        params: {},
        locals: {},
        url,
      };

      // --- Static files from public/ ---
      // Handled by wrangler's [site] config, not here.

      if (url.pathname === KURATCHI_CHANNEL_ENDPOINT) {
        const isWebSocket = isKuratchiCapnWebWebSocketRequest(request);
        const validation = validateRpcRequest(request, url, {
          allowedMethods: [isWebSocket ? 'GET' : 'POST'],
          requireSameOrigin: true,
        });
        if (!validation.valid) {
          return new Response(JSON.stringify({ ok: false, error: validation.reason || 'Forbidden' }), {
            status: validation.status,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          });
        }
        const dispatch = (input: KuratchiChannelCallFrame) => {
          return dispatchAppRouteChannelCall(input, routes, router, context);
        };
        if (isWebSocket) return createKuratchiCapnWebWebSocketResponse(request, dispatch);
        return createKuratchiCapnWebHttpResponse(request, dispatch);
      }

      // --- Route matching ---
      const match = router.match(url.pathname);

      // Build the final handler (route dispatch)
      const routeHandler = async (): Promise<Response> => {
        if (!match) {
          return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/html' } });
        }

        const route = routes[match.index];
        context.params = match.params;

        // --- API routes: dispatch to method handler ---
        if ('__api' in route && route.__api) {
          const method = request.method;
          if (method === 'OPTIONS') {
            const handler = (route as any)['OPTIONS'];
            if (typeof handler === 'function') return handler(context);
            const allowed = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']
              .filter(m => typeof (route as any)[m] === 'function' || (m === 'HEAD' && typeof (route as any).GET === 'function'))
              .join(', ');
            return new Response(null, {
              status: 204,
              headers: { 'Allow': allowed, 'Access-Control-Allow-Methods': allowed },
            });
          }
          const handler = (route as any)[method] ?? (method === 'HEAD' ? (route as any).GET : undefined);
          if (typeof handler !== 'function') {
            const allowed = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']
              .filter(m => typeof (route as any)[m] === 'function' || (m === 'HEAD' && typeof (route as any).GET === 'function'))
              .join(', ');
            return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
              status: 405,
              headers: { 'content-type': 'application/json', 'Allow': allowed },
            });
          }
          const response = await handler(context);
          if (method !== 'HEAD') return response;
          return new Response(null, response);
        }

        // From here, route is a page route (RouteModule)
        const pageRoute = route as RouteModule<E>;

        // --- Form actions: POST ?/actionName ---
        if (request.method === 'POST') {
          const actionParam = [...url.searchParams.keys()].find(k => k.startsWith('/'));
          if (actionParam) {
            const actionName = actionParam.slice(1); // remove leading /
            const actionFn = pageRoute.actions?.[actionName];
            if (!actionFn) {
              return new Response(`Action '${actionName}' not found`, { status: 404 });
            }
            try {
              const formData = await request.formData();
              const actionResult = await actionFn({ ...context, formData });

              // After action, re-run load and re-render with action result
              const loadData = pageRoute.load ? await pageRoute.load(context) : {};
              const data = { ...loadData, actionResult, actionName };
              return renderPage(pageRoute, data, layouts);
            } catch (err: any) {
              // Re-render with error
              const loadData = pageRoute.load ? await pageRoute.load(context) : {};
              const data = { ...loadData, actionError: err.message, actionName };
              return renderPage(pageRoute, data, layouts);
            }
          }
        }

        // --- GET: load + render ---
        try {
          const data = pageRoute.load ? await pageRoute.load(context) : {};
          return renderPage(pageRoute, data, layouts);
        } catch (err: any) {
          return new Response(`Server Error: ${err.message}`, {
            status: 500,
            headers: { 'content-type': 'text/html' },
          });
        }
      };

      return routeHandler();
    },
  };
}

async function dispatchAppRouteChannelCall<E>(
  input: KuratchiChannelCallFrame,
  routes: (RouteModule<E> | ApiRouteModule<E>)[],
  router: Router,
  context: RouteContext<E>,
) {
  if (input.target === 'server') {
    return {
      ok: false as const,
      status: 404,
      error: `Unknown channel operation: ${input.op || '(missing)'}`,
    };
  }

  const routePath = typeof input.route === 'string' && input.route ? input.route : context.url.pathname;
  const routeUrl = new URL(routePath, context.url.origin);
  const match = router.match(routeUrl.pathname);
  if (!match) {
    return {
      ok: false as const,
      status: 404,
      error: `Unknown channel route: ${routeUrl.pathname}`,
    };
  }

  const route = routes[match.index];
  if ('__api' in route && route.__api) {
    return {
      ok: false as const,
      status: 404,
      error: `Unknown channel operation: ${input.op || '(missing)'}`,
    };
  }
  const pageRoute = route as RouteModule<E>;
  if (!input.op || !pageRoute.rpc || !Object.hasOwn(pageRoute.rpc, input.op)) {
    return {
      ok: false as const,
      status: 404,
      error: `Unknown channel operation: ${input.op || '(missing)'}`,
    };
  }

  const previousUrl = context.url;
  const previousParams = context.params;
  context.url = routeUrl;
  context.params = match.params;

  const operations = Object.fromEntries(
    Object.entries(pageRoute.rpc).map(([name, fn]) => [
      name,
      (...args: unknown[]) => fn(args, context.env, context),
    ]),
  );

  try {
    return await invokeKuratchiChannelHost(
      { operations, schemas: pageRoute.rpcSchemas },
      { op: input.op, args: input.args, kind: input.kind || 'query' },
    );
  } catch (err) {
    return {
      ok: false as const,
      status: 500,
      error: err instanceof Error && err.message ? err.message : 'RPC call failed',
    };
  } finally {
    context.url = previousUrl;
    context.params = previousParams;
  }
}

/** Render a page through its layout */
function renderPage<E>(
  route: RouteModule<E>,
  data: Record<string, any>,
  layouts: Record<string, LayoutModule>
): Response {
  const rendered = normalizeRenderOutput(route.render(data));
  const layoutName = route.layout ?? 'default';
  const layout = layouts[layoutName];

  const html = layout
    ? layout.render({ content: rendered.html, data, head: rendered.head })
    : rendered.html;

  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function normalizeRenderOutput(output: PageRenderOutput): PageRenderResult {
  if (typeof output === 'string') {
    return { html: output, head: '' };
  }
  return {
    html: typeof output?.html === 'string' ? output.html : '',
    head: typeof output?.head === 'string' ? output.head : '',
  };
}
