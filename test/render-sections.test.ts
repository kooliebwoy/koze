import { describe, expect, it } from 'vitest';

import { compileTemplate, splitTemplateRenderSections } from '../src/compiler/template.js';

describe('template render sections', () => {
  it('separates conditional head content from body content', () => {
    const template = `if (!user) {
  <head>
    <meta http-equiv="refresh" content="0;url=/auth/signin" />
  </head>
  <p>Redirecting to sign in...</p>
} else {
  <section>Dashboard</section>
}`;

    const sections = splitTemplateRenderSections(template);

    expect(sections.headTemplate).toContain('<meta http-equiv="refresh" content="0;url=/auth/signin" />');
    expect(sections.headTemplate).not.toContain('<p>Redirecting to sign in...</p>');
    expect(sections.bodyTemplate).toContain('<p>Redirecting to sign in...</p>');
    expect(sections.bodyTemplate).not.toContain('<meta http-equiv="refresh" content="0;url=/auth/signin" />');
    expect(sections.headTemplate).toContain('if (!user) {');
    expect(sections.bodyTemplate).toContain('if (!user) {');
  });

  it('does not treat css braces inside style blocks as head control flow', () => {
    const template = `<style>
  .box {
    color: red;
  }
</style>

if (!user) {
  <head>
    <meta http-equiv="refresh" content="0;url=/auth/signin" />
  </head>
  <p>Redirecting to sign in...</p>
} else {
  <section>Dashboard</section>
}`;

    const sections = splitTemplateRenderSections(template);

    expect(sections.bodyTemplate).toContain('<style>');
    expect(sections.bodyTemplate).toContain('  }');
    expect(sections.headTemplate).toContain('if (!user) {');
    expect(sections.headTemplate).not.toContain('.box {');
    expect(sections.headTemplate).not.toContain('color: red;');
    expect(sections.headTemplate).not.toContain('  }');
  });

  it('does not treat script-looking text inside style blocks as script state', () => {
    const template = `<style>
  .icon::before { content: "<script>"; }
</style>
<head>
  <title>Styled</title>
</head>
<main>Body</main>`;

    const sections = splitTemplateRenderSections(template);

    expect(sections.bodyTemplate).toContain('content: "<script>"');
    expect(sections.bodyTemplate).toContain('<main>Body</main>');
    expect(sections.headTemplate).toContain('<title>Styled</title>');
    expect(sections.headTemplate).not.toContain('content: "<script>"');
  });

  it('preserves raw style block expressions while rendering template expressions outside CSS', () => {
    const compiled = compileTemplate(`<style>
  .card::before { content: "{title}"; }
  .card { background-image: url("/icons/{title}.svg"); }
</style>
<main>{title}</main>`);
    const render = new Function(
      'title',
      '__esc',
      '__rawHtml',
      '__sanitizeHtml',
      `${compiled}\nreturn __html;`,
    );
    const html = render(
      'Dashboard',
      (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      (value: unknown) => String(value ?? ''),
      (value: unknown) => String(value ?? ''),
    );

    expect(html).toContain('content: "{title}";');
    expect(html).toContain('url("/icons/{title}.svg")');
    expect(html).toContain('<main>Dashboard</main>');
  });

  it('leaves unknown data- attributes as-is (no fragment instrumentation)', () => {
    // `data-poll` / `data-interval` were removed along with the fragment manifest
    // infrastructure. Live workflow status now lives in the `koze:workflow`
    // virtual module. This test guards against the compiler reintroducing any
    // implicit data-* attribute handling.
    const compiled = compileTemplate(
      `<section data-poll={getStatus(job.id)}>
  <strong>{job.status}</strong>
</section>`,
      undefined,
      undefined,
      new Map([['getStatus', 'rpc_status']]),
      { emitCall: '__emit' },
    );

    expect(compiled).not.toContain('__pushFragment(');
    expect(compiled).not.toContain('__popFragment(');
    expect(compiled).not.toContain('__signFragment(');
    expect(compiled).not.toContain('data-poll-id');
    // The attribute is passed through to the output unchanged.
    expect(compiled).toContain('data-poll=');
  });
});
