import { __esc, __getLocals, __setLocal, __setRequestContext } from './context.js';
import { createPreparedRouter, matchPreparedRouter, type PreparedRouter } from './router.js';
import {
  initCspNonce,
  validateRpcRequest,
  validateActionRequest,
  validateQueryOverride,
  parseQueryArgs,
  type ActionSecurityConfig,
} from './security.js';
import {
  createKuratchiCapnWebHttpResponse,
  createKuratchiCapnWebWebSocketResponse,
  isKuratchiCapnWebWebSocketRequest,
} from './channel-capnweb-host.js';
import { invokeKuratchiChannelHost } from './channel-host.js';
import { KURATCHI_CHANNEL_ENDPOINT } from './channel-protocol.js';
import type { KuratchiChannelCallFrame } from './channel-protocol.js';
import type { MiddlewareContext, MiddlewareDefinition, PageRenderOutput, PageRenderResult, RuntimeDefinition } from './types.js';

export interface GeneratedAssetEntry {
  content: string;
  mime: string;
  etag: string;
}

export interface GeneratedApiRoute {
  pattern: string;
  __api: true;
  manifest?: Record<string, unknown>;
  [method: string]: unknown;
}

export interface GeneratedPageRoute {
  pattern: string;
  load?: (params: Record<string, string>) => Promise<unknown> | unknown;
  actions?: Record<string, (...args: any[]) => Promise<unknown> | unknown>;
  rpc?: Record<string, (...args: any[]) => Promise<unknown> | unknown>;
  rpcSchemas?: Record<string, any>;
  /** Allowed query function names for this route (for query override validation) */
  allowedQueries?: string[];
  render: (data: Record<string, any>) => PageRenderOutput;
}

export interface GeneratedRouteDescription {
  pattern: string;
  type: 'page' | 'api';
  methods?: string[];
  manifest?: Record<string, unknown>;
  hasLoad?: boolean;
  actions?: string[];
  rpc?: string[];
  queries?: string[];
}

export interface SecurityOptions {
  /**
   * Content Security Policy directive string.
   * Use the literal placeholder `{NONCE}` to opt into per-request nonces on the
   * framework's injected inline scripts, e.g. `script-src 'self' 'nonce-{NONCE}'`.
   */
  contentSecurityPolicy?: string | null;
  /** Strict-Transport-Security header value */
  strictTransportSecurity?: string | null;
  /** Permissions-Policy header value */
  permissionsPolicy?: string | null;
}

export interface GeneratedWorkerOptions {
  routes: Array<GeneratedPageRoute | GeneratedApiRoute>;
  preparedRouter?: PreparedRouter;
  layout: (content: string, head?: string) => Promise<string> | string;
  layoutActions: Record<string, (...args: any[]) => Promise<unknown> | unknown>;
  assetsPrefix: string;
  assets: Record<string, GeneratedAssetEntry>;
  rpcModules?: Record<string, Record<string, any>>;
  errorPages: Record<number, (detail?: string) => string>;
  middlewareDefinition?: MiddlewareDefinition;
  /** @deprecated Use middlewareDefinition */
  runtimeDefinition?: RuntimeDefinition;
  initializeRequest?: (ctx: MiddlewareContext) => Promise<void> | void;
  preRouteChecks?: (ctx: MiddlewareContext) => Promise<Response | null | undefined> | Response | null | undefined;
  /** Security configuration */
  security?: SecurityOptions;
}

type MiddlewareEntry = [string, NonNullable<MiddlewareDefinition[string]>];
const API_METHOD_NAMES = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
type ApiMethodName = typeof API_METHOD_NAMES[number];

interface PreparedApiRouteDispatch {
  handlers: Partial<Record<ApiMethodName, (ctx: MiddlewareContext) => Promise<Response> | Response>>;
  allowHeader: string;
}

