import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServerModuleCompiler } from '../src/compiler/server-module-pipeline.ts';

describe('server-module-pipeline virtual imports', () => {
  let tempDir: string;
  let srcDir: string;
  let serverDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuratchi-test-'));
    srcDir = path.join(tempDir, 'src');
    serverDir = path.join(srcDir, 'server');
    fs.mkdirSync(serverDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createCompiler() {
    return createServerModuleCompiler({
      projectDir: tempDir,
      srcDir,
      doHandlerProxyPaths: new Map(),
      isDev: true,
      writeFile: (filePath, content) => {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content);
      },
    });
  }

  test('injects compile-time dev aliases for koze:environment imports', () => {
    const moduleFile = path.join(serverDir, 'test.ts');
    fs.writeFileSync(moduleFile, `
import { dev } from 'koze:environment';

export function checkDev() {
  return dev;
}
`);

    const compiler = createCompiler();
    const outputPath = compiler.transformModule(moduleFile);
    const output = fs.readFileSync(outputPath, 'utf-8');

    expect(output).toContain('const dev = true;');
    expect(output).not.toContain("from 'koze:environment'");
  });

  test('allows server-safe koze:request imports in src/server modules', () => {
    const moduleFile = path.join(serverDir, 'test.ts');
    fs.writeFileSync(moduleFile, `
import { request, url, params, locals, headers } from 'koze:request';

export function getRequestInfo() {
  return { method: request.method, url: url.href, params, locals, headers };
}
`);

    const compiler = createCompiler();
    const outputPath = compiler.transformModule(moduleFile);
    const output = fs.readFileSync(outputPath, 'utf-8');

    expect(output).toContain("from '@kuratchi/koze/runtime/request.js'");
  });

  test('allows redirect from koze:navigation in src/server modules', () => {
    const moduleFile = path.join(serverDir, 'test.ts');
    fs.writeFileSync(moduleFile, `
import { redirect } from 'koze:navigation';

export function requireAuth(isLoggedIn: boolean) {
  if (!isLoggedIn) redirect('/login');
}
`);

    const compiler = createCompiler();
    const outputPath = compiler.transformModule(moduleFile);
    const output = fs.readFileSync(outputPath, 'utf-8');

    expect(output).toContain("from '@kuratchi/koze/runtime/navigation.js'");
  });

  test('rejects route-only exports when mixed with other server-safe virtual imports', () => {
    const moduleFile = path.join(serverDir, 'test.ts');
    fs.writeFileSync(moduleFile, `
import { dev } from 'koze:environment';
import { url, params } from 'koze:request';
import { navigateTo } from 'koze:navigation';

export function handler() {
  if (dev) console.log('dev mode');
  if (!params.id) navigateTo('/404');
  return url.pathname;
}
`);

    const compiler = createCompiler();
    expect(() => compiler.transformModule(moduleFile))
      .toThrow(/koze:navigation export 'navigateTo' is not available in server context/);
  });

  test('preserves non-kuratchi imports unchanged', () => {
    const moduleFile = path.join(serverDir, 'test.ts');
    fs.writeFileSync(moduleFile, `
import { dev } from 'koze:environment';
import { env } from 'cloudflare:workers';
import lodash from 'lodash';

export function test() {
  return { dev, env, lodash };
}
`);

    const compiler = createCompiler();
    const outputPath = compiler.transformModule(moduleFile);
    const output = fs.readFileSync(outputPath, 'utf-8');

    expect(output).toContain('const dev = true;');
    expect(output).toContain("from 'cloudflare:workers'");
    expect(output).toContain("from 'lodash'");
  });

  test('resolveCompiledImportPath handles server-safe virtual modules', () => {
    const compiler = createCompiler();

    expect(compiler.resolveCompiledImportPath('koze:environment', serverDir, tempDir))
      .toBe('@kuratchi/koze/runtime/environment.js');
    expect(compiler.resolveCompiledImportPath('koze:request', serverDir, tempDir))
      .toBe('@kuratchi/koze/runtime/request.js');
    expect(compiler.resolveCompiledImportPath('koze:navigation', serverDir, tempDir))
      .toBe('@kuratchi/koze/runtime/navigation.js');
    expect(compiler.resolveCompiledImportPath('koze:cookies', serverDir, tempDir))
      .toBe('@kuratchi/koze/runtime/cookies.js');
    expect(compiler.resolveCompiledImportPath('koze:middleware', serverDir, tempDir))
      .toBe('@kuratchi/koze/runtime/middleware-virtual.js');
  });

  test('allows koze:cookies in src/server modules', () => {
    const moduleFile = path.join(serverDir, 'test.ts');
    fs.writeFileSync(moduleFile, `
import { cookies } from 'koze:cookies';

export function setTheme() {
  cookies.set('theme', 'dark', { path: '/' });
}
`);

    const compiler = createCompiler();
    const outputPath = compiler.transformModule(moduleFile);
    const output = fs.readFileSync(outputPath, 'utf-8');

    expect(output).toContain("from '@kuratchi/koze/runtime/cookies.js'");
  });

  test('allows koze:middleware in server files', () => {
    const moduleFile = path.join(serverDir, 'middleware.ts');
    fs.writeFileSync(moduleFile, `
import { defineMiddleware } from 'koze:middleware';

export default defineMiddleware({});
`);

    const compiler = createCompiler();
    const outputPath = compiler.transformModule(moduleFile);
    const output = fs.readFileSync(outputPath, 'utf-8');

    expect(output).toContain("from '@kuratchi/koze/runtime/middleware-virtual.js'");
  });

  test('leaves unknown koze:* modules unchanged', () => {
    const moduleFile = path.join(serverDir, 'test.ts');
    fs.writeFileSync(moduleFile, `
import { foo } from 'koze:unknown';

export const bar = foo;
`);

    const compiler = createCompiler();
    const outputPath = compiler.transformModule(moduleFile);
    const output = fs.readFileSync(outputPath, 'utf-8');

    // Unknown modules are left as-is (will fail at runtime, but that's expected)
    expect(output).toContain("from 'koze:unknown'");
  });
});
