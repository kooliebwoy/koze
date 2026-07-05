/**
 * Cloudflare Access integration — first-class framework primitive.
 *
 * Cloudflare Access is an edge-side identity layer: when a user hits
 * an Access-protected URL, Cloudflare authenticates them against the
 * configured IdP, then injects a signed JWT (`cf-access-jwt-assertion`)
 * + a few headers into the request before forwarding to the origin
 * Worker. Verifying that JWT is what proves the request actually came
 * through Access and wasn't spoofed.
 *
 * Two integration points:
 *
 *   1. `requireCloudflareAccess({ audience, teamDomain, exclude? })`
 *      → a `MiddlewareStep` that verifies the JWT against the team's
 *        JWKS, populates `locals.access` with the verified identity,
 *        and short-circuits with 403 on missing/invalid tokens.
 *
 *   2. `koze:access` virtual module → typed accessors for the
 *      verified identity from inside route handlers / actions / RPC.
 *
 * Verification is strict by default: signature, issuer, audience,
 * and expiry all checked. Apps that need a looser stance (e.g. local
 * dev where Access isn't running) should compose their middleware
 * differently — there's no "trust headers" escape hatch in this
 * factory by design. Loose verification is exactly the kind of toggle
 * that ships incidents.
 *
 * The JWKS endpoint at `https://<teamDomain>/cdn-cgi/access/certs` is
 * fetched lazily and cached by `jose`'s `createRemoteJWKSet` (default:
 * 10 min cache, 30 sec cooldown between misses). Survives Worker
 * isolate restarts because the cache lives in module scope; the first
 * request after a cold start pays the JWKS fetch cost.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MiddlewareStep } from './types.js';
import { __getLocals } from './context.js';

/**
 * Verified Cloudflare Access identity claims. Populated on
 * `locals.access` by `requireCloudflareAccess` after JWT verification
 * succeeds. Routes consume this via the `koze:access` virtual
 * module's `user()` accessor.
 *
 * Standard Access claims documented at
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/application-token/
 */
export interface AccessIdentity {
	/** Authenticated user email — always present for user identities. */
	email: string;
	/** Stable Access user ID (`sub` claim). Persists across email changes. */
	sub: string;
	/** Identity provider key (e.g. `azureAD`, `google`, `onetimepin`). */
	idp?: string;
	/** Group memberships defined in the IdP and surfaced by Access. */
	groups?: string[];
	/** Country code Cloudflare derived from the request. */
	country?: string;
	/** Custom claims set on the Access policy. */
	custom?: Record<string, unknown>;
}

/** Internal shape stored on `locals.access` after verification. */
export interface AccessLocalsState {
	identity: AccessIdentity;
	jwt: Record<string, unknown>;
}

export interface RequireCloudflareAccessOptions {
	/**
	 * Application Audience (AUD) tag from the Access App configuration.
	 * Required — JWT verification fails when the JWT's `aud` claim
	 * doesn't match. Each Access App has its own AUD; one Worker
	 * serving multiple Apps composes multiple middleware steps with
	 * different audiences.
	 */
	audience: string;
	/**
	 * Team domain without scheme — e.g. `mycompany.cloudflareaccess.com`
	 * (NOT `https://...`). The JWKS endpoint is derived from this:
	 * `https://<teamDomain>/cdn-cgi/access/certs`. Issuer claim is
	 * also validated against `https://<teamDomain>`.
	 */
	teamDomain: string;
	/**
	 * Path patterns to skip — useful for `/health`, public APIs, or
	 * webhook endpoints that shouldn't require Access. Patterns
	 * support a trailing `/*` glob; everything else is exact match.
	 */
	exclude?: string[];
}

/**
 * Match a pathname against an `exclude` pattern. `/api/public/*`
 * matches `/api/public/foo` and `/api/public/foo/bar`. Exact match
 * otherwise. Trailing slash is normalized (both `/health` and
 * `/health/` match the pattern `/health`).
 */
function matchExcludePattern(pathname: string, pattern: string): boolean {
	const normalizedPath = pathname.replace(/\/+$/, '') || '/';
	const normalizedPattern = pattern.replace(/\/+$/, '') || '/';

	if (normalizedPattern.endsWith('/*')) {
		const prefix = normalizedPattern.slice(0, -2);
		return normalizedPath === prefix || normalizedPath.startsWith(prefix + '/');
	}

	return normalizedPath === normalizedPattern;
}

/** Cloudflare Access JWT comes via this header on every request. */
const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/**
 * Per-team JWKS cache. `createRemoteJWKSet` returns a function that
 * fetches and caches the team's signing keys; we memoize by
 * `teamDomain` so multiple middleware steps targeting the same team
 * share a single cache.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwksForTeam(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
	let jwks = jwksCache.get(teamDomain);
	if (!jwks) {
		const url = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
		jwks = createRemoteJWKSet(url);
		jwksCache.set(teamDomain, jwks);
	}
	return jwks;
}

/**
 * Project the verified JWT payload onto the public `AccessIdentity`
 * shape. Standard claims are extracted into named fields; everything
 * else flows into `custom` so policies that set bespoke claims (e.g.
 * `department`, `costCenter`) stay reachable without parsing the raw
 * payload.
 */
