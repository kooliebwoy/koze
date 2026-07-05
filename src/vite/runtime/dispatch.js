/**
 * Kuratchi dispatch module — served as the `koze:dispatch` virtual
 * module inside the Worker bundle. Loaded as raw text from the plugin
 * (NOT transpiled by Vite, NOT a template literal) so comments can use
 * backticks and ${} freely without template-literal escaping hazards.
 *
 * Runs inside the Worker runtime: no Node APIs, no TypeScript, ESM-only,
 * globals limited to the Worker platform (Request, Response, URL, fetch,
 * crypto, etc.).
 */

import { routes, preparedRouter } from 'koze:routes';
import { lookup as lookupRpcModule } from 'koze:rpc-map';
import { runtime as middlewareRuntime } from 'virtual:koze-middleware-entry';
// Populate the per-request globals that `getEnv()` and the request-state
// virtual modules read. Without
// this, any `$server/*` code using `getEnv()` (e.g. the ORM's lazy
// binding resolver) throws "called outside of a request context".
import { __setRequestContext, __getLocals } from '@kuratchi/koze/runtime/context.js';
import { matchPreparedRouter } from '@kuratchi/koze/runtime/router.js';
import {
	createKuratchiCapnWebHttpResponse,
	createKuratchiCapnWebWebSocketResponse,
	isKuratchiCapnWebWebSocketRequest,
} from '@kuratchi/koze/runtime/channel-capnweb-host.js';
import { invokeKuratchiChannelHost } from '@kuratchi/koze/runtime/channel-host.js';
import { KOZE_CHANNEL_ENDPOINT, KOZE_LEGACY_CHANNEL_ENDPOINT } from '@kuratchi/koze/runtime/channel-protocol.js';

// Client-side polling bridge injected into pages that use workflowStatus({ poll }).
// Mirrors the initWorkflowPoll IIFE from root-layout-pipeline.ts (the CLI path).
const __POLL_BRIDGE_SCRIPT = '<script>(function(){function parseInterval(v){if(typeof v==="number")return v>0?v:30000;if(!v)return 30000;var m=String(v).match(/^(\\d+(?:\\.\\d+)?)(ms|s|m)?$/i);if(!m)return 30000;var n=parseFloat(m[1]);var u=(m[2]||"s").toLowerCase();if(u==="ms")return n;if(u==="m")return n*60000;return n*1000}function readConfig(){var el=document.getElementById("__koze_poll");if(!el)return null;try{return JSON.parse(el.textContent||"{}")}catch(e){return null}}var timer=null;var stopped=false;function stop(){stopped=true;if(timer){clearTimeout(timer);timer=null}}function tick(interval){if(stopped)return;timer=setTimeout(function(){if(stopped)return;if(document.hidden){tick(interval);return}fetch(location.pathname+location.search,{headers:{"x-koze-poll":"1"},credentials:"same-origin"}).then(function(r){var done=r.headers.get("x-koze-poll-done")==="1";return r.text().then(function(html){return{html:html,done:done,ok:r.ok}})}).then(function(res){if(stopped)return;if(!res.ok){tick(interval);return}if(typeof DOMParser==="undefined"){location.reload();return}var doc=new DOMParser().parseFromString(res.html,"text/html");if(doc&&doc.body){document.body.innerHTML=doc.body.innerHTML}if(res.done){stop();return}var next=readConfig();tick(next?parseInterval(next.interval):interval)}).catch(function(){if(!stopped)tick(interval)})},interval)}var cfg=readConfig();if(cfg)tick(parseInterval(cfg.interval))})()\x3c/script>';
// Reuse the legacy security module wholesale. Same guarantees as the
// CLI-generated worker: same-origin gate on RPC/action, default security
// headers, optional CSP nonce stamping.
import {
	validateRpcRequest,
	validateActionRequest,
	applySecurityHeaders as __applySecHeadersRaw,
	initCspNonce,
	getCspNonce,
	sanitizeErrorMessage,
	sanitizeErrorDetail,
} from '@kuratchi/koze/runtime/security.js';
// Response-header security configuration (CSP / HSTS / Permissions-Policy).
// The plugin generates this virtual module from `koze({ security: {...} })`
// options. Defaults to all-null when no security options are passed.
import { config as __securityConfig } from 'koze:security';

