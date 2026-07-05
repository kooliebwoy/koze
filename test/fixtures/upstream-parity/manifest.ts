export type UpstreamParityScope = 'svelte' | 'sveltekit';

export type UpstreamParityStatus =
  | 'converted-pass'
  | 'partially-converted'
  | 'future-feature'
  | 'intentional-divergence'
  | 'not-applicable'
  | 'gap';

export interface UpstreamParityBase {
  scope: UpstreamParityScope;
  id: string;
  upstreamPath: string;
  status: UpstreamParityStatus;
  notes: string;
  nextAction?: string;
  localEvidence?: string[];
}

export interface SvelteUpstreamSuite extends UpstreamParityBase {
  scope: 'svelte';
  fixtureCount: number;
  fileCount: number;
}

export interface SvelteKitUpstreamApp extends UpstreamParityBase {
  scope: 'sveltekit';
  testFileCount: number;
  routeFileCount: number;
}

export type UpstreamParityItem = SvelteUpstreamSuite | SvelteKitUpstreamApp;

export const UPSTREAM_PARITY_SOURCE = {
  svelteVersion: '5.55.5',
  svelteRepository: 'sveltejs/svelte',
  sveltePath: 'packages/svelte/tests',
  svelteKitRepository: 'sveltejs/kit',
  svelteKitPath: 'packages/kit/test/apps',
  capturedAt: '2026-05-08',
} as const;

