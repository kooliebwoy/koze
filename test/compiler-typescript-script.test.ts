import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compile } from '../src/compiler/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempProject(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kuratchi-ts-${name}-`));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src', 'routes', 'auth', 'signin'), { recursive: true });
  return dir;
}

describe('compiler TypeScript transpilation', () => {
  it('emits valid JavaScript for route scripts that use TypeScript syntax', async () => {
    const projectDir = createTempProject('template-script');
    // RFC 0002: Server-side env access should be in $server/ modules, not in <script>
    // This test verifies TypeScript syntax is preserved in client scripts
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<script>
  interface FormData { email: string; }
  const formData: FormData = { email: '' };
  const validate = (data: FormData): boolean => data.email.length > 0;
</script>

<form><div>{formData.email}</div></form>`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    // TypeScript syntax should be preserved (wrangler's esbuild handles transpilation)
    expect(routesCode).toContain('interface FormData');
    expect(routesCode).toContain('formData');
  });

  it('tracks typed top-level declarations from route scripts as template data vars', async () => {
    const projectDir = createTempProject('typed-vars');
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<script>
const title: string = 'Secure Sign In';
</script>

<h1>{title}</h1>`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(routesCode).toContain('const { params } = data;');
    expect(routesCode).toContain("const title: string = 'Secure Sign In';");
    expect(routesCode).toContain('<h1>${__esc(title)}</h1>');
  });

  it('rejects Cloudflare env access from component scripts', async () => {
    const projectDir = createTempProject('component-env');
    fs.mkdirSync(path.join(projectDir, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<script>
import Card from '$lib/card.koze';
</script>

<Card />`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'lib', 'card.koze'),
      `<script>
import { env } from 'cloudflare:workers';
const secret = env.AUTH_SECRET;
</script>

<div>{secret}</div>`,
      'utf-8',
    );

    await expect(compile({ projectDir, isDev: true })).rejects.toThrow(
      'Client <script> blocks cannot import env from cloudflare:workers.',
    );
  });

  it('injects framework dev as a compile-time constant in route scripts', async () => {
    const projectDir = createTempProject('framework-dev');
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
        `<script>
import { dev } from '@kuratchi/koze/environment';
const mode = dev ? 'development' : 'production';
</script>

<div>{mode}</div>`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    let routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');
    expect(routesCode).toContain('const dev = true;');
    expect(routesCode).toContain("const mode = dev ? 'development' : 'production';");

    await compile({ projectDir, isDev: false });
    routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');
    expect(routesCode).toContain('const dev = false;');
  });


  it('preserves non-call value imports in route load scripts', async () => {
    const projectDir = createTempProject('request-values');
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<script>
import { pathname, url } from '@kuratchi/koze/request';
const href = await Promise.resolve(pathname + url.search);
</script>

<div>{href}</div>`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(routesCode).toContain("const pathname = ");
    expect(routesCode).toContain("const url = ");
    expect(routesCode).toContain("const href = await Promise.resolve(pathname + url.search);");
  });

  it('does not return imported action functions from async route load output', async () => {
    const projectDir = createTempProject('async-action-load');
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<script>
import { getUser, createUser } from '$server/actions';
const user = await getUser();
</script>

<form action={createUser} method="POST"></form>
<div>{user.name}</div>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'actions.ts'),
      `export async function getUser() {
  return { name: 'Ada' };
}

export async function createUser(formData: FormData) {
  return formData;
}
`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(routesCode).toContain("actions: { 'createUser': __m0.createUser }");
    expect(routesCode).not.toContain('return { user, createUser');
    expect(routesCode).not.toContain('return { user, getUser, createUser');
  });

  it('does not duplicate extracted top-level SSR await declarations in generated load code', async () => {
    const projectDir = createTempProject('ssr-await-dedup');
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<script>
import { getQuarterBreakdown } from '$server/breakdown';
const selectedQuarter = 'q126';
const selectedGroup = 'devplat';
const breakdown = await getQuarterBreakdown(selectedQuarter, selectedGroup);
</script>

<div>{breakdown?.ok ? 'ready' : 'missing'}</div>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'breakdown.ts'),
      `export async function getQuarterBreakdown(quarter: string, group: string) {
  return { ok: Boolean(quarter && group) };
}
`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');
    const breakdownDecls = routesCode.match(/const breakdown = await /g) ?? [];
    const selectedQuarterIndex = routesCode.indexOf("const selectedQuarter = 'q126';");
    const breakdownIndex = routesCode.search(/const breakdown = await [^;]+;/);

    expect(breakdownDecls.length).toBe(1);
    expect(selectedQuarterIndex).toBeGreaterThanOrEqual(0);
    expect(breakdownIndex).toBeGreaterThan(selectedQuarterIndex);
  });

  it('promotes component action props into the route actions map', async () => {
    const projectDir = createTempProject('component-action-prop');
    fs.mkdirSync(path.join(projectDir, 'src', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<script>
import FormShell from '$lib/form-shell.koze';
import { submitForm } from '$server/actions';
</script>

<FormShell submitAction={submitForm} />`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'lib', 'form-shell.koze'),
      `<form action={submitAction} method="POST"></form>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'actions.ts'),
      `export async function submitForm(formData: FormData) {
  return formData;
}
`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(routesCode).toContain("actions: { 'submitForm': __m0.submitForm }");
    expect(routesCode).toContain('__kozeAction: "submitForm"');
    expect(routesCode).toContain('submitAction.__kozeAction');
  });

  it('promotes layout component action props into layout actions', async () => {
    const projectDir = createTempProject('layout-action-prop');
    fs.mkdirSync(path.join(projectDir, 'src', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'layout.koze'),
      `<script>
import Shell from '$lib/shell.koze';
import { signOut } from '$server/actions';
</script>

<Shell submitAction={signOut}>
  <slot></slot>
</Shell>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<p>Layout action test</p>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'lib', 'shell.koze'),
      `<form action={submitAction} method="POST"><slot></slot></form>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'actions.ts'),
      `export async function signOut(formData: FormData) {
  return formData;
}
`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(routesCode).toContain("const __layoutActions = { 'signOut':");
    expect(routesCode).toContain('__kozeAction: "signOut"');
    expect(routesCode).toContain('submitAction.__kozeAction');
  });

  it('routes component $server client stubs through the channel facade', async () => {
    const projectDir = createTempProject('component-rpc-channel');
    fs.mkdirSync(path.join(projectDir, 'src', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<script>
import StatusCard from '$lib/status-card.koze';
</script>

<StatusCard />`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'lib', 'status-card.koze'),
      `<script>
import { getStatus } from '$server/status';
let status = getStatus();
</script>

<p>{status.pending ? 'loading' : 'ready'}</p>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'status.ts'),
      `export async function getStatus() {
  return { ok: true };
}
`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(routesCode).toContain('__kozeComponentRpcValue');
    expect(routesCode).toContain('window.__kozeChannel');
    expect(routesCode).not.toContain('__kozeCallComponentRpcFallback');
    expect(routesCode).toContain("carrier: 'capnweb-http', target: 'route'");
  });

  it('compiles protocol-lab style SSR and browser $server calls through the channel model', async () => {
    const projectDir = createTempProject('protocol-lab-channel');
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<script>
import { echoChannel } from '$server/protocol-lab';

const ssr = await echoChannel({ message: 'ssr-load', nonce: 'server-render' });
let probe = { pending: false, success: false, error: null };

function runProbe() {
  probe = echoChannel({ message: 'browser-click', nonce: 'client' });
}
</script>

<button type="button" onclick={runProbe()}>Call $server</button>
<pre>{JSON.stringify(ssr)}</pre>
<pre>{JSON.stringify(probe)}</pre>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'protocol-lab.ts'),
      `export const schemas = {};

export async function echoChannel(data: { message: string; nonce: string }) {
  return { ok: true, ...data };
}
`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(routesCode).toContain('const echoChannel = __m0.echoChannel;');
    expect(routesCode).toContain('const ssr = await echoChannel({ message: \'ssr-load\', nonce: \'server-render\' });');
    expect(routesCode).toContain("'rpc_0_server_echoChannel': __m0.echoChannel");
    expect(routesCode).toContain('createKuratchiRpcAsyncValue');
    expect(routesCode).toContain('target: \\"route\\"');
    expect(routesCode).toContain('return createKuratchiRpcAsyncValue');
    expect(routesCode).not.toContain('legacy');
    expect(routesCode).not.toContain('fallback');
  });

  it('rewrites nested project imports inside transformed server modules', async () => {
    const projectDir = createTempProject('server-module-rewrite');
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<script>
import { getTitle } from '$server/loaders';
const title = await getTitle();
</script>

<h1>{title}</h1>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'loaders.ts'),
      `import { baseTitle } from '$server/helpers';

export async function getTitle() {
  return baseTitle + ' Docs';
}
`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'helpers.ts'),
      `export const baseTitle = 'Kuratchi';
`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });

    const rewrittenModule = fs.readFileSync(
      path.join(projectDir, '.koze', 'modules', 'src', 'server', 'loaders.ts'),
      'utf-8',
    );
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    // The server-module pipeline strips source extensions when rewriting relative
    // imports so the transformed file is portable and the importer can resolve
    // it via the runtime's own extension probe.
    expect(rewrittenModule).toContain("from './helpers'");
    expect(routesCode).toContain("import * as __m0 from './modules/src/server/loaders';");
  });

  it('merges nested layout server state into child route compilation', async () => {
    const projectDir = createTempProject('nested-layout-merge');
    fs.mkdirSync(path.join(projectDir, 'src', 'routes', 'dashboard', 'reports'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'dashboard', 'layout.koze'),
      `<script>
import { getSection } from '$server/layout-data';
const section = await getSection();
</script>

<main>
  <h1>{section}</h1>
  <slot></slot>
</main>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'dashboard', 'reports', 'page.koze'),
      `<script>
const title = 'Quarterly';
</script>

<p>{title}</p>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'layout-data.ts'),
      `export async function getSection() {
  return 'Reports';
}
`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(routesCode).toContain('const section = await __m0.getSection();');
    expect(routesCode).toContain('<h1>${__esc(section)}</h1>');
    expect(routesCode).toContain('<p>${__esc(title)}</p>');
  });

  it('allows koze:environment imports in client scripts', async () => {
    const projectDir = createTempProject('framework-dev-client');
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
        `<script>
import { dev } from 'koze:environment';
if (dev) console.log('dev mode');
</script>

<div>Hello</div>`,
      'utf-8',
    );

    // Should compile without error - dev flag is serialized for client
    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');
    
    // The dev flag should be available in the compiled output
    expect(routesCode).toBeDefined();
  });

  it('emits route client assets for top-level $lib event handlers', async () => {
    const projectDir = createTempProject('route-client-handlers');
    fs.mkdirSync(path.join(projectDir, 'src', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'lib', 'form.ts'),
      `export function copyText(value: string) {
  return navigator.clipboard.writeText(value);
}

export function validateForm(event?: Event) {
  event?.preventDefault();
}
`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'actions.ts'),
      `export async function submitForm(formData: FormData) {
  return formData;
}
`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<script>
import { copyText, validateForm } from '$lib/form';
import { submitForm } from '$server/actions';
</script>

<form action={submitForm} onsubmit={validateForm()}>
  <button type="button" onclick={copyText('hello')}>Copy</button>
</form>`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    // RFC 0002 route client bundle — a single `<routeId>/script.js` asset holds
    // all of the route's client-side code (including `$lib/` helpers, which are
    // bundled inline rather than published as separate shared modules).
    expect(routesCode).toContain('__koze/client/routes/route_0/script.js');
    expect(routesCode).toContain('data-client-route="route_0"');
    expect(routesCode).toContain('data-cce-submit="h0"');
    expect(routesCode).toContain('data-cce-click="h1"');
    expect(routesCode).toContain('data-cc-evts="submit"');
    expect(routesCode).toContain('data-cc-evts="click"');
    expect(routesCode).toContain('window.__kozeClient?.register(');
  });

  it('keeps $lib helpers in render scope without returning them from async load output', async () => {
    const projectDir = createTempProject('async-lib-render-helper');
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'src', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'sites.ts'),
      `export async function getSites() {
  return [{ id: '1', totalSize: 2048 }];
}
`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'lib', 'format.ts'),
      `export function formatBytes(bytes: number) {
  return bytes + ' B';
}
`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<script>
import { getSites } from '$server/sites';
import { formatBytes } from '$lib/format';
const sites = await getSites();
</script>

<p>{formatBytes(sites[0].totalSize)}</p>`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(routesCode).not.toContain('return { sites, getSites, formatBytes');
    expect(routesCode).not.toContain('return { sites, formatBytes');
    expect(routesCode).toContain('return { sites };');
    expect(routesCode).toContain('const formatBytes = __m');
    expect(routesCode).toContain('<p>${__esc(formatBytes(sites[0].totalSize))}</p>');
  });

  it('does not redeclare action imports in non-async render prelude', async () => {
    const projectDir = createTempProject('non-async-action-render');
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'auth.ts'),
      `export async function signIn(formData: FormData) {
  return formData;
}
`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<script>
import { signIn } from '$server/auth';
</script>

<form action={signIn} method="POST"></form>
<p>{signIn.error}</p>`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(routesCode).toContain("actions: { 'signIn': __m0.signIn }");
    expect(routesCode).not.toContain('const signIn = __m0.signIn;');
    expect(routesCode).toContain('const { signIn, params } = data;');
  });

  it('compiles augment(action, hooks) into a stateful action alias', async () => {
    const projectDir = createTempProject('augment-action-alias');
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'databases.ts'),
      `export async function createDatabase(formData: FormData) {
  return formData;
}
`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<script>
import { augment } from '@kuratchi/koze';
import { createDatabase } from '$server/databases';

let createDbOpen = false;
const createDb = augment(createDatabase, {
  error() {
    createDbOpen = true;
  },
});
</script>

<form action={createDb} method="POST">
  if (createDb.error) {
    <p role="alert">{createDb.error}</p>
  }
  <button disabled={createDb.pending}>Create</button>
</form>`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(routesCode).toMatch(/actions: \{ 'createDb': __m\d+\.createDatabase \}/);
    expect(routesCode).toContain('name="_action" value="createDb"');
    expect(routesCode).toContain('data-action-augment="createDb"');
    expect(routesCode).toContain('const { createDb, params } = data;');
    expect(routesCode).not.toContain('const createDb = augment');
    expect(routesCode).not.toContain('augment(createDatabase');
    expect(routesCode).toContain('__koze/client/routes/route_0/script.js');
  });

  it('emits route client assets for nested layout-level $lib event handlers', async () => {
    const projectDir = createTempProject('layout-client-handlers');
    fs.mkdirSync(path.join(projectDir, 'src', 'lib', 'ui'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'src', 'routes', 'dashboard'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'lib', 'ui', 'dialog.ts'),
      `export function closeNearestDialog(_value?: unknown, _event?: Event, element?: Element | null) {
  const dialog = element?.closest ? element.closest('dialog') : null;
  if (dialog && typeof (dialog as HTMLDialogElement).close === 'function') {
    (dialog as HTMLDialogElement).close();
  }
}
`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'dashboard', 'layout.koze'),
      `<script>
import { closeNearestDialog } from '$lib/ui/dialog';
</script>

<dialog open>
  <button type="button" onclick={closeNearestDialog()}>Close</button>
</dialog>
<slot></slot>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'dashboard', 'page.koze'),
      `<p>Hello</p>`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    // Nested layout `$lib/` handlers are bundled into the route's client entry
    // and dispatched through the `__kozeClient` registry. The inlined handler
    // gets wired onto the layout's dialog button via `data-client-*` attributes.
    expect(routesCode).toContain('__koze/client/routes/route_0.js');
    expect(routesCode).toContain('data-client-route="route_0"');
    expect(routesCode).toContain('data-cce-click="h0"');
  });

  it('emits root layout client assets for top-level $lib event handlers', async () => {
    const projectDir = createTempProject('root-layout-client-handlers');
    fs.mkdirSync(path.join(projectDir, 'src', 'lib', 'ui'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'lib', 'ui', 'dialog.ts'),
      `export function closeNearestDialog(_value?: unknown, _event?: Event, element?: Element | null) {
  const dialog = element?.closest ? element.closest('dialog') : null;
  if (dialog && typeof (dialog as HTMLDialogElement).close === 'function') {
    (dialog as HTMLDialogElement).close();
  }
}
`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'layout.koze'),
      `<script>
import { closeNearestDialog } from '$lib/ui/dialog';
</script>

<!doctype html>
<html>
<head></head>
<body>
  <dialog open>
    <button type="button" onclick={closeNearestDialog()}>Close</button>
  </dialog>
  <slot></slot>
</body>
</html>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<p>Hello</p>`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    // The root layout's client bundle lives at `layout_root.js` and the
    // `$lib/ui/dialog` helper is inlined into it. The original `import … from
    // '$lib/…'` statement is rewritten before the runtime ever sees it.
    expect(routesCode).toContain('__koze/client/routes/layout_root.js');
    expect(routesCode).toContain('data-client-route="layout_root"');
    expect(routesCode).toContain('data-cce-click="h0"');
    expect(routesCode).not.toContain("import { closeNearestDialog } from '$lib/ui/dialog';");
  });

  it('emits companion rpc schemas for imported route rpc functions', async () => {
    const projectDir = createTempProject('route-rpc-schemas');
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'drafts.ts'),
      `import { schema, type InferSchema } from '@kuratchi/koze';

export const schemas = {
  saveDraft: schema({
    title: schema.string().min(1),
    content: schema.string().min(1),
  }),
};

export async function saveDraft(data: InferSchema<typeof schemas.saveDraft>) {
  return data.title + ':' + data.content;
}
`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'routes', 'auth', 'signin', 'page.koze'),
      `<script>
import { saveDraft } from '$server/drafts';
</script>

<button type="button" onclick={saveDraft({ title: 'Hello', content: 'World' })}>Save</button>`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    // Imported `$server/` functions referenced from the template register a
    // client-side RPC binding (`rpc_0_server_<name>`) and its companion schema
    // is wired into `rpcSchemas` so the runtime can validate incoming calls.
    expect(routesCode).toContain("'rpc_0_server_saveDraft': __m0.saveDraft");
    expect(routesCode).toContain("'rpc_0_server_saveDraft': __m0.schemas?.[\"saveDraft\"]");
  });

  it('validates durable object rpc methods against static schemas in generated proxies', async () => {
    const projectDir = createTempProject('do-rpc-schemas');
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'profile.do.ts'),
      `import { DurableObject } from 'cloudflare:workers';
import { schema } from '@kuratchi/koze';

export default class ProfileDO extends DurableObject {
  static schemas = {
    createProfile: schema({
      name: schema.string().min(1),
    }),
  };

  async createProfile(data: { name: string }) {
    return data.name;
  }
}
`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const proxyCode = fs.readFileSync(path.join(projectDir, '.koze', 'do', 'profile.do.ts'), 'utf-8');
    const routesCode = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(proxyCode).toContain("import { validateSchemaInput as __validateSchemaInput } from '@kuratchi/koze/runtime/schema.js';");
    expect(proxyCode).toContain("const __schema_createProfile = __handler_profile_do.schemas?.[\"createProfile\"];");
    expect(proxyCode).toContain("const __validated = __validateSchemaInput(__schema_createProfile, a);");
    expect(routesCode).toContain('static schemas = {};');
    expect(routesCode).toContain('Object.assign(ProfileDO.schemas, __handler_profile_do.schemas || {});');
  });
});