const __cspUsesNonce = !!(
	__securityConfig?.contentSecurityPolicy &&
	__securityConfig.contentSecurityPolicy.includes('{NONCE}')
);

function applySecurityHeaders(response) {
	if (isWebSocketUpgradeResponse(response)) return response;
	return __applySecHeadersRaw(response, __securityConfig);
}

// Streaming async-boundary primitives. After a template render that used
// `const x = fn()` patterns, the per-request boundary collector is populated.
// We read it here to decide whether to stream the response or return a flat
// string (no boundaries = no streaming, zero overhead).
import {
	__takeCollectedBoundaries,
	BOOTSTRAP_SCRIPT as __BOUNDARY_BOOTSTRAP,
	resolveBoundaryToChunk,
} from '@kuratchi/koze/runtime/stream.js';

// Action-handler calling convention (`fn(...args, ctx)`). Lives in its
// own module because it's the only piece of the dispatcher that can be
// exercised in isolation — the rest of this file transitively imports
// Worker-only virtual modules that Bun can't resolve at test time.
import { invokeAction } from './invoke-action.js';

/**
 * The middleware definition is a map of step names
 * to `{ request, route, response, error }` handlers. We precompute the
 * sorted entry list once per worker boot; per-request, each phase walks
 * the list in order with a `next()` chain so steps can wrap downstream
 * work (auth → logging → feature flags, etc.).
 */
const middlewareEntries = Object.entries(middlewareRuntime || {}).filter(
	([, step]) => step && typeof step === 'object',
);
const hasMiddleware = middlewareEntries.length > 0;

async function runRequestPhase(ctx, next) {
	let idx = -1;
	async function dispatch(i) {
		if (i <= idx) throw new Error('[koze] next() called twice in request phase');
		idx = i;
		const entry = middlewareEntries[i];
		if (!entry) return next();
		const [, step] = entry;
		if (typeof step.request !== 'function') return dispatch(i + 1);
		return step.request(ctx, () => dispatch(i + 1));
	}
	return dispatch(0);
}

async function runRoutePhase(ctx, next) {
	let idx = -1;
	async function dispatch(i) {
		if (i <= idx) throw new Error('[koze] next() called twice in route phase');
		idx = i;
		const entry = middlewareEntries[i];
		if (!entry) return next();
		const [, step] = entry;
		if (typeof step.route !== 'function') return dispatch(i + 1);
		return step.route(ctx, () => dispatch(i + 1));
	}
	return dispatch(0);
}

async function runResponsePhase(ctx, response) {
	if (isWebSocketUpgradeResponse(response)) return response;
	// `Response.redirect()` and some other constructors produce responses
	// with immutable headers. Middleware typically needs to mutate headers
	// (set cookies, custom observability headers), so we rebuild into a
	// mutable Response before handing to steps. Cheap for our scale.
	let current = toMutableResponse(response);
	for (const [, step] of middlewareEntries) {
		if (typeof step.response === 'function') {
			current = (await step.response(ctx, current)) || current;
		}
	}
	return current;
}

function toMutableResponse(response) {
	if (!response) return response;
	if (isWebSocketUpgradeResponse(response)) return response;
	// Redirect responses (303/302/etc) have a frozen headers list. Copying
	// status + headers into a new Response gives a mutable clone.
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: new Headers(response.headers),
	});
}

async function runErrorPhase(ctx, error) {
	for (const [, step] of middlewareEntries) {
		if (typeof step.error !== 'function') continue;
		const result = await step.error(ctx, error);
		if (result && result.response instanceof Response) return result.response;
	}
	return null;
}

