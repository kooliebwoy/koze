import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { koze } from './dist/vite/index.js';

const fixtureRoot = fileURLToPath(new URL('./test/vite/integration/native-worker/', import.meta.url));

export default defineConfig({
	root: fixtureRoot,
	plugins: [
		koze(),
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
		}),
	],
	test: {
		include: ['native-worker.test.ts'],
	},
});
