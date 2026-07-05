/**
 * AsyncValue - A wrapper for async operations that provides state metadata.
 * 
 * When you call an async function without `await`, it returns an AsyncValue<T>
 * that extends T with `.pending`, `.error`, and `.success` properties.
 * 
 * Usage:
 *   const todos = getTodos();  // AsyncValue<Todo[]>
 *   if (todos.pending) { <Skeleton /> }
 *   if (todos.error) { <Error>{todos.error}</Error> }
 *   for (const todo of todos) { <TodoItem todo={todo} /> }
 * 
 *   const todos = await getTodos();  // Todo[] - blocks until resolved
 */

export interface AsyncValueState {
  /** True while the async operation is in progress */
  pending: boolean;
  /** Error message if the operation failed, null otherwise */
  error: string | null;
  /** True when the operation completed successfully */
  success: boolean;
}

/**
 * AsyncValue<T> extends T with async state metadata.
 * The value is directly accessible (no .data wrapper needed).
 */
export type AsyncValue<T> = T & AsyncValueState;

export type ThenableAsyncValue<T> = AsyncValue<T> & PromiseLike<T> & {
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult>;
  finally(onfinally?: (() => void) | null): Promise<T>;
};

/**
 * Create an AsyncValue in pending state.
 * For arrays, returns an empty array with state metadata.
 * For objects, returns an empty object with state metadata.
 */
export function createPendingValue<T>(): AsyncValue<T> {
  const base = {} as Record<string, unknown>;
  base.pending = true;
  base.error = null;
  base.success = false;
  return base as AsyncValue<T>;
}

/**
 * Create an AsyncValue in success state with the resolved value.
 */
export function createSuccessValue<T>(value: T): AsyncValue<T> {
  if (value === null || value === undefined) {
    const base = {} as Record<string, unknown>;
    base.pending = false;
    base.error = null;
    base.success = true;
    return base as AsyncValue<T>;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    obj.pending = false;
    obj.error = null;
    obj.success = true;
    return obj as AsyncValue<T>;
  }
  // For primitives, wrap in an object-like structure that preserves the value
  const wrapper = Object(value) as Record<string, unknown>;
  wrapper.pending = false;
  wrapper.error = null;
  wrapper.success = true;
  return wrapper as AsyncValue<T>;
}

/**
 * Create an AsyncValue in error state.
 */
export function createErrorValue<T>(errorMessage: string): AsyncValue<T> {
  const base = {} as Record<string, unknown>;
  base.pending = false;
  base.error = errorMessage;
  base.success = false;
  return base as AsyncValue<T>;
}

function clearResolvedFields(target: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    if (key === 'pending' || key === 'error' || key === 'success') continue;
    delete target[key];
  }
}

function applyResolvedValue<T>(target: Record<string, unknown>, value: T): void {
  clearResolvedFields(target);
  if (value !== null && value !== undefined && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) target[key] = entry;
    if (Array.isArray(value)) {
      target.length = value.length;
      for (let i = 0; i < value.length; i++) target[i] = value[i];
    }
    const proto = Object.getPrototypeOf(record);
    if (proto && Object.getPrototypeOf(target) !== proto) {
      try {
        Object.setPrototypeOf(target, proto);
      } catch {
        // Ignore prototype assignment failures in constrained runtimes.
      }
    }
  }
  target.pending = false;
  target.error = null;
  target.success = true;
}

function applyRejectedValue(target: Record<string, unknown>, errorMessage: string): void {
  clearResolvedFields(target);
  target.pending = false;
  target.error = errorMessage;
  target.success = false;
}

export function createThenableAsyncValue<T>(
  promise: Promise<T>,
  opts?: {
    onSuccess?: (value: T) => void;
    onError?: (errorMessage: string) => void;
  },
): ThenableAsyncValue<T> {
  const target = createPendingValue<T>() as ThenableAsyncValue<T> & Record<string, unknown>;
  const chained = promise.then(
    (value) => {
      applyResolvedValue(target, value);
      opts?.onSuccess?.(value);
      return value;
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      applyRejectedValue(target, message);
      opts?.onError?.(message);
      throw (err instanceof Error ? err : new Error(message));
    },
  );

  Object.defineProperties(target, {
    then: {
      value: chained.then.bind(chained),
      enumerable: false,
    },
    catch: {
      value: chained.catch.bind(chained),
      enumerable: false,
    },
    finally: {
      value: chained.finally.bind(chained),
      enumerable: false,
    },
  });

  return target;
}

/**
 * Parse a human-readable interval string to milliseconds.
 * Supports: '2s', '500ms', '1m'
 */
export function parseInterval(str: string): number {
  if (!str) return 30000;
  const match = str.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i);
  if (!match) return 30000;
  const num = parseFloat(match[1]);
  const unit = (match[2] || 's').toLowerCase();
  if (unit === 'ms') return num;
  if (unit === 'm') return num * 60000;
  return num * 1000;
}

/**
 * Server-side async value wrapper for SSR. Resolves the promise and returns
 * either a success or error `AsyncValue`.
 */
export async function wrapAsyncValue<T>(promise: Promise<T>): Promise<AsyncValue<T>> {
  try {
    const value = await promise;
    return createSuccessValue(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return createErrorValue<T>(message);
  }
}

/**
 * Type guard to check if a value is an AsyncValue
 */
export function isAsyncValue<T>(value: unknown): value is AsyncValue<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'pending' in value &&
    'error' in value &&
    'success' in value
  );
}