export function createGeneratedWorker(opts: GeneratedWorkerOptions) {
  const middlewareEntries = __getMiddlewareEntries(opts.middlewareDefinition ?? opts.runtimeDefinition);
  const routeDescriptions = opts.routes.map((route) => __describeRoute(route));
  const preparedRouter = opts.preparedRouter ?? createPreparedRouter(opts.routes.map((route) => route.pattern));
  const apiDispatch = opts.routes.map((route) => __prepareApiRouteDispatch(route));

  // Security configuration with defaults
  const securityConfig: RuntimeSecurityConfig = {
    contentSecurityPolicy: opts.security?.contentSecurityPolicy ?? null,
    strictTransportSecurity: opts.security?.strictTransportSecurity ?? null,
    permissionsPolicy: opts.security?.permissionsPolicy ?? null,
  };
  const cspUsesNonce = !!(securityConfig.contentSecurityPolicy && securityConfig.contentSecurityPolicy.includes('{NONCE}'));

  // Initialize configurable security headers
  __initSecurityHeaders(securityConfig);

  return {
    describeRoutes(): GeneratedRouteDescription[] {
      return routeDescriptions;
    },
    async fetch(request: Request, env: Record<string, any>, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      if (middlewareEntries.length === 0 && !opts.initializeRequest && !opts.preRouteChecks && !cspUsesNonce) {
        const earlyAsset = __tryHandleAssetRequest(opts, request, url);
        if (earlyAsset) return __secHeaders(earlyAsset);
      }

      __setRequestContext(ctx, request, env);

      const middlewareCtx: MiddlewareContext = {
        request,
        env,
        ctx,
        url,
        params: {},
        locals: __getLocals(),
      };

      // Generate a per-request CSP nonce only when the policy opts in via {NONCE}.
      // Otherwise skip; most apps don't configure a CSP and we avoid the work.
      if (cspUsesNonce) {
        initCspNonce();
      }

      if (opts.initializeRequest) {
        await opts.initializeRequest(middlewareCtx);
      }

      const coreFetch = async (): Promise<Response> => {
        const { url } = middlewareCtx;

        const preRoute = opts.preRouteChecks ? await opts.preRouteChecks(middlewareCtx) : null;
        if (preRoute instanceof Response) {
          return __secHeaders(preRoute);
        }

        if (url.pathname.startsWith(opts.assetsPrefix)) {
          const name = url.pathname.slice(opts.assetsPrefix.length);
          const asset = opts.assets[name];
          if (asset) {
            if (request.headers.get('if-none-match') === asset.etag) {
              return new Response(null, { status: 304 });
            }
            return new Response(asset.content, {
              headers: {
                'content-type': asset.mime,
                'cache-control': 'public, max-age=31536000, immutable',
                'etag': asset.etag,
              },
            });
          }
          return __secHeaders(new Response('Not Found', { status: 404 }));
        }

        if (url.pathname === KURATCHI_CHANNEL_ENDPOINT) {
          const isWebSocket = isKuratchiCapnWebWebSocketRequest(request);
          const channelValidation = validateRpcRequest(request, url, {
            allowedMethods: [isWebSocket ? 'GET' : 'POST'],
            requireSameOrigin: true,
          });
          if (!channelValidation.valid) {
            return __secHeaders(new Response(JSON.stringify({ ok: false, error: channelValidation.reason || 'Forbidden' }), {
              status: channelValidation.status,
              headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
            }));
          }
          if (isWebSocket) {
            return createKuratchiCapnWebWebSocketResponse(request, (input) => {
              return __dispatchChannelCall(input, opts, middlewareCtx, preparedRouter);
            });
          }
          return __secHeaders(await createKuratchiCapnWebHttpResponse(request, (input) => {
            return __dispatchChannelCall(input, opts, middlewareCtx, preparedRouter);
          }));
        }

        // Serve client module assets at /__koze/ path
        if (url.pathname.startsWith('/__koze/')) {
          const name = url.pathname.slice(1); // Remove leading slash, keep __koze/
          const asset = opts.assets[name];
          if (asset) {
            if (request.headers.get('if-none-match') === asset.etag) {
              return new Response(null, { status: 304 });
            }
            return new Response(asset.content, {
              headers: {
                'content-type': asset.mime,
                'cache-control': 'public, max-age=31536000, immutable',
                'etag': asset.etag,
              },
            });
          }
        }

        const match = matchPreparedRouter(preparedRouter, url.pathname);
        if (!match) {
          return __secHeaders(new Response(await opts.layout(__renderError(opts.errorPages, 404)), {
            status: 404,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }));
        }

        middlewareCtx.params = match.params;
        __setLocal('params', match.params);

        const route = opts.routes[match.index];

        if ('__api' in route && route.__api) {
          return __dispatchApiRoute(apiDispatch[match.index]!, middlewareCtx);
        }

        const pageRoute = route as GeneratedPageRoute;

        // Validate and parse query override if present
        const queryFn = request.headers.get('x-koze-query-fn') || '';
        const queryArgsRaw = request.headers.get('x-koze-query-args') || '[]';
        let queryArgs: any[] = [];
        
        if (queryFn) {
          // Validate query function is allowed for this route
          const allowedQueries = pageRoute.allowedQueries || [];
          // Also allow RPC functions as queries
          const rpcFunctions = pageRoute.rpc ? Object.keys(pageRoute.rpc) : [];
          const allAllowed = [...allowedQueries, ...rpcFunctions];
          
          if (allAllowed.length > 0) {
            const queryValidation = validateQueryOverride(queryFn, allAllowed);
            if (!queryValidation.valid) {
              return __secHeaders(new Response(JSON.stringify({ ok: false, error: queryValidation.reason }), {
                status: 403,
                headers: { 'content-type': 'application/json' },
              }));
            }
          }
          
          // Parse and validate query arguments
          const argsValidation = parseQueryArgs(queryArgsRaw);
          if (!argsValidation.valid) {
            return __secHeaders(new Response(JSON.stringify({ ok: false, error: argsValidation.reason }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            }));
          }
          queryArgs = argsValidation.args as any[];
        }
        
        __setLocal('__queryOverride', queryFn ? { fn: queryFn, args: queryArgs } : null);

        if (request.method === 'POST') {
          const actionResponse = await __handleAction(pageRoute, opts.layoutActions, opts.layout, middlewareCtx, securityConfig);
          if (actionResponse) return actionResponse;
        }

        try {
          const loaded = pageRoute.load ? await pageRoute.load(match.params) : {};
          const data = (__isObject(loaded) ? loaded : { value: loaded }) as Record<string, any>;
          data.params = match.params;
          const allActions = Object.assign({}, pageRoute.actions, opts.layoutActions || {});
          Object.keys(allActions).forEach((key) => {
            if (!(key in data)) data[key] = { error: undefined, pending: false, success: false };
          });
          return await __renderPage(opts.layout, pageRoute, data);
        } catch (err: any) {
          if (err?.isRedirectError) {
            const redirectTo = err.location || url.pathname;
            const redirectStatus = Number(err.status) || 303;
            return __attachCookies(new Response(null, { status: redirectStatus, headers: { location: redirectTo } }));
          }
          const handled = await __runMiddlewareError(middlewareEntries, middlewareCtx, err);
          if (handled) return __secHeaders(handled);
          console.error('[koze] Route load/render error:', err);
          const pageErrStatus = err?.isPageError && err.status ? err.status : 500;
          const errDetail = __sanitizeErrorDetail(err);
          return __secHeaders(new Response(await opts.layout(__renderError(opts.errorPages, pageErrStatus, errDetail)), {
            status: pageErrStatus,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }));
        }
      };

      try {
        if (middlewareEntries.length === 0) {
          return await coreFetch();
        }

        const requestResponse = await __runMiddlewareRequest(middlewareEntries, middlewareCtx, async () => {
          return __runMiddlewareRoute(middlewareEntries, middlewareCtx, coreFetch);
        });
        return await __runMiddlewareResponse(middlewareEntries, middlewareCtx, requestResponse);
      } catch (err) {
        const handled = await __runMiddlewareError(middlewareEntries, middlewareCtx, err);
        if (handled) return __secHeaders(handled);
        throw err;
      }
    },
  };
}

