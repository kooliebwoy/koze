import { describe, expect, it } from 'vitest';
import { collectServerTemplateReferences, parseFile } from '../src/compiler/parser.js';
import {
  findKuratchiSlotSpan,
  getKuratchiTemplateExpressions,
  getKuratchiTemplateAttributeExpression,
  getKuratchiTemplateRawBlocks,
  getKuratchiTemplateTags,
  parseKuratchiTemplate,
  replaceKuratchiSlot,
  stripKuratchiTemplateCompilerIgnoredNodes,
} from '../src/compiler/template-parser.js';

describe('template parser', () => {
  it('parses tags and braced attributes through nested attribute expressions', () => {
    const ast = parseKuratchiTemplate(`<button action={save} onClick={save({ id: item.id })}>{label}</button>`);
    const [button] = getKuratchiTemplateTags(ast);

    expect(button.name).toBe('button');
    expect(button.attrs.find((attr) => attr.name === 'action')?.value).toBe('{save}');
    expect(button.attrs.find((attr) => attr.name === 'onClick')?.value).toBe('{save({ id: item.id })}');
    expect(getKuratchiTemplateAttributeExpression(button, 'action')).toBe('save');
  });

  it('keeps quoted greater-than text and expression comparisons inside tag attributes', () => {
    const ast = parseKuratchiTemplate(`<Panel title="A > B" tone={priority > 1 ? 'high' : 'low'}>
  <p>{title}</p>
</Panel>`);
    const tags = getKuratchiTemplateTags(ast);
    const panel = tags[0];

    expect(panel.name).toBe('Panel');
    expect(panel.attrs.find((attr) => attr.name === 'title')?.value).toBe('"A > B"');
    expect(panel.attrs.find((attr) => attr.name === 'tone')?.value).toBe("{priority > 1 ? 'high' : 'low'}");
    expect(tags.some((tag) => tag.name === 'p')).toBe(true);
  });

  it('parses raw style blocks without treating braces as template expressions', () => {
    const ast = parseKuratchiTemplate(`<style>
@media (min-width: 40rem) {
  .card::before { content: "{notTemplate}"; }
}
</style>
<p>{title}</p>`);
    const expressions = getKuratchiTemplateExpressions(ast).map((node) => node.expression);

    expect(getKuratchiTemplateRawBlocks(ast, 'style')[0].content).toContain('{notTemplate}');
    expect(expressions).toEqual(['title']);
  });

  it('does not let template JS block braces swallow child tags', () => {
    const ast = parseKuratchiTemplate(`for (const item of rows) {
  <button action={save}>{item.name}</button>
}`);
    const tags = getKuratchiTemplateTags(ast);

    expect(tags.some((tag) => tag.name === 'button')).toBe(true);
  });

  it('strips comments and raw blocks before server reference collection', () => {
    const refs = collectServerTemplateReferences(`<style>
.card { color: themeColor; }
</style>
<!-- {commentOnly} -->
<main>{title}</main>`);

    expect(refs.has('themeColor')).toBe(false);
    expect(refs.has('commentOnly')).toBe(false);
    expect(refs.has('title')).toBe(true);
  });

  it('does not let braces inside template JS strings leak local scope', () => {
    const refs = collectServerTemplateReferences(`for (const item of rows) {
  const label = item.label.includes('{') ? item.label : 'missing';
  <p>{label}</p>
}
<p>{item}</p>`);

    expect(refs.has('rows')).toBe(true);
    expect(refs.has('item')).toBe(true);
    expect(refs.has('label')).toBe(false);
  });

  it('tracks destructured template locals without treating property names as bindings', () => {
    const refs = collectServerTemplateReferences(`for (const item of rows) {
  const { id: itemId } = item;
  <p>{itemId}</p>
  <p>{id}</p>
}`);

    expect(refs.has('rows')).toBe(true);
    expect(refs.has('id')).toBe(true);
    expect(refs.has('item')).toBe(false);
    expect(refs.has('itemId')).toBe(false);
  });

  it('does not parse destructuring braces on template JS lines as template expressions', () => {
    const ast = parseKuratchiTemplate(`for (const row of rows) {
  const { item: activeItem } = row;
  <p>{activeItem.label}</p>
}`);

    const expressions = getKuratchiTemplateExpressions(ast).map((node) => node.expression);
    expect(expressions).toEqual(['activeItem.label']);
  });

  it('tracks destructured for-of locals without treating property names as bindings', () => {
    const refs = collectServerTemplateReferences(`for (const { item: activeItem } of rows) {
  <p>{activeItem.label}</p>
  <p>{item.label}</p>
}`);

    expect(refs.has('rows')).toBe(true);
    expect(refs.has('item')).toBe(true);
    expect(refs.has('activeItem')).toBe(false);
  });

  it('tracks classic for-loop locals as template scope bindings', () => {
    const refs = collectServerTemplateReferences(`for (let i = 0; i < rows.length; i++) {
  <p>{i}:{rows[i]}</p>
}`);

    expect(refs.has('rows')).toBe(true);
    expect(refs.has('i')).toBe(false);
  });

  it('tracks catch clause locals as template scope bindings', () => {
    const refs = collectServerTemplateReferences(`try {
} catch ({ message: catchMessage }) {
  <p>{catchMessage}</p>
}`);

    expect(refs.has('catchMessage')).toBe(false);
  });

  it('uses the template AST for route action discovery inside JS control blocks', () => {
    const parsed = parseFile(`<script>
async function save() {}
const rows = [{ id: 1 }];
</script>
for (const row of rows) {
  <button action={save}>{row.id}</button>
}`);

    expect(parsed.actionFunctions).toContain('save');
  });

  it('accepts native property bind targets', () => {
    expect(() => parseFile('<dialog bind:open={isOpen}></dialog>')).not.toThrow();
    expect(() => parseFile('<dialog bind:this={dialogEl}></dialog>')).not.toThrow();
  });

  it('rejects non-expression bind values', () => {
    expect(() => parseFile('<input bind:value="selected">')).toThrow('Invalid bind:value value.');
  });

  it('preserves non-ignored template source while stripping compiler-ignored nodes', () => {
    const ast = parseKuratchiTemplate(`<style>.x { color: red; }</style><main>{title}</main>`);

    expect(stripKuratchiTemplateCompilerIgnoredNodes(ast)).toBe('<main>{title}</main>');
  });

  it('exposes raw blocks and replaces slot nodes without regex matching', () => {
    const ast = parseKuratchiTemplate(`<section>
  <style>.card { color: red; }</style>
  <slot />
</section>`);

    expect(getKuratchiTemplateRawBlocks(ast, 'style')[0].content).toContain('.card');
    expect(findKuratchiSlotSpan(ast)).toEqual({ start: 51, end: 59 });
    expect(replaceKuratchiSlot(ast, '<main>Page</main>')).toContain('<main>Page</main>');
  });
});
