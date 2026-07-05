import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { compileApiRoute } from '../src/compiler/api-route-pipeline.ts';
import { compile } from '../src/compiler/index.ts';
import { discoverRoutes } from '../src/compiler/route-discovery.ts';

describe('compileApiRoute', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('preserves a merged manifest for agent-oriented api metadata', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuratchi-api-route-'));
    tempDirs.push(projectDir);

    const routePath = path.join(projectDir, 'src', 'routes', 'api', 'reports', 'index.ts');
    fs.mkdirSync(path.dirname(routePath), { recursive: true });
    fs.writeFileSync(routePath, [
      'export const manifest = {',
      "  summary: 'List reports',",
      "  auth: 'required',",
      "  tags: ['reports'],",
      '};',
      '',
      'export async function GET() {',
      "  return new Response('ok');",
      '}',
      '',
      'export async function POST() {',
      "  return new Response('created', { status: 201 });",
      '}',
      '',
    ].join('\n'));

    const imports: string[] = [];
    const compiled = compileApiRoute({
      pattern: '/api/reports',
      fullPath: routePath,
      projectDir,
      transformModule: (entryAbsPath) => entryAbsPath,
      allocateModuleId: () => '__m0',
      pushImport: (statement) => imports.push(statement),
    });

    expect(imports).toEqual(["import * as __m0 from '../src/routes/api/reports/index.ts';"]);
    expect(compiled).toContain("__api: true");
    expect(compiled).toContain("manifest:");
    expect(compiled).toContain("kind: 'api'");
    expect(compiled).toContain('pattern: "/api/reports"');
    expect(compiled).toContain('file: "src/routes/api/reports/index.ts"');
    expect(compiled).toContain('methods: ["GET","POST"]');
    expect(compiled).toContain('__m0.manifest');
    expect(compiled).toContain('GET: __m0.GET');
    expect(compiled).toContain('POST: __m0.POST');
  });

  test('discovers API methods from TypeScript exports instead of comments or strings', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuratchi-api-route-'));
    tempDirs.push(projectDir);

    const routePath = path.join(projectDir, 'src', 'routes', 'api', 'status.ts');
    fs.mkdirSync(path.dirname(routePath), { recursive: true });
    fs.writeFileSync(routePath, [
      '// export async function DELETE() {}',
      "const example = 'export async function PUT() {}';",
      '',
      'export const GET = async () => new Response("ok");',
      'const create = async () => new Response("created");',
      'export { create as POST };',
      'export default function HEAD() { return new Response(null); }',
      '',
    ].join('\n'));

    const compiled = compileApiRoute({
      pattern: '/api/status',
      fullPath: routePath,
      projectDir,
      transformModule: (entryAbsPath) => entryAbsPath,
      allocateModuleId: () => '__m0',
      pushImport: () => {},
    });

    expect(compiled).toContain('methods: ["GET","POST"]');
    expect(compiled).toContain('GET: __m0.GET');
    expect(compiled).toContain('POST: __m0.POST');
    expect(compiled).not.toContain('DELETE: __m0.DELETE');
    expect(compiled).not.toContain('PUT: __m0.PUT');
    expect(compiled).not.toContain('HEAD: __m0.HEAD');
  });
});

describe('discoverRoutes api routes', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('maps api index and named route modules to extensionless url patterns', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuratchi-api-route-'));
    tempDirs.push(projectDir);

    const routesDir = path.join(projectDir, 'src', 'routes');
    const apiDir = path.join(routesDir, 'api');
    fs.mkdirSync(path.join(apiDir, 'v1', 'health'), { recursive: true });
    fs.mkdirSync(path.join(apiDir, 'v1', 'platform', 'sites', '[id]'), { recursive: true });
    fs.writeFileSync(path.join(apiDir, 'v1', 'health', 'index.ts'), 'export function GET() {}');
    fs.writeFileSync(path.join(apiDir, 'v1', 'platform', 'sites', '[id]', 'files.ts'), 'export function GET() {}');
    fs.writeFileSync(path.join(apiDir, 'v1', 'ignored.txt'), 'export function GET() {}');

    const apiRoutes = discoverRoutes(routesDir).filter((route) => route.type === 'api');

    expect(apiRoutes.map((route) => route.name)).toEqual([
      'api/v1/health',
      'api/v1/platform/sites/[id]/files',
    ]);
    expect(apiRoutes.find((route) => route.name === 'api/v1/health')?.file).toBe('v1/health/index.ts');
    expect(apiRoutes.find((route) => route.name === 'api/v1/platform/sites/[id]/files')?.file).toBe(
      'v1/platform/sites/[id]/files.ts',
    );
  });
});

