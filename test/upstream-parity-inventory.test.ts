import { describe, expect, it } from 'vitest';

import {
  SVELTE_UPSTREAM_TEST_SUITES,
  SVELTEKIT_UPSTREAM_TEST_APPS,
  UPSTREAM_PARITY_SOURCE,
  UPSTREAM_PARITY_TOTALS,
  getUpstreamParityItems,
  type UpstreamParityItem,
  type UpstreamParityStatus,
} from './fixtures/upstream-parity/manifest.js';
import {
  SVELTE_FIXTURE_INVENTORY,
  SVELTE_HYDRATION_FIXTURES,
  SVELTE_SERVER_SIDE_RENDERING_FIXTURES,
  type UpstreamSvelteFixtureInventoryItem,
  type UpstreamSvelteFixtureStatus,
} from './fixtures/upstream-parity/svelte-fixtures.js';

const VALID_STATUSES = new Set<UpstreamParityStatus>([
  'converted-pass',
  'partially-converted',
  'future-feature',
  'intentional-divergence',
  'not-applicable',
  'gap',
]);

const VALID_FIXTURE_STATUSES = new Set<UpstreamSvelteFixtureStatus>([
  'converted-pass',
  'framework-equivalent',
  'intentional-divergence',
  'not-applicable',
  'gap',
]);

function assertClassified(item: UpstreamParityItem): void {
  expect(item.id).toBeTruthy();
  expect(item.upstreamPath).toBeTruthy();
  expect(VALID_STATUSES.has(item.status)).toBe(true);
  expect(item.notes.trim().length).toBeGreaterThan(10);

  if (item.status === 'gap') {
    expect(item.nextAction, `${item.id} gap needs a next action`).toBeTruthy();
  }

  if (item.status === 'future-feature') {
    expect(item.nextAction, `${item.id} future feature needs a next action`).toBeTruthy();
  }

  if (item.status === 'partially-converted') {
    expect(item.localEvidence?.length, `${item.id} partial coverage needs local evidence`).toBeGreaterThan(0);
    expect(item.nextAction, `${item.id} partial coverage needs a next action`).toBeTruthy();
  }
}

function assertFixtureClassified(fixture: UpstreamSvelteFixtureInventoryItem): void {
  expect(fixture.id).toBeTruthy();
  expect(fixture.upstreamPath).toBe(`packages/svelte/tests/${fixture.suite}/samples/${fixture.id}`);
  expect(VALID_FIXTURE_STATUSES.has(fixture.status)).toBe(true);
}

