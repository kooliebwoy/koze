/**
 * Streaming SSR — async boundary support.
 *
 * Enables templates to declare async data via non-awaited calls:
 *
 *   const todos = getTodos();       // AsyncValue<Todo[]>
 *   if (todos.pending) { <Skeleton /> }
 *   if (todos.error)   { <p>{todos.error}</p> }
 *   if (todos.success) { for (const t of todos) { <Todo /> } }
 *
 * The compiler detects these patterns and, for each, calls:
 *
 *   const todos = await __registerBoundary('todos-1', getTodos(), {
 *     pending: (value) => '<skeleton markup>',
 *     success: (value) => '<resolved markup>',
 *     error:   (value) => '<error markup>',
 *   });
 *
 * `__registerBoundary` returns an AsyncValue synchronously so the rest of the
 * template render proceeds with `.pending=true, .error=null, .success=false`.
 * The promise is tracked in a per-request collector on `locals`. After the
 * render function returns its (synchronous, pending-state) HTML, the dispatcher
 * checks the collector. If empty, it responds with the HTML as a plain string
 * — no streaming overhead. If any boundaries are pending, it:
 *
 *   1. Opens a ReadableStream.
 *   2. Emits the initial HTML, injecting a `<script>$_swap=...</script>`
 *      boot helper near the end of `<body>`.
 *   3. Awaits each boundary promise (in parallel — they've already been fired).
 *   4. On each resolution, streams a `<template id="__ssr_chunk_N">{html}</template><script>$_swap(N)</script>`
 *      fragment. The browser runs `$_swap(N)` synchronously on script parse,
 *      which moves the template's content into the pending-state placeholder
 *      div, replacing the skeleton.
 *   5. Closes the stream once all boundaries have resolved.
 *
 * This is the "out-of-order flush" pattern used by React 18 Suspense SSR,
 * Solid's streaming resources, and every other modern streaming SSR framework.
 * It requires no client-side framework — the `$_swap` helper is ~180 bytes
 * of inline JS, and each chunk is self-contained HTML + one-line script.
 *
 * Safe degradation: if the client has JavaScript disabled, the skeletons sit
 * in place until the stream closes; then `<template>` elements appear inert
 * at the end of the body. The user sees skeletons permanently — acceptable,
 * and the overall HTML is still syntactically valid (templates don't render).
 * If we cared about no-JS users, a later augmented form mode could make the server
 * emit the final resolved HTML inline when it detects `<noscript>` support
 * is desired — out of scope for now.
 */

import { __getLocals } from './context.js';
import {
	type AsyncValue,
	createErrorValue,
	createPendingValue,
	createSuccessValue,
} from './async-value.js';

/**
 * Placeholder HTML emitted for a boundary during the synchronous render.
 * Carries a stable boundary id so the `<script>$_swap(id)</script>` chunk
 * can locate and replace it.
 *
 * The boundary's "pending" branch content is rendered here via the
 * compiler-supplied `renderPending` callback. When the promise resolves,
 * a new `<template>` + `<script>$_swap(id)</script>` is streamed; the client
 * replaces this div's contents with the template's.
 */
export function boundaryPlaceholder(id: string, pendingHtml: string): string {
	return `<div id="__ssr_boundary_${escapeAttr(id)}" data-kuratchi-boundary="${escapeAttr(id)}">${pendingHtml}</div>`;
}

/**
 * Inline bootstrap script injected once per streamed response. The helper
 * replaces a placeholder div's content with the content of a later-streamed
 * `<template>` element. Kept minimal so it ships at ~180 bytes.
 *
 * - Runs synchronously on `<script>` parse, so the chunk-script that calls
 *   `$_swap(id)` always finds `$_swap` defined by the time it runs (the
 *   bootstrap is emitted before any chunks).
 * - No-ops if either the placeholder or the template is missing (defensive
 *   for e.g. a client that filtered out the boundary div).
 * - Removes the consumed `<template>` to keep the DOM clean.
 * - Uses `replaceChildren(...template.content.children)` so event handlers
 *   and nested boundaries inside the chunk remain live. `replaceChildren` is
 *   universally supported (Chrome 86+, Safari 14+, Firefox 78+).
 */
export const BOOTSTRAP_SCRIPT = `<script>window.$_swap=function(i){var b=document.getElementById('__ssr_boundary_'+i),t=document.getElementById('__ssr_chunk_'+i);if(!b||!t)return;b.replaceChildren(...t.content.childNodes);t.remove();};</script>`;

/**
 * Per-request boundary collector. Lives on `locals` (single-threaded worker,
 * one collector per request). Promises are fired at `registerBoundary` time
 * (which means they run in parallel — the author's non-awaited calls already
 * kicked them off) and awaited by the dispatcher after render completes.
 */