const API_METHOD_NAMES = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function prepareApiRoute(routeModule) {
	const handlers = Object.create(null);
	const allowedMethods = getApiRouteMethods(routeModule);
	for (const name of API_METHOD_NAMES) {
		const value = routeModule[name];
		if (typeof value !== 'function') continue;
		handlers[name] = value;
	}
	if (typeof handlers.HEAD !== 'function' && typeof handlers.GET === 'function') {
		handlers.HEAD = handlers.GET;
	}
	return {
		handlers,
		allowHeader: allowedMethods.join(', '),
	};
}

function getApiRouteMethods(routeModule) {
	const methods = API_METHOD_NAMES.filter((name) => typeof routeModule[name] === 'function');
	if (typeof routeModule.GET === 'function' && typeof routeModule.HEAD !== 'function') {
		const getIndex = methods.indexOf('GET');
		methods.splice(getIndex === -1 ? 0 : getIndex + 1, 0, 'HEAD');
	}
	return methods;
}

const compiledRoutes = routes.map((r) => ({
	pattern: r.pattern,
	type: r.type || 'page',
	module: r.module,
	api: (r.type || 'page') === 'api' ? prepareApiRoute(r.module) : null,
}));

/**
 * High-level Koze request handler. The user's Worker delegates via
 * `koze:worker`, which wires this `handle` into the `fetch` export.
 */