describe('upstream Svelte/SvelteKit parity inventory', () => {
  it('records the upstream source snapshot explicitly', () => {
    expect(UPSTREAM_PARITY_SOURCE.svelteVersion).toBe('5.55.5');
    expect(UPSTREAM_PARITY_SOURCE.svelteRepository).toBe('sveltejs/svelte');
    expect(UPSTREAM_PARITY_SOURCE.svelteKitRepository).toBe('sveltejs/kit');
    expect(UPSTREAM_PARITY_SOURCE.capturedAt).toBe('2026-05-08');
  });

  it('classifies every scanned Svelte upstream test suite bucket', () => {
    expect(SVELTE_UPSTREAM_TEST_SUITES).toHaveLength(UPSTREAM_PARITY_TOTALS.svelteSuites);
    expect(new Set(SVELTE_UPSTREAM_TEST_SUITES.map((suite) => suite.id)).size).toBe(
      SVELTE_UPSTREAM_TEST_SUITES.length,
    );
    expect(SVELTE_UPSTREAM_TEST_SUITES.reduce((sum, suite) => sum + suite.fixtureCount, 0)).toBe(
      UPSTREAM_PARITY_TOTALS.svelteFixtures,
    );
    expect(SVELTE_UPSTREAM_TEST_SUITES.reduce((sum, suite) => sum + suite.fileCount, 0)).toBe(
      UPSTREAM_PARITY_TOTALS.svelteFiles,
    );

    for (const suite of SVELTE_UPSTREAM_TEST_SUITES) {
      assertClassified(suite);
    }
  });

  it('classifies every scanned SvelteKit upstream test app bucket', () => {
    expect(SVELTEKIT_UPSTREAM_TEST_APPS).toHaveLength(UPSTREAM_PARITY_TOTALS.svelteKitApps);
    expect(new Set(SVELTEKIT_UPSTREAM_TEST_APPS.map((app) => app.id)).size).toBe(
      SVELTEKIT_UPSTREAM_TEST_APPS.length,
    );
    expect(SVELTEKIT_UPSTREAM_TEST_APPS.reduce((sum, app) => sum + app.testFileCount, 0)).toBe(
      UPSTREAM_PARITY_TOTALS.svelteKitTestFiles,
    );
    expect(SVELTEKIT_UPSTREAM_TEST_APPS.reduce((sum, app) => sum + app.routeFileCount, 0)).toBe(
      UPSTREAM_PARITY_TOTALS.svelteKitRouteFiles,
    );

    for (const app of SVELTEKIT_UPSTREAM_TEST_APPS) {
      assertClassified(app);
    }
  });

  it('keeps remaining work explicit without stale gap buckets', () => {
    expect(getUpstreamParityItems('gap')).toHaveLength(0);
    expect(getUpstreamParityItems('partially-converted')).toHaveLength(0);
    expect(getUpstreamParityItems('converted-pass')).toHaveLength(17);
    expect(getUpstreamParityItems('future-feature')).toHaveLength(0);
    expect(getUpstreamParityItems('intentional-divergence').length).toBeGreaterThan(0);
    expect(getUpstreamParityItems('not-applicable').length).toBeGreaterThan(0);
  });

  it('classifies every upstream Svelte SSR fixture ID in the first per-fixture pass', () => {
    const suite = SVELTE_UPSTREAM_TEST_SUITES.find((candidate) => candidate.id === 'server-side-rendering');
    expect(suite).toBeTruthy();
    expect(SVELTE_SERVER_SIDE_RENDERING_FIXTURES).toHaveLength(suite!.fixtureCount);
    expect(new Set(SVELTE_SERVER_SIDE_RENDERING_FIXTURES.map((fixture) => fixture.id)).size).toBe(
      SVELTE_SERVER_SIDE_RENDERING_FIXTURES.length,
    );

    for (const fixture of SVELTE_SERVER_SIDE_RENDERING_FIXTURES) {
      assertFixtureClassified(fixture);
    }

    expect(SVELTE_SERVER_SIDE_RENDERING_FIXTURES.filter((fixture) => fixture.status === 'converted-pass').length)
      .toBeGreaterThanOrEqual(40);
    expect(SVELTE_SERVER_SIDE_RENDERING_FIXTURES.filter((fixture) => fixture.status === 'framework-equivalent').length)
      .toBe(0);
    expect(SVELTE_SERVER_SIDE_RENDERING_FIXTURES.filter((fixture) => fixture.status === 'gap')).toHaveLength(0);
  });

  it('classifies every upstream Svelte hydration fixture ID and marks executable browser coverage', () => {
    const suite = SVELTE_UPSTREAM_TEST_SUITES.find((candidate) => candidate.id === 'hydration');
    expect(suite).toBeTruthy();
    expect(SVELTE_HYDRATION_FIXTURES).toHaveLength(suite!.fixtureCount);
    expect(new Set(SVELTE_HYDRATION_FIXTURES.map((fixture) => fixture.id)).size).toBe(
      SVELTE_HYDRATION_FIXTURES.length,
    );

    for (const fixture of SVELTE_HYDRATION_FIXTURES) {
      assertFixtureClassified(fixture);
    }

    expect(SVELTE_HYDRATION_FIXTURES.filter((fixture) => fixture.status === 'converted-pass').length)
      .toBeGreaterThanOrEqual(9);
    expect(SVELTE_HYDRATION_FIXTURES.filter((fixture) => fixture.status === 'framework-equivalent').length)
      .toBeGreaterThan(0);
    expect(SVELTE_HYDRATION_FIXTURES.filter((fixture) => fixture.status === 'gap')).toHaveLength(0);
  });

  it('keeps the expanded Svelte fixture inventory duplicate-free across suites', () => {
    const keys = SVELTE_FIXTURE_INVENTORY.map((fixture) => `${fixture.suite}/${fixture.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(SVELTE_FIXTURE_INVENTORY).toHaveLength(
      SVELTE_SERVER_SIDE_RENDERING_FIXTURES.length + SVELTE_HYDRATION_FIXTURES.length,
    );
  });
});