function projectIdentity(payload: Record<string, unknown>): AccessIdentity {
	const KNOWN_CLAIMS = new Set([
		'email',
		'sub',
		'identity_nonce',
		'iat',
		'exp',
		'iss',
		'aud',
		'nbf',
		'jti',
		'idp',
		'groups',
		'country',
		'common_name',
		'kid',
		'type',
	]);

	const custom: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (!KNOWN_CLAIMS.has(key)) custom[key] = value;
	}

	const idpRaw = payload.idp;
	const idp = idpRaw && typeof idpRaw === 'object' && idpRaw !== null
		? ((idpRaw as Record<string, unknown>).type as string | undefined)
		: typeof idpRaw === 'string'
		? idpRaw
		: undefined;

	return {
		email: typeof payload.email === 'string' ? payload.email : '',
		sub: typeof payload.sub === 'string' ? payload.sub : '',
		idp,
		groups: Array.isArray(payload.groups)
			? (payload.groups as unknown[]).filter((g): g is string => typeof g === 'string')
			: undefined,
		country: typeof payload.country === 'string' ? payload.country : undefined,
		custom: Object.keys(custom).length > 0 ? custom : undefined,
	};
}

/**
 * Build a minimal 403 response. Intentionally bare — apps that want
 * branded forbidden pages should compose a custom error step before
 * `requireCloudflareAccess`, OR catch the response in their
 * downstream `error` middleware step and rewrite. Default keeps the
 * primitive boring, predictable, and dependency-free.
 */
function forbidden(message: string): Response {
	return new Response(`Forbidden: ${message}\n`, {
		status: 403,
		headers: { 'content-type': 'text/plain; charset=utf-8' },
	});
}

/**
 * Middleware factory: returns a `MiddlewareStep` that verifies the
 * Cloudflare Access JWT on every incoming request (subject to the
 * `exclude` filter). Successful verification populates
 * `locals.access` and continues the pipeline; any failure
 * short-circuits with a 403.
 *
 * Usage:
 *
 * ```ts
 * import { defineMiddleware } from '@kuratchi/koze';
 * import { requireCloudflareAccess } from '@kuratchi/koze/access';
 *
 * export default defineMiddleware({
 *   access: requireCloudflareAccess({
 *     audience: env.CF_ACCESS_AUD,
 *     teamDomain: 'mycompany.cloudflareaccess.com',
 *     exclude: ['/health', '/api/public/*'],
 *   }),
 * });
 * ```
 */
export function requireCloudflareAccess(
	options: RequireCloudflareAccessOptions,
): MiddlewareStep {
	if (!options.audience) {
		throw new Error('[koze/access] `audience` is required for requireCloudflareAccess()');
	}
	if (!options.teamDomain) {
		throw new Error('[koze/access] `teamDomain` is required for requireCloudflareAccess()');
	}
	if (options.teamDomain.startsWith('http')) {
		throw new Error(
			'[koze/access] `teamDomain` should be the bare hostname ' +
				'(e.g. `mycompany.cloudflareaccess.com`), not a URL.',
		);
	}

	const issuer = `https://${options.teamDomain}`;
	const jwks = getJwksForTeam(options.teamDomain);
	const exclude = options.exclude ?? [];

	return {
		async request(ctx, next) {
			// `exclude` lets apps carve out unauthenticated paths
			// (health checks, public webhooks). Match against the
			// pathname only — query strings shouldn't influence
			// authentication.
			for (const pattern of exclude) {
				if (matchExcludePattern(ctx.url.pathname, pattern)) {
					return next();
				}
			}

			const token = ctx.request.headers.get(ACCESS_JWT_HEADER);
			if (!token) {
				return forbidden('Missing Cloudflare Access JWT');
			}

			let payload: Record<string, unknown>;
			try {
				const result = await jwtVerify(token, jwks, {
					issuer,
					audience: options.audience,
				});
				payload = result.payload as Record<string, unknown>;
			} catch (err) {
				const message = err instanceof Error ? err.message : 'JWT verification failed';
				return forbidden(message);
			}

			const identity = projectIdentity(payload);
			const state: AccessLocalsState = { identity, jwt: payload };
			ctx.locals.access = state;

			return next();
		},
	};
}

/**
 * Internal accessor for the `koze:access` virtual module. Reads
 * from the per-request locals set by `requireCloudflareAccess`.
 * Throws when called on an unauthenticated request — the API is
 * deliberately not optional here because the typical caller has
 * already gone through middleware that gates on Access.
 */
export function __getAccessState(): AccessLocalsState | null {
	const locals = __getLocals();
	const state = locals?.access as AccessLocalsState | undefined;
	return state ?? null;
}