export async function handle(request, env, ctx) {
	const url = new URL(request.url);

	// Seed the module-scoped context so helpers like `getEnv()` and the
	// request-state bindings work in any
	// `$server/*` module for the duration of this request. Workers are
	// single-threaded per isolate, so this is safe despite the module
	// scope — the handler completes before the next request starts.
	__setRequestContext(ctx, request, env);

	// Per-request CSP nonce — only when the policy opts in via `{NONCE}`.
	// Most apps don't configure a CSP at all; skip the work.
	if (__cspUsesNonce) {
		initCspNonce();
	}

	// Runtime context passed to every middleware step. `locals` MUST be
	// the same object the runtime `locals` proxy reads — otherwise
	// middleware mutations (e.g. `ctx.locals.userId = 1`) land on a
	// detached object and downstream handlers, actions, and
	// `$server/*` modules read `undefined`. `__setRequestContext` reset
	// `__locals = {}` above; we grab that same reference and hand it
	// through the runtime context.
	const runtimeCtx = {
		request,
		env,
		ctx,
		url,
		locals: __getLocals(),
		params: {},
	};

	try {
		if (!hasMiddleware) {
			return finalizeResponse(toMutableResponse(await coreHandle(runtimeCtx)));
		}

		const requestResponse = await runRequestPhase(runtimeCtx, async () => {
			return runRoutePhase(runtimeCtx, async () => {
				// Always hand middleware a mutable response: `Response.redirect()`
				// and friends return frozen headers, which breaks middleware that
				// sets cookies / observability headers after `await next()`.
				return toMutableResponse(await coreHandle(runtimeCtx));
			});
		});
		const afterResponseChain = await runResponsePhase(runtimeCtx, requestResponse);
		return finalizeResponse(afterResponseChain);
	} catch (err) {
		const handled = await runErrorPhase(runtimeCtx, err);
		if (handled) return finalizeResponse(handled);
		// Last-chance framework error path. We do NOT rethrow in prod
		// because Cloudflare's default 1101 page leaks stack traces into
		// logs + headers on some proxies. Render a minimal sanitized
		// 500 instead; `sanitizeErrorDetail` suppresses the raw message
		// in prod (`isDevMode() === false`) and keeps `PageError`
		// messages visible because they're intentional.
		console.error('[koze] Unhandled request error:', err);
		const detail = sanitizeErrorDetail(err);
		const status = (err && err.isPageError && Number(err.status)) || 500;
		const body = detail
			? `<!doctype html><html><head><meta charset="utf-8"><title>Error</title></head><body><h1>${status}</h1><pre>${escapeHtml(detail)}</pre></body></html>`
			: `<!doctype html><html><head><meta charset="utf-8"><title>Error</title></head><body><h1>${status}</h1></body></html>`;
		return finalizeResponse(new Response(body, {
			status,
			headers: { 'content-type': 'text/html; charset=utf-8' },
		}));
	}
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Final response pipeline: attach `Set-Cookie` headers accumulated in
 * `locals.__setCookieHeaders` (the shared convention used by
 * `@kuratchi/auth` and `createAuthSession()`), THEN apply framework
 * security headers (X-Content-Type-Options, X-Frame-Options,
 * Referrer-Policy, optional CSP) and stamp CSP nonces onto
 * framework-injected `<script>` tags in HTML output. No-op when CSP is
 * unconfigured (most apps).
 *
 * Mirrors `__attachCookies` → `__secHeaders` in the legacy CLI
 * `generated-worker.ts`. Must stay in that order — CSP / security
 * headers should be final.
 */
function finalizeResponse(response) {
	if (isWebSocketUpgradeResponse(response)) return response;
	const locals = __getLocals();
	const cookies = locals?.__setCookieHeaders;
	if (cookies && cookies.length > 0) {
		// Clone to avoid body-stream reuse issues behind WARP / proxy layers.
		const cloned = response.clone();
		const headers = new Headers(cloned.headers);
		for (const header of cookies) headers.append('Set-Cookie', header);
		return applySecurityHeaders(new Response(cloned.body, {
			status: cloned.status,
			statusText: cloned.statusText,
			headers,
		}));
	}
	return applySecurityHeaders(response);
}

function isWebSocketUpgradeResponse(response) {
	return !!response && response.status === 101;
}

/**
 * Route + RPC + action dispatch.
 *
 * Routes deliberately DO NOT receive `env`, `ctx`, or `locals` in their
 * `render()` payload — templates must stay env-agnostic, and any binding
 * access has to go through a `$server/*` module (which uses `getEnv()`
 * from the module-scope request context we seeded in `handle`).
 *
 * This mirrors the legacy CLI's `generated-worker.ts` contract exactly.
 */
async function coreHandle(runtimeCtx) {
	const { request, url } = runtimeCtx;

	if (url.pathname === KOZE_CHANNEL_ENDPOINT || url.pathname === KOZE_LEGACY_CHANNEL_ENDPOINT) {
		const isWebSocket = isKuratchiCapnWebWebSocketRequest(request);
		const channelCheck = validateRpcRequest(request, url, {
			allowedMethods: [isWebSocket ? 'GET' : 'POST'],
			requireSameOrigin: true,
		});
		if (!channelCheck.valid) {
			return new Response(JSON.stringify({ ok: false, error: channelCheck.reason }), {
				status: channelCheck.status,
				headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
			});
		}
		if (isWebSocket) {
			return createKuratchiCapnWebWebSocketResponse(request, (input) => {
				return dispatchChannelCall(input, runtimeCtx);
			});
		}
		return createKuratchiCapnWebHttpResponse(request, (input) => {
			return dispatchChannelCall(input, runtimeCtx);
		});
	}

	const routeMatch = matchPreparedRouter(preparedRouter, url.pathname);
	if (!routeMatch) return new Response('Not Found', { status: 404 });
	const match = compiledRoutes[routeMatch.index];
	const params = routeMatch.params;
	runtimeCtx.params = params;

	if (match.type === 'api') {
		return handleApiRoute(match.api, runtimeCtx);
	}

	if (request.method === 'POST') {
		// Actions, like RPC, are same-origin-only. Cross-origin form
		// POSTs (e.g. an attacker's site submitting to ours) are rejected.
		const actionCheck = validateActionRequest(request, url, { requireSameOrigin: true });
		if (!actionCheck.valid) {
			return new Response(actionCheck.reason ?? 'Forbidden', { status: actionCheck.status });
		}
		return handleAction(request, match, params, url);
	}

	return renderRoute(request, url, match, params);
}

async function dispatchChannelCall(input, runtimeCtx) {
	const target = input && input.target === 'server' ? 'server' : 'route';
	if (target === 'server') {
		return dispatchServerModuleChannelCall(input);
	}
	return dispatchRouteChannelCall(input, runtimeCtx);
}

async function dispatchRouteChannelCall(input, runtimeCtx) {
	const op = input && typeof input.op === 'string' ? input.op : '';
	const routePath = input && typeof input.route === 'string' ? input.route : runtimeCtx.url.pathname;
	const routeUrl = new URL(routePath || '/', runtimeCtx.url.origin);
	const routeMatch = matchPreparedRouter(preparedRouter, routeUrl.pathname);
	const match = routeMatch ? compiledRoutes[routeMatch.index] : null;
	const params = routeMatch ? routeMatch.params : null;
	const rpcTable = match && match.module && match.module.rpc && typeof match.module.rpc === 'object'
		? match.module.rpc
		: null;
	if (!op || !rpcTable || !Object.hasOwn(rpcTable, op)) {
		return { ok: false, status: 404, error: `Unknown channel operation: ${op || '(missing)'}` };
	}
	const previousUrl = runtimeCtx.url;
	const previousParams = runtimeCtx.params;
	const locals = __getLocals();
	const previousLocalParams = locals.params;
	runtimeCtx.url = routeUrl;
	runtimeCtx.params = params || {};
	locals.params = params || {};
	try {
		return await invokeKuratchiChannelHost(
			{ operations: rpcTable, schemas: match.module.rpcSchemas },
			{ op, args: input.args, kind: input.kind || 'query' },
		);
	} catch (err) {
		console.error('[koze] Capn Web route RPC error:', err);
		return { ok: false, status: 500, error: sanitizeErrorMessage(err, 'RPC call failed') };
	} finally {
		runtimeCtx.url = previousUrl;
		runtimeCtx.params = previousParams;
		if (previousLocalParams === undefined) delete locals.params;
		else locals.params = previousLocalParams;
	}
}

async function dispatchServerModuleChannelCall(input) {
	const op = input && typeof input.op === 'string' ? input.op : '';
	const slashIdx = op.lastIndexOf('/');
	if (slashIdx < 0) {
		return { ok: false, status: 400, error: 'Malformed channel operation' };
	}
	const subpath = op.slice(0, slashIdx);
	const fnName = op.slice(slashIdx + 1);
	const mod = lookupRpcModule(subpath);
	if (!mod) {
		return { ok: false, status: 404, error: 'Unknown RPC module: ' + subpath };
	}
	const value = fnName === 'default' ? mod.default : mod[fnName];
	if (typeof value !== 'function') {
		if (fnName in mod) return { ok: true, value: mod[fnName] ?? null };
		return { ok: false, status: 404, error: 'Unknown RPC function: ' + fnName };
	}
	try {
		return await invokeKuratchiChannelHost(
			{ operations: { [fnName]: value } },
			{ op: fnName, args: input.args, kind: input.kind || 'query' },
		);
	} catch (err) {
		console.error('[koze] Capn Web RPC error:', err);
		return { ok: false, status: 500, error: sanitizeErrorMessage(err, 'RPC call failed') };
	}
}

async function handleApiRoute(api, runtimeCtx) {
	const { request } = runtimeCtx;
	const method = request.method;

	if (method === 'OPTIONS') {
		const handler = api.handlers.OPTIONS;
		if (typeof handler === 'function') return handler(runtimeCtx);
		return new Response(null, {
			status: 204,
			headers: { Allow: api.allowHeader, 'Access-Control-Allow-Methods': api.allowHeader },
		});
	}

	const handler = api.handlers[method];
	if (typeof handler !== 'function') {
		return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
			status: 405,
			headers: { 'content-type': 'application/json', Allow: api.allowHeader },
		});
	}

	const response = await handler(runtimeCtx);
	if (method !== 'HEAD') return response;
	return new Response(null, response);
}

