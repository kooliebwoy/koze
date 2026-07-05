/**
 * Koze Security Module
 *
 * Philosophy: Koze enforces ONLY origin integrity and visibility boundaries.
 * Authentication and authorization are the developer's responsibility — the
 * framework never auto-blocks based on `locals.user`. Guards (`requireAuth`,
 * rate limits, audit logs, etc.) belong in user code or opt-in packages.
 *
 * What this module owns:
 *   - Strict same-origin gate for RPC (reject non-browser + cross-origin)
 *   - Same-origin check for form action POSTs
 *   - Per-request CSP nonce for inline scripts the framework injects
 *   - Default response headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
 *   - Query override allow-list (internal plumbing)
 */

import { __getLocals, __setLocal } from './context.js';

// ── CSP Nonce ──────────────────────────────────────────────────────
//
// The runtime injects a handful of inline <script> tags (workflow poll, client bridge,
// confirm handlers). When the developer configures a Content-Security-Policy that
// includes the literal placeholder `{NONCE}`, the framework generates a random nonce
// per request, stamps it onto every injected <script>, and substitutes it into the CSP
// header. This lets authors ship a strict `script-src 'self' 'nonce-…'` policy without
// having to manually propagate the value.

const CSP_NONCE_BYTES = 16;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Generate and store a per-request CSP nonce. Idempotent: subsequent calls return
 * the same value so every injected inline script shares the same nonce.
 */
export function initCspNonce(): string {
  const locals = __getLocals();
  const existing = locals.__cspNonce as string | undefined;
  if (existing) return existing;
  const bytes = new Uint8Array(CSP_NONCE_BYTES);
  crypto.getRandomValues(bytes);
  const nonce = toBase64Url(bytes);
  __setLocal('__cspNonce', nonce);
  return nonce;
}

/** Read the CSP nonce for the current request (empty string if not initialized). */
export function getCspNonce(): string {
  return (__getLocals().__cspNonce as string | undefined) || '';
}

// ── RPC Security ───────────────────────────────────────────────────

export interface RpcSecurityConfig {
  allowedMethods: ('GET' | 'POST')[];
  /** Enforce strict same-origin on RPC calls (default true). Blocks non-browser clients. */
  requireSameOrigin?: boolean;
}

/**
 * Validate an RPC request meets the framework's origin guarantees.
 * Auth/authorization is the developer's responsibility (in-handler guards).
 */
export function validateRpcRequest(
  request: Request,
  url: URL,
  config: RpcSecurityConfig,
): { valid: boolean; status: number; reason?: string } {
  const method = request.method as 'GET' | 'POST';

  if (!config.allowedMethods.includes(method)) {
    return {
      valid: false,
      status: 405,
      reason: `RPC method ${method} not allowed. Use: ${config.allowedMethods.join(', ')}`,
    };
  }

  // Strict same-origin gate. RPC is browser-only by design: clients must send either
  // Sec-Fetch-Site: same-origin (all modern browsers) or an Origin header matching the
  // request URL origin. Non-browser clients (curl, server-to-server scripts) and any
  // cross-origin browser fetch are rejected outright. Combined with SameSite=Lax on any
  // session cookie an auth library sets, this closes the classic CSRF attack surface
  // without the framework minting its own token.
  if (config.requireSameOrigin !== false) {
    if (!isBrowserSameOrigin(request, url)) {
      return { valid: false, status: 403, reason: 'RPC requires same-origin browser request' };
    }
  }

  return { valid: true, status: 200 };
}

// ── Action Security ────────────────────────────────────────────────

export interface ActionSecurityConfig {
  requireSameOrigin: boolean;
}

/**
 * Validate a form action POST. Accepts same-origin browser requests including
 * top-level form navigations (which may omit `Sec-Fetch-Site` but always include
 * `Origin` on POST). Cross-origin is rejected.
 */
export function validateActionRequest(
  request: Request,
  url: URL,
  config: ActionSecurityConfig,
): { valid: boolean; status: number; reason?: string } {
  if (config.requireSameOrigin && !isSameOrigin(request, url)) {
    return { valid: false, status: 403, reason: 'Cross-origin action requests forbidden' };
  }
  return { valid: true, status: 200 };
}

// ── Security Headers ───────────────────────────────────────────────

export interface SecurityHeadersConfig {
  contentSecurityPolicy?: string | null;
  strictTransportSecurity?: string | null;
  permissionsPolicy?: string | null;
}

const DEFAULT_SEC_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/**
 * Apply security headers to a response. If `contentSecurityPolicy` contains the
 * literal placeholder `{NONCE}`, it is replaced with the per-request nonce.
 */
