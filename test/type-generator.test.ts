import { afterEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { generateAppTypes } from '../src/compiler/type-generator.js';

const TYPECHECK_TIMEOUT_MS = 15_000;

function createTempProject(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kuratchi-types-${name}-`));
  fs.mkdirSync(path.join(dir, 'src', 'server'), { recursive: true });
  return dir;
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function typecheck(files: string[], options: ts.CompilerOptions = {}): ts.Diagnostic[] {
  const program = ts.createProgram(files, {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    ...options,
  });
  return ts.getPreEmitDiagnostics(program);
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file || diagnostic.start == null) return message;
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${path.basename(diagnostic.file.fileName)}:${position.line + 1}:${position.character + 1} ${message}`;
}

describe('type generator', () => {
  const projectDirs: string[] = [];

  afterEach(() => {
    for (const dir of projectDirs.splice(0)) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('generated app.d.ts type-checks Kuratchi virtual modules and app locals', () => {
    const projectDir = createTempProject('virtual-contract');
    projectDirs.push(projectDir);
    write(path.join(projectDir, 'src', 'server', 'billing-sync.workflow.ts'), 'export default {};\n');
    write(path.join(projectDir, 'src', 'content', 'docs', 'getting-started.md'), '# Getting started\n');

    const appTypes = generateAppTypes({
      projectDir,
      localsInterface: `    interface Locals {
      userId: number;
      userEmail: string;
    }`,
    });
    const appTypesPath = path.join(projectDir, 'src', 'app.d.ts');
    const usagePath = path.join(projectDir, 'src', 'usage.ts');
    write(appTypesPath, appTypes);
    write(
      usagePath,
      `import { locals, params } from 'koze:request';
import { navigateTo } from 'koze:navigation';
import { props } from 'koze:component';
import { user } from 'koze:access';
import { workflowStatus } from 'koze:workflow';
import { content } from 'koze:content';

const userId: number = locals.userId;
const email: string = locals.userEmail;
const slug: string | undefined = params.slug;
const title: string = props<{ title: string }>().title;
const accessEmail: string = user().email;
navigateTo('/dashboard', { replace: true });

async function inspectWorkflow() {
  const status = await workflowStatus('billing-sync', 'run-1', {
    poll: '1s',
    until: (value) => value.status === 'complete',
  });
  const pending: boolean = status.pending;
  const success: boolean = status.success;
  const error: string | null = status.error;
  return { pending, success, error, slug, title, accessEmail, userId, email };
}

async function inspectContent() {
  const docs = await content.docs.list();
  const doc = await content.docs.render('getting-started');
  const firstTitle: string | undefined = docs[0]?.title;
  const html: string | undefined = doc?.html;
  return { firstTitle, html };
}

// @ts-expect-error unknown workflow names must not type-check
workflowStatus('missing-workflow', 'run-1');

// @ts-expect-error locals preserve the app-provided number type
const badUserId: string = locals.userId;

// @ts-expect-error unknown content names must not type-check
content.missing.list();
`,
    );

    const diagnostics = typecheck([appTypesPath, usagePath]);

    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  }, TYPECHECK_TIMEOUT_MS);

  test('generated table row types are visible under App from schema.ts', () => {
    const projectDir = createTempProject('schema-contract');
    projectDirs.push(projectDir);
    write(
      path.join(projectDir, 'src', 'server', 'schema.ts'),
      `export const schema = {
  tables: {
    users: {
      id: 'integer not null',
      email: 'text not null',
      bio: 'text',
    },
  },
};
`,
    );
    const appTypesPath = path.join(projectDir, 'src', 'app.d.ts');
    const usagePath = path.join(projectDir, 'src', 'schema-usage.ts');
    write(appTypesPath, generateAppTypes({ projectDir }));
    write(
      usagePath,
      `const row: App.UsersRow = {
  id: 1,
  email: 'user@example.com',
};

const id: number = row.id;
const bio: string | undefined = row.bio;

// @ts-expect-error id is generated from integer as number
const badId: string = row.id;
`,
    );

    const diagnostics = typecheck([appTypesPath, usagePath]);

    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  }, TYPECHECK_TIMEOUT_MS);

  test('generated app.d.ts types $server imports as RPC async values', () => {
    const projectDir = createTempProject('server-rpc-contract');
    projectDirs.push(projectDir);
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const serverFile = path.join(projectDir, 'src', 'server', 'account.ts');
    const appTypesPath = path.join(projectDir, 'src', 'app.d.ts');
    const usagePath = path.join(projectDir, 'src', 'server-rpc-usage.ts');
    write(
      serverFile,
      `export type ServerOnlyType = { hidden: true };

export async function getUser(id: string) {
  return { id, name: 'Ada' };
}

export const currentTenant = {
  id: 'org_1',
  name: 'Core',
};

export default function signOut(reason?: string) {
  return { ok: true as const, reason };
}
`,
    );
    write(
      path.join(projectDir, 'src', 'server', 'activity-log.pipeline.ts'),
      `export const pipeline = 'activity_log';
export const schema = { id: 'string!' };
`,
    );
    write(appTypesPath, generateAppTypes({ projectDir }));
    expect(fs.readFileSync(appTypesPath, 'utf-8')).not.toContain("$server/activity-log.pipeline");
    write(
      usagePath,
      `import signOut, { currentTenant, getUser } from '$server/account';

const user = getUser('user_1');
const pending: boolean = user.pending;
const success: boolean = user.success;
const error: string | null = user.error;
const id: string = user.id;
const name: string = user.name;

const tenant = currentTenant();
const tenantId: string = tenant.id;
const tenantName: string = tenant.name;

async function run() {
  const resolvedUser = await user;
  const resolvedName: string = resolvedUser.name;
  const signedOut = await signOut('manual');
  const ok: true = signedOut.ok;
  return { resolvedName, ok };
}

// @ts-expect-error getUser preserves the server function parameter type
getUser(123);

// @ts-expect-error RPC async value preserves the resolved field type
const badName: number = user.name;

void pending;
void success;
void error;
void id;
void name;
void tenantId;
void tenantName;
void run;
`,
    );

    const diagnostics = typecheck([appTypesPath, serverFile, usagePath], {
      baseUrl: packageRoot,
      paths: {
        '@kuratchi/koze/runtime/channel.js': ['src/runtime/channel.ts'],
      },
    });

    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  }, TYPECHECK_TIMEOUT_MS);

  test('runtime route module contracts preserve app Env across load, actions, rpc, and api routes', () => {
    const projectDir = createTempProject('route-contract');
    projectDirs.push(projectDir);
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const usagePath = path.join(projectDir, 'src', 'route-contract.ts');
    write(
      usagePath,
      `import type {
  ActionContext,
  ApiRouteModule,
  AppConfig,
  RouteContext,
  RouteModule,
} from '@kuratchi/koze/runtime/types.js';

declare global {
  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }
}

type Statement = {
  bind(...values: unknown[]): Statement;
  first<T = unknown>(): Promise<T | null>;
};

type AppEnv = {
  DB: {
    prepare(sql: string): Statement;
  };
  BUCKET: {
    get(key: string): Promise<Response | null>;
  };
};

const load = async (ctx: RouteContext<AppEnv>) => {
  const slug: string | undefined = ctx.params.slug;
  const userId = ctx.locals.userId as number | undefined;
  const statement: Statement = ctx.env.DB.prepare('select * from items where slug = ?').bind(slug);

  // @ts-expect-error app Env binding type must not collapse to string
  const badDb: string = ctx.env.DB;

  return { slug, userId, statement };
};

const nativeSave = async (ctx: ActionContext<AppEnv>) => {
  const title = ctx.formData.get('title');
  const method: string = ctx.request.method;
  const pathname: string = ctx.url.pathname;
  ctx.env.DB.prepare('insert into items(title) values (?)').bind(title);
  return { method, pathname };
};

const positionalSave = async (id: string, ctx: ActionContext<AppEnv>) => {
  ctx.env.DB.prepare('update items set slug = ? where id = ?').bind(ctx.params.slug, id);
  return { id };
};

const pageRoute: RouteModule<AppEnv> = {
  pattern: '/items/:slug',
  load,
  actions: {
    nativeSave,
    positionalSave,
  },
  rpc: {
    getItem: async (args, env, ctx) => {
      const id = String(args[0]);
      const slug: string | undefined = ctx.params.slug;
      const item = await env.DB.prepare('select * from items where id = ?').bind(id).first<{ title: string }>();
      return { item, slug };
    },
  },
  render: (data) => ({ html: String(data.slug), head: '<title>Item</title>' }),
};

const apiRoute: ApiRouteModule<AppEnv> = {
  __api: true,
  pattern: '/api/items/:slug',
  GET: async (ctx) => {
    const response = await ctx.env.BUCKET.get(ctx.params.slug);
    return response ?? new Response('missing', { status: 404 });
  },
  POST: (ctx) => {
    ctx.env.DB.prepare('insert into api_logs(slug) values (?)').bind(ctx.params.slug);
    return new Response('ok');
  },
};

const app: AppConfig<AppEnv> = {
  routes: [pageRoute, apiRoute],
};

const invalidRoute: RouteModule<AppEnv> = {
  pattern: '/invalid',
  // @ts-expect-error load context must use the route Env type
  load: (ctx: RouteContext<{ OTHER: string }>) => ({ other: ctx.env.OTHER }),
  render: () => '',
};

void app;
void invalidRoute;
`,
    );

    const diagnostics = typecheck([usagePath], {
      baseUrl: packageRoot,
      paths: {
        '@kuratchi/koze/runtime/types.js': ['src/runtime/types.ts'],
      },
    });

    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  }, TYPECHECK_TIMEOUT_MS);

  test('runtime channel RPC values expose typed async state', () => {
    const projectDir = createTempProject('channel-contract');
    projectDirs.push(projectDir);
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const usagePath = path.join(projectDir, 'src', 'channel-usage.ts');
    write(
      usagePath,
      `import {
  createKuratchiRpcAsyncValue,
  type KuratchiBrowserChannelGlobal,
} from '@kuratchi/koze/runtime/channel.js';
import type { ThenableAsyncValue } from '@kuratchi/koze/runtime/async-value.js';

type Todo = { title: string };

const value = createKuratchiRpcAsyncValue<Todo[]>({ op: 'todos' });
const pending: boolean = value.pending;
const success: boolean = value.success;
const error: string | null = value.error;
const firstTitle: string | undefined = value[0]?.title;
const thenable: PromiseLike<Todo[]> = value;

const channel: KuratchiBrowserChannelGlobal = {
  invoke: async <T>() => [{ title: 'typed' }] as T,
  createRpcValue: <T>() => value as unknown as ThenableAsyncValue<T>,
};

const channelValue = channel.createRpcValue<Todo[]>({ op: 'todos' });
const channelPending: boolean = channelValue.pending;
const channelFirstTitle: string | undefined = channelValue[0]?.title;

// @ts-expect-error pending is boolean, not string
const badPending: string = value.pending;

// @ts-expect-error channel facade keeps the generic result type
const badTitle: number | undefined = channelValue[0]?.title;

void pending;
void success;
void error;
void firstTitle;
void thenable;
void channelPending;
void channelFirstTitle;
`,
    );

    const diagnostics = typecheck([usagePath], {
      baseUrl: packageRoot,
      paths: {
        '@kuratchi/koze/runtime/channel.js': ['src/runtime/channel.ts'],
        '@kuratchi/koze/runtime/async-value.js': ['src/runtime/async-value.ts'],
      },
    });

    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  }, TYPECHECK_TIMEOUT_MS);
});
