import { describe, expect, test } from 'vitest';

import * as compilerExports from '../src/compiler/index.ts';
import { createKozeCompiler } from '../src/compiler/index.ts';

describe('compiler service boundary', () => {
  test('exposes one grouped build-integration service without a project compile entrypoint', () => {
    const compiler = createKozeCompiler();

    expect(Object.isFrozen(compiler)).toBe(true);
    expect(Object.isFrozen(compiler.application)).toBe(true);
    expect(Object.isFrozen(compiler.language)).toBe(true);
    expect(Object.isFrozen(compiler.project)).toBe(true);
    expect(Object.isFrozen(compiler.output)).toBe(true);
    expect(compiler.language.parseFile).toBeTypeOf('function');
    expect(compiler.application.transformRouteFile).toBeTypeOf('function');
    expect(compiler.application.generateWorkerModule).toBeTypeOf('function');
    expect(compiler.project.analyzeProject).toBeTypeOf('function');
    expect(compiler.project.createComponentCompiler).toBeTypeOf('function');
    expect('cloudflare' in compiler).toBe(false);
    expect('compile' in compilerExports).toBe(false);
  });

  test('preserves top-level server control flow and its dependencies in the SSR prelude', () => {
    const compiler = createKozeCompiler();
    const result = compiler.language.buildSelectiveSsrPrelude({
      scriptBody: `
        import { pathname } from 'koze:request';
        import { redirect } from 'koze:navigation';
        const destination = pathname === '/' ? '/inbox' : '/work';
        if (pathname === '/') redirect(destination, 308);
      `,
      template: '<p>Opening…</p>',
      serverImports: [
        "import { redirect } from 'koze:navigation';",
      ],
    });

    expect(result.prelude).toContain("const destination = pathname === '/' ? '/inbox' : '/work';");
    expect(result.prelude).toContain("if (pathname === '/')");
    expect(result.prelude).toContain('redirect(destination, 308);');
    expect(result.imports).toEqual(["import { redirect } from 'koze:navigation';"]);
  });
});
