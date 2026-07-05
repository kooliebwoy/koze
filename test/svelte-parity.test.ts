import { afterAll, describe, expect, it } from 'vitest';
import { compile as compileSvelte } from 'svelte/compiler';
import { render as renderSvelteComponent } from 'svelte/server';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { componentFuncName } from '../src/compiler/compiler-shared.js';
import { KuratchiCompilerError } from '../src/compiler/diagnostics.js';
import { compileTemplate } from '../src/compiler/template.js';
import { parseFile } from '../src/compiler/parser.js';
import { parseKuratchiSfc } from '../src/compiler/sfc-parser.js';
import {
  SVELTE_PARITY_FIXTURES,
  getSvelteParityFixtures,
  type SvelteParityFixture,
} from './fixtures/svelte-parity/manifest.js';

const tmpRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp-svelte-parity');

function ensureTmpRoot(): void {
  fs.mkdirSync(tmpRoot, { recursive: true });
}

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows can briefly hold imported modules. Leave tmp files if cleanup races.
  }
});

function buildComponentNames(fixture: SvelteParityFixture): Map<string, string> | undefined {
  if (!fixture.components) return undefined;
  return new Map(Object.entries(fixture.components).map(([name, stub]) => [name, stub.fileName]));
}

function buildComponentStubs(fixture: SvelteParityFixture): string {
  if (!fixture.components) return '';
  return Object.values(fixture.components)
    .map((stub) => `  function ${componentFuncName(stub.fileName)}(props, __esc) {\n${stub.body}\n  }`)
    .join('\n');
}

function buildKuratchiRenderSource(
  fixture: SvelteParityFixture,
  template: string,
  dataVars: string[],
  filePath: string,
): string {
  const body = compileTemplate(template, buildComponentNames(fixture), undefined, undefined, { filePath });
  const destructure = dataVars.length
    ? `  const { ${dataVars.join(', ')} } = data || {};\n`
    : '';
  const componentStubs = buildComponentStubs(fixture);

  return `function render(data) {
${destructure}
  const __rawHtml = (v) => {
    if (v == null) return '';
    return String(v);
  };
  const __sanitizeHtml = (v) => {
    let html = __rawHtml(v);
    html = html.replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, '');
    html = html.replace(/<iframe\\b[^>]*>[\\s\\S]*?<\\/iframe>/gi, '');
    html = html.replace(/<object\\b[^>]*>[\\s\\S]*?<\\/object>/gi, '');
    html = html.replace(/<embed\\b[^>]*>/gi, '');
    html = html.replace(/\\son[a-z]+\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)/gi, '');
    html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*(["'])\\s*javascript:[\\s\\S]*?\\2/gi, ' $1="#"');
    html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*javascript:[^\\s>]+/gi, ' $1="#"');
    html = html.replace(/\\ssrcdoc\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)/gi, '');
    return html;
  };
  const __esc = (v) => {
    if (v == null) return '';
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };
${componentStubs ? `${componentStubs}\n` : ''}  ${body}
  return __html;
}`;
}

function assertKuratchiCompiles(fixture: SvelteParityFixture): string {
  const source = fixture.kozeSource;
  if (!source) throw new Error(`${fixture.id} is missing kozeSource`);

  const filePath = `svelte-parity/${fixture.id}.koze`;
  const sfc = parseKuratchiSfc(source, { kind: 'route', filePath });
  const parsed = parseFile(source, { kind: 'route', filePath });
  const renderSource = buildKuratchiRenderSource(fixture, sfc.template.source, parsed.dataVars, filePath);

  expect(parsed.ir.template.source).toBe(sfc.template.source);
  expect(renderSource).toContain('function render(data)');
  new Function(`${renderSource}; return render;`);

  return renderSource;
}

function assertKuratchiDiagnostic(fixture: SvelteParityFixture): void {
  if (!fixture.expectedKozeErrorCode) {
    throw new Error(`${fixture.id} is missing expectedKozeErrorCode`);
  }

  try {
    assertKuratchiCompiles(fixture);
  } catch (error) {
    expect(error).toBeInstanceOf(KuratchiCompilerError);
    expect((error as KuratchiCompilerError).code).toBe(fixture.expectedKozeErrorCode);
    return;
  }

  throw new Error(`Expected ${fixture.id} to fail with ${fixture.expectedKozeErrorCode}`);
}

function assertSvelteCompiles(fixture: SvelteParityFixture): string {
  const source = fixture.svelteSource;
  if (!source) throw new Error(`${fixture.id} is missing svelteSource`);

  const compiled = compileSvelte(source, {
    generate: 'server',
    dev: false,
  });
  expect(compiled.js.code.length).toBeGreaterThan(0);
  return compiled.js.code;
}

function renderKuratchi(fixture: SvelteParityFixture): string {
  const renderSource = assertKuratchiCompiles(fixture);
  const render = new Function(`${renderSource}; return render;`)() as (data?: Record<string, unknown>) => string;
  return render(fixture.data ?? {});
}

