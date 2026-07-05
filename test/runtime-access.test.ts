/**
 * Tests for `koze/access` — Cloudflare Access JWT verification
 * middleware factory.
 *
 * Coverage:
 *   - Missing JWT → 403
 *   - Invalid signature → 403
 *   - Wrong issuer → 403
 *   - Wrong audience → 403
 *   - Expired token → 403
 *   - Valid token → next() runs, locals.access populated
 *   - Excluded paths skip verification
 *   - Pattern matching for `/foo/*` exclusions
 *   - Identity projection (standard claims, idp object/string, custom claims)
 *
 * The JWKS endpoint is mocked at the network level via a fetch
 * intercept that serves a generated key pair. Same key signs the
 * test JWTs; verification round-trips through the real `jose`
 * primitives, so this isn't a useless mock — it actually exercises
 * the cryptographic path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type GenerateKeyPairResult } from 'jose';
import { requireCloudflareAccess } from '../src/runtime/access.js';

const TEAM_DOMAIN = 'kuratchi-test.cloudflareaccess.com';
const ISSUER = `https://${TEAM_DOMAIN}`;
const AUDIENCE = 'test-audience-tag';
const JWKS_URL = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;

// One key pair per file — `createRemoteJWKSet` caches per
// teamDomain at module scope inside `access.ts`, so generating
// a new pair per test would invalidate the cache and force the
// verifier to re-fetch a JWKS that no longer matches earlier
// tokens. Sharing a single pair across all tests keeps cache
// behavior deterministic and exercises the same code path the
// production runtime would (one fetch, many verifications).
let keyPair: GenerateKeyPairResult;
const KID = 'test-key-1';
let jwks: { keys: any[] };

const originalFetch = globalThis.fetch;

// Suite-level setup: generate keys once, install the JWKS fetch
// interceptor, and leave both for all tests in the file.
async function suiteSetup() {
	keyPair = await generateKeyPair('RS256');
	const jwk = await exportJWK(keyPair.publicKey);
	jwk.kid = KID;
	jwk.alg = 'RS256';
	jwks = { keys: [jwk] };

	globalThis.fetch = ((input: any, init?: any) => {
		const url = typeof input === 'string' ? input : input.url;
		if (url === JWKS_URL) {
			return Promise.resolve(
				new Response(JSON.stringify(jwks), {
					headers: { 'content-type': 'application/json' },
				}),
			);
		}
		return originalFetch(input, init);
	}) as typeof fetch;
}

let suiteSetupPromise: Promise<void> | null = null;

beforeEach(async () => {
	if (!suiteSetupPromise) suiteSetupPromise = suiteSetup();
	await suiteSetupPromise;
	(globalThis as any).__koze_context__ = undefined;
});

afterEach(() => {
	// Don't restore fetch between tests — the JWKS cache lives in
	// access.ts module scope and must keep seeing the mock for the
	// rest of the suite. Restored after the file completes via
	// vitest's teardown ordering.
});

async function signToken(claims: Record<string, unknown>, options: {
	issuer?: string;
	audience?: string;
	exp?: number;
	keyOverride?: GenerateKeyPairResult;
} = {}): Promise<string> {
	const key = options.keyOverride ?? keyPair;
	const builder = new SignJWT(claims)
		.setProtectedHeader({ alg: 'RS256', kid: KID })
		.setIssuer(options.issuer ?? ISSUER)
		.setAudience(options.audience ?? AUDIENCE)
		.setIssuedAt();

	if (options.exp !== undefined) {
		builder.setExpirationTime(options.exp);
	} else {
		builder.setExpirationTime('1h');
	}

	return builder.sign(key.privateKey);
}

function buildCtx(overrides: {
	url?: string;
	method?: string;
	headers?: Record<string, string>;
} = {}) {
	const url = overrides.url ?? 'http://example.com/dashboard';
	const headers = new Headers(overrides.headers ?? {});
	const request = new Request(url, { method: overrides.method ?? 'GET', headers });
	const locals: Record<string, any> = {};
	(globalThis as any).__koze_context__ = { request, env: {}, locals };
	return {
		request,
		env: {} as any,
		ctx: {} as any,
		url: new URL(url),
		params: {},
		locals,
	};
}

describe('requireCloudflareAccess', () => {
	describe('configuration validation', () => {
		it('throws when audience is missing', () => {
			expect(() =>
				requireCloudflareAccess({
					audience: '',
					teamDomain: TEAM_DOMAIN,
				}),
			).toThrow(/audience.*required/);
		});

		it('throws when teamDomain is missing', () => {
			expect(() =>
				requireCloudflareAccess({
					audience: AUDIENCE,
					teamDomain: '',
				}),
			).toThrow(/teamDomain.*required/);
		});

		it('throws when teamDomain looks like a URL instead of a hostname', () => {
			expect(() =>
				requireCloudflareAccess({
					audience: AUDIENCE,
					teamDomain: 'https://kuratchi-test.cloudflareaccess.com',
				}),
			).toThrow(/bare hostname/);
		});
	});

	describe('JWT verification', () => {
		it('returns 403 when no JWT header is present', async () => {
			const middleware = requireCloudflareAccess({
				audience: AUDIENCE,
				teamDomain: TEAM_DOMAIN,
			});
			const ctx = buildCtx();
			const res = await middleware.request!(ctx, async () => new Response('ok'));
			expect(res.status).toBe(403);
			expect(await res.text()).toContain('Missing Cloudflare Access JWT');
		});

		it('returns 403 when JWT signature is invalid (signed by different key)', async () => {
			const middleware = requireCloudflareAccess({
				audience: AUDIENCE,
				teamDomain: TEAM_DOMAIN,
			});
			const wrongKey = await generateKeyPair('RS256');
			const token = await signToken(
				{ email: 'attacker@example.com', sub: 'attacker' },
				{ keyOverride: wrongKey },
			);
			const ctx = buildCtx({ headers: { 'cf-access-jwt-assertion': token } });
			const res = await middleware.request!(ctx, async () => new Response('ok'));
			expect(res.status).toBe(403);
		});

		it('returns 403 when issuer does not match teamDomain', async () => {
			const middleware = requireCloudflareAccess({
				audience: AUDIENCE,
				teamDomain: TEAM_DOMAIN,
			});
			const token = await signToken(
				{ email: 'user@example.com', sub: 'user' },
				{ issuer: 'https://different-team.cloudflareaccess.com' },
			);
			const ctx = buildCtx({ headers: { 'cf-access-jwt-assertion': token } });
			const res = await middleware.request!(ctx, async () => new Response('ok'));
			expect(res.status).toBe(403);
		});

		it('returns 403 when audience does not match', async () => {
			const middleware = requireCloudflareAccess({
				audience: AUDIENCE,
				teamDomain: TEAM_DOMAIN,
			});
			const token = await signToken(
				{ email: 'user@example.com', sub: 'user' },
				{ audience: 'wrong-audience' },
			);
			const ctx = buildCtx({ headers: { 'cf-access-jwt-assertion': token } });
			const res = await middleware.request!(ctx, async () => new Response('ok'));
			expect(res.status).toBe(403);
		});

		it('returns 403 when token is expired', async () => {
			const middleware = requireCloudflareAccess({
				audience: AUDIENCE,
				teamDomain: TEAM_DOMAIN,
			});
			const token = await signToken(
				{ email: 'user@example.com', sub: 'user' },
				{ exp: Math.floor(Date.now() / 1000) - 60 },
			);
			const ctx = buildCtx({ headers: { 'cf-access-jwt-assertion': token } });
			const res = await middleware.request!(ctx, async () => new Response('ok'));
			expect(res.status).toBe(403);
		});

		it('passes through and populates locals.access on a valid token', async () => {
			const middleware = requireCloudflareAccess({
				audience: AUDIENCE,
				teamDomain: TEAM_DOMAIN,
			});
			const token = await signToken({
				email: 'alice@example.com',
				sub: 'usr_alice',
				idp: { id: 'idp_1', type: 'azureAD' },
				groups: ['engineers', 'admins'],
				country: 'US',
			});
			const ctx = buildCtx({ headers: { 'cf-access-jwt-assertion': token } });

			let nextRan = false;
			const res = await middleware.request!(ctx, async () => {
				nextRan = true;
				return new Response('ok', { status: 200 });
			});

			expect(nextRan).toBe(true);
			expect(res.status).toBe(200);
			expect(ctx.locals.access).toBeDefined();
			expect(ctx.locals.access.identity.email).toBe('alice@example.com');
			expect(ctx.locals.access.identity.sub).toBe('usr_alice');
			expect(ctx.locals.access.identity.idp).toBe('azureAD');
			expect(ctx.locals.access.identity.groups).toEqual(['engineers', 'admins']);
			expect(ctx.locals.access.identity.country).toBe('US');
		});

		it('exposes raw JWT payload alongside projected identity', async () => {
			const middleware = requireCloudflareAccess({
				audience: AUDIENCE,
				teamDomain: TEAM_DOMAIN,
			});
			const token = await signToken({
				email: 'user@example.com',
				sub: 'usr_1',
				department: 'engineering',
				costCenter: 'CC-1234',
			});
			const ctx = buildCtx({ headers: { 'cf-access-jwt-assertion': token } });
			await middleware.request!(ctx, async () => new Response('ok'));

			expect(ctx.locals.access.jwt.email).toBe('user@example.com');
			expect(ctx.locals.access.jwt.department).toBe('engineering');
			// Custom claims also project onto identity.custom for ergonomic access.
			expect(ctx.locals.access.identity.custom).toEqual({
				department: 'engineering',
				costCenter: 'CC-1234',
			});
		});

		it('handles `idp` claim as a string (some IdPs format it that way)', async () => {
			const middleware = requireCloudflareAccess({
				audience: AUDIENCE,
				teamDomain: TEAM_DOMAIN,
			});
			const token = await signToken({
				email: 'user@example.com',
				sub: 'usr_1',
				idp: 'google',
			});
			const ctx = buildCtx({ headers: { 'cf-access-jwt-assertion': token } });
			await middleware.request!(ctx, async () => new Response('ok'));
			expect(ctx.locals.access.identity.idp).toBe('google');
		});
	});

	describe('exclude patterns', () => {
		it('skips verification on exact-match exclude path', async () => {
			const middleware = requireCloudflareAccess({
				audience: AUDIENCE,
				teamDomain: TEAM_DOMAIN,
				exclude: ['/health'],
			});
			const ctx = buildCtx({ url: 'http://example.com/health' });

			let nextRan = false;
			const res = await middleware.request!(ctx, async () => {
				nextRan = true;
				return new Response('healthy');
			});
			expect(nextRan).toBe(true);
			expect(res.status).toBe(200);
			expect(ctx.locals.access).toBeUndefined();
		});

		it('skips verification on /*-glob exclude pattern', async () => {
			const middleware = requireCloudflareAccess({
				audience: AUDIENCE,
				teamDomain: TEAM_DOMAIN,
				exclude: ['/api/public/*'],
			});

			for (const path of ['/api/public', '/api/public/foo', '/api/public/foo/bar']) {
				const ctx = buildCtx({ url: `http://example.com${path}` });
				let nextRan = false;
				await middleware.request!(ctx, async () => {
					nextRan = true;
					return new Response('ok');
				});
				expect(nextRan, `expected next() on ${path}`).toBe(true);
			}
		});

		it('still requires JWT for paths NOT in exclude', async () => {
			const middleware = requireCloudflareAccess({
				audience: AUDIENCE,
				teamDomain: TEAM_DOMAIN,
				exclude: ['/health', '/api/public/*'],
			});
			const ctx = buildCtx({ url: 'http://example.com/admin' });
			const res = await middleware.request!(ctx, async () => new Response('ok'));
			expect(res.status).toBe(403);
		});

		it('normalizes trailing slashes (matches `/health` and `/health/` to pattern `/health`)', async () => {
			const middleware = requireCloudflareAccess({
				audience: AUDIENCE,
				teamDomain: TEAM_DOMAIN,
				exclude: ['/health'],
			});

			const ctx = buildCtx({ url: 'http://example.com/health/' });
			let nextRan = false;
			await middleware.request!(ctx, async () => {
				nextRan = true;
				return new Response('ok');
			});
			expect(nextRan).toBe(true);
		});
	});
});