function __tryHandleAssetRequest(
  opts: GeneratedWorkerOptions,
  request: Request,
  url: URL,
): Response | null {
  if (url.pathname.startsWith(opts.assetsPrefix)) {
    const name = url.pathname.slice(opts.assetsPrefix.length);
    const asset = opts.assets[name];
    if (!asset) return new Response('Not Found', { status: 404 });
    if (request.headers.get('if-none-match') === asset.etag) {
      return new Response(null, { status: 304 });
    }
    return new Response(asset.content, {
      headers: {
        'content-type': asset.mime,
        'cache-control': 'public, max-age=31536000, immutable',
        'etag': asset.etag,
      },
    });
  }

  if (url.pathname.startsWith('/__koze/')) {
    const name = url.pathname.slice(1);
    const asset = opts.assets[name];
    if (!asset) return null;
    if (request.headers.get('if-none-match') === asset.etag) {
      return new Response(null, { status: 304 });
    }
    return new Response(asset.content, {
      headers: {
        'content-type': asset.mime,
        'cache-control': 'public, max-age=31536000, immutable',
        'etag': asset.etag,
      },
    });
  }

  return null;
}

function __describeRoute(route: GeneratedPageRoute | GeneratedApiRoute): GeneratedRouteDescription {
  if ('__api' in route && route.__api) {
    const methods = __getApiRouteMethods(route);
    const manifest = (route.manifest && typeof route.manifest === 'object')
      ? { ...route.manifest as Record<string, unknown> }
      : undefined;

    return {
      pattern: route.pattern,
      type: 'api',
      methods: [...methods],
      manifest,
    };
  }

  return {
    pattern: route.pattern,
    type: 'page',
    hasLoad: typeof route.load === 'function',
    actions: Object.keys(route.actions ?? {}),
    rpc: Object.keys(route.rpc ?? {}),
    queries: Array.isArray(route.allowedQueries) ? [...route.allowedQueries] : [],
  };
}

