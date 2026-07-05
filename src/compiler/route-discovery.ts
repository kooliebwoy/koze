import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RouteFile {
  absPath: string;
  file: string;
  name: string;
  layouts: string[];
  type: 'page' | 'api';
}

export interface RouteDiscoveryOptions {
  apiDir?: string;
  apiUrlPrefix?: string;
}

const ROUTE_EXT = '.koze';
const LEGACY_ROUTE_EXT = '.kuratchi';
const ROUTE_EXTENSIONS = [ROUTE_EXT, LEGACY_ROUTE_EXT] as const;
const LAYOUT_BASENAME = 'layout';
const INDEX_BASENAME = 'index';
const ERROR_PAGE_RE = /^\d{3}\.(koze|kuratchi)$/;
const API_ROUTE_RE = /\.(ts|js)$/;
const API_SHIELD_SIDECAR_RE = /\.api-shield\.(ts|js)$/;

export function discoverRoutes(routesDir: string, options: RouteDiscoveryOptions = {}): RouteFile[] {
  const results: RouteFile[] = [];
  const registered = new Set<string>();
  const apiDir = options.apiDir ?? path.join(routesDir, 'api');
  const apiUrlPrefix = normalizeApiUrlPrefix(options.apiUrlPrefix);

  function getLayoutsForPrefix(prefix: string): string[] {
    const layouts: string[] = [];
    const rootLayout = resolveSourceSibling(routesDir, LAYOUT_BASENAME);
    if (rootLayout) layouts.push(path.relative(routesDir, rootLayout).replace(/\\/g, '/'));
    if (!prefix) return layouts;

    const parts = prefix.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const layout = resolveSourceSibling(path.join(routesDir, current), LAYOUT_BASENAME);
      if (layout) layouts.push(path.relative(routesDir, layout).replace(/\\/g, '/'));
    }
    return layouts;
  }

  function registerRoute(route: RouteFile): void {
    if (registered.has(route.absPath)) return;
    if (results.some((existing) => existing.type === route.type && existing.name === route.name)) {
      throw new Error(`[koze] Duplicate route source for "${route.name}". Keep either the .koze or .kuratchi file, not both.`);
    }
    registered.add(route.absPath);
    results.push(route);
  }

  function walkPages(dir: string, prefix: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (isWithinApiDir(entryPath, apiDir)) {
        if (entry.isDirectory()) continue;
        if (isSourceFileName(entry.name)) continue;
      }

      if (entry.isDirectory()) {
        const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
        const pageFile = resolveSourceSibling(entryPath, INDEX_BASENAME);
        if (pageFile) {
          const routeFile = `${childPrefix}/${path.basename(pageFile)}`;
          registerRoute({
            absPath: pageFile,
            file: routeFile,
            name: childPrefix,
            layouts: getLayoutsForPrefix(childPrefix),
            type: 'page',
          });
        }

        walkPages(entryPath, childPrefix);
        continue;
      }

      // Layout files and error pages (e.g. 404.koze, 500.koze) are
      // handled separately; skip them here so they don't become addressable
      // routes.
      if (stripSourceExtension(entry.name) === LAYOUT_BASENAME || ERROR_PAGE_RE.test(entry.name)) {
        continue;
      }

      if (stripSourceExtension(entry.name) === INDEX_BASENAME && isSourceFileName(entry.name)) {
        const routeFile = prefix ? `${prefix}/${entry.name}` : entry.name;
        registerRoute({
          absPath: path.join(dir, entry.name),
          file: routeFile,
          name: prefix || 'index',
          layouts: getLayoutsForPrefix(prefix),
          type: 'page',
        });
        continue;
      }

      if (isSourceFileName(entry.name) && stripSourceExtension(entry.name) !== INDEX_BASENAME) {
        const stem = stripSourceExtension(entry.name);
        const name = prefix ? `${prefix}/${stem}` : stem;
        registerRoute({
          absPath: path.join(dir, entry.name),
          file: prefix ? `${prefix}/${entry.name}` : entry.name,
          name,
          layouts: getLayoutsForPrefix(prefix),
          type: 'page',
        });
      }
    }
  }

  function walkApi(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkApi(entryPath);
        continue;
      }
      if (!API_ROUTE_RE.test(entry.name) || API_SHIELD_SIDECAR_RE.test(entry.name)) continue;

      const rel = path.relative(apiDir, entryPath).replace(/\\/g, '/');
      registerRoute({
        absPath: entryPath,
        file: rel,
        name: apiRouteName(rel, apiUrlPrefix),
        layouts: [],
        type: 'api',
      });
    }
  }

  walkPages(routesDir, '');
  walkApi(apiDir);

  results.sort((a, b) => {
    const aScore = a.name.includes('[...') ? 2 : a.name.includes('[') ? 1 : 0;
    const bScore = b.name.includes('[...') ? 2 : b.name.includes('[') ? 1 : 0;
    return aScore - bScore || a.name.localeCompare(b.name);
  });

  return results;
}

function sourceExtension(fileName: string): string | null {
  return ROUTE_EXTENSIONS.find((ext) => fileName.endsWith(ext)) ?? null;
}

function isSourceFileName(fileName: string): boolean {
  return sourceExtension(fileName) !== null;
}

function stripSourceExtension(fileName: string): string {
  const ext = sourceExtension(fileName);
  return ext ? fileName.slice(0, -ext.length) : fileName;
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

function isWithinApiDir(candidate: string, apiDir: string): boolean {
  const rel = path.relative(apiDir, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeApiUrlPrefix(value: string | undefined): string {
  if (!value) return '/api';
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '/';
  return '/' + trimmed.replace(/^\/+|\/+$/g, '');
}

function apiRouteName(relativeFile: string, apiUrlPrefix: string): string {
  const withoutExt = relativeFile.replace(/\.(ts|js)$/, '');
  const fileSegments = withoutExt.split('/').filter((segment) => segment && segment !== 'index');
  const prefixSegments = apiUrlPrefix === '/'
    ? []
    : apiUrlPrefix.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  const allSegments = [...prefixSegments, ...fileSegments];
  return allSegments.length > 0 ? allSegments.join('/') : 'index';
}
