import { describe, expect, test } from 'vitest';
import { createThenableAsyncValue } from '../src/runtime/async-value.js';

describe('createThenableAsyncValue', () => {
  test('starts pending, resolves via await, and exposes success state on the same object', async () => {
    let resolvePromise!: (value: { answer: number }) => void;
    const value = createThenableAsyncValue(
      new Promise<{ answer: number }>((resolve) => {
        resolvePromise = resolve;
      }),
    );

    expect(value.pending).toBe(true);
    expect(value.success).toBe(false);
    expect(value.error).toBeNull();

    resolvePromise({ answer: 42 });

    await expect(value).resolves.toEqual({ answer: 42 });
    expect(value.pending).toBe(false);
    expect(value.success).toBe(true);
    expect(value.error).toBeNull();
    expect((value as { answer?: number }).answer).toBe(42);
  });

  test('rejects through await while updating error state in place', async () => {
    let rejectPromise!: (reason: unknown) => void;
    const value = createThenableAsyncValue(
      new Promise<unknown>((_resolve, reject) => {
        rejectPromise = reject;
      }),
    );

    rejectPromise(new Error('boom'));

    await expect(value).rejects.toThrow('boom');
    expect(value.pending).toBe(false);
    expect(value.success).toBe(false);
    expect(value.error).toBe('boom');
  });
});