async function __dispatchChannelCall(
  input: KuratchiChannelCallFrame,
  opts: GeneratedWorkerOptions,
  middlewareCtx: MiddlewareContext,
  preparedRouter: PreparedRouter,
) {
  if (input.target === 'server') {
    return __dispatchServerModuleChannelCall(input, opts);
  }

  const routePath = typeof input.route === 'string' && input.route ? input.route : middlewareCtx.url.pathname;
  const routeUrl = new URL(routePath, middlewareCtx.url.origin);
  const match = matchPreparedRouter(preparedRouter, routeUrl.pathname);
  if (!match) {
    return {
      ok: false as const,
      status: 404,
      error: `Unknown channel route: ${routeUrl.pathname}`,
    };
  }

  const route = opts.routes[match.index];
  if ('__api' in route && route.__api) {
    return {
      ok: false as const,
      status: 404,
      error: `Unknown channel operation: ${input.op || '(missing)'}`,
    };
  }
  const pageRoute = route as GeneratedPageRoute;
  if (!input.op || !pageRoute.rpc || !Object.hasOwn(pageRoute.rpc, input.op)) {
    return {
      ok: false as const,
      status: 404,
      error: `Unknown channel operation: ${input.op || '(missing)'}`,
    };
  }

  const previousUrl = middlewareCtx.url;
  const previousParams = middlewareCtx.params;
  const locals = __getLocals();
  const previousLocalParams = locals.params;
  middlewareCtx.url = routeUrl;
  middlewareCtx.params = match.params;
  locals.params = match.params;

  try {
    return await invokeKuratchiChannelHost(
      { operations: pageRoute.rpc, schemas: pageRoute.rpcSchemas },
      { op: input.op, args: input.args, kind: input.kind || 'query' },
    );
  } catch (err) {
    console.error('[koze] Capn Web route RPC error:', err);
    return {
      ok: false as const,
      status: 500,
      error: __sanitizeErrorMessage(err, 'RPC call failed'),
    };
  } finally {
    middlewareCtx.url = previousUrl;
    middlewareCtx.params = previousParams;
    if (previousLocalParams === undefined) delete locals.params;
    else locals.params = previousLocalParams;
  }
}

function __prepareApiRouteDispatch(route: GeneratedPageRoute | GeneratedApiRoute): PreparedApiRouteDispatch | null {
  if (!('__api' in route && route.__api)) return null;

  const handlers: PreparedApiRouteDispatch['handlers'] = Object.create(null);
  const allowedMethods = __getApiRouteMethods(route);
  for (const name of API_METHOD_NAMES) {
    const value = route[name];
    if (typeof value !== 'function') continue;
    handlers[name] = value as (ctx: MiddlewareContext) => Promise<Response> | Response;
  }
  if (typeof handlers.HEAD !== 'function' && typeof handlers.GET === 'function') {
    handlers.HEAD = handlers.GET;
  }

  return {
    handlers,
    allowHeader: allowedMethods.join(', '),
  };
}

