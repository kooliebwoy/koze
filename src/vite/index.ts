/**
 * koze/vite — Vite plugin for Koze
 *
 * Route files use the `.koze` extension. The files are HTML-shaped but
 * contain native JS control flow (`if () {}`, `for () {}`), `{expression}`
 * interpolation, attribute binding, and `$server/*` RPC imports — none of
 * which are valid HTML. The dedicated extension lets Vite / Rollup / Prettier
 * / editors / agents route through the right handler without fighting
 * HTML-tooling assumptions.
 *
 * The plugin consumes the single `koze/compiler` boundary and adds
 * Vite-specific orchestration: route discovery, virtual `koze:routes` module,
 * leading-script browser fragments, and `$lib`/`$server` resolve aliases.
 */

import type { Plugin } from 'vite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// Compiler primitives are siblings within the same package now
// (koze consolidated the Vite plugin into itself). The relative
// path keeps the import graph internal — no self-reference through the
// package's `exports` map, which would create a build-order paradox
// when this file is being compiled before `dist/compiler/index.js`
// exists.
import { createKozeCompiler } from '../compiler/index.js';
import type { ClientFragment, ComponentCompiler } from '../compiler/index.js';
import { createPreparedRouter } from '../runtime/router.js';
import type {
	DiscoveredRoute,
	KozeViteOptions,
	ResolvedKozeOptions,
} from './types.js';

const {
	application: {
		CLIENT_BRIDGE_HASH,
		DEFAULT_APP_SHELL,
		NESTED_LAYOUT_VIRTUAL_PREFIX,
		extractClientFragments,
		generateContentModule,
		generateRpcMapModule,
		generateRpcStubModule,
		generateWorkerModule,
		layoutModuleHash,
		routeModuleHash,
		resolveServerFile,
		transformAppFile,
		transformLayoutFile,
		transformRouteFile,
	},
	language: {
		buildBridgeScriptSource,
		isKozeVirtualModule,
		resolveKozeVirtualModule,
	},
	project: {
		analyzeProject,
		createComponentCompiler,
		isApiRouteFile,
		isPageRouteFile,
		isRouteFile,
		isRouteLayoutFile,
		layoutChainForRoute,
		writeAppTypes,
	},
} = createKozeCompiler();

/**
 * Resolve a `@kuratchi/koze/runtime/<name>.js` virtual specifier to a
 * concrete filesystem path.
 *
 * Now that the Vite plugin lives inside `koze` itself, the
 * runtime files are siblings of this module under `dist/runtime/<name>.js`
 * (this file ends up at `dist/vite/index.js`). Resolution against
 * `import.meta.url` is enough — no `createRequire`, no package.json
 * lookup, no transitive dependency assumptions about how the host app
 * installed us.
 */
let cachedKuratchiDistDir: string | null = null;
const kuratchiViteRequire = createRequire(import.meta.url);
function getKuratchiDistDir(): string {
	if (cachedKuratchiDistDir) return cachedKuratchiDistDir;
	// `import.meta.url` → file:///abs/path/to/dist/vite/index.js
	// `..` lands at the package's `dist/` directory which is where
	// the runtime files live (e.g. `dist/runtime/request.js`).
	// IMPORTANT (Windows): `URL.pathname` yields `/C:/...` which produces an
	// invalid path when fed to `path.normalize`. Convert through
	// `fileURLToPath` so we always get a real filesystem path.
	const herePath = fileURLToPath(import.meta.url);
	cachedKuratchiDistDir = path.dirname(path.dirname(herePath));
	return cachedKuratchiDistDir;
}
/**
 * Read the dispatch runtime source from disk. Kept as a sibling file
 * (`runtime/dispatch.js`) rather than a template literal so comments,
 * regex literals, and `${…}` inside the source don't need exotic
 * escaping. Cached after the first read for speed.
 *
 * During dev + prod the file is co-located with the plugin's compiled
 * `dist/index.js`. We resolve against `import.meta.url` so the lookup
 * works regardless of how the plugin was installed (workspace link
 * vs. node_modules).
 *
 * `dispatch.js` imports `./invoke-action.js` so the action-dispatch
 * calling convention can be unit-tested in isolation (Bun can't resolve
 * the virtual `koze:routes` / `koze:middleware` modules that
 * the rest of `dispatch.js` transitively pulls in, but a pure helper
 * in its own file is testable directly). Rollup can't resolve that
 * relative import when the dispatcher is injected as a virtual module,
 * so we inline the helper's body here at plugin-load time.
 */
let cachedDispatchSource: string | null = null;
function loadDispatchSource(): string {
	if (cachedDispatchSource !== null) return cachedDispatchSource;
	const dispatchPath = new URL('./runtime/dispatch.js', import.meta.url);
	const invokeActionPath = new URL('./runtime/invoke-action.js', import.meta.url);
	const dispatchSrc = fs.readFileSync(dispatchPath, 'utf-8');
	const invokeActionSrc = fs.readFileSync(invokeActionPath, 'utf-8');
	// Drop the import line and inline the helper's source in its place.
	// Exact-match replacement — if anyone ever changes the spec or the
	// line shape in dispatch.js they'll notice immediately because this
	// throws instead of silently producing a broken bundle.
	const importLineRe = /^import\s+\{\s*invokeAction\s*\}\s+from\s+'\.\/invoke-action\.js';\s*$/m;
	if (!importLineRe.test(dispatchSrc)) {
		throw new Error(
			"[koze/vite] dispatch.js no longer contains the expected `import { invokeAction } from './invoke-action.js'` line. " +
			"Update the inlining pattern in `loadDispatchSource()` to match.",
		);
	}
	// Strip `export` keywords from the helper source because they're
	// meaningless (and disallowed) inside a top-level module body that
	// already has its own exports. `invokeAction` just becomes a local
	// binding visible to the rest of dispatch.js.
	const invokeActionBody = invokeActionSrc.replace(/^export\s+/gm, '');
	cachedDispatchSource = dispatchSrc.replace(
		importLineRe,
		'// --- inlined from ./invoke-action.js (see `loadDispatchSource` in koze/vite/src/index.ts) ---\n' +
		invokeActionBody +
		'// --- end inlined invoke-action.js ---\n',
	);
	return cachedDispatchSource;
}

function resolveKuratchiRuntimeFile(runtimeSpec: string): string {
	// runtimeSpec looks like '@kuratchi/koze/runtime/request.js' —
	// strip the package name and map to the dist dir.
	const pkgPrefix = '@kuratchi/koze/';
	if (!runtimeSpec.startsWith(pkgPrefix)) return runtimeSpec;
	const subpath = runtimeSpec.slice(pkgPrefix.length);
	try {
		return path.join(getKuratchiDistDir(), subpath);
	} catch {
		return runtimeSpec;
	}
}

export type { KozeViteOptions } from './types.js';

/**
 * Fallback expressions for each safe `koze:request` export. The parser
 * only allows this subset through (see `KURATCHI_REQUEST_SAFE_EXPORTS` in
 * `koze/compiler/parser.ts`), so we keep the table in lock-step:
 * if a new safe export is added there, it needs a matching fallback here.
 * The dispatcher populates matching fields on `data` per-request; the
 * fallback only fires if something bypasses the dispatcher (e.g. a direct
 * `render({})` call in tests).
 */
const VIRTUAL_ROUTES_ID = 'koze:routes';
const RESOLVED_VIRTUAL_ROUTES_ID = '\0' + VIRTUAL_ROUTES_ID;
const VIRTUAL_ROUTE_PREFIX = 'koze:route/';

/**
 * `koze:layout` — a single synthesized module that exports the
 * root-layout `render(data, __content)` function. Emitted only when a
 * `routes/layout.koze` (or `layout.html`) file exists at the root of
 * the routes dir. Each route's compiled render wraps its HTML output in
 * a layout-render call when this module is available.
 *
 * Keeping the layout in its own virtual module (not inlined per-route)
 * means the layout source + any `$server/*` it imports are evaluated
 * once per request at the layout level, not redundantly per route.
 */
const VIRTUAL_LAYOUT_ID = 'koze:layout';
const RESOLVED_VIRTUAL_LAYOUT_ID = '\0' + VIRTUAL_LAYOUT_ID;

