import { describe, expect, it } from 'vitest';
import { transformReactiveClientScript, rewriteWorkerEnvAliases } from '../src/compiler/script-transform';

describe('destructuring property names', () => {
  it('keeps callback property keys intact while assigning the aliased value to reactive state', () => {
    const transformed = transformReactiveClientScript(`let result = null;
      const callbacks = { success({ result: answer }) { result = answer; } };`, { forceRuntime: true });
    expect(transformed).toContain('result: answer');
    expect(transformed).toContain('__kState.result = answer');
    expect(transformed).not.toContain('__kState.result:');
    // Parse the emitted JavaScript: malformed binding keys used to throw during printing.
    expect(() => new Function(transformed)).not.toThrow();
  });

  it('preserves an environment-named property in an aliased binding', () => {
    const transformed = rewriteWorkerEnvAliases('function read({ env: value }) { return value; }', ['env']);
    expect(transformed).toContain('env: value');
    expect(new Function(`${transformed}; return read({ env: 42 });`)()).toBe(42);
  });
});
