/**
 * Template compiler â€” native JS flow control in HTML.
 *
 * Syntax:
 *   {expression}                â†’ escaped output
 *   {@html expression}          â†’ sanitized HTML output
 *   {@raw expression}           â†’ raw HTML output (unescaped)
 *   for (const x of arr) {     â†’ JS for loop (inline in HTML)
 *     <li>{x.name}</li>
 *   }
 *   if (condition) {            â†’ JS if block
 *     <p>yes</p>
 *   } else {
 *     <p>no</p>
 *   }
 *
 * The compiler scans line-by-line:
 *   - Lines that are pure JS control flow (for/if/else/}) â†’ emitted as JS
 *   - Everything else â†’ emitted as HTML string with {expr} interpolation
 */

import ts from 'typescript';
import { componentFuncName } from './compiler-shared.js';
import { createCompilerError } from './diagnostics.js';
import { collectReferencedIdentifiers } from './import-linking.js';
import { collectServerTemplateReferences } from './parser.js';
import {
  buildClientScopeMount,
  collectReactiveClientScriptNames,
  collectTopLevelClientScopeBindings,
  transformReactiveClientScript,
} from './script-transform.js';
import {
  getKuratchiTemplateRawBlocks,
  parseKuratchiTemplate,
} from './template-parser.js';
import { validateKuratchiTemplate } from './validation.js';