/**
 * Per-layout virtual module prefix for nested layouts.
 *
 * Every discovered `layout.koze` under `routes/` gets its own
 * virtual module at `koze:layout/<hash>` where `<hash>` is a
 * stable digest of the layout file's absolute path. Routes import
 * the full chain of layouts that wrap them and compose them at
 * render time.
 *
 * `koze:layout` maps to `routes/layout.koze` (the root).
 * Subdirectory layouts use the nested id.
 */
/**
 * Stable 10-char hash derived from a layout file's absolute path.
 * Used to form the nested-layout virtual id and the local binding
 * name routes use to reference the layout module. Keyed on path
 * (not content) so cache-busting happens naturally when Vite rebuilds
 * the layout module and routes pick up the new output without the
 * route module's content hash changing.
 */
/**
 * `koze:app` — the document shell (doctype + <html> + <head> + <body>).
 *
 * Synthesized from `src/routes/app.koze` when present; otherwise
 * falls back to a minimal default shell. The app shell's single
 * `<slot></slot>` is where the layout+page stream is inserted.
 *
 * This separates two previously conflated concerns:
 *   - `app.koze` owns the document frame (head, meta, framework
 *     head/body injections, CSP nonce, per-request html attrs).
 *   - `layout.koze` is a fragment — just another route file with
 *     a top <script>, template, and a <slot></slot> for the page.
 *
 * A layout containing a document shell is rejected; document markup
 * belongs in `app.koze`.
 */
const VIRTUAL_APP_ID = 'koze:app';
const RESOLVED_VIRTUAL_APP_ID = '\0' + VIRTUAL_APP_ID;

/**
 * `koze:worker` exposes Koze's HTTP request handler. The application owns
 * its Worker default export, named class exports, and non-fetch handlers.
 */
const VIRTUAL_WORKER_ID = 'koze:worker';
const RESOLVED_VIRTUAL_WORKER_ID = '\0' + VIRTUAL_WORKER_ID;

/**
 * Internal middleware entry module — resolves to `src/middleware.ts` if it exists,
 * or an empty stub otherwise. One canonical location — matches Next.js
 * and SvelteKit conventions, visible at a glance, implicitly server-only
 * (there's no client-side middleware concept).
 *
 * The user default-exports a `MiddlewareDefinition` (map of step names →
 * `{ request, route, response, error }` phase handlers). The dispatcher
 * walks it per request phase.
 */
const VIRTUAL_MIDDLEWARE_ID = 'virtual:koze-middleware-entry';
const RESOLVED_VIRTUAL_MIDDLEWARE_ID = '\0' + VIRTUAL_MIDDLEWARE_ID;
const MIDDLEWARE_FILE = 'src/middleware.ts';

/**
 * Prefix for per-route client-script virtual modules. Template-body
 * `<script>` blocks with imports get extracted, keyed by a content hash,
 * and served from these IDs. The `<script>` tag the browser loads is
 * `<script type="module" src="/@id/virtual:koze-client/<hash>.ts">`.
 *
 * No null-byte prefix: the browser fetches these over HTTP, so the ID
 * must be URL-safe. Vite's dev server routes `/@id/<id>` through the
 * plugin pipeline regardless of prefix.
 */
const CLIENT_VIRTUAL_PREFIX = 'virtual:koze-client/';

/**
 * Stable fragment hash for the shared client-event bridge. The bridge
 * source is a single framework-owned string and doesn't vary per route,
 * so a fixed identifier is fine — Vite hashes the compiled asset
 * filename when the content changes, which is what actually drives
 * browser cache busting. The `bridge` prefix makes the fragment easy
 * to spot in bundle listings: `koze-client-bridge.<vite-hash>.js`.
 */
/**
 * Client-env stub prefix. When the browser-bound build sees an import of
 * `$server/<path>`, `resolveId` rewrites it to
 * `virtual:koze-rpc/<path>.ts` (this prefix + relative `<path>`). The
 * corresponding `load` emits one Cap'n Web-backed channel stub per exported
 * identifier in the referenced server module, so the real server module never
 * enters the client bundle.
 */
const RPC_VIRTUAL_PREFIX = 'virtual:koze-rpc/';

/**
 * `koze:rpc-map` — SSR-only virtual module that statically imports
 * every `$server/<subpath>` the client env has referenced, and exposes
 * them by subpath. The dispatcher uses this at request time so we never
 * need a dynamic `import()` with a runtime-computed specifier.
 */
const VIRTUAL_RPC_MAP_ID = 'koze:rpc-map';
const RESOLVED_VIRTUAL_RPC_MAP_ID = '\0' + VIRTUAL_RPC_MAP_ID;

/**
 * `koze:manifest` — imported by compiled route modules to resolve the
 * browser-visible URL for a client fragment. Separated from the fragments
 * themselves so the URL policy can differ per environment:
 *
 *   - dev: returns `/@id/<virtual-id>`; Vite's dev server transforms + serves
 *   - prod: reads `dist/client/.vite/manifest.json` (written by the client
 *     Rollup build that runs *before* the SSR build) and returns the hashed
 *     asset path
 */
const VIRTUAL_MANIFEST_ID = 'koze:manifest';
const RESOLVED_VIRTUAL_MANIFEST_ID = '\0' + VIRTUAL_MANIFEST_ID;

/**
 * `koze:dispatch` — high-level request handler the user's Worker
 * delegates to. Matches routes, renders on GET, dispatches server actions
 * (POST with `_action` form field) with a POST-Redirect-GET response.
 *
 * Exposing this as a virtual module — rather than a published helper in
 * `koze/vite` — means the generated code has direct access to the
 * `koze:routes` module graph (pattern matching + `actions` export
 * per route). The user's `src/worker.ts` becomes three lines.
 */
const VIRTUAL_DISPATCH_ID = 'koze:dispatch';
const RESOLVED_VIRTUAL_DISPATCH_ID = '\0' + VIRTUAL_DISPATCH_ID;

/**
 * `koze:security` — exports the response-header security config
 * supplied via `koze({ security: { ... } })`. Imported by the
 * dispatch runtime to stamp CSP / HSTS / Permissions-Policy onto every
 * response. Empty when no security options are provided (defaults to
 * `null` for every field).
 */
const VIRTUAL_SECURITY_ID = 'koze:security';
const RESOLVED_VIRTUAL_SECURITY_ID = '\0' + VIRTUAL_SECURITY_ID;

/**
 * `koze:content` — generated from Markdown files under
 * named folders in `src/content`. The public module exports a single
 * `content` object whose direct properties mirror the folder names.
 */
const VIRTUAL_CONTENT_ID = 'koze:content';
const RESOLVED_VIRTUAL_CONTENT_ID = '\0' + VIRTUAL_CONTENT_ID;

/**
 * Convention filename for the project's global stylesheet. When a file
 * exists at this path, `koze/vite` registers it as a client Rollup
 * input so Vite's plugin pipeline processes it (Tailwind, PostCSS,
 * CSS Modules, etc.), emits a hashed `.css` asset in prod, and
 * auto-injects a `<link rel="stylesheet">` into the app shell's
 * `<head>` at compile time.
 *
 * Zero-config: drop `src/app.css` in the project, `@import "tailwindcss";`
 * (or whatever), and every page ships with it linked. Mirrors
 * SvelteKit's `src/app.css`, Next.js's `app/globals.css`, and Astro's
 * `src/styles/global.css` conventions.
 *
 * Static assets are a separate application/Cloudflare concern configured
 * explicitly by the app.
 */
const GLOBAL_CSS_FILE = 'src/app.css';
const GLOBAL_CSS_VIRTUAL_ID = 'virtual:koze-global-css.js';
/** Rollup-input / manifest key for the global-CSS shim. */
const GLOBAL_CSS_ENTRY_NAME = 'koze-global-css';

/**
 * Virtual stylesheet that bundles framework-level global CSS — rules every
 * Koze app should get regardless of whether it ships its own app.css.
 * Currently just the default cross-document view-transition rule; additions
 * here should be conservative and unopinionated (no colors, no resets).
 * The shim at `GLOBAL_CSS_VIRTUAL_ID` imports this *before* the user's
 * app.css so user rules always win via source order.
 */
const FRAMEWORK_CSS_VIRTUAL_ID = 'virtual:koze-framework-css.css';
const FRAMEWORK_CSS_SOURCE = `@view-transition { navigation: auto; }\n`;

export function koze(options: KozeViteOptions = {}): Plugin[] {
	const resolved: ResolvedKozeOptions = {
		routesDir: options.routesDir ?? 'src/routes',
		serverDir: options.serverDir ?? 'src/server',
		libDir: options.libDir ?? 'src/lib',
		security: options.security,
	};

	return [routesPlugin(resolved)];
}

