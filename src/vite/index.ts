/**
 * koze/vite — Vite plugin for Koze
 *
 * SPIKE BRANCH. Minimum surface to pass the gates in `VITE-SPIKE.md`.
 *
 * Route files use the `.koze` extension. The files are HTML-shaped but
 * contain native JS control flow (`if () {}`, `for () {}`), `{expression}`
 * interpolation, attribute binding, and `$server/*` RPC imports — none of
 * which are valid HTML. The dedicated extension lets Vite / Rollup / Prettier
 * / editors / agents route through the right handler without fighting
 * HTML-tooling assumptions.
 *
 * The plugin delegates template parsing + codegen to `koze/compiler`
 * (the same primitives the legacy CLI uses), and adds Vite-specific
 * orchestration: route discovery, virtual `koze:routes` module,
 * leading-script browser fragments, and `$lib`/`$server` resolve aliases.
 */

import type { Plugin } from 'vite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
// Compiler primitives are siblings within the same package now
// (koze consolidated the Vite plugin into itself). The relative
// path keeps the import graph internal — no self-reference through the
// package's `exports` map, which would create a build-order paradox
// when this file is being compiled before `dist/compiler/index.js`
// exists.
import {
	parseFile,
	analyzeClientTemplateReactivity,
	buildClientTemplateRenderersExpression,
	compileTemplate,
	rewriteAugmentedActionInitializersForClient,
	stripAugmentImportSpecifier,
	stripAugmentedActionDeclarations,
	stripTopLevelImports,
	buildSelectiveSsrPrelude,
	buildClientScopeMount,
	buildBridgeScriptSource,
	buildReactiveRuntimeScriptTag,
	transformReactiveClientScript,
	isKuratchiVirtualModule,
	resolveKuratchiVirtualModule,
	createComponentCompiler,
	parseKuratchiSfc,
	discoverAgentFiles,
	discoverContainerFiles,
	discoverPipelineFiles,
	discoverSandboxFiles,
	discoverQueueConsumerFiles,
	discoverWorkflowFiles,
	discoverDurableObjects,
	discoverContentEntries,
	syncWranglerConfig,
	writeAppTypes,
	writePipelineArtifacts,
	readApiShieldRouteMetadata,
	writeApiShieldOpenApi,
	appendInlineSourceMap,
	createGeneratedSourceMap,
	createKuratchiSourceMap,
} from '../compiler/index.js';
import type { AugmentedActionAlias, ComponentCompiler } from '../compiler/index.js';
import { createServerModuleCompiler } from '../compiler/server-module-pipeline.js';
import type { ServerModuleCompiler } from '../compiler/server-module-pipeline.js';
import { componentFuncName, toSafeIdentifier } from '../compiler/compiler-shared.js';
import type { DoConfigEntry, DoHandlerEntry } from '../compiler/compiler-shared.js';
import { createPreparedRouter } from '../runtime/router.js';
import type {
	DiscoveredRoute,
	KuratchiViteOptions,
	ResolvedKuratchiOptions,
} from './types.js';

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

export type { KuratchiViteOptions } from './types.js';

const ROUTE_EXT = '.koze';
const LEGACY_ROUTE_EXT = '.kuratchi';
const ROUTE_EXTENSIONS = [ROUTE_EXT, LEGACY_ROUTE_EXT] as const;
const API_ROUTE_RE = /\.(ts|js)$/;
const API_SHIELD_SIDECAR_RE = /\.api-shield\.(ts|js)$/;

function isPageRouteFile(filePath: string): boolean {
	return routeSourceExtension(filePath) !== null;
}

function isRouteLayoutFile(filePath: string): boolean {
	return stripRouteSourceExtension(path.basename(filePath)) === ROUTE_LAYOUT_BASENAME;
}

function routeSourceExtension(filePath: string): string | null {
	return ROUTE_EXTENSIONS.find((ext) => filePath.endsWith(ext)) ?? null;
}

function stripRouteSourceExtension(filePath: string): string {
	const ext = routeSourceExtension(filePath);
	return ext ? filePath.slice(0, -ext.length) : filePath;
}

function resolveSourceSibling(dir: string, basename: string): string | null {
	const candidates = ROUTE_EXTENSIONS
		.map((ext) => path.join(dir, basename + ext))
		.filter((candidate) => fs.existsSync(candidate));
	if (candidates.length > 1) {
		throw new Error(`[koze] Both ${basename}.koze and ${basename}.kuratchi exist in ${dir}. Keep one source file for this route.`);
	}
	return candidates[0] ?? null;
}

function normalizeVirtualSpecifier(id: string): string {
	if (id.startsWith('kuratchi:')) return 'koze:' + id.slice('kuratchi:'.length);
	if (id.startsWith('\0kuratchi:')) return '\0koze:' + id.slice('\0kuratchi:'.length);
	if (id.startsWith('virtual:kuratchi-')) return 'virtual:koze-' + id.slice('virtual:kuratchi-'.length);
	if (id.startsWith('\0virtual:kuratchi-')) return '\0virtual:koze-' + id.slice('\0virtual:kuratchi-'.length);
	return id;
}

/**
 * Fallback expressions for each safe `koze:request` export. The parser
 * only allows this subset through (see `KURATCHI_REQUEST_SAFE_EXPORTS` in
 * `koze/compiler/parser.ts`), so we keep the table in lock-step:
 * if a new safe export is added there, it needs a matching fallback here.
 * The dispatcher populates matching fields on `data` per-request; the
 * fallback only fires if something bypasses the dispatcher (e.g. a direct
 * `render({})` call in tests).
 */
/**
 * Default static-assets directory. Auto-wired into `wrangler.jsonc`'s
 * `assets.directory` field if the folder exists — no app-side config
 * required. Wrangler serves files from this directory at the URL
 * matching their path relative to the directory, so
 * `src/assets/styles.css` is reachable at `/styles.css` in both dev
 * (via the Cloudflare Vite plugin's asset handling) and prod.
 */
const DEFAULT_ASSETS_DIR = 'src/assets';

const REQUEST_IMPORT_FALLBACKS: Record<string, string> = {
	url: 'new URL("http://localhost/")',
	pathname: '"/"',
	searchParams: 'new URLSearchParams()',
	params: '{}',
	slug: 'undefined',
	method: '"GET"',
};

const ROUTE_LAYOUT_BASENAME = 'layout';
const ROUTE_APP_BASENAME = 'app';

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
 * The legacy single-id `koze:layout` still resolves — it maps
 * to whichever layout lives at `routes/layout.koze` (the root).
 * Subdirectory layouts are only reachable via the nested id.
 */
const NESTED_LAYOUT_VIRTUAL_PREFIX = 'koze:layout/';

/**
 * Stable 10-char hash derived from a layout file's absolute path.
 * Used to form the nested-layout virtual id and the local binding
 * name routes use to reference the layout module. Keyed on path
 * (not content) so cache-busting happens naturally when Vite rebuilds
 * the layout module and routes pick up the new output without the
 * route module's content hash changing.
 */
function layoutModuleHash(layoutAbsPath: string): string {
	return crypto.createHash('sha1').update(layoutAbsPath).digest('hex').slice(0, 10);
}

function routeModuleHash(routeAbsPath: string): string {
	return crypto.createHash('sha1').update(routeAbsPath).digest('hex').slice(0, 10);
}

function componentRpcHash(sourceKey: string, importedName: string): string {
	return crypto.createHash('sha1').update(`${sourceKey}:${importedName}`).digest('hex').slice(0, 12);
}

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
 * Back-compat: if `app.koze` is absent AND `layout.koze`
 * contains `<html>` / `<body>`, the layout keeps its old conflated
 * role (the default shell is bypassed). A deprecation warning is
 * emitted when we detect that legacy shape.
 */
const VIRTUAL_APP_ID = 'koze:app';
const RESOLVED_VIRTUAL_APP_ID = '\0' + VIRTUAL_APP_ID;

/**
 * `koze:worker` — the full Worker module the user's `src/worker.ts`
 * re-exports. Combines:
 *
 *   - `default` export: `{ fetch, queue? }` (dispatcher + queue router)
 *   - Named exports: every discovered convention class
 *     (.workflow.ts / .do.ts / .sandbox.ts / .container.ts classes)
 *
 * Cloudflare requires convention classes to be NAMED EXPORTS OF THE
 * WORKER ENTRY SCRIPT for binding resolution. This virtual module gives
 * the user a single re-export target so `src/worker.ts` stays a two-line
 * stub regardless of how many conventions the project uses.
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
 * A unified view of a discoverable Worker class (workflow / DO / sandbox
 * / container). Queue consumers are tracked separately because they're
 * function handlers, not classes.
 */
interface ConventionClass {
	className: string;
	file: string;
	exportKind: 'named' | 'default';
}
interface QueueConsumer {
	queueName: string;
	file: string;
	exportKind: 'named' | 'default';
}

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
const CLIENT_BRIDGE_HASH = 'bridge';

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
 * Shared across transformRouteFile invocations: every time we compile a
 * route we register its leading-script browser fragment here so `resolveId` /
 * `load` can serve it back to Vite.
 */
interface ClientFragment {
	source: string;
	importerAbsPath: string;
	/**
	 * `leading` — the leading `<script>` block of a route. The plugin
	 *            extracts this as a client fragment too so the same code the
	 *            SSR runs also runs in the browser. `source` here is the
	 *            BROWSER-SHAPE transform — top-level `const X = await …` is
	 *            replaced with `const X = __kozeData?.X` so references
	 *            to SSR-resolved values keep working, and imports of virtual
	 *            modules like `koze:request` / `koze:environment`
	 *            are inlined as serialized consts.
	 *
	 * `bridge`  — the single shared client-event bridge module. Registered
	 *            once in `configResolved`, referenced by hash from every
	 *            route that has any `on<event>={…}` attribute. Emitting
	 *            this as its own asset (rather than appending it to every
	 *            leading fragment) lets the browser cache ~1 kB of
	 *            identical code once across the whole app.
	 */
	kind?: 'leading' | 'bridge';
	/**
	 * For `leading` fragments: names of SSR-resolved top-level vars that
	 * must be serialized into `window.__kozeData` at render time so the
	 * client can read them.
	 */
	hydrateVars?: string[];
	/**
	 * For `leading` fragments: the shared event-handler registry, created
	 * during `extractClientFragments` (pre-scan) and consulted during
	 * `compileTemplate` (transform) via `options.clientRouteRegistry`.
	 *
	 * The registry is pre-populated from a regex scan of the template so
	 * the handler ids (`h0`, `h1`, …) are stable between pre-scan and
	 * compile, and the handler-registration source is appended to the
	 * fragment's browser source at registration time — before the client
	 * Rollup build starts loading the fragment.
	 */
	handlerRegistry?: ViteClientRouteRegistry;
	/**
	 * For `leading` fragments: does this route need the shared client
	 * bridge loaded? True when the template contains any `on<event>={…}`
	 * attribute (either a client handler or a server-action callee) and
	 * the registered handlers need `window.__kozeClient` present,
	 * OR when any button relies on the bridge's `data-action-event`
	 * POST path. Read by the route emitter to decide whether to emit
	 * the shared-bridge `<script>` tag.
	 */
	needsBridge?: boolean;
	reactiveNames?: Set<string>;
	blockRenderersExpr?: string;
}

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
 * Files in `src/assets/` are a totally separate thing — served verbatim
 * by Wrangler's ASSETS binding (favicons, images, prebuilt CSS).
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

export function koze(options: KuratchiViteOptions = {}): Plugin[] {
	const resolved: ResolvedKuratchiOptions = {
		routesDir: options.routesDir ?? 'src/routes',
		api: {
			root: options.api?.root ?? 'src/routes/api',
			urlPrefix: normalizeApiUrlPrefix(options.api?.urlPrefix),
		},
		serverDir: options.serverDir ?? 'src/server',
		libDir: options.libDir ?? 'src/lib',
		security: options.security,
		apiShield: options.apiShield,
	};

	return [routesPlugin(resolved)];
}

/** @deprecated Use `koze()` instead. */
export const kuratchi: typeof koze = koze;

function normalizeApiUrlPrefix(value: string | undefined): string {
	if (!value) return '/api';
	const trimmed = value.trim();
	if (!trimmed || trimmed === '/') return '/';
	return '/' + trimmed.replace(/^\/+|\/+$/g, '');
}

function writeIfChanged(filePath: string, content: string): void {
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	if (fs.existsSync(filePath)) {
		const existing = fs.readFileSync(filePath, 'utf-8');
		if (existing === content) return;
	}
	fs.writeFileSync(filePath, content, 'utf-8');
}

function tryResolveFromProject(root: string, specifier: string): string | null {
	try {
		return kuratchiViteRequire.resolve(specifier, { paths: [root] });
	} catch {
		return null;
	}
}

