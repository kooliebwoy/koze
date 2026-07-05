import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { componentFuncName } from '../src/compiler/compiler-shared.js';
import { compileTemplate } from '../src/compiler/template.js';
import { createComponentCompiler } from '../src/compiler/component-pipeline.js';
import { parseFile, stripTopLevelImports } from '../src/compiler/parser.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const esc = (value: unknown): string => {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

function renderWithPanel(template: string, data: Record<string, unknown> = {}): string {
  const body = compileTemplate(template, new Map([['Panel', 'panel']]));
  const keys = Object.keys(data);
  const values = Object.values(data);
  const panel = (props: { children?: string; title?: string; tone?: string }) =>
    `<article data-title="${esc(props.title ?? '')}" data-tone="${esc(props.tone ?? '')}">${props.children ?? ''}</article>`;
  const render = new Function(
    ...keys,
    '__esc',
    componentFuncName('panel'),
    `${body}\nreturn __html;`,
  );
  return render(...values, esc, panel);
}

function normalizeHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*data-k-props="[^"]*"[\s\S]*?<\/script>/g, '')
    .replace(/ data-k-island-root\b/g, '')
    .replace(/\bdz-[0-9a-f]{6}\b/g, 'dz-hash')
    .replace(/>\s+</g, '><')
    .trim();
}

