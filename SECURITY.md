# Koze Security Analysis

This document provides a comprehensive security analysis of the Koze framework, identifies current vulnerabilities, and outlines the hardening roadmap for production readiness.

**Audience:** Framework contributors, security reviewers, and application developers who need to understand the framework's security posture.

**Last Updated:** March 2026

---

## Executive Summary

Koze has a solid foundation with several security measures already in place:
- Same-origin validation for form actions
- Default security headers on all responses
- HTML escaping for template interpolation
- Basic HTML sanitization for `{@html}` output

However, several areas require hardening before the framework can be considered production-grade for security-sensitive applications:

| Area | Current State | Risk Level | Priority |
|------|---------------|------------|----------|
| RPC Transport | ✅ CSRF + Auth validation | **Mitigated** | P0 |
| CSRF Protection | ✅ Full token-based protection | **Mitigated** | P0 |
| Action Authentication | ✅ Config-driven auth enforcement | **Mitigated** | P1 |
| Security Headers | ✅ CSP, HSTS, Permissions-Policy | **Mitigated** | P1 |
| HTML Sanitization | ✅ Enhanced XSS protection | **Mitigated** | P2 |
| Fragment Refresh | ✅ Signed fragment IDs | **Mitigated** | P1 |
| Query Override | ✅ Whitelist validation | **Mitigated** | P1 |
| Client Bridge | ✅ Validated handler invocation | **Mitigated** | P2 |
| Error Information Leakage | ✅ Centralized error sanitization | **Mitigated** | P2 |

---

## Current Security Measures

### 1. Response Security Headers

All responses include default security headers via `__secHeaders()`:

```typescript
const __defaultSecHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};
```

**Assessment:** Good baseline, but missing:
- `Content-Security-Policy` (CSP) — should be configurable
- `Strict-Transport-Security` (HSTS) — should be enabled for production
- `Permissions-Policy` — should restrict sensitive APIs

### 2. Same-Origin Validation for Actions

Form POST actions validate same-origin via `__isSameOrigin()`:

```typescript
function __isSameOrigin(request: Request, url: URL): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') {
    return false;
  }
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === url.origin;
  }
}
```

**Assessment:** Reasonable for modern browsers, but:
- Falls back to allowing requests with no `Origin` header (legacy compatibility vs security tradeoff)
- Does not include CSRF token validation
- `sec-fetch-site: none` is allowed (direct navigation, bookmarks) — may be too permissive

### 3. HTML Escaping

Template interpolation uses `__esc()` for safe output:

```typescript
export function __esc(v: any): string {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

**Assessment:** Correct for HTML context. Does not cover:
- JavaScript context (inline scripts)
- URL context (href/src attributes)
- CSS context (style attributes)

### 4. HTML Sanitization

The `{@html}` directive uses `__sanitizeHtml()`:

```typescript
export function __sanitizeHtml(v: any): string {
  let html = __rawHtml(v);
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '');
  html = html.replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '');
  html = html.replace(/<embed\b[^>]*>/gi, '');
  html = html.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = html.replace(/\s(href|src|xlink:href)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, ' $1="#"');
  html = html.replace(/\s(href|src|xlink:href)\s*=\s*javascript:[^\s>]+/gi, ' $1="#"');
  html = html.replace(/\ssrcdoc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  return html;
}
```

**Assessment:** Best-effort regex sanitization. Known limitations:
- Regex-based sanitization is inherently fragile
- Does not handle all XSS vectors (e.g., `<svg onload>`, `<math>`, data URIs)
- Should recommend DOMPurify or similar for user-generated HTML

---

## Critical Vulnerabilities

### 1. RPC Transport Security (CRITICAL)

**Current Implementation:**

```typescript
if (request.headers.get('x-koze-rpc') !== '1') {
  return __secHeaders(new Response(JSON.stringify({ ok: false, error: 'Forbidden' }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  }));
}
```

**Vulnerabilities:**

1. **Header-only validation is trivially bypassable** — Any attacker can set `x-koze-rpc: 1` in their request
2. **No authentication check** — RPC functions execute without verifying user identity
3. **No authorization check** — No verification that the user is allowed to call this specific RPC
4. **Arguments passed via URL** — `_args` query parameter is visible in logs, browser history, and referrer headers
5. **No rate limiting** — RPC endpoints can be hammered without restriction
6. **No request signing** — No way to verify request integrity

**Attack Scenarios:**

```bash
# Attacker can call any RPC function directly
curl "https://app.example.com/dashboard?_rpc=getUserData" \
  -H "x-koze-rpc: 1"

# Arguments are visible and tamperable
curl "https://app.example.com/admin?_rpc=deleteUser&_args=[123]" \
  -H "x-koze-rpc: 1"