// Patterns that identify a line as JS control flow (trimmed)
const JS_CONTROL_PATTERNS = [
  /^\s*for\s*\(/, // for (...)
  /^\s*if\s*\(/,  // if (...)
  /^\s*while\s*\(/, // while (...)
  /^\s*switch\s*\(/, // switch (...)
  /^\s*case\s+.+:\s*$/, // case ...:
  /^\s*default\s*:\s*$/, // default:
  /^\s*do\s*\{?\s*$/, // do {
  /^\s*try\s*\{?\s*$/, // try {
  /^\s*\}?\s*catch\s*\(/, // catch (...) { or } catch (...) {
  /^\s*\}?\s*finally\s*\{?\s*$/, // finally { or } finally {
  /^\s*\}\s*while\s*\(/, // } while (...);
  /^\s*break\s*;\s*$/, // break;
  /^\s*continue\s*;\s*$/, // continue;
  /^\s*throw\b[\s\S]*;\s*$/, // throw ...;
  /^\s*\}\s*else\s*if\s*\(/, // } else if (...)
  /^\s*\}\s*else\s*\{?\s*$/, // } else {  or  } else
  /^\s*\}\s*$/,   // }
  /^\s*\w[\w.]*\s*(\+\+|--)\s*;\s*$/, // varName++;  varName--;
  /^\s*(let|const|var)\s+/, // let x = ...; const y = ...;
];

function isJsControlLine(line: string): boolean {
  return JS_CONTROL_PATTERNS.some(p => p.test(line));
}

function stripHtmlCommentsForBlockDetection(line: string): string {
  return line.replace(/<!--[\s\S]*?-->/g, '');
}

/** HTML boolean attributes that should be present or absent, never have a value */
const BOOLEAN_ATTRIBUTES = new Set([
  'disabled',
  'checked',
  'selected',
  'readonly',
  'required',
  'hidden',
  'open',
  'autofocus',
  'autoplay',
  'controls',
  'default',
  'defer',
  'formnovalidate',
  'inert',
  'ismap',
  'itemscope',
  'loop',
  'multiple',
  'muted',
  'nomodule',
  'novalidate',
  'playsinline',
  'reversed',
  'async',
]);

function isBooleanAttribute(name: string): boolean {
  return BOOLEAN_ATTRIBUTES.has(name.toLowerCase());
}

export interface TemplateRenderSections {
  bodyTemplate: string;
  headTemplate: string;
}

export interface CompileTemplateOptions {
  emitCall?: string;
  appendNewline?: boolean;
  filePath?: string;
  validate?: boolean;
  clientRouteRegistry?: ClientRouteRegistry;
  reactiveOwnerId?: string;
  awaitQueryBindings?: Map<string, { asName: string; rpcId: string }>;
  internalSkipReactiveBlocks?: boolean;
  internalReactiveBlocks?: ReactiveBlockRenderer[];
  liveTemplateNames?: Set<string>;
  clientScriptBody?: string;
  /** Directory of the importing file, used for rewriting $lib/ imports */
  importerDir?: string;
  /** Action state objects created by augment(action, hooks?) */
  augmentedActionNames?: Set<string>;
}

export function splitTemplateRenderSections(template: string): TemplateRenderSections {
  const bodyLines: string[] = [];
  const headLines: string[] = [];
  const lines = template.split('\n');
  let inHead = false;
  let inStyle = false;
  let inScript = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const structuralTrimmed = stripHtmlCommentsForBlockDetection(line).trim();
    const opensStyle = !inScript && /<style[\s>]/i.test(structuralTrimmed);
    const closesStyle = (inStyle || opensStyle) && /<\/style>/i.test(structuralTrimmed);
    const opensScript = !inStyle && !opensStyle && /<script[\s>]/i.test(structuralTrimmed);
    const closesScript = (inScript || opensScript) && /<\/script>/i.test(structuralTrimmed);
    const inRawBlock = inStyle || inScript || opensStyle || opensScript;

    if (inRawBlock) {
      let remaining = line;
      let bodyLine = '';
      let headLine = '';

      while (remaining.length > 0) {
        if (!inHead) {
          const openMatch = remaining.match(/<head(?:\s[^>]*)?>/i);
          if (!openMatch || openMatch.index === undefined) {
            bodyLine += remaining;
            break;
          }

          bodyLine += remaining.slice(0, openMatch.index);
          remaining = remaining.slice(openMatch.index + openMatch[0].length);

          const closeMatch = remaining.match(/<\/head>/i);
          if (!closeMatch || closeMatch.index === undefined) {
            headLine += remaining;
            remaining = '';
            inHead = true;
            break;
          }

          headLine += remaining.slice(0, closeMatch.index);
          remaining = remaining.slice(closeMatch.index + closeMatch[0].length);
        } else {
          const closeMatch = remaining.match(/<\/head>/i);
          if (!closeMatch || closeMatch.index === undefined) {
            headLine += remaining;
            remaining = '';
            break;
          }

          headLine += remaining.slice(0, closeMatch.index);
          remaining = remaining.slice(closeMatch.index + closeMatch[0].length);
          inHead = false;
        }
      }

      bodyLines.push(bodyLine);
      headLines.push(headLine);

      if (opensStyle && !closesStyle) inStyle = true;
      if (closesStyle) inStyle = false;
      if (opensScript && !closesScript) inScript = true;
      if (closesScript) inScript = false;
      continue;
    }

    if (isJsControlLine(trimmed) && !/<\/?head(?:\s|>)/i.test(line)) {
      bodyLines.push(line);
      headLines.push(line);
      continue;
    }

    let remaining = line;
    let bodyLine = '';
    let headLine = '';

    while (remaining.length > 0) {
      if (!inHead) {
        const openMatch = remaining.match(/<head(?:\s[^>]*)?>/i);
        if (!openMatch || openMatch.index === undefined) {
          bodyLine += remaining;
          break;
        }

        bodyLine += remaining.slice(0, openMatch.index);
        remaining = remaining.slice(openMatch.index + openMatch[0].length);

        const closeMatch = remaining.match(/<\/head>/i);
        if (!closeMatch || closeMatch.index === undefined) {
          headLine += remaining;
          remaining = '';
          inHead = true;
          break;
        }

        headLine += remaining.slice(0, closeMatch.index);
        remaining = remaining.slice(closeMatch.index + closeMatch[0].length);
      } else {
        const closeMatch = remaining.match(/<\/head>/i);
        if (!closeMatch || closeMatch.index === undefined) {
          headLine += remaining;
          remaining = '';
          break;
        }

        headLine += remaining.slice(0, closeMatch.index);
        remaining = remaining.slice(closeMatch.index + closeMatch[0].length);
        inHead = false;
      }
    }

    bodyLines.push(bodyLine);
    headLines.push(headLine);
  }

  return {
    bodyTemplate: bodyLines.join('\n'),
    headTemplate: headLines.join('\n'),
  };
}

function buildAppendStatement(expression: string, emitCall?: string): string {
  // When emitCall is provided, use it (e.g., __emit(expr))
  // Otherwise, use array push for O(n) performance
  return emitCall ? `${emitCall}(${expression});` : `__parts.push(${expression});`;
}

function buildActionPropRef(expression: string): string {
  return `{ __kozeAction: ${JSON.stringify(expression)}, error: (${expression})?.error, pending: (${expression})?.pending, success: (${expression})?.success }`;
}

function isAttributeSpreadContext(line: string, braceIdx: number): boolean {
  if (findQuotedAttributeContext(line, braceIdx)) return false;
  const lastOpen = line.lastIndexOf('<', braceIdx);
  if (lastOpen === -1) return false;
  const lastClose = line.lastIndexOf('>', braceIdx);
  if (lastClose > lastOpen) return false;
  const before = line.slice(lastOpen, braceIdx);
  return !/=\s*$/.test(before);
}

function buildSpreadAttributesExpression(expression: string): string {
  const booleanAttrs = JSON.stringify(Array.from(BOOLEAN_ATTRIBUTES));
  return `\${(() => {
    const __attrs = (${expression});
    if (__attrs == null || __attrs === false) return '';
    const __bool = new Set(${booleanAttrs});
    let __out = '';
    for (const [__name, __value] of Object.entries(Object(__attrs))) {
      if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(__name)) continue;
      if (/^on/i.test(__name)) continue;
      if (typeof __value === 'function' || typeof __value === 'symbol') continue;
      const __lower = __name.toLowerCase();
      if (__value == null) continue;
      if (__bool.has(__lower)) {
        if (__lower === 'hidden' && __value === 'until-found') {
          __out += ' ' + __name + '="until-found"';
          continue;
        }
        if (__value) __out += ' ' + __name;
        continue;
      }
      __out += ' ' + __name + '="' + __esc(__value) + '"';
    }
    return __out;
  })()}`;
}

function escapeStaticAttributeValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeTextareaValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitAttributeValue(attrs: string, targetName: string): { attrs: string; value: string } | null {
  let i = 0;
  let output = '';
  let value: string | null = null;
  const normalizedTarget = targetName.toLowerCase();

  while (i < attrs.length) {
    const tokenStart = i;
    while (i < attrs.length && /\s/.test(attrs[i])) i++;
    if (i >= attrs.length) {
      output += attrs.slice(tokenStart);
      break;
    }

    const nameStart = i;
    while (i < attrs.length && /[^\s=/>]/.test(attrs[i])) i++;
    const name = attrs.slice(nameStart, i);
    if (!name) {
      output += attrs.slice(tokenStart, Math.min(attrs.length, i + 1));
      i++;
      continue;
    }

    while (i < attrs.length && /\s/.test(attrs[i])) i++;
    if (attrs[i] !== '=') {
      output += attrs.slice(tokenStart, i);
      continue;
    }

    i++;
    while (i < attrs.length && /\s/.test(attrs[i])) i++;
    const valueStart = i;
    if (attrs[i] === '"' || attrs[i] === "'") {
      const quote = attrs[i];
      i++;
      while (i < attrs.length) {
        if (attrs[i] === '\\') {
          i += 2;
          continue;
        }
        if (attrs[i] === quote) {
          i++;
          break;
        }
        i++;
      }
    } else if (attrs[i] === '{') {
      const closeIdx = findClosingBrace(attrs, i);
      i = closeIdx === -1 ? attrs.length : closeIdx + 1;
    } else {
      while (i < attrs.length && !/\s/.test(attrs[i])) i++;
    }

    const rawValue = attrs.slice(valueStart, i);
    if (name.toLowerCase() === normalizedTarget && value == null) {
      value = normalizeTextareaValue(rawValue);
      continue;
    }
    output += attrs.slice(tokenStart, i);
  }

  return value == null ? null : { attrs: output.trimEnd(), value };
}

function rewriteTextareaTags(
  line: string,
  rewrite: (match: string, attrs: string) => string,
): string {
  const openRe = /<textarea\b/gi;
  let cursor = 0;
  let output = '';

  while (cursor < line.length) {
    openRe.lastIndex = cursor;
    const match = openRe.exec(line);
    if (!match) break;

    const start = match.index;
    const tagEnd = findComponentTagEnd(line, start + 1);
    if (tagEnd === -1) break;

    const rawInner = line.slice(start + '<textarea'.length, tagEnd);
    const selfClosing = /\/\s*$/.test(rawInner);
    const attrs = rawInner.replace(/\/\s*$/, '');

    if (selfClosing) {
      output += line.slice(cursor, start);
      output += rewrite(line.slice(start, tagEnd + 1), attrs);
      cursor = tagEnd + 1;
      continue;
    }

    const afterOpen = line.slice(tagEnd + 1);
    const closeMatch = afterOpen.match(/^\s*<\/textarea\s*>/i);
    if (!closeMatch) {
      output += line.slice(cursor, tagEnd + 1);
      cursor = tagEnd + 1;
      continue;
    }

    const end = tagEnd + 1 + closeMatch[0].length;
    output += line.slice(cursor, start);
    output += rewrite(line.slice(start, end), attrs);
    cursor = end;
  }

  return output + line.slice(cursor);
}

function rewriteTextareaValue(line: string): string {
  return rewriteTextareaTags(line, (_match, attrs) => {
    const split = splitAttributeValue(attrs, 'value');
    if (!split) return _match;
    return `<textarea${split.attrs}>${split.value}</textarea>`;
  });
}

function expandBindShorthands(line: string): string {
  return line.replace(/\bbind:([A-Za-z_$][\w$-]*)\b(?!\s*=)/g, (match, name: string) => {
    if (name === 'this') return match;
    return `bind:${name}={${name.replace(/-/g, '_')}}`;
  });
}

function buildLocalScopeAttributeSource(expression: string, activeLocalNames: string[]): string {
  const names = getReferencedLocalScopeNames(expression, activeLocalNames);
  if (names.length === 0) return '';
  return ` data-k-scope={encodeURIComponent(JSON.stringify({ ${names.join(', ')} }))}`;
}

function buildReactiveOwnerAttribute(options: CompileTemplateOptions): string {
  return options.reactiveOwnerId
    ? ` data-k-owner="${escapeStaticAttributeValue(options.reactiveOwnerId)}"`
    : '';
}

function reactiveBlockMarker(id: string, options: CompileTemplateOptions): string {
  return options.reactiveOwnerId ? `o:${options.reactiveOwnerId}:${id}` : id;
}

function reactiveHtmlMarker(marker: string, options: CompileTemplateOptions): string {
  return options.reactiveOwnerId ? `o:${options.reactiveOwnerId}:${marker}` : marker;
}

function rewriteTextareaBindValue(line: string, activeLocalNames: string[], options: CompileTemplateOptions): string {
  return rewriteTextareaTags(line, (match, attrs) => {
    const split = splitAttributeValue(attrs, 'bind:value');
    if (!split) return match;

    const normalized = normalizeTextareaValue(split.value);
    if (!normalized.startsWith('{') || !normalized.endsWith('}')) return match;

    const expression = normalized.slice(1, -1).trim();
    if (!expression) return match;

    return `<textarea${split.attrs} data-k-bind-value="${escapeStaticAttributeValue(expression)}"${buildReactiveOwnerAttribute(options)}${buildLocalScopeAttributeSource(expression, activeLocalNames)}>{${expression}}</textarea>`;
  });
}

function normalizeStaticClassAttributes(line: string): string {
  return line.replace(/\bclass\s*=\s*(["'])([\s\S]*?)\1/g, (match, quote: string, value: string) => {
    if (value.includes('{')) return match;
    const normalized = value.replace(/\s+/g, ' ').trim();
    return `class=${quote}${normalized}${quote}`;
  });
}

function attributeValueToExpression(value: string): string {
  const normalized = normalizeTextareaValue(value);
  if (normalized.startsWith('{') && normalized.endsWith('}')) {
    return normalized.slice(1, -1).trim();
  }
  return JSON.stringify(normalized);
}

function findClosingTag(source: string, from: number, tagName: string): { start: number; end: number } | null {
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
  closeRe.lastIndex = from;
  const match = closeRe.exec(source);
  if (!match) return null;
  return { start: match.index, end: match.index + match[0].length };
}

function rewriteOptionSelected(content: string, selectedExpr: string): string {
  const openRe = /<option\b/gi;
  let cursor = 0;
  let output = '';

  while (cursor < content.length) {
    openRe.lastIndex = cursor;
    const match = openRe.exec(content);
    if (!match) break;

    const start = match.index;
    const tagEnd = findComponentTagEnd(content, start + 1);
    if (tagEnd === -1) break;

    const close = findClosingTag(content, tagEnd + 1, 'option');
    if (!close) {
      output += content.slice(cursor, tagEnd + 1);
      cursor = tagEnd + 1;
      continue;
    }

    const attrs = content.slice(start + '<option'.length, tagEnd);
    const optionBody = content.slice(tagEnd + 1, close.start);
    const optionMatch = content.slice(start, close.end);
    if (/\sselected(?:\s|=|$)/i.test(attrs)) {
      output += content.slice(cursor, start) + optionMatch;
      cursor = close.end;
      continue;
    }

    const optionValue = splitAttributeValue(attrs, 'value');
    let optionExpr: string | null = optionValue ? attributeValueToExpression(optionValue.value) : null;
    if (!optionExpr) {
      const implicitValue = optionBody.trim();
      if (!implicitValue || /[<{]/.test(implicitValue)) {
        output += content.slice(cursor, start) + optionMatch;
        cursor = close.end;
        continue;
      }
      optionExpr = JSON.stringify(implicitValue);
    }

    output += content.slice(cursor, start);
    output += `<option${attrs} selected={${selectedExpr} === ${optionExpr}}>${optionBody}</option>`;
    cursor = close.end;
  }

  return output + content.slice(cursor);
}

function rewriteSelectValue(template: string): string {
  const openRe = /<select\b/gi;
  let cursor = 0;
  let output = '';

  while (cursor < template.length) {
    openRe.lastIndex = cursor;
    const match = openRe.exec(template);
    if (!match) break;

    const start = match.index;
    const tagEnd = findComponentTagEnd(template, start + 1);
    if (tagEnd === -1) break;

    const close = findClosingTag(template, tagEnd + 1, 'select');
    if (!close) {
      output += template.slice(cursor, tagEnd + 1);
      cursor = tagEnd + 1;
      continue;
    }

    const attrs = template.slice(start + '<select'.length, tagEnd);
    const content = template.slice(tagEnd + 1, close.start);
    const fullMatch = template.slice(start, close.end);
    const split = splitAttributeValue(attrs, 'value');
    if (!split) {
      output += template.slice(cursor, start) + fullMatch;
      cursor = close.end;
      continue;
    }

    const selectedExpr = attributeValueToExpression(split.value);
    const rewrittenContent = rewriteOptionSelected(content, selectedExpr);

    output += template.slice(cursor, start);
    output += `<select${split.attrs}>${rewrittenContent}</select>`;
    cursor = close.end;
  }

  return output + template.slice(cursor);
}

interface ClientScriptTransformOptions {
  needsReactiveRuntime?: boolean;
  reactiveNames?: Iterable<string>;
  blockRenderers?: ReactiveBlockRenderer[];
  reactiveOwnerId?: string;
}

export interface ReactiveBlockRenderer {
  id: string;
  source: string;
  renderer: string;
  localNames: string[];
  startLine: number;
  endLine: number;
}

function localizeReactiveBlockRenderers(
  blockRenderers: ReactiveBlockRenderer[],
  startLine: number,
  endLine: number,
): ReactiveBlockRenderer[] {
  return blockRenderers
    .filter((renderer) => renderer.startLine >= startLine && renderer.endLine < endLine)
    .map((renderer) => ({
      ...renderer,
      startLine: renderer.startLine - startLine,
      endLine: renderer.endLine - startLine,
    }));
}

export interface ClientTemplateReactivityPlan {
  reactiveNames: Set<string>;
  blockRenderers: ReactiveBlockRenderer[];
}

interface TemplateLocalScope {
  names: string[];
  depth: number;
}

/**
 * Compile a template string into a JS render function body.
 *
 * The generated code expects `data` in scope (destructured load return)
 * and an `__esc` helper for HTML-escaping.
 */
export function compileTemplate(
  template: string,
  componentNames?: Map<string, string>,
  actionNames?: Set<string>,
  rpcNameMap?: Map<string, string>,
  options: CompileTemplateOptions = {},
): string {
  if (options.validate !== false) {
    validateKuratchiTemplate(parseKuratchiTemplate(template), { filePath: options.filePath });
  }
  template = rewriteSelectValue(template);

  const hasBindDirectives = /\bbind:[\w-]+(?:\s*=|(?=[\s>/]))/.test(template);
  const clientTemplateRefs = collectServerTemplateReferences(template);
  const clientScriptBody = options.clientScriptBody ?? extractFirstClientScriptBody(template);
  const topLevelBindings = clientScriptBody
    ? collectTopLevelClientScopeBindings(clientScriptBody)
    : { exposed: [], mutable: new Set<string>(), reactive: new Set<string>() };
  const topLevelReactiveLets = topLevelBindings.reactive;
  const topLevelMutableNames = topLevelBindings.mutable;
  const topLevelScopeNames = new Set(topLevelBindings.exposed);
  const liveActionNames = options.augmentedActionNames ?? new Set<string>();
  const liveReactiveNames = new Set([...topLevelReactiveLets, ...liveActionNames]);
  const reactiveTemplateRefs = Array.from(clientTemplateRefs).filter((name) => liveReactiveNames.has(name));
  const reactiveNames = clientScriptBody
    ? collectReactiveClientScriptNames(clientScriptBody, reactiveTemplateRefs)
    : new Set<string>(reactiveTemplateRefs);
  for (const name of liveActionNames) reactiveNames.add(name);
  const liveTemplateNames = options.liveTemplateNames ?? reactiveNames;
  const hasReactiveTemplateReads = Array.from(clientTemplateRefs).some((name) => liveTemplateNames.has(name));
  const blockRenderers = options.internalSkipReactiveBlocks
    ? []
    : options.internalReactiveBlocks
      ?? collectReactiveBlockRenderers(template, liveReactiveNames, topLevelScopeNames, topLevelMutableNames, componentNames, actionNames, rpcNameMap, options);
  const needsReactiveRuntime = hasBindDirectives || hasReactiveTemplateReads || blockRenderers.length > 0;
  const blockRendererByStartLine = new Map(blockRenderers.map((renderer) => [renderer.startLine, renderer]));
  const blockRendererByEndLine = new Map(blockRenderers.map((renderer) => [renderer.endLine, renderer]));
  const emitCall = options.emitCall;
  // Use array accumulation for O(n) performance instead of O(n²) string concatenation
  const useArrayAccum = !emitCall;
  const out: string[] = useArrayAccum ? ['const __parts = [];'] : ['let __html = "";'];
  const lines = template.split('\n');
  let inStyle = false;
  let inScript = false;
  let scriptBuffer: string[] = [];
  let inHtmlTag = false;
  let htmlAttrQuote: '"' | "'" | null = null;
  let templateBlockDepth = 0;
  const localScopeStack: TemplateLocalScope[] = [];
  let templateReactivityMountEmitted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const structuralTrimmed = stripHtmlCommentsForBlockDetection(line).trim();

    // Track <style> blocks â€” emit CSS as literal, no parsing
    if (structuralTrimmed.match(/<style[\s>]/i)) inStyle = true;
    if (inStyle) {
      out.push(buildAppendStatement(`\`${escapeLiteral(line)}\\n\``, emitCall));
      if (structuralTrimmed.match(/<\/style>/i)) inStyle = false;
      continue;
    }

    // Track <script> blocks â€” transform reactive ($:) client syntax first.
    if (!inScript && structuralTrimmed.match(/<script[\s>]/i)) {
      inScript = true;
      scriptBuffer = [line];
      if (structuralTrimmed.match(/<\/script>/i)) {
        const shouldMountTemplateReactivity = needsReactiveRuntime && !templateReactivityMountEmitted;
        const transformed = transformClientScriptBlock(scriptBuffer.join('\n'), options.clientRouteRegistry, options.importerDir, {
          needsReactiveRuntime: shouldMountTemplateReactivity,
          reactiveNames,
          blockRenderers: shouldMountTemplateReactivity ? blockRenderers : [],
          reactiveOwnerId: options.reactiveOwnerId,
        });
        if (shouldMountTemplateReactivity) templateReactivityMountEmitted = true;
        for (const scriptLine of transformed.split('\n')) {
          out.push(buildAppendStatement(`\`${escapeLiteral(scriptLine)}\\n\``, emitCall));
        }
        scriptBuffer = [];
        inScript = false;
      }
      continue;
    }
    if (inScript) {
      scriptBuffer.push(line);
      if (structuralTrimmed.match(/<\/script>/i)) {
        const shouldMountTemplateReactivity = needsReactiveRuntime && !templateReactivityMountEmitted;
        const transformed = transformClientScriptBlock(scriptBuffer.join('\n'), options.clientRouteRegistry, options.importerDir, {
          needsReactiveRuntime: shouldMountTemplateReactivity,
          reactiveNames,
          blockRenderers: shouldMountTemplateReactivity ? blockRenderers : [],
          reactiveOwnerId: options.reactiveOwnerId,
        });
        if (shouldMountTemplateReactivity) templateReactivityMountEmitted = true;
        for (const scriptLine of transformed.split('\n')) {
          out.push(buildAppendStatement(`\`${escapeLiteral(scriptLine)}\\n\``, emitCall));
        }
        scriptBuffer = [];
        inScript = false;
      }
      continue;
    }

    const startedInsideQuotedAttr = !!htmlAttrQuote;
    const nextHtmlState = advanceHtmlTagState(line, inHtmlTag, htmlAttrQuote);
    if (startedInsideQuotedAttr) {
      out.push(buildAppendStatement(`\`${escapeLiteral(line)}\n\``, emitCall));
      inHtmlTag = nextHtmlState.inTag;
      htmlAttrQuote = nextHtmlState.quote;
      continue;
    }
    inHtmlTag = nextHtmlState.inTag;
    htmlAttrQuote = nextHtmlState.quote;


    // Skip empty lines
    if (!trimmed) {
      out.push(buildAppendStatement(`"\\n"`, emitCall));
      continue;
    }

    // One-line inline if/else with branch content:
    // if (cond) { text/html } else { text/html }
    // Compile branch content as template output instead of raw JS.
    const inlineIfElse = tryCompileInlineIfElseLine(trimmed, actionNames, rpcNameMap, options);
    if (inlineIfElse) {
      out.push(...inlineIfElse);
      continue;
    }

    // JS control flow lines â†’ emit as raw JS
    const reactiveBlock = blockRendererByStartLine.get(i);
    if (reactiveBlock) {
      const contextSuffix = reactiveBlock.localNames.length > 0
        ? `:\${encodeURIComponent(JSON.stringify({ ${reactiveBlock.localNames.join(', ')} }))}`
        : '';
      out.push(buildAppendStatement(`\`<!--k-block:${reactiveBlockMarker(reactiveBlock.id, options)}${contextSuffix}-->\\n\``, emitCall));
    }

    if (isJsControlLine(trimmed)) {
      out.push(trimmed);
      const closingReactiveBlock = blockRendererByEndLine.get(i);
      if (closingReactiveBlock) {
        out.push(buildAppendStatement(`\`<!--/k-block:${reactiveBlockMarker(closingReactiveBlock.id, options)}-->\\n\``, emitCall));
      }
      const nextDepth = templateBlockDepth + templateBraceDelta(trimmed);
      while (localScopeStack.length > 0 && localScopeStack[localScopeStack.length - 1].depth > nextDepth) {
        localScopeStack.pop();
      }
      const forLocals = extractForLocalNames(trimmed);
      if (forLocals.length > 0 && nextDepth > templateBlockDepth) {
        localScopeStack.push({ names: forLocals, depth: nextDepth });
      }
      const catchLocals = extractCatchLocalNames(trimmed);
      if (catchLocals.length > 0 && nextDepth > 0) {
        localScopeStack.push({ names: catchLocals, depth: nextDepth });
      }
      const declaredLocals = extractDeclarationLocalNames(trimmed);
      if (declaredLocals.length > 0 && forLocals.length === 0 && catchLocals.length === 0) {
        localScopeStack.push({ names: declaredLocals, depth: Math.max(nextDepth, templateBlockDepth) });
      }
      templateBlockDepth = nextDepth;
      continue;
    }

    // Component tags: <StatCard attr="val" attr={expr} /> (PascalCase, explicitly imported)
    if (componentNames && componentNames.size > 0) {
      // Multi-line component tag: if line starts with <PascalCase but doesn't close,
      // join continuation lines until we find the closing > or />
      let joinedTrimmed = trimmed;
      let joinedExtra = 0;
      const multiLineStart = trimmed.match(/^<([A-Z]\w*)(?:\s|$)/);
      if (multiLineStart && findComponentTagEnd(trimmed, 1) === -1 && componentNames.has(multiLineStart[1])) {
        // Keep joining lines until we find > or />
        let j = i + 1;
        while (j < lines.length) {
          const nextTrimmed = lines[j].trim();
          joinedTrimmed += ' ' + nextTrimmed;
          joinedExtra++;
          if (findComponentTagEnd(joinedTrimmed, 1) !== -1) break;
          j++;
        }
      }

      // Self-closing: <Card attr="x" />
      const componentLine = tryCompileComponentTag(joinedTrimmed, componentNames, actionNames, rpcNameMap, options);
      if (componentLine) {
        i += joinedExtra;
        out.push(componentLine);
        continue;
      }

      // Opening tag with children: <Card attr="x">
      const openResult = tryMatchComponentOpen(joinedTrimmed, componentNames, actionNames);
      if (openResult) {
        i += joinedExtra;
        // Collect lines until the matching </TagName>
        const childLines: string[] = [];
        let depth = 1;
        const childStartLine = i + 1;
        i++;
        while (i < lines.length) {
          const childTrimmed = lines[i].trim();
          // Check for nested opening of the same component
          if (childTrimmed.match(new RegExp(`^<${openResult.tagName}[\\s>]`)) && !childTrimmed.match(/\/>/)) {
            depth++;
          }
          if (childTrimmed === `</${openResult.tagName}>`) {
            depth--;
            if (depth === 0) break;
          }
          childLines.push(lines[i]);
          i++;
        }

        // Compile children into a sub-render block
        const childTemplate = childLines.join('\n');
        const childReactiveBlocks = localizeReactiveBlockRenderers(blockRenderers, childStartLine, i);
        const childBody = compileTemplate(childTemplate, componentNames, actionNames, rpcNameMap, {
          clientRouteRegistry: options.clientRouteRegistry,
          awaitQueryBindings: options.awaitQueryBindings,
          liveTemplateNames: options.liveTemplateNames,
          clientScriptBody,
          internalReactiveBlocks: childReactiveBlocks,
          augmentedActionNames: options.augmentedActionNames,
          reactiveOwnerId: options.reactiveOwnerId,
        });
        // Wrap in an IIFE that returns the children HTML
        const childrenExpr = `(function() { ${childBody}; return __html; })()`;
        const componentProps = appendComponentOwnerProp(openResult.propsStr, options);
        out.push(buildAppendStatement(`${openResult.funcName}({ ${componentProps}${componentProps ? ', ' : ''}children: ${childrenExpr} }, __esc)`, emitCall));
        continue;
      }
    }

    // HTML line â†’ compile {expr} interpolations.
    //
    // Two kinds of line-joining happen before we hand the buffer off to
    // `compileHtmlLineStatements`:
    //
    //   1. Unclosed `{` — a templated expression spans multiple lines
    //      (e.g. an `aria-label={`foo ${x}\n${y}`}` template literal).
    //      Join until all braces close.
    //
    //   2. Unclosed open tag — an `<element attr=...>` with attributes
    //      wrapping to the next line. Without joining, `action={fn}` on
    //      the first chunk stores `pendingActionHiddenInput` inside
    //      `compileHtmlSegment` but the `>` it needs to splice into
    //      arrives on a later chunk, so the hidden `<input name="_action">`
    //      is silently dropped and the dispatcher later sees a blank
    //      `_action`, returning `Unknown action:`. We only join when the
    //      tag state is mid-open (`inTag && !quote`) AND we didn't start
    //      this line inside a quoted attr value — that pre-existing case
    //      (`startedInsideQuotedAttr`) is handled above as literal emit.
    let htmlLine = line;
    let extraLines = 0;

    if (hasUnclosedBrace(htmlLine)) {
      let j = i + 1;
      while (j < lines.length && hasUnclosedBrace(htmlLine)) {
        htmlLine += '\n' + lines[j];
        extraLines++;
        j++;
      }
    }

    if (
      nextHtmlState.inTag &&
      !startedInsideQuotedAttr
    ) {
      let j = i + extraLines + 1;
      let joinState: { inTag: boolean; quote: '"' | "'" | null } = nextHtmlState;
      while (j < lines.length && joinState.inTag) {
        htmlLine += '\n' + lines[j];
        extraLines++;
        joinState = advanceHtmlTagState(lines[j], joinState.inTag, joinState.quote);
        j++;
      }
      // Re-sync outer tag-state bookkeeping so subsequent lines (now
      // past the closed `>`) don't think they're still mid-tag.
      inHtmlTag = joinState.inTag;
      htmlAttrQuote = joinState.quote;
    }

    if (extraLines > 0) {
      i += extraLines;
    }

    const activeLocalNames = Array.from(new Set(localScopeStack.flatMap((scope) => scope.names)));
    out.push(...compileHtmlLineStatements(htmlLine, actionNames, rpcNameMap, { ...options, liveTemplateNames }, activeLocalNames, topLevelScopeNames));
  }
  // For non-emit mode, add final join to produce __html
  if (!emitCall) {
    out.push('let __html = __parts.join(\'\');');
  }
  return out.join('\n');
}

/**
 * Check if a string has unclosed template braces (more { than }).
 * Respects string quotes to avoid false positives.
 */
function hasUnclosedBrace(src: string): boolean {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch as '"' | "'" | '`';
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') depth--;
  }

  return depth > 0;
}

function advanceHtmlTagState(
  src: string,
  startInTag: boolean,
  startQuote: '"' | "'" | null,
): { inTag: boolean; quote: '"' | "'" | null } {
  let inTag = startInTag;
  let quote = startQuote;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (!inTag) {
      if (ch === '<') {
        inTag = true;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      continue;
    }

    if (ch === '>') {
      inTag = false;
    }
  }

  return { inTag, quote };
}

export function analyzeClientTemplateReactivity(
  template: string,
  clientScriptBody: string,
  componentNames?: Map<string, string>,
  actionNames?: Set<string>,
  rpcNameMap?: Map<string, string>,
  options: CompileTemplateOptions = {},
): ClientTemplateReactivityPlan {
  const topLevelBindings = clientScriptBody
    ? collectTopLevelClientScopeBindings(clientScriptBody)
    : { exposed: [], mutable: new Set<string>(), reactive: new Set<string>() };
  const topLevelReactiveLets = topLevelBindings.reactive;
  const topLevelMutableNames = topLevelBindings.mutable;
  const topLevelScopeNames = new Set(topLevelBindings.exposed);
  const liveActionNames = options.augmentedActionNames ?? new Set<string>();
  const liveReactiveNames = new Set([...topLevelReactiveLets, ...liveActionNames]);
  const reactiveTemplateRefs = Array.from(collectServerTemplateReferences(template)).filter((name) => liveReactiveNames.has(name));
  const reactiveNames = clientScriptBody
    ? collectReactiveClientScriptNames(clientScriptBody, reactiveTemplateRefs)
    : new Set<string>(reactiveTemplateRefs);
  for (const name of liveActionNames) reactiveNames.add(name);
  const blockRenderers = collectReactiveBlockRenderers(
    template,
    liveReactiveNames,
    topLevelScopeNames,
    topLevelMutableNames,
    componentNames,
    actionNames,
    rpcNameMap,
    { ...options, clientScriptBody },
  );
  return { reactiveNames, blockRenderers };
}

export function buildClientTemplateRenderersExpression(blockRenderers: ClientTemplateReactivityPlan['blockRenderers']): string | undefined {
  const rendererEntries = blockRenderers
    .map((renderer) => `${JSON.stringify(renderer.id)}: ${renderer.renderer}`)
    .join(', ');
  return rendererEntries ? `{ ${rendererEntries} }` : undefined;
}

function extractFirstClientScriptBody(template: string): string {
  return getKuratchiTemplateRawBlocks(parseKuratchiTemplate(template), 'script')[0]?.content ?? '';
}

function templateBraceDelta(line: string): number {
  let delta = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch as '"' | "'" | '`';
      continue;
    }
    if (ch === '{') delta++;
    else if (ch === '}') delta--;
  }

  return delta;
}

function startsReactiveControlBlock(trimmed: string): boolean {
  return /^\s*(if|for)\s*\(/.test(trimmed) && trimmed.includes('{');
}

function extractForLocalNames(line: string): string[] {
  const source = line.trim().endsWith('{') ? `${line}\n}` : line;
  const sourceFile = ts.createSourceFile(
    'template-for-local.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set<string>();

  const visit = (node: ts.Node) => {
    if (ts.isForStatement(node) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations) {
        collectBindingNames(declaration.name, names);
      }
    } else if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && ts.isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations) {
        collectBindingNames(declaration.name, names);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return Array.from(names);
}

function extractCatchLocalNames(line: string): string[] {
  if (!/^\s*\}?\s*catch\s*\(/.test(line)) return [];

  const normalized = line.trim().replace(/^\}\s*/, '');
  const source = `try {} ${normalized.endsWith('{') ? `${normalized}\n}` : normalized}`;
  const sourceFile = ts.createSourceFile(
    'template-catch-local.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set<string>();

  const visit = (node: ts.Node) => {
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      collectBindingNames(node.variableDeclaration.name, names);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return Array.from(names);
}

function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    collectBindingNames(element.name, out);
  }
}

function extractDeclarationLocalNames(line: string): string[] {
  if (!/^\s*(?:const|let|var)\s+/.test(line)) return [];

  const statement = line.trim().endsWith(';') ? line : `${line};`;
  const source = ts.createSourceFile(
    'template-declaration.ts',
    statement,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set<string>();

  for (const node of source.statements) {
    if (!ts.isVariableStatement(node)) continue;
    for (const declaration of node.declarationList.declarations) {
      collectBindingNames(declaration.name, names);
    }
  }

  return Array.from(names);
}

function collectBlockDeclaredNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    for (const name of extractForLocalNames(line)) {
      names.add(name);
    }
    for (const name of extractCatchLocalNames(line)) {
      names.add(name);
    }
    for (const name of extractDeclarationLocalNames(line)) {
      names.add(name);
    }
  }
  return names;
}

function isRuntimeTemplateName(name: string): boolean {
  return name === '$anchor'
    || name === '$block'
    || name === 'undefined'
    || name === 'Math'
    || name === 'Date'
    || name === 'Number'
    || name === 'String'
    || name === 'Boolean'
    || name === 'Array'
    || name === 'Object'
    || name === 'JSON'
    || name === 'encodeURIComponent'
    || name === 'decodeURIComponent'
    || name === '__rawHtml'
    || name === '__sanitizeHtml'
    || name === '__esc'
    || name === '__koze_propsbag';
}

function getReferencedLocalScopeNames(expression: string, activeLocalNames: string[]): string[] {
  if (activeLocalNames.length === 0) return [];
  const names = activeLocalNames.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(expression);
  });
  return Array.from(new Set(names));
}

