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
});