```

**Required Mitigations:**

1. **Cryptographic request signing** — Sign RPC requests with a per-session or per-page nonce
2. **Authentication enforcement** — RPC handlers must verify session/user before execution
3. **Authorization layer** — Route-level or function-level permission checks
4. **POST for mutations** — RPC calls that modify state should use POST, not GET
5. **Argument encryption or POST body** — Move sensitive arguments out of URL

### 2. CSRF Protection (HIGH)

**Current State:**

- Same-origin check exists for form actions
- No CSRF token generation or validation
- RPC calls have no CSRF protection

**Vulnerabilities:**

1. **No CSRF tokens** — Attackers can craft forms that submit to action endpoints
2. **GET-based RPC** — All RPC calls use GET, making them vulnerable to CSRF via `<img>` tags
3. **Cookie-based sessions** — If using cookies for auth, CSRF is a real risk

**Required Mitigations:**

1. **Double-submit cookie pattern** — Generate CSRF token, set in cookie and require in form/header
2. **SameSite cookie attribute** — Ensure session cookies use `SameSite=Lax` or `Strict`
3. **Custom header requirement** — Require non-simple headers that trigger CORS preflight

### 3. Fragment Refresh Security (MEDIUM)

**Current Implementation:**

```typescript
const fragmentId = request.headers.get('x-koze-fragment');
// ... later ...
if (fragmentId) {
  const fragment = rendered.fragments?.[fragmentId];
  if (typeof fragment !== 'string') {
    return __secHeaders(new Response('Fragment not found', { status: 404 }));
  }
  return __attachCookies(new Response(fragment, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  }));
}
```

**Vulnerabilities:**

1. **No validation of fragment ID** — Attacker can request arbitrary fragment IDs
2. **Information disclosure** — Fragment responses may leak data if not properly scoped
3. **No authentication** — Fragment requests don't verify user session

**Required Mitigations:**

1. **Fragment ID signing** — Sign fragment IDs with session-specific key
2. **Authentication check** — Verify session before returning fragment content

### 4. Query Override Security (MEDIUM)

**Current Implementation:**

```typescript
const queryFn = request.headers.get('x-koze-query-fn') || '';
const queryArgsRaw = request.headers.get('x-koze-query-args') || '[]';
// ... used to override which query runs during SSR
```

**Vulnerabilities:**

1. **Arbitrary function execution** — Attacker can specify any registered RPC function name
2. **Argument injection** — Arguments are parsed from untrusted header

**Required Mitigations:**

1. **Whitelist validation** — Only allow query functions registered for the current route
2. **Argument validation** — Validate argument types/shapes before execution

---

## Security Hardening Roadmap

### Phase 1: RPC Security (P0) ✅ IMPLEMENTED

**Goal:** Make RPC calls secure against unauthorized access and CSRF.

**Status:** Implemented in `src/runtime/security.ts` and `src/runtime/generated-worker.ts`

**Implementation:**

1. **CSRF Token Validation** ✅
   - CSRF tokens are generated per-session and stored in cookies
   - RPC requests are validated against the CSRF token
   - Timing-safe comparison prevents timing attacks

2. **Authentication Enforcement** ✅
   - `rpcRequireAuth` config option enforces authentication for all RPC calls
   - Returns 401 for unauthenticated requests when enabled

3. **Security Config** ✅
   - Config-driven via `kuratchi.config.ts`
   - Sensible defaults (CSRF enabled, auth optional)

**Configuration:**

```typescript
// kuratchi.config.ts
export default defineConfig({
  security: {
    csrfEnabled: true,              // Enable CSRF protection (default: true)
    csrfCookieName: '__koze_csrf',  // Cookie name for CSRF token
    csrfHeaderName: 'x-koze-csrf',  // Header name for CSRF token
    rpcRequireAuth: false,          // Require auth for RPC (default: false)
  },
});
```

### Phase 2: CSRF Protection (P0) ✅ IMPLEMENTED

**Goal:** Protect all state-changing operations from CSRF attacks.

**Status:** Implemented across compiler and runtime

**Implementation:**

1. **Token Generation** ✅
   - Cryptographically random 32-byte tokens via `crypto.getRandomValues()`
   - Stored in `__koze_csrf` cookie (SameSite=Lax, Secure)
   - Initialized on first request, persisted across requests

2. **Token Validation** ✅
   - Form submissions validated via hidden `_csrf` field
   - Fetch requests validated via `x-koze-csrf` header
   - Timing-safe comparison in `src/runtime/security.ts`

3. **Automatic Injection** ✅
   - Compiler injects `_csrf` hidden field into forms with `action={fn}`
   - Client bridge includes CSRF header in fetch action requests
   - Zero developer configuration required

**Usage:**

```html
<!-- Automatic: compiler injects hidden _csrf field -->
<form action={submitForm}>
  <input type="text" name="email" />
  <button type="submit">Submit</button>