function tryResolveFromProject(root: string, specifier: string): string | null {
	try {
		return kuratchiViteRequire.resolve(specifier, { paths: [root] });
	} catch {
		return null;
	}
}

function routesPlugin(options: ResolvedKozeOptions): Plugin {
	let projectRoot = process.cwd();
	let routes: DiscoveredRoute[] = [];
	let isProduction = false;
	/**
	 * Absolute path to the root layout file (`routes/layout.koze` or
	 * `routes/layout.html`), or `null` if none exists. Routes only wrap
	 * their output in a layout render when this is set.
	 */
	let rootLayoutPath: string | null = null;
	/**
	 * Every `layout.koze` found at any depth under `routes/`.
	 * Populated in `configResolved`. Each layout is served through a
	 * virtual module keyed by a stable hash of its absolute path;
	 * routes import the chain of layouts that wrap them in
	 * outermost-first order and compose them innermost-first at
	 * render time. See `layoutChainForRoute` + the route emission code.
	 */
	let allLayoutPaths: string[] = [];
	/**
	 * Absolute path to the document shell (`routes/app.koze`), or
	 * `null` when the app doesn't ship one — in which case the
	 * framework synthesizes a minimal default shell at render time.
	 */
	let rootAppPath: string | null = null;
	/**
	 * Every `$server/<subpath>` specifier that the client env has ever
	 * resolved. The generated `koze:rpc-map` module gives each one a
	 * literal dynamic-import loader so Vite can split it safely while
	 * the dispatcher loads only the module requested by the client.
	 */
	const rpcReferencedModules = new Set<string>();
	const clientFragments = new Map<string, ClientFragment>();
	/**
	 * Whether `src/app.css` exists. Set in `configResolved`; drives
	 * both the client-Rollup-input registration and the `<link>`
	 * injection in `transformAppFile`.
	 */
	let hasGlobalCss = false;
	const checkHasGlobalCss = (): boolean => {
		hasGlobalCss = projectRoot ? fs.existsSync(path.resolve(projectRoot, GLOBAL_CSS_FILE)) : false;
		return hasGlobalCss;
	};
	/**
	 * Per-plugin component compiler. Created lazily in `configResolved`
	 * once `projectRoot` is known. Caches compiled component bodies and
	 * scoped CSS across every route + layout in the build, so a
	 * component referenced by ten routes gets compiled once. Delegates
	 * all `.koze` parsing and codegen to `koze/compiler` —
	 * the plugin only orchestrates Vite-side concerns (watch files,
	 * virtual module wiring, build graph).
	 */
	let componentCompiler: ComponentCompiler | null = null;
	/**
	 * Reverse index from component absolute path → set of importer
	 * absolute paths (routes, layouts) that include the component in
	 * their compiled output.
	 *
	 * Populated incrementally on every `transformRouteFile` /
	 * `transformLayoutFile` call. The Vite `load` hook calls
	 * `addWatchFile` for each resolved component, but Vite's module
	 * graph doesn't automatically know which virtual modules need
	 * re-emission when the component edits — they're synthetic IDs,
	 * not first-class graph nodes from Vite's POV. This tracker is
	 * the bridge: on a component file edit, `handleHotUpdate` looks up
	 * every importer here and invalidates each one's virtual module so
	 * the next request re-runs the transform with the updated component.
	 */
	const componentImporters = new Map<string, Set<string>>();
	/**
	 * Reverse index from layout absolute path → set of route absolute
	 * paths whose layout chain includes this layout.
	 *
	 * Populated in `configResolved` (every layout's chain is fixed by
	 * the directory tree, so we compute it once at startup). Used by
	 * `handleHotUpdate` to invalidate every dependent route when the
	 * layout source changes.
	 */
	const layoutDependents = new Map<string, Set<string>>();
	const refreshProjectAnalysis = (): void => {
		const analysis = analyzeProject({
			projectRoot,
			routesDir: options.routesDir,
		});
		routes = analysis.routes;
		rootLayoutPath = analysis.rootLayoutPath;
		rootAppPath = analysis.rootAppPath;
		allLayoutPaths = analysis.allLayoutPaths;
		layoutDependents.clear();
		const routesAbsDirForChain = path.resolve(projectRoot, options.routesDir);
		for (const route of routes) {
			for (const layoutPath of layoutChainForRoute(route.absPath, allLayoutPaths, routesAbsDirForChain)) {
				let dependents = layoutDependents.get(layoutPath);
				if (!dependents) {
					dependents = new Set();
					layoutDependents.set(layoutPath, dependents);
				}
				dependents.add(route.absPath);
			}
		}
	};

	return {
		name: 'koze:routes',
		enforce: 'pre',

		config(userConfig, configEnv) {
			// `$lib` and `$server` are Koze's author-facing path aliases.
			// Registering them via Vite's resolver means the leading browser
			// fragment and Worker-side modules can just `import x from '$lib/y'`
			// and have Vite resolve it. No custom rewrite pass needed.
			const root = (userConfig.root ? path.resolve(userConfig.root) : process.cwd());
			// Initial type stub so editor tooling has SOMETHING to
			// resolve `koze:*` virtual modules against before the
			// full `writeAppTypes` runs in `configResolved`. The full
			// pass needs project content + schema parsing, both of which
			// require the resolved `projectRoot`
			// from `configResolved`. The minimal stub here covers the
			// editor LSP cold-start case where the user just opened
			// the project and Vite hasn't reached `configResolved` yet.
			writeAppTypes({ projectDir: root });
			// `koze:environment` exposes a `dev` flag that reads
			// `globalThis.__koze_DEV__`. Vite substitutes this at build time so
			// `if (dev) { ... }` compiles to a literal. `command` is
			// 'serve' during `vite dev` and 'build` during `vite build`.
			const isDev = configEnv.command !== 'build';
			const dedupePackages = [
				'koze',
				'@kuratchi/js',
				'@kuratchi/orm',
				'@kuratchi/auth',
				'kunii',
				'kyzen',
				'kuzan',
			];
			const sharedAliases = dedupePackages
				.map((pkg) => {
					const replacement = tryResolveFromProject(root, pkg);
					return replacement
						? { find: pkg, replacement }
						: null;
				})
				.filter((entry): entry is { find: string; replacement: string } => entry !== null);
			return {
				define: {
					'globalThis.__koze_DEV__': JSON.stringify(isDev),
				},
				resolve: {
					dedupe: dedupePackages,
					alias: [
						...sharedAliases,
						{
							find: /^\$lib\/(.*)/,
							replacement: path.resolve(root, options.libDir) + '/$1',
						},
						// `$server/*` is NOT registered as a resolve.alias
						// because alias rewriting runs BEFORE plugin
						// `resolveId` hooks. For RPC to work, we need
						// env-aware resolution (client = RPC stub, ssr =
						// real file) — handled in `resolveId` below.
					],
				},
				// Emit a Vite manifest for the client env. In prod we read
				// this to rewrite `/@id/virtual:...` dev URLs to the hashed
				// asset paths Rollup generated.
				environments: {
					client: {
						build: {
							manifest: true,
						},
					},
					ssr: {
						resolve: {
							dedupe: dedupePackages,
						},
						ssr: {
							noExternal: true,
						},
						optimizeDeps: {
							noDiscovery: true,
							include: [],
						},
					},
				},
			};
		},

		async configResolved(config) {
			projectRoot = config.root;
			isProduction = config.command === 'build';
			// Component compiler is shared across every route + layout
			// transform, so a `<Card>` imported by ten routes resolves
			// once and emits one `__c_card` function. The compiler is
			// stateless from Vite's POV (no async work in
			// `ensureCompiled`); HMR invalidates the consumer modules,
			// not the compiler instance.
			componentCompiler = createComponentCompiler({
				projectDir: projectRoot,
				srcDir: path.resolve(projectRoot, 'src'),
				isDev: !isProduction,
			});
			refreshProjectAnalysis();
			if (rootLayoutPath) {
				const layoutSource = await fs.promises.readFile(rootLayoutPath, 'utf-8');
				if (/<html\b/i.test(layoutSource) || /<!DOCTYPE\s+html/i.test(layoutSource)) {
					throw new Error(
						'[koze] src/routes/layout.koze must be a layout fragment, not a document shell. ' +
							'Move <!DOCTYPE>, <html>, <head>, and <body> to src/app.koze.',
					);
				}
			}
			// Generate `src/app.d.ts` with the full type surface:
			//
			//   - `koze:*` virtual module declarations
			//   - DB row types parsed from `src/server/schema.ts` if it
			//     exists
			//   - `App.Locals` interface — preserved across regenerations
			//     via `// USER LOCALS START/END` markers so author edits
			//     survive
			//
			// Called automatically every time Vite reloads its config
			// (build, dev startup) and re-invoked from `handleHotUpdate`
			// when the schema or server files change so the IDE picks
			// up new types without a manual regeneration step.
			writeAppTypes({ projectDir: projectRoot });
			// Pre-scan routes before the client-env Rollup build starts so
			// each leading-script browser fragment is registered as a Rollup
			// input in production and as a Vite virtual module in dev.
			{
				for (const route of routes) {
					if (route.type === 'api') continue;
					try {
						const source = await fs.promises.readFile(route.absPath, 'utf-8');
						extractClientFragments(source, route.absPath, clientFragments, isProduction, componentCompiler ?? undefined);
					} catch {
						// Routes unreadable at config time (permissions/moves) will
						// surface later in `load` where the user gets a real error.
					}
				}

				// Same pre-scan for every discovered layout. Layouts also ship a
				// leading-`<script>` client fragment
				// — and crucially their event handlers (`on<event>={fn(...)}`)
				// must be registered with the per-layout handler registry BEFORE
				// the client-env Rollup build starts, otherwise the registration
				// table never makes it into the leading-fragment bundle and the
				// browser sees `ReferenceError`s when it tries to invoke them.
				//
				// Without this loop, layouts emit `data-client-event` attributes
				// (because `transformLayoutFile` queries the registry at compile
				// time) but the leading-fragment hash is never added to the
				// client Rollup input, so no asset is produced. The result is a
				// silently broken layout: SSR renders correctly, the client
				// bridge sees the `data-client-handler` attribute but can't find
				// any registered handler for it.
				for (const layoutPath of allLayoutPaths) {
					try {
						const source = await fs.promises.readFile(layoutPath, 'utf-8');
						extractClientFragments(source, layoutPath, clientFragments, isProduction, componentCompiler ?? undefined);
					} catch {
						// Same tolerance as the route loop above — surface real
						// errors at `load()` time where the user gets a stack.
					}
				}

				if (rootAppPath) {
					try {
						const source = await fs.promises.readFile(rootAppPath, 'utf-8');
						extractClientFragments(source, rootAppPath, clientFragments, isProduction, componentCompiler ?? undefined);
					} catch {
						// Same best-effort policy as routes/layouts. Real read errors
						// surface later when the virtual app module loads.
					}
				}
			}

			// Register the shared client-event bridge as its own fragment.
			// One asset per app, referenced from every route that emits
			// `on<event>={…}` attributes. `importerAbsPath` is set to the
			// project root as a sentinel — `load()` only uses it for HMR
			// watch-file registration and the bridge never changes at
			// runtime so the sentinel is fine.
			clientFragments.set(CLIENT_BRIDGE_HASH, {
				source: buildBridgeScriptSource(true),
				importerAbsPath: projectRoot,
				kind: 'bridge',
			});

			// Scan every extracted fragment for `$server/<path>` imports in
			// both serve and build modes. The Worker can request this map before
			// the client environment resolves its imports, so startup discovery
			// is required for dev/prod parity.
			// Populating `rpcReferencedModules` BEFORE the SSR build starts
			// ensures `koze:rpc-map` has a statically analyzable loader for
			// every module the client might RPC into.
			for (const fragment of clientFragments.values()) {
					// NB: use `[\s\S]+?` to tolerate multi-line named-import lists
					// — `.+` does not cross newlines and would miss any import with
					// the form `import { a,\n b } from '$server/...'`, which is
					// how most hand-authored routes break up long lists.
					const importRe = /import\s+[\s\S]+?from\s+['"]\$server\/([^'"]+)['"]/g;
					let m: RegExpExecArray | null;
					while ((m = importRe.exec(fragment.source)) !== null) {
						rpcReferencedModules.add(m[1]);
					}
			}

			// Global CSS convention: when `src/app.css` exists, register it
			// as a client Rollup input so Vite's plugin pipeline processes
			// it (Tailwind, PostCSS, CSS Modules, etc.), and the shell's
			// compiled template auto-injects a `<link rel="stylesheet">`
			// pointing at the hashed output. Mirrors SvelteKit/Next.js.
			hasGlobalCss = fs.existsSync(path.resolve(projectRoot, GLOBAL_CSS_FILE));

			if (clientFragments.size > 0 || hasGlobalCss) {
				const clientEnv = config.environments?.client;
				if (clientEnv) {
					const existingInput = clientEnv.build.rollupOptions?.input;
					const fragmentInputs: Record<string, string> = {};
					for (const hash of clientFragments.keys()) {
						fragmentInputs['koze-client-' + hash] =
							CLIENT_VIRTUAL_PREFIX + hash + '.ts';
					}
					if (hasGlobalCss) {
						fragmentInputs[GLOBAL_CSS_ENTRY_NAME] = GLOBAL_CSS_VIRTUAL_ID;
					}
					clientEnv.build.rollupOptions = {
						...clientEnv.build.rollupOptions,
						input: mergeRollupInputs(existingInput, fragmentInputs),
					};
				}
			}
		},

		async resolveId(id, importer) {
			if (id === VIRTUAL_ROUTES_ID) return RESOLVED_VIRTUAL_ROUTES_ID;
			if (id === VIRTUAL_MANIFEST_ID) return RESOLVED_VIRTUAL_MANIFEST_ID;
			if (id === VIRTUAL_DISPATCH_ID) return RESOLVED_VIRTUAL_DISPATCH_ID;
			if (id.startsWith(VIRTUAL_ROUTE_PREFIX)) return '\0' + id;
			if (id === VIRTUAL_LAYOUT_ID) return RESOLVED_VIRTUAL_LAYOUT_ID;
			// Nested-layout virtual id: `koze:layout/<hash>` resolves
			// to the same id with a null-byte marker so the browser
			// can't accidentally fetch it. The `load` hook below pulls
			// the hash back out and reads the matching file from disk.
			if (id.startsWith(NESTED_LAYOUT_VIRTUAL_PREFIX)) return '\0' + id;
			if (id === VIRTUAL_APP_ID) return RESOLVED_VIRTUAL_APP_ID;
			if (id === VIRTUAL_WORKER_ID) return RESOLVED_VIRTUAL_WORKER_ID;
			if (id === VIRTUAL_RPC_MAP_ID) return RESOLVED_VIRTUAL_RPC_MAP_ID;
			if (id === VIRTUAL_MIDDLEWARE_ID) return RESOLVED_VIRTUAL_MIDDLEWARE_ID;
			if (id === VIRTUAL_SECURITY_ID) return RESOLVED_VIRTUAL_SECURITY_ID;
			if (id === VIRTUAL_CONTENT_ID) return RESOLVED_VIRTUAL_CONTENT_ID;
			if (id.startsWith(CLIENT_VIRTUAL_PREFIX)) return id;
			if (id.startsWith(RPC_VIRTUAL_PREFIX)) return id;
			if (id === GLOBAL_CSS_VIRTUAL_ID) return id;
			if (id === FRAMEWORK_CSS_VIRTUAL_ID) return id;

			// `$server/*` resolution is env-aware:
			//   - client env → per-module RPC stub (no server code in the
			//     browser bundle)
			//   - ssr (Worker) env → real file on disk, so server-side
			//     code + the RPC dispatcher can call it directly
			if (id.startsWith('$server/')) {
				const subpath = id.slice('$server/'.length);
				const envName = (this as { environment?: { name?: string } }).environment?.name;
				if (envName === 'client') {
					rpcReferencedModules.add(subpath);
					return RPC_VIRTUAL_PREFIX + subpath + '.ts';
				}
				// SSR / dev-server default: resolve to the real file.
				const real = resolveServerFile(projectRoot, options.serverDir, subpath);
				return real ?? null;
			}
			// `koze:*` virtual modules (request, navigation, environment,
			// request) map to real files under `@kuratchi/koze/runtime/`.
			// Resolve against the PLUGIN's own require context so the host
			// app doesn't have to list `koze` as a direct dep.
			if (
				isKozeVirtualModule(id) &&
				!id.startsWith('koze:routes') &&
				!id.startsWith('koze:manifest') &&
				!id.startsWith('koze:dispatch') &&
				!id.startsWith('koze:layout') &&
				!id.startsWith('koze:app') &&
				!id.startsWith('koze:worker') &&
				!id.startsWith('koze:content') &&
				!id.startsWith('koze:client')
			) {
				const target = resolveKozeVirtualModule(id);
				if (target !== id) {
					return resolveKuratchiRuntimeFile(target);
				}
			}
			return null;
		},

		async load(id) {
			if (id === RESOLVED_VIRTUAL_ROUTES_ID) {
				return generateRoutesModule(routes);
			}
			if (id.startsWith('\0' + VIRTUAL_ROUTE_PREFIX)) {
				const hash = id.slice(('\0' + VIRTUAL_ROUTE_PREFIX).length);
				const route = routes.find((candidate) => routeModuleHash(candidate.absPath) === hash);
				if (!route) return null;
				this.addWatchFile(route.absPath);
				if (route.type === 'api') {
					return `export * from ${JSON.stringify(route.absPath)};`;
				}
				const source = await fs.promises.readFile(route.absPath, 'utf-8');
				const routesAbsDir = path.resolve(projectRoot, options.routesDir);
				const chain = layoutChainForRoute(route.absPath, allLayoutPaths, routesAbsDir);
				const result = transformRouteFile(
					source,
					route.absPath,
					clientFragments,
					componentCompiler!,
					isProduction,
					chain,
				);
				// Watch every resolved component file so editing
				// `card.koze` triggers a re-emit of every route that
				// pulls it in. The component compiler caches across
				// routes, so this list grows monotonically — but the
				// `addWatchFile` API tolerates duplicates.
				for (const file of result.watchFiles) {
					this.addWatchFile(file);
					registerComponentImporter(componentImporters, file, route.absPath);
				}
				return result.code;
			}
			if (id === RESOLVED_VIRTUAL_MANIFEST_ID) {
				return generateManifestModule(projectRoot, isProduction);
			}
			if (id === RESOLVED_VIRTUAL_DISPATCH_ID) {
				return loadDispatchSource();
			}
			if (id === RESOLVED_VIRTUAL_WORKER_ID) {
				return generateWorkerModule();
			}
			if (id === RESOLVED_VIRTUAL_RPC_MAP_ID) {
				return generateRpcMapModule(
					projectRoot,
					options.serverDir,
					rpcReferencedModules,
				);
			}
			if (id === RESOLVED_VIRTUAL_MIDDLEWARE_ID) {
				const middlewareFile = resolveMiddlewareFile(projectRoot, options.serverDir);
				if (middlewareFile) {
					this.addWatchFile(middlewareFile);
					return `export { default as runtime } from ${JSON.stringify(middlewareFile)};
`;
				}
				// Stub — empty runtime definition. The dispatcher handles this
				// as a no-op (no steps to run), matching the behavior when
				// no middleware file exists.
				return 'export const runtime = {};\n';
			}
			if (id === RESOLVED_VIRTUAL_SECURITY_ID) {
				// Inline the supplied options directly so dispatch.js gets a
				// stable constant object — no runtime indirection, no Vite
				// HMR reload required to change headers (a plugin restart is).
				const security = options.security ?? {};
				const config = {
					contentSecurityPolicy: security.contentSecurityPolicy ?? null,
					strictTransportSecurity: security.strictTransportSecurity ?? null,
					permissionsPolicy: security.permissionsPolicy ?? null,
				};
				return `export const config = ${JSON.stringify(config)};\n`;
			}
			if (id === RESOLVED_VIRTUAL_CONTENT_ID) {
				const result = generateContentModule(projectRoot);
				for (const file of result.watchFiles) {
					this.addWatchFile(file);
				}
				return result.code;
			}
			if (id === RESOLVED_VIRTUAL_LAYOUT_ID) {
				if (!rootLayoutPath) return 'export const hasLayout = false;\nexport const render = async (_data, content) => content;\n';
				this.addWatchFile(rootLayoutPath);
				const source = await fs.promises.readFile(rootLayoutPath, 'utf-8');
				const result = transformLayoutFile(
					source,
					rootLayoutPath,
					clientFragments,
					componentCompiler!,
					isProduction,
				);
				for (const file of result.watchFiles) {
					this.addWatchFile(file);
					registerComponentImporter(componentImporters, file, rootLayoutPath);
				}
				return result.code;
			}
			// Nested layout virtual module: `\0koze:layout/<hash>`.
			// Look up the layout path by hash and compile it the same
			// way as the root layout. Each nested layout is a self-
			// contained fragment with its own leading `<script>` and a
			// `<slot></slot>` that becomes the wrapped child content.
			if (id.startsWith('\0' + NESTED_LAYOUT_VIRTUAL_PREFIX)) {
				const hash = id.slice(('\0' + NESTED_LAYOUT_VIRTUAL_PREFIX).length);
				const layoutPath = allLayoutPaths.find((p) => layoutModuleHash(p) === hash);
				if (!layoutPath) {
					return 'export const hasLayout = false;\nexport const render = async (_data, content) => content;\n';
				}
				this.addWatchFile(layoutPath);
				const source = await fs.promises.readFile(layoutPath, 'utf-8');
				const result = transformLayoutFile(
					source,
					layoutPath,
					clientFragments,
					componentCompiler!,
					isProduction,
				);
				for (const file of result.watchFiles) {
					this.addWatchFile(file);
					registerComponentImporter(componentImporters, file, layoutPath);
				}
				return result.code;
			}
			if (id === RESOLVED_VIRTUAL_APP_ID) {
				if (rootAppPath) {
					this.addWatchFile(rootAppPath);
					const source = await fs.promises.readFile(rootAppPath, 'utf-8');
					const result = transformAppFile(
						source,
						checkHasGlobalCss(),
						clientFragments,
						isProduction,
						rootAppPath,
						componentCompiler!,
					);
					const code = typeof result === 'string' ? result : result.code;
					const watchFiles = typeof result === 'string' ? [] : result.watchFiles;
					for (const file of watchFiles) {
						this.addWatchFile(file);
						registerComponentImporter(componentImporters, file, rootAppPath);
					}
					return code;
				}
				// Default shell — no app.koze in the project.
				const result = transformAppFile(DEFAULT_APP_SHELL, checkHasGlobalCss());
				return typeof result === 'string' ? result : result.code;
			}
			// Global-CSS virtual shim: imports the framework baseline
			// (view-transitions etc.) *then* the user's `src/app.css` so
			// Rollup treats it as an entry and Vite's plugins run
			// (Tailwind, PostCSS, CSS Modules, etc.). The emitted hashed
			// `.css` output is linked from the shell automatically. Source
			// order matters — user rules come last so they always win over
			// the framework defaults.
			if (id === GLOBAL_CSS_VIRTUAL_ID) {
				const absPath = path.resolve(projectRoot, GLOBAL_CSS_FILE);
				this.addWatchFile(absPath);
				return `import ${JSON.stringify(FRAMEWORK_CSS_VIRTUAL_ID)};\nimport ${JSON.stringify(absPath)};\n`;
			}
			// Framework baseline CSS — served as an inline stylesheet. Kept
			// deliberately tiny and opinion-free; app.css still owns all
			// app-specific styling.
			if (id === FRAMEWORK_CSS_VIRTUAL_ID) {
				return FRAMEWORK_CSS_SOURCE;
			}
			// Client-env RPC stub for `$server/<path>`: synthesize one
			// Cap'n Web-backed channel wrapper per exported identifier in the
			// real server file. The real source is never shipped to the browser.
			if (id.startsWith(RPC_VIRTUAL_PREFIX)) {
				const subpath = id
					.slice(RPC_VIRTUAL_PREFIX.length)
					.replace(/\.ts$/, '');
				const serverFile = resolveServerFile(projectRoot, options.serverDir, subpath);
				if (serverFile) this.addWatchFile(serverFile);
				return generateRpcStubModule(subpath, serverFile);
			}
			// Client fragment requested by the browser: serve the extracted
			// `<script>` body. The `.ts` extension on the id tells Vite to
			// run its TypeScript transform on the module.
			if (id.startsWith(CLIENT_VIRTUAL_PREFIX)) {
				const hash = id.slice(CLIENT_VIRTUAL_PREFIX.length).replace(/\.ts$/, '');
				const fragment = clientFragments.get(hash);
				if (!fragment) return null;
				this.addWatchFile(fragment.importerAbsPath);
				return fragment.source;
			}
			// `.koze` route files: read, compile, emit the render module.
			// API route files are normal TypeScript/JavaScript modules; the
			// virtual route wrapper imports them so Vite can transform their
			// actual source. Do not intercept the real file id here, or the
			// module self-reexports and loses its method handlers in dev.
			const fileId = id.split('?')[0];
			if (
				isRouteFile(fileId, projectRoot, options.routesDir)
			) {
				if (isApiRouteFile(fileId, projectRoot)) return null;
				const source = await fs.promises.readFile(fileId, 'utf-8');
				// Compute the layout chain for this route from the full
				// discovered list. The chain excludes the route file
				// itself (never wraps yourself) and a layout's own
				// ancestors (a layout renders its own ancestor chain in
				// the compiled route call, so a layout module doesn't
				// wrap itself again here).
				const routesAbsDir = path.resolve(projectRoot, options.routesDir);
				const chain = isRouteLayoutFile(fileId)
					? []
					: layoutChainForRoute(fileId, allLayoutPaths, routesAbsDir);
				const result = transformRouteFile(
					source,
					fileId,
					clientFragments,
					componentCompiler!,
					isProduction,
					chain,
				);
				for (const file of result.watchFiles) {
					this.addWatchFile(file);
					registerComponentImporter(componentImporters, file, fileId);
				}
				return result.code;
			}
			return null;
		},

		async handleHotUpdate({ file, server, modules }) {
			// Type generation: regenerate `src/app.d.ts` whenever a server
			// module changes so the IDE picks up ordinary `$server/*` exports. The
			// `writeAppTypes` call is idempotent — it short-circuits
			// when the output bytes are unchanged, so editing an
			// unrelated server file doesn't thrash the file (which
			// would otherwise trigger Vite's watcher in a loop). The
			// schema path defaults to `src/server/schema.ts`; multi-
			// schema apps using `src/server/schemas/*` won't see DB
			// row types regenerated, which apps/web ships fine without.
			const serverRootAbs = path.resolve(projectRoot, options.serverDir);
			const isServerFile = file.startsWith(serverRootAbs + path.sep) && /\.(ts|js|mjs)$/.test(file);
			const contentRootAbs = path.resolve(projectRoot, 'src', 'content');
			const isContentFile = file.startsWith(contentRootAbs + path.sep) && file.toLowerCase().endsWith('.md');
			if (isServerFile || isContentFile) {
				try {
					writeAppTypes({ projectDir: projectRoot });
				} catch (err) {
					// Type generation failures should never block HMR.
					// Surface them in the dev console and continue.
					// eslint-disable-next-line no-console
					console.warn('[koze] writeAppTypes failed:', (err as Error).message);
				}
			}

			const globalCssPath = path.resolve(projectRoot, GLOBAL_CSS_FILE);
			const isCssFile = file === globalCssPath || file.endsWith('.css');
			if (isCssFile) {
				checkHasGlobalCss();
				const globalMod = server.moduleGraph.getModuleById(GLOBAL_CSS_VIRTUAL_ID);
				if (globalMod) server.moduleGraph.invalidateModule(globalMod);
				const appMod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_APP_ID);
				if (appMod) server.moduleGraph.invalidateModule(appMod);
			}

			if (componentCompiler && typeof componentCompiler.invalidate === 'function') {
				componentCompiler.invalidate(file);
			}

			// Translate the source-file edit into the set of synthetic
			// virtual module ids that bake in this file's compiled
			// output. Components and layouts are absorbed into their
			// consumers' virtual modules at compile time (not imported
			// as separate Vite-graph nodes), so Vite's automatic
			// importer-graph traversal can't see them — the tracker
			// helpers maintained during `load` bridge that gap.
			const { virtualIds, structural } = virtualModulesForChangedFile(
				file,
				projectRoot,
				options.routesDir,
				allLayoutPaths,
				rootAppPath,
				rootLayoutPath,
				routes,
				componentImporters,
				layoutDependents,
			);
			if (isCssFile) {
				virtualIds.push(RESOLVED_VIRTUAL_APP_ID, GLOBAL_CSS_VIRTUAL_ID);
			}
			if (isContentFile) {
				virtualIds.push(RESOLVED_VIRTUAL_CONTENT_ID);
			}
			const affectedRoutes = new Set<string>();
			const collectImporters = (f: string) => {
				if (f === rootAppPath || isRouteFile(f, projectRoot, options.routesDir)) {
					affectedRoutes.add(f);
				}
				const importers = componentImporters.get(f);
				if (importers) {
					for (const imp of importers) {
						if (!affectedRoutes.has(imp)) {
							collectImporters(imp);
						}
					}
				}
				const dependents = layoutDependents.get(f);
				if (dependents) {
					for (const dep of dependents) {
						if (!affectedRoutes.has(dep)) {
							collectImporters(dep);
						}
					}
				}
			};
			collectImporters(file);

			const clientFragmentIds: string[] = [];
			for (const routePath of affectedRoutes) {
				const hashes = await refreshClientFragmentsForImporter(
					routePath,
					clientFragments,
					isProduction,
					projectRoot,
					componentCompiler ?? undefined,
				);
				for (const hash of hashes) {
					clientFragmentIds.push(CLIENT_VIRTUAL_PREFIX + hash + '.ts');
				}
			}

			// If this file has no framework relationship, fall through
			// to Vite's default behavior (returning undefined preserves
			// the standard module-graph traversal for normal imports).
			if (virtualIds.length === 0 && clientFragmentIds.length === 0 && !structural && !isCssFile) return undefined;

			// Structural changes to the routes tree (file added or
			// removed under `src/routes/`) require re-running discovery
			// and invalidating the manifest module so the next request
			// picks up the new route set.
			if (structural) {
				refreshProjectAnalysis();
				const manifestMod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ROUTES_ID);
				if (manifestMod) server.moduleGraph.invalidateModule(manifestMod);
			}

			// Invalidate the precise set of virtual modules that bake in
			// the changed file. Returning the affected ModuleNodes from
			// `handleHotUpdate` triggers Vite's full HMR propagation:
			// importers of these modules re-evaluate on the next request,
			// the SSR worker reloads, and the browser receives an HMR
			// update without a hard reload.
			const affected: import('vite').ModuleNode[] = [];
			for (const id of [...virtualIds, ...clientFragmentIds]) {
				const mod = server.moduleGraph.getModuleById(id);
				if (mod) {
					server.moduleGraph.invalidateModule(mod);
					affected.push(mod);
				}
			}

			if (affectedRoutes.size > 0 && !isCssFile) {
				server.ws.send({ type: 'full-reload' });
			}

			// Combine the framework-detected affected modules with any
			// modules Vite already identified through its own import
			// graph (e.g. `$server/*` files imported normally). De-duped
			// via a Set so we don't return the same node twice.
			const merged = new Set<import('vite').ModuleNode>([...modules, ...affected]);
			return [...merged];
		},

		/**
		 * Post-build patch: Vite builds the SSR environment before the
		 * client environment (the Cloudflare plugin pins SSR as the
		 * primary builder). That ordering means the `koze:manifest`
		 * virtual module — loaded during the SSR Rollup run — sees an
		 * empty `dist/client/.vite/manifest.json` and bakes `MAP = {}`
		 * into the Worker bundle.
		 *
		 * To avoid swapping bundler order (risky — it's set by the
		 * Cloudflare plugin), we patch the emitted Worker bundle once the
		 * client build completes. The `writeBundle` hook fires per
		 * environment; we only act when the *client* env finishes, at
		 * which point the client manifest is on disk.
		 */
		writeBundle: {
			sequential: true,
			handler(outputOptions) {
				if (!isProduction) return;
				// Only the Worker bundle has the `MAP = {}` placeholder. SSR
				// output lands in `dist/ssr/index.js` (or the env-specific
				// default (Cloudflare plugin respects Vite defaults).
				const dir = outputOptions.dir ?? '';
				if (!dir.endsWith(path.sep + 'client') && !dir.endsWith('/client')) return;
				patchSsrManifestPlaceholder(projectRoot, hasGlobalCss);
			},
		},
	};
}

