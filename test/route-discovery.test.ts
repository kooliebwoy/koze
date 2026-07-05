import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { discoverRoutes } from '../src/compiler/route-discovery.ts';

describe('discoverRoutes', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('discovers api routes only from the api root and ignores page files under it', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuratchi-route-discovery-'));
    tempDirs.push(projectDir);

    const routesDir = path.join(projectDir, 'src', 'routes');
    const apiDir = path.join(routesDir, 'api');
    fs.mkdirSync(path.join(routesDir, 'dashboard'), { recursive: true });
    fs.mkdirSync(path.join(apiDir, 'users', '[id]'), { recursive: true });

    fs.writeFileSync(path.join(routesDir, 'index.koze'), '<h1>home</h1>');
    fs.writeFileSync(path.join(routesDir, 'dashboard', 'index.koze'), '<h1>dashboard</h1>');
    fs.writeFileSync(path.join(apiDir, 'users.ts'), 'export async function GET() { return new Response("ok"); }');
    fs.writeFileSync(path.join(apiDir, 'users', '[id]', 'suspend.ts'), 'export async function POST() { return new Response("ok"); }');
    fs.writeFileSync(path.join(apiDir, 'ignored.koze'), '<h1>should not be a page</h1>');
    fs.writeFileSync(path.join(routesDir, 'not-a-route.ts'), 'export const helper = true;');

    const routes = discoverRoutes(routesDir);

    expect(routes.map((route) => ({ name: route.name, type: route.type, file: route.file }))).toEqual([
      { name: 'api/users', type: 'api', file: 'users.ts' },
      { name: 'dashboard', type: 'page', file: 'dashboard/index.koze' },
      { name: 'index', type: 'page', file: 'index.koze' },
      { name: 'api/users/[id]/suspend', type: 'api', file: 'users/[id]/suspend.ts' },
    ]);
  });

  test('supports a custom api root and url prefix', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuratchi-custom-api-root-'));
    tempDirs.push(projectDir);

    const routesDir = path.join(projectDir, 'src', 'routes');
    const apiDir = path.join(projectDir, 'src', 'backend');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(routesDir, { recursive: true });

    fs.writeFileSync(path.join(routesDir, 'index.koze'), '<h1>home</h1>');
    fs.writeFileSync(path.join(apiDir, 'health.ts'), 'export async function GET() { return new Response("ok"); }');

    const routes = discoverRoutes(routesDir, {
      apiDir,
      apiUrlPrefix: '/random-api-path',
    });

    expect(routes.map((route) => ({ name: route.name, type: route.type }))).toEqual([
      { name: 'index', type: 'page' },
      { name: 'random-api-path/health', type: 'api' },
    ]);
  });
});
