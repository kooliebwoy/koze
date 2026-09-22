/**
 * Middleware extension system
 */

import type { Env, MiddlewareDefinition } from './types.js';

export function defineMiddleware<E extends Env = Env>(middleware: MiddlewareDefinition<E>): MiddlewareDefinition<E> {
  return middleware;
}