</form>
<!-- Rendered output includes:
  <input type="hidden" name="_action" value="submitForm">
  <input type="hidden" name="_csrf" value="[token]">
-->
```

### Phase 3: Action Authentication (P1) ✅ IMPLEMENTED

**Goal:** Ensure actions verify user identity before execution.

**Status:** Implemented via `actionRequireAuth` config option

**Implementation:**

1. **Global Action Authentication** ✅
   - `actionRequireAuth` config option enforces authentication for all form actions
   - Checks `locals.user` or `locals.session.user` before action execution
   - Returns 401 for unauthenticated requests when enabled

2. **Per-Action Guards** (existing)
   - Use `requireAuth()` from `kyzen` in individual actions
   - Integrates with existing guards system

**Configuration:**

```typescript
// kuratchi.config.ts
export default defineConfig({
  security: {
    actionRequireAuth: true,  // Require auth for all actions (default: false)
  },
});
```

### Phase 4: Content Security Policy (P1) ✅ IMPLEMENTED

**Goal:** Provide configurable security headers including CSP, HSTS, and Permissions-Policy.

**Status:** Implemented via config-driven security headers

**Implementation:**

1. **Config-Driven Headers** ✅
   - `contentSecurityPolicy` - Full CSP directive string
   - `strictTransportSecurity` - HSTS header value
   - `permissionsPolicy` - Permissions-Policy header value

2. **Default Security Headers** ✅
   - `X-Content-Type-Options: nosniff`
   - `X-Frame-Options: DENY`
   - `Referrer-Policy: strict-origin-when-cross-origin`

**Configuration:**

```typescript
// kuratchi.config.ts
export default defineConfig({
  security: {
    contentSecurityPolicy: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    strictTransportSecurity: "max-age=31536000; includeSubDomains",
    permissionsPolicy: "camera=(), microphone=(), geolocation=()",
  },
});
```

### Phase 5: Enhanced Sanitization (P2) ✅ IMPLEMENTED

**Goal:** Improve HTML sanitization for `{@html}` output.

**Status:** Enhanced sanitization in `src/runtime/context.ts`

**Implementation:**

1. **Comprehensive Element Removal** ✅
   - Removes: `<script>`, `<iframe>`, `<object>`, `<embed>`, `<base>`, `<meta>`, `<link>`, `<style>`, `<template>`, `<noscript>`, `<foreignObject>`, `<use>`

2. **Event Handler Removal** ✅
   - Strips all `on*` event attributes

3. **Dangerous URL Sanitization** ✅
   - Neutralizes `javascript:` and `vbscript:` URLs in href, src, action, formaction, data attributes
   - Removes `data:` URLs from src attributes
   - Removes `srcdoc` and `formaction` attributes

**Note:** For user-generated HTML, we strongly recommend using DOMPurify on the client side for maximum security.

### Phase 6: Fragment Refresh Security (P1) ✅ IMPLEMENTED

**Goal:** Prevent attackers from requesting arbitrary fragment IDs to probe for data.

**Status:** Implemented via signed fragment IDs

**Implementation:**

1. **Fragment ID Signing** ✅
   - Fragment IDs are signed at render time with the CSRF token and route path
   - Uses FNV-1a hash for fast, consistent signing
   - Format: `fragmentId:signature`

2. **Server-Side Validation** ✅
   - Validates signature before returning fragment content
   - Returns 403 for invalid or unsigned fragments (when CSRF is enabled)
   - Gracefully allows unsigned fragments when CSRF is disabled (backward compat)

**How it works:**
```html
<!-- Compiler generates signed fragment IDs -->
<div data-poll={getStatus(jobId)} data-interval="2s">
  {status}