function createTempProject(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kuratchi-components-${name}-`));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src', 'routes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'lib', 'cards'), { recursive: true });
  return dir;
}

function renderRealRoute(projectDir: string, routeSource: string): string {
  const srcDir = path.join(projectDir, 'src');
  const routeFile = path.join(srcDir, 'routes', 'page.koze');
  fs.writeFileSync(routeFile, routeSource, 'utf-8');

  const componentCompiler = createComponentCompiler({ projectDir, srcDir, isDev: true });
  const parsed = parseFile(routeSource, { kind: 'route', filePath: routeFile });
  const componentNames = componentCompiler.collectComponentMap(parsed.componentImports, routeFile);
  const body = compileTemplate(parsed.template, componentNames, undefined, undefined, { filePath: routeFile });
  const prelude = stripTopLevelImports(parsed.script ?? '');
  const render = new Function(
    `${componentCompiler.getCompiledComponents().join('\n\n')}
return function render() {
  const __esc = ${esc.toString()};
  ${prelude}
  ${body}
  return __html;
};`,
  )() as () => string;

  return render();
}

describe('template components', () => {
  it('sanitizes unusual component file names into valid render function identifiers', () => {
    const funcName = componentFuncName('[foo]');
    expect(funcName).toBe('__c__foo_');
    expect(() => new Function(`function ${funcName}(){ return ''; }`)).not.toThrow();
  });

  it('passes inline component children instead of treating the tag as empty', () => {
    expect(normalizeHtml(renderWithPanel('<Panel><p>{label}</p></Panel>', { label: 'Child' })))
      .toBe('<article data-title="" data-tone=""><p>Child</p></article>');
  });

  it('keeps reactive block ids and live action scope inside component children', () => {
    const body = compileTemplate(
      `<script>
import { augment } from '@kuratchi/koze';
const createDatabase = () => {};
const createDb = augment(createDatabase);
</script>
if (createDb.success) {
  <p>Created</p>
}
<Panel>
  if (createDb.error) {
    <p>{createDb.error}</p>
  }
  <button disabled={createDb.pending}>
    if (createDb.pending) {
      <span>Creating</span>
    } else {
      <span>Create</span>
    }
  </button>
</Panel>`,
      new Map([['Panel', 'panel']]),
      new Set(['createDb']),
      undefined,
      { augmentedActionNames: new Set(['createDb']) },
    );

    expect(body).toContain('<!--k-block:b0-->');
    expect(body).toContain('<!--k-block:b1-->');
    expect(body).toContain('<!--k-block:b2-->');
    expect(body).toContain('__k$.mount(__kScope, { "b0": __k$.renderer');
    expect(body).toContain('"b1": __k$.renderer');
    expect(body).toContain('"b2": __k$.renderer');
    expect(body).not.toContain('JSON.stringify({ createDb })');
  });

  it('still supports explicit empty component pairs', () => {
    expect(normalizeHtml(renderWithPanel('<Panel></Panel>'))).toBe('<article data-title="" data-tone=""></article>');
  });

  it('passes component prop spreads into the generated props object', () => {
    const html = renderWithPanel('<Panel {...props} tone="warm" />', {
      props: { title: 'Spread' },
    });

    expect(normalizeHtml(html)).toBe('<article data-title="Spread" data-tone="warm"></article>');
  });

  it('evaluates quoted component prop interpolations like template attributes', () => {
    const body = compileTemplate(
      `<Widget foo='{bar}' baz='{40 + x}' qux='this is a {compound} string' quux='{go.deeper}'/>`,
      new Map([['Widget', 'widget']]),
    );
    const widget = (props: { foo: string; baz: number; qux: string; quux: string }) =>
      `<p>foo: ${esc(props.foo)}</p><p>baz: ${esc(props.baz)} (${typeof props.baz})</p><p>qux: ${esc(props.qux)}</p><p>quux: ${esc(props.quux)}</p>`;
    const render = new Function('bar', 'x', 'compound', 'go', '__esc', componentFuncName('widget'), `${body}\nreturn __html;`);
    const html = render('lol', 2, 'piece of', { deeper: 'core' }, esc, widget);

    expect(normalizeHtml(html)).toBe('<p>foo: lol</p><p>baz: 42 (number)</p><p>qux: this is a piece of string</p><p>quux: core</p>');
  });

  it('parses component props with greater-than characters in quoted values and expressions', () => {
    const body = compileTemplate(
      `<Widget title="A > B" score={count > 1 ? 'many' : 'one'} />`,
      new Map([['Widget', 'widget']]),
    );
    const widget = (props: { title: string; score: string }) =>
      `<p>${esc(props.title)}:${esc(props.score)}</p>`;
    const render = new Function('count', '__esc', componentFuncName('widget'), `${body}\nreturn __html;`);

    expect(normalizeHtml(render(2, esc, widget))).toBe('<p>A &gt; B:many</p>');
  });

  it('joins multiline component tags without treating greater-than text as tag close', () => {
    const html = renderWithPanel(`<Panel
  title="A > B"
  tone={priority > 1 ? 'high' : 'low'}
>
  <p>{label}</p>
</Panel>`, {
      priority: 2,
      label: 'Ready',
    });

    expect(normalizeHtml(html)).toBe('<article data-title="A &gt; B" data-tone="high"><p>Ready</p></article>');
  });

  it('compiles real multi-file components with typed props, spreads, slots, and relative child imports', () => {
    const projectDir = createTempProject('real-props');
    fs.writeFileSync(
      path.join(projectDir, 'src', 'lib', 'cards', 'badge.koze'),
      `<script>
import { props } from 'koze:component';
</script>

<span class="badge" data-kind={props.kind}>{props.label}</span>`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'lib', 'cards', 'stat-card.koze'),
      `<script>
import Badge from './badge.koze';
import { props } from 'koze:component';

const { title, count = 0 } = props<{ title: string; count?: number }>();
const label = \`\${title}:\${count}\`;
</script>

<article class="stat-card" data-title={props.title} {...props.attrs}>
  <h2>{label}</h2>
  <Badge kind={props.tone} label={props.title} />
  <slot></slot>
</article>`,
      'utf-8',
    );

    const html = renderRealRoute(
      projectDir,
      `<script>
import StatCard from '$lib/cards/stat-card.koze';

const attrs = { 'data-tier': 'gold', hidden: false };
const childLabel = 'Revenue';
</script>

<StatCard title="Revenue" count={3} tone="positive" attrs={attrs}>
  <p>{childLabel} grew</p>
</StatCard>`,
    );

    expect(normalizeHtml(html)).toBe(
      '<div class="dz-hash"><article class="stat-card" data-title="Revenue" data-tier="gold"><h2>Revenue:3</h2><div class="dz-hash"><span class="badge" data-kind="positive">Revenue</span></div><p>Revenue grew</p></article></div>',
    );
  });

  it('scopes component CSS selectors without corrupting nested at-rules', () => {
    const projectDir = createTempProject('component-css');
    const routeFile = path.join(projectDir, 'src', 'routes', 'page.koze');
    const componentFile = path.join(projectDir, 'src', 'lib', 'cards', 'styled-card.koze');
    fs.writeFileSync(
      componentFile,
      `<style>
.card, button.primary {
  color: red;
}

@media (min-width: 40rem) {
  .card:hover, .card[data-active="true"] {
    color: blue;
  }
}

@keyframes pulse {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>

<article class="card"><slot></slot></article>`,
      'utf-8',
    );
    fs.writeFileSync(
      routeFile,
      `<script>
import StyledCard from '$lib/cards/styled-card.koze';
</script>

<StyledCard>Body</StyledCard>`,
      'utf-8',
    );

    const componentCompiler = createComponentCompiler({
      projectDir,
      srcDir: path.join(projectDir, 'src'),
      isDev: true,
    });
    const parsed = parseFile(fs.readFileSync(routeFile, 'utf-8'), { kind: 'route', filePath: routeFile });
    const componentNames = componentCompiler.collectComponentMap(parsed.componentImports, routeFile);
    const [css] = componentCompiler.collectStyles(componentNames);
    const normalizedCss = css.replace(/\bdz-[0-9a-f]{6}\b/g, 'dz-hash');

    expect(normalizedCss).toContain('.dz-hash .card, .dz-hash button.primary {');
    expect(normalizedCss).toContain('@media (min-width: 40rem) {');
    expect(normalizedCss).toContain('.dz-hash .card:hover, .dz-hash .card[data-active="true"] {');
    expect(normalizedCss).toContain('@keyframes pulse {');
    expect(normalizedCss).toContain('from { opacity: 0; }');
    expect(normalizedCss).not.toContain('.dz-hash @media');
    expect(normalizedCss).not.toContain('.dz-hash from');
  });
});
