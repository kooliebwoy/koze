/**
 * Centralized koze:* virtual module resolution.
 *
 * All koze:* imports are rewritten to scoped Koze runtime paths.
 * This is the single source of truth for virtual module mapping.
 *
 * Usage:
 *   import { dev } from 'koze:environment';
 *   import { url, params, locals } from 'koze:request';
 *   import { redirect, navigateTo, refreshRoute } from 'koze:navigation';
 */

import type { ImportBinding } from './import-linking.js';

export type KozeVirtualModuleContext = 'route' | 'server' | 'browser';

/**
 * Map of koze:* module names to their Koze runtime package paths.
 * All paths use the ./runtime/*.js pattern for consistency.
 */
export const VIRTUAL_MODULE_MAP: Record<string, string> = {
  environment: '@kuratchi/koze/runtime/environment.js',
  request: '@kuratchi/koze/runtime/request.js',
  navigation: '@kuratchi/koze/runtime/navigation.js',
  cookies: '@kuratchi/koze/runtime/cookies.js',
  middleware: '@kuratchi/koze/runtime/middleware-virtual.js',
  // `koze:component` is consumed at compile time — `props<T>()` is
  // rewritten to a reference to the component wrapper's `props`
  // parameter. The runtime export below is just the type contract; if a
  // route or layout accidentally imports from `koze:component`, the
  // import resolves to a no-op so it doesn't crash, but it has no
  // effect (the rewrite only fires inside component scripts).
  component: '@kuratchi/koze/runtime/component.js',
};

/** All supported koze:* module names */
export const VIRTUAL_MODULE_NAMES = Object.keys(VIRTUAL_MODULE_MAP);
const VIRTUAL_PREFIX = 'koze:';

const CONTEXTUAL_VIRTUAL_EXPORTS: Partial<Record<string, Partial<Record<KozeVirtualModuleContext, string[]>>>> = {
  environment: {
    route: ['dev'],
    server: ['dev'],
    browser: ['dev'],
  },
  request: {
    route: ['url', 'pathname', 'searchParams', 'method', 'params', 'slug'],
    server: ['request', 'url', 'pathname', 'searchParams', 'headers', 'method', 'params', 'slug', 'locals'],
  },
  navigation: {
    route: ['redirect', 'navigateTo', 'refreshRoute'],
    server: ['redirect'],
    browser: ['navigateTo', 'refreshRoute'],
  },
  cookies: {
    server: ['cookies'],
  },
  middleware: {
    server: ['defineMiddleware'],
  },
  content: {
    route: ['content'],
    server: ['content'],
    browser: ['content'],
  },
};

/**
 * Check if a module specifier is a koze:* virtual module
 */
export function isKozeVirtualModule(spec: string): boolean {
  return spec.startsWith(VIRTUAL_PREFIX);
}

/**
 * Resolve a koze:* virtual module to its koze runtime path.
 * Returns the original specifier if not a known virtual module.
 */
export function resolveKozeVirtualModule(spec: string): string {
  const moduleName = getKozeModuleName(spec);
  if (!moduleName) return spec;
  return VIRTUAL_MODULE_MAP[moduleName] ?? spec;
}

/**
 * Get the module name from a koze:* specifier (e.g., 'koze:request' -> 'request')
 */
export function getKozeModuleName(spec: string): string | null {
  return spec.startsWith(VIRTUAL_PREFIX) ? spec.slice(VIRTUAL_PREFIX.length) : null;
}

export function getAllowedKozeExports(
  spec: string,
  context: KozeVirtualModuleContext,
): string[] | null {
  const moduleName = getKozeModuleName(spec);
  if (!moduleName) return null;
  const moduleRules = CONTEXTUAL_VIRTUAL_EXPORTS[moduleName];
  if (!moduleRules) return null;
  return moduleRules[context] ?? [];
}

export function validateKozeVirtualModuleImport(
  spec: string,
  bindings: ImportBinding[],
  namespaceImport: string | null,
  context: KozeVirtualModuleContext,
): void {
  const allowed = getAllowedKozeExports(spec, context);
  if (!allowed) return;

  if (namespaceImport) {
    throw new Error(
      `[koze compiler] ${spec} does not support namespace imports in ${context} context.\n` +
      `Use named imports. Allowed exports: ${allowed.join(', ')}`
    );
  }

  for (const binding of bindings) {
    if (!allowed.includes(binding.imported)) {
      throw new Error(
        `[koze compiler] ${spec} export '${binding.imported}' is not available in ${context} context.\n` +
        `Allowed exports: ${allowed.join(', ')}`
      );
    }
  }
}

/**
 * TypeScript module declarations for all koze:* virtual modules.
 * Used by type-generator.ts to emit into app.d.ts.
 *
 * Content group names parameterize `koze:content`; Cloudflare product types
 * come from Wrangler and the native Worker module, not Koze declarations.
 */
