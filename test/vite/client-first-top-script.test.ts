import { afterEach, describe, expect, test } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { kuratchi } from '../../src/vite/index.js';

function createTempProject(name: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kuratchi-vite-${name}-`));
	fs.mkdirSync(path.join(dir, 'src', 'routes'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'src', 'server'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'src', 'worker.ts'), 'export { default } from "koze:worker";\n', 'utf-8');
	return dir;
}

function leadingHash(filePath: string): string {
	const source = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
	return crypto.createHash('sha1').update('leading:' + filePath + '\0' + source).digest('hex').slice(0, 12);
}

function routeHash(filePath: string): string {
	return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 10);
}

type MinimalResolvedConfig = {
	root: string;
	command: 'serve' | 'build';
	environments: {
		client: {
			build: {
				rollupOptions: {
					input: Record<string, string>;
				};
			};
		};
	};
};

async function setupPlugin(projectDir: string, command: 'serve' | 'build' = 'serve') {
	const plugin = kuratchi()[0];
	const config: MinimalResolvedConfig = {
		root: projectDir,
		command,
		environments: {
			client: {
				build: {
					rollupOptions: {
						input: {},
					},
				},
			},
		},
	};
	if (typeof plugin.configResolved === 'function') {
		await (plugin.configResolved as unknown as (config: MinimalResolvedConfig) => Promise<void> | void)(config);
	}
	const load = plugin.load;
	const handleHotUpdate = plugin.handleHotUpdate;
	if (typeof load !== 'function') throw new Error('Expected kuratchi plugin load hook');
	if (typeof handleHotUpdate !== 'function') throw new Error('Expected kuratchi plugin hot update hook');
	const ctx = {
		addWatchFile(_file: string) {},
	};
	return {
		load: (id: string) => load.call(ctx as never, id),
		handleHotUpdate,
	};
}

describe('koze/vite client-first leading script emit', () => {
	const projectDirs: string[] = [];

	afterEach(() => {
		for (const dir of projectDirs.splice(0)) {
			if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('injects reactive runtime into app shell output', async () => {
		const projectDir = createTempProject('app-reactive-runtime');
		projectDirs.push(projectDir);
		fs.writeFileSync(
			path.join(projectDir, 'src', 'app.koze'),
			`<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body><slot></slot></body>
</html>`,
			'utf-8',
		);
		fs.writeFileSync(path.join(projectDir, 'src', 'routes', 'page.koze'), '<div>Hello</div>', 'utf-8');

		const plugin = await setupPlugin(projectDir);
		const appModule = await plugin.load('\0koze:app');

		expect(appModule).toContain('__kozeReactive = { __version: runtimeVersion, state, effect, replace, scope, mount, renderer };');
	});

	test('preserves document script tags in app shell head', async () => {
		const projectDir = createTempProject('app-head-document-script');
		projectDirs.push(projectDir);
		fs.writeFileSync(
			path.join(projectDir, 'src', 'app.koze'),
			`<!DOCTYPE html>
<html>
<head>
	<title>CDN</title>
	<script defer src="https://cdn.example.com/widget.js"></script>
</head>
<body><slot></slot></body>
</html>`,
			'utf-8',
		);
		fs.writeFileSync(path.join(projectDir, 'src', 'routes', 'page.koze'), '<div>Hello</div>', 'utf-8');

		const plugin = await setupPlugin(projectDir);
		const appModule = await plugin.load('\0koze:app');

		expect(appModule).toContain('<script defer src="https://cdn.example.com/widget.js"></script>');
	});

	test('leaves API route source modules to Vite instead of self-reexporting', async () => {
		const projectDir = createTempProject('api-route-source-pass-through');
		projectDirs.push(projectDir);
		const apiPath = path.join(projectDir, 'src', 'routes', 'api', 'v1', 'health.ts');
		fs.mkdirSync(path.dirname(apiPath), { recursive: true });
		fs.writeFileSync(
			apiPath,
			`export function GET() {
	return Response.json({ ok: true });
}
`,
			'utf-8',
		);

		const plugin = await setupPlugin(projectDir);
		const routeModule = await plugin.load(`\0koze:route/${routeHash(apiPath)}`);
		const sourceModule = await plugin.load(apiPath);

		expect(routeModule).toBe(`export * from ${JSON.stringify(apiPath)};`);
		expect(sourceModule).toBeNull();
	});

	test('preserves named catch-all params in the route manifest', async () => {
		const projectDir = createTempProject('named-catch-all-route');
		projectDirs.push(projectDir);
		const pagePath = path.join(projectDir, 'src', 'routes', 'docs', '[pkg]', '[...slug]', 'index.koze');
		const apiPath = path.join(projectDir, 'src', 'routes', 'api', 'files', '[...path].ts');
		fs.mkdirSync(path.dirname(pagePath), { recursive: true });
		fs.mkdirSync(path.dirname(apiPath), { recursive: true });
		fs.writeFileSync(pagePath, '<main>Doc</main>', 'utf-8');
		fs.writeFileSync(apiPath, 'export function GET() { return new Response("ok"); }\n', 'utf-8');

		const plugin = await setupPlugin(projectDir);
		const routesModule = await plugin.load('\0koze:routes');

		expect(routesModule).toContain('{ pattern: "/docs/:pkg/*slug"');
		expect(routesModule).toContain('{ pattern: "/api/files/*path"');
		expect(routesModule).toContain('"paramName":"slug"');
		expect(routesModule).toContain('"paramName":"path"');
	});

	test('uses production transforms for build-mode client fragments and app runtime', async () => {
		const projectDir = createTempProject('production-client-fragment');
		projectDirs.push(projectDir);
		const routePath = path.join(projectDir, 'src', 'routes', 'page.koze');
		fs.writeFileSync(
			path.join(projectDir, 'src', 'app.koze'),
			`<!DOCTYPE html>
<html>
<head><title>Prod</title></head>
<body><slot></slot></body>
</html>`,
			'utf-8',
		);
		fs.writeFileSync(
			routePath,
			`<script>
import { dev } from 'koze:environment';
let count = 0;
$: label = dev ? 'dev' : 'prod';
</script>
<button>{label}: {count}</button>`,
			'utf-8',
		);

		const plugin = await setupPlugin(projectDir, 'build');
		const appModule = await plugin.load('\0koze:app');
		const fragment = await plugin.load(`virtual:koze-client/${leadingHash(routePath)}.ts`);

		expect(appModule).toContain('__version:runtimeVersion,state,effect,replace,scope,mount,renderer');
		expect(appModule).not.toContain('__kozeReactive = { state, effect, replace, scope, mount, renderer };');
		expect(fragment).toContain('const dev = false;');
		expect(fragment).not.toContain('const dev = true;');
		expect(fragment).toContain("__k$.effect(() => { __kState.label = dev ? 'dev' : 'prod'; });");
	});

	test('rewrites leading route script for client hydration and reactive runtime usage', async () => {
		const projectDir = createTempProject('leading-client-fragment');
		projectDirs.push(projectDir);
		const routePath = path.join(projectDir, 'src', 'routes', 'page.koze');
		fs.writeFileSync(
			routePath,
			`<script>
import { getData } from '$server/api';
let state = { count: 0 };
const data = await getData();
$: console.log(state.count, data);
</script>
<div>{data}</div>`,
			'utf-8',
		);
		fs.writeFileSync(
			path.join(projectDir, 'src', 'server', 'api.ts'),
			`import { env } from 'cloudflare:workers';

export async function getData() {
  return env.SECRET_TOKEN;
}
`,
			'utf-8',
		);

		const plugin = await setupPlugin(projectDir);
		const fragment = await plugin.load(`virtual:koze-client/${leadingHash(routePath)}.ts`);

		expect(fragment).toContain('const __k$ = window.__kozeReactive;');
		expect(fragment).toContain('const __kState = __k$.state({});');
		expect(fragment).toContain('__kState.state = { count: 0 };');
		expect(fragment).toContain('__k$.effect(() => { console.log(__kState.state.count, data); });');
		expect(fragment).toContain('const data = __kozeReadData("data");');
	});

	test('strips route load() and Cloudflare env imports from browser fragments', async () => {
		const projectDir = createTempProject('leading-client-load-env-strip');
		projectDirs.push(projectDir);
		const routePath = path.join(projectDir, 'src', 'routes', 'page.koze');
		fs.writeFileSync(
			routePath,
			`<script>
import { env } from 'cloudflare:workers';
import { dev } from 'koze:environment';

export async function load() {
	return {
		turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
	};
}

let clicked = false;
function markClicked() {
	clicked = true;
}
</script>
<button onClick={markClicked}>{dev ? 'dev' : turnstileSiteKey}</button>`,
			'utf-8',
		);

		const plugin = await setupPlugin(projectDir);
		const fragment = await plugin.load(`virtual:koze-client/${leadingHash(routePath)}.ts`);

		expect(fragment).not.toContain('cloudflare:workers');
		expect(fragment).not.toContain('function load');
		expect(fragment).not.toContain('TURNSTILE_SITE_KEY');
		expect(fragment).toContain('const dev = true;');
		expect(fragment).toContain('function markClicked()');
	});

	test('supports derived reactive aliases without a separate top-level let declaration', async () => {
		const projectDir = createTempProject('leading-derived-alias');
		projectDirs.push(projectDir);
		const routePath = path.join(projectDir, 'src', 'routes', 'page.koze');
		fs.writeFileSync(
			routePath,
			`<script>
let selected = 'x';
$: showDetails = selected === 'x';
</script>
if (showDetails) {
	<p>Visible</p>
}`,
			'utf-8',
		);

		const plugin = await setupPlugin(projectDir);
		const fragment = await plugin.load(`virtual:koze-client/${leadingHash(routePath)}.ts`);

		expect(fragment).toContain('__kState.showDetails = undefined;');
		expect(fragment).toContain("__k$.effect(() => { __kState.showDetails = __kState.selected === 'x'; });");
		expect(fragment).toContain('get(){ return __kState.showDetails; }');
	});

	test('emits the shared bridge before state-augmented form client fragments', async () => {
		const projectDir = createTempProject('state-augment-bridge');
		projectDirs.push(projectDir);
		const routePath = path.join(projectDir, 'src', 'routes', 'page.koze');
		fs.writeFileSync(
			path.join(projectDir, 'src', 'server', 'databases.ts'),
			`export async function createDatabase() {
  return null;
}
`,
			'utf-8',
		);
		fs.writeFileSync(
			routePath,
			`<script>
import { augment } from '@kuratchi/koze';
import { createDatabase } from '$server/databases';

const createDb = augment(createDatabase);
</script>
<form action={createDb} method="POST">
  <button disabled={createDb.pending}>Create</button>
</form>`,
			'utf-8',
		);

		const plugin = await setupPlugin(projectDir);
		const routeModule = await plugin.load(`\0koze:route/${routeHash(routePath)}`);
		const fragment = await plugin.load(`virtual:koze-client/${leadingHash(routePath)}.ts`);
		const bridge = await plugin.load('virtual:koze-client/bridge.ts');

		expect(routeModule).toContain('resolveClientAsset("bridge")');
		expect(routeModule).toContain('data-action-augment="createDb"');
		expect(fragment).toContain('window.__kozeAugment("createDb", "createDatabase"');
		expect(bridge).toContain('window.__kozeAugment');
		expect(bridge).toContain("document.addEventListener('submit'");
		expect(bridge).toContain("headers.accept = 'application/json'");
	});

	test('rewrites browser navigation imports in state-augmented action hooks', async () => {
		const projectDir = createTempProject('state-augment-navigation');
		projectDirs.push(projectDir);
		const routePath = path.join(projectDir, 'src', 'routes', 'page.koze');
		fs.writeFileSync(
			path.join(projectDir, 'src', 'server', 'databases.ts'),
			`export async function createDatabase() {
  return null;
}
`,
			'utf-8',
		);
		fs.writeFileSync(
			routePath,
			`<script>
import { augment } from '@kuratchi/koze';
import { navigateTo } from 'koze:navigation';
import { createDatabase } from '$server/databases';

const createDb = augment(createDatabase, {
  success(result) {
    navigateTo(result.redirectTo || '/databases', { replace: true });
  },
});
</script>
<form action={createDb} method="POST">
  <button disabled={createDb.pending}>Create</button>
</form>`,
			'utf-8',
		);

		const plugin = await setupPlugin(projectDir);
		await plugin.load(`\0koze:route/${routeHash(routePath)}`);
		const fragment = await plugin.load(`virtual:koze-client/${leadingHash(routePath)}.ts`);

		expect(fragment).toContain('from "@kuratchi/koze/runtime/navigation.js"');
		expect(fragment).not.toContain('koze:navigation');
		expect(fragment).toContain("navigateTo(result.redirectTo || '/databases', { replace: true });");
		expect(fragment).toContain('window.__kozeAugment("createDb", "createDatabase"');
	});

	test('client augment renderers can render imported components inside state blocks', async () => {
		const projectDir = createTempProject('state-augment-components');
		projectDirs.push(projectDir);
		fs.mkdirSync(path.join(projectDir, 'src', 'lib'), { recursive: true });
		const routePath = path.join(projectDir, 'src', 'routes', 'page.koze');
		fs.writeFileSync(
			path.join(projectDir, 'src', 'lib', 'alert.koze'),
			`<script>
import { props } from 'koze:component';
</script>
<div class="alert" data-variant={props.data_variant}><slot></slot></div>`,
			'utf-8',
		);
		fs.writeFileSync(
			path.join(projectDir, 'src', 'lib', 'loading.koze'),
			`<script>
import { props } from 'koze:component';
</script>
<span class="loader" data-size={props.size}></span>`,
			'utf-8',
		);
		fs.writeFileSync(
			path.join(projectDir, 'src', 'server', 'databases.ts'),
			`export async function createDatabase() {
  return null;
}
`,
			'utf-8',
		);
		fs.writeFileSync(
			routePath,
			`<script>
import { augment } from '@kuratchi/koze';
import { createDatabase } from '$server/databases';
import Alert from '$lib/alert.koze';
import Loading from '$lib/loading.koze';

const createDb = augment(createDatabase);
</script>
if (createDb.success) {
  <Alert data-variant="success">Database created.</Alert>
}
<form action={createDb} method="POST">
  if (createDb.error) {
    <Alert data-variant="danger">{createDb.error}</Alert>
  }
  <button disabled={createDb.pending}>
    if (createDb.pending) {
      <Loading size="sm" />
      <span>Creating...</span>
    } else {
      <span>Create</span>
    }
  </button>
</form>`,
			'utf-8',
		);

		const plugin = await setupPlugin(projectDir);
		const fragment = await plugin.load(`virtual:koze-client/${leadingHash(routePath)}.ts`);

		expect(fragment).toContain('function __c_alert');
		expect(fragment).toContain('function __c_loading');
		expect(fragment).toContain('Object.defineProperty(__kScopeValues, "__c_alert"');
		expect(fragment).toContain('Object.defineProperty(__kScopeValues, "__c_loading"');
		expect(fragment).toContain('__c_alert({ data_variant: \\"success\\"');
		expect(fragment).toContain('__c_alert({ data_variant: \\"danger\\"');
		expect(fragment).toContain('__c_loading({ size: \\"sm\\"');
		expect(fragment).not.toContain('<Alert');
		expect(fragment).not.toContain('<Loading');
	});

	test('exposes server RPC stubs to local template event expressions', async () => {
		const projectDir = createTempProject('rpc-local-event-scope');
		projectDirs.push(projectDir);
		const routePath = path.join(projectDir, 'src', 'routes', 'page.koze');
		fs.writeFileSync(
			path.join(projectDir, 'src', 'server', 'api.ts'),
			`export async function slowRpcSuccess() {
  return { ok: true };
}
`,
			'utf-8',
		);
		fs.writeFileSync(
			routePath,
			`<script>
import { slowRpcSuccess } from '$server/api';

let rpcOk = null;

function boolText(value) {
  return value ? 'true' : 'false';
}
</script>
<button onClick={rpcOk = slowRpcSuccess()}>Run RPC</button>
<p>{boolText(rpcOk?.pending)}</p>`,
			'utf-8',
		);

		const plugin = await setupPlugin(projectDir);
		const routeModule = await plugin.load(`\0koze:route/${routeHash(routePath)}`);
		const hash = leadingHash(routePath);
		const fragment = await plugin.load(`virtual:koze-client/${hash}.ts`);

		expect(routeModule).toContain('data-k-on-click');
		expect(routeModule).toContain(`data-k-owner="${hash}"`);
		expect(routeModule).toContain('rpcOk = slowRpcSuccess()');
		expect(fragment).toContain('__kState.rpcOk = null;');
		expect(fragment).toContain('Object.defineProperty(__kScopeValues, "rpcOk"');
		expect(fragment).toContain('Object.defineProperty(__kScopeValues, "boolText"');
		expect(fragment).toContain('Object.defineProperty(__kScopeValues, "slowRpcSuccess"');
		expect(fragment).toContain(`, ${JSON.stringify(hash)});`);
	});

	test('emits RPC stubs as thenable async-values with invalidation dispatch', async () => {
		const projectDir = createTempProject('rpc-stub-contract');
		projectDirs.push(projectDir);
		fs.writeFileSync(path.join(projectDir, 'src', 'routes', 'page.koze'), '<div>Hello</div>', 'utf-8');
		fs.writeFileSync(
			path.join(projectDir, 'src', 'server', 'api.ts'),
			`export async function getData() {
  return 'hello';
}
`,
			'utf-8',
		);

		const plugin = await setupPlugin(projectDir);
		const rpcModule = await plugin.load('virtual:kuratchi-rpc/api.ts');

		expect(rpcModule).toContain(`import { createKuratchiRpcAsyncValue } from '@kuratchi/koze/runtime/channel.js';`);
		expect(rpcModule).toContain(`return createKuratchiRpcAsyncValue({ carrier: 'capnweb-http', target: 'server', op: rpcId, args });`);
		expect(rpcModule).toContain('export function getData(...args) {');
		expect(rpcModule).not.toContain('cloudflare:workers');
		expect(rpcModule).not.toContain('SECRET_TOKEN');
	});

	test('synthesizes RPC-safe Durable Object exports from .do.ts classes', async () => {
		const projectDir = createTempProject('worker-do-export');
		projectDirs.push(projectDir);
		fs.writeFileSync(path.join(projectDir, 'src', 'routes', 'page.koze'), '<div>Hello</div>', 'utf-8');
		fs.writeFileSync(
			path.join(projectDir, 'src', 'server', 'org-auth.do.ts'),
			`import { DurableObject } from 'cloudflare:workers';