function routesPlugin(options: ResolvedKuratchiOptions): Plugin {
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
	 * True when the layout file itself contains `<html>`/`<body>` — the
	 * legacy "layout is also the shell" shape. Triggers a deprecation
	 * warning and makes the default app shell a pass-through so we
	 * don't emit a nested `<html>`.
	 */
	let layoutIsLegacyShell = false;
	/**
	 * Populated by `syncWranglerFromConventions` during `configResolved`.
	 * Used later by the `koze:worker` module to re-export classes
	 * and wire queue dispatch.
	 */
	let conventionClasses: ConventionClass[] = [];
	let durableObjectConfig: DoConfigEntry[] = [];
	let durableObjectHandlers: DoHandlerEntry[] = [];
	let queueConsumers: QueueConsumer[] = [];
	let workflowRegistry: Array<{ name: string; binding: string }> = [];
	let pipelineRegistry: Array<{ name: string; binding: string; pipeline: string }> = [];
	/**
	 * Every `$server/<subpath>` specifier that the client env has ever
	 * resolved. We static-import each of these into the SSR bundle's
	 * `koze:rpc-map` module so the dispatcher can look the module up
	 * at runtime without a dynamic `import()` (which Rollup can't
	 * statically resolve against an aliased specifier).
	 */
	const rpcReferencedModules = new Set<string>();
	const clientFragments = new Map<string, ClientFragment>();
	/**
	 * Whether `src/app.css` exists. Set in `configResolved`; drives
	 * both the client-Rollup-input registration and the `<link>`
	 * injection in `transformAppFile`.
	 */
	let hasGlobalCss = false;
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
	let workerModuleCompiler: ServerModuleCompiler | null = null;
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

	return {
		name: 'koze:routes',
		enforce: 'pre',

		config(userConfig, configEnv) {
			// `$lib` and `$server` are Koze's author-facing path aliases.
			// Registering them via Vite's resolver means the leading browser
			// fragment and Worker-side modules can just `import x from '$lib/y'`
			// and have Vite resolve it. No custom rewrite pass needed.
			const root = (userConfig.root ? path.resolve(userConfig.root) : process.cwd());
			// Scaffold `src/worker.ts` if missing, BEFORE the Cloudflare
			// plugin's own `config` hook reads wrangler.jsonc's `main`
			// field. Otherwise that hook errors on a missing file and
			// dev/build fails to start.
			ensureWorkerEntry(root);
			// Initial type stub so editor tooling has SOMETHING to
			// resolve `koze:*` virtual modules against before the
			// full `writeAppTypes` runs in `configResolved`. The full
			// pass needs project-discovered workflow names + schema
			// parsing — both of which require the resolved `projectRoot`
			// from `configResolved`. The minimal stub here covers the
			// editor LSP cold-start case where the user just opened
			// the project and Vite hasn't reached `configResolved` yet.
			writeAppTypes({ projectDir: root });
			// Default `publicDir` to `src/assets/` when it exists. Vite
			// serves this directory at URL root (files at `/<name>`) in
			// dev; Wrangler serves from the same directory in prod via
			// the assets binding we auto-wire into `wrangler.jsonc`.
			// Authors never configure a separate static dir.
			const assetsAbs = path.resolve(root, DEFAULT_ASSETS_DIR);
			const publicDir = userConfig.publicDir === undefined && fs.existsSync(assetsAbs)
				? assetsAbs
				: userConfig.publicDir;
			// `koze:environment` exposes a `dev` flag that reads
			// `globalThis.__koze_DEV__`. The legacy CLI substitutes
			// this at build time — we do the same via Vite's `define` so
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
				publicDir,
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
			routes = discoverRoutes(projectRoot, options.routesDir, options.api.root, options.api.urlPrefix);
			writeApiShieldOpenApi({
				projectDir: projectRoot,
				routes: routes
					.filter((route) => route.type === 'api')
					.map((route) => readApiShieldRouteMetadata({
						projectDir: projectRoot,
						pattern: route.urlPattern,
						fullPath: route.absPath,
					})),
				options: options.apiShield,
				writeFile: writeIfChanged,
			});
			rootLayoutPath = discoverRootLayout(projectRoot, options.routesDir);
			rootAppPath = discoverRootApp(projectRoot, options.routesDir);
			// Discover every `layout.koze` under `routes/`. The root
			// layout remains accessible as `rootLayoutPath` for back-compat
			// with the legacy-shell detection; nested layouts are picked
			// up per route at emission time via `layoutChainForRoute`.
			allLayoutPaths = discoverAllLayouts(projectRoot, options.routesDir);
			// Build the layout → dependent-routes index once at startup.
			// HMR reads this in `handleHotUpdate` to invalidate every
			// route module that includes the edited layout in its chain.
			// The relationship is purely structural (driven by the
			// directory tree), so it doesn't change between edits — only
			// when files are added/removed, which already triggers a
			// reload through the `koze:routes` manifest invalidation.
			layoutDependents.clear();
			{
				const routesAbsDirForChain = path.resolve(projectRoot, options.routesDir);
				for (const route of routes) {
					const chain = layoutChainForRoute(route.absPath, allLayoutPaths, routesAbsDirForChain);
					for (const layoutPath of chain) {
						let set = layoutDependents.get(layoutPath);
						if (!set) {
							set = new Set();
							layoutDependents.set(layoutPath, set);
						}
						set.add(route.absPath);
					}
				}
			}
			layoutIsLegacyShell = false;
			if (rootLayoutPath) {
				try {
					const layoutSource = await fs.promises.readFile(rootLayoutPath, 'utf-8');
					if (/<html\b/i.test(layoutSource) || /<!DOCTYPE\s+html/i.test(layoutSource)) {
						layoutIsLegacyShell = true;
						if (!rootAppPath) {
							// eslint-disable-next-line no-console
							console.warn(
								'[koze] src/routes/layout.koze contains the document shell ' +
									'(<!DOCTYPE>/<html>). This shape is deprecated. Move the shell to ' +
									'src/routes/app.koze and keep layout.koze as a fragment ' +
									'(top <script> + markup wrapping <slot></slot>).',
							);
						}
					}
				} catch {
					// Best-effort detection; fall back to the new model.
				}
			}
			workerModuleCompiler = createServerModuleCompiler({
				projectDir: projectRoot,
				srcDir: path.resolve(projectRoot, 'src'),
				doHandlerProxyPaths: new Map(),
				isDev: !isProduction,
				emitJs: true,
				writeFile: (filePath, content) => {
					const fileDir = path.dirname(filePath);
					if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
					if (fs.existsSync(filePath)) {
						const existing = fs.readFileSync(filePath, 'utf-8');
						if (existing === content) return;
					}
					fs.writeFileSync(filePath, content, 'utf-8');
				},
			});
			const discovered = syncWranglerFromConventions(projectRoot, options.serverDir, workerModuleCompiler);
			conventionClasses = discovered.classes;
			durableObjectConfig = discovered.durableObjectConfig;
			durableObjectHandlers = discovered.durableObjectHandlers;
			queueConsumers = discovered.queues;
			workflowRegistry = discovered.workflows;
			pipelineRegistry = discovered.pipelines;
			// Generate `src/app.d.ts` with the full type surface:
			//
			//   - `koze:*` virtual module declarations (parameterized
			//     by the discovered workflow names → typed `WorkflowName`
			//     union)
			//   - DB row types parsed from `src/server/schema.ts` if it
			//     exists
			//   - `App.Locals` interface — preserved across regenerations
			//     via `// USER LOCALS START/END` markers so author edits
			//     survive
			//
			// Called automatically every time Vite reloads its config
			// (build, dev startup) and re-invoked from `handleHotUpdate`
			// when the schema or workflow files change so the IDE picks
			// up new types without a manual regeneration step.
			writeAppTypes({ projectDir: projectRoot });
			// Pre-scan routes before the client-env Rollup build starts so
			// each leading-script browser fragment is registered as a Rollup
			// input in production and as a Vite virtual module in dev.
			if (isProduction || process.env.VITEST === 'true') {
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

			if (isProduction || process.env.VITEST === 'true') {
				// Scan every extracted fragment for `$server/<path>` imports
				// up front. Populating `rpcReferencedModules` BEFORE the SSR
				// build starts ensures `koze:rpc-map` has static imports
				// to every server module the client might RPC into.
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
			id = normalizeVirtualSpecifier(id);
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
			// workflow) map to real files under `@kuratchi/koze/runtime/`.
			// Resolve against the PLUGIN's own require context so the host
			// app doesn't have to list `koze` as a direct dep.
			if (
				isKuratchiVirtualModule(id) &&
				!id.startsWith('koze:routes') &&
				!id.startsWith('koze:manifest') &&
				!id.startsWith('koze:dispatch') &&
				!id.startsWith('koze:layout') &&
				!id.startsWith('koze:app') &&
				!id.startsWith('koze:worker') &&
				!id.startsWith('koze:content') &&
				!id.startsWith('koze:client')
			) {
				const target = resolveKuratchiVirtualModule(id);
				if (target !== id) {
					return resolveKuratchiRuntimeFile(target);
				}
			}
			return null;
		},

		async load(id) {
			id = normalizeVirtualSpecifier(id);
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
				return generateWorkerModule(
					conventionClasses,
					queueConsumers,
					workflowRegistry,
					pipelineRegistry,
					durableObjectConfig,
					durableObjectHandlers,
				);
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
					return transformAppFile(source, hasGlobalCss, clientFragments, isProduction, rootAppPath);
				}
				// Legacy shape: layout.koze owns the shell — app becomes a pass-through.
				if (layoutIsLegacyShell) {
					return 'export const hasApp = false;\nexport const render = async (_data, content) => content;\n';
				}
				// Default shell — no app.koze in the project.
				return transformAppFile(DEFAULT_APP_SHELL, hasGlobalCss);
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
				isRouteFile(fileId, projectRoot, options.routesDir, options.api.root)
			) {
				if (isApiRouteFile(fileId, projectRoot, options.api.root)) return null;
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
			// Type generation: regenerate `src/app.d.ts` whenever the
			// schema source or any typed convention file changes so the
			// IDE picks up new column types, workflow names, and pipeline names. The
			// `writeAppTypes` call is idempotent — it short-circuits
			// when the output bytes are unchanged, so editing an
			// unrelated server file doesn't thrash the file (which
			// would otherwise trigger Vite's watcher in a loop). The
			// schema path defaults to `src/server/schema.ts`; multi-
			// schema apps using `src/server/schemas/*` won't see DB
			// row types regenerated, which apps/web ships fine without.
			const schemaAbsPath = path.resolve(projectRoot, 'src', 'server', 'schema.ts');
			const isWorkflowFile = file.endsWith('.workflow.ts');
			const isPipelineFile = file.endsWith('.pipeline.ts');
			const contentRootAbs = path.resolve(projectRoot, 'src', 'content');
			const isContentFile = file.startsWith(contentRootAbs + path.sep) && file.toLowerCase().endsWith('.md');
			if (file === schemaAbsPath || isWorkflowFile || isPipelineFile || isContentFile) {
				try {
					writeAppTypes({ projectDir: projectRoot });
				} catch (err) {
					// Type generation failures should never block HMR.
					// Surface them in the dev console and continue.
					// eslint-disable-next-line no-console
					console.warn('[koze] writeAppTypes failed:', (err as Error).message);
				}
			}

			const apiRootAbs = path.resolve(projectRoot, options.api.root);
			const isApiShieldOwnedFile = file.startsWith(apiRootAbs + path.sep) &&
				(/\.(ts|js)$/i.test(file) || API_SHIELD_SIDECAR_RE.test(file));
			if (isApiShieldOwnedFile) {
				try {
					writeApiShieldOpenApi({
						projectDir: projectRoot,
						routes: routes
							.filter((route) => route.type === 'api')
							.map((route) => readApiShieldRouteMetadata({
								projectDir: projectRoot,
								pattern: route.urlPattern,
								fullPath: route.absPath,
							})),
						options: options.apiShield,
						writeFile: writeIfChanged,
					});
				} catch (err) {
					// API Shield artifact generation is advisory during dev.
					// eslint-disable-next-line no-console
					console.warn('[koze] API Shield OpenAPI generation failed:', (err as Error).message);
				}
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
				options.api.root,
				allLayoutPaths,
				rootAppPath,
				rootLayoutPath,
				routes,
				componentImporters,
				layoutDependents,
			);
			if (isContentFile) {
				virtualIds.push(RESOLVED_VIRTUAL_CONTENT_ID);
			}
			const fragmentOwner =
				file === rootAppPath ||
				isRouteFile(file, projectRoot, options.routesDir, options.api.root);
			const clientFragmentIds = fragmentOwner
				? (await refreshClientFragmentsForImporter(
					file,
					clientFragments,
					isProduction,
					projectRoot,
					options.api.root,
					componentCompiler ?? undefined,
				)).map(
					(hash) => CLIENT_VIRTUAL_PREFIX + hash + '.ts',
				)
				: [];

			// If this file has no framework relationship, fall through
			// to Vite's default behavior (returning undefined preserves
			// the standard module-graph traversal for normal imports).
			if (virtualIds.length === 0 && clientFragmentIds.length === 0 && !structural) return undefined;

			// Structural changes to the routes tree (file added or
			// removed under `src/routes/`) require re-running discovery
			// and invalidating the manifest module so the next request
			// picks up the new route set.
			if (structural || isRouteFile(file, projectRoot, options.routesDir, options.api.root)) {
				routes = discoverRoutes(projectRoot, options.routesDir, options.api.root, options.api.urlPrefix);
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

			if (fragmentOwner) {
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

function discoverRoutes(
	projectRoot: string,
	routesDir: string,
	apiRoot: string,
	apiUrlPrefix: string,
): DiscoveredRoute[] {
	const routesAbs = path.resolve(projectRoot, routesDir);
	const apiAbs = path.resolve(projectRoot, apiRoot);
	const out: DiscoveredRoute[] = [];
	if (fs.existsSync(routesAbs)) {
		walk(routesAbs, (file) => {
			if (!isPageRouteFile(file)) return;
			if (isUnderApiRoot(file, projectRoot, apiRoot)) return;
			const rel = path.relative(routesAbs, file);
			const basename = path.basename(file);
			const stem = stripRouteSourceExtension(basename);
			if (stem === ROUTE_LAYOUT_BASENAME || stem === 'error') return;
			const urlPattern = pathToUrlPattern(rel);
			const id = stripRouteSourceExtension(rel).replace(/[\\/]/g, '__');
			if (out.some((route) => route.type === 'page' && route.id === id)) {
				throw new Error(`[koze] Duplicate route source for "${urlPattern}". Keep either the .koze or .kuratchi file, not both.`);
			}
			out.push({ absPath: file, urlPattern, id, type: 'page' });
		});
	}
	if (fs.existsSync(apiAbs)) {
		walk(apiAbs, (file) => {
			if (!API_ROUTE_RE.test(file) || API_SHIELD_SIDECAR_RE.test(file)) return;
			const rel = path.relative(apiAbs, file);
			const urlPattern = apiPathToUrlPattern(rel, apiUrlPrefix);
			const id = `api__${rel.replace(/[\\/]/g, '__').replace(/\.(ts|js)$/, '')}`;
			out.push({ absPath: file, urlPattern, id, type: 'api' });
		});
	}
	out.sort((a, b) => {
		const aParam = (a.urlPattern.match(/:/g) ?? []).length;
		const bParam = (b.urlPattern.match(/:/g) ?? []).length;
		if (aParam !== bParam) return aParam - bParam;
		return b.urlPattern.length - a.urlPattern.length;
	});
	return out;
	/*
	walk(routesAbs, (file) => {
		const rel = path.relative(routesAbs, file);
		const basename = path.basename(file);
		const isPageRoute = file.endsWith(ROUTE_EXT);
		const isApiRoute = isApiRouteFile(file, projectRoot, apiRoot);
		if (!isPageRoute && !isApiRoute) return;
		if (isApiRoute) {
			const siblingPage = path.join(path.dirname(file), 'index' + ROUTE_EXT);
			if (fs.existsSync(siblingPage)) return;
		}
		if (isPageRoute) {
			const stem = basename.replace(new RegExp(`\\${ROUTE_EXT}$`), '');
			if (stem === ROUTE_LAYOUT_BASENAME || stem === 'error') return;
		}
		const urlPattern = pathToUrlPattern(rel);
		const id = rel.replace(/[\\/]/g, '__').replace(/\.(kuratchi|ts|js)$/, '');
		out.push({ absPath: file, urlPattern, id, type: isApiRoute ? 'api' : 'page' });
	});
	out.sort((a, b) => {
		const aParam = (a.urlPattern.match(/:/g) ?? []).length;
		const bParam = (b.urlPattern.match(/:/g) ?? []).length;
		if (aParam !== bParam) return aParam - bParam;
		return b.urlPattern.length - a.urlPattern.length;
	});
	return out;
	walk(abs, (file) => {
		if (!file.endsWith(ROUTE_EXT)) return;
		// Skip layout + error page files — they're not addressable routes.
		const basename = path.basename(file).replace(new RegExp(`\\${ROUTE_EXT}$`), '');
		if (basename === ROUTE_LAYOUT_BASENAME || basename === 'error') return;
		const rel = path.relative(abs, file);
		const urlPattern = pathToUrlPattern(rel);
		const id = rel.replace(/[\\/]/g, '__').replace(new RegExp(`\\${ROUTE_EXT}$`), '');
		out.push({ absPath: file, urlPattern, id, type: 'page' });
	});
	out.sort((a, b) => {
		const aParam = (a.urlPattern.match(/:/g) ?? []).length;
		const bParam = (b.urlPattern.match(/:/g) ?? []).length;
		if (aParam !== bParam) return aParam - bParam;
		return b.urlPattern.length - a.urlPattern.length;
	});
	return out;
	*/
}

function walk(dir: string, visit: (file: string) => void) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, visit);
		else if (entry.isFile()) visit(full);
	}
}

/**
 * Look for a root layout at `routes/layout.koze`.
 * Returns the first match, or null.
 */
function discoverRootLayout(projectRoot: string, routesDir: string): string | null {
	const abs = path.resolve(projectRoot, routesDir);
	return resolveSourceSibling(abs, ROUTE_LAYOUT_BASENAME);
}

/**
 * Walk the routes tree and collect every `layout.koze` at any depth.
 * The root layout (`routes/layout.koze`) is included.
 *
 * Returns absolute paths. The caller builds a per-route chain by
 * filtering this list down to ancestors of each route; see
 * `layoutChainForRoute`.
 */
function discoverAllLayouts(projectRoot: string, routesDir: string): string[] {
	const abs = path.resolve(projectRoot, routesDir);
	const out: string[] = [];
	const visit = (dir: string) => {
		if (!fs.existsSync(dir)) return;
		const candidate = resolveSourceSibling(dir, ROUTE_LAYOUT_BASENAME);
		if (candidate) out.push(candidate);
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) visit(path.join(dir, entry.name));
		}
	};
	visit(abs);
	return out;
}

/**
 * Given a route file's absolute path, return the ordered chain of
 * layouts that wrap it, outermost first. A layout at
 * `routes/foo/layout.koze` wraps every route under `routes/foo/**`.
 *
 * Output contract:
 *   chain[0]  — outermost layout (closest to the root)
 *   chain[n]  — innermost layout (deepest directory)
 *
 * Composition at render time is the reverse: the innermost layout
 * wraps the route's HTML first, then the next one out, then the
 * outermost. See the route-emission code for the wrapping order.
 */
function layoutChainForRoute(
	routeAbsPath: string,
	allLayouts: string[],
	routesAbsDir: string,
): string[] {
	// Pick every layout whose directory is an ancestor of the route
	// (including the layout's own directory, so a page at
	// `routes/foo/index.koze` gets wrapped by
	// `routes/foo/layout.koze`). Eligibility is: the layout's
	// directory must contain the route file's directory, AND the
	// route must live under `routesAbsDir` at all.
	const routeDir = path.dirname(routeAbsPath);
	if (!isPathWithin(routeDir, routesAbsDir)) return [];
	const eligible = allLayouts.filter((layoutPath) => {
		const layoutDir = path.dirname(layoutPath);
		return isPathWithin(routeDir, layoutDir);
	});
	// Sort outermost → innermost. Shorter directory path = outer.
	eligible.sort((a, b) => path.dirname(a).length - path.dirname(b).length);
	return eligible;
}

/**
 * True when `descendant` is `ancestor` itself or any subdirectory of it.
 * Used by `layoutChainForRoute` to pick ancestor layouts.
 */
function isPathWithin(descendant: string, ancestor: string): boolean {
	const rel = path.relative(ancestor, descendant);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Look for the document shell at `src/app.koze` — a framework-level
 * file, not a route. Mirrors SvelteKit's `src/app.html`, Next.js's
 * `app/layout.tsx`, and Remix's `app/root.tsx` conventions: the root
 * shell sits alongside `src/worker.ts` and `src/middleware.ts`, leaving
 * `src/routes/` for layouts and pages only.
 *
 * Returns the absolute path, or `null` when the project doesn't ship
 * one (in which case the framework synthesizes a minimal default).
 */
function discoverRootApp(projectRoot: string, _routesDir: string): string | null {
	// The `src/` location is derived from the canonical kuratchi layout
	// so we don't tie it to the routes dir. Changing the routes dir
	// doesn't move the shell.
	return resolveSourceSibling(path.resolve(projectRoot, 'src'), ROUTE_APP_BASENAME);
}

/**
 *   routes/index.koze           -> '/'
 *   routes/about.koze           -> '/about'
 *   routes/users/index.koze     -> '/users'
 *   routes/users/[id].koze      -> '/users/:id'
 *   routes/posts/[...slug].koze -> '/posts/*slug'
 */
function pathToUrlPattern(rel: string): string {
	const withoutExt = rel.replace(/\.(koze|kuratchi|ts|js)$/, '');
	const segments = withoutExt.split(/[\\/]/).filter((s) => s !== 'index');
	const mapped = segments.map((s) => {
		const rest = s.match(/^\[\.\.\.([^\]]+)\]$/);
		if (rest) return '*' + rest[1];
		const param = s.match(/^\[([^\]]+)\]$/);
		if (param) return ':' + param[1];
		return s;
	});
	return '/' + mapped.join('/');
}

function apiPathToUrlPattern(rel: string, apiUrlPrefix: string): string {
	const withoutExt = rel.replace(/\.(ts|js)$/, '');
	const fileSegments = withoutExt.split(/[\\/]/).filter((segment) => segment !== 'index');
	const prefixSegments = apiUrlPrefix === '/'
		? []
		: apiUrlPrefix.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
	const mapped = [...prefixSegments, ...fileSegments].map((segment) => {
		const rest = segment.match(/^\[\.\.\.([^\]]+)\]$/);
		if (rest) return '*' + rest[1];
		const param = segment.match(/^\[([^\]]+)\]$/);
		if (param) return ':' + param[1];
		return segment;
	});
	return '/' + mapped.join('/');
}

