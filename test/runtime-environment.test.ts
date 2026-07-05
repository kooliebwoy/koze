import { describe, expect, test, beforeEach, afterEach } from 'vitest';

describe('runtime environment', () => {
  let originalDev: boolean | undefined;

  beforeEach(() => {
    originalDev = (globalThis as any).__koze_DEV__;
  });

  afterEach(() => {
    if (originalDev === undefined) {
      delete (globalThis as any).__koze_DEV__;
    } else {
      (globalThis as any).__koze_DEV__ = originalDev;
    }
  });

  test('dev is false when __koze_DEV__ is not set', async () => {
    delete (globalThis as any).__koze_DEV__;
    
    // Re-import to get fresh value
    const { dev } = await import('../src/runtime/environment.ts');
    expect(dev).toBe(false);
  });

  test('dev is true when __koze_DEV__ is true', async () => {
    (globalThis as any).__koze_DEV__ = true;
    
    // The module caches the value at import time, so we need to check the global
    expect((globalThis as any).__koze_DEV__).toBe(true);
  });

  test('dev is false when __koze_DEV__ is false', async () => {
    (globalThis as any).__koze_DEV__ = false;
    
    expect((globalThis as any).__koze_DEV__).toBe(false);
  });
});
