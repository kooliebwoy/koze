import { describe, expect, it } from 'vitest';

import { compileTemplate } from '../src/compiler/template.js';

function compile(source: string, componentNames?: Map<string, string>): string {
  return compileTemplate(source, componentNames);
}

describe('hydration plan compiler parity', () => {
  it('leaves static markup without hydration work', () => {
    const body = compile('<h1>Hello world!</h1>');

    expect(body).not.toContain('data-k-');
    expect(body).not.toContain('__k$.mount');
  });

  it('leaves top-level text and nested static elements without hydration work', () => {
    const body = compile(`Text
<div>
  <p>nested</p>
</div>`);

    expect(body).not.toContain('data-k-');
    expect(body).not.toContain('__k$.mount');
  });

  it('preserves comments and constant expressions without reactive markers', () => {
    const body = compile(`<div><!-- test1 --><!-- test2 --></div>
<p>{1} 2 <span>3</span></p>`);

    expect(body).toContain('<!-- test1 --><!-- test2 -->');
    expect(body).not.toContain('data-k-text');
    expect(body).not.toContain('__k$.mount');
  });

  it('keeps static component calls and static component parents runtime-free', () => {
    const body = compile(`<div>
  <Nested/>
</div>`, new Map([['Nested', 'nested']]));

    expect(body).toContain('__c_nested({');
    expect(body).not.toContain('data-k-');
    expect(body).not.toContain('__k$.mount');
  });

  it('keeps non-reactive control flow runtime-free', () => {
    const body = compile(`if (true) {
  <span>hello</span>
}
for (const letter of 'abc') {
  {letter}
}`);

    expect(body).not.toContain('data-k-');
    expect(body).not.toContain('__k$.mount');
  });

  it('keeps static raw HTML and rich option content runtime-free', () => {
    const body = compile(`<div>{@html ''}</div>
<svg>{@html '<circle cx="200" cy="500" r="200"></circle>'}</svg>
<select>
  <option value="a"><strong>Bold</strong> Option</option>
</select>`);

    expect(body).toContain('__sanitizeHtml');
    expect(body).not.toContain('data-k-');
    expect(body).not.toContain('__k$.mount');
  });

  it('marks reactive raw HTML with comment anchors', () => {
    const body = compile(`<script>
let raw = '<p>this is some html</p>';
</script>
{@html raw}`);

    expect(body).toContain('<!--k-html:raw-->');
    expect(body).toContain('<!--/k-html:raw-->');
    expect(body).toContain('${__sanitizeHtml(raw)}');
    expect(body).toContain('__k$.mount(__kScope);');
  });

  it('marks mixed text and raw HTML hydration independently', () => {
    const body = compile(`<script>
let a = 'a';
let b = '<strong>b</strong>';
let c = 'c';
</script>
{a} {@html b} {c}`);

    expect(body).toContain('data-k-text="${__esc("a")}"');
    expect(body).toContain('<!--k-html:b-->');
    expect(body).toContain('data-k-text="${__esc("c")}"');
    expect(body).toContain('__k$.mount(__kScope);');
  });

  it('keeps static sibling attributes runtime-free', () => {
    const body = compile(`.<input checked />
<p dir="rtl">text</p>.`);

    expect(body).not.toContain('data-k-');
    expect(body).not.toContain('__k$.mount');
  });

  it('marks dynamic text reads for client hydration', () => {
    const body = compile(`<script>
let name = 'world';
</script>
<h1>Hello {name}!</h1>`);

    expect(body).toContain('data-k-text="${__esc("name")}"');
    expect(body).toContain('__k$.mount(__kScope);');
  });

  it('keeps nullish dynamic text mounted as empty text', () => {
    const body = compile(`<script>
let maybeNull = null;
let maybeUndefined = undefined;
</script>
<p>{maybeNull}</p>
<p>{maybeUndefined}</p>`);

    expect(body).toContain('data-k-text="${__esc("maybeNull")}"');
    expect(body).toContain('data-k-text="${__esc("maybeUndefined")}"');
    expect(body).toContain('__k$.mount(__kScope);');
  });

  it('wires input bindings and dependent text to the same reactive scope', () => {
    const body = compile(`<script>
let name = 'world';
</script>
<input bind:value={name}>
<p>Hello {name}!</p>`);

    expect(body).toContain('data-k-bind-value="${__esc("name")}"');
    expect(body).toContain('data-k-text="${__esc("name")}"');
    expect(body).toContain('__k$.mount(__kScope);');
  });

  it('marks reactive attributes without rewriting unchanged static attributes', () => {
    const dynamicBody = compile(`<script>
let className = 'foo';
</script>
<div class={className}></div>`);
    const staticBody = compile("<div class='foo'></div>");

    expect(dynamicBody).toContain('data-k-attr-class="${__esc("className")}"');
    expect(dynamicBody).toContain('__k$.mount(__kScope);');
    expect(staticBody).not.toContain('data-k-attr-class');
    expect(staticBody).not.toContain('__k$.mount');
  });

  it('anchors if-blocks that depend on reactive state', () => {
    const body = compile(`<script>
let foo = true;
</script>
if (foo) {
  <p>foo!</p>
}`);

    expect(body).toContain('<!--k-block:b0-->');
    expect(body).toContain('<!--/k-block:b0-->');
    expect(body).toContain('__k$.mount(__kScope, { "b0": __k$.renderer');
  });

  it('anchors each-blocks that depend on reactive arrays', () => {
    const body = compile(`<script>
let things = ['animal', 'vegetable', 'mineral'];
</script>
<ul>
  for (const thing of things) {
    <li>{thing}</li>
  }
</ul>`);

    expect(body).toContain('<!--k-block:b0-->');
    expect(body).toContain('<!--/k-block:b0-->');
    expect(body).toContain('__k$.mount(__kScope, { "b0": __k$.renderer');
  });

  it('wires local client events and their dependent blocks', () => {
    const body = compile(`<script>
let clicked = false;
</script>
<button onClick={clicked = true}>click me</button>
if (clicked) {
  <p>clicked!</p>
}`);

    expect(body).toContain('data-k-on-click="${__esc("clicked = true")}"');
    expect(body).toContain('<!--k-block:b0-->');
    expect(body).toContain('__k$.mount(__kScope, { "b0": __k$.renderer');
  });

  it('hydrates raw HTML inside reactive block renderers through the block anchor', () => {
    const body = compile(`<script>
let content = ['a ', 'b ', 'c '];
</script>
<div>before</div>
for (const c of content) {
  {@html c}
}
<div>after</div>`);

    expect(body).toContain('<!--k-block:b0-->');
    expect(body).toContain('__sanitizeHtml(c)');
    expect(body).toContain('__k$.mount(__kScope, { "b0": __k$.renderer');
  });

  it('marks dynamic text in whitespace-sensitive elements and sibling expressions', () => {
    const body = compile(`<script>
let name = '';
let remaining = 2;
</script>
<pre>
<div><span>{name}</span></div>
</pre>
<span><span>{name}</span>{remaining >= 2 ? ',' : ''}</span>`);

    expect(body).toContain('data-k-text="${__esc("name")}"');
    expect(body).toContain('data-k-text="${__esc("remaining >= 2 ?');
    expect(body).toContain('__k$.mount(__kScope);');
  });
});