/**
 * Replace the empty `MAP = {}` literal the SSR build baked in with the
 * real client-manifest mapping. Matches against the well-known shape
 * emitted by `generateManifestModule` so we can't accidentally rewrite
 * unrelated code.
 */
function patchSsrManifestPlaceholder(
	projectRoot: string,
	hasGlobalCss: boolean,
): void {
	const clientManifestPath = path.join(projectRoot, 'dist', 'client', '.vite', 'manifest.json');
	const ssrDir = path.join(projectRoot, 'dist', 'ssr');
	if (!fs.existsSync(clientManifestPath) || !fs.existsSync(ssrDir)) return;

	const manifest = JSON.parse(fs.readFileSync(clientManifestPath, 'utf-8')) as Record<
		string,
		{ file: string; css?: string[]; src?: string }
	>;

	// Client-fragment map: virtual hash → hashed output path.
	const clientMap: Record<string, string> = {};
	for (const [inputPath, entry] of Object.entries(manifest)) {
		const clientMatch = inputPath.match(
			new RegExp(`^${CLIENT_VIRTUAL_PREFIX.replace(/[/:]/g, (c) => '\\' + c)}([^.]+)\\.ts$`),
		);
		if (clientMatch) clientMap[clientMatch[1]] = '/' + entry.file;
	}

	// Global-CSS: resolve the single hashed `.css` Vite emitted via the
	// shim's `css[]` field. Empty string when absent so the shell's
	// `<link>` resolves to the harmless `href=""`, which browsers drop.
	let globalCssHref = '';
	if (hasGlobalCss) {
		const shimEntry = manifest[GLOBAL_CSS_VIRTUAL_ID];
		const css = shimEntry?.css?.[0];
		if (css) globalCssHref = '/' + css;
	}

	if (Object.keys(clientMap).length === 0 && !globalCssHref) return;

	// Collect all JS files in the SSR output. The Cloudflare Vite plugin
	// moved the worker entrypoint from `dist/ssr/index.js` to
	// `dist/ssr/assets/worker-entry-<hash>.js` in v1+, so we can't
	// target a single well-known path any more — walk the tree and
	// rewrite every bundle that contains the stub consts. The consts
	// are unique enough that there's no ambiguity.
	const ssrFiles: string[] = [];
	const walkJs = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walkJs(full);
			else if (entry.isFile() && full.endsWith('.js')) ssrFiles.push(full);
		}
	};
	walkJs(ssrDir);

	const clientLiteral = JSON.stringify(clientMap);
	const hrefLiteral = JSON.stringify(globalCssHref);
	for (const file of ssrFiles) {
		const bundleSource = fs.readFileSync(file, 'utf-8');
		// Rollup may rename the const under minification if a collision
		// exists, so we match both the original name and the `$N` suffix
		// variants Rollup emits for collisions.
		let patched = bundleSource;
		if (Object.keys(clientMap).length > 0) {
			patched = patched.replace(
				/const (__kozeClientAssetMap(?:\$\d+)?)\s*=\s*\{[^;]*\};/g,
				(_m, name) => `const ${name} = ${clientLiteral};`,
			);
			// Minifiers may drop `const` in favor of a top-level assignment
			// or a bare identifier-equals pair. Handle those shapes too.
			patched = patched.replace(
				/(__kozeClientAssetMap(?:\$\d+)?)\s*=\s*\{[^;]*\}/g,
				(_m, name) => `${name} = ${clientLiteral}`,
			);
		}
		if (globalCssHref) {
			patched = patched.replace(
				/const (__kozeGlobalCssHref(?:\$\d+)?)\s*=\s*"[^"]*"\s*;/g,
				(_m, name) => `const ${name} = ${hrefLiteral};`,
			);
			patched = patched.replace(
				/(__kozeGlobalCssHref(?:\$\d+)?)\s*=\s*"[^"]*"/g,
				(_m, name) => `${name} = ${hrefLiteral}`,
			);
		}
		if (patched !== bundleSource) {
			fs.writeFileSync(file, patched);
		}
	}
}

