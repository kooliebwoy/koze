import { describe, expect, it } from 'vitest';
import { parseFile } from '../src/compiler/parser.js';

describe('parser: top-level script inference', () => {
  it('extracts non-reactive top-level script for server prepass', () => {
    const source = `<script>
import { getUser } from './server/auth';
const user = await getUser();
</script>
<main>{user?.email}</main>`;

    const parsed = parseFile(source);
    expect(parsed.script).toContain('const user = await getUser();');
    expect(parsed.hasLoad).toBe(true);
    expect(parsed.template).toContain('<main>{user?.email}</main>');
    expect(parsed.ir.script.normalized).toContain('const user = await getUser();');
    expect(parsed.ir.imports.server[0].moduleSpecifier).toBe('./server/auth');
    expect(parsed.ir.template.source).toBe(parsed.template);
  });

  it('treats all <script> blocks as hybrid client-first scripts', () => {
    // Reactive `$:` labels remain part of the authored top-script model.
    // The parser preserves them for the server prepass and the client bundle.
    const source = `<script>
let count = 0;
$: count = count + 1;
</script>
<main>{count}</main>`;

    const parsed = parseFile(source);
    expect(parsed.script).toContain('$: count = count + 1;');
    expect(parsed.template).toBe('<main>{count}</main>');
  });

  it('preserves undeclared reactive derived bindings for downstream compilation', () => {
    const source = `<script>
let selected = '';
$: showDetails = selected === 'x';
</script>
<main>{showDetails ? 'Visible' : 'Hidden'}</main>`;

    const parsed = parseFile(source, { filePath: 'src/routes/demo/page.koze' });
    expect(parsed.script).toContain("$: showDetails = selected === 'x';");
    expect(parsed.template).toContain("{showDetails ? 'Visible' : 'Hidden'}");
  });

  it('keeps for-of loops inside the top script out of template parsing', () => {
    const source = `<script>
const rows = [];
for (const item of sourceRows) {
  rows.push(item);
}
</script>
<main>{rows.length}</main>`;

    const parsed = parseFile(source, { filePath: 'src/routes/demo/page.koze' });

    expect(parsed.script).toContain('for (const item of sourceRows)');
    expect(parsed.template).toBe('<main>{rows.length}</main>');
    expect(parsed.dataVars).toContain('rows');
    expect(parsed.dataVars).not.toContain('item');
  });

  it('extracts explicit load() return vars for template access', () => {
    const source = `<script>
import { env } from 'cloudflare:workers';

export async function load() {
  return {
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
  };
}
</script>
<main>{turnstileSiteKey}</main>`;

    const parsed = parseFile(source);
    expect(parsed.loadFunction).toContain('export async function load()');
    expect(parsed.loadReturnVars).toContain('turnstileSiteKey');
    expect(parsed.dataVars).toContain('turnstileSiteKey');
  });

  it('rejects Cloudflare env usage outside route load()', () => {
    const source = `<script>
import { env } from 'cloudflare:workers';
const secret = env.AUTH_SECRET;
</script>
<main>{secret}</main>`;

    expect(() => parseFile(source, { filePath: 'src/routes/leak.koze' })).toThrow(
      'Cloudflare env alias "env" can only be used inside export load() in a route script.',
    );
  });

  it('rejects non-env Cloudflare Workers imports from route scripts', () => {
    const source = `<script>
import { DurableObject } from 'cloudflare:workers';
const value = DurableObject;
</script>
<main>{value}</main>`;

    expect(() => parseFile(source, { filePath: 'src/routes/do-leak.koze' })).toThrow(
      'Route top-level <script> can only import env from cloudflare:workers for export load().',
    );
  });

  it('keeps non-component imports available to server template rendering', () => {
    const source = `<script>
import answer from './answer.js';
import problems from '$lib/problems.js';
</script>
<div>i got {problems} problems</div>
<div>the answer is {answer}</div>`;

    const parsed = parseFile(source, { filePath: 'src/routes/demo/page.koze' });

    expect(parsed.serverImports).toContain("import answer from './answer.js';");
    expect(parsed.serverImports).toContain("import problems from '$lib/problems.js';");
    expect(parsed.ir.imports.server.map((imp) => imp.moduleSpecifier)).toEqual(['./answer.js', '$lib/problems.js']);
    expect(parsed.template).toContain('{answer}');
    expect(parsed.template).toContain('{problems}');
  });

  it('rejects script blocks after template markup', () => {
    const source = `<div>{formatBytes(1024)}</div>

<script>
  function formatBytes(bytes) {
    return String(bytes);
  }
</script>`;

    expect(() => parseFile(source, { filePath: 'src/routes/sites/page.koze' })).toThrow(
      'Only one top-level <script> block is allowed, and it must appear before template markup.',
    );
  });

  it('rejects additional script blocks even when the bottom script has complex braces', () => {
    const source = `<script>
let count = 0;
</script>
<main>{count}</main>
<script>
const config = {
  nested: {
    count,
    values: [1, 2, 3].map((value) => ({ value })),
  },
};
console.log(config);
</script>`;

    expect(() => parseFile(source, { filePath: 'src/routes/demo/page.koze' })).toThrow(
      'Only one top-level <script> block is allowed, and it must appear before template markup.',
    );
  });

  // Note: $lib/ imports are now isomorphic and allowed in server templates
  // The old $client/ convention that blocked server template usage has been removed
});