function __getApiRouteMethods(route: GeneratedApiRoute): string[] {
  const methods = API_METHOD_NAMES.filter((name) => typeof route[name] === 'function');
  if (typeof route.GET === 'function' && typeof route.HEAD !== 'function') {
    const getIndex = methods.indexOf('GET');
    methods.splice(getIndex === -1 ? 0 : getIndex + 1, 0, 'HEAD');
  }
  return methods;
}

async function __dispatchServerModuleChannelCall(
  input: KuratchiChannelCallFrame,
  opts: GeneratedWorkerOptions,
) {
  const op = typeof input.op === 'string' ? input.op : '';
  const slashIdx = op.lastIndexOf('/');
  if (slashIdx < 0) {
    return {
      ok: false as const,
      status: 400,
      error: 'Malformed channel operation',
    };
  }
  const subpath = op.slice(0, slashIdx);
  const fnName = op.slice(slashIdx + 1);
  const rpcModule = opts.rpcModules?.[subpath];
  if (!rpcModule) {
    return {
      ok: false as const,
      status: 404,
      error: `Unknown RPC module: ${subpath}`,
    };
  }
  const value = fnName === 'default' ? rpcModule.default : rpcModule[fnName];
  if (typeof value !== 'function') {
    if (fnName in rpcModule) return { ok: true as const, value: rpcModule[fnName] ?? null };
    return {
      ok: false as const,
      status: 404,
      error: `Unknown RPC function: ${fnName}`,
    };
  }
  try {
    return await invokeKuratchiChannelHost(
      { operations: { [fnName]: value } },
      { op: fnName, args: input.args, kind: input.kind || 'query' },
    );
  } catch (err) {
    console.error('[koze] Capn Web server RPC error:', err);
    return {
      ok: false as const,
      status: 500,
      error: __sanitizeErrorMessage(err, 'RPC call failed'),
    };
  }
}

async function __dispatchApiRoute(dispatch: PreparedApiRouteDispatch, middlewareCtx: MiddlewareContext): Promise<Response> {
  const { request } = middlewareCtx;
  const method = request.method as ApiMethodName;
  if (method === 'OPTIONS') {
    const handler = dispatch.handlers.OPTIONS;
    if (handler) return __secHeaders(await handler(middlewareCtx));
    return __secHeaders(new Response(null, {
      status: 204,
      headers: { Allow: dispatch.allowHeader, 'Access-Control-Allow-Methods': dispatch.allowHeader },
    }));
  }
  const handler = dispatch.handlers[method];
  if (!handler) {
    return __secHeaders(new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'content-type': 'application/json', Allow: dispatch.allowHeader },
    }));
  }
  const response = await handler(middlewareCtx);
  if (method !== 'HEAD') return __secHeaders(response);
  return __secHeaders(new Response(null, response));
}

interface RuntimeSecurityConfig {
  contentSecurityPolicy: string | null;
  strictTransportSecurity: string | null;
  permissionsPolicy: string | null;
}