function registerComponentImporter(
	componentImporters: Map<string, Set<string>>,
	componentAbsPath: string,
	importerAbsPath: string,
): void {
	let set = componentImporters.get(componentAbsPath);
	if (!set) {
		set = new Set();
		componentImporters.set(componentAbsPath, set);
	}
	set.add(importerAbsPath);
}

function collectClientFragmentHashesForImporter(
	clientFragments: Map<string, ClientFragment>,
	importerAbsPath: string,
): string[] {
	const hashes: string[] = [];
	for (const [hash, fragment] of clientFragments) {
		if (fragment.importerAbsPath === importerAbsPath) {
			hashes.push(hash);
		}
	}
	return hashes;
}

async function refreshClientFragmentsForImporter(
	sourceFile: string,
	clientFragments: Map<string, ClientFragment>,
	isProduction: boolean,
	projectRoot: string,
	componentCompiler?: ComponentCompiler,
): Promise<string[]> {
	const previousHashes = collectClientFragmentHashesForImporter(clientFragments, sourceFile);
	for (const hash of previousHashes) {
		clientFragments.delete(hash);
	}
	if (isApiRouteFile(sourceFile, projectRoot)) {
		return previousHashes;
	}
	if (!fs.existsSync(sourceFile)) {
		return previousHashes;
	}
	const source = await fs.promises.readFile(sourceFile, 'utf-8');
	const { leadingHash } = extractClientFragments(
		source,
		sourceFile,
		clientFragments,
		isProduction,
		componentCompiler,
	);
	const nextHashes = leadingHash ? [leadingHash] : [];
	return [...new Set([...previousHashes, ...nextHashes])];
}

