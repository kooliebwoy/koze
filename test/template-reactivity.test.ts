import { describe, expect, it } from 'vitest';
import { compileTemplate } from '../src/compiler/template.js';
import { buildClientScopeMount, transformReactiveClientScript } from '../src/compiler/script-transform.js';

describe('template compiler reactive transform', () => {
  it('transforms $: expression into an internal effect', () => {
    const template = `<script>
let users = ['Alice'];
$: console.log(\`Users updated: \${users.length}\`);
</script>`;

    const compiled = compileTemplate(template);
    expect(compiled).toContain("const __k$ = window.__kozeReactive;");
    expect(compiled).toContain('const __kState = __k$.state({});');
    expect(compiled.indexOf('const __k$ = window.__kozeReactive;')).toBeLessThan(compiled.indexOf('const __kState = __k$.state({});'));
    expect(compiled).toContain("__kState.users = ['Alice'];");
    expect(compiled).toContain('__k$.effect(() => {');
    expect(compiled).toContain('console.log(\\`Users updated: \\${__kState.users.length}\\`);');
    expect(compiled).toContain('Users updated: \\${__kState.users.length}');
  });

  it('rewrites proxy-backed reassignment to preserve reactivity', () => {
    const template = `<script>
let users = ['Alice'];
$: console.log(users.length);
function resetUsers() {
  users = ['Bob'];
}
</script>`;

    const compiled = compileTemplate(template);
    expect(compiled).toContain("__kState.users = ['Bob'];");
  });

  it('transforms $: block syntax into an effect block', () => {
    const template = `<script>
let form = { first: '', last: '' };
$: {
  const fullName = \`\${form.first} \${form.last}\`.trim();
  console.log(fullName);
}
</script>`;

    const compiled = compileTemplate(template);
    expect(compiled).toContain('const __kState = __k$.state({});');
    expect(compiled).toContain("__kState.form = { first: '', last: '' };");
    expect(compiled).toContain("__k$.effect(() => {");
    expect(compiled).toContain('const fullName = \\`\\${__kState.form.first} \\${__kState.form.last}\\`.trim();');
    expect(compiled).toContain("});");
  });

  it('injects runtime binding after top-level import statements in module scripts', () => {
    const template = `<script type="module">
import { x } from './x.js';
let users = [];
$: console.log(users.length);
</script>`;

    const compiled = compileTemplate(template);
    const importIdx = compiled.indexOf("import { x } from './x.js';");
    const runtimeIdx = compiled.indexOf('const __k$ = window.__kozeReactive;');
    expect(importIdx).toBeGreaterThan(-1);
    expect(runtimeIdx).toBeGreaterThan(-1);
    expect(runtimeIdx).toBeGreaterThan(importIdx);
  });

  it('does not inject reactive runtime binding when no $: label is present', () => {
    const template = `<script>
const title = 'Hello';
console.log(title);
</script>`;

    const compiled = compileTemplate(template);
    expect(compiled).not.toContain("const __k$ = window.__kozeReactive;");
    expect(compiled).toContain("const title = 'Hello';");
  });

  it('does not treat script-looking CSS text as a client script', () => {
    const template = `<style>
.icon::before { content: "<script>$: console.log('css')</script>"; }
</style>
<p>Styled</p>`;

    const compiled = compileTemplate(template);

    expect(compiled).not.toContain("const __k$ = window.__kozeReactive;");
    expect(compiled).toContain(`content: "<script>$: console.log('css')</script>";`);
  });

  it('keeps non-reactive component-style attributes as plain SSR HTML', () => {
    const template = `<script>
const resolvedIconPath = '/icons/home.svg';
const className = 'h-4 w-4';
</script>
<img src="{resolvedIconPath}" class={\`app-icon \${className}\`} />`;

    const compiled = compileTemplate(template);
    expect(compiled).not.toContain("const __k$ = window.__kozeReactive;");
    expect(compiled).not.toContain('data-k-text');
    expect(compiled).not.toContain('data-k-attr-class');
    expect(compiled).toContain('src="${__esc(resolvedIconPath)}"');
    expect(compiled).toContain('const __value = (`app-icon ${className}`);');
    expect(compiled).toContain(`' class="' + __esc(__value) + '"'`);
  });

  it('emits bind:value and reactive template bindings for runtime mounting', () => {
    const template = `<script>
let form = { selected: '' };
</script>
<select bind:value={form.selected}></select>
<option hidden={form.selected !== 'a'}>{form.selected}</option>`;

    const compiled = compileTemplate(template);
    expect(compiled).toContain('data-k-bind-value="${__esc("form.selected")}"');
    expect(compiled).toContain('data-k-attr-hidden="${__esc("form.selected !==');
    expect(compiled).toContain('data-k-text="${__esc("form.selected")}"');
    expect(compiled).toContain('__k$.mount(__kScope);');
  });

  it('does not evaluate $el bind expressions during server render', () => {
    const template = `<script>
let forms = { row1: { selected: 'a' } };
</script>
<select bind:value={forms[$el.closest('[data-row]').dataset.rowId].selected}></select>`;

    const compiled = compileTemplate(template);
    expect(compiled).toContain("try { return ''; } catch (_err) { return ''; }");
    expect(compiled).toContain('data-k-bind-value="${__esc("forms[$el.closest');
  });

  it('captures template loop locals for client bindings', () => {
    const template = `<script>
const rows = [{ id: 'row1' }];
let forms = { row1: { selected: 'a' } };
</script>
for (const item of rows) {
  <select bind:value={forms[item.id].selected}></select>
}`;

    const compiled = compileTemplate(template);
    expect(compiled).toContain('data-k-bind-value="${__esc("forms[item.id].selected")}"');
    expect(compiled).toContain('data-k-scope="${__esc(encodeURIComponent(JSON.stringify({ item })))}"');
  });

  it('does not serialize destructuring property names as template locals', () => {
    const template = `<script>
const rows = [{ item: { id: 'row1' } }];
const item = { id: 'top-level' };
let selected = 'row1';
</script>
for (const row of rows) {
  const { item: activeItem } = row;
  <button data-active={item.id === selected && activeItem.id === selected}>{activeItem.id}</button>
}`;

    const compiled = compileTemplate(template);

    expect(compiled).toContain('data-k-scope="${__esc(encodeURIComponent(JSON.stringify({ activeItem })))}"');
    expect(compiled).not.toContain('JSON.stringify({ item, activeItem })');
  });

  it('captures destructured loop bindings for client-side template metadata', () => {
    const template = `<script>
const rows = [{ item: { id: 'row1' } }];
const item = { id: 'top-level' };
let selected = 'row1';
</script>
for (const { item: activeItem } of rows) {
  <button data-active={item.id === selected && activeItem.id === selected}>{activeItem.id}</button>
}`;

    const compiled = compileTemplate(template);

    expect(compiled).toContain('data-k-scope="${__esc(encodeURIComponent(JSON.stringify({ activeItem })))}"');
    expect(compiled).not.toContain('JSON.stringify({ item, activeItem })');
  });

  it('captures classic for-loop locals for client-side template metadata', () => {
    const template = `<script>
const rows = [{ id: 'row1' }];
let selected = 'row1';
</script>
for (let i = 0; i < rows.length; i++) {
  <button data-active={rows[i].id === selected}>{i}:{rows[i].id}</button>
}`;

    const compiled = compileTemplate(template);

    expect(compiled).toContain('data-k-scope="${__esc(encodeURIComponent(JSON.stringify({ i })))}"');
  });

  it('supports while and catch control lines with scoped client metadata', () => {
    const template = `<script>
let selected = 'boom';
</script>
let count = 0;
while (count < 1) {
  <span>{count}</span>
  count++;
}
try {
  throw new Error('boom');
} catch (err) {
  <p data-active={err.message === selected}>{err.message}</p>
}`;

    const compiled = compileTemplate(template);

    expect(compiled).toContain('while (count < 1) {');
    expect(compiled).toContain("throw new Error('boom');");
    expect(compiled).toContain('} catch (err) {');
    expect(compiled).toContain('data-k-scope="${__esc(encodeURIComponent(JSON.stringify({ err })))}"');
  });

  it('emits reactive renderers for control-flow blocks that read reactive state', () => {
    const template = `<script>
let items = [{ title: 'A' }];
</script>
<ul>
  for (const item of items) {
    <li>{item.title}</li>
  }
</ul>`;

    const compiled = compileTemplate(template);
    expect(compiled).toContain('<!--k-block:b0-->');
    expect(compiled).toContain('<!--/k-block:b0-->');
    expect(compiled).toContain('__k$.renderer(');
    expect(compiled).toContain('__k$.mount(__kScope, { "b0": __k$.renderer');
  });

  it('captures server loop locals for nested reactive blocks', () => {
    const template = `<script>
const rows = [{ id: 'r1' }];
let optionsByRow = { r1: ['A'] };
</script>
for (const row of rows) {
  <select>
    for (const option of optionsByRow[row.id] ?? []) {
      <option>{option}</option>
    }
  </select>
}`;

    const compiled = compileTemplate(template);
    expect(compiled).toContain('<!--k-block:b0:${encodeURIComponent(JSON.stringify({ row }))}-->');
    expect(compiled).toContain('with($scope)');
  });

  it('mounts reactive block renderers only once when a page has multiple scripts', () => {
    const template = `<script>
const options = { noWarrantTypeId: 'none' };
let warrantType = '';
let isNoWarrant = false;
$: isNoWarrant = warrantType === options.noWarrantTypeId;
</script>
if (isNoWarrant) {
  <p>{options.noWarrantTypeId}</p>
}
<script>
console.log('plain imperative script');
</script>`;

    const compiled = compileTemplate(template);
    const mounts = compiled.match(/__k\$\.mount\(/g) ?? [];
    expect(mounts).toHaveLength(1);
    expect(compiled).toContain('Object.defineProperty(__kScopeValues, "options"');
    expect(compiled).toContain('__k$.mount(__kScope, { "b0": __k$.renderer');
    expect(compiled).toContain("console.log('plain imperative script');");
  });

  it('passes reactive owner ids into generated template mount calls', () => {
    const template = `<script>
let count = 0;
</script>
<button onClick={count += 1}>{count}</button>`;

    const compiled = compileTemplate(template, undefined, undefined, undefined, {
      reactiveOwnerId: 'owner-1',
    });

    expect(compiled).toContain('data-k-owner="owner-1"');
    expect(compiled).toContain('__k$.mount(__kScope, undefined, undefined, "owner-1");');
  });

  it('passes reactive owner ids through component props and slot children', () => {
    const template = `<script>
let createDbOpen = false;
let createDb = { error: undefined, pending: false, success: false };
</script>
<Dialog bind:open={createDbOpen}>
  <form action={createDb} method="POST">
    if (createDb.error) {
      <p role="alert">{createDb.error}</p>
    }
    <button type="submit" disabled={createDb.pending}>
      {createDb.pending ? 'Creating...' : 'Create Database'}
    </button>
  </form>
</Dialog>`;

    const compiled = compileTemplate(
      template,
      new Map([['Dialog', 'dialog']]),
      new Set(['createDb']),
      undefined,
      {
        augmentedActionNames: new Set(['createDb']),
        reactiveOwnerId: 'owner-1',
      },
    );

    expect(compiled).toContain('__kozeOwner: "owner-1"');
    expect(compiled).toContain('data-action-augment="createDb"');
    expect(compiled).toContain('data-k-owner="owner-1"');
    expect(compiled).toContain('<!--k-block:o:owner-1:');
    expect(compiled).toContain('__k$.mount(__kScope, { "b0": __k$.renderer');
    expect(compiled).toContain(', "owner-1");');
  });

  it('exposes readonly constants needed by reactive block renderers', () => {
    const template = `<script>
const featureOptions = [{ name: 'A' }];
let search = '';
</script>
for (const feature of featureOptions.filter((item) => item.name.includes(search))) {
  <div>{feature.name}</div>
}`;

    const compiled = compileTemplate(template);
    expect(compiled).toContain('Object.defineProperty(__kScopeValues, "featureOptions"');
    expect(compiled).toContain('Object.defineProperty(__kScopeValues, "search"');
    expect(compiled).toContain('get(){ return __kState.search; }, set(__value){ __kState.search = __value; }');
  });

  it('treats $: assignment targets as declared reactive state', () => {
    const template = `<script>
let selected = '';
$: isSelected = selected === 'yes';
</script>
<p>{isSelected}</p>`;

    const compiled = compileTemplate(template);
    expect(compiled).toContain("__kState.selected = '';");
    expect(compiled).toContain("__kState.isSelected = undefined;");
    expect(compiled).toContain("__k$.effect(() => { __kState.isSelected = __kState.selected === 'yes'; });");
    expect(compiled).toContain('Object.defineProperty(__kScopeValues, "isSelected"');
  });

  it('keeps implicit $: assignment targets reactive when callers pass a narrow name list', () => {
    const source = `
let selected = '';
$: isSelected = selected === 'yes';
`;

    const transformed = transformReactiveClientScript(source, {
      forceRuntime: true,
      reactiveNames: ['selected'],
    });

    expect(transformed).toContain('__kState.isSelected = undefined;');
    expect(transformed).toContain("__k$.effect(() => { __kState.isSelected = __kState.selected === 'yes'; });");
    expect(transformed).not.toContain('{ isSelected =');
  });

  it('runs the runtime version guard before creating reactive state', () => {
    const transformed = transformReactiveClientScript('let count = 0;', {
      forceRuntime: true,
      reactiveNames: ['count'],
    });

    expect(transformed.indexOf('if (!__k$ || __k$.__version <')).toBeLessThan(transformed.indexOf('const __kState'));
  });

  it('exposes implicit $: assignment targets even when scope names are filtered', () => {
    const source = `
let selected = '';
$: isSelected = selected === 'yes';
`;

    const mount = buildClientScopeMount(source, ['selected'], undefined, ['selected']);

    expect(mount).toContain('Object.defineProperty(__kScopeValues, "selected"');
    expect(mount).toContain('Object.defineProperty(__kScopeValues, "isSelected"');
  });

  it('transpiles TypeScript syntax inside client scripts', () => {
    const template = `<script>
const title: string = 'Hello';
const siteKey = env?.TURNSTILE_SITE_KEY as string | undefined;
</script>`;

    const compiled = compileTemplate(template);
    expect(compiled).toContain("const title: string = 'Hello';");
    expect(compiled).toContain('const siteKey = env?.TURNSTILE_SITE_KEY as string | undefined;');
  });
});