/**
 * Render a matched route to an HTML Response. Shared by:
 *   - the GET path (normal page load)
 *   - the action-error path (POST → action threw → re-render same page
 *     with `actionName.error` populated so the template can surface it)
 *
 * `overrides` lets the action-error path inject its error/success state
 * into the render data without duplicating the data-construction logic.
 * `status` defaults to 200 for normal renders; action errors pass 422
 * (Unprocessable Entity) or whatever status the thrown error provides.
 */
async function renderRoute(request, url, match, params, overrides, status) {
	// `render(data)` receives the safe subset of request state. The
	// compiled route module destructures `url`, `pathname`, `searchParams`,
	// `params`, `slug`, `method` from `data` (via synthesized
	// `requestImportDecls` — see `transformRouteFile` in the plugin) so
	// the leading-script body running inside render can read
	// `koze:request` values. Locals and env are NOT here — templates
	// reach those through `$server/*` modules.
	const data = {
		url,
		pathname: url.pathname,
		searchParams: url.searchParams,
		params,
		slug: params?.slug ?? Object.values(params ?? {})[0],
		method: request.method,
	};
	// Seed default action state for every declared action on this route so
	// templates can reference `myAction.error` / `.pending` / `.success`
	// unconditionally — no existence checks required. Action errors
	// overwrite this below via `overrides`.
	if (match.module.actions) {
		for (const actionKey of Object.keys(match.module.actions)) {
			if (!(actionKey in data)) {
				data[actionKey] = { error: undefined, pending: false, success: false };
			}
		}
	}
	if (overrides) Object.assign(data, overrides);

	let rendered;
	try {
		rendered = await match.module.render(data);
	} catch (err) {
		// Same `redirect()` control-flow as actions: a route's leading
		// `<script>` can call `redirect('/somewhere')` (e.g. to bounce
		// unauthenticated users). The framework's `RedirectError` must
		// be converted to a 3xx here — otherwise it bubbles to the
		// error phase and renders a 500 page.
		if (err && err.isRedirectError) {
			const location = err.location || url.pathname;
			const redirectStatus = Number(err.status) || 303;
			return new Response(null, { status: redirectStatus, headers: { location } });
		}
		throw err;
	}
	// Legacy contract: `render()` may return either a string (raw HTML)
	// or an object with `html` / `head` fields (when the compiler
	// produced a layout-compatible render). Normalize to string.
	let html = typeof rendered === 'string'
		? rendered
		: (rendered?.html ?? '');

	// Inject workflow poll metadata if workflowStatus(..., { poll }) was
	// called during render. The client bridge reads the JSON config tag and
	// re-fetches the page on the given interval, swapping <body> contents
	// so every { status.* } in the template re-renders against fresh data.
	// The server sets x-koze-poll-done when the 'until' predicate
	// reports terminal, so the client stops polling.
	const poll = __getLocals().__kozePoll;
	const responseHeaders = { 'content-type': 'text/html; charset=utf-8' };
	if (poll && !poll.done) {
		const payload = JSON.stringify({ interval: poll.interval });
		html = html + '\n<script type="application/json" id="__koze_poll">' + payload.replace(/</g, '\\u003c') + '</script>';
		// Inject the client-side polling bridge inline. The IIFE reads the
		// config tag above, then re-fetches the current URL on the interval
		// and swaps <body> contents. Runs once — the setTimeout chain
		// survives body innerHTML replacements because the closure is in
		// memory, not in the DOM.
		html = html + '\n' + __POLL_BRIDGE_SCRIPT;
	}
	if (poll && poll.done) {
		responseHeaders['x-koze-poll-done'] = '1';
	}

	// Streaming: if the template registered any async boundaries via
	// `const x = fn()` patterns, the sync render emitted pending-state
	// placeholder divs and queued the promises on the request-scoped
	// collector. We now:
	//   1. Inject the bootstrap `$_swap` helper once.
	//   2. Keep the initial HTML's `</body>` / `</html>` tail for after the chunks.
	//   3. Stream each resolved chunk (`<template>` + `<script>$_swap(id)</script>`)
	//      into the body before those closing tags.
	// If there are no boundaries, skip the streaming machinery entirely
	// and return a plain string response — zero overhead for simple pages.
	const boundaries = __takeCollectedBoundaries();
	if (boundaries.length === 0) {
		return new Response(html, {
			status: status ?? 200,
			headers: responseHeaders,
		});
	}
	return streamResponseWithBoundaries(html, boundaries, status, responseHeaders);
}