/**
 * Resolve the changed file to the set of virtual module ids whose
 * compiled output bakes in this file's contents. The Vite dev server
 * walks the resulting set, invalidates each, and re-fetches them on
 * the next request.
 *
 * The mapping is necessarily framework-aware: components and layouts
 * are ABSORBED into their consumers' virtual modules at compile time
 * rather than imported as separate modules, so Vite's automatic
 * importer-graph traversal can't see them. This function bridges
 * that gap by translating a source-file edit into the synthetic
 * virtual-module ids that need re-evaluation.
 *
 * Returns an empty array when the file isn't owned by the framework
 * (Vite's default HMR will handle it correctly without our help).
 */
function virtualModulesForChangedFile(
	file: string,
	projectRoot: string,
	routesDir: string,
	allLayoutPaths: string[],
	rootAppPath: string | null,
	rootLayoutPath: string | null,
	routes: DiscoveredRoute[],
	componentImporters: Map<string, Set<string>>,
	layoutDependents: Map<string, Set<string>>,
): { virtualIds: string[]; structural: boolean } {
	const ids = new Set<string>();
	let structural = false;

	const isRoute = isRouteFile(file, projectRoot, routesDir);
	const isLayout = isRoute && isRouteLayoutFile(file);

	// Layout edit: invalidate the specific layout virtual module + every
	// route module that includes it in its chain. Layouts are always
	// also routes (they live under routes/), so this branch fires
	// before the plain-route branch below.
	if (isLayout) {
		ids.add('\0' + NESTED_LAYOUT_VIRTUAL_PREFIX + layoutModuleHash(file));
		// The legacy `koze:layout` id resolves to the root layout.
		if (rootLayoutPath && file === rootLayoutPath) {
			ids.add(RESOLVED_VIRTUAL_LAYOUT_ID);
		}
		for (const dependentRoutePath of layoutDependents.get(file) ?? []) {
			const dependentRoute = routes.find((r) => r.absPath === dependentRoutePath);
			if (dependentRoute) {
				ids.add('\0' + VIRTUAL_ROUTE_PREFIX + routeModuleHash(dependentRoute.absPath));
			}
		}
		return { virtualIds: [...ids], structural: false };
	}

	// Route edit (non-layout): invalidate the specific route module.
	// Manifest doesn't change unless the file was added/removed; we
	// flag `structural` so the caller can also invalidate
	// `koze:routes`. We can't tell add/remove from a `change` event
	// alone, but Vite calls `handleHotUpdate` with the changed file
	// which always exists at this point — the structural flag is left
	// off here and set by the caller's `add`/`unlink` event handlers.
	if (isRoute) {
		const route = routes.find((r) => r.absPath === file);
		if (route && fs.existsSync(file)) {
			ids.add('\0' + VIRTUAL_ROUTE_PREFIX + routeModuleHash(route.absPath));
		} else {
			// Route file exists on disk but wasn't in our `routes` array
			// yet (new file) OR file was deleted — this is a structural change.
			// Bump the manifest so discoverRoutes runs again.
			structural = true;
			if (route) {
				ids.add('\0' + VIRTUAL_ROUTE_PREFIX + routeModuleHash(route.absPath));
			}
		}
		return { virtualIds: [...ids], structural };
	}

	// App shell edit: invalidate `koze:app` + every route (because
	// every route's render() invokes `__kozeApp.render` and the
	// shell's compiled output is baked in).
	if (rootAppPath && file === rootAppPath) {
		ids.add(RESOLVED_VIRTUAL_APP_ID);
		for (const route of routes) {
			ids.add('\0' + VIRTUAL_ROUTE_PREFIX + routeModuleHash(route.absPath));
		}
		return { virtualIds: [...ids], structural: false };
	}

	// Middleware edit: invalidate the middleware virtual module. The
	// dispatcher imports it at module top, so this propagates through
	// Vite's normal importer graph after this invalidation.
	const middlewareAbsPath = path.resolve(projectRoot, MIDDLEWARE_FILE);
	if (file === middlewareAbsPath) {
		ids.add(RESOLVED_VIRTUAL_MIDDLEWARE_ID);
		return { virtualIds: [...ids], structural: false };
	}

	// `$server/<x>.ts` edit: the rpc-map has a loader for every server
	// module the client env has resolved. Invalidate it so the next
	// dispatch picks up the changed module. Detection is "lives under serverDir"
	// — the plugin doesn't track which serverDir the user configured
	// here, so we conservatively treat any .ts under `src/server/`
	// as RPC-affecting. False positives (server util that nothing
	// imports) cost a single virtual-module re-emit, which is cheap.
	const serverAbsRoot = path.resolve(projectRoot, 'src', 'server');
	const relToServer = path.relative(serverAbsRoot, file);
	if (relToServer && !relToServer.startsWith('..') && !path.isAbsolute(relToServer) && file.endsWith('.ts')) {
		ids.add(RESOLVED_VIRTUAL_RPC_MAP_ID);
		return { virtualIds: [...ids], structural: false };
	}

	// Component file edit: walk the importers index and invalidate
	// every route/layout virtual module that has this component baked
	// in. This is the case Vite's automatic importer graph CAN'T cover
	// (components are absorbed into route output, not imported as
	// modules), so the explicit tracker is the bridge.
	const importers = componentImporters.get(file);
	if (importers && importers.size > 0) {
		for (const importerAbsPath of importers) {
			// The importer is itself either a route or a layout. If
			// it's a layout, recursively pick up every dependent route.
			if (isRouteLayoutFile(importerAbsPath)) {
				ids.add('\0' + NESTED_LAYOUT_VIRTUAL_PREFIX + layoutModuleHash(importerAbsPath));
				if (rootLayoutPath && importerAbsPath === rootLayoutPath) {
					ids.add(RESOLVED_VIRTUAL_LAYOUT_ID);
				}
				for (const dependentRoutePath of layoutDependents.get(importerAbsPath) ?? []) {
					const dependentRoute = routes.find((r) => r.absPath === dependentRoutePath);
					if (dependentRoute) {
						ids.add('\0' + VIRTUAL_ROUTE_PREFIX + routeModuleHash(dependentRoute.absPath));
					}
				}
			} else {
				// Importer is a route (or the app shell — which doesn't
				// import components today, but if it ever does, this
				// path covers it).
				const route = routes.find((r) => r.absPath === importerAbsPath);
				if (route) {
					ids.add('\0' + VIRTUAL_ROUTE_PREFIX + routeModuleHash(route.absPath));
				} else if (rootAppPath && importerAbsPath === rootAppPath) {
					ids.add(RESOLVED_VIRTUAL_APP_ID);
				}
			}
		}
		return { virtualIds: [...ids], structural: false };
	}

	return { virtualIds: [], structural: false };
}

