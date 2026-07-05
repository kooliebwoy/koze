/**
 * `kuratchi create <project-name>` â€” scaffold a new Koze project
 *
 * Interactive prompts for feature selection, then generates
 * a ready-to-run project with the selected stack.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';

// Runtime/framework package: always `@kuratchi/koze`. Hardcoded so the
// scaffolder doesn't accidentally read the caller's `package.json`
// name and emit imports against the WRONG package (e.g. when invoked
// via `bun create kuratchi`, where the caller is `create-kuratchi`).
const FRAMEWORK_PACKAGE_NAME = '@kuratchi/koze';
const UI_PACKAGE_NAME = '@kuratchi/kuzan';
const ORM_PACKAGE_NAME = '@kuratchi/kunii';
const AUTH_PACKAGE_NAME = '@kuratchi/kyzen';

// â”€â”€ Prompt Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultVal = ''): Promise<string> {
  const suffix = defaultVal ? ` (${defaultVal})` : '';
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  return new Promise((resolve) => {
    rl.question(`  ${question} (${hint}): `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (!a) return resolve(defaultYes);
      resolve(a === 'y' || a === 'yes');
    });
  });
}

// â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface ScaffoldOptions {
  name: string;
  ui: boolean;
  auth: boolean;
  orm: boolean;
  do: boolean;
  monorepo: boolean;
  /** Absolute path to monorepo root (null if not in a monorepo) */
  monorepoRoot: string | null;
  /** Absolute path to the project directory */
  projectDir: string;
}

export async function create(projectName?: string, flags: string[] = []) {
  const autoYes = flags.includes('--yes') || flags.includes('-y');
  const forceDO = flags.includes('--do');

  console.log('\n⚡ Create a new Koze project\n');

  // Project name
  const name = projectName || (autoYes ? 'my-kuratchi-app' : await ask('Project name', 'my-kuratchi-app'));

  // Validate name
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    console.error('  âœ— Project name must be lowercase alphanumeric with hyphens');
    process.exit(1);
  }

  const targetDir = path.resolve(process.cwd(), name);
  if (fs.existsSync(targetDir)) {
    console.error(`  âœ— Directory "${name}" already exists`);
    process.exit(1);
  }

  // Feature selection
  const ui = autoYes ? true : await confirm('Include kuzan theme?');
  const orm = autoYes ? true : await confirm('Include kunii with D1?');
  const enableDO = forceDO || (autoYes ? false : await confirm('Include Durable Objects (SQLite-backed DO)?', false));
  const effectiveOrm = orm || enableDO;
  const auth = autoYes ? true : (effectiveOrm ? await confirm('Include kyzen (credentials login)?') : false);

  if (enableDO && !orm) {
    console.log('  ℹ DO uses kunii internally — enabling ORM.');
  }
  if (auth && !effectiveOrm) {
    console.log('  â„¹ Auth requires ORM â€” enabling ORM automatically');
  }

  console.log();
  console.log(`  Project:  ${name}`);
  console.log(`  Template: vite (koze() + cloudflare() plugins)`);
  console.log(`  UI:       ${ui ? 'âœ“' : 'â€”'}`);
  console.log(`  D1 ORM:   ${orm ? 'âœ“' : 'â€”'}`);
  console.log(`  DO:       ${enableDO ? 'âœ“' : 'â€”'}`);
  console.log(`  Auth:     ${auth ? 'âœ“' : 'â€”'}`);
  console.log();

  if (!autoYes) {
    const ok = await confirm('Create project?');
    if (!ok) {
      console.log('  Cancelled.');
      rl.close();
      process.exit(0);
    }
  }

  rl.close();

  // Detect monorepo â€” if we're inside a workspace with packages/koze, use workspace:*
  const monorepoRoot = detectMonorepo(targetDir);
  const isMonorepo = !!monorepoRoot;

  const opts: ScaffoldOptions = {
    name,
    ui,
    orm,
    do: enableDO,
    auth,
    monorepo: isMonorepo,
    monorepoRoot,
    projectDir: targetDir,
  };
  scaffoldVite(targetDir, opts);

  // â”€â”€ Post-scaffold setup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log();

  // 1. Install dependencies
  step('Installing dependencies...');
  run('bun install', isMonorepo ? monorepoRoot! : targetDir);

  // 2. Create D1 database (local only for now)
  if (orm) {
    step('Creating D1 database...');
    try {
      const output = run(`npx wrangler d1 create ${name}-db`, targetDir);
      // Parse database_id from wrangler output
      const idMatch = output.match(/database_id\s*=\s*"([^"]+)"/);
      if (idMatch) {
        const dbId = idMatch[1];
        patchWranglerDbId(targetDir, dbId);
        step(`D1 database created: ${dbId}`);
      }
    } catch {
      // D1 create may fail if not logged in â€” that's fine for local dev
      step('D1 create skipped (not logged in to Cloudflare â€” local dev still works)');
    }
  }

  // 3. Generate worker types
  step('Generating types...');
  try {
    run('npx wrangler types', targetDir);
  } catch {
    // May fail without D1 â€” not critical
  }

  // 4. No upfront build. `bun run dev` spins up `vite dev`, which
  // compiles routes on demand. `bun run build` runs `vite build` +
  // `wrangler deploy`. Skipping a prebuild keeps `create` fast.
  step('Vite template ready — no prebuild needed.');

  console.log();
  console.log(`  âœ“ Project ready at ./${name}`);
  console.log();
  console.log('  Get started:');
  console.log(`    cd ${name}`);
  console.log('    bun run dev');
  console.log();
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function step(msg: string) {
  console.log(`  â–¸ ${msg}`);
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' });
  } catch (err: any) {
    // Return stderr/stdout even on failure for parsing
    if (err.stdout) return err.stdout;
    throw err;
  }
}

