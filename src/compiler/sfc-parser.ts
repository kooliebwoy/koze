import * as path from 'node:path';

import type { KuratchiFileAst, KuratchiFileKind, KuratchiScriptAst } from './ast.js';
import { createCompilerError } from './diagnostics.js';
import { parseKuratchiTemplate } from './template-parser.js';

interface ParseKuratchiSfcOptions {
  kind?: KuratchiFileKind;
  filePath?: string;
}

interface RawScriptBlock {
  attrs: string;
  openTag: string;
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
}

interface CloseTag {
  start: number;
  end: number;
}

function startsWithIgnoreCase(source: string, index: number, needle: string): boolean {
  return source.slice(index, index + needle.length).toLowerCase() === needle.toLowerCase();
}

function isTagNameBoundary(ch: string | undefined): boolean {
  return ch === undefined || ch === '>' || ch === '/' || /\s/.test(ch);
}

function findTagEnd(source: string, openIndex: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
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

function findRawCloseTag(source: string, fromIndex: number, tagName: string): CloseTag | null {
  let cursor = fromIndex;
  const closeNeedle = `</${tagName}`;
  while (cursor < source.length) {
    const next = source.indexOf('<', cursor);
    if (next === -1) return null;
    if (startsWithIgnoreCase(source, next, closeNeedle)) {
      const boundary = source[next + closeNeedle.length];
      if (isTagNameBoundary(boundary)) {
        const closeEnd = findTagEnd(source, next);
        return closeEnd === -1 ? null : { start: next, end: closeEnd + 1 };
      }
    }
    cursor = next + 1;
  }
  return null;
}

function findScriptClose(source: string, fromIndex: number): CloseTag | null {
  return findRawCloseTag(source, fromIndex, 'script');
}

function findScriptBlocks(source: string, filePath?: string): RawScriptBlock[] {
  const blocks: RawScriptBlock[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const lt = source.indexOf('<', cursor);
    if (lt === -1) break;

    if (source.startsWith('<!--', lt)) {
      const commentEnd = source.indexOf('-->', lt + 4);
      cursor = commentEnd === -1 ? source.length : commentEnd + 3;
      continue;
    }

    if (startsWithIgnoreCase(source, lt, '<style') && isTagNameBoundary(source[lt + '<style'.length])) {
      const openEnd = findTagEnd(source, lt);
      if (openEnd === -1) {
        cursor = lt + '<style'.length;
        continue;
      }
      const close = findRawCloseTag(source, openEnd + 1, 'style');
      cursor = close ? close.end : openEnd + 1;
      continue;
    }

    if (!startsWithIgnoreCase(source, lt, '<script') || !isTagNameBoundary(source[lt + '<script'.length])) {
      cursor = lt + 1;
      continue;
    }

    const openEnd = findTagEnd(source, lt);
    if (openEnd === -1) {
      throw createCompilerError({
        code: 'KUR_UNCLOSED_SCRIPT_TAG',
        filePath,
        source,
        span: { start: lt, end: Math.min(source.length, lt + '<script'.length) },
        message: 'Unclosed <script> tag.',
      });
    }
    const close = findScriptClose(source, openEnd + 1);
    if (!close) {
      throw createCompilerError({
        code: 'KUR_UNCLOSED_SCRIPT_BLOCK',
        filePath,
        source,
        span: { start: lt, end: openEnd + 1 },
        message: 'Unclosed <script> block.',
      });
    }

    const openTag = source.slice(lt, openEnd + 1);
    const attrs = openTag.replace(/^<script\b/i, '').replace(/>$/, '');
    const contentStart = openEnd + 1;
    blocks.push({
      attrs,
      openTag,
      start: lt,
      end: close.end,
      contentStart,
      contentEnd: close.start,
    });
    cursor = close.end;
  }
  return blocks;
}

function consumeAllowedPrefix(source: string): number {
  let cursor = 0;
  while (cursor < source.length) {
    const next = source.slice(cursor);
    const whitespace = next.match(/^\s+/);
    if (whitespace) {
      cursor += whitespace[0].length;
      continue;
    }
    if (startsWithIgnoreCase(source, cursor, '<!doctype')) {
      const end = source.indexOf('>', cursor);
      if (end === -1) return cursor;
      cursor = end + 1;
      continue;
    }
    if (source.startsWith('<!--', cursor)) {
      const end = source.indexOf('-->', cursor + 4);
      if (end === -1) return cursor;
      cursor = end + 3;
      continue;
    }
    return cursor;
  }
  return cursor;
}

function buildScriptPlacementError(kind: KuratchiFileKind, filePath?: string): Error {
  return createCompilerError({
    code: 'KUR_SCRIPT_PLACEMENT',
    filePath,
    message: 'Only one top-level <script> block is allowed, and it must appear before template markup.',
    hint: 'Move additional browser code into a $lib module and import it from the top script.',
  });
}

function isAppShellFile(filePath: string | undefined): boolean {
  return filePath != null && path.basename(filePath).toLowerCase() === 'app.koze';
}

function toScriptAst(source: string, block: RawScriptBlock): KuratchiScriptAst {
  return {
    kind: 'script',
    attrs: block.attrs,
    openTag: block.openTag,
    content: source.slice(block.contentStart, block.contentEnd),
    span: { start: block.start, end: block.end },
    contentSpan: { start: block.contentStart, end: block.contentEnd },
  };
}

export function parseKuratchiSfc(source: string, options: ParseKuratchiSfcOptions = {}): KuratchiFileAst {
  const kind = options.kind ?? 'route';
  const scriptBlocks = findScriptBlocks(source, options.filePath);
  const firstAllowedScriptIndex = consumeAllowedPrefix(source);
  const allowDocumentScripts = isAppShellFile(options.filePath);

  if (!allowDocumentScripts) {
    if (scriptBlocks.length > 0 && scriptBlocks[0].start !== firstAllowedScriptIndex) {
      throw buildScriptPlacementError(kind, options.filePath);
    }
    if (scriptBlocks.length > 1) {
      throw buildScriptPlacementError(kind, options.filePath);
    }
  }

  const compilerScriptBlock = scriptBlocks[0]?.start === firstAllowedScriptIndex
    ? scriptBlocks[0]
    : null;
  const script = compilerScriptBlock ? toScriptAst(source, compilerScriptBlock) : null;
  const leadingPrefix = script ? source.slice(0, script.span.start) : '';
  const rest = script ? source.slice(script.span.end).trim() : source;
  const preservedPrefix = leadingPrefix.trim();
  const templateSource = script && preservedPrefix ? `${preservedPrefix}\n${rest}` : rest;
  const template = parseKuratchiTemplate(templateSource);

  return {
    kind,
    filePath: options.filePath,
    source,
    script,
    template,
  };
}