/**
 * Content-addressed hash for the leading client fragment of a given route
 * file. The path keeps same-content routes distinct; the source keeps the
 * browser module URL in lockstep with the rendered HTML during dev reloads.
 */
function generateManifestModule(projectRoot: string, isProduction: boolean): string {
	// Dev-server URL that Vite's module graph will serve through all
	// registered plugins (Tailwind, PostCSS, CSS Modules, …). The
	// leading `/` is a project-root-relative path; Vite resolves it
	// against the source tree and applies its transform pipeline.
	const devGlobalCssHref = '/' + GLOBAL_CSS_FILE;
	if (!isProduction) {
		return `export function resolveClientAsset(hash) {
	return '/@id/${CLIENT_VIRTUAL_PREFIX}' + hash + '.ts';
}
export function resolveGlobalCssHref() {
	return ${JSON.stringify(devGlobalCssHref)};
}
`;
	}

	const manifestPath = path.join(projectRoot, 'dist', 'client', '.vite', 'manifest.json');
	let clientMap: Record<string, string> = {};
	try {
		const raw = fs.readFileSync(manifestPath, 'utf-8');
		const manifest = JSON.parse(raw) as Record<
			string,
			{ file: string; css?: string[] }
		>;
		for (const [inputPath, entry] of Object.entries(manifest)) {
			const clientMatch = inputPath.match(
				new RegExp(`^${CLIENT_VIRTUAL_PREFIX.replace(/[/:]/g, (c) => '\\' + c)}([^.]+)\\.ts$`),
			);
			if (clientMatch) clientMap[clientMatch[1]] = '/' + entry.file;
		}
		// Global CSS href is baked in at write time by
		// `patchSsrManifestPlaceholder` — the placeholder stays an
		// empty string here so we can rewrite it to the hashed path.
	} catch {
		// Manifest absent (e.g. SSR-only build). Fall back to hash-as-path.
	}

	// Unique variable names avoid Rollup renaming under minification
	// (e.g. a collision with `koze:rpc-map`'s own `MAP`), which would
	// break the post-build `writeBundle` patch that swaps the stub for
	// the real value.
	return `const __kozeClientAssetMap = ${JSON.stringify(clientMap)};
const __kozeGlobalCssHref = "";
export function resolveClientAsset(hash) {
	return __kozeClientAssetMap[hash] || ('/@id/${CLIENT_VIRTUAL_PREFIX}' + hash + '.ts');
}
export function resolveGlobalCssHref() {
	return __kozeGlobalCssHref;
}
`;
}