function isUnderRoutesDir(file: string, projectRoot: string, routesDir: string): boolean {
	const abs = path.resolve(projectRoot, routesDir);
	const rel = path.relative(abs, file);
	return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isUnderApiRoot(file: string, projectRoot: string, apiRoot: string): boolean {
	const abs = path.resolve(projectRoot, apiRoot);
	const rel = path.relative(abs, file);
	return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isApiRouteFile(filePath: string, projectRoot: string, apiRoot: string): boolean {
	return API_ROUTE_RE.test(filePath) && !API_SHIELD_SIDECAR_RE.test(filePath) && isUnderApiRoot(filePath, projectRoot, apiRoot);
}

function isRouteFile(
	filePath: string,
	projectRoot: string,
	routesDir: string,
	apiRoot: string,
): boolean {
	return (
		(isPageRouteFile(filePath) && isUnderRoutesDir(filePath, projectRoot, routesDir)) ||
		isApiRouteFile(filePath, projectRoot, apiRoot)
	);
}

/**
 * Track that `importerAbsPath` (a route or layout) compiled with the
 * given `componentAbsPath` baked into its emitted module. The reverse
 * index is consulted by `handleHotUpdate` so editing a component file
 * invalidates exactly the route + layout virtual modules that need to
 * re-emit, without falling back to a server restart.
 *
 * Idempotent: re-registering the same pair is a no-op.
 */
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
	apiRoot: string,
	componentCompiler?: ComponentCompiler,
): Promise<string[]> {
	const previousHashes = collectClientFragmentHashesForImporter(clientFragments, sourceFile);
	for (const hash of previousHashes) {
		clientFragments.delete(hash);
	}
	if (isApiRouteFile(sourceFile, projectRoot, apiRoot)) {
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
	apiRoot: string,
	allLayoutPaths: string[],
	rootAppPath: string | null,
	rootLayoutPath: string | null,
	routes: DiscoveredRoute[],
	componentImporters: Map<string, Set<string>>,
	layoutDependents: Map<string, Set<string>>,
): { virtualIds: string[]; structural: boolean } {
	const ids = new Set<string>();
	let structural = false;

	const isRoute = isRouteFile(file, projectRoot, routesDir, apiRoot);
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
		if (route) {
			ids.add('\0' + VIRTUAL_ROUTE_PREFIX + routeModuleHash(route.absPath));
		} else {
			// Route file exists on disk but wasn't in our `routes` array
			// yet — this is a structural change (new file). Bump the
			// manifest so discoverRoutes runs again.
			structural = true;
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

	// `$server/<x>.ts` edit: the rpc-map imports every server module
	// the client env has resolved. Invalidate to pick up the changed
	// module on next dispatch. Detection is "lives under serverDir"
	// — the plugin doesn't track which serverDir the user configured
	// here, so we conservatively treat any .ts under `src/server/`
	// as RPC-affecting. False positives (server util that nothing
	// imports) cost a single virtual-module re-emit, which is cheap.
	const serverAbsRoot = path.resolve(projectRoot, 'src', 'server');
	const relToServer = path.relative(serverAbsRoot, file);
	if (relToServer && !relToServer.startsWith('..') && !path.isAbsolute(relToServer) && file.endsWith('.ts')) {
		ids.add(RESOLVED_VIRTUAL_RPC_MAP_ID);
		// Worker convention re-exports happen for *.workflow.ts /
		// *.do.ts / *.sandbox.ts / *.container.ts / *.queue.ts files —
		// adding/removing these requires the worker module to re-emit
		// its named exports. Treat as structural so the worker module
		// invalidates too.
		if (/\.(workflow|do|sandbox|container|queue|pipeline)\.ts$/.test(file)) {
			ids.add(RESOLVED_VIRTUAL_WORKER_ID);
		}
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
function leadingScriptHash(importerAbsPath: string, source: string): string {
	return crypto
		.createHash('sha1')
		.update('leading:' + importerAbsPath + '\0' + source)
		.digest('hex')
		.slice(0, 12);
}

/**
 * Inspect the leading-script source and return the names of every
 * top-level declaration whose initializer reaches an `await` at module
 * evaluation time. Those are the SSR-resolved values the server computes
 * per request; we serialize them into the HTML payload so the client
 * copy of the script can read them without re-running the work.
 *
 * Supported initializer shapes:
 *   const X = await fn();                           // direct
 *   const X = cond ? await fn() : other;            // ternary (either branch)
 *   const X = cond ? other : await fn();
 *   const X = (await fn());                         // parenthesized
 *   const X = (a, await fn());                      // sequence (rare)
 *
 * Nested awaits inside arrow bodies / functions / blocks are NOT
 * collected — those don't fire at module-eval time.
 */
function initializerContainsTopLevelAwait(expr: ts.Expression): boolean {
	if (ts.isAwaitExpression(expr)) return true;
	if (ts.isParenthesizedExpression(expr)) {
		return initializerContainsTopLevelAwait(expr.expression);
	}
	if (ts.isConditionalExpression(expr)) {
		return (
			initializerContainsTopLevelAwait(expr.whenTrue) ||
			initializerContainsTopLevelAwait(expr.whenFalse)
		);
	}
	if (ts.isBinaryExpression(expr)) {
		// Logical / nullish short-circuit: `x ?? await fn()`, `x || await fn()`.
		const op = expr.operatorToken.kind;
		if (
			op === ts.SyntaxKind.QuestionQuestionToken ||
			op === ts.SyntaxKind.AmpersandAmpersandToken ||
			op === ts.SyntaxKind.BarBarToken ||
			op === ts.SyntaxKind.CommaToken
		) {
			return (
				initializerContainsTopLevelAwait(expr.left) ||
				initializerContainsTopLevelAwait(expr.right)
			);
		}
		return false;
	}
	return false;
}

/**
 * Walk the subtree under `node` (without crossing into nested functions,
 * arrow bodies, class/method bodies — those don't execute at module-eval
 * time) and report whether any `await` expression lives within. Used to
 * classify top-level statements: anything that contains an await is SSR-
 * only work and gets stripped from the browser bundle.
 */
function containsAwaitInControlFlow(node: ts.Node): boolean {
	if (ts.isAwaitExpression(node)) return true;
	// Stop at any construct that creates a new callable boundary. `await`
	// inside a function body will fire only if the function is invoked,
	// which we can't know statically — err on the side of preserving.
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isClassDeclaration(node) ||
		ts.isClassExpression(node)
	) {
		return false;
	}
	let found = false;
	node.forEachChild((child) => {
		if (found) return;
		if (containsAwaitInControlFlow(child)) found = true;
	});
	return found;
}

/**
 * Walk the subtree under `node` (same "no-function-body" rule as above)
 * and collect every identifier that appears as the LHS of an assignment
 * (plain `=`, compound `+=`, `-=`, etc.) or as the operand of `++`/`--`.
 * Only bare identifiers are collected — property-access targets like
 * `obj.field = …` are ignored (they mutate the object the hydrated
 * binding points to, not the binding itself, so hydration still works).
 */
function collectReassignedIdentifiers(node: ts.Node, out: Set<string>): void {
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isClassDeclaration(node) ||
		ts.isClassExpression(node)
	) {
		return;
	}
	if (ts.isBinaryExpression(node)) {
		const op = node.operatorToken.kind;
		const isAssignmentOp =
			op === ts.SyntaxKind.EqualsToken ||
			op === ts.SyntaxKind.PlusEqualsToken ||
			op === ts.SyntaxKind.MinusEqualsToken ||
			op === ts.SyntaxKind.AsteriskEqualsToken ||
			op === ts.SyntaxKind.SlashEqualsToken ||
			op === ts.SyntaxKind.PercentEqualsToken ||
			op === ts.SyntaxKind.AmpersandEqualsToken ||
			op === ts.SyntaxKind.BarEqualsToken ||
			op === ts.SyntaxKind.CaretEqualsToken ||
			op === ts.SyntaxKind.QuestionQuestionEqualsToken ||
			op === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
			op === ts.SyntaxKind.BarBarEqualsToken ||
			op === ts.SyntaxKind.LessThanLessThanEqualsToken ||
			op === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
			op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken;
		if (isAssignmentOp && ts.isIdentifier(node.left)) {
			out.add(node.left.text);
		}
	}
	if (
		(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
		(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
		ts.isIdentifier(node.operand)
	) {
		out.add(node.operand.text);
	}
	node.forEachChild((child) => collectReassignedIdentifiers(child, out));
}

function collectBindingIdentifiers(name: ts.BindingName, out: string[]): void {
	if (ts.isIdentifier(name)) {
		out.push(name.text);
		return;
	}
	for (const element of name.elements) {
		if (ts.isOmittedExpression(element)) continue;
		collectBindingIdentifiers(element.name, out);
	}
}

export interface LeadingHydrateTargets {
	/**
	 * Top-level `const|let|var X = await …` identifiers (plus ternary /
	 * short-circuit variants). The initializer itself reaches an `await`
	 * at module-eval time — the entire declaration is rewritten on the
	 * client to read from the hydrate payload.
	 */
	initAwaitVars: string[];
	/**
	 * Top-level `let X = <literal>` identifiers (or `let X;`) that are
	 * reassigned from within a statement whose body contains an `await`.
	 * These are the "imperative SSR lets" pattern — declared with a
	 * placeholder, mutated inside `if/try/…` blocks that do async work.
	 * The client rewrite is: keep the declaration, seed its initializer
	 * from the hydrate payload (falling back to the original init so
	 * unhydrated reruns don't crash), then strip the async blocks that
	 * mutate it since those values are already the SSR-final values.
	 */
	reassignedLets: string[];
}

function collectLeadingHydrateTargets(scriptBody: string): LeadingHydrateTargets {
	const empty: LeadingHydrateTargets = { initAwaitVars: [], reassignedLets: [] };
	if (!scriptBody.trim()) return empty;
	let sourceFile: ts.SourceFile;
	try {
		sourceFile = ts.createSourceFile(
			'kuratchi-leading-script.ts',
			scriptBody,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
	} catch {
		return empty;
	}

	const initAwaitVars: string[] = [];
	// Map every top-level `let` identifier to its declaration so we can
	// decide later whether to hydrate. `const` bindings can't be reassigned
	// so there's no point collecting them here — their initializer was
	// already handled by `initAwaitVars` above.
	const topLevelLets = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		const isLet = (statement.declarationList.flags & ts.NodeFlags.Let) !== 0;
		const isVar =
			(statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
		for (const decl of statement.declarationList.declarations) {
			if (decl.initializer && initializerContainsTopLevelAwait(decl.initializer)) {
				const names: string[] = [];
				collectBindingIdentifiers(decl.name, names);
				initAwaitVars.push(...names);
				continue;
			}
			if (!ts.isIdentifier(decl.name)) continue;
			const name = decl.name.text;
			if (isLet || isVar) topLevelLets.add(name);
		}
	}

	// Walk each top-level statement. If the statement body contains an
	// `await` (via `containsAwaitInControlFlow`), collect the identifiers
	// it reassigns. Any of those identifiers that is ALSO a top-level
	// `let`/`var` becomes a hydration target.
	const reassignedLets = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (ts.isVariableStatement(statement)) continue; // declarations themselves handled above
		if (!containsAwaitInControlFlow(statement)) continue;
		const reassigned = new Set<string>();
		collectReassignedIdentifiers(statement, reassigned);
		for (const name of reassigned) {
			if (topLevelLets.has(name)) reassignedLets.add(name);
		}
	}

	return {
		initAwaitVars,
		reassignedLets: Array.from(reassignedLets),
	};
}

/**
 * AST-driven rewrite that transforms the leading script's source into its
 * browser-shaped equivalent. Two concerns, both at module-top-level:
 *
 *   1. "Init-await" declarations (`const X = await fn()`, incl. ternary/
 *      short-circuit variants): the whole declaration's initializer is
 *      swapped for `__kozeReadData("X")`. Type annotation dropped —
 *      the SSR-serialized value is the source of truth.
 *
 *   2. "Reassigned-let" declarations (`let X = <literal>` mutated from
 *      inside a top-level block that contains an `await`): the
 *      declaration is preserved but its initializer becomes
 *      `__kozeReadData("X") ?? <originalInitOrUndefined>`. Then every
 *      top-level statement whose body contains an `await` is stripped,
 *      because it exists only to populate those lets — and the hydration
 *      payload already carries the post-eval result.
 *
 * Everything else — helper functions, non-async branches, template
 * expressions — passes through untouched. We use the TypeScript compiler
 * API to guarantee we handle multi-line initializers, comments, template
 * literals, and nested ternaries correctly. Regex-based replacement would
 * misfire on any of those.
 */
function rewriteLeadingScriptForBrowser(
	scriptBody: string,
	initAwaitVars: Set<string>,
	reassignedLets: Set<string>,
): string {
	const sourceFile = ts.createSourceFile(
		'kuratchi-leading-script.ts',
		scriptBody,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

	const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });

	const makeHydrateRead = (factory: ts.NodeFactory, name: string): ts.CallExpression =>
		factory.createCallExpression(
			factory.createIdentifier('__kozeReadData'),
			undefined,
			[factory.createStringLiteral(name)],
		);

	const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
		const factory = context.factory;
		return (file) => {
			const newStatements: ts.Statement[] = [];
			for (const statement of file.statements) {
				// Variable declarations get rewritten to pull from hydrate.
				if (ts.isVariableStatement(statement)) {
					const decls: ts.VariableDeclaration[] = [];
					for (const decl of statement.declarationList.declarations) {
						if (!ts.isIdentifier(decl.name)) {
							if (decl.initializer && initializerContainsTopLevelAwait(decl.initializer)) {
								const names: string[] = [];
								collectBindingIdentifiers(decl.name, names);
								for (const name of names) {
									if (!initAwaitVars.has(name)) continue;
									decls.push(
										factory.createVariableDeclaration(
											factory.createIdentifier(name),
											undefined,
											undefined,
											makeHydrateRead(factory, name),
										),
									);
								}
							} else {
								decls.push(decl);
							}
							continue;
						}
						const name = decl.name.text;
						if (initAwaitVars.has(name)) {
							decls.push(factory.updateVariableDeclaration(
								decl,
								decl.name,
								decl.exclamationToken,
								undefined, // drop type — SSR value wins
								makeHydrateRead(factory, name),
							));
							continue;
						}
						if (reassignedLets.has(name)) {
							// Preserve the original initializer (or `undefined`
							// if `let X;` with no init) as a fallback. `??`
							// is correct: JSON.parse can't produce `undefined`,
							// so `null`-valued hydrates fall through to the
							// author's original init, matching SSR behavior.
							const fallback = decl.initializer ?? factory.createIdentifier('undefined');
							const hydrateWithFallback = factory.createBinaryExpression(
								makeHydrateRead(factory, name),
								factory.createToken(ts.SyntaxKind.QuestionQuestionToken),
								fallback,
							);
							decls.push(factory.updateVariableDeclaration(
								decl,
								decl.name,
								decl.exclamationToken,
								undefined,
								hydrateWithFallback,
							));
							continue;
						}
						decls.push(decl);
					}
					newStatements.push(
						factory.updateVariableStatement(
							statement,
							statement.modifiers,
							factory.updateVariableDeclarationList(statement.declarationList, decls),
						),
					);
					continue;
				}

				// Top-level statements whose bodies contain `await` exist only
				// to populate the SSR lets we just hydrated. On the client
				// those lets already carry the post-eval values, so we skip
				// the whole statement. Nested functions are NOT flagged by
				// `containsAwaitInControlFlow` (they might be referenced by
				// event handlers that DO run client-side), so that path is
				// preserved.
				if (containsAwaitInControlFlow(statement)) continue;

				newStatements.push(statement);
			}

			return factory.updateSourceFile(file, newStatements);
		};
	};

	const result = ts.transform(sourceFile, [transformer]);
	const printed = printer.printFile(result.transformed[0] as ts.SourceFile);
	result.dispose();
	return printed;
}

/**
 * Produce the BROWSER-SHAPE version of the leading script. Three changes:
 *
 *   1. Top-level `const|let|var X = await …` declarations are rewritten to
 *      `const X = (typeof window !== 'undefined' && window.__kozeData)
 *        ? window.__kozeData.X : undefined;`
 *      so the client can read the value the server computed. `await`
 *      cannot run in a non-async module-eval context against a `$server/*`
 *      RPC stub without turning the top-level script into an async
 *      sequence; hydration keeps evaluation synchronous and predictable.
 *
 *   2. `import … from 'koze:request'` is replaced with synthesized
 *      `const` declarations reading from `window.location`, so the same
 *      aliases (`params`, `searchParams`, `pathname`, etc.) resolve in
 *      the browser.
 *
 *   3. `import … from 'koze:environment'` is replaced with a literal
 *      `const dev = <bool>;` matching the build-time env.
 *
 * Everything else — `$server/*` imports, `$lib/*` imports, helper
 * functions, non-await top-level consts, event listeners, etc. —
 * passes through unchanged. `$server/*` imports become RPC stubs
 * transparently via the existing client-env resolver.
 */
/**
 * Prepended to every leading-script browser bundle. Reads the JSON blob
 * the server inlined under `<script type="application/json"
 * id="__koze_data">`. Using `application/json` keeps the browser's
 * script parser in data mode — the payload is never interpreted as JS
 * even if it contains `</script>`-like sequences or looks like code — so
 * authors can stare at View Source without worrying what's "live" there.
 *
 * If the element is missing (route shipped with no SSR data, or the
 * script runs in a stale page) the helper returns `undefined`; author
 * code is expected to have started with `x && x.foo` idioms anyway.
 */
const LEADING_FRAGMENT_HYDRATE_PRELUDE = `// koze: SSR data hydrate helper
const __kozeReadData = (key) => {
	if (typeof document === 'undefined') return undefined;
	const nodes = Array.from(document.querySelectorAll('#__koze_data'));
	if (nodes.length === 0) return undefined;
	const merged = {};
	for (const el of nodes) {
		if (!el || !el.textContent) continue;
		try {
			const data = JSON.parse(el.textContent);
			if (data && typeof data === 'object') Object.assign(merged, data);
		} catch {
			// Ignore malformed fragments and keep scanning later blobs.
		}
	}
	return merged == null ? undefined : merged[key];
};
`;

function removeSourceRanges(source: string, ranges: Array<{ start: number; end: number }>): string {
	if (ranges.length === 0) return source;
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	let cursor = 0;
	let out = '';
	for (const range of sorted) {
		out += source.slice(cursor, range.start);
		cursor = range.end;
	}
	out += source.slice(cursor);
	return out.trim();
}

function statementRemovalRange(source: string, statement: ts.Statement): { start: number; end: number } {
	let start = statement.getFullStart();
	let end = statement.end;
	if (source[end] === ';') end += 1;
	while (end < source.length && (source[end] === ' ' || source[end] === '\t')) end += 1;
	if (source[end] === '\r' && source[end + 1] === '\n') end += 2;
	else if (source[end] === '\n') end += 1;
	return { start, end };
}

function stripRouteServerOnlyPartsForClient(source: string): string {
	const sourceFile = ts.createSourceFile(
		'koze-client-route.ts',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const ranges: Array<{ start: number; end: number }> = [];
	for (const statement of sourceFile.statements) {
		if (
			ts.isImportDeclaration(statement) &&
			ts.isStringLiteral(statement.moduleSpecifier) &&
			statement.moduleSpecifier.text === 'cloudflare:workers' &&
			!statement.importClause?.isTypeOnly
		) {
			ranges.push(statementRemovalRange(source, statement));
			continue;
		}
		if (
			ts.isFunctionDeclaration(statement) &&
			statement.name?.text === 'load' &&
			statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
		) {
			ranges.push(statementRemovalRange(source, statement));
		}
	}
	return removeSourceRanges(source, ranges);
}

function mergeImportDeclarations(source: string): string {
	if (!source.trim()) return source;
	const sourceFile = ts.createSourceFile(
		'kuratchi-merged-imports.ts',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
	const moduleEntries = new Map<string, {
		defaultImport: string | null;
		namespaceImport: string | null;
		named: Map<string, string>;
		sideEffectOnly: boolean;
	}>();
	const passthrough: ts.Statement[] = [];

	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
			passthrough.push(statement);
			continue;
		}
		const moduleSpecifier = statement.moduleSpecifier.text;
		const entry = moduleEntries.get(moduleSpecifier) ?? {
			defaultImport: null,
			namespaceImport: null,
			named: new Map<string, string>(),
			sideEffectOnly: false,
		};
		const clause = statement.importClause;
		if (!clause) {
			entry.sideEffectOnly = true;
			moduleEntries.set(moduleSpecifier, entry);
			continue;
		}
		if (clause.name && !entry.defaultImport) entry.defaultImport = clause.name.text;
		if (clause.namedBindings) {
			if (ts.isNamespaceImport(clause.namedBindings)) {
				if (!entry.namespaceImport) entry.namespaceImport = clause.namedBindings.name.text;
			} else if (ts.isNamedImports(clause.namedBindings)) {
				for (const element of clause.namedBindings.elements) {
					const localName = element.name.text;
					if (entry.named.has(localName)) continue;
					entry.named.set(localName, element.propertyName?.text ?? localName);
				}
			}
		}
		moduleEntries.set(moduleSpecifier, entry);
	}

	const importStatements: ts.Statement[] = [];
	for (const [moduleSpecifier, entry] of moduleEntries) {
		if (entry.sideEffectOnly && !entry.defaultImport && !entry.namespaceImport && entry.named.size === 0) {
			importStatements.push(ts.factory.createImportDeclaration(
				undefined,
				undefined,
				ts.factory.createStringLiteral(moduleSpecifier),
				undefined,
			));
			continue;
		}
		const namedImports = entry.named.size > 0
			? ts.factory.createNamedImports(
				Array.from(entry.named.entries()).map(([localName, importedName]) =>
					ts.factory.createImportSpecifier(
						false,
						importedName === localName ? undefined : ts.factory.createIdentifier(importedName),
						ts.factory.createIdentifier(localName),
					),
				),
			)
			: undefined;
		const namedBindings = entry.namespaceImport
			? ts.factory.createNamespaceImport(ts.factory.createIdentifier(entry.namespaceImport))
			: namedImports;
		importStatements.push(ts.factory.createImportDeclaration(
			undefined,
			ts.factory.createImportClause(
				false,
				entry.defaultImport ? ts.factory.createIdentifier(entry.defaultImport) : undefined,
				namedBindings,
			),
			ts.factory.createStringLiteral(moduleSpecifier),
			undefined,
		));
	}

	const mergedSourceFile = ts.factory.updateSourceFile(
		sourceFile,
		ts.factory.createNodeArray([...importStatements, ...passthrough]),
	);
	return printer.printFile(mergedSourceFile);
}

function transformLeadingScriptForClient(
	scriptBody: string,
	hydrateTargets: LeadingHydrateTargets,
	requestImports: Array<{ exportName: string; alias: string }>,
	isProduction: boolean,
	reactiveNames?: Iterable<string>,
	blockRenderersExpr?: string,
	actionAliases: AugmentedActionAlias[] = [],
	extraScopeNames?: Iterable<string>,
	ownerId?: string,
): string {
	// 1. Rewrite the script body for the browser:
	//    - init-await declarations: initializer swapped for hydrate read
	//    - reassigned-let declarations: initializer wrapped in a hydrate
	//      read with `??` fallback to the original literal
	//    - every top-level statement whose body contains `await`:
	//      dropped, since those ran SSR and their effects were serialized
	let out = scriptBody;
	const hadReactiveSyntax = /\$\s*:/.test(scriptBody);
	out = stripRouteServerOnlyPartsForClient(out);
	if (hydrateTargets.initAwaitVars.length > 0 || hydrateTargets.reassignedLets.length > 0) {
		out = rewriteLeadingScriptForBrowser(
			out,
			new Set(hydrateTargets.initAwaitVars),
			new Set(hydrateTargets.reassignedLets),
		);
	}

	// 2. Swap `koze:request` imports for browser-readable aliases.
	// `params` reads from the SSR-hydrated data blob (route params aren't
	// visible to `window.location` alone — they come from the matched
	// route pattern). Everything else derives from `window.location`.
	if (requestImports.length > 0) {
		out = out.replace(
			/import\s*\{[^}]*\}\s*from\s*['"](?:koze|kuratchi):request['"]\s*;?\s*/g,
			'',
		);
		const lines: string[] = [
			`const __kozeUrl = new URL(window.location.href);`,
			`const __kozeParams = __kozeReadData('__params') ?? {};`,
		];
		for (const imp of requestImports) {
			switch (imp.exportName) {
				case 'url':
					lines.push(`const ${imp.alias} = __kozeUrl;`);
					break;
				case 'pathname':
					lines.push(`const ${imp.alias} = __kozeUrl.pathname;`);
					break;
				case 'searchParams':
					lines.push(`const ${imp.alias} = __kozeUrl.searchParams;`);
					break;
				case 'params':
					lines.push(`const ${imp.alias} = __kozeParams;`);
					break;
				case 'slug':
					lines.push(
						`const ${imp.alias} = __kozeParams.slug ?? Object.values(__kozeParams)[0];`,
					);
					break;
				case 'method':
					lines.push(`const ${imp.alias} = 'GET';`);
					break;
			}
		}
		out = lines.join('\n') + '\n' + out;
	}

	// 3. `koze:environment` → `const dev = …;`. The legacy CLI used
	// `globalThis.__koze_DEV__`; we inline it because the client
	// fragment is bundled per environment and the value is static.
	out = out.replace(
		/import\s*\{\s*([^}]*)\s*\}\s*from\s*['"](?:koze|kuratchi):environment['"]\s*;?\s*/g,
		(_m, bindings: string) => {
			const aliases = bindings
				.split(',')
				.map((b: string) => b.trim().split(/\s+as\s+/).pop() ?? '')
				.filter((name: string) => /^[A-Za-z_$][\w$]*$/.test(name));
			return aliases.map((alias: string) => `const ${alias} = ${!isProduction};`).join('\n') + '\n';
		},
	);
	out = rewriteBrowserNavigationImports(out);

	// Prepend the hydrate helper whenever ANY bridge from SSR → browser
	// is in play (hydrated await vars OR a `koze:request` `params`
	// import). The helper is a tiny arrow function + one DOM read; the
	// extra bytes are negligible and having it unconditionally present
	// means authors can call `__kozeReadData(...)` from their own
	// code if they want to read additional SSR-serialized values.
	out = stripKuratchiComponentImports(out);
	out = rewriteAugmentedActionInitializersForClient(out, actionAliases);
	out = stripAugmentImportSpecifier(out);

	const needsHydrateHelper =
		hydrateTargets.initAwaitVars.length > 0 ||
		hydrateTargets.reassignedLets.length > 0 ||
		requestImports.length > 0;
	if (needsHydrateHelper) {
		out = LEADING_FRAGMENT_HYDRATE_PRELUDE + out;
	}
	const reactiveNameList = reactiveNames ? Array.from(reactiveNames) : [];
	const needsReactiveRuntime =
		hadReactiveSyntax ||
		reactiveNameList.length > 0 ||
		!!blockRenderersExpr;
	const mountSource = out;
	if (needsReactiveRuntime) {
		out = transformReactiveClientScript(out, {
			forceRuntime: true,
			reactiveNames: reactiveNameList,
		});
		out += '\n' + buildClientScopeMount(
			mountSource,
			reactiveNameList,
			blockRenderersExpr,
			undefined,
			undefined,
			extraScopeNames,
			ownerId,
		);
	}

	return out;
}

function rewriteBrowserNavigationImports(source: string): string {
	return source.replace(
		/import\s*\{\s*([^}]*)\s*\}\s*from\s*['"](?:koze|kuratchi):navigation['"]\s*;?\s*/g,
		(_match, bindings: string) => {
			const browserBindings = bindings
				.split(',')
				.map((binding: string) => binding.trim())
				.filter(Boolean)
				.map((binding: string) => {
					const aliasMatch = binding.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
					if (aliasMatch) return { exported: aliasMatch[1], local: aliasMatch[2] };
					return { exported: binding, local: binding };
				})
				.filter((binding: { exported: string; local: string }) =>
					binding.exported === 'navigateTo' || binding.exported === 'refreshRoute',
				);
			if (browserBindings.length === 0) return '';
			const rewrittenBindings = browserBindings
				.map((binding: { exported: string; local: string }) =>
					binding.exported === binding.local ? binding.exported : `${binding.exported} as ${binding.local}`,
				)
				.join(', ');
			return `import { ${rewrittenBindings} } from ${JSON.stringify(resolveKuratchiVirtualModule('koze:navigation'))};\n`;
		},
	);
}

function stripKuratchiComponentImports(source: string): string {
	return source.replace(
		/^[ \t]*import\s+[^\n;]+?\s+from\s+['"][^'"]+\.(?:koze|kuratchi)['"][ \t]*;?[ \t]*(?:\r?\n)?/gm,
		'',
	);
}

/**
 * A `<script>` block is a "client fragment candidate" when it is not the
 * leading script AND contains at least one ES-module import. Without
 * imports, there is nothing to bundle — the block can stay inline (and
 * the existing Kuratchi template compiler preserves it as-is).
 *
 * NB: we match across multiple lines because named-import lists often
 * break across lines in hand-authored code (`import {\n a,\n b\n } from`).
 * The original regex used `.+` which doesn't cross newlines; that bug
 * caused multi-line imports to be treated as "no imports" and the entire
 * `<script>` block — raw TypeScript, `$server/*` and all — got echoed
 * into the rendered HTML response.
 */
/**
 * Count the net brace delta in a compiled-template body, ignoring any
 * braces inside string literals (single, double, or backtick) and
 * template-literal interpolations. Used as a pre-Rollup sanity check
 * so a stray `}` in an author's template surfaces as a clear error
 * instead of a downstream "return not allowed here".
 *
 * Returns 0 for balanced bodies, positive for extra openers, negative
 * for extra closers.
 */
function controlFlowBraceImbalance(src: string): number {
	let depth = 0;
	let quote: '"' | "'" | '`' | null = null;
	let templateDepth = 0; // depth of `${…}` interpolations inside a backtick
	let escaped = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		// Single-line and block comments — skip.
		if (!quote) {
			if (ch === '/' && src[i + 1] === '/') {
				while (i < src.length && src[i] !== '\n') i++;
				continue;
			}
			if (ch === '/' && src[i + 1] === '*') {
				i += 2;
				while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
				i++;
				continue;
			}
		}
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === '\\') {
				escaped = true;
				continue;
			}
			if (quote === '`') {
				// `${` opens a template interpolation; inside it we go
				// back to regular code until a matching `}`.
				if (ch === '$' && src[i + 1] === '{') {
					templateDepth++;
					i++;
					quote = null;
					continue;
				}
			}
			if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			quote = ch as '"' | "'" | '`';
			continue;
		}
		if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			if (templateDepth > 0) {
				// Closing a `${…}` interpolation, re-enter the template.
				templateDepth--;
				quote = '`';
			} else {
				depth--;
			}
		}
	}
	return depth;
}

