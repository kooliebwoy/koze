import { describe, expect, it } from 'vitest';
import { parseKuratchiSfc } from '../src/compiler/sfc-parser.js';

describe('SFC parser', () => {
  it('extracts a single leading script into an AST node', () => {
    const ast = parseKuratchiSfc(`<script type="module">
const count = 1;
</script>
<main>{count}</main>`, { kind: 'route', filePath: 'src/routes/page.koze' });

    expect(ast.kind).toBe('route');
    expect(ast.script?.attrs.trim()).toBe('type="module"');
    expect(ast.script?.content.trim()).toBe('const count = 1;');
    expect(ast.template.source).toBe('<main>{count}</main>');
  });

  it('preserves allowed document prefix before the top script', () => {
    const ast = parseKuratchiSfc(`<!DOCTYPE html>
<!-- shell -->
<script>
const title = 'Home';
</script>
<html><body>{title}</body></html>`, { kind: 'layout' });

    expect(ast.template.source).toBe(`<!DOCTYPE html>
<!-- shell -->
<html><body>{title}</body></html>`);
  });

  it('rejects scripts after template markup', () => {
    const source = `<main>Content</main>
<script>
const late = true;
</script>`;

    expect(() => parseKuratchiSfc(source, { filePath: 'src/routes/page.koze' })).toThrow(
      'Only one top-level <script> block is allowed',
    );
  });

  it('rejects a second script including JSON data scripts', () => {
    const source = `<script>
const count = 1;
</script>
<main>{count}</main>
<script type="application/json">{"count":1}</script>`;

    expect(() => parseKuratchiSfc(source, { filePath: 'src/routes/page.koze' })).toThrow(
      'Only one top-level <script> block is allowed',
    );
  });

  it('ignores commented scripts and non-script tag names', () => {
    const ast = parseKuratchiSfc(`<!-- <script>ignored()</script> -->
<script>
const marker = '</scripture>';
</script>
<scripture>{marker}</scripture>`);

    expect(ast.script?.content).toContain("'</scripture>'");
    expect(ast.template.source).toBe(`<!-- <script>ignored()</script> -->
<scripture>{marker}</scripture>`);
  });

  it('does not discover scripts inside style raw text', () => {
    const ast = parseKuratchiSfc(`<script>
const title = 'Styled';
</script>
<style>
.icon::before { content: "<script></script>"; }
</style>
<main>{title}</main>`);

    expect(ast.script?.content.trim()).toBe("const title = 'Styled';");
    expect(ast.template.source).toContain('content: "<script></script>"');
  });
});
