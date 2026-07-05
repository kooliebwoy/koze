/**
 * Public and internal types for the Kuratchi Vite plugin.
 *
 * `KuratchiViteOptions` is the user-facing config surface. The framework
 * deliberately keeps this small: routes/server/lib directory overrides
 * for non-default project layouts, and response-header security knobs
 * for CSP / HSTS / Permissions-Policy. Everything else (auth, ORM, UI,
 * CSS, migrations) is wired through middleware or the relevant package
 * — the plugin doesn't read a project-level config file.
 *
 * `ResolvedKuratchiOptions` is the normalized form passed around internally.
 */

export interface KuratchiSecurityOptions {
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

export interface KuratchiApiOptions {
  /** Relative path from the project root to API route files. Defaults to `src/routes/api`. */
  root?: string;
  /** URL prefix mounted for API routes. Defaults to `/api`. */
  urlPrefix?: string;
}

export interface KuratchiApiShieldOptions {
  /** Set false to skip generating _cloudflare/api-shield/openapi.json. */
  enabled?: boolean;
  /** OpenAPI info.title. Defaults to "Koze API". */
  title?: string;
  /** OpenAPI info.version. Defaults to "1.0.0". */
  version?: string;
  /** Output path relative to project root. Defaults to "_cloudflare/api-shield/openapi.json". */
  outputPath?: string;
  /** Optional OpenAPI server URLs. */
  servers?: string[];
  /** Optional API path prefixes to include, such as ['/api/v1']. Defaults to all API routes. */
  include?: string[];
}

export interface KuratchiViteOptions {
	/** Relative path from the project root to the routes directory. Defaults to `src/routes`. */
	routesDir?: string;
	/** API route discovery configuration. */
	api?: KuratchiApiOptions;
	/** Relative path from the project root to server-only modules. Defaults to `src/server`. */
	serverDir?: string;
	/** Relative path from the project root to browser helpers. Defaults to `src/lib`. */
	libDir?: string;
  /** Response-header security configuration. */
  security?: KuratchiSecurityOptions;
  /** Generate an OpenAPI document for Cloudflare API Shield Schema Validation. Defaults to enabled. */
  apiShield?: boolean | KuratchiApiShieldOptions;
}

export interface ResolvedKuratchiOptions {
	routesDir: string;
	api: {
		root: string;
		urlPrefix: string;
	};
	serverDir: string;
	libDir: string;
	security: KuratchiSecurityOptions | undefined;
	apiShield: boolean | KuratchiApiShieldOptions | undefined;
}

/**
 * Intermediate representation of a discovered `.html` route file.
 * The `routesPlugin` produces these; downstream code uses them to generate
 * the virtual `koze:routes` module and the per-route client entries.
 */
export interface DiscoveredRoute {
	/** Absolute path to the `.html` source file. */
	absPath: string;
	/** URL pathname pattern derived from the file path (e.g. `/sandboxes/:name`). */
	urlPattern: string;
	/** Stable id used for virtual module naming and client entry keys. */
	id: string;
	/** Route kind used by the Vite dispatcher. */
	type: 'page' | 'api';
}
