export type SvelteKitParityStatus = 'ported-pass' | 'ported-fail' | 'future-feature' | 'not-applicable';

export interface SvelteKitParityEvidence {
  file: string;
  testName: string;
}

export interface SvelteKitParityFixture {
  id: string;
  category: 'routing' | 'form-action' | 'rpc' | 'navigation' | 'cookie' | 'adapter';
  status: SvelteKitParityStatus;
  notes: string;
  evidence?: SvelteKitParityEvidence;
}

/**
 * Only active-path evidence belongs here. Whole-project compiler and
 * generated-worker tests were removed with the legacy build path.
 */
export const SVELTEKIT_PARITY_FIXTURES: SvelteKitParityFixture[] = [
  {
    id: 'routing/static-dynamic-catchall',
    category: 'routing',
    status: 'ported-pass',
    notes: 'Static, dynamic, and catch-all matching is covered by the active router.',
    evidence: {
      file: 'test/router.test.ts',
      testName: 'matches dynamic params and catch-all routes',
    },
  },
  {
    id: 'routing/static-priority',
    category: 'routing',
    status: 'ported-pass',
    notes: 'Static routes win over dynamic siblings.',
    evidence: {
      file: 'test/router.test.ts',
      testName: 'prefers exact static routes over dynamic params',
    },
  },
  {
    id: 'form-action/context-signature',
    category: 'form-action',
    status: 'ported-pass',
    notes: 'Vite-dispatched actions use the context-object calling convention.',
    evidence: {
      file: 'test/vite/action-invocation.test.ts',
      testName: 'form submission: handler receives only the context object',
    },
  },
  {
    id: 'rpc/browser-asyncvalue-invalidation',
    category: 'rpc',
    status: 'ported-pass',
    notes: 'Browser RPC returns AsyncValue state and emits Koze invalidation.',
    evidence: {
      file: 'test/browser-hydration.test.ts',
      testName: 'browser channel returns AsyncValue state and dispatches invalidation through Capn Web HTTP',
    },
  },
  {
    id: 'navigation/redirect-virtual-module',
    category: 'navigation',
    status: 'ported-pass',
    notes: 'The navigation virtual module exposes redirect helpers.',
    evidence: {
      file: 'test/virtual-modules.test.ts',
      testName: 'declares koze:navigation module',
    },
  },
  {
    id: 'cookie/server-cookie-module',
    category: 'cookie',
    status: 'ported-pass',
    notes: 'Server cookie APIs are exposed through a server-safe virtual module.',
    evidence: {
      file: 'test/virtual-modules.test.ts',
      testName: 'declares koze:cookies module',
    },
  },
  {
    id: 'adapter/cloudflare-worker',
    category: 'adapter',
    status: 'not-applicable',
    notes: 'Koze intentionally targets the Cloudflare Vite plugin and Workers runtime.',
  },
  {
    id: 'adapter/active-worker-e2e-coverage',
    category: 'adapter',
    status: 'future-feature',
    notes: 'Add workerd-backed coverage for page, API, middleware, RPC, action, error, and asset dispatch.',
  },
];

export function getSvelteKitParityFixtures(status: SvelteKitParityStatus): SvelteKitParityFixture[] {
  return SVELTEKIT_PARITY_FIXTURES.filter((fixture) => fixture.status === status);
}
