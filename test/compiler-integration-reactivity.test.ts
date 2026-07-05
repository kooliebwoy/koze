import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compile } from '../src/compiler/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempProject(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kuratchi-${name}-`));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src', 'routes'), { recursive: true });
  return dir;
}

function writeRoute(projectDir: string, source: string): void {
  const routeFile = path.join(projectDir, 'src', 'routes', 'page.koze');
  fs.writeFileSync(routeFile, source, 'utf-8');
}

function readCompiledRoutes(projectDir: string): string {
  return fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');
}

describe('compiler integration: reactive client scripts', () => {
  it('emits reactive transforms for $: route scripts in compiled output', async () => {
    const projectDir = createTempProject('reactive-route');
    writeRoute(
      projectDir,
      `<script>
let users = ['Alice'];
$: console.log(users.length);
function reset() {
  users = ['Bob'];
}
</script>
<main>Reactive page</main>
<button onClick="reset()">Reset</button>`,
    );

    const workerPath = await compile({ projectDir, isDev: true });
    expect(workerPath).toBe(path.join(projectDir, '.koze', 'worker.ts'));

    const routesCode = readCompiledRoutes(projectDir);
    expect(routesCode).toContain('window.__kozeReactive');
    expect(routesCode).toContain('var __kState = __k$.state({});');
    expect(routesCode).toContain('__kState.users = [\\"Alice\\"];');
    expect(routesCode).toContain('__k$.effect(() => {');
    expect(routesCode).toContain('console.log(__kState.users.length);');
    expect(routesCode).toContain('__kState.users = [\\"Bob\\"];');
  });

  it('keeps module imports before reactive runtime binding in compiled scripts', async () => {
    const projectDir = createTempProject('reactive-module-order');
    writeRoute(
      projectDir,
      `<script type="module">
import { createSuccessValue } from '@kuratchi/koze/runtime/async-value.js';
let users = [];
$: console.log(users.length);
</script>
<main>Module script</main>
<div>Hi</div>`,
    );

    await compile({ projectDir, isDev: true });
    const routesCode = readCompiledRoutes(projectDir);

    const importNeedle = 'import { createSuccessValue } from \\"@kuratchi/koze/runtime/async-value.js\\";';
    const runtimeNeedle = 'var __k$ = window.__kozeReactive;';
    const importIdx = routesCode.indexOf(importNeedle);
    const runtimeIdx = routesCode.indexOf(runtimeNeedle);

    expect(importIdx).toBeGreaterThan(-1);
    expect(runtimeIdx).toBeGreaterThan(-1);
    expect(runtimeIdx).toBeGreaterThan(importIdx);
  });

  it('supports derived reactive aliases declared only through $: assignment', async () => {
    const projectDir = createTempProject('reactive-derived-alias');
    writeRoute(
      projectDir,
      `<script>
let selected = 'x';
$: showDetails = selected === 'x';
</script>
if (showDetails) {
  <p>Visible</p>
}`,
    );

    await compile({ projectDir, isDev: true });
    const routesCode = readCompiledRoutes(projectDir);

    expect(routesCode).toContain('let showDetails;');
    expect(routesCode).toContain("showDetails = selected === 'x';");
    expect(routesCode).toContain('__kState.showDetails = void 0;');
    expect(routesCode).toContain('__kState.showDetails = __kState.selected === \\"x\\";');
    expect(routesCode).toContain('return __kState.showDetails;');
  });
});
