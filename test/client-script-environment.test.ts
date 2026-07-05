import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { compile } from '../src/compiler/index.ts';
import { parseFile } from '../src/compiler/parser.ts';

function createTempProject(name: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `kuratchi-test-${name}-`));
  fs.mkdirSync(path.join(tempDir, 'src', 'routes'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'src', 'server'), { recursive: true });
  return tempDir;
}

describe('client script koze:environment serialization', () => {
  let projectDir: string;

  afterEach(() => {
    if (projectDir && fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('parser extracts clientScriptRaw and serverRpcImports for reactive scripts', () => {
    const source = `<script>
import { dev } from 'koze:environment';
import { getData } from '$server/api';

const data = await getData();

$: if (dev) console.log('Dev mode!', data);
</script>

<div>{data}</div>`;
    
    const result = parseFile(source, { kind: 'route', filePath: 'test.koze' });
    
    // Should have clientScriptRaw set (because of $: label)
    expect(result.clientScriptRaw).toBeTruthy();
    // Should have serverRpcImports
    expect(result.serverRpcImports.length).toBeGreaterThan(0);
    expect(result.serverRpcImports[0]).toContain('$server/api');
    // Should have serverRpcFunctions
    expect(result.serverRpcFunctions).toContain('getData');
    // Should have devAliases
    expect(result.devAliases).toContain('dev');
  });

  test('serializes dev=true in dev mode for client scripts with $server/ imports', async () => {
    projectDir = createTempProject('env-dev-true');
    
    // Create a route with koze:environment and $server/ import
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'page.koze'),
      `<script>
import { dev } from 'koze:environment';
import { getData } from '$server/api';

const data = await getData();

if (dev) console.log('Dev mode!', data);
</script>

<div>{data}</div>`,
      'utf-8',
    );
    
    // Create the server module
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'api.ts'),
      `export async function getData() {
  return 'test data';
}`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    
    // Client script assets are embedded in routes.ts, not written as separate files
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');
    
    // Should contain the client script asset with serialized dev = true
    expect(routesCode).toContain('const dev = true');
    // Should NOT contain the import statement in the bundled asset
    expect(routesCode).not.toContain("from 'koze:environment'");
  });

  test('serializes dev=false in prod mode for client scripts with $server/ imports', async () => {
    projectDir = createTempProject('env-dev-false');
    
    // Create a route with koze:environment and $server/ import
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'page.koze'),
      `<script>
import { dev } from 'koze:environment';
import { getData } from '$server/api';

const data = await getData();

if (dev) console.log('Dev mode!', data);
</script>

<div>{data}</div>`,
      'utf-8',
    );
    
    // Create the server module
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'api.ts'),
      `export async function getData() {
  return 'test data';
}`,
      'utf-8',
    );

    await compile({ projectDir, isDev: false });
    
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');
    // Should contain serialized dev = false
    expect(routesCode).toContain('const dev = false');
  });

  test('serializes renamed dev alias correctly', async () => {
    projectDir = createTempProject('env-dev-alias');
    
    // Create a route with renamed dev alias
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'page.koze'),
      `<script>
import { dev as isDevelopment } from 'koze:environment';
import { getData } from '$server/api';

const data = await getData();

if (isDevelopment) console.log('Dev mode!', data);
</script>

<div>{data}</div>`,
      'utf-8',
    );
    
    // Create the server module
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'api.ts'),
      `export async function getData() {
  return 'test data';
}`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');
    // Should contain the renamed alias
    expect(routesCode).toContain('const isDevelopment = true');
  });

  test('serializes koze:request pathname for client scripts', async () => {
    projectDir = createTempProject('request-pathname');
    
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'page.koze'),
      `<script>
import { pathname } from 'koze:request';
import { getData } from '$server/api';

const data = await getData();

console.log('Current path:', pathname);
</script>

<div>{data}</div>`,
      'utf-8',
    );
    
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'api.ts'),
      `export async function getData() {
  return 'test data';
}`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');
    // Should contain serialized pathname from URL (esbuild may convert const to var)
    expect(routesCode).toMatch(/(?:const|var) pathname = __kozeUrl\.pathname/);
    // Should NOT contain the import statement
    expect(routesCode).not.toContain("from 'koze:request'");
  });

  test('serializes multiple koze:request exports', async () => {
    projectDir = createTempProject('request-multiple');
    
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'page.koze'),
      `<script>
import { pathname, searchParams, url } from 'koze:request';
import { getData } from '$server/api';

const data = await getData();

console.log(pathname, searchParams.get('q'), url.href);
</script>

<div>{data}</div>`,
      'utf-8',
    );
    
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'api.ts'),
      `export async function getData() {
  return 'test data';
}`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');
    // esbuild may convert const to var
    expect(routesCode).toMatch(/(?:const|var) pathname = __kozeUrl\.pathname/);
    expect(routesCode).toMatch(/(?:const|var) searchParams = __kozeUrl\.searchParams/);
    expect(routesCode).toMatch(/(?:const|var) url = __kozeUrl/);
  });

  test('rejects unsafe koze:request exports in client scripts', () => {
    const source = `<script>
import { headers } from 'koze:request';
import { getData } from '$server/api';

console.log(headers.get('Authorization'));
</script>

<div>test</div>`;
    
    expect(() => parseFile(source, { kind: 'route', filePath: 'test.koze' })).toThrow(
      "koze:request export 'headers' is not available in route context"
    );
  });

  test('rejects server-only koze:cookies imports in route scripts', () => {
    const source = `<script>
import { cookies } from 'koze:cookies';
</script>

<div>test</div>`;

    expect(() => parseFile(source, { kind: 'route', filePath: 'test.koze' })).toThrow(
      "koze:cookies export 'cookies' is not available in route context"
    );
  });
});