/**
 * Stream an HTML response with out-of-order flushed async boundaries.
 *
 * The initial HTML contains placeholder divs (`<div id="__ssr_boundary_X">`)
 * at each boundary site. We emit that HTML as the first chunk, followed by
 * one inline bootstrap script defining `$_swap`. Then — as each boundary's
 * promise resolves — we emit a `<template id="__ssr_chunk_X">{html}</template>`
 * plus a `<script>$_swap('X')</script>` chunk. The client's inline
 * bootstrap moves the template's contents into the placeholder, replacing
 * the pending-state markup with the resolved content.
 *
 * Chunks are emitted in resolution order, not declaration order (out-of-order
 * flush). Browsers handle this correctly because every chunk targets its
 * placeholder by id.
 */
function streamResponseWithBoundaries(initialHtml, boundaries, status, headers) {
	// Find the safest injection point for the bootstrap + chunks. We prefer
	// just before `</body>`; if missing (rare — fragment responses, etc),
	// we append at the very end of the HTML string.
	const closingIdx = findClosingBodyIndex(initialHtml);
	const head = closingIdx >= 0 ? initialHtml.slice(0, closingIdx) : initialHtml;
	const tail = closingIdx >= 0 ? initialHtml.slice(closingIdx) : '';

	const encoder = new TextEncoder();
	const body = new ReadableStream({
		async start(controller) {
			try {
				// 1) Emit initial HTML up to but NOT including </body>
				controller.enqueue(encoder.encode(head));
				// 2) Emit the one-time bootstrap <script>. Safe to always emit
				//    at this position — the helper must be defined before any
				//    chunk script runs.
				controller.enqueue(encoder.encode('\n' + __BOUNDARY_BOOTSTRAP));
				// 3) Fire all boundary resolutions in parallel. As each
				//    settles, enqueue its chunk. Using Promise.all on the
				//    mapped list preserves each boundary's completion in
				//    whatever order it finishes.
				await Promise.all(
					boundaries.map(async (b) => {
						const chunk = await resolveBoundaryToChunk(b);
						controller.enqueue(encoder.encode('\n' + chunk));
					}),
				);
				// 4) Emit the preserved </body></html> tail after all chunks.
				if (tail) controller.enqueue(encoder.encode(tail));
				controller.close();
			} catch (err) {
				// A catastrophic error in the streaming pipeline (not in an
				// individual boundary — those are caught by resolveBoundaryToChunk).
				// Close the stream gracefully; the client sees whatever we've
				// emitted so far, which is better than a hung connection.
				console.error('[koze] Streaming render error:', err);
				try {
					controller.close();
				} catch {
					// Already closed.
				}
			}
		},
	});

	return new Response(body, {
		status: status ?? 200,
		headers,
	});
}

