type ContainerLike = {
  start?: (options: { envVars?: Record<string, string> }) => Promise<unknown>;
  fetch: (request: Request) => Promise<Response>;
};

type ContainerFactory = (namespace: DurableObjectNamespace, slug: string) => ContainerLike;

export interface StartContainerOptions {
  namespace: DurableObjectNamespace;
  slug: string;
  containerFactory: ContainerFactory;
  envVars?: Record<string, string>;
}

export interface ProxyToContainerOptions extends StartContainerOptions {
  request: Request;
  onError?: (slug: string, err: unknown) => Response;
}

export interface ContainerPathMatch {
  slug: string;
  containerPath: string;
}

export interface HandleContainerRoutingOptions {
  request: Request;
  appDomain: string;
  proxyToSlug: (slug: string, request: Request) => Promise<Response>;
  sitePrefix?: string;
  viewSegment?: string;
  blockContainerPathPrefix?: string;
  skipSubdomainWhenPathStartsWith?: string;
}

export function extractSubdomainSlug(host: string, appDomain: string): string | null {
  if (host.endsWith('.localhost')) {
    const slug = host.slice(0, -'.localhost'.length);
    return slug || null;
  }
  if (host.endsWith('.' + appDomain)) {
    const slug = host.slice(0, -(appDomain.length + 1));
    return slug && !slug.includes('.') ? slug : null;
  }
  return null;
}

export function extractSlugFromPrefix(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slug = rest.split('/')[0];
  return slug || null;
}

export function matchContainerViewPath(pathname: string, opts?: {
  sitePrefix?: string;
  viewSegment?: string;
}): ContainerPathMatch | null {
  const sitePrefix = opts?.sitePrefix ?? '/sites/';
  const viewSegment = opts?.viewSegment ?? '/view';
  if (!pathname.startsWith(sitePrefix)) return null;

  const rest = pathname.slice(sitePrefix.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx <= 0) return null;

  const slug = rest.slice(0, slashIdx);
  const after = rest.slice(slashIdx);
  if (!(after === viewSegment || after.startsWith(viewSegment + '/'))) return null;

  const containerPath = after.slice(viewSegment.length) || '/';
  return { slug, containerPath };
}

export function rewriteProxyLocationHeader(location: string, slug: string, opts?: {
  sitePrefix?: string;
  viewSegment?: string;
}): string {
  const sitePrefix = opts?.sitePrefix ?? '/sites';
  const viewSegment = opts?.viewSegment ?? '/view';
  const prefix = `${sitePrefix}/${slug}${viewSegment}`;

  if (location.startsWith('/')) return prefix + location;
  if (location.startsWith('http://') || location.startsWith('https://')) {
    const loc = new URL(location);
    loc.pathname = prefix + loc.pathname;
    return loc.toString();
  }
  return location;
}

export function buildContainerRequest(request: Request, containerPath: string): Request {
  const url = new URL(request.url);
  const target = new URL(containerPath, url.origin);
  target.search = url.search;
  return new Request(target.toString(), request);
}

export function createContainerEnvVars(opts: {
  slug: string;
  vars: Record<string, string | ((slug: string) => string)>;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.vars)) {
    out[key] = typeof value === 'function' ? value(opts.slug) : value;
  }
  return out;
}

export async function startContainer(options: StartContainerOptions): Promise<ContainerLike> {
  const container = options.containerFactory(options.namespace, options.slug);
  if (options.envVars && container.start) {
    await container.start({ envVars: options.envVars });
  }
  return container;
}

export async function proxyToContainer(options: ProxyToContainerOptions): Promise<Response> {
  try {
    const container = await startContainer(options);
    return await container.fetch(options.request);
  } catch (err) {
    if (options.onError) return options.onError(options.slug, err);
    throw err;
  }
}

export async function forwardJsonPostToContainerDO(options: {
  namespace: DurableObjectNamespace;
  slug: string;
  containerFactory: ContainerFactory;
  request: Request;
  targetPath?: string;
}): Promise<Response> {
  const container = options.containerFactory(options.namespace, options.slug);
  const body = await options.request.text();
  const targetPath = options.targetPath ?? '/sql';
  const doRequest = new Request(`https://do-internal${targetPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return container.fetch(doRequest);
}

export async function handleContainerRouting(options: HandleContainerRoutingOptions): Promise<Response | null> {
  const sitePrefix = options.sitePrefix ?? '/sites/';
  const viewSegment = options.viewSegment ?? '/view';
  const blockedPrefix = options.blockContainerPathPrefix ?? '/__koze/';
  const skipSubdomainPrefix = options.skipSubdomainWhenPathStartsWith ?? '/sites/';

  const url = new URL(options.request.url);
  const hostHeader = options.request.headers.get('host') || url.host;
  const host = hostHeader.split(':')[0];

  const subdomainSlug = extractSubdomainSlug(host, options.appDomain);
  if (subdomainSlug && !url.pathname.startsWith(skipSubdomainPrefix)) {
    return options.proxyToSlug(subdomainSlug, options.request);
  }

  const pathMatch = matchContainerViewPath(url.pathname, { sitePrefix, viewSegment });
  if (!pathMatch) return null;
  if (pathMatch.containerPath.startsWith(blockedPrefix)) {
    return new Response('Not Found', { status: 404 });
  }

  const containerRequest = buildContainerRequest(options.request, pathMatch.containerPath);
  const res = await options.proxyToSlug(pathMatch.slug, containerRequest);
  const location = res.headers.get('location');
  if (location && res.status >= 300 && res.status < 400) {
    const rewritten = rewriteProxyLocationHeader(location, pathMatch.slug, {
      sitePrefix: sitePrefix.endsWith('/') ? sitePrefix.slice(0, -1) : sitePrefix,
      viewSegment,
    });
    const newRes = new Response(res.body, res);
    newRes.headers.set('location', rewritten);
    return newRes;
  }
  return res;
}

// Backwards-compatible aliases (to avoid breaking early adopters)
export const startSiteContainer = startContainer;
export const proxyToSiteContainer = proxyToContainer;
export const matchSiteViewPath = matchContainerViewPath;
export const buildSiteContainerRequest = buildContainerRequest;
export const createWpContainerEnvVars = createContainerEnvVars;