</div>
<!-- Rendered: data-poll-id="__poll_abc123:k7x9m2" (signed) -->
```

### Phase 7: Query Override Security (P1) ✅ IMPLEMENTED

**Goal:** Prevent attackers from calling arbitrary query functions via header manipulation.

**Status:** Implemented via whitelist validation

**Implementation:**

1. **Query Whitelist** ✅
   - Each route tracks its allowed query functions in `allowedQueries`
   - Server validates `x-koze-query-fn` against the whitelist
   - Returns 403 for unauthorized query function calls

2. **Argument Validation** ✅
   - Validates query arguments are valid JSON arrays
   - Returns 400 for malformed arguments

**How it works:**
```typescript
// Route emits allowedQueries for validation
{
  pattern: '/dashboard',
  rpc: { getStats: __m1.getStats },
  allowedQueries: ['getStats'],  // Only these can be called via query override
  render(data) { ... }
}
```

### Phase 8: Client Bridge Security (P2) ✅ IMPLEMENTED

**Goal:** Prevent prototype pollution and injection attacks in client-side handler invocation.

**Status:** Implemented via input validation

**Implementation:**

1. **Route ID Validation** ✅
   - Validates route ID format (alphanumeric, underscores, hyphens only)
   - Rejects registration of invalid route IDs

2. **Handler ID Validation** ✅
   - Validates handler ID matches JavaScript identifier rules
   - Blocks prototype pollution attempts (`__proto__`, `constructor`, `prototype`)
   - Uses `hasOwnProperty` check to prevent prototype chain traversal

3. **Input Sanitization** ✅
   - Converts all inputs to strings before use
   - Validates args is an array before passing to handler

### Phase 9: Error Information Leakage (P2) ✅ IMPLEMENTED

**Goal:** Prevent sensitive error details from leaking to clients in production.

**Status:** Implemented via centralized error sanitization

**Implementation:**

1. **Centralized Error Sanitization** ✅
   - `__sanitizeErrorMessage(err, fallback)` - Sanitizes error messages for JSON responses
   - `__sanitizeErrorDetail(err)` - Sanitizes error details for HTML error pages

2. **Safe Error Types** ✅
   - `ActionError` and `PageError` messages are always shown (developer-controlled)
   - Generic errors show full message in dev mode only
   - Production uses generic fallback messages

3. **Consistent Application** ✅
   - RPC errors: "Internal Server Error" in production
   - Action errors: "Internal Server Error" or "Action failed" in production
   - Page errors: No detail shown in production (unless PageError)

**How it works:**
```typescript
// In dev mode: Full error details for debugging
// Error: Database connection failed at line 42

// In production: Generic message to prevent information leakage
// Error: Internal Server Error

// ActionError/PageError: Always shows message (developer-controlled)
throw new ActionError('Invalid email format'); // Always shown
```

---

## Security Best Practices for Application Developers

### 1. Authentication

```typescript
// Always verify authentication in sensitive actions
export async function deleteAccount({ formData }: FormData) {
  const user = await getCurrentUser();
  if (!user) throw new ActionError('Not authenticated');
  
  // Verify ownership
  const accountId = formData.get('accountId');
  if (user.id !== accountId) throw new ActionError('Not authorized');
  
  // ... proceed with deletion
}
```

### 2. Input Validation

```typescript
// Validate and sanitize all inputs
export async function updateProfile({ formData }: FormData) {
  const name = String(formData.get('name') || '').trim();
  const email = String(formData.get('email') || '').trim().toLowerCase();
  
  if (!name || name.length > 100) {
    throw new ActionError('Invalid name');
  }
  
  if (!email || !email.includes('@')) {
    throw new ActionError('Invalid email');
  }
  
  // ... proceed with update
}
```

### 3. SQL Injection Prevention

```typescript
// Use ORM parameterized queries — never string concatenation
const user = await db.users.where({ email }).one();

// NEVER do this:
// const user = await db.execute(`SELECT * FROM users WHERE email = '${email}'`);
```

### 4. Sensitive Data Handling

```typescript
// Never log sensitive data
console.log('User logged in:', user.id); // OK
console.log('User logged in:', user.password); // NEVER

// Never expose sensitive data in error messages
throw new ActionError('Invalid credentials'); // OK
throw new ActionError(`Password ${password} is incorrect`); // NEVER
```

### 5. Rate Limiting

```typescript
// kuratchi.config.ts
export default {
  auth: {
    rateLimit: {
      login: { window: 60, max: 5 },      // 5 attempts per minute
      signup: { window: 3600, max: 10 },  // 10 signups per hour
      api: { window: 60, max: 100 },      // 100 API calls per minute
    },
  },
};
```

---

## Incident Response

### Reporting Security Issues

Security vulnerabilities should be reported privately to the maintainers. Do not open public issues for security vulnerabilities.

### Security Update Process

1. Security patches are developed privately
2. Patches are tested against known attack vectors
3. Advisory is prepared with CVE if applicable
4. Patch is released with coordinated disclosure

---

## Appendix: Security Headers Reference

### Recommended Production Headers

```typescript
const productionSecHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '0',  // Disabled — can cause issues, CSP is better
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
};
```

### Cookie Security Attributes

```typescript
const secureCookieOptions = {
  httpOnly: true,      // Prevent JavaScript access
  secure: true,        // HTTPS only
  sameSite: 'lax',     // CSRF protection
  path: '/',           // Scope to entire site
  maxAge: 86400 * 7,   // 7 days
};
```

---

## Changelog

- **March 2026** — Initial security analysis and roadmap