async function renderSvelte(fixture: SvelteParityFixture): Promise<string> {
  ensureTmpRoot();
  const compiled = assertSvelteCompiles(fixture);
  const safeName = fixture.id.replace(/[^A-Za-z0-9_-]/g, '_');
  const filePath = path.join(tmpRoot, `${safeName}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(filePath, compiled, 'utf8');
  const mod = await import(`${pathToFileURL(filePath).href}?t=${Date.now()}`);
  const result = renderSvelteComponent(mod.default);
  return result.html ?? result.body ?? '';
}

function normalizeHtml(html: string): string {
  return sortHtmlAttributes(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s(disabled|checked|selected|readonly|required|hidden|open|multiple|autofocus)=""/g, ' $1')
    .replace(/<input([^>]*)\/>/g, '<input$1>')
    .replace(/<circle([^>]*)><\/circle>/g, '<circle$1/>')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&gt;/g, '>')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .replace(/\s+>/g, '>')
    .trim();
}

function sortHtmlAttributes(html: string): string {
  let out = '';
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }

    out += html.slice(i, lt);
    const next = html[lt + 1];
    if (!next || next === '/' || next === '!' || !/[A-Za-z]/.test(next)) {
      out += html[lt];
      i = lt + 1;
      continue;
    }

    const end = findTagEnd(html, lt);
    if (end === -1) {
      out += html.slice(lt);
      break;
    }

    out += sortTagAttributes(html.slice(lt, end + 1));
    i = end + 1;
  }

  return out;
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = start + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

function sortTagAttributes(tag: string): string {
  const match = tag.match(/^<([A-Za-z][\w:-]*)([\s\S]*?)>$/);
  if (!match) return tag;

  const [, name, rawAttrs] = match;
  if (!rawAttrs.trim()) return tag;

  const selfClosing = /\/\s*$/.test(rawAttrs);
  const attrsSource = selfClosing ? rawAttrs.replace(/\/\s*$/, '') : rawAttrs;
    const attrs: Array<{ name: string; raw: string; index: number }> = [];
    let i = 0;

    while (i < attrsSource.length) {
      while (i < attrsSource.length && /\s/.test(attrsSource[i])) i++;
      if (i >= attrsSource.length) break;

      const start = i;
      while (i < attrsSource.length && /[^\s=/>]/.test(attrsSource[i])) i++;
      const attrName = attrsSource.slice(start, i);
      if (!attrName) {
        i++;
        continue;
      }

      while (i < attrsSource.length && /\s/.test(attrsSource[i])) i++;
      if (attrsSource[i] === '=') {
        i++;
        while (i < attrsSource.length && /\s/.test(attrsSource[i])) i++;
        if (attrsSource[i] === '"' || attrsSource[i] === "'") {
          const quote = attrsSource[i++];
          while (i < attrsSource.length) {
            if (attrsSource[i] === quote) {
              i++;
              break;
            }
            i++;
          }
        } else {
          while (i < attrsSource.length && !/\s/.test(attrsSource[i])) i++;
        }
      }

      attrs.push({
        name: attrName.toLowerCase(),
        raw: attrsSource.slice(start, i).trim(),
        index: attrs.length,
      });
    }

    if (attrs.length === 0) return tag;
    const sorted = attrs
      .sort((a, b) => a.name.localeCompare(b.name) || a.index - b.index)
      .map((attr) => attr.raw)
      .join(' ');
  return `<${name} ${sorted}${selfClosing ? '/' : ''}>`;
}

describe('Svelte parity matrix', () => {
  const portedPass = getSvelteParityFixtures('ported-pass');
  const portedFail = getSvelteParityFixtures('ported-fail');
  const futureFeature = getSvelteParityFixtures('future-feature');
  const intentionalDivergence = getSvelteParityFixtures('intentional-divergence');
  const notApplicable = getSvelteParityFixtures('not-applicable');

  it('tracks applicable Svelte parity coverage explicitly', () => {
    expect(portedPass.length).toBeGreaterThanOrEqual(60);
    expect(portedFail).toHaveLength(0);
    expect(futureFeature).toHaveLength(0);
    expect(intentionalDivergence.length).toBeGreaterThan(0);
    expect(notApplicable.length).toBeGreaterThan(0);
    expect(new Set(SVELTE_PARITY_FIXTURES.map((fixture) => fixture.id)).size).toBe(SVELTE_PARITY_FIXTURES.length);
  });

  for (const fixture of portedPass) {
    it(`${fixture.assertion ?? 'compile'}: ${fixture.id}`, async () => {
      if (fixture.assertion === 'diagnostic') {
        assertKuratchiDiagnostic(fixture);
        if (fixture.svelteShouldThrow) {
          expect(() => assertSvelteCompiles(fixture)).toThrow();
        }
        return;
      }

      assertKuratchiCompiles(fixture);
      assertSvelteCompiles(fixture);

      if (fixture.assertion === 'render') {
        const kuratchiHtml = normalizeHtml(renderKuratchi(fixture));
        const svelteHtml = normalizeHtml(await renderSvelte(fixture));
        expect(kuratchiHtml).toBe(svelteHtml);
      }
    });
  }
});
