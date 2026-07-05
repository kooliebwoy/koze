/**
 * Request-scoped context.
 *
 * Env bindings: use `import { env } from 'cloudflare:workers'` directly.
 * Request/ctx/locals: set per-request by the framework, accessed via runtime state.
 *
 * Workers are single-threaded per request â€” module-scoped
 * variables are safe and require no Node.js compat flags.
 */

import { __getDoSelf } from './do.js';
import { __setRequestParams, __setRequestState } from './request.js';

let __ctx: any = null;
let __request: Request | null = null;
let __env: Record<string, any> | null = null;
let __locals: Record<string, any> = {};

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

/** Called by the framework at the start of each request */
export function __setRequestContext(ctx: any, request: Request, env?: Record<string, any>): void {
  __ctx = ctx;
  __request = request;
  __env = env ?? null;
  __locals = {};
  __setRequestState(request);

  // Expose context on globalThis for @kuratchi/auth and other packages
  // Workers are single-threaded per request — this is safe
  (globalThis as any).__koze_context__ = {
    get request() { return __request; },
    get locals() { return __locals; },
  };
}

/**
 * Push a new request context for the duration of a DO RPC call.
 * Saves current state and returns a restore function.
 * @internal
 */
export function __pushRequestContext(rpcContext: any, ctx: any, env: any): () => void {
  const prevCtx = __ctx;
  const prevRequest = __request;
  const prevEnv = __env;
  const prevLocals = __locals;
  __ctx = ctx;
  __request = rpcContext?.request ?? __request;
  __env = env ?? __env;
  __locals = rpcContext?.locals ? { ...rpcContext.locals } : {};
  return () => {
    __ctx = prevCtx;
    __request = prevRequest;
    __env = prevEnv;
    __locals = prevLocals;
  };
}


/** Get the execution context (Worker: ExecutionContext, DO: DurableObjectState) */
export function getCtx(): any {
  const doSelf = __getDoSelf();
  if (doSelf) return doSelf.ctx;
  if (!__ctx) throw new Error('getCtx() called outside of a request context');
  return __ctx;
}

/** Get the current environment bindings */
export function getEnv<T = Record<string, any>>(): T {
  const doSelf = __getDoSelf();
  if (doSelf) return doSelf.env as T;
  if (!__env) throw new Error('getEnv() called outside of a request context');
  return __env as T;
}

/** Get request-scoped locals (session, auth, custom data) */
export function getLocals<T = Record<string, any>>(): T {
  return __locals as T;
}

/**
 * Server-side redirect helper for actions/load logic.
 * Throws a redirect signal consumed by the framework's PRG flow.
 */
export function redirect(path: string, status = 303): never {
  __locals.__redirectTo = path;
  __locals.__redirectStatus = status;
  throw new RedirectError(path, status);
}

/** Set a value on request-scoped locals (used by framework internals) */
export function __setLocal(key: string, value: any): void {
  __locals[key] = value;
  if (key === 'params') __setRequestParams(value);
}

/** Get the full locals object reference (used by framework internals) */
export function __getLocals(): Record<string, any> {
  return __locals;
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