async function __handleAction(
  route: GeneratedPageRoute,
  layoutActions: Record<string, (...args: any[]) => Promise<unknown> | unknown>,
  layout: (content: string, head?: string) => Promise<string> | string,
  middlewareCtx: MiddlewareContext,
  securityConfig: RuntimeSecurityConfig,
): Promise<Response | null> {
  const { request, url, params } = middlewareCtx;
  if (request.method !== 'POST') return null;

  // Validate origin before reading the body. Blocks cross-origin form POSTs; auth
  // is the developer's responsibility inside the action handler itself.
  const actionSecConfig: ActionSecurityConfig = { requireSameOrigin: true };
  const actionValidation = validateActionRequest(request, url, actionSecConfig);
  if (!actionValidation.valid) {
    return __secHeaders(new Response(actionValidation.reason || 'Forbidden', { status: actionValidation.status }));
  }

  const formData = await request.formData();
  const actionName = formData.get('_action');
  const actionKey = typeof actionName === 'string' ? actionName : null;
  const actionFn = (actionKey && route.actions && Object.hasOwn(route.actions, actionKey) ? route.actions[actionKey] : null)
    || (actionKey && layoutActions && Object.hasOwn(layoutActions, actionKey) ? layoutActions[actionKey] : null);
  if (!(actionKey && actionFn)) {
    return null;
  }

  const argsStr = formData.get('_args');
  const isFetchAction = argsStr !== null;
  const actionMode = request.headers.get('x-koze-action');
  const isAugmentedFormAction = actionMode === 'augment';
  const isHtmlAugmentedFormAction = actionMode === 'augment-html';
  const actionContext = {
    formData,
    request,
    url,
    params,
    env: middlewareCtx.env,
    ctx: middlewareCtx.ctx,
    locals: middlewareCtx.locals,
  };
  try {
    if (isFetchAction) {
      const parsed = JSON.parse(String(argsStr));
      const args = Array.isArray(parsed) ? parsed : [];
      await actionFn(...args, actionContext);
    } else {
      await actionFn(actionContext);
    }
  } catch (err: any) {
    if (err?.isRedirectError) {
      const redirectTo = err.location || url.pathname;
      const redirectStatus = Number(err.status) || 303;
      if (isAugmentedFormAction) {
        return __attachCookies(__secHeaders(new Response(JSON.stringify({
          ok: true,
          action: actionKey,
          redirectTo,
          redirectStatus,
          state: { error: undefined, pending: false, success: true },
        }), {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        })));
      }
      if (isFetchAction) {
        return __attachCookies(__secHeaders(new Response(JSON.stringify({ ok: true, redirectTo, redirectStatus }), {
          headers: { 'content-type': 'application/json' },
        })));
      }
      return __attachCookies(new Response(null, { status: redirectStatus, headers: { location: redirectTo } }));
    }
    console.error('[koze] Action error:', err);
    if (isFetchAction) {
      const errMsg = __sanitizeErrorMessage(err);
      return __secHeaders(new Response(JSON.stringify({ ok: false, error: errMsg }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }));
    }
    const loaded = route.load ? await route.load(params) : {};
    const data = (__isObject(loaded) ? loaded : { value: loaded }) as Record<string, any>;
    data.params = params;
    const allActions = Object.assign({}, route.actions, layoutActions || {});
    Object.keys(allActions).forEach((key) => {
      if (!(key in data)) data[key] = { error: undefined, pending: false, success: false };
    });
    const errMsg = __sanitizeErrorMessage(err, 'Action failed');
    data[actionKey] = { error: errMsg, pending: false, success: false };
    if (isAugmentedFormAction) {
      return __secHeaders(new Response(JSON.stringify({
        ok: false,
        action: actionKey,
        error: errMsg,
        state: data[actionKey],
      }), {
        status: 422,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      }));
    }
    return await __renderPage(layout, route, data);
  }

  if (isFetchAction) {
    return __attachCookies(new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    }));
  }

  if (isAugmentedFormAction) {
    const redirectTo = middlewareCtx.locals.__redirectTo || null;
    const redirectStatus = Number(middlewareCtx.locals.__redirectStatus) || (redirectTo ? 303 : null);
    return __attachCookies(new Response(JSON.stringify({
      ok: true,
      action: actionKey,
      redirectTo,
      redirectStatus,
      state: { error: undefined, pending: false, success: true },
    }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }));
  }

  if (isHtmlAugmentedFormAction) {
    const loaded = route.load ? await route.load(params) : {};
    const data = (__isObject(loaded) ? loaded : { value: loaded }) as Record<string, any>;
    data.params = params;
    const allActions = Object.assign({}, route.actions, layoutActions || {});
    Object.keys(allActions).forEach((key) => {
      if (!(key in data)) data[key] = { error: undefined, pending: false, success: false };
    });
    data[actionKey] = { error: undefined, pending: false, success: true };
    return await __renderPage(layout, route, data);
  }

  const locals = __getLocals();
  const redirectTo = locals.__redirectTo || url.pathname;
  const redirectStatus = Number(locals.__redirectStatus) || 303;
  return __attachCookies(new Response(null, { status: redirectStatus, headers: { location: redirectTo } }));
}

