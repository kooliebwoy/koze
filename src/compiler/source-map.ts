import { Buffer } from 'node:buffer';

import { parseKuratchiSfc } from './sfc-parser.js';
import { getKuratchiTemplateTags } from './template-parser.js';

export interface KuratchiSourceMap {
  version: 3;
  file?: string;
  sources: string[];
  sourcesContent: string[];
  names: string[];
  mappings: string;
}

export interface KuratchiSourceMapSource {
  sourcePath: string;
  source: string;
}

export interface KuratchiSourceMapAnchor {
  generatedNeedle: string;
  sourcePath: string;
  sourceNeedle?: string;
}

interface SourceMapSegment {
  generatedLine: number;
  generatedColumn: number;
  sourceIndex: number;
  sourceLine: number;
  sourceColumn: number;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function normalizeSourcePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function findNextOccurrence(
  source: string,
  needle: string,
  starts: Map<string, number>,
  defaultStart = 0,
  key = needle,
): number {
  const start = starts.get(key) ?? defaultStart;
  const index = source.indexOf(needle, start);
  if (index !== -1) starts.set(key, index + needle.length);
  return index;
}

function lineColumnAt(source: string, index: number): { line: number; column: number } {
  let line = 0;
  let column = 0;
  const safeIndex = Math.max(0, Math.min(index, source.length));
  for (let i = 0; i < safeIndex; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      column = 0;
    } else {
      column++;
    }
  }
  return { line, column };
}

function encodeVlq(value: number): string {
  let vlq = value < 0 ? ((-value) << 1) + 1 : value << 1;
  let encoded = '';
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    encoded += BASE64_CHARS[digit];
  } while (vlq > 0);
  return encoded;
}

function encodeMappings(generatedLineCount: number, segments: SourceMapSegment[]): string {
  const byLine = new Map<number, SourceMapSegment[]>();
  for (const segment of segments) {
    const lineSegments = byLine.get(segment.generatedLine) ?? [];
    lineSegments.push(segment);
    byLine.set(segment.generatedLine, lineSegments);
  }

  let previousGeneratedColumn = 0;
  let previousSourceIndex = 0;
  let previousSourceLine = 0;
  let previousSourceColumn = 0;
  const lines: string[] = [];

  for (let line = 0; line < generatedLineCount; line++) {
    previousGeneratedColumn = 0;
    const lineSegments = (byLine.get(line) ?? [])
      .sort((a, b) => a.generatedColumn - b.generatedColumn);

    const encodedSegments = lineSegments.map((segment) => {
      const fields = [
        segment.generatedColumn - previousGeneratedColumn,
        segment.sourceIndex - previousSourceIndex,
        segment.sourceLine - previousSourceLine,
        segment.sourceColumn - previousSourceColumn,
      ];
      previousGeneratedColumn = segment.generatedColumn;
      previousSourceIndex = segment.sourceIndex;
      previousSourceLine = segment.sourceLine;
      previousSourceColumn = segment.sourceColumn;
      return fields.map(encodeVlq).join('');
    });
    lines.push(encodedSegments.join(','));
  }

  return lines.join(';');
}

function addSegment(
  segments: SourceMapSegment[],
  seen: Set<string>,
  generatedCode: string,
  source: string,
  generatedIndex: number,
  originalIndex: number,
  sourceFileIndex = 0,
): void {
  if (generatedIndex < 0 || originalIndex < 0) return;
  const generated = lineColumnAt(generatedCode, generatedIndex);
  const original = lineColumnAt(source, originalIndex);
  const key = `${generated.line}:${generated.column}`;
  if (seen.has(key)) return;
  seen.add(key);
  segments.push({
    generatedLine: generated.line,
    generatedColumn: generated.column,
    sourceIndex: sourceFileIndex,
    sourceLine: original.line,
    sourceColumn: original.column,
  });
}

function addScriptLineSegments(
  segments: SourceMapSegment[],
  seen: Set<string>,
  generatedCode: string,
  source: string,
  scriptContent: string,
  contentStart: number,
): void {
  let offset = 0;
  for (const line of scriptContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) {
      const leadingWhitespace = line.length - line.trimStart().length;
      addSegment(
        segments,
        seen,
        generatedCode,
        source,
        generatedCode.indexOf(trimmed),
        contentStart + offset + leadingWhitespace,
      );
    }
    offset += line.length + 1;
  }
}