function buildLocalScopeAttribute(expression: string, activeLocalNames: string[]): string {
  const names = getReferencedLocalScopeNames(expression, activeLocalNames);
  if (names.length === 0) return '';
  return ` data-k-scope="\${__esc(encodeURIComponent(JSON.stringify({ ${names.join(', ')} })))}"`;
}

function isLiveTemplateExpression(expression: string, liveTemplateNames?: Set<string>): boolean {
  if (!liveTemplateNames || liveTemplateNames.size === 0) return false;
  return Array.from(liveTemplateNames).some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(expression);
  });
}

function isLocalClientExpression(expression: string, topLevelScopeNames: Set<string>): boolean {
  if (topLevelScopeNames.size === 0) return false;
  return Array.from(collectReferencedIdentifiers(expression)).some((name) => topLevelScopeNames.has(name));
}

function findQuotedAttributeContext(line: string, braceIdx: number): { attrName: string } | null {
  const before = line.slice(0, braceIdx);
  const match = before.match(/([\w:-]+)=["'][^"']*$/);
  if (!match) return null;
  return { attrName: match[1] };
}

function collectReactiveBlockRenderers(
  template: string,
  reactiveNames: Set<string>,
  topLevelScopeNames: Set<string>,
  topLevelMutableNames: Set<string>,
  componentNames?: Map<string, string>,
  actionNames?: Set<string>,
  rpcNameMap?: Map<string, string>,
  options: CompileTemplateOptions = {},
): ReactiveBlockRenderer[] {
  const lines = template.split('\n');
  const renderers: ReactiveBlockRenderer[] = [];
  let inStyle = false;
  let inScript = false;
  let id = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const opensStyle = !inScript && /<style[\s>]/i.test(trimmed);
    const closesStyle = (inStyle || opensStyle) && /<\/style>/i.test(trimmed);
    const opensScript = !inStyle && !opensStyle && /<script[\s>]/i.test(trimmed);
    const closesScript = (inScript || opensScript) && /<\/script>/i.test(trimmed);
    if (opensStyle) inStyle = true;
    if (opensScript) inScript = true;
    if (inStyle || inScript) {
      if (closesStyle) inStyle = false;
      if (closesScript) inScript = false;
      continue;
    }
    if (!startsReactiveControlBlock(trimmed)) continue;

    let depth = templateBraceDelta(lines[i]);
    let endLine = i;
    while (endLine + 1 < lines.length && depth > 0) {
      endLine++;
      depth += templateBraceDelta(lines[endLine]);
    }

    if (endLine <= i) continue;
    const source = lines.slice(i, endLine + 1).join('\n');
    const controlRefs = collectServerTemplateReferences(lines[i]);
    if (!Array.from(controlRefs).some((name) => reactiveNames.has(name))) {
      continue;
    }
    const refs = collectServerTemplateReferences(source);
    const declared = collectBlockDeclaredNames(source);
    const localNames = Array.from(refs).filter((name) =>
      !declared.has(name)
      && !isRuntimeTemplateName(name)
      && (
        !topLevelScopeNames.has(name)
        || (!topLevelMutableNames.has(name) && !reactiveNames.has(name))
      )
      && /^[A-Za-z_$][\w$]*$/.test(name),
    );
    const body = compileTemplate(source, componentNames, actionNames, rpcNameMap, {
      ...options,
      internalSkipReactiveBlocks: true,
    });
    const renderer = `__k$.renderer(${JSON.stringify(`const __rawHtml = window.__kozeRawHtml; const __sanitizeHtml = window.__kozeSanitizeHtml; const __esc = window.__kozeEscapeHtml; with($scope){ ${body} return __html; }`)})`;
    renderers.push({
      id: `b${id++}`,
      source,
      renderer,
      localNames,
      startLine: i,
      endLine,
    });
    i = endLine;
  }

  return renderers;
}

function transformClientScriptBlock(
  block: string,
  clientRouteRegistry?: ClientRouteRegistry,
  importerDir?: string,
  transformOptions: ClientScriptTransformOptions = {},
): string {
  const match = block.match(/^([\s\S]*?<script\b[^>]*>)([\s\S]*?)(<\/script>\s*)$/i);
  if (!match) return block;

  let openTag = match[1];
  let body = match[2];
  const originalBody = body;
  const closeTag = match[3];

  // Check if the script has ES module imports (import ... from '...')
  const hasEsModuleImports = /^\s*import\s+.+\s+from\s+['"][^'"]+['"]/m.test(body);

  // Rewrite $lib/ imports to bundled asset paths
  let hasRewrittenClientImports = false;
  if (clientRouteRegistry && importerDir) {
    body = body.replace(
      /^(\s*import\s+.+\s+from\s+['"]\$lib\/[^'"]+['"];?\s*)$/gm,
      (importLine) => {
        const rewritten = clientRouteRegistry.rewriteClientImport(importLine.trim(), importerDir);
        if (rewritten) {
          hasRewrittenClientImports = true;
          return importLine.replace(importLine.trim(), rewritten);
        }
        return importLine;
      }
    );
  }

  // Add type="module" if the script has ES module imports and doesn't already have it
  if ((hasEsModuleImports || hasRewrittenClientImports) && !/type\s*=\s*["']module["']/i.test(openTag)) {
    openTag = openTag.replace(/<script\b/i, '<script type="module"');
  }

  // TypeScript is preserved — wrangler's esbuild handles transpilation
  const needsReactiveRuntime = /\$\s*:/.test(body) || !!transformOptions.needsReactiveRuntime;
  if (!needsReactiveRuntime) {
    return `${openTag}${body}${closeTag}`;
  }
  const transformedBody = transformReactiveClientScript(body, {
    forceRuntime: !!transformOptions.needsReactiveRuntime,
    reactiveNames: transformOptions.reactiveNames,
  });
  const rendererEntries = (transformOptions.blockRenderers ?? [])
    .map((renderer) => `${JSON.stringify(renderer.id)}: ${renderer.renderer}`)
    .join(', ');
  const rendererArg = rendererEntries ? `{ ${rendererEntries} }` : undefined;
  const withScopeMount = `${transformedBody}\n${buildClientScopeMount(
    originalBody,
    transformOptions.reactiveNames,
    rendererArg,
    undefined,
    undefined,
    undefined,
    transformOptions.reactiveOwnerId,
  )}`;
  return `${openTag}${withScopeMount}${closeTag}`;
}

function extractAwaitTemplateCall(expr: string): { fnName: string; argsExpr: string; awaitExpr: string } | null {
  const match = expr.trim().match(/^await\s+([A-Za-z_$][\w$]*)\(([\s\S]*)\)$/);
  if (!match) return null;
  const fnName = match[1];
  const argsExpr = (match[2] || '').trim();
  return { fnName, argsExpr, awaitExpr: `${fnName}(${argsExpr})` };
}

function findMatching(src: string, openPos: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let i = openPos; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch as '"' | "'" | '`';
      continue;
    }
    if (ch === openChar) depth++;
    if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function compileInlineBranchContent(
  content: string,
  actionNames?: Set<string>,
  rpcNameMap?: Map<string, string>,
  options: CompileTemplateOptions = {},
): string[] {
  const c = content.trim();
  if (!c) return [];
  return compileHtmlLineStatements(c, actionNames, rpcNameMap, { ...options, appendNewline: false });
}

function tryCompileInlineIfElseLine(
  line: string,
  actionNames?: Set<string>,
  rpcNameMap?: Map<string, string>,
  options: CompileTemplateOptions = {},
): string[] | null {
  if (!line.startsWith('if')) return null;
  const ifMatch = line.match(/^if\s*\(/);
  if (!ifMatch) return null;

  const openParen = line.indexOf('(');
  const closeParen = findMatching(line, openParen, '(', ')');
  if (openParen === -1 || closeParen === -1) return null;

  const condition = line.slice(openParen + 1, closeParen).trim();
  if (!condition) return null;

  const firstOpenBrace = line.indexOf('{', closeParen + 1);
  if (firstOpenBrace === -1) return null;
  const firstCloseBrace = findMatching(line, firstOpenBrace, '{', '}');
  if (firstCloseBrace === -1) return null;

  const afterFirst = line.slice(firstCloseBrace + 1);
  let pos = 0;
  while (pos < afterFirst.length && /\s/.test(afterFirst[pos])) pos++;
  if (!afterFirst.slice(pos).startsWith('else')) return null;
  pos += 'else'.length;
  while (pos < afterFirst.length && /\s/.test(afterFirst[pos])) pos++;
  if (afterFirst[pos] !== '{') return null;

  const elseOpen = firstCloseBrace + 1 + pos;
  const elseClose = findMatching(line, elseOpen, '{', '}');
  if (elseClose === -1) return null;

  const trailing = line.slice(elseClose + 1).trim();
  if (trailing.length > 0) return null;

  const thenContent = line.slice(firstOpenBrace + 1, firstCloseBrace);
  const elseContent = line.slice(elseOpen + 1, elseClose);

  const out: string[] = [];
  out.push(`if (${condition}) {`);
  out.push(...compileInlineBranchContent(thenContent, actionNames, rpcNameMap, options));
  out.push(`} else {`);
  out.push(...compileInlineBranchContent(elseContent, actionNames, rpcNameMap, options));
  out.push(`}`);
  return out;
}

// componentFuncName lives in compiler-shared.ts so the component
// pipeline (which emits the function) and the template compiler
// (which emits the call) agree on the name. See top-of-file imports.

/** Parse component attributes string into a JS object literal fragment */
function componentQuotedPropExpression(value: string): string | null {
  if (!value.includes('{')) return null;

  let cursor = 0;
  const parts: string[] = [];
  let expressionCount = 0;

  while (cursor < value.length) {
    const open = value.indexOf('{', cursor);
    if (open === -1) {
      const text = value.slice(cursor);
      if (text) parts.push(JSON.stringify(text));
      break;
    }

    const text = value.slice(cursor, open);
    if (text) parts.push(JSON.stringify(text));

    const close = findClosingBrace(value, open);
    if (close === -1) return null;

    const expression = value.slice(open + 1, close).trim();
    if (!expression) return null;
    parts.push(`(${expression})`);
    expressionCount++;
    cursor = close + 1;
  }

  if (expressionCount === 0) return null;
  if (expressionCount === 1 && parts.length === 1) return parts[0];
  return parts.length > 0 ? parts.join(' + ') : null;
}

function parseComponentAttrs(attrsStr: string, actionNames?: Set<string>): string {
  const props: string[] = [];
  let i = 0;

  while (i < attrsStr.length) {
    while (i < attrsStr.length && /\s/.test(attrsStr[i])) i++;
    if (i >= attrsStr.length) break;

    if (attrsStr[i] === '{') {
      const closeIdx = findClosingBrace(attrsStr, i);
      if (closeIdx !== -1) {
        const expr = attrsStr.slice(i + 1, closeIdx).trim();
        if (expr.startsWith('...')) {
          props.push(`...(${expr.slice(3).trim()})`);
          i = closeIdx + 1;
          continue;
        }
      }
    }

    const nameStart = i;
    while (i < attrsStr.length && /[\w:-]/.test(attrsStr[i])) i++;
    if (i === nameStart) {
      i++;
      continue;
    }

    const rawKey = attrsStr.slice(nameStart, i);
    const key = rawKey.replace(/[:\-]/g, '_'); // kebab/colon directives -> snake_case for JS

    while (i < attrsStr.length && /\s/.test(attrsStr[i])) i++;
    if (attrsStr[i] !== '=') {
      if (rawKey.startsWith('bind:')) {
        const bindingName = rawKey.slice(5);
        if (bindingName && bindingName !== 'this') {
          const propKey = bindingName.replace(/-/g, '_');
          props.push(`${propKey}: ${propKey}`);
          props.push(`bind_${propKey}: ${JSON.stringify(propKey)}`);
        }
        continue;
      }
      props.push(`${key}: true`);
      continue;
    }

    i++; // skip '='
    while (i < attrsStr.length && /\s/.test(attrsStr[i])) i++;
    if (i >= attrsStr.length) {
      if (rawKey.startsWith('bind:')) {
        const bindingName = rawKey.slice(5);
        if (bindingName && bindingName !== 'this') {
          const propKey = bindingName.replace(/-/g, '_');
          props.push(`${propKey}: ${propKey}`);
          props.push(`bind_${propKey}: ${JSON.stringify(propKey)}`);
        }
        break;
      }
      props.push(`${key}: true`);
      break;
    }

    if (attrsStr[i] === '"' || attrsStr[i] === "'") {
      const quote = attrsStr[i];
      i++;
      const valueStart = i;
      while (i < attrsStr.length) {
        if (attrsStr[i] === '\\') {
          i += 2;
          continue;
        }
        if (attrsStr[i] === quote) break;
        i++;
      }
      const literal = attrsStr.slice(valueStart, i);
      props.push(`${key}: ${componentQuotedPropExpression(literal) ?? JSON.stringify(literal)}`);
      if (i < attrsStr.length && attrsStr[i] === quote) i++;
      continue;
    }

    if (attrsStr[i] === '{') {
      const closeIdx = findClosingBrace(attrsStr, i);
      const expr = attrsStr.slice(i + 1, closeIdx).trim();
      if (rawKey.startsWith('bind:')) {
        const bindingName = rawKey.slice(5);
        const propKey = bindingName.replace(/-/g, '_');
        if (bindingName === 'this') {
          props.push(`bind_this: ${JSON.stringify(expr)}`);
        } else {
          props.push(`${propKey}: (${expr})`);
          props.push(`bind_${propKey}: ${JSON.stringify(expr)}`);
        }
        i = closeIdx + 1;
        continue;
      }
      // If this expression is a known server action function, pass its name as a string
      // literal instead of a variable reference â€” action functions are not in scope in
      // the render function, but their string names are what the runtime dispatches on.
      const isAction = actionNames?.has(expr);
      props.push(isAction ? `${key}: ${buildActionPropRef(expr)}` : `${key}: (${expr})`);
      i = closeIdx + 1;
      continue;
    }

    const valueStart = i;
    while (i < attrsStr.length && !/\s/.test(attrsStr[i])) i++;
    const bare = attrsStr.slice(valueStart, i);
    props.push(`${key}: ${JSON.stringify(bare)}`);
  }

  return props.join(', ');
}

function appendComponentOwnerProp(propsStr: string, options: CompileTemplateOptions): string {
  if (!options.reactiveOwnerId) return propsStr;
  const ownerProp = `__kozeOwner: ${JSON.stringify(options.reactiveOwnerId)}`;
  return propsStr ? `${propsStr}, ${ownerProp}` : ownerProp;
}

function findComponentTagEnd(source: string, start = 1): number {
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let braceDepth = 0;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch as '"' | "'" | '`';
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      continue;
    }
    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (ch === '>' && braceDepth === 0) return i;
  }

  return -1;
}

interface ComponentLineParts {
  tagName: string;
  attrs: string;
  selfClosing: boolean;
  inner: string | null;
}

function parseComponentLine(line: string): ComponentLineParts | null {
  const trimmed = line.trim();
  const nameMatch = trimmed.match(/^<([A-Z]\w*)(?=[\s/>])/);
  if (!nameMatch) return null;

  const tagName = nameMatch[1];
  const tagEnd = findComponentTagEnd(trimmed, 1);
  if (tagEnd === -1) return null;

  const openInner = trimmed.slice(1, tagEnd).trim();
  const selfClosing = /\/\s*$/.test(openInner);
  const attrs = openInner.slice(tagName.length).replace(/\/\s*$/, '').trim();
  const remaining = trimmed.slice(tagEnd + 1);

  if (selfClosing) {
    return remaining.trim() ? null : { tagName, attrs, selfClosing: true, inner: null };
  }

  const closeMatch = remaining.match(new RegExp(`</${tagName}>\\s*$`));
  if (!closeMatch) return remaining.trim() ? null : { tagName, attrs, selfClosing: false, inner: null };

  return {
    tagName,
    attrs,
    selfClosing: false,
    inner: remaining.slice(0, remaining.length - closeMatch[0].length),
  };
}

/**
 * Try to compile a self-closing component tag into a function call.
 * Returns null if the line is not a component tag.
 *
 * Matches: <StatCard attr="literal" attr={expr} />
 * Generates: __html += __c_stat_card({ attr: "literal", attr: (expr) }, __esc);
 */
function tryCompileComponentTag(
  line: string,
  componentNames: Map<string, string>,
  actionNames?: Set<string>,
  rpcNameMap?: Map<string, string>,
  options: CompileTemplateOptions = {},
): string | null {
  const parsed = parseComponentLine(line);
  if (!parsed) return null;

  if (parsed.selfClosing || parsed.inner === '') {
    const fileName = componentNames.get(parsed.tagName);
    if (!fileName) return null;
    const funcName = componentFuncName(fileName);
    const propsStr = parseComponentAttrs(parsed.attrs, actionNames);
    const componentProps = appendComponentOwnerProp(propsStr, options);
    return buildAppendStatement(`${funcName}({ ${componentProps} }, __esc)`, options.emitCall);
  }

  if (parsed.inner != null) {
    const fileName = componentNames.get(parsed.tagName);
    if (!fileName) return null;
    const funcName = componentFuncName(fileName);
    const propsStr = parseComponentAttrs(parsed.attrs, actionNames);
    const innerContent = parsed.inner;
    // Compile the inline content as a mini-template to handle {expr} interpolation
    const childBody = compileTemplate(innerContent, componentNames, actionNames, rpcNameMap, {
      clientRouteRegistry: options.clientRouteRegistry,
      awaitQueryBindings: options.awaitQueryBindings,
      liveTemplateNames: options.liveTemplateNames,
      augmentedActionNames: options.augmentedActionNames,
      reactiveOwnerId: options.reactiveOwnerId,
    });
    const childrenExpr = `(function() { ${childBody}; return __html; })()`;
    const componentProps = appendComponentOwnerProp(propsStr, options);
    return buildAppendStatement(`${funcName}({ ${componentProps}${componentProps ? ', ' : ''}children: ${childrenExpr} }, __esc)`, options.emitCall);
  }

  return null;
}

/**
 * Try to match a component opening tag (not self-closing).
 * Returns parsed info if matched, null otherwise.
 *
 * Matches: <Card attr="x" attr={expr}>
 */
function tryMatchComponentOpen(line: string, componentNames: Map<string, string>, actionNames?: Set<string>): { tagName: string; funcName: string; propsStr: string } | null {
  const parsed = parseComponentLine(line);
  if (!parsed || parsed.selfClosing || parsed.inner !== null) return null;

  const tagName = parsed.tagName;
  const fileName = componentNames.get(tagName);
  if (!fileName) return null;

  const funcName = componentFuncName(fileName);
  const propsStr = parseComponentAttrs(parsed.attrs, actionNames);

  return { tagName, funcName, propsStr };
}

/**
 * Expand shorthand attribute syntax before main compilation:
 *   <div {id}>     â†’ <div id="{id}">
 */
function expandShorthands(line: string): string {
  // Bare {ident} inside a tag â†’ attr="{ident}"
  // Only match simple identifiers in attribute position (after < or after a space inside a tag)
  line = line.replace(/(<\w[\w-]*\s(?:[^>]*?\s)?)\{(\w+)\}(?=[\s/>])/g, (_match, before, ident) => {
    return `${before}${ident}={${ident}}`;
  });

  return line;
}

function compileHtmlLineStatements(
  line: string,
  actionNames?: Set<string>,
  rpcNameMap?: Map<string, string>,
  options: CompileTemplateOptions = {},
  activeLocalNames: string[] = [],
  topLevelScopeNames: Set<string> = new Set(),
): string[] {
  const appendNewline = options.appendNewline !== false;
  const segment = compileHtmlSegment(line, actionNames, rpcNameMap, { ...options, appendNewline }, activeLocalNames, topLevelScopeNames);
  return segment ? [segment] : [];
}

import type { ClientRouteRegistry } from './client-module-pipeline.js';

/**
 * Compile a single HTML segment, replacing {expr} with escaped output,
 * {@html expr} with sanitized HTML, and {@raw expr} with raw output.
 * Handles attribute values like value={x}.
 */
function compileHtmlSegment(
  line: string,
  actionNames?: Set<string>,
  rpcNameMap?: Map<string, string>,
  options: CompileTemplateOptions = {},
  activeLocalNames: string[] = [],
  topLevelScopeNames: Set<string> = new Set(),
): string {
  // Expand shorthand syntax before main compilation
  line = expandBindShorthands(line);
  line = rewriteTextareaBindValue(line, activeLocalNames, options);
  line = rewriteTextareaValue(line);
  line = normalizeStaticClassAttributes(line);
  line = expandShorthands(line);

  let result = '';
  let pos = 0;
  let pendingActionHiddenInput: string | null = null;

  while (pos < line.length) {
    const braceIdx = findNextTemplateBrace(line, pos);

    if (braceIdx === -1) {
      // No more braces â€” rest is literal
      result += escapeLiteral(line.slice(pos));
      break;
    }

    // Literal text before the brace
    if (braceIdx > pos) {
      result += escapeLiteral(line.slice(pos, braceIdx));
    }

    // Find matching closing brace
    const closeIdx = findClosingBrace(line, braceIdx);
    if (closeIdx === -1) {
      throw createCompilerError({
        code: 'KUR_TEMPLATE_UNMATCHED_BRACE',
        filePath: options.filePath,
        source: line,
        span: { start: braceIdx, end: braceIdx + 1 },
        message: 'Unclosed template expression.',
        hint: 'Close the expression with `}` or escape the literal `{` so it is not parsed as a template expression.',
      });
    }
    const inner = line.slice(braceIdx + 1, closeIdx).trim();

    // Sanitized HTML: {@html expr}
    if (inner.startsWith('@html ')) {
      const expr = inner.slice(6).trim();
      if (isLiveTemplateExpression(expr, options.liveTemplateNames)) {
        const marker = encodeURIComponent(expr);
        const ownedMarker = reactiveHtmlMarker(marker, options);
        result += `<!--k-html:${ownedMarker}-->\${__sanitizeHtml(${expr})}<!--/k-html:${ownedMarker}-->`;
      } else {
        result += `\${__sanitizeHtml(${expr})}`;
      }
    } else if (inner.startsWith('@raw ')) {
      // Unsafe raw HTML: {@raw expr}
      const expr = inner.slice(5).trim();
      result += `\${__rawHtml(${expr})}`;
    } else {
      if (inner.startsWith('=html ')) {
        throw new Error('[koze compiler] `{=html ...}` has been removed. Use `{@raw ...}` instead.');
      }
      if (inner.startsWith('...') && isAttributeSpreadContext(line, braceIdx)) {
        const expr = inner.slice(3).trim();
        if (!expr) {
          throw createCompilerError({
            code: 'KUR_TEMPLATE_EXPRESSION_SYNTAX',
            filePath: options.filePath,
            source: line,
            span: { start: braceIdx + 1, end: closeIdx },
            message: 'Attribute spread requires an expression.',
          });
        }
        result = result.replace(/\s*$/, '');
        result += buildSpreadAttributesExpression(expr);
        pos = closeIdx + 1;
        continue;
      }
      // Check if this is an attribute value: attr={expr}
      const charBefore = braceIdx > 0 ? line[braceIdx - 1] : '';
      const quotedAttr = findQuotedAttributeContext(line, braceIdx);
      if (quotedAttr) {
        result += `\${__esc(${inner})}`;
      } else if (charBefore === '=') {
        // Check what attribute this is for
        // Look backwards from braceIdx to find the attribute name
        const beforeBrace = line.slice(0, braceIdx);
        const attrMatch = beforeBrace.match(/([\w:-]+)=$/);
        const attrName = attrMatch ? attrMatch[1] : '';
        const escapedAttrName = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        if (attrName.startsWith('bind:')) {
          const bindingName = attrName.slice(5);
          if (!/^(this|[A-Za-z_$][\w$-]*)$/.test(bindingName)) {
            throw new Error(`Unsupported bind target: "${bindingName}".`);
          }
          if (bindingName === 'this') {
            result = result.replace(new RegExp(`\\s*${escapedAttrName}=$`), '');
            result += ` data-k-bind-this="\${__esc(${JSON.stringify(inner)})}"${buildReactiveOwnerAttribute(options)}${buildLocalScopeAttribute(inner, activeLocalNames)}`;
          } else if (bindingName === 'checked') {
            const serverValue = `(() => { try { return ${/\$el\b/.test(inner) ? "''" : inner}; } catch (_err) { return ''; } })()`;
            result = result.replace(new RegExp(`\\s*${escapedAttrName}=$`), '');
            result += `\${${serverValue} ? ' checked' : ''} data-k-bind-checked="\${__esc(${JSON.stringify(inner)})}"${buildReactiveOwnerAttribute(options)}${buildLocalScopeAttribute(inner, activeLocalNames)}`;
          } else if (bindingName === 'value') {
            const serverValue = `(() => { try { return ${/\$el\b/.test(inner) ? "''" : inner}; } catch (_err) { return ''; } })()`;
            result = result.replace(new RegExp(`\\s*${escapedAttrName}=$`), ' value=');
            result += `"\${__esc(${serverValue})}" data-k-bind-value="\${__esc(${JSON.stringify(inner)})}"${buildReactiveOwnerAttribute(options)}${buildLocalScopeAttribute(inner, activeLocalNames)}`;
          } else {
            const serverValue = `(() => { try { return ${/\$el\b/.test(inner) ? "undefined" : inner}; } catch (_err) { return undefined; } })()`;
            result = result.replace(new RegExp(`\\s*${escapedAttrName}=$`), '');
            if (isBooleanAttribute(bindingName)) {
              result += `\${${serverValue} ? ' ${bindingName}' : ''}`;
            } else {
              result += `\${(() => { const __value = ${serverValue}; return __value == null ? '' : ' ${bindingName}="' + __esc(__value) + '"'; })()}`;
            }
            result += ` data-k-bind-prop="${bindingName}" data-k-bind-expr="\${__esc(${JSON.stringify(inner)})}"${buildReactiveOwnerAttribute(options)}${buildLocalScopeAttribute(inner, activeLocalNames)}`;
          }
          pos = closeIdx + 1;
          continue;
        }

        if (attrName === 'data-dialog-data') {
          // data-dialog-data={expr} â†’ data-dialog-data="JSON.stringify(expr)" (HTML-escaped)
          result += `"\${__esc(JSON.stringify(${inner}))}"`;
          pos = closeIdx + 1;
          continue;
        } else if (attrName === 'action') {
          // action={fnName} -> server action dispatch via hidden _action field.
          const isSimpleIdentifier = /^[A-Za-z_$][\w$]*$/.test(inner);
          // When actionNames is undefined we're inside a shared component template.
          // Allow any simple identifier â€” the consuming route is responsible for
          // importing the function, and the runtime validates at dispatch time.
          const isServerAction = isSimpleIdentifier && (actionNames === undefined || actionNames.has(inner));

          if (!isServerAction) {
            throw new Error(`Invalid action expression: "${inner}". Use action={myActionFn} for server actions.`);
          }

          // Remove trailing `action=` from output and inject _action hidden field + CSRF token.
          result = result.replace(/\s*action=$/, '');
          const actionValue = actionNames === undefined
            ? `\${__esc((typeof ${inner} === 'string'
                ? ${inner}
                : (${inner} && typeof ${inner} === 'object' && ${inner}.__kozeAction)
                  ? ${inner}.__kozeAction
                  : ${inner}))}`
            : inner;
          if (options.augmentedActionNames?.has(inner)) {
            result += ` data-action-augment="${inner}"`;
          }
          // Inject only the _action hidden field. Origin enforcement is handled
          // server-side (strict same-origin gate on the /route POST endpoint).
          pendingActionHiddenInput = `\\n<input type="hidden" name="_action" value="${actionValue}">`;
          pos = closeIdx + 1;
          continue;
        } else if (/^on[A-Za-z]+$/i.test(attrName)) {
          // onClick/onChange/...={expr} â€” check if it's a server action or plain client JS
          const eventName = attrName.slice(2).toLowerCase();
          const actionCallMatch = inner.match(/^(\w+)\((.*)\)$/);
          if (actionCallMatch && actionNames?.has(actionCallMatch[1])) {
            // Server action: onClick={deleteTodo(id)}
            // â†’ data attributes consumed by the client action bridge
            const fnName = actionCallMatch[1];
            const argsExpr = actionCallMatch[2].trim();
            // Remove the trailing "onX=" we already appended
            result = result.replace(new RegExp(`\\s*${escapedAttrName}=$`), '');
            // Emit data-action, data-args, and which browser event should trigger it.
            result += ` data-action="${fnName}" data-args="\${__esc(JSON.stringify([${argsExpr}]))}" data-action-event="${eventName}"`;
          } else {
            const clientRegistration = options.clientRouteRegistry?.registerEventHandler(eventName, inner) ?? null;
            if (clientRegistration) {
              result = result.replace(new RegExp(`\\s*${escapedAttrName}=$`), '');
              // Per-event attribute names so multiple `on<event>={…}` directives
              // on the SAME element don't collide. HTML5 keeps only the FIRST
              // attribute when names dupe — so a single `data-client-event` /
              // `data-client-handler` shape silently dropped every handler
              // after the first. We now emit:
              //   data-client-route="<routeId>"     (one per element, same value)
              //   data-cc-evts="<event1> <event2>…" (whitespace-separated tokens
              //                                       so `[data-cc-evts~="focus"]`
              //                                       selectors work in CSS.)
              //   data-cce-<event>="<handlerId>"    (one per registered event)
              //   data-cca-<event>="…JSON…"         (one per registered event)
              // The bridge dispatches by inspecting `data-cce-<eventType>` on
              // the matched element. The legacy single-event attributes are
              // also emitted for the FIRST handler so any external code (or
              // older bridge instance) still sees something sensible.
              result += ` data-client-route="${clientRegistration.routeId}"`;
              // Append (or extend) the multi-event token list. We can't read
              // the in-progress `result` to detect the existing list cheaply,
              // so we always emit the per-event marker via a unique attribute
              // and the bridge uses those for dispatch. We still emit the
              // single `data-cc-evts` attribute on the first handler only —
              // duplicates would be dropped by the parser anyway and the
              // bridge no longer relies on it.
              const isFirstHandlerOnElement = !/data-cce-/.test(
                // `result` already has the open tag through the current attr
                // position; check the slice since the last `<` to be safe.
                result.slice(result.lastIndexOf('<')),
              );
              if (isFirstHandlerOnElement) {
                result += ` data-cc-evts="${eventName}"`;
              } else {
                // Extend the existing `data-cc-evts="…"` token list with the
                // new event name, in-place. Tolerates both single and double
                // quotes (compiler emits double, but be defensive).
                result = result.replace(
                  /(data-cc-evts=)("([^"]*)"|'([^']*)')/,
                  (_match, prefix, _quoted, dq, sq) => {
                    const existing = dq != null ? dq : sq;
                    if (existing.split(/\s+/).includes(eventName)) {
                      return `${prefix}"${existing}"`;
                    }
                    return `${prefix}"${existing} ${eventName}"`;
                  },
                );
              }
              result += ` data-cce-${eventName}="${clientRegistration.handlerId}"`;
              if (clientRegistration.argsExpr) {
                result += ` data-cca-${eventName}="\${__esc(JSON.stringify([${clientRegistration.argsExpr}]))}"`;
              }
            } else if (isLocalClientExpression(inner, topLevelScopeNames)) {
              result = result.replace(new RegExp(`\\s*${escapedAttrName}=$`), '');
              result += ` data-k-on-${eventName}="\${__esc(${JSON.stringify(inner)})}"${buildReactiveOwnerAttribute(options)}${buildLocalScopeAttribute(inner, activeLocalNames)}`;
            } else if (options.clientRouteRegistry?.hasBindingReference(inner)) {
              throw new Error(
                `Unsupported client handler expression: "${inner}". ` +
                `Top-level $lib event handlers must be a direct function reference or call, like onClick={openDialog()} or onClick={helpers.openDialog()}.`,
              );
            } else {
              // Plain client-side event handler: onClick={myFn()}
              // Emit as native inline handler (lowercased event attribute).
              result = result.replace(new RegExp(`\\s*${escapedAttrName}=$`), ` on${eventName}=`);
              result += `"${escapeLiteral(inner)}"`;
            }
          }
          pos = closeIdx + 1;
          continue;
        } else if (isBooleanAttribute(attrName)) {
          // Boolean attributes: disabled={expr} → conditionally include the attribute or omit entirely
          // Remove the trailing "attrName=" we already appended, we'll handle it with a ternary
          result = result.replace(new RegExp(`\\s*${escapedAttrName}=$`), '');
          if (attrName.toLowerCase() === 'hidden') {
            result += `\${${inner} === 'until-found' ? ' ${attrName}="until-found"' : (${inner} ? ' ${attrName}' : '')}`;
          } else {
            result += `\${${inner} ? ' ${attrName}' : ''}`;
          }
          if (isLiveTemplateExpression(inner, options.liveTemplateNames)) {
            result += ` data-k-attr-${attrName}="\${__esc(${JSON.stringify(inner)})}"${buildReactiveOwnerAttribute(options)}${buildLocalScopeAttribute(inner, activeLocalNames)}`;
          }
          pos = closeIdx + 1;
          continue;
        } else {
          // Regular attribute: value={expr} â†’ value="escaped"
          result = result.replace(new RegExp(`\\s*${escapedAttrName}=$`), '');
          const omitEmptyClass = attrName.toLowerCase() === 'class' ? ` || __value === ''` : '';
          result += `\${(() => { const __value = (${inner}); return __value == null${omitEmptyClass} ? '' : ' ${attrName}="' + __esc(__value) + '"'; })()}`;
          if (isLiveTemplateExpression(inner, options.liveTemplateNames)) {
            result += ` data-k-attr-${attrName}="\${__esc(${JSON.stringify(inner)})}"${buildReactiveOwnerAttribute(options)}${buildLocalScopeAttribute(inner, activeLocalNames)}`;
          }
        }
      } else {
        const awaitCall = extractAwaitTemplateCall(inner);
        const awaitBinding = awaitCall ? options.awaitQueryBindings?.get(awaitCall.awaitExpr) : null;
        if (awaitCall && awaitBinding) {
          // The awaited value is hydrated into scope as `<asName>.data` by the
          // route pipeline. Emit only the escaped text — no wrapper attributes.
          result += `\${__esc(((${awaitBinding.asName} && ${awaitBinding.asName}.data) ?? ''))}`;
        } else if (isLiveTemplateExpression(inner, options.liveTemplateNames)) {
          result += `<span data-k-text="\${__esc(${JSON.stringify(inner)})}"${buildReactiveOwnerAttribute(options)}${buildLocalScopeAttribute(inner, activeLocalNames)}>\${__esc(${inner})}</span>`;
        } else {
          result += `\${__esc(${inner})}`;
        }
      }
    }

    pos = closeIdx + 1;
  }

  if (pendingActionHiddenInput && result.includes('>')) {
    const gtIndex = result.lastIndexOf('>');
    result = result.slice(0, gtIndex + 1) + pendingActionHiddenInput + result.slice(gtIndex + 1);
  }

  return buildAppendStatement(`\`${result}${options.appendNewline === false ? '' : '\\n'}\``, options.emitCall);
}

