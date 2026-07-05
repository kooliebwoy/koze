/**
 * Runtime stub for `koze:component`.
 *
 * `props<T>()` is wired to the component wrapper's props bag at
 * COMPILE TIME inside `.koze` component files — by the time any
 * code reaches the runtime, no `props()` call survives in component
 * scripts and the `import { props } from 'koze:component'` line
 * has been stripped by the component compiler's
 * `stripTopLevelImports` pass.
 *
 * This file exists only as the resolution target for the
 * `koze:component` virtual module specifier, so module
 * tooling (esbuild, Rollup) has a real file to terminate the
 * resolve chain on. It is never imported at runtime in a correctly
 * built app.
 *
 * The export below is a defensive no-op: if a runtime path ever
 * managed to reach it (e.g. someone builds a non-component file
 * that imports `props` and the import survives stripping for some
 * reason), `props()` returns an empty object so callers get a
 * benign empty bag rather than `TypeError: props is not a function`.
 */

export function props<T = Record<string, unknown>>(): T {
  return {} as T;
}