export default class OrgAuth extends DurableObject {
  static binding = 'ORG_DB';

  async createUser(input) {
    return input;
  }

  async alarm() {
    return null;
  }

  webSocketMessage() {
    return null;
  }

  private async hiddenMethod() {
    return null;
  }
}
`,
			'utf-8',
		);

		const plugin = await setupPlugin(projectDir);
		const workerModule = await plugin.load('\0koze:worker');

		expect(workerModule).toContain('export class OrgAuth extends __KozeDurableObject');
		expect(workerModule).toContain('createUser(...args)');
		expect(workerModule).toContain('alarm(...args)');
		expect(workerModule).toContain('webSocketMessage(...args)');
		expect(workerModule).not.toContain('hiddenMethod(...args)');
	});

	test('rejects plural worker convention suffixes during Vite config', async () => {
		const projectDir = createTempProject('plural-worker-convention');
		projectDirs.push(projectDir);
		fs.mkdirSync(path.join(projectDir, 'src', 'server', 'ai'), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, 'src', 'server', 'ai', 'session.agents.ts'),
			`export class SessionAgent {}\n`,
			'utf-8',
		);

		await expect(setupPlugin(projectDir)).rejects.toThrow(
			'use "session.agent.ts" instead of "session.agents.ts"',
		);
	});

	test('rejects template-body scripts instead of extracting hidden fragments', async () => {
		const projectDir = createTempProject('reject-body-script');
		projectDirs.push(projectDir);
		const routePath = path.join(projectDir, 'src', 'routes', 'page.koze');
		fs.writeFileSync(
			routePath,
			`<main>Body</main>