// ─────────────────────────────────────────────────────────────────────
//  Stream boundaries — automatic detection.
//
//  Authors write normal Koze templates:
//
//    <script>
//      const todos = getTodos();         // no await → async binding
//    </script>
//    if (todos.pending) { <Skeleton /> }
//    else if (todos.error) { <p>{todos.error}</p> }
//    else { for (const t of todos) { <TodoItem todo={t} /> } }
//
//  The framework spots the if/else-if/else chain that gates on
//  `todos.pending|error|success`, compiles that chain into a render
//  closure, and streams its resolved markup in when the promise settles.
//  Authors never see a `<Boundary>` tag or any other wrapper — the
//  compiler infers the region from the `.pending/.error/.success`
//  accesses the author already wrote.
//
//  Region rule: smallest contiguous `if (…) { } else if (…) { } else { }`
//  chain whose gating expressions reference any async binding. A chain
//  may reference multiple bindings (`if (a.pending || b.pending)`); in
//  that case the boundary awaits `Promise.all([a, b])` and re-renders
//  the chain once both settle.
//
//  See `@kuratchi/koze/runtime/stream.ts` for the runtime primitives
//  (`__registerBoundary`, `boundaryPlaceholder`, `BOOTSTRAP_SCRIPT`,
//  `resolveBoundaryToChunk`) this pre-pass composes with.
// ─────────────────────────────────────────────────────────────────────

interface ExtractedBoundary {
	/** Marker substituted into the outer template in place of the if-chain. */
	marker: string;
	/** The full source of the if-chain. Compiled on its own into a closure. */
	chainSource: string;
	/** Identifiers the chain depends on (bindings accessed as X.pending/.error/.success). */
	bindings: string[];
	/** 0-based sequence number, makes closure names unique per route. */
	index: number;
}

/**
 * Which top-level script bindings are "async" — meaning they're
 * referenced in the template as `X.pending`?
 *
 * `.pending` is the shared AsyncValue/action-state tell. Action
 * function names are not top-level data vars, so they are filtered out
 * before streaming boundary extraction.
 *
 * Once `.pending` is seen the caller promotes the identifier to an
 * async binding; the extractor then matches if-chains gated on any of
 * `.pending | .error | .success` for that same identifier.
 */
function detectAsyncBindings(template: string): Set<string> {
	const out = new Set<string>();
	const re = /\b([A-Za-z_$][\w$]*)\.pending\b/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(template)) !== null) {
		out.add(match[1]);
	}
	return out;
}

/**
 * Walk the template line-by-line (the same shape `compileTemplate`
 * expects) and identify every `if (...) { ... } else if (...) { ... }
 * else { ... }` chain whose head condition mentions an async binding.
 * Replace each chain with a `<!--koze:auto-boundary:N-->` marker.
 *
 * Control-flow opener detection: `compileTemplate` already recognizes
 * `if (…) {`, `else if (…) {`, `else {`, and the closing `}` as plain
 * JS lines. We follow the same bracket-counting rules to find the end
 * of a chain.
 */
function extractAsyncBoundaries(
	template: string,
	asyncBindings: Set<string>,
): { template: string; boundaries: ExtractedBoundary[] } {
	if (asyncBindings.size === 0) {
		return { template, boundaries: [] };
	}
	const lines = template.split('\n');
	const boundaries: ExtractedBoundary[] = [];
	const output: string[] = [];

	// Regexes tolerant of leading whitespace. Head `if` must reference
	// an async binding directly in its condition; `else if` continues
	// an ongoing chain regardless of whether its own condition mentions
	// an async binding (the chain as a whole is already a boundary).
	const headIfRe = /^\s*if\s*\(([^)]+)\)\s*\{\s*$/;
	const elseIfRe = /^\s*\}\s*else\s+if\s*\(([^)]+)\)\s*\{\s*$/;
	const elseRe = /^\s*\}\s*else\s*\{\s*$/;
	const closeRe = /^\s*\}\s*$/;

	const conditionReferencesAsyncBinding = (condition: string): string[] => {
		const hits: string[] = [];
		const idRe = /\b([A-Za-z_$][\w$]*)\.(?:pending|error|success)\b/g;
		let m: RegExpExecArray | null;
		while ((m = idRe.exec(condition)) !== null) {
			if (asyncBindings.has(m[1]) && !hits.includes(m[1])) hits.push(m[1]);
		}
		return hits;
	};

	// Scan an arbitrary slice of template source for async-binding usage —
	// not just `.pending|.error|.success` accessors but ANY property /
	// method access on the binding identifier. The boundary closure runs
	// AFTER reassignment to the pending AsyncValue, so any reference to
	// the raw binding inside the chain body — `x.success`, `x.candidates`,
	// `x.length`, `x.context.person`, etc. — needs the binding hoisted
	// into the boundary's parameter list. Without this, the closure reads
	// the outer-scope raw Promise (or worse, the AsyncValue) for nested
	// bindings whose head condition we never detected, and renders junk
	// (or nothing). Concrete repro: a chain like
	//
	//   if (a.pending) { … }
	//   else if (a.success) {
	//     if (b.pending) { … } else if (b.success) { … b.value … }
	//   }
	//
	// previously only registered `a` in the boundary; `b` stayed a raw
	// Promise so `b.pending` was undefined and the inner branch never
	// matched. Hoisting `b` into the outer boundary makes the chain
	// stream atomically when BOTH resolve — the simplest correct
	// behavior given async boundaries don't compose recursively yet.
	const sourceReferencesAsyncBindings = (src: string): string[] => {
		const hits: string[] = [];
		const idRe = /\b([A-Za-z_$][\w$]*)\b/g;
		let m: RegExpExecArray | null;
		while ((m = idRe.exec(src)) !== null) {
			if (asyncBindings.has(m[1]) && !hits.includes(m[1])) hits.push(m[1]);
		}
		return hits;
	};

	let i = 0;
	let boundaryIndex = 0;
	while (i < lines.length) {
		const line = lines[i];
		const headMatch = line.match(headIfRe);
		const headHits = headMatch ? conditionReferencesAsyncBinding(headMatch[1]) : [];
		if (!headMatch || headHits.length === 0) {
			output.push(line);
			i++;
			continue;
		}

		// We're at the head of an async-binding-gated if. Walk forward
		// through the chain tracking `{`/`}` depth. The chain ends at
		// the line that closes the last `else` branch.
		const chainStart = i;
		const bindingsInChain = new Set<string>(headHits);
		let depth = 1;
		let j = i + 1;
		let chainClosedAt = -1;
		while (j < lines.length) {
			const l = lines[j];
			// Continuation clauses at depth 1 keep the chain alive AND
			// may introduce new binding references.
			if (depth === 1) {
				const ei = l.match(elseIfRe);
				if (ei) {
					for (const b of conditionReferencesAsyncBinding(ei[1])) bindingsInChain.add(b);
					// `} else if (…) {` pops one block and opens another; depth stays at 1.
					j++;
					continue;
				}
				const e = l.match(elseRe);
				if (e) {
					j++;
					continue;
				}
				if (closeRe.test(l)) {
					chainClosedAt = j;
					break;
				}
			}
			// Count braces INSIDE lines that aren't clause boundaries.
			// We approximate: each naked `{` at end of line opens, each
			// naked `}` at start closes. Good enough because the author
			// writes control flow on its own line (the template-compiler
			// line-scanner already assumes this).
			const opens = (l.match(/\{\s*$/) || []).length;
			const closes = (l.match(/^\s*\}/) || []).length;
			depth += opens;
			depth -= closes;
			j++;
		}
		if (chainClosedAt === -1) {
			// Unclosed chain — bail out to avoid breaking the template;
			// emit the original lines unchanged so `compileTemplate`
			// surfaces any syntax error rather than us masking it.
			output.push(line);
			i++;
			continue;
		}
		const chainSource = lines.slice(chainStart, chainClosedAt + 1).join('\n');
		// Add any other async bindings referenced inside the chain body.
		// See `sourceReferencesAsyncBindings` for the rationale.
		for (const b of sourceReferencesAsyncBindings(chainSource)) bindingsInChain.add(b);
		const marker = `<!--koze:auto-boundary:${boundaryIndex}-->`;
		boundaries.push({
			marker,
			chainSource,
			bindings: Array.from(bindingsInChain),
			index: boundaryIndex,
		});
		output.push(marker);
		boundaryIndex++;
		i = chainClosedAt + 1;
	}

	return { template: output.join('\n'), boundaries };
}

// ─────────────────────────────────────────────────────────────────────
//  Inline event-handler directive: `onclick={fn(args)}`
//
//  Koze-native handler binding. Authors write:
//      <button onclick={deleteTodo(todo.id)}>Delete</button>
//  The template compiler in `koze` recognizes `on<event>={…}`
//  attributes and consults the `ClientRouteRegistry` we pass in via
//  `compileTemplate`'s options. The registry assigns a stable handler
//  id (`h0`, `h1`, …), remembers the callee expression, and returns
//  the triple `(routeId, handlerId, argsExpr)`. The compiler then
//  emits the element with:
//
//      data-client-route="<routeId>"
//      data-client-handler="h0"
//      data-client-event="click"
//      data-client-args="${__esc(JSON.stringify([<argsExpr>]))}"
//
//  At the end of the leading-script browser bundle we register the
//  handler table with the client bridge:
//
//      window.__kozeClient.register("<routeId>", {
//          h0: (args) => deleteTodo(args[0]),
//          h1: (args, event) => save(),
//      });
//
//  The bridge (a tiny ~1 kB IIFE) installs one document-level listener
//  per event type, finds the `data-client-*` attributes on the closest
//  ancestor, parses `data-client-args`, and invokes the registered
//  handler. Re-including the bridge across multiple pages is
//  idempotent — it guards on `window.__kozeClient`.
//
//  This is deliberately MORE permissive than `koze`'s reference
//  implementation. That one required every referenced binding to come
//  from a `$lib/*` import. We allow any identifier: `$lib/*` imports,
//  `$server/*` RPC stubs (which in the browser bundle become real
//  functions), or functions the author declared in the top `<script>`
//  block. The registry never resolves the expression — it just stores
//  the string — so as long as the expression evaluates cleanly in the
//  leading-fragment's module scope at register time, it works.
// ─────────────────────────────────────────────────────────────────────

interface ClientEventRegistration {
	routeId: string;
	handlerId: string;
	argsExpr: string | null;
}

interface ClientRouteRegistryLike {
	hasBindings(): boolean;
	hasBindingReference(expression: string): boolean;
	registerEventHandler(eventName: string, expression: string): ClientEventRegistration | null;
	getServerProxyBindings(): unknown[];
	buildEntryAsset(): { assetName: string; asset: unknown } | null;
	rewriteClientImport(importLine: string, importerDir: string): string | null;
}

/**
 * Does the template have any `on<event>={fn(…)}` where `fn` is a
 * `$server/*` import? Used to decide whether the leading-fragment
 * bundle must ship the bridge's server-action dispatch branch even
 * when there are zero client handlers to register.
 */
function templateHasServerActionHandlers(
	template: string,
	serverActionCallees: Set<string>,
): boolean {
	if (serverActionCallees.size === 0) return false;
	const re = /\son[A-Za-z]+\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\(/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(template)) !== null) {
		if (serverActionCallees.has(match[1])) return true;
	}
	return false;
}

function templateHasEnhancedActionForms(
	template: string,
	stateActionNames: Set<string>,
): boolean {
	if (/<form\b[^>]*(?:\saugment(?:[\s=>/]|$)|\sdata-augment(?:[\s=>/]|$))/i.test(template)) {
		return true;
	}
	if (stateActionNames.size === 0) return false;
	const re = /<form\b[^>]*\saction\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(template)) !== null) {
		if (stateActionNames.has(match[1])) return true;
	}
	return false;
}

/**
 * Pre-populate the per-route handler registry from a raw template
 * scan. Matches every `on<event>={expr}` attribute and feeds `expr` to
 * `registerEventHandler`. Run during `extractClientFragments` so the
 * handler-registration source can be appended to the leading-fragment
 * browser source at fragment registration time — BEFORE the client
 * Rollup build calls `load()` on the virtual fragment module.
 *
 * Skips expressions whose root callee is a `$server/*` import — those
 * are dispatched as server actions by the template compiler
 * (`data-action=…`), not through the client-handler bridge. Keeping
 * them out of the registry keeps the browser bundle tight.
 *
 * Must match `{…}` carefully: we want the FULL expression including
 * nested parens, template literals, comments. A naive `{[^}]*}` would
 * cut off at the first `}` inside the expression. We use a tiny
 * bracket-balanced scanner instead.
 */
