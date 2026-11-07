/** Request context for the Worker dispatcher and server helpers. */

import { __setRequestParams, __setRequestState } from './request.js';

interface RequestContext {
  ctx: any;
  request: Request | null;
  url: URL | null;
  env: Record<string, any> | null;
  locals: Record<string, any>;
}

interface RequestContextStorage {
  getStore(): RequestContext | undefined;
  run<T>(store: RequestContext, callback: () => T): T;
}

let storage: RequestContextStorage | undefined;
let fallback: RequestContext = { ctx: null, request: null, url: null, env: null, locals: {} };

// Packages such as @kuratchi/auth read these accessors at call time.
const sharedContext = {
  get request() { return currentContext().request; },
  get locals() { return __getLocals(); },
};

function currentContext(): RequestContext {
  return storage?.getStore() ?? fallback;
}

export function __installRequestContextStorage(next: RequestContextStorage): void {
  storage = next;
  (globalThis as any).__koze_context__ = sharedContext;
}

export function __runWithRequestContext<T>(
  ctx: any, request: Request, url: URL, env: Record<string, any> | undefined, run: () => T,
): T {
  if (!storage) throw new Error('Koze request context storage is unavailable.');
  return storage.run({ ctx, request, url, env: env ?? null, locals: {} }, run);
}

export function __runWithRouteParams<T>(url: URL, params: Record<string, string>, run: () => T): T {
  if (!storage) throw new Error('Koze request context storage is unavailable.');
  const parent = currentContext();
  // Keep middleware locals and response cookies shared within the request.
  // Each routed operation gets its own params.
  const locals = new Proxy(parent.locals, {
    get(target, key) {
      return key === 'params' ? params : Reflect.get(target, key);
    },
    set(target, key, value) {
      if (key === 'params') {
        params = value;
        return true;
      }
      return Reflect.set(target, key, value);
    },
    has(target, key) {
      return key === 'params' || Reflect.has(target, key);
    },
    ownKeys(target) {
      const keys = Reflect.ownKeys(target);
      if (!keys.includes('params')) keys.push('params');
      return keys;
    },
    getOwnPropertyDescriptor(target, key) {
      return key === 'params'
        ? { configurable: true, enumerable: true, writable: true, value: params }
        : Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  return storage.run({ ...parent, url, locals }, run);
}

export class RedirectError extends Error {
  readonly isRedirectError = true;
  readonly location: string;
  readonly status: number;

  constructor(path: string, status = 303) {
    super(`Redirect to ${path}`);
    this.name = 'RedirectError';
    this.location = path;
    this.status = status;
  }
}

/** Seed request state for standalone runtime callers. */
export function __setRequestContext(ctx: any, request: Request, env?: Record<string, any>): void {
  fallback = { ctx, request, url: new URL(request.url), env: env ?? null, locals: {} };
  __setRequestState(request);
  (globalThis as any).__koze_context__ = sharedContext;
}

export function __getCurrentRequest(): Request | null {
  return currentContext().request;
}

export function __getCurrentUrl(): URL | null {
  return currentContext().url;
}

/** Get the current Worker execution context. */
export function getCtx(): any {
  const { ctx } = currentContext();
  if (!ctx) throw new Error('getCtx() called outside of a request context');
  return ctx;
}

/** Get the current environment bindings */
export function getEnv<T = Record<string, any>>(): T {
  const { env } = currentContext();
  if (!env) throw new Error('getEnv() called outside of a request context');
  return env as T;
}

/** Get request-scoped locals (session, auth, custom data) */
export function getLocals<T = Record<string, any>>(): T {
  return __getLocals() as T;
}

/**
 * Server-side redirect helper for actions/load logic.
 * Throws a redirect signal consumed by the framework's PRG flow.
 */
export function redirect(path: string, status = 303): never {
  const locals = __getLocals();
  locals.__redirectTo = path;
  locals.__redirectStatus = status;
  throw new RedirectError(path, status);
}

/** Set a value on request-scoped locals (used by framework internals) */
export function __setLocal(key: string, value: any): void {
  __getLocals()[key] = value;
  if (key === 'params') __setRequestParams(value);
}

/** Get the full locals object reference (used by framework internals) */
export function __getLocals(): Record<string, any> {
  return currentContext().locals;
}

/** HTML-escape a value for safe output in templates */
export function __esc(v: any): string {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Convert a value to a raw HTML string (unsafe, no escaping). */
export function __rawHtml(v: any): string {
  if (v == null) return '';
  return String(v);
}

/** Best-effort HTML sanitizer for {@html ...} template output. */
export function __sanitizeHtml(v: any): string {
  let html = __rawHtml(v);
  // Remove dangerous elements entirely
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '');
  html = html.replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '');
  html = html.replace(/<embed\b[^>]*>/gi, '');
  html = html.replace(/<base\b[^>]*>/gi, '');
  html = html.replace(/<meta\b[^>]*>/gi, '');
  html = html.replace(/<link\b[^>]*>/gi, '');
  html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, '');
  html = html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
  // Remove all event handlers (on*)
  html = html.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // Remove javascript: URLs in href, src, xlink:href, action, formaction, data
  html = html.replace(/\s(href|src|xlink:href|action|formaction|data)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, ' $1="#"');
  html = html.replace(/\s(href|src|xlink:href|action|formaction|data)\s*=\s*javascript:[^\s>]+/gi, ' $1="#"');
  // Remove vbscript: URLs
  html = html.replace(/\s(href|src|xlink:href|action|formaction|data)\s*=\s*(["'])\s*vbscript:[\s\S]*?\2/gi, ' $1="#"');
  html = html.replace(/\s(href|src|xlink:href|action|formaction|data)\s*=\s*vbscript:[^\s>]+/gi, ' $1="#"');
  // Remove data: URLs in src (can contain scripts)
  html = html.replace(/\ssrc\s*=\s*(["'])\s*data:[\s\S]*?\1/gi, ' src="#"');
  html = html.replace(/\ssrc\s*=\s*data:[^\s>]+/gi, ' src="#"');
  // Remove srcdoc (can contain arbitrary HTML)
  html = html.replace(/\ssrcdoc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // Remove form-related dangerous attributes
  html = html.replace(/\sformaction\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // Remove SVG-specific dangerous elements
  html = html.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, '');
  html = html.replace(/<use\b[^>]*>/gi, '');
  return html;
}




