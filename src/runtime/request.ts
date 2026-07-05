import { __getLocals } from './context.js';

// Global App namespace for user-defined types
declare global {
  namespace App {
    /** Request-scoped locals set by runtime hooks. Extend in your app.d.ts */
    interface Locals {
      [key: string]: unknown;
    }
  }
}

export let request: Request = new Request('http://localhost/');
export let url: URL = new URL('http://localhost/');
export let pathname = '/';
export let searchParams: URLSearchParams = url.searchParams;
export let headers = new Headers();
export let method = 'GET';
export let params: Record<string, string> = {};
export let slug: string | undefined = undefined;

/** 
 * Direct access to request-scoped locals.
 * Type is inferred from App.Locals declared in your app.d.ts.
 */
export const locals: App.Locals = new Proxy({} as App.Locals, {
  get(_target, prop) {
    return __getLocals()[prop as string];
  },
  set(_target, prop, value) {
    __getLocals()[prop as string] = value;
    return true;
  },
  has(_target, prop) {
    return prop in __getLocals();
  },
  ownKeys() {
    return Reflect.ownKeys(__getLocals());
  },
  getOwnPropertyDescriptor(_target, prop) {
    const locals = __getLocals();
    if (prop in locals) {
      return { configurable: true, enumerable: true, value: locals[prop as string] };
    }
    return undefined;
  },
});

function __syncDerivedState(): void {
  pathname = url.pathname;
  searchParams = url.searchParams;
  slug = params.slug ?? Object.values(params)[0];
}

export function __setRequestState(nextRequest: Request): void {
  request = nextRequest;
  url = new URL(nextRequest.url);
  headers = nextRequest.headers;
  method = nextRequest.method;
  params = {};
  __syncDerivedState();
}

export function __setRequestParams(nextParams: Record<string, string> | null | undefined): void {
  params = nextParams ?? {};
  __syncDerivedState();
}