function detectMonorepo(targetDir: string): string | null {
  // Walk up from target to find a workspace root with packages/koze
  let dir = path.dirname(targetDir);
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'packages', 'koze', 'package.json'))) {
      return isWorkspaceMemberTarget(dir, targetDir) ? dir : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isWorkspaceMemberTarget(rootDir: string, targetDir: string): boolean {
  const packageJsonPath = path.join(rootDir, 'package.json');
  let workspaces: unknown = [];
  try {
    workspaces = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')).workspaces;
  } catch {
    return false;
  }

  const patterns: unknown[] = Array.isArray(workspaces)
    ? workspaces
    : Array.isArray((workspaces as any)?.packages)
      ? (workspaces as any).packages
      : [];

  const relativeTarget = path.relative(rootDir, targetDir).replace(/\\/g, '/');
  if (!relativeTarget || relativeTarget.startsWith('../')) return false;

  return patterns.some((pattern) => {
    if (typeof pattern !== 'string') return false;
    const normalized = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized.endsWith('/*')) return relativeTarget === normalized;
    const prefix = normalized.slice(0, -2);
    if (!relativeTarget.startsWith(`${prefix}/`)) return false;
    const rest = relativeTarget.slice(prefix.length + 1);
    return rest.length > 0 && !rest.includes('/');
  });
}

function patchWranglerDbId(dir: string, dbId: string) {
  const wranglerPath = path.join(dir, 'wrangler.jsonc');
  let content = fs.readFileSync(wranglerPath, 'utf-8');
  content = content.replace('"local-dev-only"', `"${dbId}"`);
  fs.writeFileSync(wranglerPath, content, 'utf-8');
}

