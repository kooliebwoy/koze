/**
 * Covers the action-dispatch calling convention documented in
 * `src/runtime/invoke-action.js` (and used by `handleAction` in
 * `dispatch.js`), surfaced to app authors via
 * `apps/docs/framework/actions.mdx`.
 *
 * The contract is `fn(...positionalArgs, context)`:
 *   - `<form action={save}>` → `save({ formData, request, url, params })`
 *   - `<button onclick={deleteItem(id)}>` →
 *     `deleteItem(id, { formData, request, url, params })`
 *
 * The exact shape has regressed once already (see the April 2026
 * incident where the dispatcher briefly shipped
 * `fn(...spreadArgs, formData)`, which dropped `request` / `url` /
 * `params` from the handler signature and broke every destructured
 * `{ formData }` action in downstream apps). These tests lock the
 * contract in place so the same mistake isn't made twice.
 *
 * `invokeAction` is the pure core of `handleAction` — it takes an
 * already-parsed set of inputs and applies the calling convention. This
 * lets us exercise every shape without standing up a Miniflare worker
 * just to POST a form.
 */

// @ts-expect-error — invoke-action.js is plain JS without a type declaration.
import { invokeAction } from '../../src/vite/runtime/invoke-action.js';
import { describe, expect, test } from 'vitest';

/** Build a fresh fixture each test so mutations don't leak between cases. */
function fixture(overrides: {
	spreadArgs?: unknown[];
	formData?: FormData;
	request?: Request;
	url?: URL;
	params?: Record<string, string>;
} = {}) {
	return {
		spreadArgs: overrides.spreadArgs ?? [],
		formData: overrides.formData ?? new FormData(),
		request: overrides.request ?? new Request('https://app.example.com/items'),
		url: overrides.url ?? new URL('https://app.example.com/items'),
		params: overrides.params ?? {},
	};
}

describe('invokeAction calling convention', () => {
	test('form submission: handler receives only the context object', async () => {
		// Captures the argv so we can assert on shape without brittle
		// equality checks against `Request` / `URL` identity.
		let received: unknown[] | undefined;
		const save = (...argv: unknown[]) => {
			received = argv;
			return { ok: true };
		};

		const fd = new FormData();
		fd.append('title', 'hello');
		const result = await invokeAction(save, fixture({ formData: fd }));

		expect(result).toEqual({ ok: true });
		expect(received).toBeDefined();
		expect(received!.length).toBe(1);

		const ctx = received![0] as Record<string, unknown>;
		expect(ctx).toBeInstanceOf(Object);
		expect(ctx.formData).toBeInstanceOf(FormData);
		expect((ctx.formData as FormData).get('title')).toBe('hello');
		expect(ctx.request).toBeInstanceOf(Request);
		expect(ctx.url).toBeInstanceOf(URL);
		expect(ctx.params).toEqual({});
	});

	test('form submission: destructured handler signature works', async () => {
		// Mirrors the canonical app-side pattern documented in
		// `actions.mdx`: `async function save({ formData })`.
		async function save({ formData }: { formData: FormData }) {
			return formData.get('title');
		}

		const fd = new FormData();
		fd.append('title', 'destructured');
		const result = await invokeAction(save, fixture({ formData: fd }));

		expect(result).toBe('destructured');
	});

	test('button with one positional arg: handler receives (arg, ctx)', async () => {
		// The canonical button-triggered shape — this is the case that
		// prompted the invocation-convention refactor in the first place.
		async function deleteItem(id: number, { formData }: { formData: FormData }) {
			return { id, hasFormData: formData instanceof FormData };
		}

		const result = await invokeAction(deleteItem, fixture({ spreadArgs: [123] }));

		expect(result).toEqual({ id: 123, hasFormData: true });
	});

	test('button with multiple positional args: order matches call site', async () => {
		// `<button onclick={move(item.id, 'done')}>` → `move(item.id, 'done', ctx)`.
		async function move(
			id: number,
			target: string,
			{ formData }: { formData: FormData },
		) {
			return { id, target, formDataIsEmpty: Array.from(formData.keys()).length === 0 };
		}

		const result = await invokeAction(move, fixture({ spreadArgs: [42, 'done'] }));

		expect(result).toEqual({ id: 42, target: 'done', formDataIsEmpty: true });
	});

	test('handler can reach request / url / params via context', async () => {
		// Guards the regression where an earlier draft of the dispatcher
		// replaced the context object with raw FormData, making `request`
		// / `url` / `params` unreachable without global helpers.
		type Ctx = {
			request: Request;
			url: URL;
			params: Record<string, string>;
			formData: FormData;
		};
		async function whoami(ctx: Ctx) {
			return {
				method: ctx.request.method,
				path: ctx.url.pathname,
				id: ctx.params.id,
			};
		}

		const url = new URL('https://app.example.com/items/42?_action=whoami');
		const request = new Request(url, { method: 'POST' });

		const result = await invokeAction(
			whoami,
			fixture({ request, url, params: { id: '42' } }),
		);

		expect(result).toEqual({ method: 'POST', path: '/items/42', id: '42' });
	});

	test('form handlers that ignore context still work', async () => {
		// Documented escape hatch: drop the parameter entirely when you
		// don't need anything from the request. Common for one-shot
		// utility actions.
		let called = false;
		async function ping() {
			called = true;
			return 'pong';
		}

		const result = await invokeAction(ping, fixture());

		expect(called).toBe(true);
		expect(result).toBe('pong');
	});

	test('button handlers that ignore context still work', async () => {
		async function deleteItem(id: number) {
			return `deleted ${id}`;
		}

		const result = await invokeAction(deleteItem, fixture({ spreadArgs: [7] }));

		expect(result).toBe('deleted 7');
	});

	test('context is the trailing argument, never inserted between positionals', async () => {
		// Sanity check against accidentally injecting ctx at the wrong
		// position (e.g. `fn(ctx, ...args)`). The order matters because
		// app code relies on `args[0]` being the first positional at the
		// call site, not the context object.
		const argv: unknown[] = [];
		const capture = (...received: unknown[]) => {
			argv.push(...received);
			return null;
		};

		await invokeAction(capture, fixture({ spreadArgs: ['first', 'second', 'third'] }));

		expect(argv.length).toBe(4);
		expect(argv[0]).toBe('first');
		expect(argv[1]).toBe('second');
		expect(argv[2]).toBe('third');
		expect(argv[3]).toBeInstanceOf(Object);
		expect((argv[3] as { formData: unknown }).formData).toBeInstanceOf(FormData);
	});

	test('handler errors propagate to the caller unchanged', async () => {
		// `handleAction` has its own catch block around `invokeAction` for
		// redirect-error unwrapping etc. This test just locks in that
		// `invokeAction` itself doesn't swallow or wrap errors.
		class SentinelError extends Error {
			constructor() {
				super('sentinel');
				this.name = 'SentinelError';
			}
		}

		async function boom() {
			throw new SentinelError();
		}

		await expect(invokeAction(boom, fixture())).rejects.toBeInstanceOf(SentinelError);
	});

	test('handler return value is returned verbatim (sync)', async () => {
		// Allow non-async handlers. `handleAction` `await`s the result
		// anyway, so a plain return is fine.
		const handler = () => 'sync-value';
		const result = await invokeAction(handler, fixture());
		expect(result).toBe('sync-value');
	});

	test('handler return value is returned verbatim (async)', async () => {
		const handler = async () => Promise.resolve({ async: true });
		const result = await invokeAction(handler, fixture());
		expect(result).toEqual({ async: true });
	});
});