function preRegisterHandlers(
	template: string,
	registry: ViteClientRouteRegistry,
	serverActionCallees: Set<string>,
): void {
	const attrRe = /\son([A-Za-z]+)\s*=\s*\{/g;
	let match: RegExpExecArray | null;
	while ((match = attrRe.exec(template)) !== null) {
		const eventName = match[1].toLowerCase();
		const exprStart = match.index + match[0].length;
		let depth = 1;
		let end = exprStart;
		let inString: '"' | "'" | '`' | null = null;
		while (end < template.length && depth > 0) {
			const ch = template[end];
			const prev = end > 0 ? template[end - 1] : '';
			if (inString) {
				if (ch === inString && prev !== '\\') inString = null;
			} else if (ch === '"' || ch === "'" || ch === '`') {
				inString = ch;
			} else if (ch === '{') {
				depth++;
			} else if (ch === '}') {
				depth--;
				if (depth === 0) break;
			}
			end++;
		}
		const expr = template.slice(exprStart, end).trim();
		if (!expr) continue;
		// Skip server-action callees. `parseHandlerExpression` reports
		// the root identifier of `foo.bar(…)` as `foo`, so we need the
		// parser's result to filter correctly for property-access
		// callees — but server actions are always bare identifiers
		// (`$server/*` imports produce top-level bindings), so a cheap
		// identifier-first check is sufficient.
		const rootMatch = expr.match(/^([A-Za-z_$][\w$]*)/);
		if (rootMatch && serverActionCallees.has(rootMatch[1])) continue;
		registry.registerEventHandler(eventName, expr);
	}
}

/**
 * Parse `fnExpr(argsExpr)` into its parts. The argsExpr is the raw
 * argument list source (possibly multi-arg, possibly empty). We use the
 * TypeScript parser to tolerate nested parens, template literals, and
 * commas inside array/object literals — things a regex can't handle.
 *
 * Returns `null` if the expression isn't a call expression, or if the
 * callee isn't a simple identifier / property-access chain (we refuse
 * to register anything more exotic because it's not clear what the
 * client-side invocation shape should be).
 */
function parseHandlerExpression(expression: string): {
	calleeExpr: string;
	argsExpr: string;
	rootBinding: string;
} | null {
	let sourceFile: ts.SourceFile;
	try {
		sourceFile = ts.createSourceFile(
			'kuratchi-handler.ts',
			`(${expression})`,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
	} catch {
		return null;
	}
	const stmt = sourceFile.statements[0];
	if (!stmt || !ts.isExpressionStatement(stmt)) return null;
	const paren = stmt.expression;
	if (!ts.isParenthesizedExpression(paren)) return null;
	const expr = paren.expression;
	if (!ts.isCallExpression(expr)) return null;

	// Callee must be a plain identifier or dotted property-access chain.
	// This is the ONLY place we're opinionated: `foo.bar()` is fine,
	// `(a || b)()` is not. Authors who need dynamic dispatch can wrap
	// their logic in a named function.
	const rootBinding = (() => {
		let node: ts.Expression = expr.expression;
		while (ts.isPropertyAccessExpression(node)) node = node.expression;
		if (!ts.isIdentifier(node)) return null;
		return node.text;
	})();
	if (!rootBinding) return null;

	const calleeText = expr.expression.getText(sourceFile);
	const argsText = expr.arguments.map((a) => a.getText(sourceFile)).join(', ');
	return { calleeExpr: calleeText, argsExpr: argsText, rootBinding };
}

interface ClientHandlerRecord {
	id: string;
	calleeExpr: string;
	argsExpr: string;
}

class ViteClientRouteRegistry implements ClientRouteRegistryLike {
	private readonly handlerByKey = new Map<string, ClientHandlerRecord>();

	constructor(private readonly routeId: string) {}

	hasBindings(): boolean {
		// We don't gate registrations on `$lib` bindings, so claim
		// `true` whenever a registration has happened. The field is
		// only consulted by the template compiler to decide whether to
		// emit the legacy native `on<event>=` fallback; we always want
		// the data-client-* path for our routes.
		return true;
	}

	hasBindingReference(_expression: string): boolean {
		// The reference implementation uses this to refuse unsupported
		// handler shapes whose identifiers come from `$lib`. We accept
		// any identifier, so returning `false` lets `compileTemplate`
		// fall through to the native inline-handler branch if
		// `registerEventHandler` couldn't parse the expression.
		return false;
	}

	registerEventHandler(_eventName: string, expression: string): ClientEventRegistration | null {
		const parsed = parseHandlerExpression(expression);
		if (!parsed) return null;

		// De-dupe: two identical `<button onclick={save()}>` elements
		// share the same handler id, so we don't bloat the registry.
		const key = `${parsed.calleeExpr}::${parsed.argsExpr}`;
		let record = this.handlerByKey.get(key);
		if (!record) {
			record = {
				id: `h${this.handlerByKey.size}`,
				calleeExpr: parsed.calleeExpr,
				argsExpr: parsed.argsExpr,
			};
			this.handlerByKey.set(key, record);
		}

		return {
			routeId: this.routeId,
			handlerId: record.id,
			argsExpr: parsed.argsExpr.trim() === '' ? null : parsed.argsExpr,
		};
	}

	getServerProxyBindings(): unknown[] {
		return [];
	}

	buildEntryAsset(): null {
		// We emit the handler table inline in the leading fragment, not
		// as a separate client entry asset. Return null so the template
		// compiler doesn't try to inject a `<script src=...>` tag of
		// its own for the handler bundle.
		return null;
	}

	rewriteClientImport(_importLine: string, _importerDir: string): string | null {
		return null;
	}

	/**
	 * JS source appended to the end of the leading fragment's browser
	 * source, AFTER all user code. Registers every collected handler
	 * with `window.__kozeClient.register(routeId, {…})`. Returns
	 * empty string when no handlers were registered — that short-circuits
	 * both the `register(...)` call AND the bridge inclusion.
	 */
	emitRegistrationSource(): string {
		if (this.handlerByKey.size === 0) return '';
		// Invocation shape: `fn(...args, event, element)`. Matches the
		// reference `koze` runtime. `args` comes from
		// `data-client-args` (JSON-serialized at SSR); `event` is the
		// browser event; `element` is the ancestor element the bridge
		// matched on (the one carrying `data-client-handler`). Authors
		// who only care about their own args can write a normal
		// fixed-arity function: `function deleteTodo(id) { … }` works
		// whether invoked with zero or three trailing arguments.
		const entries = Array.from(this.handlerByKey.values())
			.map((record) => `\t${record.id}: (args, event, element) => ${record.calleeExpr}(...args, event, element)`)
			.join(',\n');
		return `\nwindow.__kozeClient && window.__kozeClient.register(${JSON.stringify(this.routeId)}, {\n${entries}\n});\n`;
	}

	get handlerCount(): number {
		return this.handlerByKey.size;
	}
}

/**
 * Minimal client bridge. Runs once per page — idempotent because it
 * guards on `window.__kozeClient`. Listens at the document root
 * for a fixed set of events and performs TWO dispatches:
 *
 *   1. `data-client-event`  → client handler registered via
 *      `window.__kozeClient.register(routeId, {…})`. Registered
 *      by the leading-fragment browser bundle. See `registerEventHandler`
 *      in the compiler for the emission shape.
 *
 *   2. `data-action-event`  → server action. The bridge POSTs to the
 *      current URL with `_action`, `_args`, optional `_method` fields.
 *      The response JSON can include `{ redirectTo }` to trigger a
 *      client-side navigation after the action resolves. This mirrors
 *      the `koze` reference bridge — `onclick={serverFn(id)}`
 *      where `serverFn` is a `$server/*` import compiles to these
 *      attributes, so the button "just works" with no extra code.
 *
 * Security: every routeId / handlerId is validated against a strict
 * identifier regex, prototype-pollution names are blocked, and the
 * handler table is an `Object.create(null)` with `hasOwnProperty`
 * checks on lookup.
 */
/**
 * Register the single leading `<script>` block as a browser fragment.
 * The SFC parser enforces the one-script rule before Vite touches the
 * source, so body scripts cannot bypass the compiler by becoming hidden
 * client fragments.
 *
 * As of the leading-script dual-bundle change, the LEADING `<script>`
 * block (index 0) is ALSO registered as a client fragment — with its
 * body rewritten so module-level `await` of `$server/*` reads from the
 * SSR-hydrated `window.__kozeData` instead. The SSR copy of the
 * leading script remains inlined as the render-function prelude; the
 * browser copy runs the same code with live data, the same way Svelte
 * + Astro ship dual SSR/client modules.
 */
function extractClientFragments(
	source: string,
	importerAbsPath: string,
	clientFragments: Map<string, ClientFragment>,
	isProduction: boolean = false,
	componentCompiler?: ComponentCompiler,
): { source: string; leadingHash: string | null } {
	let leadingHash: string | null = null;

	const sfc = parseKuratchiSfc(source, { kind: 'route', filePath: importerAbsPath });
	if (!sfc.script) return { source, leadingHash };

	const trimmedLeading = sfc.script.content.trim();
	if (trimmedLeading.length === 0) return { source, leadingHash };

	const hash = leadingScriptHash(importerAbsPath, source);
	leadingHash = hash;
	const hydrateTargets = collectLeadingHydrateTargets(trimmedLeading);
	let requestImports: Array<{ exportName: string; alias: string }> = [];
	let serverActionCallees = new Set<string>();
	let actionAliases: AugmentedActionAlias[] = [];
	let augmentedActionNames = new Set<string>();
	let componentNames: Map<string, string> | undefined;
	let serverRpcScopeNames: string[] = [];
	try {
		const parsed = parseFile(source, {
			kind: 'route',
			filePath: importerAbsPath,
		});
		requestImports = parsed.ir.imports.request;
		actionAliases = parsed.actionAliases ?? [];
		augmentedActionNames = new Set(actionAliases.map((alias) => alias.name));
		serverRpcScopeNames = parsed.ir.rpc.serverFunctions;
		serverActionCallees = new Set([
			...serverRpcScopeNames,
			...augmentedActionNames,
		]);
		componentNames = componentCompiler?.collectComponentMap(parsed.componentImports, importerAbsPath);
	} catch {
		requestImports = [];
	}
	const templateTail = sfc.template.source;
	const reactivePlan = analyzeClientTemplateReactivity(
		templateTail,
		trimmedLeading,
		componentNames,
		serverActionCallees,
		undefined,
		{ augmentedActionNames, reactiveOwnerId: hash },
	);
	const componentScopeNames = componentNames
		? Array.from(new Set(Array.from(componentNames.values()).map((fileName) => componentFuncName(fileName))))
		: [];
	const extraScopeNames = Array.from(new Set([
		...componentScopeNames,
		...serverRpcScopeNames,
	]));
	const blockRenderersExpr = buildClientTemplateRenderersExpression(reactivePlan.blockRenderers);
	const browserSource = transformLeadingScriptForClient(
		trimmedLeading,
		hydrateTargets,
		requestImports,
		isProduction,
		reactivePlan.reactiveNames,
		blockRenderersExpr,
		actionAliases,
		extraScopeNames,
		hash,
	);
	const handlerRegistry = new ViteClientRouteRegistry(hash);
	preRegisterHandlers(templateTail, handlerRegistry, serverActionCallees);

	const hasServerActionHandlers = templateHasServerActionHandlers(templateTail, serverActionCallees);
	const hasEnhancedActionForms = actionAliases.length > 0 || templateHasEnhancedActionForms(templateTail, augmentedActionNames);
	const needsBridge = handlerRegistry.handlerCount > 0 || hasServerActionHandlers || hasEnhancedActionForms;
	let finalSource = browserSource;
	const componentDecls = componentNames && componentNames.size > 0 && componentCompiler
		? componentCompiler.getCompiledComponents().join('\n\n')
		: '';
	if (componentDecls) {
		finalSource += '\n' + componentDecls;
	}
	if (handlerRegistry.handlerCount > 0) {
		finalSource += handlerRegistry.emitRegistrationSource();
	}
	finalSource = appendInlineSourceMap(
		finalSource,
		createKuratchiSourceMap({
			generatedCode: finalSource,
			source,
			sourcePath: importerAbsPath,
			file: `${hash}.ts`,
		}),
	);
	clientFragments.set(hash, {
		source: finalSource,
		importerAbsPath,
		kind: 'leading',
		hydrateVars: [...hydrateTargets.initAwaitVars, ...hydrateTargets.reassignedLets],
		handlerRegistry,
		needsBridge,
		reactiveNames: reactivePlan.reactiveNames,
		blockRenderersExpr,
	});
	return { source, leadingHash };

}

/**
 * Compile a `.koze` route file into a TS module exporting `render(data)`.
 *
 *   1. Register the leading `<script>` browser fragment.
 *   2. Parse the source with `koze/compiler`.
 *   3. Compile the template to the `const __parts = [...]` body.
 *   4. Inline the leading `<script>` body as the render-function prelude
 *      so top-level `const` declarations become locals in scope.
 *
 * Dual SSR/client split for the leading script + `$server/*` RPC stubs
 * arrive in Phase C.2/C.3.
 */
/**
 * Compile a `routes/layout.*` file into a TS module exporting
 * `render(data, __content)`. `<slot></slot>` and `<slot/>` in the layout
 * template get rewritten to `{@raw __content}` so the child route's
 * HTML is inserted unescaped at that location — matching the existing
 * CLI's layout semantics.
 *
 * Layouts use the same single leading-script fragment rule as routes.
 */
const DEFAULT_APP_SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
	<slot></slot>
</body>
</html>`;

/**
 * Compile a `routes/app.koze` file into a TS module exporting
 * `render(data, __content)`. Structurally identical to the layout
 * transform — app files are fragments too, just scoped to the
 * document shell instead of in-page chrome. Keeping the transforms
 * symmetrical means authors get the same mental model in both
 * files: top <script> + template + `<slot></slot>`.
 */
function transformAppFile(
	source: string,
	hasGlobalCss: boolean,
	clientFragments?: Map<string, ClientFragment>,
	isProduction: boolean = false,
	importerAbsPath?: string,
): string {
	const preprocessed = clientFragments && importerAbsPath
		? extractClientFragments(source, importerAbsPath, clientFragments, isProduction)
		: { source, leadingHash: null as string | null };
	const parsed = parseFile(preprocessed.source, {
		kind: 'route',
		filePath: importerAbsPath,
	});
	const rawTemplate = parsed.template ?? '';
	// When `src/app.css` exists, inject `<link rel="stylesheet" href={...}>`
	// immediately before `</head>`. The href resolves at render time via
	// `resolveGlobalCssHref()` from koze:manifest — pointing at the
	// dev-server URL in dev, and the hashed manifest output in prod.
	//
	// If the shell has no `</head>`, we synthesize one: authors who ship
	// a shell without a head get a one-line injection as the first child
	// of `<html>`. The default shell always has `</head>`.
	const withGlobalCss = hasGlobalCss ? injectGlobalCssLink(rawTemplate) : rawTemplate;
	const withReactiveRuntime = injectReactiveRuntimeScript(withGlobalCss, isProduction);
	const template = withReactiveRuntime
		.replace(/<slot\s*><\/slot>/g, '{@raw __content}')
		.replace(/<slot\s*\/>/g, '{@raw __content}');
	const script = parsed.script ?? '';
	const appPreludePlan = buildSelectiveSsrPrelude({
		scriptBody: script,
		template,
		serverImports: parsed.serverImports ?? [],
	});
	const authoredImports = appPreludePlan.imports.join('\n');
	const manifestImport = hasGlobalCss
		? "import { resolveGlobalCssHref as __kozeResolveGlobalCssHref } from 'koze:manifest';"
		: '';
	const leadingHash = preprocessed.leadingHash;
	const moduleImports = [authoredImports, manifestImport].filter(Boolean).join('\n');
	const prelude = appPreludePlan.prelude;
	const requestImportDecls = buildRequestImportDecls(parsed.requestImports ?? []);
	let body = compileTemplate(template, undefined, undefined, undefined, {
		reactiveOwnerId: leadingHash ?? undefined,
	});
	if (leadingHash) {
		const leadingFragment = clientFragments?.get(leadingHash);
		const leadingScriptTag =
			'<script type="module" src="${resolveClientAsset(' +
			JSON.stringify(leadingHash) +
			')}"></script>';
		const bridgeTag = leadingFragment?.needsBridge
			? '<script type="module" src="${resolveClientAsset(' +
				JSON.stringify(CLIENT_BRIDGE_HASH) +
				')}\"></script>'
			: null;
		const bridgePush = bridgeTag
			? `\n\t__parts.push(\`${bridgeTag}\\n\`);`
			: '';
		body = `${body}${bridgePush}\n\t__parts.push(\`${leadingScriptTag}\\n\`);\n\t__html = __parts.join('');`;
	}
	const appManifestImport = leadingHash
		? `import { resolveClientAsset } from 'koze:manifest';\n`
		: '';

	const code = `${appManifestImport}${moduleImports}
export const hasApp = true;
export async function render(data, __content) {
${requestImportDecls}
	const __rawHtml = (v) => (v == null ? '' : String(v));
	const __sanitizeHtml = (v) => {
		let html = __rawHtml(v);
		html = html.replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, '');
		html = html.replace(/<iframe\\b[^>]*>[\\s\\S]*?<\\/iframe>/gi, '');
		html = html.replace(/<object\\b[^>]*>[\\s\\S]*?<\\/object>/gi, '');
		html = html.replace(/<embed\\b[^>]*>/gi, '');
		html = html.replace(/\\son[a-z]+\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi, '');
		html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*([\"'])\\s*javascript:[\\s\\S]*?\\2/gi, ' $1=\"#\"');
		html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*javascript:[^\\s>]+/gi, ' $1=\"#\"');
		html = html.replace(/\\ssrcdoc\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi, '');
		return html;
	};
	const __esc = (v) => {
		if (v == null) return '';
		return String(v)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/\"/g, '&quot;')
			.replace(/'/g, '&#39;');
	};

	${prelude}

	${body}
	return __html;
}
`;
	return importerAbsPath
		? appendInlineSourceMap(
			code,
			createKuratchiSourceMap({
				generatedCode: code,
				source,
				sourcePath: importerAbsPath,
				file: path.basename(importerAbsPath) + '.js',
			}),
		)
		: code;
}

/**
 * Inject `<link rel="stylesheet" href={__kozeResolveGlobalCssHref()}>`
 * immediately before the first `</head>` in the template. When the
 * template has no `</head>` (authors who ship a shell without a head),
 * the link goes right after `<html ...>` so the browser still sees it
 * before any body content.
 *
 * Idempotent: if the template already contains a rendered call to
 * `__kozeResolveGlobalCssHref`, we leave it alone (prevents double
 * injection on HMR).
 */
function injectGlobalCssLink(template: string): string {
	if (template.includes('__kozeResolveGlobalCssHref')) return template;
	const tag = `<link rel="stylesheet" href={__kozeResolveGlobalCssHref()} />`;
	if (/<\/head\s*>/i.test(template)) {
		return template.replace(/<\/head\s*>/i, `\t${tag}\n</head>`);
	}
	if (/<html\b[^>]*>/i.test(template)) {
		return template.replace(/(<html\b[^>]*>)/i, `$1\n${tag}`);
	}
	// No `<html>` — prepend. Produces a malformed document but at least
	// the link is in the HTML response.
	return `${tag}\n${template}`;
}

function injectReactiveRuntimeScript(template: string, isProduction: boolean): string {
	if (template.includes('__kozeReactive')) return template;
	const tag = buildReactiveRuntimeScriptTag(!isProduction);
	if (/<\/head\s*>/i.test(template)) {
		return template.replace(/<\/head\s*>/i, `\t${tag}\n</head>`);
	}
	if (/<html\b[^>]*>/i.test(template)) {
		return template.replace(/(<html\b[^>]*>)/i, `$1\n${tag}`);
	}
	return `${tag}\n${template}`;
}

/**
 * Synthesize `const <alias> = data.<exportName> ?? <fallback>;`
 * declarations for every `koze:request` import the leading script
 * referenced. Routes, layouts, and the app shell all run inside a
 * `render(data, ...)` function the dispatcher invokes per request —
 * so any file whose top <script> pulls from `koze:request` needs
 * these locals to be in scope.
 */
function buildRequestImportDecls(
	requestImports: Array<{ exportName: string; alias: string }>,
): string {
	return requestImports
		.map((imp) => {
			const fallback = REQUEST_IMPORT_FALLBACKS[imp.exportName] ?? 'undefined';
			return `\tconst ${imp.alias} = data.${imp.exportName} ?? ${fallback};`;
		})
		.join('\n');
}

function stripAugmentedActionsFromServerPrelude(
	scriptBody: string,
	actionAliases: AugmentedActionAlias[],
): string {
	if (actionAliases.length === 0) return scriptBody;
	return stripAugmentImportSpecifier(
		stripAugmentedActionDeclarations(scriptBody, actionAliases),
	);
}

function transformLayoutFile(
	source: string,
	importerAbsPath: string,
	clientFragments: Map<string, ClientFragment>,
	componentCompiler: ComponentCompiler,
	isProduction: boolean = false,
): { code: string; watchFiles: string[] } {
	const { source: preprocessedSource, leadingHash } = extractClientFragments(
		source,
		importerAbsPath,
		clientFragments,
		isProduction,
		componentCompiler,
	);
	const parsed = parseFile(preprocessedSource, {
		kind: 'route',
		filePath: importerAbsPath,
	});
	const rawTemplate = parsed.template ?? '';
	// Replace both styles of `<slot>` marker with the raw-content directive.
	// Koze's template compiler lowers `{@raw expr}` to `__rawHtml(expr)`.
	const template = rawTemplate
		.replace(/<slot\s*><\/slot>/g, '{@raw __content}')
		.replace(/<slot\s*\/>/g, '{@raw __content}');
	const script = parsed.script ?? '';

	// Component compilation — same pattern as the route transform, but
	// rooted at the layout file's path so relative component imports
	// resolve against the layout's directory.
	const componentNames = componentCompiler.collectComponentMap(
		parsed.componentImports,
		importerAbsPath,
	);
	const componentWatchFiles = Array.from(componentCompiler.getResolvedFiles().values()) as string[];

	// Server-action identifiers used in `action={fn}` or `on<event>={fn(…)}`.
	// Same filtering rule as pages: only names that are ALSO imported
	// from `$server/*` qualify (the rest are client-handler callees).
	// Without this, the template compiler falls through to its native
	// attribute emitter which calls `toString()` on the function — the
	// "Unknown action: async function setCaseCategoryAction(…)" bug that
	// used to bite every form in a layout.
	const rawLayoutActionFunctions = parsed.actionFunctions ?? [];
	const layoutServerRpcFunctions = new Set(parsed.serverRpcFunctions ?? []);
	const layoutActionAliases = parsed.actionAliases ?? [];
	const layoutActionAliasTargets = new Map(
		layoutActionAliases.map((alias) => [alias.name, alias.target] as const),
	);
	const layoutAugmentedActionNames = new Set(layoutActionAliases.map((alias) => alias.name));
	const layoutActionNames = new Set(
		rawLayoutActionFunctions.filter((name) =>
			layoutServerRpcFunctions.has(name) || layoutAugmentedActionNames.has(name),
		),
	);
	for (const name of layoutAugmentedActionNames) layoutActionNames.add(name);
	// Same component-action bubble as routes: a `<Card action={save}>`
	// inside a layout where `save` comes from `$server/*` becomes part
	// of the layout's action table.
	for (const fnName of componentCompiler.resolveActionProps(
		template,
		componentNames,
		(name: string) => layoutServerRpcFunctions.has(name) || layoutAugmentedActionNames.has(name),
	)) {
		layoutActionNames.add(fnName);
	}
	const layoutPreludeScript = stripAugmentedActionsFromServerPrelude(script, layoutActionAliases);
	const layoutNeededActionBindings = Array.from(new Set([
		...layoutActionNames,
		...layoutActionAliasTargets.values(),
	]));
	const layoutPreludePlan = buildSelectiveSsrPrelude({
		scriptBody: layoutPreludeScript,
		template,
		serverImports: parsed.serverImports ?? [],
		additionalNeededBindings: layoutNeededActionBindings,
	});
	const componentModuleImports = componentCompiler.getServerImports().join('\n');
	const moduleImports = [layoutPreludePlan.imports.join('\n'), componentModuleImports]
		.filter(Boolean)
		.join('\n');
	const prelude = layoutPreludePlan.prelude;
	const requestImportDecls = buildRequestImportDecls(parsed.requestImports ?? []);

	// Layouts support the same async-boundary rewrite as pages: a top-
	// level `let x = fn()` (non-awaited) that the template gates on via
	// `x.pending | x.error | x.success` becomes a stream boundary. The
	// runtime's dispatcher handles boundaries uniformly regardless of
	// whether they were registered from a layout or a page — boundaries
	// collect on the per-request `locals` collector, and the final
	// `renderRoute` check picks them all up.
	const topLevelDataVars = new Set(parsed.dataVars ?? []);
	const layoutAsyncBindings = new Set(
		[...detectAsyncBindings(template)].filter((name) => topLevelDataVars.has(name) && !layoutActionNames.has(name)),
	);
	const layoutBoundaryExtraction = extractAsyncBoundaries(template, layoutAsyncBindings);
	const layoutBoundariesUsed = layoutBoundaryExtraction.boundaries.length > 0;
	const handlerRegistry = leadingHash
		? clientFragments.get(leadingHash)?.handlerRegistry ?? null
		: null;

	let body = compileTemplate(layoutBoundaryExtraction.template, componentNames, layoutActionNames, undefined, {
		clientRouteRegistry: handlerRegistry as any,
		augmentedActionNames: layoutAugmentedActionNames,
		reactiveOwnerId: leadingHash ?? undefined,
	});

	// Post-compile: swap each `<!--koze:auto-boundary:N-->` marker
	// for a block that registers the combined promise with the stream
	// runtime and emits a placeholder wrapping the chain's pending
	// render. Same shape as the route-side rewrite in `transformRouteFile`.
	for (const boundary of layoutBoundaryExtraction.boundaries) {
		const marker = boundary.marker;
		const innerBody = compileTemplate(boundary.chainSource, componentNames, layoutActionNames, undefined, {
			clientRouteRegistry: handlerRegistry as any,
			augmentedActionNames: layoutAugmentedActionNames,
			reactiveOwnerId: leadingHash ?? undefined,
		});
		const params = boundary.bindings.join(', ');
		const closureName = `__boundary_${boundary.bindings[0]}_${boundary.index}_render`;
		const closureDef = `const ${closureName} = (${params}) => { ${innerBody}; return __html; };`;
		const rawCaptures = boundary.bindings
			.map((b) => `const __boundary_raw_${b} = ${b};`)
			.join('\n\t\t');
		// Each binding's promise is wrapped INDEPENDENTLY into an AsyncValue
		// before joining. `Promise.all` short-circuits on the first rejection,
		// which historically meant a single failed binding (e.g. an AI call
		// that errored) bled across to all other bindings sharing the
		// boundary — they'd all render their `.error` branch even though
		// their own data was fine. Mapping rejections to `wrapError(msg)`
		// per-binding gives every chain branch its own success/error state
		// while keeping the boundary's "stream when ALL settle" semantics.
		const combinedPromise = `Promise.all([${boundary.bindings
			.map(
				(b) =>
					`Promise.resolve(__boundary_raw_${b}).then(__kozeWrapSuccess, function(__err){ return __kozeWrapError(__err && __err.message ? String(__err.message) : String(__err)); })`,
			)
			.join(', ')}])`;
		// Each `__values[i]` is already an AsyncValue (success or error)
		// thanks to the per-binding wrapping above — pass them straight
		// into the closure without re-wrapping.
		const successArgs = boundary.bindings.map((_, idx) => `__values[${idx}]`).join(', ');
		const successHandler = `(__values) => ${closureName}(${successArgs})`;
		// Defensive only: if `Promise.all` itself throws (it shouldn't —
		// every input now resolves), every binding falls back to error.
		const errorArgs = boundary.bindings.map(() => `__kozeWrapError(__message)`).join(', ');
		const errorHandler = `(__message) => ${closureName}(${errorArgs})`;
		const reassignPending = boundary.bindings
			.map((b) => `${b} = __boundary_pending;`)
			.join('\n\t\t');
		const pendingArgs = boundary.bindings.map(() => '__boundary_pending').join(', ');
		const replacement = `\`);
	{
		${closureDef}
		${rawCaptures}
		const __boundary_id = __kozeNextBoundaryId(${JSON.stringify(boundary.bindings.join('-'))});
		const __boundary_pending = __kozeRegisterBoundary(
			__boundary_id,
			${combinedPromise},
			${successHandler},
			${errorHandler},
		);
		${reassignPending}
		__parts.push(__kozeBoundaryPlaceholder(__boundary_id, ${closureName}(${pendingArgs})));
	}
	__parts.push(\``;
		body = body.split(marker).join(replacement);
	}

	const streamRuntimeImport = layoutBoundariesUsed
		? `import {\n\t__registerBoundary as __kozeRegisterBoundary,\n\t__nextBoundaryId as __kozeNextBoundaryId,\n\tboundaryPlaceholder as __kozeBoundaryPlaceholder,\n\t__wrapSuccess as __kozeWrapSuccess,\n\t__wrapError as __kozeWrapError,\n} from '@kuratchi/koze/runtime/stream.js';\n`
		: '';

	// Export every detected server-action function so the route module
	// can re-export them as its own `actions` (layout actions bubble up
	// the chain to the page's exported `actions` table; the dispatcher
	// looks up `match.module.actions[name]` without needing any
	// layout-awareness at the runtime level).
	const layoutActionExportEntries = Array.from(layoutActionNames)
		.map((name) => `\t${JSON.stringify(name)}: ${layoutActionAliasTargets.get(name) ?? name},`)
		.join('\n');
	// Always export `actions` — empty when the layout has no
	// server-action callees of its own. Rollup warns when a route
	// module imports a name that isn't exported, even though the
	// `?? {}` coalesce handles it at runtime; emitting the name
	// unconditionally suppresses the warning and lets Rollup
	// tree-shake correctly.
	const layoutActionsExport = layoutActionExportEntries
		? `\nexport const actions = {\n${layoutActionExportEntries}\n};\n`
		: '\nexport const actions = {};\n';

	let leadingModuleAppend = '';
	if (leadingHash) {
		const leadingFragment = clientFragments.get(leadingHash);
		const hydrateVars = leadingFragment?.hydrateVars ?? [];
		const hydrateEntries = hydrateVars
			.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
			.map((name) => `${JSON.stringify(name)}: ${name}`)
			.join(', ');
		const hydratePayload = `{ ${hydrateEntries}${
			hydrateEntries ? ', ' : ''
		}__params: data.params ?? {} }`;
		const leadingScriptTag =
			'<script type="module" src="${resolveClientAsset(' +
			JSON.stringify(leadingHash) +
			')}"></script>';
		const bridgeTag = leadingFragment?.needsBridge
			? '<script type="module" src="${resolveClientAsset(' +
				JSON.stringify(CLIENT_BRIDGE_HASH) +
				')}"></script>'
			: null;
		const bridgePush = bridgeTag
			? `\n\t__parts.push(\`${bridgeTag}\\n\`);`
			: '';
		leadingModuleAppend = `
	__parts.push('<script type="application/json" id="__koze_data">' + __kozeSerializeData(${hydratePayload}) + '</' + 'script>\\n');${bridgePush}
	__parts.push(\`${leadingScriptTag}\\n\`);
	__html = __parts.join('');`;
	}

	// Inside `render(data, __content)`, shadow every action identifier
	// with its per-request state object (`{ error, pending, success }`).
	// Seeded by the dispatcher before render; same mechanism as pages.
	const layoutActionStateDecls = Array.from(layoutActionNames)
		.map(
			(name) =>
				`\tconst ${name} = (data && data[${JSON.stringify(name)}]) ?? { error: undefined, pending: false, success: false };`,
		)
		.join('\n');
	const manifestImport = leadingHash
		? `import { resolveClientAsset } from 'koze:manifest';\n`
		: '';

	// Component decls + styles — same shape as routes. Layouts can
	// import their own components (e.g. an app-shell layout that
	// imports `<Sidebar>`); the compiled functions land at module
	// scope so the layout's `render()` can call them.
	const componentDecls = componentCompiler.getCompiledComponents().join('\n\n');
	const componentStyles = componentCompiler.collectStyles(componentNames);
	const componentStylesInjection = componentStyles.length > 0
		? `__parts.push(\`${componentStyles.join('')}\`);`
		: '';

	const code = `${streamRuntimeImport}${manifestImport}${moduleImports}
${componentDecls}
${layoutActionsExport}
export const hasLayout = true;
export async function render(data, __content) {
${requestImportDecls}
${layoutActionStateDecls}
	const __rawHtml = (v) => (v == null ? '' : String(v));
	const __sanitizeHtml = (v) => {
		let html = __rawHtml(v);
		html = html.replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, '');
		html = html.replace(/<iframe\\b[^>]*>[\\s\\S]*?<\\/iframe>/gi, '');
		html = html.replace(/<object\\b[^>]*>[\\s\\S]*?<\\/object>/gi, '');
		html = html.replace(/<embed\\b[^>]*>/gi, '');
		html = html.replace(/\\son[a-z]+\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi, '');
		html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*([\"'])\\s*javascript:[\\s\\S]*?\\2/gi, ' $1=\"#\"');
		html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*javascript:[^\\s>]+/gi, ' $1=\"#\"');
		html = html.replace(/\\ssrcdoc\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi, '');
		return html;
	};
	const __esc = (v) => {
		if (v == null) return '';
		return String(v)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	};
	const __kozeSerializeData = (value) => {
		let s;
		try { s = JSON.stringify(value); } catch { s = undefined; }
		if (s === undefined) return 'null';
		const __lineSep = String.fromCharCode(0x2028);
		const __paraSep = String.fromCharCode(0x2029);
		return s
			.split('<').join('\\\\u003c')
			.split(__lineSep).join('\\\\u2028')
			.split(__paraSep).join('\\\\u2029');
	};

	${prelude}

	${injectComponentStyles(body, componentStylesInjection)}${leadingModuleAppend}
	return __html;
}
`;
	return {
		code: appendInlineSourceMap(
			code,
			createKuratchiSourceMap({
				generatedCode: code,
				source,
				sourcePath: importerAbsPath,
				file: path.basename(importerAbsPath) + '.js',
			}),
		),
		watchFiles: componentWatchFiles,
	};
}

/**
 * Emit the JS that composes the route's HTML through every layout in
 * its chain, innermost-first. The chain is received outermost-first
 * (so `chain[0]` is the root-most layout wrapping everything); we
 * reverse at compose time so the first wrap is the innermost layout
 * — that layout receives the raw route HTML, and its output becomes
 * the child content for the next-outer layout.
 *
 * Returns a sequence of `const` assignments feeding a final
 * `__layoutHtml` that the route emission hands to `__kozeApp.render`.
 *
 * When the chain is empty, falls back to the legacy single-module
 * `__kozeLayout` import (which resolves to a no-op stub when the
 * project has no root layout file). This preserves behavior for
 * existing apps with no layouts at all.
 */
function composeLayoutChain(chain: string[]): string {
	if (chain.length === 0) {
		return `const __layoutHtml = await __kozeLayout.render(data, __routeHtml);`;
	}
	const lines: string[] = [`let __layoutHtml = __routeHtml;`];
	// Reverse to innermost-first. Each wrap's output feeds the next.
	for (const layoutPath of [...chain].reverse()) {
		const hash = layoutModuleHash(layoutPath);
		lines.push(`__layoutHtml = await __kozeLayout_${hash}.render(data, __layoutHtml);`);
	}
	return lines.join('\n\t');
}

function transformRouteFile(
	source: string,
	importerAbsPath: string,
	clientFragments: Map<string, ClientFragment>,
	componentCompiler: ComponentCompiler,
	isProduction: boolean = false,
	layoutChain: string[] = [],
): { code: string; watchFiles: string[] } {
	const { source: preprocessedSource, leadingHash } = extractClientFragments(
		source,
		importerAbsPath,
		clientFragments,
		isProduction,
		componentCompiler,
	);

	const parsed = parseFile(preprocessedSource, {
		kind: 'route',
		filePath: importerAbsPath,
	});
	const template = parsed.template ?? '';
	const script = parsed.script ?? '';

	// Component compilation. `componentImports` was populated by the
	// parser from `import Card from '$lib/card.koze'` (or
	// '@scope/pkg/card.koze', or './widgets/card.koze'). The
	// component compiler resolves each one — relative paths against
	// the importer's directory, $lib paths against `src/lib`, package
	// paths against `node_modules`. Compiled component bodies are
	// shared across the entire build via the per-plugin
	// `componentCompiler` instance.
	const componentNames = componentCompiler.collectComponentMap(
		parsed.componentImports,
		importerAbsPath,
	);
	// Track watch files so the Vite plugin's `load` hook can register
	// them. Editing a `card.koze` should re-emit every route that
	// imports it.
	const componentWatchFiles = Array.from(componentCompiler.getResolvedFiles().values()) as string[];

	// Imports hoist to module scope so Vite's resolver handles them once
	// per module (via `$lib`/`$server` aliases). The prelude — the script
	// body with imports stripped — runs inside `render()` every request
	// so top-level `await` of `$server/*` calls produces per-request data.
	// (`serverRpcImports` is a subset of `serverImports`; `serverImports`
	// alone covers everything from the leading script.)

	// `koze:request` imports are stripped by the parser (they're not
	// real import lines at runtime; they map to per-request state). We
	// synthesize the matching `const alias = data.alias || <fallback>;`
	// declarations so the leading-script body, which runs inside `render`,
	// can reference `params` / `searchParams` / `url` / etc. The Vite
	// dispatcher populates `data` with these values before calling render.

	// Dispatch rule for `on<event>={fn(args)}` matches the Kuratchi CLI:
	//
	//   1. If `fn` is imported from `$server/*`              → server action
	//      (POSTs to the route URL via the action dispatcher).
	//   2. Else, if `fn` is a known client binding           → client handler
	//      (either a `$lib/*` import or a function declared
	//       in the top `<script>` block).
	//   3. Else                                              → native inline
	//      `<button onclick="fn(args)">` — legacy escape hatch.
	//
	// The `compileTemplate` branch at `template.ts:1030` dispatches rule
	// 1 vs rules 2/3 based on whether the callee name is present in
	// `actionNames`. So `actionNames` must contain EXACTLY the server-
	// action callees — no more, no less.
	//
	// `parsed.actionFunctions` from the parser conflates both categories
	// (it collects every `action={…}` + every `on<event>={…}` callee).
	// We filter it down to just the ones that are also `$server/*`
	// imports. That matches the CLI's effective behavior: only functions
	// authored as server work become server-action dispatches.
	const rawActionFunctions = parsed.actionFunctions ?? [];
	const serverRpcFunctions = new Set(parsed.serverRpcFunctions ?? []);
	const actionAliases = parsed.actionAliases ?? [];
	const actionAliasTargets = new Map(
		actionAliases.map((alias) => [alias.name, alias.target] as const),
	);
	const augmentedActionNames = new Set(actionAliases.map((alias) => alias.name));
	const actionNames = new Set(
		rawActionFunctions.filter((name) =>
			serverRpcFunctions.has(name) || augmentedActionNames.has(name),
		),
	);
	for (const name of augmentedActionNames) actionNames.add(name);
	// Components can declare `action={fn}` props (e.g. `<Card action={save}>`).
	// The component compiler scans each component's own template for
	// `action={…}` prop sites and reports them via `getActionPropNames`;
	// `resolveActionProps` then walks THIS template, looks at each
	// component tag's attribute list, and figures out which local
	// callees flow into those slots. Any callee that's also a
	// `$server/*` import becomes part of the route's `actions` table —
	// without this bubble step, `<Card action={save}>` where `save`
	// comes from `$server/orders` would never get dispatched.
	for (const fnName of componentCompiler.resolveActionProps(
		template,
		componentNames,
		(name: string) => serverRpcFunctions.has(name) || augmentedActionNames.has(name),
	)) {
		actionNames.add(fnName);
	}
	const routePreludeScript = stripAugmentedActionsFromServerPrelude(script, actionAliases);
	const neededActionBindings = Array.from(new Set([
		...actionNames,
		...actionAliasTargets.values(),
	]));
	const routePreludePlan = buildSelectiveSsrPrelude({
		scriptBody: routePreludeScript,
		template,
		serverImports: parsed.serverImports ?? [],
		additionalNeededBindings: neededActionBindings,
	});
	const componentModuleImports = componentCompiler.getServerImports().join('\n');
	const moduleImports = mergeImportDeclarations([routePreludePlan.imports.join('\n'), componentModuleImports]
		.filter(Boolean)
		.join('\n'));
	const prelude = routePreludePlan.prelude;
	const requestImportDecls = buildRequestImportDecls(parsed.requestImports ?? []);

	// Per-route event-handler registry. Consumed by `compileTemplate`
	// whenever it sees an `on<event>={…}` attribute. The registry was
	// created during `extractClientFragments` and pre-populated from a
	// template scan, so handler IDs here match what the leading
	// fragment's browser bundle registers with `__kozeClient`.
	const handlerRegistry = leadingHash
		? clientFragments.get(leadingHash)?.handlerRegistry ?? null
		: null;

	// Async boundaries — auto-detected from the template. For every
	// top-level `if/else-if/else` chain whose conditions reference
	// `X.pending | X.error | X.success`, the framework pulls that
	// chain out, compiles it into a render closure, and (at render
	// time) registers it with the stream collector. Authors write
	// plain template control flow — no `<Boundary>` wrapper required.
	//
	// An identifier qualifies as an async binding when it is
	// (a) declared at the top level of the leading `<script>` AND
	// (b) accessed in the template via `.pending`.
	//
	// `.pending` is the shared AsyncValue/action-state tell. Only
	// top-level data vars are considered for streamed async boundaries.
	const topLevelDataVars = new Set(parsed.dataVars ?? []);
	const asyncBindings = new Set(
		[...detectAsyncBindings(template)].filter((name) => topLevelDataVars.has(name) && !actionNames.has(name)),
	);
	const boundaryExtraction = extractAsyncBoundaries(template, asyncBindings);
	const boundariesUsed = boundaryExtraction.boundaries.length > 0;
	const clientTemplatePlan = analyzeClientTemplateReactivity(
		boundaryExtraction.template,
		script,
		componentNames,
		actionNames,
		undefined,
		{
			clientRouteRegistry: handlerRegistry as any,
			augmentedActionNames,
		},
	);

	// `clientRouteRegistry` is typed in `koze` against a private
	// internal interface we can't import by name. Structural typing
	// handles the shape — the method surface we expose matches exactly.
	let body = compileTemplate(boundaryExtraction.template, componentNames, actionNames, undefined, {
		clientRouteRegistry: handlerRegistry as any,
		clientScriptBody: script,
		liveTemplateNames: clientTemplatePlan.reactiveNames,
		augmentedActionNames,
		reactiveOwnerId: leadingHash ?? undefined,
	});

	// NOTE: a brace-balance pre-check was attempted here but produced
	// false positives because `compileTemplate` legitimately emits JS
	// where string-literal or template-interpolation braces don't net
	// to zero at the token-level when analyzed without a full JS parser.
	// A proper implementation would need to acorn-parse the emitted body
	// and surface the first unbalanced brace at its source-line. Left
	// for follow-up; for now, Rollup's downstream "return not allowed
	// here" error points at the route module and is enough to find a
	// stray `}` in the template by visual inspection.
	// Stream-boundary rewrite. For each detected if-chain:
	//
	//  1. Compile the chain's source into a render closure parameterized
	//     on every async binding it references. The same closure is
	//     invoked at SSR time with pending AsyncValues (rendering the
	//     skeleton branch) and at stream-resolve time with success or
	//     error AsyncValues (rendering the final branch).
	//
	//  2. Capture each binding's underlying promise before the register
	//     call reassigns the binding to a pending AsyncValue.
	//
	//  3. Combine the promises with `Promise.all` — the chain streams
	//     atomically when ALL referenced bindings settle, matching how
	//     an author reasons about "this block needs a, b, and c ready
	//     before it can render."
	//
	//  4. Emit `boundaryPlaceholder(id, initialHTML)` wrapping the
	//     closure's pending-state output. The stream dispatcher later
	//     picks up the registered promise, runs `renderSuccess` /
	//     `renderError`, and streams the resolved chunk.
	for (const boundary of boundaryExtraction.boundaries) {
		const marker = boundary.marker;
		const innerBody = compileTemplate(boundary.chainSource, componentNames, actionNames, undefined, {
			clientRouteRegistry: handlerRegistry as any,
			augmentedActionNames,
			reactiveOwnerId: leadingHash ?? undefined,
		});
		const params = boundary.bindings.join(', ');
		const closureName = `__boundary_${boundary.bindings[0]}_${boundary.index}_render`;
		const closureDef = `const ${closureName} = (${params}) => { ${innerBody}; return __html; };`;

		// Capture each binding's raw value BEFORE reassigning — those
		// raw values are the promises (or already-resolved values) we
		// hand to the stream runtime.
		const rawCaptures = boundary.bindings
			.map((b) => `const __boundary_raw_${b} = ${b};`)
			.join('\n\t\t');

		// Combine all raw values through `Promise.resolve` so non-thenable
		// bindings (already resolved literals, rare but possible) flow
		// through cleanly. Each binding's promise is wrapped INDEPENDENTLY
		// into an AsyncValue (`wrapSuccess` on resolve / `wrapError` on
		// reject) so a single failed binding doesn't poison its sibling
		// bindings — historically `Promise.all`'s short-circuit caused the
		// whole boundary to flip to error on any rejection, leaving every
		// binding's `.error` branch firing even when only one had failed.
		// This per-binding wrap gives each branch its own success/error
		// state while preserving "stream when ALL settle" semantics.
		const combinedPromise = `Promise.all([${boundary.bindings
			.map(
				(b) =>
					`Promise.resolve(__boundary_raw_${b}).then(__kozeWrapSuccess, function(__err){ return __kozeWrapError(__err && __err.message ? String(__err.message) : String(__err)); })`,
			)
			.join(', ')}])`;

		// renderSuccess: each `__values[i]` is already an AsyncValue
		// (success or error) thanks to the per-binding wrapping above,
		// so we pass them straight through without re-wrapping.
		const successArgs = boundary.bindings.map((_, idx) => `__values[${idx}]`).join(', ');
		const successHandler = `(__values) => ${closureName}(${successArgs})`;

		// renderError: defensive fallback only. The combined promise no
		// longer rejects (every input maps rejection to a success-shaped
		// error AsyncValue), but if `Promise.all` itself throws for some
		// runtime-internal reason every binding falls back to error.
		const errorArgs = boundary.bindings.map(() => `__kozeWrapError(__message)`).join(', ');
		const errorHandler = `(__message) => ${closureName}(${errorArgs})`;

		// Reassign each binding to a SHARED pending AsyncValue for the
		// initial render. `createPendingValue` returns an empty object
		// with `pending=true, error=null, success=false` — that's what
		// every binding evaluates to during SSR up to the boundary
		// site. Must happen AFTER `rawCaptures` stashes the promises.
		const reassignPending = boundary.bindings
			.map((b) => `${b} = __boundary_pending;`)
			.join('\n\t\t');

		const pendingArgs = boundary.bindings.map(() => '__boundary_pending').join(', ');

		const replacement = `\`);
	{
		${closureDef}
		${rawCaptures}
		const __boundary_id = __kozeNextBoundaryId(${JSON.stringify(boundary.bindings.join('-'))});
		const __boundary_pending = __kozeRegisterBoundary(
			__boundary_id,
			${combinedPromise},
			${successHandler},
			${errorHandler},
		);
		${reassignPending}
		__parts.push(__kozeBoundaryPlaceholder(__boundary_id, ${closureName}(${pendingArgs})));
	}
	__parts.push(\``;
		body = body.split(marker).join(replacement);
	}

	// (Handler registration + bridge are emitted to the leading
	// fragment's browser source during `extractClientFragments`, not
	// here. See `preRegisterHandlers`.)

	// Leading-script dual bundle: emit a JSON data blob + module
	// `<script>` at the very end of the route body. The client bundle
	// reads the blob via `getElementById('__koze_data').textContent`
	// + `JSON.parse(...)` so the payload is never parsed as JavaScript
	// — no risk of XSS via a broken serializer, no visible "live-looking
	// code" in view-source. Matches the pattern Next.js (__NEXT_DATA__),
	// SvelteKit, and Remix (loader data) all use.
	let leadingModuleAppend = '';
	if (leadingHash) {
		const leadingFragment = clientFragments.get(leadingHash);
		const hydrateVars = leadingFragment?.hydrateVars ?? [];
		const hydrateEntries = hydrateVars
			.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
			.map((name) => `${JSON.stringify(name)}: ${name}`)
			.join(', ');
		// `__params` is always included so `koze:request`'s `params`
		// / `slug` virtual imports have a source on the client. Cost is
		// typically a couple of bytes for `{}` when a route has no params.
		const hydratePayload = `{ ${hydrateEntries}${
			hydrateEntries ? ', ' : ''
		}__params: data.params ?? {} }`;
		const leadingScriptTag =
			'<script type="module" src="${resolveClientAsset(' +
			JSON.stringify(leadingHash) +
			')}"></script>';
		// Module `<script type="module">` is implicitly deferred until
		// the document is parsed, so the JSON blob is always present in
		// the DOM by the time the client bundle evaluates.
		// NB: compileTemplate ends its output with `let __html =
		// __parts.join('')`. We push more onto `__parts` after that
		// join, then re-assign `__html` so the appended markup makes it
		// into the final response.
		//
		// If the route uses any `on<event>={…}`, emit the shared client
		// bridge BEFORE the leading fragment. `<script type="module">`
		// preserves document order, so `window.__kozeClient` is
		// defined by the time the leading bundle calls `register(…)`.
		const bridgeTag = leadingFragment?.needsBridge
			? '<script type="module" src="${resolveClientAsset(' +
				JSON.stringify(CLIENT_BRIDGE_HASH) +
				')}"></script>'
			: null;
		const bridgePush = bridgeTag
			? `\n	__parts.push(\`${bridgeTag}\\n\`);`
			: '';
		leadingModuleAppend = `
	__parts.push('<script type="application/json" id="__koze_data">' + __kozeSerializeData(${hydratePayload}) + '</' + 'script>\\n');${bridgePush}
	__parts.push(\`${leadingScriptTag}\\n\`);
	__html = __parts.join('');`;
	}

	const manifestImport = leadingHash
		? `import { resolveClientAsset } from 'koze:manifest';\n`
		: '';

	// Stream-boundary runtime imports. Only emitted for routes that
	// declare a `<Boundary>` element — routes without boundaries pay
	// zero cost. The dispatcher side of the streaming protocol lives
	// in `koze/vite/runtime/dispatch.js`; these imports give the
	// route's `render()` access to the compile-time primitives.
	const streamRuntimeImport = boundariesUsed
		? `import {\n\t__registerBoundary as __kozeRegisterBoundary,\n\t__nextBoundaryId as __kozeNextBoundaryId,\n\tboundaryPlaceholder as __kozeBoundaryPlaceholder,\n\t__wrapSuccess as __kozeWrapSuccess,\n\t__wrapError as __kozeWrapError,\n} from '@kuratchi/koze/runtime/stream.js';\n`
		: '';

	// Export the action map so the request dispatcher can call server
	// functions referenced via `<form action={fn}>`. Names are preserved
	// — server module imports are hoisted at module scope, so the
	// identifiers are in lexical range at module eval time.
	//
	// Layout actions bubble up: a form `<form action={fn}>` inside any
	// `layout.koze` on the chain should dispatch when the user POSTs
	// to a page under that layout. We spread each layout's `actions`
	// export into our own (outermost→innermost so a page can override a
	// layout action by re-exporting the same name). The dispatcher
	// stays layout-ignorant — it just sees a single `actions` table on
	// the matched page module.
	const actionExportEntries = Array.from(actionNames)
		.map((name) => `\t${JSON.stringify(name)}: ${actionAliasTargets.get(name) ?? name},`)
		.join('\n');
	const layoutActionSpreads = layoutChain
		.map((p) => `\t...(__kozeLayout_${layoutModuleHash(p)}.actions ?? {}),`)
		.join('\n');
	const mergedActionBody = [layoutActionSpreads, actionExportEntries]
		.filter((chunk) => chunk.length > 0)
		.join('\n');
	const actionsExport = mergedActionBody
		? `\nexport const actions = {\n${mergedActionBody}\n};\n`
		: `\nexport const actions = {};\n`;

	const rpcNameMap = new Map<string, string>();
	let rpcCounter = 0;
	for (const fnName of parsed.pollFunctions ?? []) {
		if (!rpcNameMap.has(fnName)) {
			rpcNameMap.set(fnName, `rpc_${routeModuleHash(importerAbsPath)}_${rpcCounter++}`);
		}
	}
	for (const query of parsed.dataGetQueries ?? []) {
		if (!rpcNameMap.has(query.fnName)) {
			rpcNameMap.set(query.fnName, `rpc_${routeModuleHash(importerAbsPath)}_${rpcCounter++}`);
		}
	}
	const rpcEntries = new Map<string, string>();
	for (const fnName of parsed.pollFunctions ?? []) {
		const rpcId = rpcNameMap.get(fnName) ?? fnName;
		rpcEntries.set(rpcId, fnName);
	}
	for (const binding of componentCompiler.collectServerRpcBindings(componentNames)) {
		const rpcId = `rpc_component_${componentRpcHash(binding.sourceKey, binding.importedName)}`;
		if (!rpcEntries.has(rpcId)) {
			rpcEntries.set(rpcId, binding.localName);
		}
	}
	const rpcExport = rpcEntries.size > 0
		? `\nexport const rpc = {\n${Array.from(rpcEntries.entries()).map(([rpcId, localName]) => `\t${JSON.stringify(rpcId)}: ${localName},`).join('\n')}\n};\n`
		: `\nexport const rpc = {};\n`;
	const allowedQueriesExport = rpcEntries.size > 0
		? `export const allowedQueries = [${Array.from(rpcEntries.keys()).map((rpcId) => JSON.stringify(rpcId)).join(', ')}];\n`
		: `export const allowedQueries = [];\n`;

	// Inside `render(data)`, shadow every action function identifier with
	// its per-request state object (`{ error, pending, success }`). The
	// state object is seeded on `data` by the dispatcher for every GET and
	// populated with `error` on an action failure. This makes
	// `<actionFn>.error` in the template resolve to the state, not the
	// hoisted function reference (which would always be `undefined`).
	//
	// We keep the fallback to the function itself (`?? <name>`) so bare
	// identifier usage in JSX-ish contexts like `<form action={fn}>`
	// still sees a truthy value at render time — though in practice the
	// template compiler rewrites those into string literals anyway.
	const actionStateDecls = Array.from(actionNames)
		.map(
			(name) =>
				`\tconst ${name} = (data && data[${JSON.stringify(name)}]) ?? { error: undefined, pending: false, success: false };`
		)
		.join('\n');

	// Every route imports the chain of layouts that wrap it, outermost
	// first. The chain is computed in the `load` hook via
	// `layoutChainForRoute`. Each entry gets its own local binding
	// `__kozeLayout_<hash>`. If the chain is empty (no layout file
	// anywhere on the ancestor chain), the legacy `koze:layout`
	// module (a no-op when the root layout is absent) is imported so
	// existing setups without nested layouts still behave as before.
	const layoutChainImports = layoutChain.length > 0
		? layoutChain
			.map((p) => {
				const hash = layoutModuleHash(p);
				return `import * as __kozeLayout_${hash} from ${JSON.stringify(NESTED_LAYOUT_VIRTUAL_PREFIX + hash)};`;
			})
			.join('\n') + '\n'
		: `import * as __kozeLayout from 'koze:layout';\n`;
	const layoutImport = `${layoutChainImports}import * as __kozeApp from 'koze:app';\n`;

	// Component function declarations — one `function __c_<name>(props,
	// __esc) { … }` per imported `.koze` component. The compiler's
	// `getCompiledComponents()` returns the de-duped set across the
	// whole build (cached per-plugin). Each component lives at module
	// scope so it's in lexical range when the route's `render()`
	// invokes `__c_card({...}, __esc)` from the `compileTemplate`
	// output.
	const componentDecls = componentCompiler.getCompiledComponents().join('\n\n');
	// Component styles — every scoped `<style>` block from imported
	// components, joined into a single string the route's render
	// pushes into its output before the route body. The styles are
	// already escaped for template-literal embedding (see
	// `escapeTemplateLiteral` in component-pipeline). When a route
	// imports no components, the array is empty and the push is
	// optimized into a literal '' that minifiers DCE.
	const componentStyles = componentCompiler.collectStyles(componentNames);
	// `compileTemplate`'s output begins with `const __parts = [];`. We
	// inject the component-style push immediately AFTER that line so
	// the styles land at the very top of the rendered route HTML —
	// which means they sit inside the layout's <slot> and inside the
	// app shell's <body>, ahead of any user markup. Browsers tolerate
	// `<style>` anywhere in the document; the alternative (head
	// injection) would require a separate stream-time rewrite step
	// that earns nothing the inline pattern doesn't.
	const componentStylesInjection = componentStyles.length > 0
		? `__parts.push(\`${componentStyles.join('')}\`);`
		: '';

	// `async` so top-level `await` in the leading script (e.g. `const x =
	// await $serverFn()`) is valid inside the function body. Worker
	// callers must `await render()`.
	//
	// `__kozeSerializeData` is defined inside `render()` so routes
	// without a leading-script hydration payload still pay zero cost
	// (no closure over a module-level helper, minifiers can DCE it).
	const code = `${manifestImport}${streamRuntimeImport}${layoutImport}${moduleImports}
${componentDecls}
${actionsExport}
${rpcExport}${allowedQueriesExport}
export async function render(data) {
	const __rawHtml = (v) => (v == null ? '' : String(v));
	const __sanitizeHtml = (v) => {
		let html = __rawHtml(v);
		html = html.replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, '');
		html = html.replace(/<iframe\\b[^>]*>[\\s\\S]*?<\\/iframe>/gi, '');
		html = html.replace(/<object\\b[^>]*>[\\s\\S]*?<\\/object>/gi, '');
		html = html.replace(/<embed\\b[^>]*>/gi, '');
		html = html.replace(/\\son[a-z]+\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi, '');
		html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*([\"'])\\s*javascript:[\\s\\S]*?\\2/gi, ' $1=\"#\"');
		html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*javascript:[^\\s>]+/gi, ' $1=\"#\"');
		html = html.replace(/\\ssrcdoc\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi, '');
		return html;
	};
	const __esc = (v) => {
		if (v == null) return '';
		return String(v)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	};
	const __kozeSerializeData = (value) => {
		let s;
		try { s = JSON.stringify(value); } catch { s = undefined; }
		if (s === undefined) return 'null';
		// The payload lives inside <script type="application/json">, so the
		// browser never parses it as JavaScript — no XSS-via-unquoted-JSON.
		// The only remaining hazard is the HTML tokenizer bailing out of
		// the script tag if it encounters a literal '</' sequence; escape
		// '<' (covering '</', '<!--', '<script', etc.) to '\u003c'.
		// U+2028 / U+2029 are preserved valid JSON but some older parsers
		// choke, so we escape them too — cheap insurance.
		const __lineSep = String.fromCharCode(0x2028);
		const __paraSep = String.fromCharCode(0x2029);
		return s
			.split('<').join('\\\\u003c')
			.split(__lineSep).join('\\\\u2028')
			.split(__paraSep).join('\\\\u2029');
	};

${requestImportDecls}
${actionStateDecls}

	${prelude}

	${injectComponentStyles(body, componentStylesInjection)}${leadingModuleAppend}
	const __routeHtml = __html;
	${composeLayoutChain(layoutChain)}
	return __kozeApp.render(data, __layoutHtml);
}

export const __kozeRoute = { kind: 'page', actions, rpc, allowedQueries };
`;
	return {
		code: appendInlineSourceMap(
			code,
			createKuratchiSourceMap({
				generatedCode: code,
				source,
				sourcePath: importerAbsPath,
				file: path.basename(importerAbsPath) + '.js',
			}),
		),
		watchFiles: componentWatchFiles,
	};
}

/**
 * Inject a `__parts.push(<styles>);` statement immediately after the
 * `const __parts = [];` line that `compileTemplate` always emits as
 * its first output. This places component styles at the top of the
 * rendered HTML — inside the route's first emitted chunk, ahead of
 * any user markup, but after `__parts` exists so the push is valid.
 *
 * When the injection string is empty, returns the body unchanged.
 */
function injectComponentStyles(compiledBody: string, injection: string): string {
	if (!injection) return compiledBody;
	const marker = 'const __parts = [];';
	const idx = compiledBody.indexOf(marker);
	if (idx === -1) {
		// `compileTemplate` always starts with this line; if it doesn't,
		// fall back to prepending — styles still land near the top of
		// the rendered fragment, just inside whatever the first
		// statement of the body is.
		return injection + '\n\t' + compiledBody;
	}
	const before = compiledBody.slice(0, idx + marker.length);
	const after = compiledBody.slice(idx + marker.length);
	return before + '\n\t' + injection + after;
}

interface GeneratedContentModule {
	code: string;
	watchFiles: string[];
}

function generateContentModule(projectRoot: string): GeneratedContentModule {
	const contentRoot = path.resolve(projectRoot, 'src', 'content');
	const entries = discoverContentEntries(projectRoot);
	const watchFiles = fs.existsSync(contentRoot) ? [contentRoot] : [];
	const seenIds = new Set<string>();
	const payload = entries.map((entry) => {
		const key = `${entry.group}:${entry.id}`;
		if (seenIds.has(key)) {
			throw new Error(
				`[koze:content] Duplicate content id "${entry.id}" in src/content/${entry.group}. ` +
				'Use one Markdown file per content id.',
			);
		}
		seenIds.add(key);
		watchFiles.push(entry.absPath);
		return {
			group: entry.group,
			id: entry.id,
			href: entry.href,
			file: entry.file,
			source: fs.readFileSync(entry.absPath, 'utf-8'),
		};
	});

	return {
		watchFiles,
		code: [
			`import { createContentRegistry } from '@kuratchi/koze/runtime/content.js';`,
			`const entries = ${JSON.stringify(payload)};`,
			`export const content = createContentRegistry(entries);`,
			`export default content;`,
			'',
		].join('\n'),
	};
}

/**
 * Emit the body of the `koze:manifest` virtual module.
 *
 * In dev (no build manifest exists yet) the helper returns a live
 * `/@id/virtual:koze-client/<hash>.ts` URL that Vite's dev server
 * transforms on demand.
 *
 * In prod, the client Rollup build runs first and writes
 * `dist/client/.vite/manifest.json`. We read it synchronously here —
 * safe because the SSR environment build runs *after* the client build
 * in Vite's default env order, so the file exists by the time this is
 * loaded. The manifest is then baked into the module as a literal
 * object; no file IO at request time.
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
 * Phase F: discover Kuratchi conventions (`.sandbox.ts`, `.container.ts`,
 * `.do.ts`, `.workflow.ts`, `.queue.ts`) under `serverDir` and sync the
 * results into the user's `wrangler.jsonc`. This runs at `configResolved`
 * so the Cloudflare Vite plugin sees a fully up-to-date wrangler config
 * when it reads bindings / DO classes / containers for dev + build.
 *
 * Delegates the actual wrangler mutation to `syncWranglerConfig` from
 * `koze/compiler` — the same code path the legacy CLI uses, so
 * the output wrangler.jsonc is byte-identical.
 */
function syncWranglerFromConventions(
	projectRoot: string,
	serverDir: string,
	workerModuleCompiler: ServerModuleCompiler | null = null,
): {
	classes: ConventionClass[];
	durableObjectConfig: DoConfigEntry[];
	durableObjectHandlers: DoHandlerEntry[];
	queues: QueueConsumer[];
	workflows: Array<{ name: string; binding: string }>;
	pipelines: Array<{ name: string; binding: string; pipeline: string }>;
} {
	const srcDir = path.dirname(path.resolve(projectRoot, serverDir));

	const workflowConfig = discoverWorkflowFiles(projectRoot);
	const containerConfig = discoverContainerFiles(projectRoot);
	const sandboxConfig = discoverSandboxFiles(projectRoot);
	const queueConsumerConfig = discoverQueueConsumerFiles(projectRoot);
	const pipelineConfig = discoverPipelineFiles(projectRoot);
	writePipelineArtifacts({
		projectDir: projectRoot,
		pipelines: pipelineConfig,
		writeFile: (filePath, content) => {
			const fileDir = path.dirname(filePath);
			if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
			if (fs.existsSync(filePath)) {
				const existing = fs.readFileSync(filePath, 'utf-8');
				if (existing === content) return;
			}
			fs.writeFileSync(filePath, content, 'utf-8');
		},
	});
	const { config: doConfig, handlers: doHandlers } = discoverDurableObjects(srcDir);
	// Cloudflare Agents (`AIChatAgent` / `Agent` subclasses).
	// Discovered from `src/server/**/*.agent.ts`. The Vite plugin
	// re-exports the agent class as a named export of the Worker
	// entry so Cloudflare's DO binding resolution can find it; the
	// binding declarations themselves remain author-managed in
	// `wrangler.jsonc` (agents don't follow the
	// filename-derives-binding convention because the framework
	// can't infer a single binding name from a class that supports
	// multiple agent kinds).
	const agentConfig = discoverAgentFiles(projectRoot);

	// Sandbox containers always run with sqlite storage (per kuratchi convention).
	// Regular containers opt in via their static `sqlite` field.
	const containerizedClassEntries = [
		...containerConfig.map((entry) => ({ ...entry, sqlite: Boolean(entry.sqlite) })),
		...sandboxConfig.map((entry) => ({ ...entry, sqlite: true })),
	];
	const containerDoConfig = containerizedClassEntries.map((entry) => ({
		binding: entry.binding,
		className: entry.className,
	}));

	// Auto-wire `assets.directory` if `src/assets/` exists. No app-level
	// config needed — authors drop files into that folder and they're
	// served at `/<filename>` in both dev and prod. Binding is always
	// `ASSETS`.
	const assetsDir = fs.existsSync(path.join(projectRoot, DEFAULT_ASSETS_DIR))
		? DEFAULT_ASSETS_DIR
		: undefined;

	syncWranglerConfig({
		projectDir: projectRoot,
		config: {
			workflows: workflowConfig,
			containers: containerizedClassEntries.map((entry) => ({
				binding: entry.binding,
				className: entry.className,
				image: entry.image,
				instanceType: entry.instanceType,
				maxInstances: entry.maxInstances,
				sqlite: entry.sqlite,
			})),
			durableObjects: [...doConfig, ...containerDoConfig],
			queues: queueConsumerConfig.map((q) => ({
				binding: q.binding,
				queueName: q.queueName,
			})),
			pipelines: pipelineConfig.map((p) => ({
				binding: p.binding,
				pipeline: p.pipeline,
			})),
			assetsDirectory: assetsDir,
		},
		writeFile: (filePath, content) => {
			// Mirror the CLI's "write-if-changed" behavior so we don't
			// retrigger Vite's wrangler.jsonc watcher on every dev boot.
			if (fs.existsSync(filePath)) {
				const existing = fs.readFileSync(filePath, 'utf-8');
				if (existing === content) return;
			}
			fs.writeFileSync(filePath, content, 'utf-8');
		},
	});

	const transformWorkerModule = (file: string): string =>
		workerModuleCompiler ? workerModuleCompiler.transformModule(file) : file;
	const workerDoHandlers: DoHandlerEntry[] = doHandlers.map((handler) => ({
		...handler,
		absPath: transformWorkerModule(handler.absPath),
		classContributors: (handler.classContributors ?? []).map((contributor) => ({
			...contributor,
			absPath: transformWorkerModule(contributor.absPath),
		})),
	}));

	// Consolidated list of non-DO convention classes the Worker must re-export.
	// `.do.ts` files go through `generateWorkerModule`'s RPC-safe DO class
	// synthesis instead of re-exporting the author class directly.
	const classes: ConventionClass[] = [
		...workflowConfig.map((e) => ({
			className: e.className,
			file: transformWorkerModule(path.resolve(projectRoot, e.file)),
			exportKind: e.exportKind,
		})),
		...containerizedClassEntries.map((e) => ({
			className: e.className,
			file: transformWorkerModule(path.resolve(projectRoot, e.file)),
			exportKind: e.exportKind,
		})),
		...agentConfig.map((e) => ({
			className: e.className,
			file: transformWorkerModule(path.resolve(projectRoot, e.file)),
			exportKind: e.exportKind,
		})),
	];
	const queues: QueueConsumer[] = queueConsumerConfig.map((q) => ({
		queueName: q.queueName,
		file: transformWorkerModule(path.resolve(projectRoot, q.file)),
		exportKind: q.exportKind,
	}));
	// Workflow registry: basename (matches `workflowStatus('<name>', ...)`)
	// → env binding name. Consumed by `generateWorkerModule` to emit a
	// `__setWorkflowRegistry(...)` call so the runtime can resolve workflow
	// instances by convention name.
	const workflows: Array<{ name: string; binding: string }> = workflowConfig.map((e) => ({
		name: path.basename(e.file).replace(/\.workflow\.ts$/, ''),
		binding: e.binding,
	}));
	const pipelines = pipelineConfig.map((entry) => ({
		name: entry.name,
		binding: entry.binding,
		pipeline: entry.pipeline,
	}));
	return { classes, durableObjectConfig: doConfig, durableObjectHandlers: workerDoHandlers, queues, workflows, pipelines };
}

/**
 * Locate the user's middleware file at the single canonical location:
 * `src/middleware.ts`. Returns null if it doesn't exist — the plugin
 * emits an empty-runtime stub in that case.
 */
function resolveMiddlewareFile(projectRoot: string, _serverDir: string): string | null {
	const candidate = path.resolve(projectRoot, MIDDLEWARE_FILE);
	return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Create `src/worker.ts` with a canonical re-export of the synthesized
 * `koze:worker` module if it doesn't already exist. Matches the
 * legacy CLI's convention so projects scaffolded by either path have
 * the same entrypoint shape.
 *
 * We never overwrite — once the file exists, the developer owns it,
 * and appending would risk losing their customizations. If they need
 * the stub back, they can delete the file and rerun dev/build.
 */
function ensureWorkerEntry(projectRoot: string): void {
	const workerPath = path.join(projectRoot, 'src', 'worker.ts');
	if (fs.existsSync(workerPath)) return;
	const srcDir = path.dirname(workerPath);
	if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });
	const source = `// Auto-generated by koze/vite on first dev/build.
// Re-exports the synthesized \`koze:worker\` module so Cloudflare
// sees every discovered convention class (workflows, durable objects,
// sandboxes, containers) as a named export off this entry, and the
// default export wires \`fetch\` through the Koze dispatcher.
//
// You can add custom code to this file (e.g. \`scheduled\` handlers);
// the plugin will never overwrite it once it exists. Delete it to
// regenerate.

// @ts-expect-error — virtual module provided by \`koze/vite\` at build time.
export { default } from 'koze:worker';
// @ts-expect-error — virtual module provided by \`koze/vite\` at build time.
export * from 'koze:worker';
`;
	fs.writeFileSync(workerPath, source, 'utf-8');
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
function resolveServerFile(
	projectRoot: string,
	serverDir: string,
	subpath: string,
): string | null {
	const base = path.resolve(projectRoot, serverDir, subpath);
	const candidates = [
		base,
		base + '.ts',
		base + '.js',
		base + '.mjs',
		path.join(base, 'index.ts'),
		path.join(base, 'index.js'),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	return null;
}

/**
 * Walk a TypeScript source file's AST to collect every exported
 * identifier name. We need this to generate the right number of RPC
 * stub exports — a Proxy-catch-all would work at runtime but break
 * Rollup's static import-analysis in the client bundle.
 *
 * Supports: `export function x`, `export const y`, `export class Z`,
 * `export { a, b }`, `export default <expr>`. For `export default`,
 * the stub exports a `default` binding (callable the same way).
 */
function collectExportedNames(sourceFile: string): string[] {
	if (!fs.existsSync(sourceFile)) return [];
	const source = fs.readFileSync(sourceFile, 'utf-8');
	const sf = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true);
	const names = new Set<string>();
	for (const stmt of sf.statements) {
		if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
			for (const spec of stmt.exportClause.elements) {
				names.add((spec.name as ts.Identifier).text);
			}
			continue;
		}
		const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
		if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
		const hasDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
		if (hasDefault) {
			names.add('default');
			continue;
		}
		if (ts.isFunctionDeclaration(stmt) && stmt.name) names.add(stmt.name.text);
		else if (ts.isClassDeclaration(stmt) && stmt.name) names.add(stmt.name.text);
		else if (ts.isVariableStatement(stmt)) {
			for (const decl of stmt.declarationList.declarations) {
				if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
			}
		}
	}
	return Array.from(names);
}

