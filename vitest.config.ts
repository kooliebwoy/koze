/**
 * Vitest config for `koze`.
 *
 * The compiler/parser/runtime-helper tests are pure Node code — they
 * write temp directories with `node:fs`, run `compile()` synchronously,
 * and assert against generated source strings. They do not need a
 * `workerd` isolate, so they run in the default Node pool for speed.
 *
 * If a future test needs to execute generated Worker output inside the
 * Cloudflare runtime, add a second project here using
 * `@cloudflare/vitest-pool-workers` (installed in `koze/vite`,
 * which is the natural home for plugin-output integration tests).
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		setupFiles: ['./test/setup.ts'],
	},
});