<script type="module">
import { boot } from '$lib/boot';
boot();
</script>`,
			'utf-8',
		);

		const plugin = await setupPlugin(projectDir);
		await expect(plugin.load(`\0koze:route/${routeHash(routePath)}`)).rejects.toThrow(
			'Only one top-level <script> block is allowed',
		);
	});

	test('refreshes cached client fragments and forces a browser reload on route edits', async () => {
		const projectDir = createTempProject('hmr-fragment-refresh');
		projectDirs.push(projectDir);
		const routePath = path.join(projectDir, 'src', 'routes', 'page.koze');
		fs.writeFileSync(
			routePath,
			`<script>
const message = 'before';
console.log(message);
</script>
<div>{message}</div>`,
			'utf-8',
		);

		const plugin = await setupPlugin(projectDir);
		const fragmentId = `virtual:koze-client/${leadingHash(routePath)}.ts`;
		const routeModuleId = `\0koze:route/${routeHash(routePath)}`;
		await plugin.load(routeModuleId);

		const before = await plugin.load(fragmentId);
		expect(before).toContain(`'before'`);

		fs.writeFileSync(
			routePath,
			`<script>
const message = 'after';
console.log(message);
</script>
<div>{message}</div>`,
			'utf-8',
		);

		const nextFragmentId = `virtual:koze-client/${leadingHash(routePath)}.ts`;
		const fragmentModule = { id: fragmentId };
		const nextFragmentModule = { id: nextFragmentId };
		const routeModule = { id: routeModuleId };
		const invalidated: string[] = [];
		const sent: Array<{ type: string }> = [];
		const updated = await plugin.handleHotUpdate({
			file: routePath,
			modules: [],
			server: {
				moduleGraph: {
					getModuleById(id: string) {
						if (id === fragmentId) return fragmentModule;
						if (id === nextFragmentId) return nextFragmentModule;
						if (id === routeModuleId) return routeModule;
						return undefined;
					},
					invalidateModule(mod: { id: string }) {
						invalidated.push(mod.id);
					},
				},
				ws: {
					send(payload: { type: string }) {
						sent.push(payload);
					},
				},
			},
		} as never);

		expect(invalidated).toContain(routeModuleId);
		expect(invalidated).toContain(fragmentId);
		expect(invalidated).toContain(nextFragmentId);
		expect(updated).toContain(routeModule);
		expect(updated).toContain(fragmentModule);
		expect(updated).toContain(nextFragmentModule);
		expect(sent).toEqual([{ type: 'full-reload' }]);

		const after = await plugin.load(nextFragmentId);
		expect(after).toContain(`'after'`);
		expect(after).not.toContain(`'before'`);
	});

	test('invalidates the route manifest for route file creation and removal', async () => {
		const projectDir = createTempProject('hmr-route-structure');
		projectDirs.push(projectDir);
		const baseRoutePath = path.join(projectDir, 'src', 'routes', 'page.koze');
		const oldRouteDir = path.join(projectDir, 'src', 'routes', 'old');
		const oldRoutePath = path.join(oldRouteDir, 'page.koze');
		const newRouteDir = path.join(projectDir, 'src', 'routes', 'new');
		const newRoutePath = path.join(newRouteDir, 'page.koze');
		fs.mkdirSync(oldRouteDir, { recursive: true });
		fs.writeFileSync(baseRoutePath, '<main>Base</main>', 'utf-8');
		fs.writeFileSync(
			oldRoutePath,
			`<script>
