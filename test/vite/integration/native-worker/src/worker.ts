import { DurableObject } from 'cloudflare:workers';
import { handleRequest } from 'koze:worker';

interface Env {
	COUNTER: DurableObjectNamespace<NativeCounter>;
}

export class NativeCounter extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
	}

	increment(): number {
		this.ctx.storage.sql.exec(`
			INSERT INTO state (key, value) VALUES ('counter', 1)
			ON CONFLICT(key) DO UPDATE SET value = value + 1
		`);
		return this.ctx.storage.sql.exec<{ value: number }>(
			"SELECT value FROM state WHERE key = 'counter'",
		).one().value;
	}

	mark(event: string): void {
		this.ctx.storage.sql.exec(
			'INSERT OR REPLACE INTO state (key, value) VALUES (?, 1)',
			`event:${event}`,
		);
	}

	hasMark(event: string): boolean {
		return this.ctx.storage.sql.exec<{ value: number }>(
			'SELECT value FROM state WHERE key = ?',
			`event:${event}`,
		).toArray().length > 0;
	}

	#internalOnly(): void {}
}

export default {
	fetch: handleRequest,

	async queue(batch, env) {
		await env.COUNTER.getByName('events').mark(`queue:${batch.queue}`);
	},

	async scheduled(controller, env) {
		await env.COUNTER.getByName('events').mark(`scheduled:${controller.cron}`);
	},
} satisfies ExportedHandler<Env>;
