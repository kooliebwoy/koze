import { performance } from 'node:perf_hooks';

import { Hono } from 'hono';

import { Router } from '../src/runtime/router.ts';
import { createGeneratedWorker, type GeneratedApiRoute } from '../src/runtime/generated-worker.ts';

type RouteCase = {
  pattern: string;
  honoPattern: string;
  sample: string;
};

type BenchResult = {
  name: string;
  iterations: number;
  durationMs: number;
  opsPerSecond: number;
};

const DEFAULT_RAW_ITERATIONS = 100_000;
const DEFAULT_FETCH_ITERATIONS = 5_000;
const RAW_ITERATIONS = Number(process.env.ROUTER_BENCH_RAW_ITERS ?? DEFAULT_RAW_ITERATIONS);
const FETCH_ITERATIONS = Number(process.env.ROUTER_BENCH_FETCH_ITERS ?? DEFAULT_FETCH_ITERATIONS);

let sink = 0;

function buildRouteCases(): RouteCase[] {
  const routes: RouteCase[] = [
    { pattern: '/', honoPattern: '/', sample: '/' },
    { pattern: '/health', honoPattern: '/health', sample: '/health' },
    { pattern: '/__koze/protocol', honoPattern: '/__koze/protocol', sample: '/__koze/protocol' },
  ];

  const sections = [
    'account',
    'admin',
    'analytics',
    'billing',
    'dashboard',
    'docs',
    'integrations',
    'projects',
    'settings',
    'teams',
  ];

  for (const section of sections) {
    routes.push({ pattern: `/${section}`, honoPattern: `/${section}`, sample: `/${section}` });
    for (let i = 0; i < 20; i++) {
      routes.push({
        pattern: `/${section}/page-${i}`,
        honoPattern: `/${section}/page-${i}`,
        sample: `/${section}/page-${i}`,
      });
    }
  }

  for (let i = 0; i < 80; i++) {
    routes.push({
      pattern: `/orgs/:orgId/projects/project-${i}`,
      honoPattern: `/orgs/:orgId/projects/project-${i}`,
      sample: `/orgs/acme/projects/project-${i}`,
    });
    routes.push({
      pattern: `/orgs/:orgId/projects/:projectId/resource-${i}`,
      honoPattern: `/orgs/:orgId/projects/:projectId/resource-${i}`,
      sample: `/orgs/acme/projects/kuratchi/resource-${i}`,
    });
  }

  for (let i = 0; i < 50; i++) {
    routes.push({
      pattern: `/api/v1/resource-${i}/:id`,
      honoPattern: `/api/v1/resource-${i}/:id`,
      sample: `/api/v1/resource-${i}/item-${i}`,
    });
  }

  for (let i = 0; i < 20; i++) {
    routes.push({
      pattern: `/files-${i}/*path`,
      honoPattern: `/files-${i}/*`,
      sample: `/files-${i}/a/b/c/file.txt`,
    });
  }

  return routes;
}

function buildKuratchiRouter(routes: RouteCase[]): Router {
  const router = new Router();
  routes.forEach((route, index) => router.add(route.pattern, index));
  return router;
}

function buildHonoApp(routes: RouteCase[]): Hono {
  const app = new Hono();
  for (const route of routes) {
    app.get(route.honoPattern, () => new Response(null, { status: 204 }));
  }
  return app;
}

function buildKuratchiWorker(routes: RouteCase[]) {
  const apiRoutes: GeneratedApiRoute[] = routes.map((route) => ({
    pattern: route.pattern,
    __api: true,
    GET: () => new Response(null, { status: 204 }),
  }));
  return createGeneratedWorker({
    routes: apiRoutes,
    layout: (content) => content,
    layoutActions: {},
    assetsPrefix: '/assets/',
    assets: {},
    errorPages: {
      404: () => 'not found',
    },
  });
}

function benchSync(
  name: string,
  iterations: number,
  run: (index: number) => void,
): BenchResult {
  for (let i = 0; i < Math.min(iterations, 10_000); i++) run(i);

  const start = performance.now();
  for (let i = 0; i < iterations; i++) run(i);
  const durationMs = performance.now() - start;

  return {
    name,
    iterations,
    durationMs,
    opsPerSecond: iterations / (durationMs / 1000),
  };
}

async function benchAsync(
  name: string,
  iterations: number,
  run: (index: number) => Promise<void>,
): Promise<BenchResult> {
  for (let i = 0; i < Math.min(iterations, 2_000); i++) await run(i);

  const start = performance.now();
  for (let i = 0; i < iterations; i++) await run(i);
  const durationMs = performance.now() - start;

  return {
    name,
    iterations,
    durationMs,
    opsPerSecond: iterations / (durationMs / 1000),
  };
}

function printResults(results: BenchResult[]): void {
  const fastest = Math.max(...results.map((result) => result.opsPerSecond));
  console.log(`route count: ${buildRouteCases().length}`);
  console.log(`raw iterations: ${RAW_ITERATIONS.toLocaleString()}`);
  console.log(`fetch iterations: ${FETCH_ITERATIONS.toLocaleString()}`);
  console.log('');
  console.log('| Benchmark | Iterations | Duration | Ops/sec | Relative |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const result of results) {
    const relative = result.opsPerSecond / fastest;
    console.log(
      `| ${result.name} | ${result.iterations.toLocaleString()} | ${result.durationMs.toFixed(2)}ms | ${Math.round(result.opsPerSecond).toLocaleString()} | ${relative.toFixed(2)}x |`,
    );
  }
  console.log('');
  console.log('Note: Hono app.fetch() is a pure HTTP router dispatch baseline. Kuratchi generated worker fetch() includes framework endpoint checks, request context setup, security hooks, API dispatch, and route matching.');
  console.log('');
  console.log(`sink: ${sink}`);
}

async function assertAllRoutesDispatch(
  label: string,
  requests: Request[],
  dispatch: (request: Request) => Promise<Response>,
): Promise<void> {
  for (const request of requests) {
    const response = await dispatch(request);
    if (response.status !== 204) {
      throw new Error(`${label} failed to dispatch ${new URL(request.url).pathname}: ${response.status}`);
    }
  }
}

async function main(): Promise<void> {
  const routes = buildRouteCases();
  const samples = routes.map((route) => route.sample);
  const requests = samples.map((sample) => new Request(`https://bench.local${sample}`));

  const kuratchiRouter = buildKuratchiRouter(routes);
  const kuratchiWorker = buildKuratchiWorker(routes);
  const honoApp = buildHonoApp(routes);
  const env = {};
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  await assertAllRoutesDispatch('Kuratchi generated worker', requests, (request) => {
    return kuratchiWorker.fetch(request, env, ctx);
  });
  await assertAllRoutesDispatch('Hono app', requests, (request) => {
    return honoApp.fetch(request);
  });

  const results: BenchResult[] = [];

  results.push(benchSync('Kuratchi Router.match(pathname)', RAW_ITERATIONS, (index) => {
    const match = kuratchiRouter.match(samples[index % samples.length]);
    sink += match?.index ?? -1;
  }));

  results.push(await benchAsync('Kuratchi generated worker fetch()', FETCH_ITERATIONS, async (index) => {
    const response = await kuratchiWorker.fetch(requests[index % requests.length], env, ctx);
    sink += response.status;
  }));

  results.push(await benchAsync('Hono app.fetch()', FETCH_ITERATIONS, async (index) => {
    const response = await honoApp.fetch(requests[index % requests.length]);
    sink += response.status;
  }));

  printResults(results);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