const message = 'old';
</script>
<main>{message}</main>`,
			'utf-8',
		);

		const plugin = await setupPlugin(projectDir);
		const manifestModule = { id: '\0koze:routes' };
		const oldRouteModule = { id: `\0koze:route/${routeHash(oldRoutePath)}` };
		const oldFragmentModule = { id: `virtual:koze-client/${leadingHash(oldRoutePath)}.ts` };
		const invalidated: string[] = [];
		const sent: Array<{ type: string }> = [];
		const moduleById = new Map<string, { id: string }>([
			[manifestModule.id, manifestModule],
			[oldRouteModule.id, oldRouteModule],
			[oldFragmentModule.id, oldFragmentModule],
		]);
		const server = {
			moduleGraph: {
				getModuleById(id: string) {
					return moduleById.get(id);
				},
				invalidateModule(mod: { id: string }) {
					invalidated.push(mod.id);
				},
			},
			ws: {
				send(payload: { type: string }) {
					sent.push(payload);
				},
			},
		};

		fs.rmSync(oldRoutePath);
		const removed = await plugin.handleHotUpdate({
			file: oldRoutePath,
			modules: [],
			server,
		} as never);

		expect(invalidated).toContain(manifestModule.id);
		expect(invalidated).toContain(oldRouteModule.id);
		expect(invalidated).toContain(oldFragmentModule.id);
		expect(removed).toEqual([oldRouteModule, oldFragmentModule]);
		expect(sent).toEqual([{ type: 'full-reload' }]);

		invalidated.length = 0;
		sent.length = 0;
		fs.mkdirSync(newRouteDir, { recursive: true });
		fs.writeFileSync(
			newRoutePath,
			`<script>
const message = 'new';
</script>
<main>{message}</main>`,
			'utf-8',
		);
		const newFragmentModule = { id: `virtual:koze-client/${leadingHash(newRoutePath)}.ts` };
		moduleById.set(newFragmentModule.id, newFragmentModule);

		const created = await plugin.handleHotUpdate({
			file: newRoutePath,
			modules: [],
			server,
		} as never);

		expect(invalidated).toContain(manifestModule.id);
		expect(invalidated).toContain(newFragmentModule.id);
		expect(created).toEqual([newFragmentModule]);
		expect(sent).toEqual([{ type: 'full-reload' }]);
	});
});
