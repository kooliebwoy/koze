/**
 * Public and internal types for the Koze Vite plugin.
 *
 * `KozeViteOptions` is the user-facing config surface. The framework
 * deliberately keeps this small: routes/server/lib directory overrides
 * for non-default project layouts, and response-header security knobs
 * for CSP / HSTS / Permissions-Policy. Everything else (auth, ORM, UI,
 * CSS, migrations) is wired through middleware or the relevant package
 * — the plugin doesn't read a project-level config file.
 *
 * `ResolvedKozeOptions` is the normalized form passed around internally.
 */

export interface KozeSecurityOptions {
	/**
	 * Content Security Policy header value. Use the literal placeholder
	 * `{NONCE}` to opt into per-request nonces — the framework will
	 * substitute it with a fresh nonce on every response and stamp the
	 * same nonce onto every inline `<script>` it injects.
	 *
	 * Example:
	 *   `"script-src 'self' 'nonce-{NONCE}'; object-src 'none'"`
	 */
	contentSecurityPolicy?: string | null;
	/** Strict-Transport-Security header value (e.g. `max-age=63072000; includeSubDomains`). */
	strictTransportSecurity?: string | null;
	/** Permissions-Policy header value. */
	permissionsPolicy?: string | null;
}

export interface KozeViteOptions {
	/** Relative path from the project root to the routes directory. Defaults to `src/routes`. */
	routesDir?: string;
	/** Relative path from the project root to server-only modules. Defaults to `src/server`. */
	serverDir?: string;
	/** Relative path from the project root to browser helpers. Defaults to `src/lib`. */
	libDir?: string;
  /** Response-header security configuration. */
  security?: KozeSecurityOptions;
}

export interface ResolvedKozeOptions {
	routesDir: string;
	serverDir: string;
	libDir: string;
	security: KozeSecurityOptions | undefined;
}

export type { DiscoveredRoute } from '../compiler/project-analysis.js';