async function __renderPage(
  layout: (content: string, head?: string) => Promise<string> | string,
  route: GeneratedPageRoute,
  data: Record<string, any>,
): Promise<Response> {
  const rendered = __normalizeRenderOutput(route.render(data));

  // Inject workflow poll metadata if workflowStatus(..., { poll }) was called during render.
  // The client bridge reads this <script> and re-fetches the page on the interval.
  const poll = __getLocals().__kozePoll as { interval: string | number; done: boolean } | undefined;
  let html = rendered.html;
  const responseHeaders: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
  if (poll && !poll.done) {
    const payload = JSON.stringify({ interval: poll.interval });
    html = `${html}\n<script type="application/json" id="__koze_poll">${payload.replace(/</g, '\\u003c')}</script>`;
  }
  if (poll?.done) {
    responseHeaders['x-koze-poll-done'] = '1';
  }

  let body = await layout(html, rendered.head || '');

  // If the developer configured a CSP with the `{NONCE}` opt-in, stamp the per-request
  // nonce onto every <script> tag the framework emitted. No-op when nonce is absent.
  const nonce = (__getLocals().__cspNonce as string | undefined) || '';
  if (nonce) {
    body = __stampScriptNonces(body, nonce);
  }

  return __attachCookies(new Response(body, { headers: responseHeaders }));
}

/**
 * Add `nonce="..."` to every `<script` opening tag in the rendered HTML unless the tag
 * already carries a nonce. Idempotent and safe on strings (no DOM traversal available).
 */
function __stampScriptNonces(html: string, nonce: string): string {
  return html.replace(/<script\b(?![^>]*\bnonce=)([^>]*)>/gi, `<script nonce="${nonce}"$1>`);
}

function __renderError(errorPages: Record<number, (detail?: string) => string>, status: number, detail?: string): string {
  const custom = errorPages[status];
  if (custom) return custom(detail);
  const title = __errorMessages[status] || 'Error';
  const detailHtml = detail
    ? '<p style="font-family:ui-monospace,monospace;font-size:0.8rem;color:#555;background:#111;padding:0.5rem 1rem;border-radius:6px;max-width:480px;margin:1rem auto 0;word-break:break-word">' + __esc(detail) + '</p>'
    : '';
  return '<div style="display:flex;align-items:center;justify-content:center;min-height:60vh;text-align:center;padding:2rem">'
    + '<div>'
    + '<p style="font-size:5rem;font-weight:700;margin:0;color:#333;line-height:1">' + status + '</p>'
    + '<p style="font-size:1rem;color:#555;margin:0.5rem 0 0;letter-spacing:0.05em">' + __esc(title) + '</p>'
    + detailHtml
    + '</div>'
    + '</div>';
}

function __isSameOrigin(request: Request, url: URL): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') {
    return false;
  }
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === url.origin;
  } catch {
    return false;
  }
}

function __secHeaders(response: Response): Response {
  if (__isWebSocketUpgradeResponse(response)) return response;
  for (const [key, value] of Object.entries(__configuredSecHeaders)) {
    if (response.headers.has(key)) continue;
    if (key === 'Content-Security-Policy' && value.includes('{NONCE}')) {
      const nonce = (__getLocals().__cspNonce as string | undefined) || '';
      response.headers.set(key, nonce ? value.replace(/\{NONCE\}/g, nonce) : value);
      continue;
    }
    response.headers.set(key, value);
  }
  return response;
}

function __attachCookies(response: Response): Response {
  if (__isWebSocketUpgradeResponse(response)) return response;
  const locals = __getLocals();
  const cookies = locals.__setCookieHeaders;
  if (cookies && cookies.length > 0) {
    // Clone the response properly to avoid body stream issues with WARP/proxy layers.
    const cloned = response.clone();
    const newHeaders = new Headers(cloned.headers);
    for (const header of cookies) newHeaders.append('Set-Cookie', header);
    const newResponse = new Response(cloned.body, {
      status: cloned.status,
      statusText: cloned.statusText,
      headers: newHeaders,
    });
    return __secHeaders(newResponse);
  }
  return __secHeaders(response);
}

function __isWebSocketUpgradeResponse(response: Response): boolean {
  return response.status === 101;
}

async function __runMiddlewareRequest(
  middlewareEntries: MiddlewareEntry[],
  ctx: MiddlewareContext,
  next: () => Promise<Response>,
): Promise<Response> {
  let idx = -1;
  async function dispatch(i: number): Promise<Response> {
    if (i <= idx) throw new Error('[kuratchi middleware] next() called multiple times in request phase');
    idx = i;
    const entry = middlewareEntries[i];
    if (!entry) return next();
    const [, step] = entry;
    if (typeof step.request !== 'function') return dispatch(i + 1);
    return step.request(ctx, () => dispatch(i + 1));
  }
  return dispatch(0);
}