/**
 * Emit the SSR-only `koze:rpc-map` module. Every `$server/<subpath>`
 * specifier the client env has referenced is statically imported here
 * (as a wildcard namespace) and exposed via a `lookup(subpath)` helper
 * the dispatcher uses at request time.
 *
 * Static imports are critical for Rollup / Worker bundling: a dynamic
 * `import('$server/' + subpath)` can't be resolved at build time, which
 * is why the dispatcher delegates to this map instead of importing
 * server modules itself.
 */
function generateRpcMapModule(
	projectRoot: string,
	serverDir: string,
	referenced: Set<string>,
): string {
	const entries = Array.from(referenced).filter((subpath) => {
		const file = resolveServerFile(projectRoot, serverDir, subpath);
		return file !== null;
	});
	const imports = entries
		.map((subpath, i) => `import * as __rpc_${i} from '$server/${subpath}';`)
		.join('\n');
	const mapEntries = entries
		.map((subpath, i) => `\t${JSON.stringify(subpath)}: __rpc_${i}`)
		.join(',\n');
	return `${imports}

const MAP = {
${mapEntries}
};

export async function lookup(subpath) {
	if (globalThis.__koze_DEV__) {
		try {
			return await import(/* @vite-ignore */ \`$server/\${subpath}\`);
		} catch (e) {
			console.error('[koze] Dev RPC import failed for ' + subpath + ':', e);
			return null;
		}
	}
	return MAP[subpath] || null;
}
`;
}