export function buildVirtualModuleTypeDeclarations(
  contentNames: string[] = [],
): string {
  const contentNameUnion = contentNames.length > 0
    ? contentNames.map((n) => `'${n}'`).join(' | ')
    : 'never';
  const contentProperties = contentNames
    .map((name) => `    readonly ${tsPropertyName(name)}: ContentGroup;`)
    .join('\n');
  const contentType = contentProperties
    ? `{\n${contentProperties}\n  } & Record<ContentName, ContentGroup>`
    : 'Record<string, ContentGroup>';

  const declarations = `
/** Virtual module: koze:worker */
declare module 'koze:worker' {
  /** Koze's HTTP route dispatcher for composition in the application-owned Worker. */
  export function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

/** Virtual module: koze:environment */
declare module 'koze:environment' {
  /** True during \`vite dev\`, false in production builds. */
  export const dev: boolean;
}

/** Virtual module: koze:request */
declare module 'koze:request' {
  /** Raw request object. Server-only. */
  export const request: Request;
  /** Current request URL */
  export const url: URL;
  /** Current pathname (e.g., '/blog/hello-world') */
  export const pathname: string;
  /** URL search params */
  export const searchParams: URLSearchParams;
  /** Raw request headers. Server-only. */
  export const headers: Headers;
  /** HTTP method (GET, POST, etc.) */
  export const method: string;
  /** Route params (e.g., { slug: 'hello-world' }) */
  export const params: Record<string, string>;
  /** Shorthand for params.slug or first param value */
  export const slug: string | undefined;
  /** Request-scoped locals set by runtime hooks. Server-only. */
  export const locals: App.Locals;
}

/** Virtual module: koze:navigation */
declare module 'koze:navigation' {
  /** Redirect to a path. Throws RedirectError caught by the framework. */
  export function redirect(path: string, status?: number): never;
  export interface NavigateToOptions {
    replace?: boolean;
  }
  /** Navigate in the browser from client event handlers. */
  export function navigateTo(path: string, options?: NavigateToOptions): Promise<void>;
  /** Refetch and replace the current route in the browser. */
  export function refreshRoute(): Promise<void>;
}

/** Virtual module: koze:cookies */
declare module 'koze:cookies' {
  export interface CookieOptions {
    path?: string;
    domain?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
    maxAge?: number;
    expires?: Date;
  }

  export interface CookieStore {
    get(name: string): string | undefined;
    getAll(): Record<string, string>;
    has(name: string): boolean;
    set(name: string, value: string, options?: CookieOptions): void;
    delete(name: string, options?: CookieOptions): void;
    serialize(name: string, value: string, options?: CookieOptions): string;
  }

  export const cookies: CookieStore;
}

/** Virtual module: koze:middleware */
declare module 'koze:middleware' {
  export function defineMiddleware<E = any>(middleware: E): E;
}

/** Virtual module: koze:component */
declare module 'koze:component' {
  /**
   * Typed accessor for the props passed to this component by its parent.
   *
   * Authors call this at the top of the component's <script> block to
   * obtain a typed, named handle on incoming props instead of relying
   * on an ambient \`props.X\` reference.
   *
   * \`\`\`html
   * <script>
   *   import { props } from 'koze:component';
   *   const { title, variant = 'default' } = props<{
   *     title: string;
   *     variant?: 'default' | 'success';
   *   }>();
   * </script>
   * <div class="card {variant}">{title}</div>
   * \`\`\`
   *
   * The compiler rewrites \`props()\` calls inside component scripts to
   * reference the component's incoming props parameter. Outside a
   * component file (e.g. a route or layout), the import resolves to a
   * runtime no-op — calling it returns \`{}\`.
   */
  export function props<T = Record<string, unknown>>(): T;
}

/** Virtual module: koze:content */
declare module 'koze:content' {
  /** Discovered content names from src/content/<name>/*.md. */
  export type ContentName = ${contentNameUnion};

  export type ContentFrontmatter = Record<string, unknown>;

  export interface ContentHeading {
    depth: number;
    slug: string;
    text: string;
  }

  export interface ContentListItem {
    id: string;
    href: string;
    file: string;
    title: string;
    description?: string;
    section?: string;
    order: number;
    headings: ContentHeading[];
    frontmatter: ContentFrontmatter;
  }

  export interface RenderedContent extends ContentListItem {
    html: string;
    body: string;
  }

  export interface ContentGroup {
    list(): Promise<ContentListItem[]>;
    render(id: string): Promise<RenderedContent | null>;
  }

  export const content: ${contentType};
  export default content;
}
`.trim();
  return declarations;
}

function tsPropertyName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}
