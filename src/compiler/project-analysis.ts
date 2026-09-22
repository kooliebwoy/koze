/** Project analysis for Koze-owned routes, layouts, and app shells. */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DiscoveredRoute {
	absPath: string;
	urlPattern: string;
	id: string;
	type: 'page' | 'api';
}

const ROUTE_EXT = '.koze';
const API_ROUTE_RE = /\.(ts|js)$/;
export const KOZE_API_ROOT = 'src/routes/api';
export const KOZE_API_URL_PREFIX = '/api';
const ROUTE_LAYOUT_BASENAME = 'layout';
const ROUTE_APP_BASENAME = 'app';

export function isPageRouteFile(filePath: string): boolean {
	return routeSourceExtension(filePath) !== null;
}

export function isRouteLayoutFile(filePath: string): boolean {
	return stripRouteSourceExtension(path.basename(filePath)) === ROUTE_LAYOUT_BASENAME;
}

function routeSourceExtension(filePath: string): string | null {
	return filePath.endsWith(ROUTE_EXT) ? ROUTE_EXT : null;
}

function stripRouteSourceExtension(filePath: string): string {
	const ext = routeSourceExtension(filePath);
	return ext ? filePath.slice(0, -ext.length) : filePath;
}

function resolveSourceSibling(dir: string, basename: string): string | null {
	const candidate = path.join(dir, basename + ROUTE_EXT);
	return fs.existsSync(candidate) ? candidate : null;
}
export function discoverRoutes(
	projectRoot: string,
	routesDir: string,
): DiscoveredRoute[] {
	const routesAbs = path.resolve(projectRoot, routesDir);
	const apiAbs = path.resolve(projectRoot, KOZE_API_ROOT);
	const out: DiscoveredRoute[] = [];
	if (fs.existsSync(routesAbs)) {
		walk(routesAbs, (file) => {
			if (!isPageRouteFile(file)) return;
			if (isUnderApiRoot(file, projectRoot)) return;
			const rel = path.relative(routesAbs, file);
			const basename = path.basename(file);
			const stem = stripRouteSourceExtension(basename);
			if (stem === ROUTE_LAYOUT_BASENAME || stem === 'error') return;
			const urlPattern = pathToUrlPattern(rel);
			const id = stripRouteSourceExtension(rel).replace(/[\\/]/g, '__');
			if (out.some((route) => route.type === 'page' && route.id === id)) {
				throw new Error(`[koze] Duplicate route source for "${urlPattern}". Keep one .koze file for this route.`);
			}
			out.push({ absPath: file, urlPattern, id, type: 'page' });
		});
	}
	if (fs.existsSync(apiAbs)) {
		walk(apiAbs, (file) => {
			if (!API_ROUTE_RE.test(file)) return;
			const rel = path.relative(apiAbs, file);
			const urlPattern = apiPathToUrlPattern(rel);
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
		const isApiRoute = isApiRouteFile(file, projectRoot);
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

export function assertNoRemovedKozeSources(projectRoot: string): void {
	const srcDir = path.resolve(projectRoot, 'src');
	if (!fs.existsSync(srcDir)) return;
	const removed: string[] = [];
	walk(srcDir, (file) => {
		if (file.endsWith('.kuratchi')) {
			removed.push(path.relative(projectRoot, file).replace(/\\/g, '/'));
		}
	});
	if (removed.length > 0) {
		throw new Error(
			`[koze] The .kuratchi source extension has been removed. Rename to .koze:\n` +
				removed.map((file) => `- ${file} -> ${file.slice(0, -'.kuratchi'.length)}.koze`).join('\n'),
		);
	}
}

/**
 * Look for a root layout at `routes/layout.koze`.
 * Returns the first match, or null.
 */
export function discoverRootLayout(projectRoot: string, routesDir: string): string | null {
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
export function discoverAllLayouts(projectRoot: string, routesDir: string): string[] {
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
export function layoutChainForRoute(
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
export function discoverRootApp(projectRoot: string, _routesDir: string): string | null {
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

function apiPathToUrlPattern(rel: string): string {
	const withoutExt = rel.replace(/\.(ts|js)$/, '');
	const fileSegments = withoutExt.split(/[\\/]/).filter((segment) => segment !== 'index');
	const prefixSegments = KOZE_API_URL_PREFIX.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
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

function isUnderApiRoot(file: string, projectRoot: string): boolean {
	const abs = path.resolve(projectRoot, KOZE_API_ROOT);
	const rel = path.relative(abs, file);
	return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isApiRouteFile(filePath: string, projectRoot: string): boolean {
	return API_ROUTE_RE.test(filePath) && isUnderApiRoot(filePath, projectRoot);
}

export function isRouteFile(
	filePath: string,
	projectRoot: string,
	routesDir: string,
): boolean {
	return (
		(isPageRouteFile(filePath) && isUnderRoutesDir(filePath, projectRoot, routesDir)) ||
		isApiRouteFile(filePath, projectRoot)
	);
}

export interface AnalyzeProjectOptions {
	projectRoot: string;
	routesDir: string;
}

export interface ProjectAnalysis {
	routes: DiscoveredRoute[];
	rootLayoutPath: string | null;
	rootAppPath: string | null;
	allLayoutPaths: string[];
}

export function analyzeProject(options: AnalyzeProjectOptions): ProjectAnalysis {
	assertNoRemovedKozeSources(options.projectRoot);
	return {
		routes: discoverRoutes(options.projectRoot, options.routesDir),
		rootLayoutPath: discoverRootLayout(options.projectRoot, options.routesDir),
		rootAppPath: discoverRootApp(options.projectRoot, options.routesDir),
		allLayoutPaths: discoverAllLayouts(options.projectRoot, options.routesDir),
	};
}