/**
 * Emit a client-safe stub module for `$server/<subpath>`. Each exported
 * identifier becomes a Kuratchi Channel call over Cap'n Web. The dispatcher
 * imports the real module server-side and invokes the function with the
 * deserialized args.
 *
 * Non-function exports become the same shape — the server dispatcher
 * returns their current value if they're not callable, which matches
 * the typical usage pattern (`await getCurrentUser()` over a `locals`
 * constant, etc.).
 */
function generateRpcStubModule(subpath: string, serverFile: string | null): string {
	const names = serverFile ? collectExportedNames(serverFile) : [];
	const runtimePrelude = `import { createKuratchiRpcAsyncValue } from '@kuratchi/koze/runtime/channel.js';

function __kozeRpc(rpcId, args) {
	return createKuratchiRpcAsyncValue({ carrier: 'capnweb-http', target: 'server', op: rpcId, args });
}`;
	const stubs = names.map((name) => {
		const rpcId = `${subpath}/${name}`;
		if (name === 'default') {
			return `function __default(...args) {
	return __kozeRpc(${JSON.stringify(rpcId)}, args);
}
export default __default;`;
		}
		return `export function ${name}(...args) {
	return __kozeRpc(${JSON.stringify(rpcId)}, args);
}`;
	});
	return `// RPC stub for $server/${subpath} — generated by koze/vite
${runtimePrelude}

${stubs.join('\n\n')}
`;
}

