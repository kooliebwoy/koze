import { cloudflare } from '@cloudflare/vite-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

import { koze } from '../../../../dist/vite/index.js';

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	plugins: [koze({ security: { contentSecurityPolicy: "default-src 'self'; script-src 'self' 'nonce-{NONCE}'" } }), cloudflare({ viteEnvironment: { name: 'ssr' } })],
});