/**
 * Locate the index of the last `</body>` tag in the HTML. Returns -1 if
 * not present (e.g. a fragment response or a misauthored template). The
 * streaming path gracefully falls back to appending chunks at end-of-string
 * in that case.
 */
function findClosingBodyIndex(html) {
	// Case-insensitive match of `</body>` with optional whitespace inside the tag.
	const m = html.match(/<\/body\s*>/i);
	if (!m) return -1;
	return html.lastIndexOf(m[0]);
}

async function handleAction(request, match, params, url) {
	if (!url) url = new URL(request.url);
	const contentType = request.headers.get('content-type') || '';
	let actionName = '';
	let formData = null;
	let spreadArgs = [];
	if (
		contentType.includes('application/x-www-form-urlencoded') ||
		contentType.includes('multipart/form-data')
	) {
		formData = await request.formData();
		actionName = String(formData.get('_action') || '');
		// Button-triggered actions post `_args` as a JSON-encoded
		// array alongside `_action`. Parse it here so handlers receive
		// positional arguments and never have to deserialize by hand.
		// Authored `<form action={fn}>` submissions have no `_args`
		// field, so the array stays empty.
		const argsRaw = formData.get('_args');
		if (argsRaw !== null) {
			try {
				const parsed = JSON.parse(String(argsRaw));
				if (Array.isArray(parsed)) spreadArgs = parsed;
			} catch {
				// Malformed `_args` is a client bug — reject loudly.
				return new Response('Invalid _args JSON', { status: 400 });
			}
		}
	} else {
		actionName = url.searchParams.get('_action') || '';
	}
	const fn = match.module.actions && match.module.actions[actionName];
	if (!fn) {
		return new Response('Unknown action: ' + actionName, { status: 400 });
	}
	const actionMode = request.headers.get('x-koze-action');
	const isStateAugment = actionMode === 'augment';
	const isHtmlAugment = actionMode === 'augment-html';
	try {
		const result = await invokeAction(fn, { spreadArgs, formData, request, url, params });
		// If the action returned a Response, honor it directly. Otherwise
		// Augmented forms can re-render action success state in-place; native
		// forms keep the 303 See Other POST-Redirect-GET fallback.
		if (result instanceof Response) return result;
		if (isStateAugment) {
			const locals = __getLocals();
			const redirectTo = locals && locals.__redirectTo ? locals.__redirectTo : null;
			const redirectStatus = Number(locals && locals.__redirectStatus) || (redirectTo ? 303 : null);
			return new Response(JSON.stringify({
				ok: true,
				action: actionName,
				redirectTo,
				redirectStatus,
				state: { error: undefined, pending: false, success: true },
				result: result ?? null,
			}), {
				status: 200,
				headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
			});
		}
		if (isHtmlAugment) {
			return renderRoute(request, url, match, params, {
				[actionName]: { error: undefined, pending: false, success: true },
			});
		}
		return Response.redirect(url.toString(), 303);
	} catch (err) {
		// `redirect()` from `@kuratchi/koze/runtime/context` throws a
		// `RedirectError` — the framework's declared control-flow
		// mechanism for action handlers. Convert to a real 3xx response.
		// Mirrors `__handleAction` in `@kuratchi/koze/runtime/generated-worker.ts`.
		if (err && err.isRedirectError) {
			const location = err.location || url.pathname;
			const status = Number(err.status) || 303;
			if (isStateAugment) {
				return new Response(JSON.stringify({
					ok: true,
					action: actionName,
					redirectTo: location,
					redirectStatus: status,
					state: { error: undefined, pending: false, success: true },
				}), {
					status: 200,
					headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
				});
			}
			return new Response(null, { status, headers: { location } });
		}

		// Action errors — the route re-renders with `actionName.error`
		// populated so templates can surface the message inline (like the
		// legacy wrangler worker's `__handleAction` did). This is the
		// declared contract in `koze` docs: `actionName.error`
		// is set on `ActionError` throw and cleared on the next render.
		//
		// `ActionError` messages always surface (explicit user-facing
		// errors by definition). Plain Error messages leak only in dev;
		// in prod they collapse to a generic fallback so internal detail
		// never reaches the browser.
		// If the thrown error carries an explicit `status` (e.g. an
		// HttpError-style with 409 / 422 / 404), honor it. Otherwise
		// default to 422 Unprocessable Entity — the standard status for
		// form-validation failures. Plain Error messages are still
		// sanitized in production by `sanitizeErrorMessage`, but the
		// route must re-render instead of falling through to the top-level
		// 500 handler.
		const errStatus = err && typeof err.status === 'number' ? err.status : 0;
		const status = errStatus >= 400 && errStatus < 600 ? errStatus : 422;
		if (status >= 500) console.error('[koze] Action error:', err);
		else console.warn('[koze] Action error:', err);
		const message = status >= 500
			? sanitizeErrorMessage(err, 'Action failed')
			: (err?.message || sanitizeErrorMessage(err, 'Action failed'));
		const overrides = {
			[actionName]: { error: message, pending: false, success: false },
		};
		if (isStateAugment) {
			return new Response(JSON.stringify({
				ok: false,
				action: actionName,
				error: message,
				state: overrides[actionName],
			}), {
				status,
				headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
			});
		}
		return renderRoute(request, url, match, params, overrides, status);
	}
}
