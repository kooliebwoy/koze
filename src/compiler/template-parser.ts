import type {
  KuratchiTemplateAst,
  KuratchiTemplateAttributeAst,
  KuratchiTemplateRawBlockAst,
  KuratchiTemplateExpressionAst,
  KuratchiTemplateNode,
  KuratchiTemplateTagAst,
} from './ast.js';

function startsWithIgnoreCase(source: string, index: number, needle: string): boolean {
  return source.slice(index, index + needle.length).toLowerCase() === needle.toLowerCase();
}

function isTagNameBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === '>' || ch === '/' || /\s/.test(ch);
}

function preserveLineBreaks(source: string): string {
  return source.replace(/[^\r\n]/g, '');
}

function findTemplateTagEnd(source: string, start: number): number {
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
      quote = ch;
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

function findMatchingTemplateExpression(source: string, openPos: number): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let i = openPos; i < source.length; i++) {
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
      quote = ch;
      continue;
    }

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function isLikelyTemplateJsBlockOpen(source: string, openPos: number): boolean {
  const lineStart = source.lastIndexOf('\n', openPos - 1) + 1;
  const lineEndIdx = source.indexOf('\n', openPos + 1);
  const lineEnd = lineEndIdx === -1 ? source.length : lineEndIdx;
  const line = source.slice(lineStart, lineEnd).trim();
  if (
    /^(?:for|if|switch|while|catch|with)\s*\(/.test(line) ||
    /^(?:try|finally|do)\b/.test(line) ||
    /^\}?\s*else\b/.test(line) ||
    /^\s*throw\b/.test(line) ||
    /^(?:const|let|var)\b/.test(line)
  ) {
    return true;
  }

  const before = source.slice(lineStart, openPos).trim();
  const after = source.slice(openPos + 1, lineEnd).trim();
  if (after && after !== ';') return false;

  return (
    /^(?:for|if|switch|while|catch|with)\s*\(/.test(before) ||
    /^(?:try|finally|do)\b/.test(before) ||
    /^\}?\s*else\b/.test(before) ||
    /^(?:const|let|var)\b/.test(before)
  );
}

function parseTemplateAttributes(source: string, offset: number): KuratchiTemplateAttributeAst[] {
  const attrs: KuratchiTemplateAttributeAst[] = [];
  let i = 0;

  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (i >= source.length) break;

    const attrStart = i;
    while (i < source.length && /[^\s=/>]/.test(source[i])) i++;
    const name = source.slice(attrStart, i);
    if (!name) break;

    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] !== '=') {
      attrs.push({
        name,
        value: null,
        raw: source.slice(attrStart, i),
        span: { start: offset + attrStart, end: offset + i },
      });
      continue;
    }

    i++;
    while (i < source.length && /\s/.test(source[i])) i++;
    if (i >= source.length) {
      attrs.push({
        name,
        value: '',
        raw: source.slice(attrStart),
        span: { start: offset + attrStart, end: offset + source.length },
      });
      break;
    }

    const valueStart = i;
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
    } else if (source[i] === '{') {
      const closeIdx = findMatchingTemplateExpression(source, i);
      i = closeIdx === -1 ? source.length : closeIdx + 1;
    } else {
      while (i < source.length && /[^\s>]/.test(source[i])) i++;
    }

    attrs.push({
      name,
      value: source.slice(valueStart, i),
      raw: source.slice(attrStart, i),
      span: { start: offset + attrStart, end: offset + i },
    });
  }

  return attrs;
}

