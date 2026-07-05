import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { __setRequestContext, __getLocals } from '../src/runtime/context.ts';
import { __setWorkflowRegistry, workflowStatus } from '../src/runtime/workflow.ts';

/**
 * These tests exercise the request-scoped `workflowStatus` runtime helper.
 * Each test installs a fresh fake env + request context via
 * `__setRequestContext` so module-scoped registry/locals do not leak between tests.
 */

interface FakeWorkflowInstance {
  status: () => Promise<any>;
}

interface FakeWorkflowBinding {
  get: (id: string) => Promise<FakeWorkflowInstance>;
}

function bindingReturning(value: any): FakeWorkflowBinding {
  return {
    get: async () => ({ status: async () => value }),
  };
}

function bindingRejecting(err: Error): FakeWorkflowBinding {
  return {
    get: async () => ({ status: async () => { throw err; } }),
  };
}

function installEnv(env: Record<string, any>): void {
  __setRequestContext({} as ExecutionContext, new Request('https://example.com/'), env);
}

function readPollLocal(): { interval: string | number; done: boolean } | undefined {
  return __getLocals().__kozePoll as any;
}

afterEach(() => {
  // Drop registry between tests to keep them isolated.
  __setWorkflowRegistry({});
});

describe('runtime workflowStatus', () => {
  beforeEach(() => {
    installEnv({});
    __setWorkflowRegistry({
      container: { binding: 'CONTAINER_WORKFLOW' },
      migration: { binding: 'MIGRATION_WORKFLOW' },
    });
  });

  test('returns an error AsyncValue when the workflow name is unknown', async () => {
    const value = await workflowStatus('does-not-exist' as any, 'id-1');
    expect(value.pending).toBe(false);
    expect(value.success).toBe(false);
    expect(value.error).toContain("Unknown workflow 'does-not-exist'");
  });

  test('returns an error AsyncValue when instanceId is missing', async () => {
    const value = await workflowStatus('container', '');
    expect(value.error).toBe('Missing instanceId');
    expect(value.success).toBe(false);
  });

  test('returns an error AsyncValue when the env binding is not present', async () => {
    // Registry references CONTAINER_WORKFLOW, but env does not expose it.
    const value = await workflowStatus('container', 'id-1');
    expect(value.error).toContain("Workflow binding 'CONTAINER_WORKFLOW' is not available");
  });

  test('resolves the binding status() into a success AsyncValue', async () => {
    installEnv({
      CONTAINER_WORKFLOW: bindingReturning({ status: 'running', output: { step: 'create' } }),
    });

    const value = await workflowStatus('container', 'id-1');
    expect(value.pending).toBe(false);
    expect(value.success).toBe(true);
    expect(value.error).toBeNull();
    expect(value.status).toBe('running');
    expect((value as any).output).toEqual({ step: 'create' });
  });

  test('does not register poll metadata when { poll } is omitted', async () => {
    installEnv({ CONTAINER_WORKFLOW: bindingReturning({ status: 'running' }) });
    await workflowStatus('container', 'id-1');
    expect(readPollLocal()).toBeUndefined();
  });

  test('registers poll metadata as not-done while the workflow is running', async () => {
    installEnv({ CONTAINER_WORKFLOW: bindingReturning({ status: 'running' }) });

    await workflowStatus('container', 'id-1', { poll: '2s' });

    expect(readPollLocal()).toEqual({ interval: '2s', done: false });
  });

  test('default until marks complete/errored/terminated as terminal', async () => {
    for (const terminal of ['complete', 'completed', 'errored', 'terminated']) {
      installEnv({ CONTAINER_WORKFLOW: bindingReturning({ status: terminal }) });
      await workflowStatus('container', 'id-1', { poll: '2s' });
      expect(readPollLocal()?.done).toBe(true);
    }
  });

  test('custom until overrides the default terminal predicate', async () => {
    installEnv({ CONTAINER_WORKFLOW: bindingReturning({ status: 'complete' }) });

    await workflowStatus('container', 'id-1', {
      poll: '2s',
      until: (s) => s.status === 'fully-settled',
    });

    // Default would have said 'complete' is terminal, but our predicate disagrees.
    expect(readPollLocal()?.done).toBe(false);
  });

  test('keeps polling when the workflow instance is not resolvable yet', async () => {
    // Binding.get() throws while the instance is still sitting in a producer
    // queue (e.g. `HOST_OPERATIONS` with max_concurrency: 1). Marking the
    // poll as terminal here would freeze the UI on first render — the whole
    // reason the route registered a poll in the first place is so it can
    // recover once the instance materializes.
    installEnv({ CONTAINER_WORKFLOW: bindingRejecting(new Error('boom')) });

    const value = await workflowStatus('container', 'id-1', { poll: '2s' });
    expect(value.error).toBe('boom');
    expect(value.success).toBe(false);
    expect(readPollLocal()?.done).toBe(false);
  });

  test('picks the shortest interval when multiple polls are registered', async () => {
    installEnv({
      CONTAINER_WORKFLOW: bindingReturning({ status: 'running' }),
      MIGRATION_WORKFLOW: bindingReturning({ status: 'running' }),
    });

    await workflowStatus('container', 'id-1', { poll: '5s' });
    await workflowStatus('migration', 'id-2', { poll: '1s' });

    expect(readPollLocal()).toEqual({ interval: '1s', done: false });
  });

  test('done remains false when any registered poll is still active', async () => {
    installEnv({
      CONTAINER_WORKFLOW: bindingReturning({ status: 'complete' }),
      MIGRATION_WORKFLOW: bindingReturning({ status: 'running' }),
    });

    await workflowStatus('container', 'id-1', { poll: '2s' }); // terminal
    await workflowStatus('migration', 'id-2', { poll: '2s' }); // still running

    expect(readPollLocal()?.done).toBe(false);
  });

  test('registers a terminal poll when no registry is installed', async () => {
    __setWorkflowRegistry({});
    installEnv({});

    const value = await workflowStatus('container' as any, 'id-1', { poll: '2s' });
    expect(value.error).toContain('No workflows are registered');
    expect(readPollLocal()).toEqual({ interval: '2s', done: true });
  });
});
