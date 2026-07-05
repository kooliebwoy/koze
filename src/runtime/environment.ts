/**
 * Environment module for koze:environment virtual import.
 *
 * Provides compile-time environment flags that are set by the framework.
 * The `dev` flag is true during development builds and false in production.
 *
 * Usage in server code (middleware.ts, .do.ts, etc.):
 * ```ts
 * import { dev } from 'koze:environment';
 *
 * if (dev) {
 *   // Skip auth checks, enable debug logging, etc.
 * }
 * ```
 */

declare const globalThis: {
  __koze_DEV__?: boolean;
};

/**
 * True during `vite dev`, false in production builds.
 * This is a compile-time constant set by the framework.
 */
export const dev: boolean = globalThis.__koze_DEV__ === true;