async function __runMiddlewareRoute(
  middlewareEntries: MiddlewareEntry[],
  ctx: MiddlewareContext,
  next: () => Promise<Response>,
): Promise<Response> {
  let idx = -1;
  async function dispatch(i: number): Promise<Response> {
    if (i <= idx) throw new Error('[kuratchi middleware] next() called multiple times in route phase');
    idx = i;
    const entry = middlewareEntries[i];
    if (!entry) return next();
    const [, step] = entry;
    if (typeof step.route !== 'function') return dispatch(i + 1);
    return step.route(ctx, () => dispatch(i + 1));
  }
  return dispatch(0);
}

async function __runMiddlewareResponse(
  middlewareEntries: MiddlewareEntry[],
  ctx: MiddlewareContext,
  response: Response,
): Promise<Response> {
  if (__isWebSocketUpgradeResponse(response)) return response;
  let out = response;
  for (const [, step] of middlewareEntries) {
    if (typeof step.response !== 'function') continue;
    out = await step.response(ctx, out);
    if (!(out instanceof Response)) {
      throw new Error('[koze] middleware response hook must return a Response');
    }
  }
  return out;
}

async function __runMiddlewareError(
  middlewareEntries: MiddlewareEntry[],
  ctx: MiddlewareContext,
  error: unknown,
): Promise<Response | null> {
  for (const [name, step] of middlewareEntries) {
    if (typeof step.error !== 'function') continue;
    try {
      const handled = await step.error(ctx, error);
      if (handled instanceof Response) return handled;
    } catch (hookErr) {
      console.error('[kuratchi middleware] error handler failed in step', name, hookErr);
    }
  }
  return null;
}

function __isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function __normalizeRenderOutput(output: PageRenderOutput): PageRenderResult {
  if (typeof output === 'string') {
    return { html: output, head: '' };
  }
  return {
    html: typeof output?.html === 'string' ? output.html : '',
    head: typeof output?.head === 'string' ? output.head : '',
  };
}

function __getMiddlewareEntries(middlewareDefinition: MiddlewareDefinition | undefined): MiddlewareEntry[] {
  return Object.entries(middlewareDefinition ?? {}).filter(
    (entry): entry is MiddlewareEntry => !!entry[1] && typeof entry[1] === 'object',
  );
}

function __isDevMode(): boolean {
  return !!(globalThis as Record<string, any>).__koze_DEV__;
}

/**
 * Sanitize error messages for client responses.
 * In production, only expose safe error messages to prevent information leakage.
 * In dev mode, expose full error details for debugging.
 */
function __sanitizeErrorMessage(err: any, fallback: string = 'Internal Server Error'): string {
  // Always allow explicit user-facing errors (ActionError, PageError)
  if (err?.isActionError || err?.isPageError) {
    return err.message || fallback;
  }
  // In dev mode, expose full error message for debugging
  if (__isDevMode() && err?.message) {
    return err.message;
  }
  // In production, use generic message to prevent information leakage
  return fallback;
}

/**
 * Sanitize error details for HTML error pages.
 * Returns undefined in production to hide error details.
 */
function __sanitizeErrorDetail(err: any): string | undefined {
  // PageError messages are always safe to show
  if (err?.isPageError) {
    return err.message;
  }
  // In dev mode, show error details
  if (__isDevMode() && err?.message) {
    return err.message;
  }
  // In production, hide error details
  return undefined;
}

const __defaultSecHeaders: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

let __configuredSecHeaders: Record<string, string> = { ...__defaultSecHeaders };

function __initSecurityHeaders(config: RuntimeSecurityConfig): void {
  __configuredSecHeaders = { ...__defaultSecHeaders };
  if (config.contentSecurityPolicy) {
    __configuredSecHeaders['Content-Security-Policy'] = config.contentSecurityPolicy;
  }
  if (config.strictTransportSecurity) {
    __configuredSecHeaders['Strict-Transport-Security'] = config.strictTransportSecurity;
  }
  if (config.permissionsPolicy) {
    __configuredSecHeaders['Permissions-Policy'] = config.permissionsPolicy;
  }
}

const __errorMessages: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};