/**
 * Emit the body of the `koze:worker` virtual module — the full
 * worker entry the user's `src/worker.ts` re-exports.
 *
 * Generates:
 *   - Named imports of every convention class from their source files.
 *   - Named queue-handler imports (one per .queue.ts consumer), shimmed
 *     so the default export's `queue(batch, env, ctx)` can dispatch by
 *     queue name.
 *   - `export default { fetch, queue? }` wired to the dispatcher.
 *   - `export { ClassA, ClassB, ... }` for Cloudflare to resolve bindings.
 *
 * Paths are absolute so Vite/Rollup resolve them against the host app's
 * node_modules + source tree (they DON'T go through the plugin's require
 * context — these are the user's own files).
 */
function generateWorkerModule(
	classes: ConventionClass[],
	queues: QueueConsumer[],
	workflows: Array<{ name: string; binding: string }> = [],
	pipelines: Array<{ name: string; binding: string; pipeline: string }> = [],
	doConfig: DoConfigEntry[] = [],
	doHandlers: DoHandlerEntry[] = [],
): string {
	const toImportSpecifier = (filePath: string): string => pathToFileURL(filePath).href;
	const classImports: string[] = [];
	const classExports: string[] = [];
	for (const c of classes) {
		if (c.exportKind === 'default') {
			classImports.push(
				`import ${c.className} from ${JSON.stringify(toImportSpecifier(c.file))};`,
			);
		} else {
			classImports.push(
				`import { ${c.className} } from ${JSON.stringify(toImportSpecifier(c.file))};`,
			);
		}
		classExports.push(c.className);
	}

	const queueImports: string[] = [];
	const queueCases: string[] = [];
	queues.forEach((q, i) => {
		const local = `__queueHandler${i}`;
		if (q.exportKind === 'default') {
			queueImports.push(`import ${local} from ${JSON.stringify(toImportSpecifier(q.file))};`);
		} else {
			queueImports.push(
				`import { queue as ${local} } from ${JSON.stringify(toImportSpecifier(q.file))};`,
			);
		}
		queueCases.push(
			`    case ${JSON.stringify(q.queueName)}: return ${local}(batch, env, ctx);`,
		);
	});
	const doBlock = generateDurableObjectWorkerBlock(doConfig, doHandlers, toImportSpecifier);

	const queueBlock = queues.length
		? `,
	async queue(batch, env, ctx) {
		switch (batch.queue) {
${queueCases.join('\n')}
			default:
				console.warn('[koze] No queue handler registered for:', batch.queue);
		}
	}`
		: '';

	const exportsLine = classExports.length
		? `\nexport { ${classExports.join(', ')} };\n`
		: '';

	// Workflow registry init. The runtime's `workflowStatus(name, id)` looks
	// up the convention name (e.g. 'container' for `container.workflow.ts`)
	// in this map to find the env binding, then calls `env[binding].get(id)`.
	// Without this, `workflowStatus()` short-circuits with a "no workflows
	// registered" error, marking polling as terminal immediately and
	// breaking the workflowStatus({ poll }) live-refresh contract.
	const workflowRegistryBlock = workflows.length
		? `\nimport { __setWorkflowRegistry as __kozeSetWorkflowRegistry } from '@kuratchi/koze/runtime/workflow.js';\n__kozeSetWorkflowRegistry({\n${workflows
				.map((w) => `\t${JSON.stringify(w.name)}: { binding: ${JSON.stringify(w.binding)} },`)
				.join('\n')}\n});\n`
		: '';
	const pipelineRegistryBlock = pipelines.length
		? `\nimport { __setPipelineRegistry as __kozeSetPipelineRegistry } from '@kuratchi/koze/runtime/pipeline.js';\n__kozeSetPipelineRegistry({\n${pipelines
				.map((p) => `\t${JSON.stringify(p.name)}: { binding: ${JSON.stringify(p.binding)}, pipeline: ${JSON.stringify(p.pipeline)} },`)
				.join('\n')}\n});\n`
		: '';

	const code = `${classImports.join('\n')}
${doBlock.imports}
${queueImports.join('\n')}
${workflowRegistryBlock}
${pipelineRegistryBlock}
${doBlock.code}
export default {
	fetch: async (request, env, ctx) => {
		const { handle } = await import('koze:dispatch');
		return handle(request, env, ctx);
	}${queueBlock},
};
${exportsLine}`;
	return appendWorkerModuleSourceMap(code, {
		classes,
		queues,
		doHandlers,
		file: 'kuratchi-worker.js',
	});
}

function appendWorkerModuleSourceMap(
	code: string,
	opts: {
		classes: ConventionClass[];
		queues: QueueConsumer[];
		doHandlers: DoHandlerEntry[];
		file: string;
	},
): string {
	const sources = new Map<string, string>();
	const anchors: Array<{ generatedNeedle: string; sourcePath: string; sourceNeedle?: string }> = [];
	const addSource = (filePath: string): string | null => {
		if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
		const normalized = filePath.replace(/\\/g, '/');
		if (!sources.has(normalized)) sources.set(normalized, fs.readFileSync(filePath, 'utf-8'));
		return normalized;
	};

	for (const entry of opts.classes) {
		const sourcePath = addSource(entry.file);
		if (!sourcePath) continue;
		anchors.push({
			generatedNeedle: entry.className,
			sourcePath,
			sourceNeedle: entry.className,
		});
	}

	for (const entry of opts.queues) {
		const sourcePath = addSource(entry.file);
		if (!sourcePath) continue;
		anchors.push({
			generatedNeedle: entry.exportKind === 'default' ? 'async queue' : 'case',
			sourcePath,
			sourceNeedle: entry.exportKind === 'default' ? 'export default' : 'queue',
		});
	}

	for (const handler of opts.doHandlers) {
		const sourcePath = addSource(handler.absPath);
		if (!sourcePath) continue;
		anchors.push({
			generatedNeedle: handler.className ?? handler.exportedFunctions[0] ?? handler.fileName,
			sourcePath,
			sourceNeedle: handler.className ?? handler.exportedFunctions[0],
		});
		for (const contributor of handler.classContributors ?? []) {
			const contributorPath = addSource(contributor.absPath);
			if (!contributorPath) continue;
			anchors.push({
				generatedNeedle: contributor.className,
				sourcePath: contributorPath,
				sourceNeedle: contributor.className,
			});
		}
	}

	if (sources.size === 0) return code;
	return appendInlineSourceMap(
		code,
		createGeneratedSourceMap({
			generatedCode: code,
			file: opts.file,
			sources: Array.from(sources, ([sourcePath, source]) => ({ sourcePath, source })),
			anchors,
		}),
	);
}

function generateDurableObjectWorkerBlock(
	doConfig: DoConfigEntry[],
	doHandlers: DoHandlerEntry[],
	toImportSpecifier: (filePath: string) => string,
): { imports: string; code: string } {
	if (doConfig.length === 0 || doHandlers.length === 0) {
		return { imports: '', code: '' };
	}

	const lifecycle = new Set([
		'constructor',
		'fetch',
		'alarm',
		'webSocketMessage',
		'webSocketClose',
		'webSocketError',
		'onInit',
		'onAlarm',
		'onMessage',
	]);
	const isRpcCallable = (name: string, visibility: string): boolean => {
		if (!name) return false;
		if (name.startsWith('_') || name.startsWith('__koze')) return false;
		if (visibility !== 'public') return false;
		if (lifecycle.has(name)) return false;
		return true;
	};
	const handlerImportVar = (handler: DoHandlerEntry): string =>
		`__koze_do_${toSafeIdentifier(handler.fileName)}`;
	const contributorImportVar = (handler: DoHandlerEntry, contributorClass: string, index: number): string =>
		`__koze_do_${toSafeIdentifier(`${handler.fileName}__${contributorClass}_${index}`)}`;
	const instanceProp = (handler: DoHandlerEntry): string =>
		`__kozeDo_${toSafeIdentifier(handler.fileName)}`;
	const contributorInstanceProp = (handler: DoHandlerEntry, contributorClass: string, index: number): string =>
		`__kozeDo_${toSafeIdentifier(`${handler.fileName}__${contributorClass}_${index}`)}`;

	const importLines: string[] = [
		`import { DurableObject as __KozeDurableObject } from 'cloudflare:workers';`,
		`import { __setDoContext as __kozeSetDoContext } from '@kuratchi/koze/runtime/do.js';`,
		`import { validateSchemaInput as __kozeValidateSchemaInput } from '@kuratchi/koze/runtime/schema.js';`,
		`function __kozeInvokeDoRpc(__self, __target, __methodName, __fn, __args) {`,
		`  if (typeof __fn !== 'function') throw new Error('[koze] Durable Object method not found: ' + __methodName);`,
		`  const __receiver = __target || __self;`,
		`  __kozeSetDoContext(__receiver);`,
		`  const __schema = __self?.constructor?.schemas?.[__methodName];`,
		`  const __validated = __kozeValidateSchemaInput(__schema, __args);`,
		`  return __fn.apply(__receiver, __validated);`,
		`}`,
	];

	const seenImports = new Set<string>();
	for (const handler of doHandlers) {
		const importKey = `${handler.absPath}::${handler.className ?? '*'}::${handler.exportKind ?? '*'}`;
		if (!seenImports.has(importKey)) {
			seenImports.add(importKey);
			const local = handlerImportVar(handler);
			const spec = JSON.stringify(toImportSpecifier(handler.absPath));
			if (handler.mode === 'class') {
				if (handler.exportKind === 'named' && handler.className) {
					importLines.push(`import { ${handler.className} as ${local} } from ${spec};`);
				} else {
					importLines.push(`import ${local} from ${spec};`);
				}
			} else {
				importLines.push(`import * as ${local} from ${spec};`);
			}
		}

		for (const [index, contributor] of (handler.classContributors ?? []).entries()) {
			const importKey = `${contributor.absPath}::${contributor.className}::${contributor.exportKind}`;
			if (seenImports.has(importKey)) continue;
			seenImports.add(importKey);
			const local = contributorImportVar(handler, contributor.className, index);
			const spec = JSON.stringify(toImportSpecifier(contributor.absPath));
			if (contributor.exportKind === 'named') {
				importLines.push(`import { ${contributor.className} as ${local} } from ${spec};`);
			} else {
				importLines.push(`import ${local} from ${spec};`);
			}
		}
	}

	const handlersByBinding = new Map<string, DoHandlerEntry[]>();
	for (const handler of doHandlers) {
		const list = handlersByBinding.get(handler.binding) ?? [];
		list.push(handler);
		handlersByBinding.set(handler.binding, list);
	}

	const codeLines: string[] = [];
	for (const entry of doConfig) {
		const handlers = handlersByBinding.get(entry.binding) ?? [];
		if (handlers.length === 0) continue;

		codeLines.push(`export class ${entry.className} extends __KozeDurableObject {`);
		codeLines.push(`  static binding = ${JSON.stringify(entry.binding)};`);
		codeLines.push(`  static schemas = {};`);
		codeLines.push(`  constructor(ctx, env) {`);
		codeLines.push(`    super(ctx, env);`);
		for (const handler of handlers.filter((h) => h.mode === 'class')) {
			const local = handlerImportVar(handler);
			codeLines.push(`    this.${instanceProp(handler)} = new ${local}(ctx, env);`);
			for (const [index, contributor] of (handler.classContributors ?? []).entries()) {
				const contributorLocal = contributorImportVar(handler, contributor.className, index);
				codeLines.push(`    this.${contributorInstanceProp(handler, contributor.className, index)} = new ${contributorLocal}(ctx, env);`);
			}
		}
		for (const handler of handlers.filter((h) => h.mode === 'function' && h.exportedFunctions.includes('onInit'))) {
			const local = handlerImportVar(handler);
			codeLines.push(`    __kozeSetDoContext(this);`);
			codeLines.push(`    Promise.resolve(${local}.onInit.call(this)).catch((err) => console.error('[koze] DO onInit failed:', err?.message || err));`);
		}
		codeLines.push(`  }`);

		const alarmHandlers = handlers.filter((h) => h.mode === 'function' && h.exportedFunctions.includes('onAlarm'));
		if (alarmHandlers.length > 0) {
			codeLines.push(`  async alarm(...args) {`);
			codeLines.push(`    __kozeSetDoContext(this);`);
			for (const handler of alarmHandlers) {
				codeLines.push(`    await ${handlerImportVar(handler)}.onAlarm.call(this, ...args);`);
			}
			codeLines.push(`  }`);
		}

		const messageHandlers = handlers.filter((h) => h.mode === 'function' && h.exportedFunctions.includes('onMessage'));
		if (messageHandlers.length > 0) {
			codeLines.push(`  webSocketMessage(...args) {`);
			codeLines.push(`    __kozeSetDoContext(this);`);
			for (const handler of messageHandlers) {
				codeLines.push(`    ${handlerImportVar(handler)}.onMessage.call(this, ...args);`);
			}
			codeLines.push(`  }`);
		}

		const classLifecycleTargets = new Map<string, { targetExpr: string; fnExpr: string }>();
		for (const handler of handlers.filter((h) => h.mode === 'class')) {
			const targetExpr = `this.${instanceProp(handler)}`;
			for (const method of handler.classMethods ?? []) {
				if (!lifecycle.has(method.name)) continue;
				if (method.name === 'constructor' || method.name.startsWith('on')) continue;
				classLifecycleTargets.set(method.name, { targetExpr, fnExpr: `${targetExpr}?.${method.name}` });
			}
		}
		if (alarmHandlers.length > 0) classLifecycleTargets.delete('alarm');
		if (messageHandlers.length > 0) classLifecycleTargets.delete('webSocketMessage');
		for (const [methodName, target] of classLifecycleTargets) {
			codeLines.push(`  ${methodName}(...args) {`);
			codeLines.push(`    const __target = ${target.targetExpr};`);
			codeLines.push(`    __kozeSetDoContext(__target || this);`);
			codeLines.push(`    return ${target.fnExpr}?.apply(__target || this, args);`);
			codeLines.push(`  }`);
		}

		const methodTargets = new Map<string, { targetExpr: string; fnExpr: string }>();
		for (const handler of handlers.filter((h) => h.mode === 'class')) {
			for (const method of handler.classMethods ?? []) {
				if (!isRpcCallable(method.name, method.visibility)) continue;
				const targetExpr = `this.${instanceProp(handler)}`;
				methodTargets.set(method.name, { targetExpr, fnExpr: `${targetExpr}?.${method.name}` });
			}
			for (const [index, contributor] of (handler.classContributors ?? []).entries()) {
				for (const method of contributor.classMethods ?? []) {
					if (!isRpcCallable(method.name, method.visibility)) continue;
					const targetExpr = `this.${contributorInstanceProp(handler, contributor.className, index)}`;
					methodTargets.set(method.name, { targetExpr, fnExpr: `${targetExpr}?.${method.name}` });
				}
			}
		}
		for (const handler of handlers.filter((h) => h.mode === 'function')) {
			for (const fn of handler.exportedFunctions) {
				if (!fn || fn.startsWith('_') || lifecycle.has(fn)) continue;
				methodTargets.set(fn, { targetExpr: 'this', fnExpr: `${handlerImportVar(handler)}.${fn}` });
			}
		}
		for (const [methodName, target] of methodTargets) {
			codeLines.push(`  ${methodName}(...args) {`);
			codeLines.push(`    const __target = ${target.targetExpr};`);
			codeLines.push(`    return __kozeInvokeDoRpc(this, __target, ${JSON.stringify(methodName)}, ${target.fnExpr}, args);`);
			codeLines.push(`  }`);
		}
		codeLines.push(`}`);

		for (const handler of handlers) {
			const local = handlerImportVar(handler);
			codeLines.push(`Object.assign(${entry.className}.schemas, ${local}.schemas || {});`);
			for (const [index, contributor] of (handler.classContributors ?? []).entries()) {
				const contributorLocal = contributorImportVar(handler, contributor.className, index);
				codeLines.push(`Object.assign(${entry.className}.schemas, ${contributorLocal}.schemas || {});`);
			}
		}
	}

	return {
		imports: importLines.join('\n'),
		code: codeLines.length > 0 ? `\n// Durable Object RPC classes (generated)\n${codeLines.join('\n')}\n` : '',
	};
}

function generateRoutesModule(routes: DiscoveredRoute[]): string {
	const imports = routes
		.map((r, i) => `import * as r${i} from ${JSON.stringify(VIRTUAL_ROUTE_PREFIX + routeModuleHash(r.absPath))};`)
		.join('\n');
	const preparedRouter = JSON.stringify(createPreparedRouter(routes.map((r) => r.urlPattern)));
	const entries = routes
		.map(
			(r, i) =>
				`  { pattern: ${JSON.stringify(r.urlPattern)}, type: ${JSON.stringify(r.type)}, module: r${i} }`,
		)
		.join(',\n');
	return `${imports}\n\nexport const routes = [\n${entries}\n];\n\nexport const preparedRouter = ${preparedRouter};\n`;
}