function parseTemplateTag(source: string, lt: number, tagEnd: number): KuratchiTemplateTagAst | null {
  const raw = source.slice(lt, tagEnd + 1);
  const inner = source.slice(lt + 1, tagEnd).trim();
  if (!inner || inner.startsWith('!')) return null;

  const closing = inner.startsWith('/');
  const normalized = closing ? inner.slice(1).trim() : inner;
  const nameMatch = normalized.match(/^([A-Za-z][\w:-]*)/);
  if (!nameMatch) return null;

  const name = nameMatch[1];
  const selfClosing = !closing && /\/\s*$/.test(normalized);
  const rawAttrSource = normalized.slice(name.length).replace(/\/\s*$/, '');
  const rawAttrStartInTag = raw.indexOf(rawAttrSource);
  const attrOffset = rawAttrStartInTag === -1
    ? lt + 1 + inner.indexOf(name) + name.length
    : lt + rawAttrStartInTag;

  return {
    kind: 'tag',
    name,
    attrs: closing ? [] : parseTemplateAttributes(rawAttrSource, attrOffset),
    closing,
    selfClosing,
    raw,
    span: { start: lt, end: tagEnd + 1 },
  };
}

function parseRawBlock(source: string, tag: KuratchiTemplateTagAst): KuratchiTemplateRawBlockAst | null {
  const name = tag.name.toLowerCase();
  if (name !== 'script' && name !== 'style') return null;
  if (tag.closing || tag.selfClosing) return null;

  let cursor = tag.span.end;
  while (cursor < source.length) {
    const next = source.indexOf('<', cursor);
    if (next === -1) return null;
    const closeNeedle = `</${name}`;
    if (startsWithIgnoreCase(source, next, closeNeedle) && isTagNameBoundary(source[next + closeNeedle.length])) {
      const closeEnd = findTemplateTagEnd(source, next + 1);
      if (closeEnd === -1) return null;
      return {
        kind: 'raw-block',
        name,
        attrs: tag.attrs,
        content: source.slice(tag.span.end, next),
        raw: source.slice(tag.span.start, closeEnd + 1),
        span: { start: tag.span.start, end: closeEnd + 1 },
        contentSpan: { start: tag.span.end, end: next },
      };
    }
    cursor = next + 1;
  }

  return null;
}

function pushTextNode(nodes: KuratchiTemplateNode[], source: string, start: number, end: number): void {
  if (end <= start) return;
  nodes.push({
    kind: 'text',
    value: source.slice(start, end),
    span: { start, end },
  });
}

export function parseKuratchiTemplate(source: string): KuratchiTemplateAst {
  const nodes: KuratchiTemplateNode[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const nextLt = source.indexOf('<', cursor);
    const nextBrace = source.indexOf('{', cursor);
    const nextSpecial = nextLt === -1
      ? nextBrace
      : nextBrace === -1
        ? nextLt
        : Math.min(nextLt, nextBrace);

    if (nextSpecial === -1) {
      pushTextNode(nodes, source, cursor, source.length);
      break;
    }

    pushTextNode(nodes, source, cursor, nextSpecial);

    if (source.startsWith('<!--', nextSpecial)) {
      const end = source.indexOf('-->', nextSpecial + 4);
      const commentEnd = end === -1 ? source.length : end + 3;
      nodes.push({
        kind: 'comment',
        value: source.slice(nextSpecial + 4, end === -1 ? source.length : end),
        span: { start: nextSpecial, end: commentEnd },
      });
      cursor = commentEnd;
      continue;
    }

    if (source[nextSpecial] === '<') {
      const tagEnd = findTemplateTagEnd(source, nextSpecial + 1);
      if (tagEnd === -1) {
        pushTextNode(nodes, source, nextSpecial, source.length);
        break;
      }

      const tag = parseTemplateTag(source, nextSpecial, tagEnd);
      if (!tag) {
        pushTextNode(nodes, source, nextSpecial, tagEnd + 1);
        cursor = tagEnd + 1;
        continue;
      }

      const rawBlock = parseRawBlock(source, tag);
      if (rawBlock) {
        nodes.push(rawBlock);
        cursor = rawBlock.span.end;
        continue;
      }

      nodes.push(tag);
      cursor = tag.span.end;
      continue;
    }

    if (source[nextSpecial] === '{' && isLikelyTemplateJsBlockOpen(source, nextSpecial)) {
      pushTextNode(nodes, source, nextSpecial, nextSpecial + 1);
      cursor = nextSpecial + 1;
      continue;
    }

    const closeIdx = findMatchingTemplateExpression(source, nextSpecial);
    if (closeIdx === -1) {
      pushTextNode(nodes, source, nextSpecial, nextSpecial + 1);
      cursor = nextSpecial + 1;
      continue;
    }

    nodes.push({
      kind: 'expression',
      expression: source.slice(nextSpecial + 1, closeIdx).trim(),
      raw: source.slice(nextSpecial, closeIdx + 1),
      span: { start: nextSpecial, end: closeIdx + 1 },
    });
    cursor = closeIdx + 1;
  }

  return {
    kind: 'template',
    source,
    span: { start: 0, end: source.length },
    nodes,
  };
}

