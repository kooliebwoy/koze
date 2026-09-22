import { afterEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createKozeCompiler } from '../src/compiler/index.js';

describe('project analysis', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('discovers only Koze-owned application structure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koze-analysis-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'src', 'routes', 'blog'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'routes', 'api'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.koze'), '<html><body><slot /></body></html>');
    fs.writeFileSync(path.join(root, 'src', 'routes', 'layout.koze'), '<main><slot /></main>');
    fs.writeFileSync(path.join(root, 'src', 'routes', 'index.koze'), '<h1>Home</h1>');
    fs.writeFileSync(path.join(root, 'src', 'routes', 'blog', '[slug].koze'), '<h1>Post</h1>');
    fs.writeFileSync(path.join(root, 'src', 'routes', 'api', 'health.ts'), 'export const GET = () => new Response("ok");');
    fs.writeFileSync(path.join(root, 'src', 'server', 'ignored.workflow.ts'), 'export class Ignored {}');

    const analysis = createKozeCompiler().project.analyzeProject({
      projectRoot: root,
      routesDir: 'src/routes',
    });

		expect(analysis.routes.map((route) => [route.urlPattern, route.type])).toEqual([
			['/api/health', 'api'],
			['/', 'page'],
			['/blog/:slug', 'page'],
		]);
    expect(analysis.rootAppPath).toBe(path.join(root, 'src', 'app.koze'));
    expect(analysis.rootLayoutPath).toBe(path.join(root, 'src', 'routes', 'layout.koze'));
    expect(analysis.allLayoutPaths).toEqual([path.join(root, 'src', 'routes', 'layout.koze')]);
  });

  test('reports the removed source extension through compiler diagnostics', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koze-analysis-removed-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'src', 'routes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'routes', 'index.kuratchi'), '<h1>Old</h1>');

    expect(() => createKozeCompiler().project.analyzeProject({
      projectRoot: root,
      routesDir: 'src/routes',
    })).toThrow('src/routes/index.kuratchi -> src/routes/index.koze');
  });

  test('keeps the API source root and URL prefix fixed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koze-analysis-api-convention-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'src', 'routes', 'api', 'users'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'custom-api'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'routes', 'api', 'index.ts'), 'export const GET = () => new Response("ok");');
    fs.writeFileSync(path.join(root, 'src', 'routes', 'api', 'users', '[id].ts'), 'export const GET = () => new Response("ok");');
    fs.writeFileSync(path.join(root, 'src', 'custom-api', 'ignored.ts'), 'export const GET = () => new Response("ignored");');

    const analysis = createKozeCompiler().project.analyzeProject({
      projectRoot: root,
      routesDir: 'src/routes',
    });

    expect(analysis.routes.map((route) => route.urlPattern)).toEqual([
      '/api',
      '/api/users/:id',
    ]);
  });
});