function addTemplateExpressionSegments(
  segments: SourceMapSegment[],
  seen: Set<string>,
  generatedCode: string,
  source: string,
  templateSource: string,
  scriptEnd: number,
): void {
  const sfc = parseKuratchiSfc(source);
  const template = sfc.template;
  const generatedSearchStarts = new Map<string, number>();
  const sourceSearchStarts = new Map<string, number>();

  for (const node of template.nodes) {
    if (node.kind !== 'expression') continue;
    const expression = node.expression.trim();
    if (!expression) continue;

    const rawIndex = findNextOccurrence(source, node.raw, sourceSearchStarts, scriptEnd, `expr:${node.raw}`);
    const sourceExpressionIndex = rawIndex === -1
      ? source.indexOf(expression)
      : rawIndex + node.raw.indexOf(expression);
    const generatedNeedles = expression.startsWith('@html ')
      ? [`__sanitizeHtml(${expression.slice(6).trim()})`]
      : expression.startsWith('@raw ')
        ? [`__rawHtml(${expression.slice(5).trim()})`]
        : [`__esc(${expression})`, `(${expression})`];

    for (const needle of generatedNeedles) {
      const generatedIndex = findNextOccurrence(generatedCode, needle, generatedSearchStarts);
      if (generatedIndex !== -1) {
        addSegment(segments, seen, generatedCode, source, generatedIndex, sourceExpressionIndex);
        break;
      }
    }
  }

  for (const tag of getKuratchiTemplateTags(template)) {
    if (tag.closing) continue;
    for (const attr of tag.attrs) {
      const value = attr.value?.trim();
      if (!value?.startsWith('{') || !value.endsWith('}')) continue;
      const expression = value.slice(1, -1).trim();
      if (!expression) continue;
      const sourceValueIndex = findNextOccurrence(source, value, sourceSearchStarts, scriptEnd, `attr:${value}`);
      const sourceExpressionIndex = sourceValueIndex === -1
        ? source.indexOf(expression)
        : sourceValueIndex + 1 + value.slice(1).indexOf(expression);
      const generatedNeedles = [
        `(${expression})`,
        `__esc(${expression})`,
        JSON.stringify(expression),
      ];
      for (const needle of generatedNeedles) {
        const generatedIndex = findNextOccurrence(generatedCode, needle, generatedSearchStarts);
        if (generatedIndex !== -1) {
          addSegment(segments, seen, generatedCode, source, generatedIndex, sourceExpressionIndex);
          break;
        }
      }
    }
  }

  void templateSource;
}

export function createKuratchiSourceMap(opts: {
  generatedCode: string;
  source: string;
  sourcePath: string;
  file?: string;
}): KuratchiSourceMap {
  const segments: SourceMapSegment[] = [];
  const seen = new Set<string>();
  const normalizedPath = normalizeSourcePath(opts.sourcePath);

  try {
    const sfc = parseKuratchiSfc(opts.source, { kind: 'route', filePath: opts.sourcePath });
    if (sfc.script) {
      addScriptLineSegments(
        segments,
        seen,
        opts.generatedCode,
        opts.source,
        sfc.script.content,
        sfc.script.contentSpan.start,
      );
    }
    addTemplateExpressionSegments(
      segments,
      seen,
      opts.generatedCode,
      opts.source,
      sfc.template.source,
      sfc.script?.span.end ?? 0,
    );
  } catch {
    // Source-map generation must never hide the primary compiler error.
  }

  const generatedLineCount = opts.generatedCode.split(/\r?\n/).length;
  return {
    version: 3,
    file: opts.file,
    sources: [normalizedPath],
    sourcesContent: [opts.source],
    names: [],
    mappings: encodeMappings(generatedLineCount, segments),
  };
}

export function createGeneratedSourceMap(opts: {
  generatedCode: string;
  sources: KuratchiSourceMapSource[];
  anchors?: KuratchiSourceMapAnchor[];
  file?: string;
}): KuratchiSourceMap {
  const normalizedSources: KuratchiSourceMapSource[] = [];
  const sourceIndexByPath = new Map<string, number>();
  for (const source of opts.sources) {
    const normalizedPath = normalizeSourcePath(source.sourcePath);
    if (sourceIndexByPath.has(normalizedPath)) continue;
    sourceIndexByPath.set(normalizedPath, normalizedSources.length);
    normalizedSources.push({
      sourcePath: normalizedPath,
      source: source.source,
    });
  }

  const segments: SourceMapSegment[] = [];
  const seen = new Set<string>();
  const generatedSearchStarts = new Map<string, number>();
  const sourceSearchStarts = new Map<string, number>();

  for (const anchor of opts.anchors ?? []) {
    const normalizedPath = normalizeSourcePath(anchor.sourcePath);
    const sourceFileIndex = sourceIndexByPath.get(normalizedPath);
    if (sourceFileIndex == null) continue;

    const mappedSource = normalizedSources[sourceFileIndex];
    const generatedIndex = findNextOccurrence(
      opts.generatedCode,
      anchor.generatedNeedle,
      generatedSearchStarts,
      0,
      anchor.generatedNeedle,
    );
    if (generatedIndex === -1) continue;

    const sourceNeedle = anchor.sourceNeedle;
    const originalIndex = sourceNeedle
      ? findNextOccurrence(
        mappedSource.source,
        sourceNeedle,
        sourceSearchStarts,
        0,
        `${sourceFileIndex}:${sourceNeedle}`,
      )
      : 0;

    addSegment(
      segments,
      seen,
      opts.generatedCode,
      mappedSource.source,
      generatedIndex,
      originalIndex,
      sourceFileIndex,
    );
  }

  const generatedLineCount = opts.generatedCode.split(/\r?\n/).length;
  return {
    version: 3,
    file: opts.file,
    sources: normalizedSources.map((source) => source.sourcePath),
    sourcesContent: normalizedSources.map((source) => source.source),
    names: [],
    mappings: encodeMappings(generatedLineCount, segments),
  };
}

export function appendInlineSourceMap(code: string, map: KuratchiSourceMap): string {
  const payload = Buffer.from(JSON.stringify(map), 'utf-8').toString('base64');
  return `${code}\n//# sourceMappingURL=data:application/json;base64,${payload}`;
}