export interface PendingBoundary {
	id: string;
	promise: Promise<unknown>;
	renderSuccess: (value: unknown) => string;
	renderError: (message: string) => string;
}

export interface BoundaryCollector {
	boundaries: PendingBoundary[];
	nextId: number;
}

const COLLECTOR_KEY = '__kozeBoundaries';

function getOrCreateCollector(): BoundaryCollector {
	const locals = __getLocals() as Record<string, unknown>;
	const existing = locals[COLLECTOR_KEY] as BoundaryCollector | undefined;
	if (existing) return existing;
	const created: BoundaryCollector = { boundaries: [], nextId: 1 };
	locals[COLLECTOR_KEY] = created;
	return created;
}

/**
 * Read + clear the per-request collector. Called by the dispatcher after
 * render() completes. Returning an empty array signals "no streaming
 * needed — respond with the plain HTML string".
 */
export function __takeCollectedBoundaries(): PendingBoundary[] {
	const locals = __getLocals() as Record<string, unknown>;
	const collector = locals[COLLECTOR_KEY] as BoundaryCollector | undefined;
	if (!collector) return [];
	locals[COLLECTOR_KEY] = undefined;
	return collector.boundaries;
}

/**
 * Called by compiled template code for each async-boundary declaration.
 *
 * Synchronously registers the promise on the per-request collector and
 * returns an `AsyncValue<T>` in `pending` state so the rest of the sync
 * render can proceed with the `.pending` branch.
 *
 * When the dispatcher streams out later, it awaits this promise and emits
 * the result via the supplied `renderSuccess` / `renderError` callbacks
 * (each is a tiny closure compiled from the template's `if (x.success)` /
 * `if (x.error)` branches).
 *
 * The `id` parameter is a compiler-assigned boundary name — typically the
 * variable name plus a counter (e.g. `todos-1`). Stability matters: the
 * placeholder div id and the `<template>` id must match at stream time.
 */
export function __registerBoundary<T>(
	id: string,
	promise: Promise<T>,
	renderSuccess: (value: T) => string,
	renderError: (message: string) => string,
): AsyncValue<T> {
	const collector = getOrCreateCollector();
	collector.boundaries.push({
		id,
		promise: promise as Promise<unknown>,
		renderSuccess: renderSuccess as (value: unknown) => string,
		renderError,
	});
	return createPendingValue<T>();
}

/**
 * Generate a unique boundary id per request. The compiler can pass a
 * human-readable prefix (usually the source variable name); this helper
 * appends a per-request monotonic counter. The resulting id is stable
 * across the placeholder emission and the later chunk emission because
 * both run on the server within the same request.
 */
export function __nextBoundaryId(prefix: string): string {
	const collector = getOrCreateCollector();
	const n = collector.nextId++;
	return `${prefix}-${n}`;
}

/**
 * Build a stream chunk for a resolved boundary. Used by the dispatcher.
 *
 * - `<template id="__ssr_chunk_{id}">`…`</template>` holds the resolved HTML
 *   safely out-of-document (browsers treat template contents as inert).
 * - `<script>$_swap('{id}')</script>` runs synchronously on parse and
 *   moves the template's children into the placeholder div.
 */
export function buildChunk(id: string, html: string): string {
	return `<template id="__ssr_chunk_${escapeAttr(id)}">${html}</template><script>$_swap(${JSON.stringify(id)})</script>`;
}

/**
 * Resolve a collected boundary into its final chunk HTML. Catches rejections
 * and routes them through `renderError`. Never throws — the stream must
 * never break just because one boundary failed.
 */
export async function resolveBoundaryToChunk(b: PendingBoundary): Promise<string> {
	try {
		const value = await b.promise;
		const html = b.renderSuccess(wrapSuccess(value));
		return buildChunk(b.id, html);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const html = b.renderError(message);
		return buildChunk(b.id, html);
	}
}

/**
 * Exported wrappers that keep the compiler's emitted code short. When the
 * template's `renderSuccess` closure is called at stream time, the value
 * is passed in — but the closure's body reads `.success` / `.pending`
 * properties. So we wrap the resolved value into an `AsyncValue` in the
 * success state before passing it in. Same idea for errors.
 *
 * Matching helper used inside the `renderSuccess`/`renderError` closures
 * compiled from `if (x.success) { ... }` blocks to keep property access
 * consistent.
 */
function wrapSuccess<T>(value: T): AsyncValue<T> {
	return createSuccessValue(value);
}

function wrapError<T>(message: string): AsyncValue<T> {
	return createErrorValue<T>(message);
}

export { wrapSuccess as __wrapSuccess, wrapError as __wrapError };

/** Minimal HTML attribute escape — boundary ids are compiler-generated and
 * known-safe (variable names + numbers), but defensive regardless. */
function escapeAttr(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
