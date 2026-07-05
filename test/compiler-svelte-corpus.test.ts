import { afterEach, describe, expect, it } from 'vitest';
import { compile as compileSvelte } from 'svelte/compiler';

import { generateRenderFunction } from '../src/compiler/template.js';
import { parseFile } from '../src/compiler/parser.js';
import { parseKuratchiSfc } from '../src/compiler/sfc-parser.js';
import { compile } from '../src/compiler/index.js';
import {
  COMPILER_CORPUS,
  getCompilerCorpusByStatus,
  type CompilerCorpusCase,
} from './fixtures/compiler-corpus.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempProject(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kuratchi-corpus-${name}-`));
  tempDirs.push(dir);
  return dir;
}

function writeProjectFiles(projectDir: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(projectDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

function assertSingleFileKuratchiCompiles(source: string, name: string): void {
  const sfc = parseKuratchiSfc(source, {
    kind: 'route',
    filePath: `svelte-corpus/${name}.koze`,
  });
  const parsed = parseFile(source, {
    kind: 'route',
    filePath: `svelte-corpus/${name}.koze`,
  });
  const renderSource = generateRenderFunction(sfc.template.source, parsed.dataVars);

  expect(sfc.template.source.length).toBeGreaterThan(0);
  expect(parsed.ir.template.source).toBe(sfc.template.source);
  expect(renderSource).toContain('function render(data)');

  // Syntax check generated render output without executing user expressions.
  new Function(`${renderSource}; return render;`);
}

async function assertKuratchiCompiles(fixture: CompilerCorpusCase): Promise<void> {
  if (fixture.projectFiles) {
    const projectDir = createTempProject(fixture.name);
    writeProjectFiles(projectDir, fixture.projectFiles);
    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(routesCode.length).toBeGreaterThan(0);
    for (const expected of fixture.expectedOutputIncludes ?? []) {
      expect(routesCode).toContain(expected);
    }
    for (const forbidden of fixture.expectedOutputExcludes ?? []) {
      expect(routesCode).not.toContain(forbidden);
    }
    return;
  }

  expect(fixture.koze, `${fixture.name} must include Kuratchi source`).toBeTruthy();
  assertSingleFileKuratchiCompiles(fixture.koze!, fixture.name);
}

function assertSvelteCompiles(source: string): void {
  const output = compileSvelte(source, {
    generate: 'server',
    dev: false,
  });
  expect(output.js.code.length).toBeGreaterThan(0);
}

describe('compiler corpus against Svelte baseline', () => {
  const portedFixtures = getCompilerCorpusByStatus('ported-pass');

  it('tracks the compatibility matrix explicitly', () => {
    expect(portedFixtures.length).toBeGreaterThanOrEqual(10);
    expect(getCompilerCorpusByStatus('ported-fail')).toHaveLength(0);
    expect(getCompilerCorpusByStatus('future-feature')).toHaveLength(0);
    expect(getCompilerCorpusByStatus('intentional-divergence').length).toBeGreaterThan(0);
    expect(new Set(COMPILER_CORPUS.map((fixture) => fixture.name)).size).toBe(COMPILER_CORPUS.length);
  });

  for (const fixture of portedFixtures) {
    it(`compiles ${fixture.category}: ${fixture.name}`, async () => {
      expect(fixture.svelte, `${fixture.name} must include Svelte source`).toBeTruthy();
      await assertKuratchiCompiles(fixture);
      assertSvelteCompiles(fixture.svelte!);
    });
  }
});