/**
 * Rollup's `input` accepts a string, string[], or Record<string,string>.
 * We want a stable named-input form so asset filenames stay predictable,
 * so we normalize existing input into an object and merge our fragment
 * entries into it.
 */
/**
 * Locate the user's middleware file at the single canonical location:
 * `src/middleware.ts`. Returns null if it doesn't exist — the plugin
 * emits an empty-runtime stub in that case.
 */
function resolveMiddlewareFile(projectRoot: string, _serverDir: string): string | null {
	const candidate = path.resolve(projectRoot, MIDDLEWARE_FILE);
	return fs.existsSync(candidate) ? candidate : null;
}

function mergeRollupInputs(
	existing: string | string[] | Record<string, string> | undefined,
	additions: Record<string, string>,
): Record<string, string> {
	if (!existing) return { ...additions };
	if (typeof existing === 'string') {
		return { main: existing, ...additions };
	}
	if (Array.isArray(existing)) {
		const asObject: Record<string, string> = {};
		for (const entry of existing) {
			const key = path.basename(entry).replace(/\.[^.]+$/, '');
			asObject[key] = entry;
		}
		return { ...asObject, ...additions };
	}
	return { ...existing, ...additions };
}


/**
 * Locate the real file backing `$server/<subpath>` using `serverDir`
 * (default `src/server`). Checks `.ts`, `.js`, and index files. Returns
 * `null` if nothing matches — callers treat that as "stub with zero
 * functions" so the module is still valid JS.
 */
function generateRoutesModule(routes: DiscoveredRoute[]): string {
	const preparedRouter = JSON.stringify(createPreparedRouter(routes.map((r) => r.urlPattern)));
	const entries = routes
		.map(
			(r) =>
				`  { pattern: ${JSON.stringify(r.urlPattern)}, type: ${JSON.stringify(r.type)}, load: () => import(${JSON.stringify(VIRTUAL_ROUTE_PREFIX + routeModuleHash(r.absPath))}) }`,
		)
		.join(',\n');
	return `export const routes = [\n${entries}\n];\n\nexport const preparedRouter = ${preparedRouter};\n`;
}
