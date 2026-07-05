/**
 * Live workflow status (koze:workflow).
 *
 * Fetches the status of a discovered Cloudflare Workflow by its convention name
 * (derived from the `*.workflow.ts` filename, e.g. `container.workflow.ts` → `'container'`).
 *
 * Usage (route top-level <script>):
 *   import { workflowStatus } from 'koze:workflow';
 *   const status = await workflowStatus('container', id, { poll: '2s' });
 *
 * When `{ poll }` is provided, the framework registers polling metadata for the
 * current request. After the route renders, the runtime injects a client-side
 * directive that re-fetches the whole route body on the given interval, so every
 * `status.*` reference in the template stays current.
 *
 * Polling stops automatically when `until(status)` returns true (default:
 * `status.status === 'complete' | 'errored' | 'terminated'`).
 */

import { AsyncValue, createErrorValue, createSuccessValue } from './async-value.js';
import { __getLocals, getEnv } from './context.js';

export type WorkflowStatusValue = {
  status: string;
  output?: unknown;
  error?: unknown;
  [key: string]: any;
};

export interface WorkflowStatusOptions<T = WorkflowStatusValue> {
  /** Polling interval: `'2s'`, `'500ms'`, `'1m'`. Enables live refresh. */
  poll?: string | number;
  /**
   * Stop polling when this predicate returns true. Evaluated server-side after each
   * status fetch. Default: status is `'complete'`, `'errored'`, or `'terminated'`.
   */
  until?: (value: T) => boolean;
}

interface WorkflowRegistryEntry {
  /** Env binding name for the workflow (e.g. `CONTAINER_WORKFLOW`). */
  binding: string;
}

const DEFAULT_UNTIL = (value: WorkflowStatusValue): boolean => {
  const s = value?.status;
  return s === 'complete' || s === 'completed' || s === 'errored' || s === 'terminated';
};

let __registry: Record<string, WorkflowRegistryEntry> | null = null;

/** Internal: populated by the compiler-generated routes module. */
export function __setWorkflowRegistry(registry: Record<string, WorkflowRegistryEntry>): void {
  __registry = registry;
}

/** Internal: list known workflow names (for diagnostics). */
function __knownWorkflowNames(): string[] {
  return __registry ? Object.keys(__registry) : [];
}

function __registerPoll(interval: string | number, done: boolean): void {
  const locals = __getLocals();
  const existing = locals.__kozePoll as
    | { interval: string | number; done: boolean }
    | undefined;
  if (!existing) {
    locals.__kozePoll = { interval, done };
    return;
  }
  existing.interval = __shorterInterval(existing.interval, interval);
  existing.done = existing.done && done;
}

function __toMs(v: string | number): number {
  if (typeof v === 'number') return v > 0 ? v : 30000;
  const m = String(v).match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!m) return 30000;
  const n = parseFloat(m[1]);
  const u = (m[2] || 's').toLowerCase();
  if (u === 'ms') return n;
  if (u === 'm') return n * 60000;
  return n * 1000;
}

function __shorterInterval(a: string | number, b: string | number): string | number {
  return __toMs(a) <= __toMs(b) ? a : b;
}

/**
 * Fetch the current status of a workflow instance.
 *
 * Returns a resolved `AsyncValue` with `.pending=false`, `.error`, `.success` and
 * the workflow's own `status`, `output`, etc. When `{ poll }` is passed, the route
 * re-renders on the interval until `until(status)` is true.
 *
 * @example
 *   const status = await workflowStatus('container', params.id, { poll: '2s' });
 *   if (status.error) { ... } else { status.status }
 */
export async function workflowStatus<T extends WorkflowStatusValue = WorkflowStatusValue>(
  name: string,
  instanceId: string,
  options?: WorkflowStatusOptions<T>,
): Promise<AsyncValue<T>> {
  if (!__registry || Object.keys(__registry).length === 0) {
    // No workflows discovered in this project
    const msg = 'No workflows are registered for this project (did you add src/server/*.workflow.ts?)';
    if (options?.poll) __registerPoll(options.poll, true);
    return createErrorValue<T>(msg);
  }
  const entry = __registry[name];
  if (!entry) {
    const known = __knownWorkflowNames().join(', ') || '(none)';
    const msg = `Unknown workflow '${name}'. Known workflows: ${known}`;
    if (options?.poll) __registerPoll(options.poll, true);
    return createErrorValue<T>(msg);
  }

  if (!instanceId) {
    if (options?.poll) __registerPoll(options.poll, true);
    return createErrorValue<T>('Missing instanceId');
  }

  const env = getEnv<Record<string, any>>();
  const binding = env?.[entry.binding];
  if (!binding || typeof binding.get !== 'function') {
    const msg = `Workflow binding '${entry.binding}' is not available in env`;
    if (options?.poll) __registerPoll(options.poll, true);
    return createErrorValue<T>(msg);
  }

  try {
    const instance = await binding.get(instanceId);
    const raw = (await instance.status()) as T;
    const value = createSuccessValue<T>(raw);
    if (options?.poll) {
      const until = options.until ?? (DEFAULT_UNTIL as unknown as (v: T) => boolean);
      let terminal = false;
      try { terminal = !!until(raw); } catch { terminal = false; }
      __registerPoll(options.poll, terminal);
    }
    return value;
  } catch (err: any) {
    // Binding `.get()` throws when the instance does not exist (yet). This is
    // a legitimate, transient state whenever the caller queues workflow
    // creations behind a serializing producer (e.g. a Cloudflare Queue with
    // `max_concurrency: 1`). Marking the poll as terminal here would freeze
    // the UI on the first render and only a manual refresh would recover.
    // Instead we surface the error value but keep the client poll alive, so
    // the route re-renders automatically once the workflow actually exists.
    if (options?.poll) __registerPoll(options.poll, false);
    const msg = err?.message || 'Failed to load workflow status';
    return createErrorValue<T>(msg);
  }
}