/** Escape characters that would break a JS template literal. */
function escapeLiteral(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function findNextTemplateBrace(src: string, startPos: number): number {
  let cursor = startPos;
  while (cursor < src.length) {
    const braceIdx = src.indexOf('{', cursor);
    if (braceIdx === -1) return -1;

    const commentStart = src.lastIndexOf('<!--', braceIdx);
    const commentEnd = src.lastIndexOf('-->', braceIdx);
    if (commentStart !== -1 && commentStart > commentEnd) {
      const closeComment = src.indexOf('-->', braceIdx);
      cursor = closeComment === -1 ? src.length : closeComment + 3;
      continue;
    }

    return braceIdx;
  }
  return -1;
}


/** Find the matching closing `}` for an opening `{`, handling nesting. */
function findClosingBrace(src: string, openPos: number): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let i = openPos; i < src.length; i++) {
    const ch = src[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch as '"' | "'" | '`';
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Generate the full render function source code.
 */
/**
 * Generate a standalone `function render(data) { ... return html; }` string
 * suitable for use outside the full route pipeline (e.g. by `@kuratchi/vite`).
 *
 * @param template  The template body source (pre-parsed out of the route file).
 * @param dataVars  Optional list of identifier names to destructure from
 *                  `data` into the render function's scope, matching the
 *                  `const { name, items } = data;` prelude emitted by the
 *                  full page-route pipeline.
 */
export function generateRenderFunction(template: string, dataVars: string[] = []): string {
  const body = compileTemplate(template);
  const destructure = dataVars.length
    ? `  const { ${dataVars.join(', ')} } = data || {};\n`
    : '';

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
    html = html.replace(/\\son[a-z]+\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi, '');
    html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*([\"'])\\s*javascript:[\\s\\S]*?\\2/gi, ' $1="#"');
    html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*javascript:[^\\s>]+/gi, ' $1="#"');
    html = html.replace(/\\ssrcdoc\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)/gi, '');
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
  ${body}
  return __html;
}`;
}

// TypeScript transpilation removed — wrangler's esbuild handles it