export function applySecurityHeaders(
  response: Response,
  config?: SecurityHeadersConfig,
): Response {
  for (const [key, value] of Object.entries(DEFAULT_SEC_HEADERS)) {
    if (!response.headers.has(key)) {
      response.headers.set(key, value);
    }
  }

  if (config?.contentSecurityPolicy && !response.headers.has('Content-Security-Policy')) {
    const nonce = getCspNonce();
    const csp = nonce
      ? config.contentSecurityPolicy.replace(/\{NONCE\}/g, nonce)
      : config.contentSecurityPolicy;
    response.headers.set('Content-Security-Policy', csp);
  }

  if (config?.strictTransportSecurity && !response.headers.has('Strict-Transport-Security')) {
    response.headers.set('Strict-Transport-Security', config.strictTransportSecurity);
  }

  if (config?.permissionsPolicy && !response.headers.has('Permissions-Policy')) {
    response.headers.set('Permissions-Policy', config.permissionsPolicy);
  }

  return response;
}

// ── Origin helpers ─────────────────────────────────────────────────

function isSameOrigin(request: Request, url: URL): boolean {
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

/**
 * Strict same-origin gate for RPC. Unlike isSameOrigin (used for form actions, which
 * must accept top-level navigations without Origin/Sec-Fetch-Site), RPC is only reachable
 * from our own client-side code via fetch(), so browsers always attach either
 * Sec-Fetch-Site or an Origin header. Both missing → not a browser → reject.
 */
function isBrowserSameOrigin(request: Request, url: URL): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');
  if (fetchSite === 'same-origin') return true;
  if (origin) {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  }
  return false;
}

// ── Query Override Security ────────────────────────────────────────

/**
 * Validate that a query function is allowed for the current route.
 * The allowedQueries set should contain the function names registered for this route.
 */
export function validateQueryOverride(
  queryFn: string,
  allowedQueries: Set<string> | string[],
): { valid: boolean; reason?: string } {
  const allowed = allowedQueries instanceof Set ? allowedQueries : new Set(allowedQueries);

  if (!queryFn) {
    return { valid: false, reason: 'No query function specified' };
  }

  if (!allowed.has(queryFn)) {
    return { valid: false, reason: `Query function '${queryFn}' not registered for this route` };
  }

  return { valid: true };
}

/**
 * Validate query arguments are safe JSON.
 * Returns parsed arguments or null if invalid.
 */
export function parseQueryArgs(argsRaw: string): { valid: boolean; args: unknown[]; reason?: string } {
  if (!argsRaw || argsRaw === '[]') {
    return { valid: true, args: [] };
  }

  try {
    const parsed = JSON.parse(argsRaw);
    if (!Array.isArray(parsed)) {
      return { valid: false, args: [], reason: 'Query args must be an array' };
    }
    return { valid: true, args: parsed };
  } catch {
    return { valid: false, args: [], reason: 'Invalid JSON in query args' };
  }
}

// ── Dev-mode flag ──────────────────────────────────────────────────
//
// Error sanitizers read this to decide whether to leak internal messages.
// The legacy CLI-built worker sets `globalThis.__koze_DEV__` inside the
// generated entry; the Vite plugin sets the same flag when running under
// `vite dev` (never in `vite build`). Any host can opt in by assigning
// `(globalThis as any).__koze_DEV__ = true` BEFORE handling a request.

export function isDevMode(): boolean {
  return !!(globalThis as Record<string, any>).__koze_DEV__;
}

// ── Error sanitization ─────────────────────────────────────────────
//
// These two helpers are the single source of truth for how framework-level
// error messages reach the client. They mirror `__sanitizeErrorMessage` /
// `__sanitizeErrorDetail` that the legacy CLI generated into every worker,
// so Vite + CLI builds behave identically.
//
// Rules (same in both helpers):
//   1. `ActionError` / `PageError` messages are ALWAYS surfaced. These are
//      intentional, user-facing errors authored by the developer.
//   2. In dev (`isDevMode()`), the raw `err.message` is exposed to make
//      debugging fast.
//   3. In prod, the raw message is swallowed:
//        - `sanitizeErrorMessage` returns the provided `fallback` so RPC /
//          action JSON responses always carry a stable, non-leaky string.
//        - `sanitizeErrorDetail` returns `undefined` so HTML error pages
//          render without the internal detail line at all.
//
// Never bypass these for framework-originated errors. If a user-facing error
// needs a specific message in prod, throw `ActionError` / `PageError`.

export function sanitizeErrorMessage(
  err: unknown,
  fallback: string = 'Internal Server Error'
): string {
  const e = err as { isActionError?: boolean; isPageError?: boolean; message?: string };
  if (e?.isActionError || e?.isPageError) {
    return e.message || fallback;
  }
  if (isDevMode() && e?.message) {
    return e.message;
  }
  return fallback;
}

export function sanitizeErrorDetail(err: unknown): string | undefined {
  const e = err as { isPageError?: boolean; message?: string };
  if (e?.isPageError) {
    return e.message;
  }
  if (isDevMode() && e?.message) {
    return e.message;
  }
  return undefined;
}
