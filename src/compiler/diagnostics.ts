import type { KuratchiSourceSpan } from './ast.js';

export type KuratchiCompilerErrorCode =
  | 'KUR_UNCLOSED_SCRIPT_TAG'
  | 'KUR_UNCLOSED_SCRIPT_BLOCK'
  | 'KUR_SCRIPT_PLACEMENT'
  | 'KUR_SCRIPT_SYNTAX'
  | 'KUR_TEMPLATE_EXPRESSION_SYNTAX'
  | 'KUR_TEMPLATE_ATTRIBUTE_SYNTAX'
  | 'KUR_TEMPLATE_UNMATCHED_BRACE'
  | 'KUR_ENV_ACCESS'
  | 'KUR_LOAD_PARSE';

export interface KuratchiCompilerDiagnostic {
  code: KuratchiCompilerErrorCode;
  message: string;
  filePath?: string;
  span?: KuratchiSourceSpan;
  line?: number;
  column?: number;
  hint?: string;
}

export class KuratchiCompilerError extends Error {
  readonly code: KuratchiCompilerErrorCode;
  readonly filePath?: string;
  readonly span?: KuratchiSourceSpan;
  readonly line?: number;
  readonly column?: number;
  readonly hint?: string;

  constructor(diagnostic: KuratchiCompilerDiagnostic) {
    super(formatCompilerDiagnostic(diagnostic));
    this.name = 'KuratchiCompilerError';
    this.code = diagnostic.code;
    this.filePath = diagnostic.filePath;
    this.span = diagnostic.span;
    this.line = diagnostic.line;
    this.column = diagnostic.column;
    this.hint = diagnostic.hint;
  }
}

export function createCompilerError(
  diagnostic: Omit<KuratchiCompilerDiagnostic, 'line' | 'column'> & { source?: string },
): KuratchiCompilerError {
  const loc = diagnostic.source && diagnostic.span
    ? getLineColumn(diagnostic.source, diagnostic.span.start)
    : null;
  return new KuratchiCompilerError({
    ...diagnostic,
    line: loc?.line,
    column: loc?.column,
  });
}

export function isKuratchiCompilerError(error: unknown): error is KuratchiCompilerError {
  return error instanceof KuratchiCompilerError;
}

export function getLineColumn(source: string, index: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const safeIndex = Math.max(0, Math.min(index, source.length));
  for (let i = 0; i < safeIndex; i++) {
    const ch = source.charCodeAt(i);
    if (ch === 10) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function formatCompilerDiagnostic(diagnostic: KuratchiCompilerDiagnostic): string {
  const location = diagnostic.filePath
    ? diagnostic.line && diagnostic.column
      ? `${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column}`
      : diagnostic.filePath
    : diagnostic.line && diagnostic.column
      ? `${diagnostic.line}:${diagnostic.column}`
      : 'compiler';
  const lines = [
    `[koze compiler] ${diagnostic.code} ${location}`,
    diagnostic.message,
  ];
  if (diagnostic.hint) lines.push(diagnostic.hint);
  return lines.join('\n');
}
