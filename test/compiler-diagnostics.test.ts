import { describe, expect, it } from 'vitest';

import { KuratchiCompilerError } from '../src/compiler/diagnostics.js';
import { parseFile } from '../src/compiler/parser.js';
import { parseKuratchiSfc } from '../src/compiler/sfc-parser.js';

function expectCompilerError(run: () => unknown): KuratchiCompilerError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(KuratchiCompilerError);
    return error as KuratchiCompilerError;
  }
  throw new Error('Expected compiler error');
}

describe('compiler diagnostics', () => {
  it('reports stable diagnostics for unclosed script tags and blocks', () => {
    const tagError = expectCompilerError(() => parseKuratchiSfc(
      `<script
const value = 1;`,
      { kind: 'route', filePath: 'src/routes/unclosed-tag.koze' },
    ));
    expect(tagError.code).toBe('KUR_UNCLOSED_SCRIPT_TAG');
    expect(tagError.filePath).toBe('src/routes/unclosed-tag.koze');
    expect(tagError.line).toBe(1);

    const blockError = expectCompilerError(() => parseKuratchiSfc(
      `<script>
const value = 1;`,
      { kind: 'route', filePath: 'src/routes/unclosed-block.koze' },
    ));
    expect(blockError.code).toBe('KUR_UNCLOSED_SCRIPT_BLOCK');
    expect(blockError.filePath).toBe('src/routes/unclosed-block.koze');
    expect(blockError.line).toBe(1);
  });

  it('reports stable diagnostics for invalid top-level script syntax', () => {
    const error = expectCompilerError(() => parseFile(`<script>
const value = ;
</script>
<p>{value}</p>`, { kind: 'route', filePath: 'src/routes/broken.koze' }));

    expect(error.code).toBe('KUR_SCRIPT_SYNTAX');
    expect(error.filePath).toBe('src/routes/broken.koze');
    expect(error.line).toBe(2);
    expect(error.column).toBeGreaterThan(0);
    expect(error.message).toContain('KUR_SCRIPT_SYNTAX');
  });

  it('reports stable diagnostics for invalid template expression syntax', () => {
    const error = expectCompilerError(() => parseFile(`<script>
const value = 1;
</script>
<p>{value(}</p>`, { kind: 'route', filePath: 'src/routes/broken-template.koze' }));

    expect(error.code).toBe('KUR_TEMPLATE_EXPRESSION_SYNTAX');
    expect(error.filePath).toBe('src/routes/broken-template.koze');
    expect(error.line).toBe(1);
    expect(error.column).toBeGreaterThan(0);
  });

  it('reports stable diagnostics for invalid attribute expression syntax', () => {
    const error = expectCompilerError(() => parseFile(`<script>
const value = 1;
</script>
<button data-value={value(}>Broken</button>`, { kind: 'route', filePath: 'src/routes/broken-attr.koze' }));

    expect(error.code).toBe('KUR_TEMPLATE_ATTRIBUTE_SYNTAX');
    expect(error.filePath).toBe('src/routes/broken-attr.koze');
  });

  it('reports stable diagnostics for invalid quoted attribute interpolation syntax', () => {
    const syntaxError = expectCompilerError(() => parseFile(
      `<a href="/users/{user.(id)}">Broken</a>`,
      { kind: 'route', filePath: 'src/routes/broken-quoted-attr.koze' },
    ));

    expect(syntaxError.code).toBe('KUR_TEMPLATE_ATTRIBUTE_SYNTAX');
    expect(syntaxError.filePath).toBe('src/routes/broken-quoted-attr.koze');
    expect(syntaxError.line).toBe(1);

    const unmatchedError = expectCompilerError(() => parseFile(
      `<a href="/users/{user.id">Broken</a>`,
      { kind: 'route', filePath: 'src/routes/unmatched-quoted-attr.koze' },
    ));

    expect(unmatchedError.code).toBe('KUR_TEMPLATE_ATTRIBUTE_SYNTAX');
    expect(unmatchedError.message).toContain('Unmatched `{`');
  });

  it('reports stable diagnostics for invalid bind directives', () => {
    const targetError = expectCompilerError(() => parseFile(
      `<dialog bind:this></dialog>`,
      { kind: 'route', filePath: 'src/routes/bad-bind-target.koze' },
    ));
    expect(targetError.code).toBe('KUR_TEMPLATE_ATTRIBUTE_SYNTAX');
    expect(targetError.hint).toContain('bind:this={element}');

    const valueError = expectCompilerError(() => parseFile(
      `<input bind:value="name">`,
      { kind: 'route', filePath: 'src/routes/bad-bind-value.koze' },
    ));
    expect(valueError.code).toBe('KUR_TEMPLATE_ATTRIBUTE_SYNTAX');
    expect(valueError.filePath).toBe('src/routes/bad-bind-value.koze');
    expect(valueError.hint).toContain('bind:value={value}');
  });

  it('reports stable diagnostics for removed raw-html shorthand', () => {
    const error = expectCompilerError(() => parseFile(
      `<script>
const content = '<b>x</b>';
</script>
{=html content}`,
      { kind: 'route', filePath: 'src/routes/removed-html.koze' },
    ));

    expect(error.code).toBe('KUR_TEMPLATE_EXPRESSION_SYNTAX');
    expect(error.filePath).toBe('src/routes/removed-html.koze');
    expect(error.line).toBe(1);
    expect(error.message).toContain('Use `{@raw ...}` instead');
  });

  it('reports stable diagnostics when Cloudflare env leaks into route script scope', () => {
    const error = expectCompilerError(() => parseFile(
      `<script>
import { env } from 'cloudflare:workers';
const secret = env.AUTH_SECRET;
</script>
<p>{secret}</p>`,
      { kind: 'route', filePath: 'src/routes/env-leak.koze' },
    ));

    expect(error.code).toBe('KUR_ENV_ACCESS');
    expect(error.filePath).toBe('src/routes/env-leak.koze');
    expect(error.hint).toContain('$server');
  });

  it('reports stable diagnostics for late or duplicate scripts', () => {
    const error = expectCompilerError(() => parseKuratchiSfc(`<main>Content</main>
<script>
const late = true;
</script>`, { filePath: 'src/routes/late.koze' }));

    expect(error.code).toBe('KUR_SCRIPT_PLACEMENT');
    expect(error.filePath).toBe('src/routes/late.koze');
  });

  it('allows document scripts in app.koze template markup', () => {
    const cdnOnly = parseFile(`<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.example.com/widget.js"></script>
</head>
<body><slot></slot></body>
</html>`, { kind: 'route', filePath: 'src/app.koze' });

    expect(cdnOnly.script).toBeNull();
    expect(cdnOnly.template).toContain('<script src="https://cdn.example.com/widget.js"></script>');

    const withLeadingCompilerScript = parseFile(`<script>
const title = 'App';
</script>
<!DOCTYPE html>
<html>
<head>
  <title>{title}</title>
  <script defer src="https://cdn.example.com/widget.js"></script>
</head>
<body><slot></slot></body>
</html>`, { kind: 'route', filePath: 'src/app.koze' });

    expect(withLeadingCompilerScript.script).toContain("const title = 'App';");
    expect(withLeadingCompilerScript.template).toContain('<script defer src="https://cdn.example.com/widget.js"></script>');
  });
});