export const SVELTE_UPSTREAM_TEST_SUITES: SvelteUpstreamSuite[] = [
  {
    scope: 'svelte',
    id: 'compiler-errors',
    upstreamPath: 'packages/svelte/tests/compiler-errors',
    fixtureCount: 144,
    fileCount: 300,
    status: 'converted-pass',
    notes: 'Kuratchi-equivalent compiler error behavior is covered by stable diagnostics for script syntax/placement, template expressions, attribute interpolations, bind directives, removed raw-HTML shorthand, and Cloudflare env leakage. Svelte-only error codes and syntax surfaces are intentional divergences rather than parity gaps.',
    localEvidence: ['test/compiler-diagnostics.test.ts', 'test/svelte-parity.test.ts'],
  },
  {
    scope: 'svelte',
    id: 'css',
    upstreamPath: 'packages/svelte/tests/css',
    fixtureCount: 181,
    fileCount: 533,
    status: 'converted-pass',
    notes: 'Kuratchi-equivalent CSS behavior is covered: raw style blocks are preserved without expression parsing, dynamic style/class attributes render and hydrate through the template system, and component CSS selector scoping handles nested group at-rules without corrupting keyframes. Svelte-specific compiled CSS hashes/output are an intentional non-goal.',
    localEvidence: ['test/render-sections.test.ts', 'test/template-attributes.test.ts', 'test/template-components.test.ts', 'test/svelte-parity.test.ts'],
  },
  {
    scope: 'svelte',
    id: 'hydration',
    upstreamPath: 'packages/svelte/tests/hydration',
    fixtureCount: 80,
    fileCount: 207,
    status: 'converted-pass',
    notes: 'Every upstream hydration fixture ID is classified with no gaps. Kuratchi-equivalent hydration is covered through compiler planning plus a browser DOM harness for SSR HTML, client script boot, bindings, events, blocks, raw HTML, local scopes, channel invalidation, enhanced forms, and idempotent init.',
    localEvidence: ['test/hydration-plan.test.ts', 'test/browser-hydration.test.ts', 'test/fixtures/upstream-parity/svelte-fixtures.ts'],
  },
  {
    scope: 'svelte',
    id: 'manual',
    upstreamPath: 'packages/svelte/tests/manual',
    fixtureCount: 0,
    fileCount: 1,
    status: 'not-applicable',
    notes: 'Manual upstream test runner glue is not a framework behavior target.',
  },
  {
    scope: 'svelte',
    id: 'migrate',
    upstreamPath: 'packages/svelte/tests/migrate',
    fixtureCount: 76,
    fileCount: 172,
    status: 'not-applicable',
    notes: 'Svelte migration tooling does not map to Kuratchi runtime/compiler behavior.',
  },
  {
    scope: 'svelte',
    id: 'motion',
    upstreamPath: 'packages/svelte/tests/motion',
    fixtureCount: 0,
    fileCount: 1,
    status: 'intentional-divergence',
    notes: 'Svelte motion package APIs are not Kuratchi template/compiler APIs.',
  },
  {
    scope: 'svelte',
    id: 'parser-legacy',
    upstreamPath: 'packages/svelte/tests/parser-legacy',
    fixtureCount: 83,
    fileCount: 168,
    status: 'converted-pass',
    notes: 'Kuratchi-equivalent legacy parser behavior is covered through SFC extraction, doctype/comment prefixes, single top-level script enforcement, raw style/script handling, comments, tags, attributes, native control-flow blocks, expressions, and slot replacement. Legacy Svelte parser AST shape is not a compatibility target.',
    localEvidence: ['test/compiler-svelte-corpus.test.ts', 'test/svelte-parity.test.ts'],
  },
  {
    scope: 'svelte',
    id: 'parser-modern',
    upstreamPath: 'packages/svelte/tests/parser-modern',
    fixtureCount: 24,
    fileCount: 49,
    status: 'converted-pass',
    notes: 'Kuratchi-equivalent modern parser behavior is covered through quote/brace-aware tag scanning, greater-than comparisons in attributes, nested object/template-literal expressions, raw style blocks, component tags, spreads, and native JS control flow. Svelte AST output parity remains intentionally out of scope.',
    localEvidence: ['test/compiler-svelte-corpus.test.ts', 'test/svelte-parity.test.ts'],
  },
  {
    scope: 'svelte',
    id: 'preprocess',
    upstreamPath: 'packages/svelte/tests/preprocess',
    fixtureCount: 19,
    fileCount: 62,
    status: 'intentional-divergence',
    notes: 'Svelte preprocess is a Svelte compiler plugin API. Kuratchi currently owns route-file parsing directly and keeps preprocessing in the Vite/compiler pipeline rather than exposing Svelte-compatible preprocess hooks.',
  },
  {
    scope: 'svelte',
    id: 'print',
    upstreamPath: 'packages/svelte/tests/print',
    fixtureCount: 40,
    fileCount: 81,
    status: 'not-applicable',
    notes: 'Svelte AST printer output is not a Kuratchi compatibility target.',
  },
  {
    scope: 'svelte',
    id: 'runtime-browser',
    upstreamPath: 'packages/svelte/tests/runtime-browser',
    fixtureCount: 66,
    fileCount: 163,
    status: 'converted-pass',
    notes: 'Kuratchi-equivalent browser runtime behavior is covered: bind:value, bind:checked, reactive text/attributes, event expressions, idempotent init, conditional blocks, raw HTML rerendering, loop-local hydration scopes, channel invalidation, Capn Web AsyncValue success/error state, and enhanced forms. Svelte lifecycle/action/transition APIs are intentional divergences.',
    localEvidence: ['test/template-components.test.ts', 'test/compiler-integration-reactivity.test.ts', 'test/browser-hydration.test.ts'],
  },
  {
    scope: 'svelte',
    id: 'runtime-legacy',
    upstreamPath: 'packages/svelte/tests/runtime-legacy',
    fixtureCount: 1207,
    fileCount: 2892,
    status: 'intentional-divergence',
    notes: 'The legacy Svelte component API and lifecycle matrix are not Kuratchi APIs.',
  },
  {
    scope: 'svelte',
    id: 'runtime-production',
    upstreamPath: 'packages/svelte/tests/runtime-production',
    fixtureCount: 6,
    fileCount: 13,
    status: 'converted-pass',
    notes: 'Kuratchi-equivalent production behavior is covered: build-mode Vite transforms set client environment constants to production values and emit compact runtime scripts, while package check/build covers production TypeScript output.',
    localEvidence: ['test/vite/client-first-top-script.test.ts', 'test/compiler-typescript-script.test.ts'],
  },
  {
    scope: 'svelte',
    id: 'runtime-runes',
    upstreamPath: 'packages/svelte/tests/runtime-runes',
    fixtureCount: 971,
    fileCount: 2295,
    status: 'intentional-divergence',
    notes: 'Svelte runes are intentionally not Kuratchi syntax or runtime state primitives.',
  },
  {
    scope: 'svelte',
    id: 'runtime-xhtml',
    upstreamPath: 'packages/svelte/tests/runtime-xhtml',
    fixtureCount: 13,
    fileCount: 28,
    status: 'not-applicable',
    notes: 'XHTML runtime output is not a current Kuratchi target.',
  },
  {
    scope: 'svelte',
    id: 'server-side-rendering',
    upstreamPath: 'packages/svelte/tests/server-side-rendering',
    fixtureCount: 124,
    fileCount: 348,
    status: 'converted-pass',
    notes: 'Every upstream SSR fixture ID is classified with no gaps. Overlapping render behavior is executable through normalized Kuratchi-vs-Svelte parity tests, while Svelte-only syntax such as snippets, runes, actions, and boundaries is explicitly marked divergence.',
    localEvidence: ['test/svelte-parity.test.ts', 'test/runtime-generated-worker.test.ts', 'test/fixtures/upstream-parity/svelte-fixtures.ts'],
  },
  {
    scope: 'svelte',
    id: 'signals',
    upstreamPath: 'packages/svelte/tests/signals',
    fixtureCount: 0,
    fileCount: 1,
    status: 'intentional-divergence',
    notes: 'Svelte signal internals are not Kuratchi public API.',
  },
  {
    scope: 'svelte',
    id: 'snapshot',
    upstreamPath: 'packages/svelte/tests/snapshot',
    fixtureCount: 32,
    fileCount: 127,
    status: 'not-applicable',
    notes: 'Svelte compiled output snapshots should not match Kuratchi generated code.',
  },
  {
    scope: 'svelte',
    id: 'sourcemaps',
    upstreamPath: 'packages/svelte/tests/sourcemaps',
    fixtureCount: 28,
    fileCount: 58,
    status: 'converted-pass',
    notes: 'Kuratchi-equivalent source maps are covered for Vite route modules, repeated template expressions, layout/app virtual modules, browser client fragments, generated worker virtual modules, and legacy compiler routes output. Browser $server RPC stubs intentionally do not embed server source maps to avoid leaking server code into client bundles.',
    localEvidence: ['test/source-map.test.ts'],
  },
  {
    scope: 'svelte',
    id: 'store',
    upstreamPath: 'packages/svelte/tests/store',
    fixtureCount: 0,
    fileCount: 1,
    status: 'intentional-divergence',
    notes: 'Svelte store package behavior is not a Kuratchi API.',
  },
  {
    scope: 'svelte',
    id: 'types',
    upstreamPath: 'packages/svelte/tests/types',
    fixtureCount: 0,
    fileCount: 10,
    status: 'converted-pass',
    notes: 'Kuratchi-equivalent type behavior is covered by a real TypeScript harness: virtual modules, generated app.d.ts output, app locals, workflow-name narrowing, component props, schema row types, typed channel RPC async-values, $server/* RPC imports, and runtime route/action/RPC/API module contracts.',
    localEvidence: ['test/virtual-modules.test.ts', 'test/type-generator.test.ts'],
  },
  {
    scope: 'svelte',
    id: 'validator',
    upstreamPath: 'packages/svelte/tests/validator',
    fixtureCount: 325,
    fileCount: 663,
    status: 'converted-pass',
    notes: 'Kuratchi-equivalent validation is covered by TypeScript-backed checks and stable diagnostics for script closure, script placement, script syntax, template expressions, braced and quoted attribute expressions, bind directives, removed HTML shorthand, virtual-module imports, and Cloudflare env leakage. Svelte-specific validator rules for runes, snippets, class directives, and actions are intentional divergences.',
    localEvidence: ['test/compiler-diagnostics.test.ts', 'test/svelte-parity.test.ts'],
  },
];

