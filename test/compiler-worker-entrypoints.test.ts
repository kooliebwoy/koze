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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kuratchi-worker-${name}-`));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src', 'routes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'routes', 'page.koze'), '<p>Hello</p>\n', 'utf-8');
  return dir;
}

describe('compiler worker entrypoints', () => {
  it('emits JS shims that forward to the current TS entrypoints', async () => {
    const projectDir = createTempProject('compat-shims');

    const workerPath = await compile({ projectDir, isDev: true });

    expect(workerPath).toBe(path.join(projectDir, '.koze', 'worker.ts'));
    expect(fs.readFileSync(path.join(projectDir, '.koze', 'routes.js'), 'utf-8')).toContain(
      "export * from './routes.ts';",
    );
    expect(fs.readFileSync(path.join(projectDir, '.koze', 'worker.js'), 'utf-8')).toContain(
      "export * from './worker.ts';",
    );
  });

  it('does not treat wrangler durable object agent bindings as generated kuratchi DO classes', async () => {
    const projectDir = createTempProject('agent-do-bindings');
    fs.mkdirSync(path.join(projectDir, 'src', 'server', 'ai'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'test-app',
        main: '.koze/worker.ts',
        durable_objects: {
          bindings: [
            { name: 'KURATCHI_AI_SESSION', class_name: 'KuratchiAiSession' },
          ],
        },
      }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'ai', 'kuratchi-ai-session.agent.ts'),
      `export class KuratchiAiSession {
  async onRequest() {
    return new Response('ok');
  }
}
`,
      'utf-8',
    );

    await compile({ projectDir, isDev: true });
    const workerSource = fs.readFileSync(path.join(projectDir, '.koze', 'worker.ts'), 'utf-8');

    expect(workerSource).toContain("export { KuratchiAiSession } from './modules/src/server/ai/kuratchi-ai-session.agent';");
    expect(workerSource).not.toContain("export { KuratchiAiSession } from './routes.ts';");
  });

  it('mirrors src/assets into the configured assets prefix and syncs wrangler assets', async () => {
    const projectDir = createTempProject('assets-prefix-sync');
    fs.mkdirSync(path.join(projectDir, 'src', 'assets', 'css'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'assets', 'css', 'app.css'), 'body { color: red; }', 'utf-8');

    await compile({ projectDir, isDev: true, assetsPrefix: '/static/' });

    const mirroredAsset = path.join(projectDir, '.koze', 'public', 'static', 'css', 'app.css');
    const wrangler = JSON.parse(fs.readFileSync(path.join(projectDir, 'wrangler.jsonc'), 'utf-8'));
    const routesSource = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(fs.readFileSync(mirroredAsset, 'utf-8')).toBe('body { color: red; }');
    expect(wrangler.assets).toEqual({ directory: '.koze/public', binding: 'ASSETS' });
    expect(routesSource).toContain('assetsPrefix: "/static/"');
  });

  it('syncs convention pipeline bindings and registers runtime pipeline names', async () => {
    const projectDir = createTempProject('pipeline-sync');
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'analytics.pipeline.ts'),
      [
        "export const pipeline = 'analytics_stream_id';",
        "export const pipelineName = 'analytics-archive';",
        "export const binding = 'ANALYTICS';",
        "export const schema = { schema_version: 'int32!', event: 'string!' };",
        "export const sink = {",
        "  type: 'r2-data-catalog',",
        "  name: 'analytics_sink',",
        "  bucket: 'analytics-archive',",
        "  namespace: 'default',",
        "  table: 'events',",
        "  rollInterval: 10,",
        "};",
        '',
      ].join('\n'),
      'utf-8',
    );

    await compile({ projectDir, isDev: true });

    const wrangler = JSON.parse(fs.readFileSync(path.join(projectDir, 'wrangler.jsonc'), 'utf-8'));
    const routesSource = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');
    const schema = JSON.parse(fs.readFileSync(path.join(projectDir, '_cloudflare', 'pipelines', 'analytics', 'schema.json'), 'utf-8'));
    const sql = fs.readFileSync(path.join(projectDir, '_cloudflare', 'pipelines', 'analytics', 'pipeline.sql'), 'utf-8');
    const setup = fs.readFileSync(path.join(projectDir, '_cloudflare', 'pipelines', 'analytics', 'setup.ps1'), 'utf-8');

    expect(wrangler.pipelines).toEqual([
      {
        pipeline: 'analytics_stream_id',
        binding: 'ANALYTICS',
      },
    ]);
    expect(routesSource).toContain('__setPipelineRegistry');
    expect(routesSource).toContain('"analytics": { binding: "ANALYTICS", pipeline: "analytics_stream_id" }');
    expect(schema.fields).toEqual([
      { name: 'schema_version', type: 'int32', required: true },
      { name: 'event', type: 'string', required: true },
    ]);
    expect(sql).toBe("INSERT INTO analytics_sink\nSELECT *\nFROM analytics_stream_id;\n");
    expect(setup).toContain('npx wrangler pipelines streams create analytics_stream_id --schema-file _cloudflare/pipelines/analytics/schema.json --http-enabled false');
    expect(setup).toContain('npx wrangler pipelines create analytics-archive --sql-file _cloudflare/pipelines/analytics/pipeline.sql');
  });

  it('uses pipeline filename defaults when the declaration has no exports', async () => {
    const projectDir = createTempProject('pipeline-defaults');
    fs.mkdirSync(path.join(projectDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'clickstream.pipeline.ts'),
      '// filename supplies the pipeline convention\n',
      'utf-8',
    );

    await compile({ projectDir, isDev: true });

    const wrangler = JSON.parse(fs.readFileSync(path.join(projectDir, 'wrangler.jsonc'), 'utf-8'));
    const routesSource = fs.readFileSync(path.join(projectDir, '.koze', 'routes.ts'), 'utf-8');

    expect(wrangler.pipelines).toEqual([
      {
        pipeline: 'clickstream',
        binding: 'CLICKSTREAM_PIPELINE',
      },
    ]);
    expect(routesSource).toContain('"clickstream": { binding: "CLICKSTREAM_PIPELINE", pipeline: "clickstream" }');
    expect(fs.existsSync(path.join(projectDir, '_cloudflare', 'pipelines', 'clickstream'))).toBe(false);
  });

  it('rejects plural server convention suffixes with singular fix-it names', async () => {
    const projectDir = createTempProject('plural-conventions');
    fs.mkdirSync(path.join(projectDir, 'src', 'server', 'ai'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'ai', 'session.agents.ts'),
      `export class SessionAgent {}\n`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'emails.queues.ts'),
      `export default async function queue() {}\n`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'events.pipelines.ts'),
      `export const pipeline = 'events-stream';\n`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'migration.workflows.ts'),
      `export class MigrationWorkflow {}\n`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'browser.containers.ts'),
      `export class BrowserContainer {}\n`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'shell.sandboxes.ts'),
      `export class ShellSandbox {}\n`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'server', 'auth.dos.ts'),
      `export class AuthDO {}\n`,
      'utf-8',
    );

    let error: unknown = null;
    try {
      await compile({ projectDir, isDev: true });
    } catch (err) {
      error = err;
    }

    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain('Convention file suffixes are singular');
    expect(message).toContain('use "session.agent.ts" instead of "session.agents.ts"');
    expect(message).toContain('use "emails.queue.ts" instead of "emails.queues.ts"');
    expect(message).toContain('use "events.pipeline.ts" instead of "events.pipelines.ts"');
    expect(message).toContain('use "migration.workflow.ts" instead of "migration.workflows.ts"');
    expect(message).toContain('use "browser.container.ts" instead of "browser.containers.ts"');
    expect(message).toContain('use "shell.sandbox.ts" instead of "shell.sandboxes.ts"');
    expect(message).toContain('use "auth.do.ts" instead of "auth.dos.ts"');
  });

});
