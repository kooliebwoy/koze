import { request } from './request.js';

export interface CookieOptions {
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  maxAge?: number;
  expires?: Date;
}

function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const name = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    cookies[name] = value.replace(/^"(.*)"$/, '$1');
  }

  return cookies;
}

function formatCookieOptions(options: CookieOptions = {}): string[] {
  const attrs: string[] = [];
  if (options.path) attrs.push(`Path=${options.path}`);
  if (options.domain) attrs.push(`Domain=${options.domain}`);
  if (options.secure) attrs.push('Secure');
  if (options.httpOnly) attrs.push('HttpOnly');
  if (options.sameSite) attrs.push(`SameSite=${options.sameSite}`);
  if (typeof options.maxAge === 'number') attrs.push(`Max-Age=${options.maxAge}`);
  if (options.expires) attrs.push(`Expires=${options.expires.toUTCString()}`);
  return attrs;
}

function pushSetCookie(header: string): void {
  const requestContext = (globalThis as any).__koze_context__;
  const locals = requestContext?.locals;
  if (!locals.__setCookieHeaders) locals.__setCookieHeaders = [];
  locals.__setCookieHeaders.push(header);
}

function serializeCookie(name: string, value: string, options?: CookieOptions): string {
  return [`${name}=${value}`, ...formatCookieOptions(options)].join('; ');
}

export const cookies = {
  get(name: string): string | undefined {
    return parseCookies(request.headers.get('cookie'))[name];
  },

  getAll(): Record<string, string> {
    return parseCookies(request.headers.get('cookie'));
  },

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(parseCookies(request.headers.get('cookie')), name);
  },

  set(name: string, value: string, options?: CookieOptions): void {
    pushSetCookie(serializeCookie(name, value, options));
  },

  delete(name: string, options?: CookieOptions): void {
    pushSetCookie(serializeCookie(name, '', { ...options, maxAge: 0 }));
  },

  serialize(name: string, value: string, options?: CookieOptions): string {
    return serializeCookie(name, value, options);
  },
};