export function getKuratchiTemplateTags(template: KuratchiTemplateAst): KuratchiTemplateTagAst[] {
  return template.nodes.filter((node): node is KuratchiTemplateTagAst => node.kind === 'tag');
}

export function getKuratchiTemplateExpressions(template: KuratchiTemplateAst): KuratchiTemplateExpressionAst[] {
  return template.nodes.filter((node): node is KuratchiTemplateExpressionAst => node.kind === 'expression');
}

export function getKuratchiTemplateRawBlocks(
  template: KuratchiTemplateAst,
  name?: 'script' | 'style',
): KuratchiTemplateRawBlockAst[] {
  return template.nodes.filter((node): node is KuratchiTemplateRawBlockAst => (
    node.kind === 'raw-block' && (!name || node.name === name)
  ));
}

export function getKuratchiTemplateAttribute(
  tag: KuratchiTemplateTagAst,
  name: string,
): KuratchiTemplateAttributeAst | null {
  return tag.attrs.find((attr) => attr.name === name) ?? null;
}

export function getKuratchiTemplateAttributeExpression(
  tag: KuratchiTemplateTagAst,
  name: string,
): string | null {
  const attr = getKuratchiTemplateAttribute(tag, name);
  const value = attr?.value?.trim();
  if (!value || !value.startsWith('{') || !value.endsWith('}')) return null;
  return value.slice(1, -1).trim();
}

export function findKuratchiSlotSpan(template: KuratchiTemplateAst): { start: number; end: number } | null {
  const nodes = template.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.kind !== 'tag' || node.name !== 'slot' || node.closing) continue;
    if (node.selfClosing) return node.span;

    for (let j = i + 1; j < nodes.length; j++) {
      const close = nodes[j];
      if (close.kind === 'tag' && close.name === 'slot' && close.closing) {
        return { start: node.span.start, end: close.span.end };
      }
    }

    return null;
  }

  return null;
}

export function replaceKuratchiSlot(template: KuratchiTemplateAst, replacement: string): string {
  const span = findKuratchiSlotSpan(template);
  if (!span) {
    throw new Error('layout.koze must contain <slot></slot> or <slot />');
  }
  return template.source.slice(0, span.start) + replacement + template.source.slice(span.end);
}

export function stripKuratchiTemplateNodes(
  template: KuratchiTemplateAst,
  shouldStrip: (node: KuratchiTemplateNode) => boolean,
): string {
  let output = '';
  let cursor = 0;

  for (const node of template.nodes) {
    output += template.source.slice(cursor, node.span.start);
    output += shouldStrip(node)
      ? preserveLineBreaks(template.source.slice(node.span.start, node.span.end))
      : template.source.slice(node.span.start, node.span.end);
    cursor = node.span.end;
  }

  output += template.source.slice(cursor);
  return output;
}

export function stripKuratchiTemplateComments(template: KuratchiTemplateAst): string {
  return stripKuratchiTemplateNodes(template, (node) => node.kind === 'comment');
}

export function stripKuratchiTemplateRawBlocks(template: KuratchiTemplateAst): string {
  return stripKuratchiTemplateNodes(
    template,
    (node) => node.kind === 'raw-block' && (node.name === 'script' || node.name === 'style'),
  );
}

export function stripKuratchiTemplateCompilerIgnoredNodes(template: KuratchiTemplateAst): string {
  return stripKuratchiTemplateNodes(
    template,
    (node) => node.kind === 'comment' || (node.kind === 'raw-block' && (node.name === 'script' || node.name === 'style')),
  );
}
