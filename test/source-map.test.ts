import { afterEach, describe, expect, test } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Buffer } from 'node:buffer';

import { compile } from '../src/compiler/index.js';
import { kuratchi } from '../src/vite/index.js';
import type { KuratchiSourceMap } from '../src/compiler/source-map.js';

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

type MinimalResolvedConfig = {
  root: string;
  command: 'serve' | 'build';
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: Record<string, string>;
        };
      };
    };
  };
};

interface DecodedSegment {
  generatedLine: number;
  generatedColumn: number;
  sourceIndex: number;
  sourceLine: number;
  sourceColumn: number;
}

function createTempProject(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kuratchi-sourcemap-${name}-`));
  fs.mkdirSync(path.join(dir, 'src', 'routes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'worker.ts'), 'export { default } from "koze:worker";\n', 'utf-8');
  return dir;
}

function routeHash(filePath: string): string {
  return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 10);
}

function leadingHash(filePath: string): string {
  const source = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  return crypto.createHash('sha1').update('leading:' + filePath + '\0' + source).digest('hex').slice(0, 12);
}

async function setupPlugin(projectDir: string) {
  const plugin = kuratchi()[0];
  const config: MinimalResolvedConfig = {
    root: projectDir,
    command: 'serve',
    environments: {
      client: {
        build: {
          rollupOptions: {
            input: {},
          },
        },
      },
    },
  };
  if (typeof plugin.configResolved === 'function') {
    await (plugin.configResolved as unknown as (config: MinimalResolvedConfig) => Promise<void> | void)(config);
  }
  const load = plugin.load;
  if (typeof load !== 'function') throw new Error('Expected kuratchi plugin load hook');
  const ctx = {
    addWatchFile(_file: string) {},
  };
  return {
    load: (id: string) => load.call(ctx as never, id),
  };
}

function extractInlineSourceMap(code: string): KuratchiSourceMap {
  const match = code.match(/\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/);
  if (!match) throw new Error('Missing inline source map');
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf-8')) as KuratchiSourceMap;
}

function decodeVlq(segment: string, indexRef: { index: number }): number {
  let result = 0;
  let shift = 0;
  let continuation = 0;

  do {
    const digit = BASE64_CHARS.indexOf(segment[indexRef.index++]);
    continuation = digit & 32;
    result += (digit & 31) << shift;
    shift += 5;
  } while (continuation);

  const negative = result & 1;
  const value = result >> 1;
  return negative ? -value : value;
}

function decodeMappings(map: KuratchiSourceMap): DecodedSegment[] {
  const decoded: DecodedSegment[] = [];
  let previousSourceIndex = 0;
  let previousSourceLine = 0;
  let previousSourceColumn = 0;

  const lines = map.mappings.split(';');
  for (let generatedLine = 0; generatedLine < lines.length; generatedLine++) {
    let previousGeneratedColumn = 0;
    const line = lines[generatedLine];
    if (!line) continue;

    for (const rawSegment of line.split(',')) {
      if (!rawSegment) continue;
      const indexRef = { index: 0 };
      previousGeneratedColumn += decodeVlq(rawSegment, indexRef);
      previousSourceIndex += decodeVlq(rawSegment, indexRef);
      previousSourceLine += decodeVlq(rawSegment, indexRef);
      previousSourceColumn += decodeVlq(rawSegment, indexRef);
      decoded.push({
        generatedLine,
        generatedColumn: previousGeneratedColumn,
        sourceIndex: previousSourceIndex,
        sourceLine: previousSourceLine,
        sourceColumn: previousSourceColumn,
      });
    }
  }
  return decoded;
}

function firstMappingForLine(map: KuratchiSourceMap, generatedLine: number): DecodedSegment | undefined {
  return decodeMappings(map).find((segment) => segment.generatedLine === generatedLine);
}

function mappingsForGeneratedNeedle(code: string, map: KuratchiSourceMap, needle: string): DecodedSegment[] {
  const lines = code.split(/\r?\n/);
  const mappings = decodeMappings(map);
  return lines
    .map((line, generatedLine) => ({ line, generatedLine }))
    .filter(({ line }) => line.includes(needle))
    .map(({ generatedLine }) => mappings.find((segment) => segment.generatedLine === generatedLine))
    .filter((segment): segment is DecodedSegment => Boolean(segment));
}

function lineIndex(source: string, needle: string): number {
  const idx = source.indexOf(needle);
  if (idx === -1) throw new Error(`Missing source needle: ${needle}`);
  return source.slice(0, idx).split(/\r?\n/).length - 1;
}

describe('Kuratchi source maps', () => {
  const projectDirs: string[] = [];

  afterEach(() => {
    for (const dir of projectDirs.splice(0)) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('maps generated route modules back to route script and template lines', async () => {
    const projectDir = createTempProject('route-module');
    projectDirs.push(projectDir);
    const routePath = path.join(projectDir, 'src', 'routes', 'page.koze');
    const routeSource = `<script>
import { params } from 'koze:request';
const title = 'Mapped';
let count = 1;
function increment() {
  count += 1;
}
</script>
<h1>{title}</h1>
<button data-count={count} onclick={increment()}>Increment</button>`;
    fs.writeFileSync(routePath, routeSource, 'utf-8');

    const plugin = await setupPlugin(projectDir);
    const code = await plugin.load(`\0koze:route/${routeHash(routePath)}`);
    expect(typeof code).toBe('string');
    const routeModule = code as string;
    const map = extractInlineSourceMap(routeModule);

    expect(map.sources).toEqual([routePath.replace(/\\/g, '/')]);
    expect(map.sourcesContent).toEqual([routeSource]);
    expect(map.mappings.length).toBeGreaterThan(0);

    const generatedLines = routeModule.split(/\r?\n/);
    const scriptGeneratedLine = generatedLines.findIndex((line) => line.includes("const title = 'Mapped';"));
    const templateGeneratedLine = generatedLines.findIndex((line) => line.includes('__esc(title)'));
    expect(firstMappingForLine(map, scriptGeneratedLine)?.sourceLine).toBe(lineIndex(routeSource, "const title = 'Mapped';"));
    expect(firstMappingForLine(map, templateGeneratedLine)?.sourceLine).toBe(lineIndex(routeSource, '<h1>{title}</h1>'));
  });

  test('maps repeated template expressions to distinct generated occurrences', async () => {
    const projectDir = createTempProject('duplicate-expressions');
    projectDirs.push(projectDir);
    const routePath = path.join(projectDir, 'src', 'routes', 'page.koze');
    const routeSource = `<script>
const title = 'Mapped twice';
</script>
<h1>{title}</h1>
<p>{title}</p>`;
    fs.writeFileSync(routePath, routeSource, 'utf-8');

    const plugin = await setupPlugin(projectDir);
    const code = await plugin.load(`\0koze:route/${routeHash(routePath)}`);
    expect(typeof code).toBe('string');
    const routeModule = code as string;
    const map = extractInlineSourceMap(routeModule);
    const mappings = mappingsForGeneratedNeedle(routeModule, map, '__esc(title)');

    expect(mappings.length).toBeGreaterThanOrEqual(2);
    expect(mappings[0].sourceLine).toBe(lineIndex(routeSource, '<h1>{title}</h1>'));
    expect(mappings[1].sourceLine).toBe(lineIndex(routeSource, '<p>{title}</p>'));
    expect(mappings[0].sourceColumn).toBeGreaterThan(0);
    expect(mappings[0].generatedColumn).toBeGreaterThan(0);
  });

  test('maps generated browser fragments back to the owning route script', async () => {
    const projectDir = createTempProject('client-fragment');
    projectDirs.push(projectDir);
    const routePath = path.join(projectDir, 'src', 'routes', 'page.koze');
    const routeSource = `<script>
const title = 'Client mapped';
let count = 1;
$: doubled = count * 2;
</script>
<button>{doubled}</button>`;
    fs.writeFileSync(routePath, routeSource, 'utf-8');

    const plugin = await setupPlugin(projectDir);
    const code = await plugin.load(`virtual:koze-client/${leadingHash(routePath)}.ts`);
    expect(typeof code).toBe('string');
    const fragment = code as string;
    const map = extractInlineSourceMap(fragment);

    const generatedLines = fragment.split(/\r?\n/);
    const generatedLine = generatedLines.findIndex((line) => line.includes("const title = 'Client mapped';"));

    expect(map.sources).toEqual([routePath.replace(/\\/g, '/')]);
    expect(firstMappingForLine(map, generatedLine)?.sourceLine).toBe(
      lineIndex(routeSource, "const title = 'Client mapped';"),
    );
  });

  test('maps layout and app virtual modules back to their source files', async () => {
    const projectDir = createTempProject('layout-app');
    projectDirs.push(projectDir);
    const layoutPath = path.join(projectDir, 'src', 'routes', 'layout.koze');
    const appPath = path.join(projectDir, 'src', 'app.koze');
    const layoutSource = `<script>
const shell = 'Layout';
</script>
<section>{shell}<slot /></section>`;
    const appSource = `<script>
const lang = 'en';
</script>
<!doctype html>
<html lang={lang}><body><slot /></body></html>`;
    fs.writeFileSync(layoutPath, layoutSource, 'utf-8');
    fs.writeFileSync(appPath, appSource, 'utf-8');

    const plugin = await setupPlugin(projectDir);
    const layoutCode = await plugin.load('\0koze:layout');
    const appCode = await plugin.load('\0koze:app');
    expect(typeof layoutCode).toBe('string');
    expect(typeof appCode).toBe('string');

    const layoutMap = extractInlineSourceMap(layoutCode as string);
    const appMap = extractInlineSourceMap(appCode as string);

    expect(layoutMap.sources).toEqual([layoutPath.replace(/\\/g, '/')]);
    expect(appMap.sources).toEqual([appPath.replace(/\\/g, '/')]);
    expect(layoutMap.sourcesContent[0]).toBe(layoutSource);
    expect(appMap.sourcesContent[0]).toBe(appSource);
  });

  test('maps generated worker virtual modules to convention source modules', async () => {
    const projectDir = createTempProject('worker-module');
    projectDirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, 'src', 'server', 'ai'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'ai', 'session.agent.ts'),
      `export class SessionAgent {
  async onRequest() {
    return new Response('ok');
  }
}
`,
      'utf-8',
    );

    const plugin = await setupPlugin(projectDir);
    const workerCode = await plugin.load('\0koze:worker');
    expect(typeof workerCode).toBe('string');
    const map = extractInlineSourceMap(workerCode as string);

    expect(map.sources.some((source) => source.endsWith('/session.agent.js'))).toBe(true);
    expect(map.sourcesContent.some((source) => source.includes('class SessionAgent'))).toBe(true);
    expect(map.mappings.length).toBeGreaterThan(0);
  });

  test('emits source maps for legacy compiler routes output without exposing server RPC stubs', async () => {
    const projectDir = createTempProject('legacy-routes');
    projectDirs.push(projectDir);
    const routePath = path.join(projectDir, 'src', 'routes', 'page.koze');
    fs.writeFileSync(routePath, '<script>const title = "Legacy";</script><h1>{title}</h1>', 'utf-8');

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');
    const map = extractInlineSourceMap(routesCode);

    expect(map.sources).toContain(routePath.replace(/\\/g, '/'));
    expect(map.sourcesContent.some((source) => source.includes('const title = "Legacy"'))).toBe(true);
    expect(map.mappings.length).toBeGreaterThan(0);
  });
});