function write(dir: string, filePath: string, content: string) {
  const full = path.join(dir, filePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  console.log(`  + ${filePath}`);
}

// â”€â”€ Template Generators â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Generate `src/middleware.ts`. Auth, ORM auto-migration, and app-level
 * concerns wire here as middleware steps — explicit, composable, and
 * visible at the call site.
 */
function genMiddleware(opts: ScaffoldOptions): string {
  const lines: string[] = [];
  lines.push(`import { defineMiddleware } from 'koze:middleware';`);

  if (opts.orm) {
    lines.push(`import { autoMigrate } from '@kuratchi/kunii';`);
    lines.push(`import { appSchema } from './schemas/app';`);
  }
  if (opts.auth) {
    lines.push(`import { kyzenAuthMiddleware } from '@kuratchi/kyzen/middleware';`);
    lines.push(`import { kyzenAuthConfig } from '@kuratchi/kyzen/adapter';`);
  }

  lines.push('');
  lines.push('/**');
  lines.push(' * Request middleware. Each step can hook into:');
  lines.push(' *   - `request(ctx, next)` — before routing');
  lines.push(' *   - `route(ctx, next)`   — after routing, before render');
  lines.push(' *   - `response(ctx, res)` — after render');
  lines.push(' *   - `error(ctx, err)`    — on thrown errors');
  lines.push(' *');
  lines.push(' * Steps run in the order defined here. Mutate `ctx.locals` to share');
  lines.push(' * data with `$server/*` modules and route actions.');
  lines.push(' */');
  lines.push('export default defineMiddleware({');

  if (opts.orm) {
    lines.push('  // Auto-migrate the D1 database on cold start. Idempotent — runs once');
    lines.push('  // per worker isolate. Comment out if you manage migrations via CI.');
    lines.push('  migrate: autoMigrate({ DB: appSchema }),');
    lines.push('');
  }

  if (opts.auth) {
    lines.push('  // Auth — credentials, sessions, guards. Add `oauth`, `rateLimit`,');
    lines.push('  // `turnstile`, etc. to the config to enable additional subsystems.');
    lines.push('  auth: kyzenAuthMiddleware(kyzenAuthConfig({');
    lines.push("    cookieName: 'kyzen_session',");
    lines.push('    sessionEnabled: true,');
    if (opts.orm) {
      lines.push("    credentials: { binding: 'DB' },");
    }
    lines.push('  })),');
    lines.push('');
  }

  lines.push('  // Add your own steps here:');
  lines.push('  //   logging: { request(ctx, next) { ... } }');
  lines.push('});');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate `src/app.css` for projects with the `kuzan` theme.
 * Auto-discovered by `koze/vite` and inlined into the app shell.
 */
function genAppCss(): string {
  return `/**
 * Global stylesheet. Auto-discovered by \`koze/vite\` (drop-in
 * convention — same as SvelteKit's \`src/app.css\`).
 */

@import '@kuratchi/kuzan/styles/theme.css';
`;
}

// ── Durable Object templates ──────────────────────────────────────────────────

function genNotesSchema(): string {
  return `import type { SchemaDsl } from '@kuratchi/kunii';

export const notesSchema: SchemaDsl = {
  name: 'notes',
  version: 1,
  tables: {
    notes: {
      id: 'integer primary key',
      title: 'text not null',
      created_at: 'text not null default now',
    },
  },
};

export interface Note {
  id: number;
  title: string;
  created_at: string;
}
`;
}

function genNotesDoHandler(): string {
  return `import { DurableObject } from 'cloudflare:workers';
import { autoMigrate, kunii } from '@kuratchi/kunii';
import { notesSchema, type Note } from '../schemas/notes';

export default class NotesDO extends DurableObject {
  static binding = 'NOTES_DO';

  declare db: any;

  constructor(ctx: DurableObjectState, env: any) {
    super(ctx, env);
    autoMigrate(ctx.storage, notesSchema);
    this.db = kunii(ctx.storage.sql, notesSchema);
  }

  async getNotes(): Promise<Note[]> {
    return (await this.db.notes.orderBy({ created_at: 'desc' }).many()).data ?? [];
  }

  async addNote(title: string): Promise<void> {
    await this.db.notes.insert({ title });
  }

  async deleteNote(id: number): Promise<void> {
    await this.db.notes.where({ id }).delete();
  }
}
`;
}

function genNotesDb(): string {
  return `import { env } from 'cloudflare:workers';
import type { Note } from '../schemas/notes';

function getStub() {
  return (env as any).NOTES_DO.get((env as any).NOTES_DO.idFromName('global'));
}

export async function getNotes(): Promise<Note[]> {
  return getStub().getNotes();
}

export async function addNote({ formData }: FormData): Promise<void> {
  const title = String(formData.get('title') || '').trim();
  if (!title) throw new Error('Note is required');
  await getStub().addNote(title);
}

export async function deleteNote(id: number): Promise<void> {
  await getStub().deleteNote(Number(id));
}
`;
}

function genNotesPage(): string {
  return `<script>
  import { getNotes, addNote, deleteNote } from '$server/notes';

  const notes = await getNotes();
</script>

<header>
  <div>
    <h1>Notes</h1>
    <p>Backed by a Cloudflare Durable Object with SQLite storage</p>
  </div>
</header>

<form action={addNote} method="POST">
  <input type="text" name="title" placeholder="New note..." required />
  <button type="submit">Add</button>
</form>

if (notes.length === 0) {
  <p style="opacity: 0.6">No notes yet.</p>
} else {
  <section>
    for (const note of notes) {
      <article>
        <span>{note.title}</span>
        <form action={deleteNote} method="POST" style="display: inline">
          <input type="hidden" name="id" value={note.id} />
          <button type="submit">Remove</button>
        </form>
      </article>
    }
  </section>
}
`;
}

function genLayout(opts: ScaffoldOptions): string {
  const navLinks: string[] = ['      <a href="/">Home</a>'];
  if (opts.orm) navLinks.push('      <a href="/items">Items</a>');
  if (opts.do)  navLinks.push('      <a href="/notes">Notes (DO)</a>');
  if (opts.auth) navLinks.push('      <a href="/admin">Admin</a>');

  const scriptImports: string[] = [];
  if (opts.ui) {
    scriptImports.push("  import ThemeInit from '@kuratchi/kuzan/theme-init.koze';");
  }

  const head: string[] = [
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>${opts.name} — Koze</title>`,
  ];
  if (opts.ui) head.push('  <ThemeInit />');

  const scriptBlock = scriptImports.length > 0
    ? `<script>\n${scriptImports.join('\n')}\n</script>\n\n`
    : '';

  return `${scriptBlock}<!doctype html>
<html lang="en" class="dark">
<head>
${head.join('\n')}
</head>
<body>
  <header>
    <a href="/">⚡ ${opts.name}</a>
    <nav>
${navLinks.join('\n')}
    </nav>
  </header>
  <main>
    <slot></slot>
  </main>
</body>
</html>
`;
}

function genLandingPage(opts: ScaffoldOptions): string {
  const imports: string[] = [];
  const cards: string[] = [];

  if (opts.ui) {
    imports.push("  import Badge from '@kuratchi/kuzan/badge.koze';");
    imports.push("  import Card from '@kuratchi/kuzan/card.koze';");
    imports.push("  import DataList from '@kuratchi/kuzan/data-list.koze';");
    imports.push("  import DataItem from '@kuratchi/kuzan/data-item.koze';");
  }

  let body = '';

  body += '<header>\n';
  body += '  <div>\n';
  body += `    <h1>${opts.name}</h1>\n`;
  body += '    <p>Built with Koze â€” a Cloudflare Workers-native framework</p>\n';
  body += '  </div>\n';
  body += '</header>\n\n';

  if (opts.orm) {
    body += '<div>\n';
    body += '  <a href="/items">\n';
    if (opts.ui) body += '    <Badge variant="success">D1 Database</Badge>\n';
    body += '    <h2>Items</h2>\n';
    body += '    <p>Full CRUD backed by Cloudflare D1. Schema auto-migrated on first request.</p>\n';
    body += '  </a>\n';
    if (opts.auth) {
      body += '  <a href="/admin">\n';
      if (opts.ui) body += '    <Badge variant="warning">Protected</Badge>\n';
      body += '    <h2>Admin</h2>\n';
      body += '    <p>Protected dashboard â€” sign in with credentials to access.</p>\n';
      body += '  </a>\n';
    }
    body += '</div>\n';
  }

  if (opts.ui) {
    body += '\n<Card title="Stack">\n';
    body += '  <DataList>\n';
    body += '    <DataItem label="Framework" value="koze" />\n';
    if (opts.orm) body += '    <DataItem label="ORM" value="kunii" />\n';
    if (opts.auth) body += '    <DataItem label="Auth" value="kyzen" />\n';
    body += '    <DataItem label="UI" value="kuzan" />\n';
    body += '  </DataList>\n';
    body += '</Card>\n';
  }

  if (imports.length > 0) {
    return `<script>\n${imports.join('\n')}\n</script>\n\n${body}`;
  }
  return body;
}

// â”€â”€ ORM Templates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function genSchema(opts: ScaffoldOptions): string {
  const tables: string[] = [];

  tables.push(`    items: {
      id: 'integer primary key',
      title: 'text not null',
      done: 'integer not null default 0',
      created_at: 'text not null default now',
    },`);

  if (opts.auth) {
    tables.push(`    users: {
      id: 'integer primary key',
      email: 'text not null unique',
      name: 'text',
      password_hash: 'text not null',
      created_at: 'text not null default now',
      updated_at: 'text not null default now',
    },
    session: {
      id: 'integer primary key',
      sessionToken: 'text not null unique',
      userId: 'integer not null',
      expires: 'integer not null',
      created_at: 'text not null default now',
      updated_at: 'text not null default now',
      deleted_at: 'text',
    },`);
  }

  const version = opts.auth ? 1 : 1;

  let types = `
export interface Item {
  id: number;
  title: string;
  done: number;
  created_at: string;
}`;

  if (opts.auth) {
    types += `

export interface User {
  id: number;
  email: string;
  name: string | null;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: number;
  sessionToken: string;
  userId: number;
  expires: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}`;
  }

  return `import type { SchemaDsl } from '@kuratchi/kunii';

export const appSchema: SchemaDsl = {
  name: '${opts.name}',
  version: ${version},
  tables: {
${tables.join('\n')}
  }
};
${types}
`;
}

function genItemsCrud(): string {
  return `import { env } from 'cloudflare:workers';
import { kunii } from '@kuratchi/kunii';
import { redirect } from '${FRAMEWORK_PACKAGE_NAME}';
import type { Item } from '../schemas/app';

const db = kunii(() => (env as any).DB);

export async function getItems() {
  const result = await db.items.orderBy({ created_at: 'desc' }).many();
  return (result.data ?? []) as Item[];
}

export async function addItem({ formData }: FormData): Promise<void> {
  const title = (formData.get('title') as string)?.trim();
  if (!title) throw new Error('Title is required');
  await db.items.insert({ title });
}

export async function deleteItem(id: number): Promise<void> {
  await db.items.where({ id }).delete();
}

export async function toggleItem(id: number): Promise<void> {
  const result = await db.items.where({ id }).first();
  const item = result.data as Item | null;
  if (item) {
    await db.items.where({ id }).update({ done: item.done ? 0 : 1 });
  }
}
`;
}

function genItemsPage(): string {
  return `<script>
  import { getItems, addItem, deleteItem, toggleItem } from '$server/items';
  import EmptyState from '@kuratchi/kuzan/empty-state.koze';

  const items = await getItems();
</script>

<header>
  <div>
    <h1>Items</h1>
    <p>Full CRUD backed by Cloudflare D1</p>
  </div>
</header>

<form action={addItem} method="POST">
  <input type="text" name="title" placeholder="What needs to be done?" required />
  <button type="submit">Add</button>
</form>

if (items.length === 0) {
  <EmptyState message="No items yet â€” add one above" />
} else {
  <section>
    for (const item of items) {
      <article>
        <span style={item.done ? 'text-decoration: line-through; opacity: 0.5' : ''}>{item.title}</span>
        <div>
          <form action={toggleItem} method="POST" style="display: inline">
            <input type="hidden" name="id" value={item.id} />
            <button type="submit">{item.done ? 'â†©' : 'âœ“'}</button>
          </form>
          <form action={deleteItem} method="POST" style="display: inline">
            <input type="hidden" name="id" value={item.id} />
            <button type="submit">âœ•</button>
          </form>
        </div>
      </article>
    }
  </section>
}
`;
}

// â”€â”€ Auth Templates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function genDevVars(): string {
  const secret = crypto.randomBytes(32).toString('hex');
  return `AUTH_SECRET=${secret}\n`;
}

function genAuthFunctions(): string {
  return `/**
 * Re-export the auth helpers from \`kyzen\` so route files can
 * \`import { signIn } from '$server/auth'\` without knowing where the
 * helpers actually live. The middleware in \`src/middleware.ts\` is what
 * makes these work — it parses the session cookie on every request.
 */
export {
  signUp,
  signIn,
  signOut,
  getCurrentUser,
  requestPasswordReset,
  resetPassword,
} from '@kuratchi/kyzen';
`;
}

function genAdminLoader(): string {
  return `import { getCurrentUser } from './auth';

export { signOut } from './auth';

export async function getAdminData() {
  const user = await getCurrentUser();
  return {
    isAuthenticated: !!user,
    user,
    timestamp: new Date().toISOString(),
  };
}
`;
}

function genLoginPage(): string {
  return `<script>
  import { signIn } from '$server/auth';
  import AuthCard from '@kuratchi/kuzan/auth-card.koze';
</script>

<AuthCard
  title="Sign In"
  subtitle="Welcome back â€” sign in to your account"
  footerText="Don't have an account?"
  footerLink="Sign up"
  footerHref="/auth/signup"
  error={signIn.error}
>
  <form action={signIn} method="POST" class="kui-auth-form">
    <div class="kui-field">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" placeholder="you@example.com" required autocomplete="email" />
    </div>
    <div class="kui-field">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢" required autocomplete="current-password" minlength="8" />
    </div>
    <button type="submit" class="kui-button kui-button--primary kui-button--block kui-auth-submit">Sign In</button>
  </form>
</AuthCard>
`;
}

function genSignupPage(): string {
  return `<script>
  import { signUp } from '$server/auth';
  import AuthCard from '@kuratchi/kuzan/auth-card.koze';
</script>

<AuthCard
  title="Create Account"
  subtitle="Sign up to get started"
  footerText="Already have an account?"
  footerLink="Sign in"
  footerHref="/auth/login"
  error={signUp.error}
>
  <form action={signUp} method="POST" class="kui-auth-form">
    <div class="kui-field">
      <label for="name">Name</label>
      <input type="text" id="name" name="name" placeholder="Your name" autocomplete="name" />
    </div>
    <div class="kui-field">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" placeholder="you@example.com" required autocomplete="email" />
    </div>
    <div class="kui-field">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢" required autocomplete="new-password" minlength="8" />
    </div>
    <button type="submit" class="kui-button kui-button--primary kui-button--block kui-auth-submit">Create Account</button>
  </form>
</AuthCard>
`;
}

function genAdminPage(): string {
  return `<script>
  import { getAdminData, signOut } from '$server/admin';
  import Badge from '@kuratchi/kuzan/badge.koze';
  import Card from '@kuratchi/kuzan/card.koze';
  import DataList from '@kuratchi/kuzan/data-list.koze';
  import DataItem from '@kuratchi/kuzan/data-item.koze';

  const admin = await getAdminData();
</script>

if (!admin.isAuthenticated) {
  <head>
    <meta http-equiv="refresh" content="0;url=/auth/login" />
  </head>
  <p>Redirecting to login...</p>
} else {
  <header>
    <div>
      <h1>Admin Dashboard</h1>
      <p>Welcome back, {admin.user.name || admin.user.email}</p>
    </div>
    <Badge variant="success">Authenticated</Badge>
  </header>

  <Card title="User Info">
    <DataList>
      <DataItem label="Email" value={admin.user.email} />
      <DataItem label="Name" value={admin.user.name || 'â€”'} />
      <DataItem label="User ID" value={String(admin.user.id)} />
      <DataItem label="Created" value={admin.user.created_at} />
    </DataList>
  </Card>

  <Card title="Session">
    <DataList>
      <DataItem label="Timestamp" value={admin.timestamp} />
    </DataList>
  </Card>

  <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
    <a href="/" class="kui-button kui-button--outline">&larr; Back to Home</a>
    <form action={signOut} method="POST" style="margin: 0;">
      <button type="submit" class="kui-button kui-button--danger">Sign Out</button>
    </form>
  </div>
}
`;
}

// ── Scaffold ──────────────────────────────────────────────────────
//
// Vite is the canonical (and only) Koze build pipeline. This
// scaffolder emits a minimal project wired for `koze/vite`:
//
//   - `vite.config.ts` with the `koze()` plugin (auto-syncs
//     `wrangler.jsonc`, discovers routes / containers / sandboxes /
//     durable objects, provides `koze:*` virtual modules).
//   - `src/worker.ts` — one-line re-export of `koze:worker`.
//   - `src/middleware.ts` — `defineMiddleware({ migrate, auth, ... })`,
//     populated based on the picked features.
//   - `src/app.css` — global stylesheet (when UI is enabled), imports
//     `kuzan/styles/theme.css`. Auto-injected into the shell.
//   - `src/routes/*.koze` — route files with the canonical extension.
//   - `src/assets/styles.css` — static asset served from the root path
//     via Wrangler's assets binding (verbatim, no plugins).
function scaffoldVite(dir: string, opts: ScaffoldOptions) {
  const { orm, auth } = opts;
  const enableDO = opts.do;

  const dirs = [
    '',
    'src',
    'src/routes',
    'src/assets',
  ];
  if (orm || enableDO) dirs.push('src/schemas');
  if (orm || enableDO || auth) dirs.push('src/server');
  if (enableDO) dirs.push('src/routes/notes');
  if (auth) dirs.push('src/routes/auth', 'src/routes/auth/login', 'src/routes/auth/signup', 'src/routes/admin');
  if (orm) dirs.push('src/routes/items');

  for (const d of dirs) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }

  write(dir, 'package.json', genVitePackageJson(opts));
  write(dir, 'vite.config.ts', genViteConfig());
  write(dir, 'vitest.config.ts', genViteVitestConfig());
  write(dir, 'wrangler.jsonc', genViteWrangler(opts));
  write(dir, 'tsconfig.json', genViteTsConfig());
  write(dir, '.gitignore', genViteGitIgnore());
  write(dir, 'test/tsconfig.json', genViteTestTsConfig());
  write(dir, 'test/worker.test.ts', genWorkerTest());
  write(dir, 'src/worker.ts', genViteWorker());
  write(dir, 'src/middleware.ts', genMiddleware(opts));
  if (opts.ui) write(dir, 'src/app.css', genAppCss());
  write(dir, 'src/assets/styles.css', genViteAssetsCss());
  write(dir, 'src/routes/layout.koze', genLayout(opts));
  write(dir, 'src/routes/index.koze', genLandingPage(opts));

  if (orm) {
    write(dir, 'src/schemas/app.ts', genSchema(opts));
    write(dir, 'src/server/items.ts', genItemsCrud());
    write(dir, 'src/routes/items/index.koze', genItemsPage());
    write(dir, 'test/d1.test.ts', genD1Test());
  }

  if (enableDO) {
    write(dir, 'src/schemas/notes.ts', genNotesSchema());
    write(dir, 'src/server/notes.do.ts', genNotesDoHandler());
    write(dir, 'src/server/notes.ts', genNotesDb());
    write(dir, 'src/routes/notes/index.koze', genNotesPage());
    write(dir, 'test/durable-object.test.ts', genDurableObjectTest());
  }

  if (auth) {
    write(dir, '.dev.vars', genDevVars());
    write(dir, 'src/server/auth.ts', genAuthFunctions());
    write(dir, 'src/server/admin.ts', genAdminLoader());
    write(dir, 'src/routes/auth/login/index.koze', genLoginPage());
    write(dir, 'src/routes/auth/signup/index.koze', genSignupPage());
    write(dir, 'src/routes/admin/index.koze', genAdminPage());
  }
}

function genVitePackageJson(opts: ScaffoldOptions): string {
  const ver = opts.monorepo ? 'workspace:*' : 'latest';
  const deps: Record<string, string> = {
    [FRAMEWORK_PACKAGE_NAME]: ver,
  };
  if (opts.ui) deps[UI_PACKAGE_NAME] = ver;
  if (opts.orm) deps[ORM_PACKAGE_NAME] = ver;
  if (opts.auth) deps[AUTH_PACKAGE_NAME] = ver;

  return JSON.stringify({
    name: opts.name,
    version: '0.0.1',
    private: true,
    type: 'module',
    scripts: {
      dev: 'vite dev',
      build: 'vite build',
      preview: 'vite preview',
      test: 'vitest run',
      'test:watch': 'vitest',
      types: 'wrangler types',
      deploy: 'vite build && wrangler deploy',
    },
    dependencies: deps,
    devDependencies: {
      '@cloudflare/vite-plugin': '^1.0.0',
      '@cloudflare/vitest-pool-workers': '^0.15.0',
      '@cloudflare/workers-types': '^4.20250214.0',
      'vite': '^7.0.0',
      'vitest': '^4.1.0',
      'wrangler': '^4.83.0',
    },
  }, null, 2) + '\n';
}

function genViteConfig(): string {
  return `import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { koze } from '@kuratchi/koze/vite';

// The \`koze()\` plugin owns:
//   - Route discovery (\`src/routes/**/*.koze\`)
//   - Virtual modules (\`koze:worker\`, \`koze:request\`, etc.)
//   - Auto-sync of \`wrangler.jsonc\` (containers, sandboxes, DOs, queues, assets)
//   - Response-header security config via the \`security\` option
//
// The \`cloudflare()\` plugin runs the SSR module inside \`workerd\`
// for dev/preview parity with production. The \`viteEnvironment.name\`
// must be \`'ssr'\` so Vite's SSR build emits to the Worker entry.
//
// Auth, ORM auto-migration, and other request-time concerns are wired
// in \`src/middleware.ts\` (no project-level config file).
export default defineConfig({
  plugins: [
    koze(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
  ],
});
`;
}

function genViteVitestConfig(): string {
  return `import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { koze } from '@kuratchi/koze/vite';

export default defineConfig({
  plugins: [
    koze(),
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
`;
}

function genViteWrangler(opts: ScaffoldOptions): string {
  // Vite emits the final worker entry into \`dist/\`, but the
  // \`koze()\` plugin rewrites \`main\` if necessary at build time.
  // We keep the config minimal here and point at the source entry so
  // \`wrangler dev\` (used for preview of the prod-shaped bundle) works.
  const compatibilityDate = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];
  const config: any = {
    name: opts.name,
    main: 'src/worker.ts',
    compatibility_date: compatibilityDate,
    compatibility_flags: ['nodejs_compat'],
    assets: { directory: 'src/assets' },
  };

  if (opts.orm) {
    config.d1_databases = [
      { binding: 'DB', database_name: `${opts.name}-db`, database_id: 'local-dev-only' },
    ];
  }

  if (opts.do) {
    config.durable_objects = { bindings: [{ name: 'NOTES_DO', class_name: 'NotesDO' }] };
    config.migrations = [{ tag: 'v1', new_sqlite_classes: ['NotesDO'] }];
  }

  return JSON.stringify(config, null, 2) + '\n';
}

function genViteWorker(): string {
  // `koze:worker` is the virtual module synthesized by the
  // `koze()` Vite plugin. It wires the dispatcher + middleware +
  // route registry into the Workers `fetch` + `queue` exports. Re-export
  // named classes too so Durable Objects, Workflows, and other convention
  // classes are visible to Wrangler, Miniflare, and the Cloudflare test pool.
  return `export { default } from 'koze:worker';
export * from 'koze:worker';
`;
}

function genViteTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      types: ['./worker-configuration.d.ts'],
    },
    include: ['src/**/*.ts', 'vite.config.ts'],
    exclude: ['node_modules', 'dist'],
  }, null, 2) + '\n';
}

