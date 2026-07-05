/**
 * Middleware extension system
 */

import type { Env, MiddlewareDefinition, RuntimeDefinition } from './types.js';

export function defineMiddleware<E extends Env = Env>(middleware: MiddlewareDefinition<E>): MiddlewareDefinition<E> {
  return middleware;
}

/** @deprecated Use defineMiddleware() */
export function defineRuntime<E extends Env = Env>(runtime: RuntimeDefinition<E>): RuntimeDefinition<E> {
  return runtime;
}
