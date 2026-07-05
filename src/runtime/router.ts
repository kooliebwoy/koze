/**
 * URL router - matches incoming requests to route modules.
 *
 * Supports:
 *   /todos          -> static
 *   /blog/:slug     -> named param
 *   /files/*rest    -> catch-all
 *
 * Uses a serializable segment trie for O(depth) dynamic route matching instead
 * of O(n) linear scan. The compiler can emit the prepared trie directly so
 * Workers do not rebuild routing state during startup.
 */

export interface MatchResult {
  params: Record<string, string>;
  index: number;
}

export interface PreparedRouterNode {
  /** Route index if this node is a terminal. */
  routeIndex?: number;
  /** Parameter name for param/catch-all nodes. */
  paramName?: string;
  /** Static child nodes keyed by the full path segment. */
  children?: Record<string, PreparedRouterNode>;
  /** Param child. Only one is allowed per level. */
  paramChild?: PreparedRouterNode;
  /** Catch-all child. Only one is allowed per level and it must be terminal. */
  catchAllChild?: PreparedRouterNode;
}

export interface PreparedRouter {
  /** Exact static path -> route index. */
  staticRoutes: Record<string, number>;
  root: PreparedRouterNode;
}

function createDict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function createPreparedNode(paramName?: string): PreparedRouterNode {
  const node: PreparedRouterNode = { children: createDict<PreparedRouterNode>() };
  if (paramName) node.paramName = paramName;
  return node;
}

function createEmptyPreparedRouter(): PreparedRouter {
  return {
    staticRoutes: createDict<number>(),
    root: createPreparedNode(),
  };
}

export function createPreparedRouter(patterns: readonly string[]): PreparedRouter {
  const prepared = createEmptyPreparedRouter();
  for (let i = 0; i < patterns.length; i++) {
    addPreparedRoute(prepared, patterns[i], i);
  }
  return prepared;
}

function addPreparedRoute(prepared: PreparedRouter, pattern: string, index: number): void {
  if (!pattern.includes(':') && !pattern.includes('*')) {
    prepared.staticRoutes[pattern] = index;
    return;
  }

  const segments = pattern.split('/').filter(Boolean);
  let node = prepared.root;

  for (const seg of segments) {
    if (seg.startsWith('*')) {
      const paramName = seg.slice(1);
      if (!node.catchAllChild) {
        node.catchAllChild = createPreparedNode(paramName);
      }
      node = node.catchAllChild;
      break;
    }

    if (seg.startsWith(':')) {
      const paramName = seg.slice(1);
      if (!node.paramChild) {
        node.paramChild = createPreparedNode(paramName);
      }
      node = node.paramChild;
      continue;
    }

    const children = node.children || (node.children = createDict<PreparedRouterNode>());
    let child = children[seg];
    if (!child) {
      child = createPreparedNode();
      children[seg] = child;
    }
    node = child;
  }

  node.routeIndex = index;
}

export function matchPreparedRouter(prepared: PreparedRouter, pathname: string): MatchResult | null {
  const normalized = normalizePathname(pathname);
  const staticIdx = prepared.staticRoutes[normalized];
  if (staticIdx !== undefined) {
    return { params: {}, index: staticIdx };
  }

  const segments = normalized.split('/').filter(Boolean);
  const params = createDict<string>();
  const result = matchPreparedNode(prepared.root, segments, 0, params);
  if (result === null) return null;
  return { params, index: result };
}

function normalizePathname(pathname: string): string {
  return pathname.length > 1 && pathname.charCodeAt(pathname.length - 1) === 47
    ? pathname.slice(0, -1)
    : pathname;
}

function matchPreparedNode(
  node: PreparedRouterNode,
  segments: string[],
  segIdx: number,
  params: Record<string, string>,
): number | null {
  if (segIdx >= segments.length) {
    return node.routeIndex ?? null;
  }

  const seg = segments[segIdx];
  const staticChild = node.children?.[seg];
  if (staticChild) {
    const result = matchPreparedNode(staticChild, segments, segIdx + 1, params);
    if (result !== null) return result;
  }

  if (node.paramChild) {
    const paramName = node.paramChild.paramName!;
    const oldValue = params[paramName];
    params[paramName] = seg;

    const result = matchPreparedNode(node.paramChild, segments, segIdx + 1, params);
    if (result !== null) return result;

    if (oldValue !== undefined) {
      params[paramName] = oldValue;
    } else {
      delete params[paramName];
    }
  }

  if (node.catchAllChild) {
    const paramName = node.catchAllChild.paramName!;
    params[paramName] = segments.slice(segIdx).join('/');
    return node.catchAllChild.routeIndex ?? null;
  }

  return null;
}

export class Router {
  private prepared: PreparedRouter = createEmptyPreparedRouter();

  /** Register a pattern (e.g. '/blog/:slug') and associate it with an index. */
  add(pattern: string, index: number): void {
    addPreparedRoute(this.prepared, pattern, index);
  }

  /** Match a pathname against registered routes. Returns null if no match. */
  match(pathname: string): MatchResult | null {
    return matchPreparedRouter(this.prepared, pathname);
  }
}

/**
 * Convert a file-system path to a route pattern.
 *
 * Examples:
 *   'index'        -> '/'
 *   'about'        -> '/about'
 *   'blog/[slug]'  -> '/blog/:slug'
 *   'files/[...path]' -> '/files/*path'
 */
export function filePathToPattern(filePath: string): string {
  if (filePath === 'index') return '/';

  let pattern = '/' + filePath
    // [...param] -> *param (catch-all)
    .replace(/\[\.\.\.(\w+)\]/g, '*$1')
    // [param] -> :param
    .replace(/\[(\w+)\]/g, ':$1');

  // Remove trailing /index
  pattern = pattern.replace(/\/index$/, '') || '/';

  return pattern;
}