describe('compile api routes', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('emits file-based API routes with method handlers for real route modules', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuratchi-api-route-compile-'));
    tempDirs.push(projectDir);

    const routesDir = path.join(projectDir, 'src', 'routes');
    const apiDir = path.join(routesDir, 'api', 'v1');
    fs.mkdirSync(path.join(apiDir, 'items', '[id]'), { recursive: true });
    fs.mkdirSync(path.join(apiDir, 'platform', 'sites', '[id]', 'domains', '[domainId]'), { recursive: true });
    fs.writeFileSync(path.join(routesDir, 'index.koze'), '<h1>home</h1>');
    fs.writeFileSync(
      path.join(apiDir, 'items', '[id]', 'index.ts'),
      [
        'export async function GET(ctx) { return Response.json({ id: ctx.params.id }); }',
        'export async function POST(ctx) { return Response.json(await ctx.request.json(), { status: 201 }); }',
        'export async function PUT(ctx) { return Response.json(await ctx.request.json()); }',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(apiDir, 'platform', 'sites', '[id]', 'domains', '[domainId]', 'refresh.ts'),
      'export async function POST() { return Response.json({ ok: true }); }',
    );
    fs.writeFileSync(path.join(apiDir, 'ignored.txt'), 'export async function GET() {}');

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(routesCode).toContain('pattern: "/api/v1/items/:id"');
    expect(routesCode).toContain('methods: ["GET","POST","PUT"]');
    expect(routesCode).toMatch(/GET: __m\d+\.GET/);
    expect(routesCode).toMatch(/POST: __m\d+\.POST/);
    expect(routesCode).toMatch(/PUT: __m\d+\.PUT/);
    expect(routesCode).toContain('file: "src/routes/api/v1/items/[id]/index.ts"');

    expect(routesCode).toContain('pattern: "/api/v1/platform/sites/:id/domains/:domainId/refresh"');
    expect(routesCode).toContain('methods: ["POST"]');
    expect(routesCode).toContain('file: "src/routes/api/v1/platform/sites/[id]/domains/[domainId]/refresh.ts"');
    expect(routesCode).not.toContain('ignored.txt');
  });

  test('generates an API Shield OpenAPI artifact from route-adjacent api-shield files', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuratchi-api-shield-'));
    tempDirs.push(projectDir);

    const routesDir = path.join(projectDir, 'src', 'routes');
    const apiDir = path.join(routesDir, 'api', 'v1', 'items', '[id]');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(path.join(routesDir, 'api', 'internal'), { recursive: true });
    fs.writeFileSync(path.join(routesDir, 'index.koze'), '<h1>home</h1>');
    fs.writeFileSync(
      path.join(apiDir, 'index.ts'),
      [
        'export async function GET() { return Response.json({ ok: true }); }',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(apiDir, 'index.api-shield.ts'),
      [
        'export default {',
        '  GET: {',
        "  operationId: 'getItem',",
        "  summary: 'Read an item',",
        "  auth: 'required',",
        "  tags: ['items'],",
        "  params: { id: { type: 'string', format: 'uuid' } },",
        "  query: { include: { type: 'string' } },",
        "  responses: { 200: { description: 'Item found' } },",
        '  },',
        '} as const;',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(routesDir, 'api', 'internal', 'index.ts'),
      'export async function GET() { return Response.json({ internal: true }); }',
      'utf-8',
    );

    await compile({
      projectDir,
      isDev: true,
      apiShield: {
        title: 'Inventory API',
        version: '2026.05',
        servers: ['https://api.example.com'],
        include: ['/api/v1'],
      },
    });

    const openapi = JSON.parse(fs.readFileSync(
      path.join(projectDir, '_cloudflare', 'api-shield', 'openapi.json'),
      'utf-8',
    ));
    const terraform = fs.readFileSync(
      path.join(projectDir, '_cloudflare', 'api-shield', 'api-shield.tf'),
      'utf-8',
    );
    const routesSource = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(openapi.info).toEqual({ title: 'Inventory API', version: '2026.05' });
    expect(openapi.servers).toEqual([{ url: 'https://api.example.com' }]);
    expect(openapi.paths['/api/internal']).toBeUndefined();
    expect(openapi.paths['/api/v1/items/{id}'].get).toMatchObject({
      operationId: 'getItem',
      summary: 'Read an item',
      tags: ['items'],
      security: [{ bearerAuth: [] }],
      responses: {
        '200': { description: 'Item found' },
      },
    });
    expect(openapi.paths['/api/v1/items/{id}'].get.parameters).toEqual([
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      {
        name: 'include',
        in: 'query',
        required: false,
        schema: { type: 'string' },
      },
    ]);
    expect(openapi.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
    expect(terraform).toContain('source             = file("${path.module}/openapi.json")');
    expect(terraform).toContain('get_getitem = {');
    expect(terraform).toContain('endpoint = "/api/v1/items/{id}"');
    expect(terraform).not.toContain('/api/internal');
    expect(routesSource).not.toContain('index.api-shield');
  });
});
