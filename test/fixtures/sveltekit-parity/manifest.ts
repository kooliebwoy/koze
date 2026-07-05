export type SvelteKitParityStatus = 'ported-pass' | 'ported-fail' | 'future-feature' | 'not-applicable';

export interface SvelteKitParityEvidence {
  file: string;
  testName: string;
}

export interface SvelteKitParityFixture {
  id: string;
  category:
    | 'routing'
    | 'load'
    | 'layout'
    | 'form-action'
    | 'api-route'
    | 'rpc'
    | 'middleware'
    | 'error'
    | 'asset'
    | 'head'
    | 'cookie'
    | 'navigation'
    | 'adapter';
  status: SvelteKitParityStatus;
  notes: string;
  evidence?: SvelteKitParityEvidence;
}

/**
 * SvelteKit parity is tracked separately from Svelte compiler parity.
 *
 * Svelte covers component/template/compiler semantics. SvelteKit covers the
 * full-stack framework contract: routing, load, actions, errors, redirects,
 * middleware/hooks, server endpoints, assets, and adapter behavior.
 */
export const SVELTEKIT_PARITY_FIXTURES: SvelteKitParityFixture[] = [
  {
    id: 'routing/static-dynamic-catchall',
    category: 'routing',
    status: 'ported-pass',
    notes: 'Static routes, dynamic params, and catch-all segments are covered by the runtime router.',
    evidence: {
      file: 'test/router.test.ts',
      testName: 'matches dynamic params and catch-all routes',
    },
  },
  {
    id: 'routing/static-priority',
    category: 'routing',
    status: 'ported-pass',
    notes: 'Static route priority over dynamic siblings is covered.',
    evidence: {
      file: 'test/router.test.ts',
      testName: 'prefers exact static routes over dynamic params',
    },
  },
  {
    id: 'routing/trailing-slash-normalization',
    category: 'routing',
    status: 'ported-pass',
    notes: 'Page routes match consistently with or without a trailing slash.',
    evidence: {
      file: 'test/runtime-generated-worker.test.ts',
      testName: 'matches page routes regardless of trailing slash',
    },
  },
  {
    id: 'load/route-load-data',
    category: 'load',
    status: 'ported-pass',
    notes: 'Route load data is passed into SSR render functions.',
    evidence: {
      file: 'test/runtime-generated-worker.test.ts',
      testName: 'runs middleware consistently for page, api, rpc, and action routes',
    },
  },
  {
    id: 'layout/custom-error-wrapper',
    category: 'layout',
    status: 'ported-pass',
    notes: 'Error pages render through the layout wrapper.',
    evidence: {
      file: 'test/runtime-generated-worker.test.ts',
      testName: 'renders custom 404 pages through the layout wrapper',
    },
  },
  {
    id: 'layout/nested-server-state',
    category: 'layout',
    status: 'ported-pass',
    notes: 'Nested layout server state is merged into child route compilation.',
    evidence: {
      file: 'test/compiler-typescript-script.test.ts',
      testName: 'merges nested layout server state into child route compilation',
    },
  },
  {
    id: 'form-action/context-signature',
    category: 'form-action',
    status: 'ported-pass',
    notes: 'Form actions receive a context object with formData, request, url, and params.',
    evidence: {
      file: 'test/vite/action-invocation.test.ts',
      testName: 'form submission: handler receives only the context object',
    },
  },
  {
    id: 'form-action/generated-worker-context-signature',
    category: 'form-action',
    status: 'ported-pass',
    notes: 'Generated Worker actions use the same context-object calling convention as the Vite runtime.',
    evidence: {
      file: 'test/runtime-generated-worker.test.ts',
      testName: 'passes the documented context object to native form actions',
    },
  },
  {
    id: 'form-action/redirect-after-post',
    category: 'form-action',
    status: 'ported-pass',
    notes: 'Actions can redirect after POST and preserve middleware context.',
    evidence: {
      file: 'test/runtime-generated-worker.test.ts',
      testName: 'runs middleware consistently for page, api, rpc, and action routes',
    },
  },
  {
    id: 'api-route/method-handler',
    category: 'api-route',
    status: 'ported-pass',
    notes: 'API routes dispatch to method handlers and return Response objects.',
    evidence: {
      file: 'test/runtime-generated-worker.test.ts',
      testName: 'runs middleware consistently for page, api, rpc, and action routes',
    },
  },
  {
    id: 'api-route/head-from-get',
    category: 'api-route',
    status: 'ported-pass',
    notes: 'HEAD requests use an explicit HEAD handler when present, otherwise GET, and return no body.',
    evidence: {
      file: 'test/runtime-generated-worker.test.ts',
      testName: 'serves API HEAD requests through GET without a response body',
    },
  },
  {
    id: 'rpc/channel-route-call',
    category: 'rpc',
    status: 'ported-pass',
    notes: 'Route RPC is served through the Kuratchi Capn Web channel endpoint.',
    evidence: {
      file: 'test/runtime-generated-worker.test.ts',
      testName: 'serves route RPC through the Capn Web channel endpoint',
    },
  },
  {
    id: 'rpc/channel-route-trailing-slash-normalization',
    category: 'rpc',
    status: 'ported-pass',
    notes: 'Route RPC dispatch uses the prepared router and preserves params when the channel route includes a trailing slash.',
    evidence: {
      file: 'test/runtime-generated-worker.test.ts',
      testName: 'matches channel route RPC calls regardless of trailing slash',
    },
  },
  {
    id: 'rpc/schema-validation',
    category: 'rpc',
    status: 'ported-pass',
    notes: 'Schema-backed route RPC validates incoming payloads.',
    evidence: {
      file: 'test/runtime-generated-worker.test.ts',
      testName: 'validates route RPC arguments with companion schemas',
    },
  },
  {
    id: 'rpc/browser-asyncvalue-invalidation',
    category: 'rpc',
    status: 'ported-pass',
    notes: 'Browser RPC calls return AsyncValue state and dispatch invalidation through the Kuratchi Capn Web channel.',
    evidence: {
      file: 'test/browser-hydration.test.ts',
      testName: 'browser channel returns AsyncValue state and dispatches invalidation through Capn Web HTTP',
    },
  },
  {
    id: 'middleware/hooks-all-flows',
    category: 'middleware',
    status: 'ported-pass',
    notes: 'Middleware applies across page, API, RPC, action, and 404 flows.',
    evidence: {
      file: 'test/compiler-middleware-end-to-end.test.ts',
      testName: 'discovers src/middleware.ts and applies it across compiled page, api, rpc, action, and 404 flows',
    },
  },
  {
    id: 'middleware/locals-isolation',
    category: 'middleware',
    status: 'ported-pass',
    notes: 'Per-request locals are isolated and reset between requests.',
    evidence: {
      file: 'test/runtime-generated-worker.test.ts',
      testName: 'resets middleware locals between requests so state does not leak',
    },
  },
  {
    id: 'error/middleware-error-handler',
    category: 'error',
    status: 'ported-pass',
    notes: 'Middleware error handlers can convert thrown route errors into responses.',
    evidence: {
      file: 'test/runtime-generated-worker.test.ts',
      testName: 'runs middleware in order and lets error middleware handle failures',
    },
  },
  {
    id: 'asset/etag-revalidation',
    category: 'asset',
    status: 'ported-pass',
    notes: 'Static assets support ETag revalidation.',
    evidence: {
      file: 'test/runtime-generated-worker.test.ts',
      testName: 'serves static assets with etag revalidation',
    },
  },
  {
    id: 'asset/custom-prefix-boundary',
    category: 'asset',
    status: 'ported-pass',
    notes: 'Static assets are served only from the configured assets prefix.',
    evidence: {
      file: 'test/runtime-generated-worker.test.ts',
      testName: 'serves static assets only from the configured prefix',
    },
  },
  {
    id: 'head/structured-head',
    category: 'head',
    status: 'ported-pass',
    notes: 'Structured head content is passed separately into the layout.',
    evidence: {
      file: 'test/runtime-generated-worker.test.ts',
      testName: 'passes structured head content into the layout',
    },
  },
  {
    id: 'navigation/redirect-virtual-module',
    category: 'navigation',
    status: 'ported-pass',
    notes: 'The navigation virtual module exposes redirect helpers for server-side flows.',
    evidence: {
      file: 'test/virtual-modules.test.ts',
      testName: 'declares koze:navigation module',
    },
  },
  {
    id: 'cookie/server-cookie-module',
    category: 'cookie',
    status: 'ported-pass',
    notes: 'Server-side cookie APIs are exposed through a server-safe virtual module.',
    evidence: {
      file: 'test/virtual-modules.test.ts',
      testName: 'declares koze:cookies module',
    },
  },
  {
    id: 'load/universal-load-invalidation',
    category: 'load',
    status: 'ported-pass',
    notes: 'refreshRoute() refetches and replaces the current route through the same same-origin HTML navigation pipeline used by navigateTo().',
    evidence: {
      file: 'test/runtime-navigation.test.ts',
      testName: 'refreshRoute refetches the current URL and replaces history state',
    },
  },
  {
    id: 'form-action/enhance-client-helper',
    category: 'form-action',
    status: 'ported-pass',
    notes: 'Kuratchi supports stateful augmented POST forms with compiler-injected _action fields while preserving native no-JS form behavior.',
    evidence: {
      file: 'test/browser-hydration.test.ts',
      testName: 'state-augmented form actions submit through fetch and update action state without replacing the document',
    },
  },
  {
    id: 'navigation/client-history-api',
    category: 'navigation',
    status: 'ported-pass',
    notes: 'navigateTo() performs same-origin client navigation with history updates, document replacement, navigation events, and native navigation fallback.',
    evidence: {
      file: 'test/runtime-navigation.test.ts',
      testName: 'navigateTo fetches same-origin HTML and updates browser history',
    },
  },
  {
    id: 'adapter/node-auto',
    category: 'adapter',
    status: 'not-applicable',
    notes: 'Kuratchi targets Cloudflare Workers/V8 isolates rather than SvelteKit adapter-node.',
  },
];

export function getSvelteKitParityFixtures(status: SvelteKitParityStatus): SvelteKitParityFixture[] {
  return SVELTEKIT_PARITY_FIXTURES.filter((fixture) => fixture.status === status);
}
