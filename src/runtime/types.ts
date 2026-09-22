/**
 * Core framework types
 */

/** Cloudflare Worker env â€" consumers define their own Env type */
export type Env = Record<string, any>;

export type MaybePromise<T> = T | Promise<T>;

/** Route context â€" passed to load functions, actions, and server utilities */
export interface RouteContext<E = Env> {
  /** The incoming Request (standard Web API) */
  request: Request;
  /** Cloudflare Worker env â€" D1, KV, R2, DO, AI, etc. */
  env: E;
  /** Cloudflare execution context */
  ctx: ExecutionContext;
  /** Route parameters (e.g., { slug: 'hello-world' }) */
  params: Record<string, string>;
  /** Request-scoped state (set by middleware, read by load/actions) */
  locals: Record<string, any>;
  /** Parsed URL */
  url: URL;
}

export interface ActionContext<E = Env> extends RouteContext<E> {
  /** Submitted form payload for native and augmented form actions */
  formData: FormData;
}

export type NativeActionHandler<E = Env> = (ctx: ActionContext<E>) => MaybePromise<any>;

export type PositionalActionHandler<E = Env, Args extends any[] = any[]> = (
  ...args: [...Args, ActionContext<E>]
) => MaybePromise<any>;

export type ActionHandler<E = Env> =
  | NativeActionHandler<E>
  | PositionalActionHandler<E>
  | ((...args: any[]) => MaybePromise<any>);

/**
 * Response-header security configuration. Supplied to the Vite plugin
 * (`koze({ security: { ... } })`) options.
 *
 * Koze enforces origin integrity (strict same-origin on RPC, same-origin on actions)
 * and visibility boundaries (`_`-prefix private) unconditionally — those are not
 * configurable because they are the framework's contract with your app. Authentication
 * and authorization are your responsibility: use an auth library (e.g. `@kuratchi/auth`)
 * or inline guards inside your RPC/action handlers.
 *
 * The fields below are the response-header knobs the framework sets for you.
 */
export interface SecurityConfig {
  /**
   * Content Security Policy directive string.
   * Use the literal placeholder `{NONCE}` to opt into per-request nonces — the framework
   * will substitute it with a fresh nonce on every response and stamp the same nonce onto
   * every inline `<script>` it injects. Example:
   *   `"script-src 'self' 'nonce-{NONCE}'; object-src 'none'"`
   */
  contentSecurityPolicy?: string;
  /** Strict-Transport-Security header value */
  strictTransportSecurity?: string;
  /** Permissions-Policy header value */
  permissionsPolicy?: string;
}





/** Middleware pipeline context - shared across middleware step handlers */
export interface MiddlewareContext<E extends Env = Env> {
  request: Request;
  env: E;
  ctx: ExecutionContext;
  url: URL;
  params: Record<string, string>;
  locals: Record<string, any>;
}

export type MiddlewareNext = () => Promise<Response>;

export type MiddlewareErrorResult = Response | null | undefined | void;

export interface MiddlewareStep<E extends Env = Env> {
  request?: (ctx: MiddlewareContext<E>, next: MiddlewareNext) => Promise<Response> | Response;
  route?: (ctx: MiddlewareContext<E>, next: MiddlewareNext) => Promise<Response> | Response;
  response?: (ctx: MiddlewareContext<E>, response: Response) => Promise<Response> | Response;
  error?: (ctx: MiddlewareContext<E>, error: unknown) => Promise<MiddlewareErrorResult> | MiddlewareErrorResult;
}

export type MiddlewareDefinition<E extends Env = Env> = Record<string, MiddlewareStep<E>>;
