import { env, exports as worker } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';

describe('native Koze Worker', () => {
	test('renders a Koze route through the application-owned Worker', async () => {
		const response = await worker.default.fetch(new Request('https://example.com/'));
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('Rendered by Koze inside workerd.');
		const nonce = response.headers.get('Content-Security-Policy')?.match(/'nonce-([^']+)'/)?.[1];
		expect(nonce).toBeTruthy();
		const scripts = html.match(/<script(?:\s[^>]*|)>/g) || [];
		expect(scripts.length).toBeGreaterThan(0);
		for (const script of scripts) expect(script).toContain(`nonce="${nonce}"`);
	});

	test('exports and calls a native Durable Object class', async () => {
		const stub = env.COUNTER.getByName('counter');
		expect(await stub.increment()).toBe(1);
		expect(await stub.increment()).toBe(2);
	});

	test('preserves application-owned non-fetch handlers', async () => {
		await worker.default.queue?.(
			{ queue: 'jobs', messages: [] } as unknown as MessageBatch<unknown>,
			env,
			{} as ExecutionContext,
		);
		expect(await env.COUNTER.getByName('events').hasMark('queue:jobs')).toBe(true);

		await worker.default.scheduled?.(
			{ cron: '*/5 * * * *' } as ScheduledController,
			env,
			{} as ExecutionContext,
		);
		expect(await env.COUNTER.getByName('events').hasMark('scheduled:*/5 * * * *')).toBe(true);
	});
});
