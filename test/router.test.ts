import { describe, expect, test } from 'vitest';

import { Router, createPreparedRouter, matchPreparedRouter } from '../src/runtime/router.ts';

describe('runtime router', () => {
  test('prefers exact static routes over dynamic params', () => {
    const router = new Router();
    router.add('/posts/:slug', 0);
    router.add('/posts/new', 1);

    expect(router.match('/posts/new/')).toEqual({
      params: {},
      index: 1,
    });
  });

  test('matches dynamic params and catch-all routes', () => {
    const router = new Router();
    router.add('/blog/:slug', 0);
    router.add('/files/*path', 1);

    expect(router.match('/blog/hello-world')).toEqual({
      params: { slug: 'hello-world' },
      index: 0,
    });

    expect(router.match('/files/a/b/c')).toEqual({
      params: { path: 'a/b/c' },
      index: 1,
    });
  });

  test('handles static sibling segments with the same first character', () => {
    const router = new Router();
    router.add('/orgs/:orgId/settings', 0);
    router.add('/orgs/:orgId/security', 1);
    router.add('/orgs/:orgId/sites', 2);

    expect(router.match('/orgs/acme/security')).toEqual({
      params: { orgId: 'acme' },
      index: 1,
    });
  });

  test('matches a prepared router emitted as JSON', () => {
    const prepared = createPreparedRouter([
      '/',
      '/orgs/:orgId/projects/:projectId',
      '/files/*path',
    ]);
    const hydrated = JSON.parse(JSON.stringify(prepared));

    expect(matchPreparedRouter(hydrated, '/orgs/acme/projects/kuratchi')).toEqual({
      params: { orgId: 'acme', projectId: 'kuratchi' },
      index: 1,
    });
    expect(matchPreparedRouter(hydrated, '/files/a/b/c.txt')).toEqual({
      params: { path: 'a/b/c.txt' },
      index: 2,
    });
  });
});