function genViteTestTsConfig(): string {
  return JSON.stringify({
    extends: '../tsconfig.json',
    compilerOptions: {
      moduleResolution: 'bundler',
      types: ['@cloudflare/vitest-pool-workers'],
    },
    include: [
      './**/*.ts',
      '../worker-configuration.d.ts',
      '../src/**/*.ts',
    ],
  }, null, 2) + '\n';
}

function genWorkerTest(): string {
  return `import { exports as worker } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';

describe('worker routes', () => {
  test('renders the home page through the Cloudflare runtime', async () => {
    const response = await worker.default.fetch(new Request('http://example.com/'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<!doctype html>');
  });

  test('returns a framework 404 for missing routes', async () => {
    const response = await worker.default.fetch(new Request('http://example.com/missing'));

    expect(response.status).toBe(404);
  });
});
`;
}

function genD1Test(): string {
  return `import { env, exports as worker } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';

describe('D1 integration', () => {
  test('auto-migrates and writes through a real D1 binding', async () => {
    await worker.default.fetch(new Request('http://example.com/items'));

    const form = new FormData();
    form.set('_action', 'addItem');
    form.set('title', 'Test item');

    const response = await worker.default.fetch(new Request('http://example.com/items', {
      method: 'POST',
      body: form,
    }));

    expect([200, 303]).toContain(response.status);

    const row = await (env as any).DB
      .prepare('SELECT title, done FROM items WHERE title = ?')
      .bind('Test item')
      .first();

    expect(row).toEqual({ title: 'Test item', done: 0 });
  });
});
`;
}

function genDurableObjectTest(): string {
  return `import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';

describe('Durable Object integration', () => {
  test('calls the notes Durable Object over Workers RPC', async () => {
    const namespace = (env as any).NOTES_DO;
    const stub = namespace.get(namespace.idFromName('test-notes'));

    await stub.addNote('from test');
    const notes = await stub.getNotes();

    expect(notes.map((note: any) => note.title)).toContain('from test');
  });
});
`;
}

function genViteGitIgnore(): string {
  return `node_modules/
.wrangler/
.dev.vars
dist/
worker-configuration.d.ts
`;
}

function genViteAssetsCss(): string {
  // Minimal reset so the landing page doesn't ship naked HTML. Users
  // are expected to replace this with their own stylesheet or opt
  // into Tailwind via the \`css.tailwind\` Koze config option.
  return `:root {
  color-scheme: light dark;
  font-family: system-ui, -apple-system, sans-serif;
}
body { margin: 0; padding: 2rem; max-width: 48rem; margin-inline: auto; }
header { margin-bottom: 2rem; }
nav { display: flex; gap: 1rem; }
`;
}