export const SVELTEKIT_UPSTREAM_TEST_APPS: SvelteKitUpstreamApp[] = [
  {
    scope: 'sveltekit',
    id: 'amp',
    upstreamPath: 'packages/kit/test/apps/amp',
    testFileCount: 1,
    routeFileCount: 15,
    status: 'not-applicable',
    notes: 'SvelteKit AMP mode is not a Kuratchi framework target.',
  },
  {
    scope: 'sveltekit',
    id: 'async',
    upstreamPath: 'packages/kit/test/apps/async',
    testFileCount: 3,
    routeFileCount: 102,
    status: 'converted-pass',
    notes: 'Kuratchi-equivalent async behavior is covered: AsyncValue success/error state, Capn Web route/server RPC, schema validation failures, enhanced form lifecycle, redirect/error handling, browser invalidation, workflow polling, and streaming SSR boundaries.',
    localEvidence: ['test/runtime-channel.test.ts', 'test/runtime-async-value.test.ts', 'test/runtime-generated-worker.test.ts', 'test/compiler-typescript-script.test.ts', 'test/browser-hydration.test.ts', 'test/runtime-workflow-poll.test.ts', 'test/runtime-stream.test.ts'],
  },
  {
    scope: 'sveltekit',
    id: 'basics',
    upstreamPath: 'packages/kit/test/apps/basics',
    testFileCount: 7,
    routeFileCount: 927,
    status: 'converted-pass',
    notes: 'Kuratchi-equivalent basics are mapped to concrete parity fixtures: routing, load, layouts, form actions, API routes, RPC, middleware, errors, assets, head handling, cookies, navigation, and Cloudflare adapter non-goals.',
    localEvidence: ['test/sveltekit-parity.test.ts', 'test/runtime-generated-worker.test.ts', 'test/router.test.ts'],
  },
  {
    scope: 'sveltekit',
    id: 'dev-only',
    upstreamPath: 'packages/kit/test/apps/dev-only',
    testFileCount: 1,
    routeFileCount: 21,
    status: 'converted-pass',
    notes: 'Kuratchi-equivalent dev-only behavior is covered: client/server virtual import boundaries are enforced, client environment values are serialized, $server modules compile to browser-safe channel stubs without leaking cloudflare:workers or secret references, and Vite client fragment invalidation is tested. SvelteKit optimizeDeps-specific assertions are intentional non-goals.',
    localEvidence: ['test/compiler-typescript-script.test.ts', 'test/parser-kuratchi-environment.test.ts', 'test/server-module-virtual-imports.test.ts', 'test/vite/client-first-top-script.test.ts'],
  },
  {
    scope: 'sveltekit',
    id: 'embed',
    upstreamPath: 'packages/kit/test/apps/embed',
    testFileCount: 1,
    routeFileCount: 5,
    status: 'intentional-divergence',
    notes: 'SvelteKit embedded component deployment is not part of Kuratchi route/runtime semantics. Kuratchi components are compiled through routes and layouts rather than mounted as independently embedded apps.',
  },
  {
    scope: 'sveltekit',
    id: 'hash-based-routing',
    upstreamPath: 'packages/kit/test/apps/hash-based-routing',
    testFileCount: 1,
    routeFileCount: 11,
    status: 'intentional-divergence',
    notes: 'Hash-based routing is not part of the current Kuratchi route model.',
  },
  {
    scope: 'sveltekit',
    id: 'no-ssr',
    upstreamPath: 'packages/kit/test/apps/no-ssr',
    testFileCount: 2,
    routeFileCount: 9,
    status: 'intentional-divergence',
    notes: 'Explicit CSR/no-SSR mode was discussed as possible, but it is not implemented as a first-class route mode.',
  },
  {
    scope: 'sveltekit',
    id: 'options',
    upstreamPath: 'packages/kit/test/apps/options',
    testFileCount: 3,
    routeFileCount: 0,
    status: 'converted-pass',
    notes: 'Kuratchi-native option behavior is covered: static asset prefixes, wrangler ASSETS sync, CSP nonce substitution/stamping, security headers, trailing-slash route matching, and virtual module config surfaces. SvelteKit-specific config shape/preload semantics are intentional non-goals.',
    localEvidence: ['test/compiler-worker-entrypoints.test.ts', 'test/runtime-generated-worker.test.ts', 'test/runtime-security.test.ts', 'test/virtual-modules.test.ts', 'test/runtime-access.test.ts'],
  },
  {
    scope: 'sveltekit',
    id: 'options-2',
    upstreamPath: 'packages/kit/test/apps/options-2',
    testFileCount: 2,
    routeFileCount: 16,
    status: 'converted-pass',
    notes: 'Kuratchi-relevant option-2 behavior is covered: static assets and prefixes, Capn Web channel/RPC, workflow polling directives, and streaming SSR boundary serialization. SvelteKit service-worker and bundleStrategy option behavior are intentional non-goals.',
    localEvidence: ['test/runtime-generated-worker.test.ts', 'test/runtime-channel.test.ts', 'test/runtime-workflow-poll.test.ts', 'test/runtime-stream.test.ts'],
  },
  {
    scope: 'sveltekit',
    id: 'options-3',
    upstreamPath: 'packages/kit/test/apps/options-3',
    testFileCount: 1,
    routeFileCount: 3,
    status: 'intentional-divergence',
    notes: 'The remaining app is specifically SvelteKit bundleStrategy inline behavior. Kuratchi should optimize its own client/channel payloads rather than copy SvelteKit bundle strategy flags.',
  },
  {
    scope: 'sveltekit',
    id: 'prerendered-app-error-pages',
    upstreamPath: 'packages/kit/test/apps/prerendered-app-error-pages',
    testFileCount: 1,
    routeFileCount: 3,
    status: 'intentional-divergence',
    notes: 'SvelteKit prerendered static error pages are not a Kuratchi Worker runtime target. Kuratchi custom error pages are dynamic Worker responses and already have runtime coverage.',
    localEvidence: ['test/runtime-generated-worker.test.ts', 'test/fixtures/sveltekit-parity/manifest.ts'],
  },
  {
    scope: 'sveltekit',
    id: 'read-file-test',
    upstreamPath: 'packages/kit/test/apps/read-file-test',
    testFileCount: 0,
    routeFileCount: 0,
    status: 'not-applicable',
    notes: 'Sparse checkout contained no app test or route files for this app.',
  },
  {
    scope: 'sveltekit',
    id: 'writes',
    upstreamPath: 'packages/kit/test/apps/writes',
    testFileCount: 1,
    routeFileCount: 8,
    status: 'converted-pass',
    notes: 'Kuratchi-equivalent write behavior is covered: production filesystem writes are a Cloudflare non-goal, while route creation/removal invalidates the generated route manifest and affected client fragments, and browser init is idempotent so repeated mounts do not double-bind handlers.',
    localEvidence: ['test/vite/client-first-top-script.test.ts', 'test/browser-hydration.test.ts'],
  },
];

export const UPSTREAM_PARITY_TOTALS = {
  svelteSuites: 22,
  svelteFixtures: 3419,
  svelteFiles: 8173,
  svelteKitApps: 13,
  svelteKitTestFiles: 24,
  svelteKitRouteFiles: 1120,
} as const;

export function getUpstreamParityItems(status: UpstreamParityStatus): UpstreamParityItem[] {
  return [...SVELTE_UPSTREAM_TEST_SUITES, ...SVELTEKIT_UPSTREAM_TEST_APPS].filter((item) => item.status === status);
}
