/**
 * `koze:access` — typed accessors for the Cloudflare Access
 * verified identity in the current request.
 *
 * The actual verification happens upstream in
 * `requireCloudflareAccess()` middleware (see `./access.ts`); this
 * module is the read-side surface route handlers / actions / RPCs
 * import to get at the identity.
 *
 * `user()` and `jwt()` THROW when called on an unverified request,
 * because the typical caller is downstream of `requireCloudflareAccess`
 * and a missing identity there is a programmer error (forgot to wire
 * the middleware, or composed it AFTER the route ran). Apps that want
 * to gracefully handle the unauthenticated case should branch on
 * `isAuthenticated()` first.
 *
 * Usage:
 *
 * ```html
 * <script>
 *   import { user, isAuthenticated } from 'koze:access';
 *   if (!isAuthenticated()) throw new ActionError('Forbidden', 403);
 *   const me = user();
 * </script>
 * <p>Welcome, {me.email}!</p>
 * ```
 */

import { __getAccessState, type AccessIdentity } from './access.js';

export type { AccessIdentity };

/**
 * Returns the verified identity for the current request. Throws when
 * called on an unauthenticated request — guard with
 * `isAuthenticated()` first if your route can serve both states.
 */
export function user(): AccessIdentity {
	const state = __getAccessState();
	if (!state) {
		throw new Error(
			'[koze/access] `user()` called outside an authenticated request. ' +
				'Wire `requireCloudflareAccess()` middleware before this route, ' +
				'or guard with `isAuthenticated()`.',
		);
	}
	return state.identity;
}

/**
 * Returns the raw verified JWT payload — escape hatch for unusual
 * claims that aren't on the standard `AccessIdentity` projection.
 * Same throw semantics as `user()`.
 */
export function jwt(): Record<string, unknown> {
	const state = __getAccessState();
	if (!state) {
		throw new Error(
			'[koze/access] `jwt()` called outside an authenticated request. ' +
				'Wire `requireCloudflareAccess()` middleware before this route, ' +
				'or guard with `isAuthenticated()`.',
		);
	}
	return state.jwt;
}

/**
 * True when the current request has a verified Access identity. Use
 * this to branch in routes that conditionally show authenticated
 * content (e.g. an admin link in a header) without the throw of
 * `user()` / `jwt()`.
 */
export function isAuthenticated(): boolean {
	return __getAccessState() !== null;
}
