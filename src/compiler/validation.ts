import ts from 'typescript';

import type {
  KuratchiFileAst,
  KuratchiSourceSpan,
  KuratchiTemplateAst,
  KuratchiTemplateAttributeAst,
  KuratchiTemplateExpressionAst,
} from './ast.js';
import { createCompilerError } from './diagnostics.js';
import {
  getKuratchiTemplateExpressions,
  getKuratchiTemplateTags,
} from './template-parser.js';

type SourceFileWithParseDiagnostics = ts.SourceFile & {
  parseDiagnostics?: readonly ts.Diagnostic[];
};

export function validateKuratchiAst(ast: KuratchiFileAst): void {
  if (ast.script) {
    validateScriptSyntax(ast.script.content, {
      source: ast.source,
      filePath: ast.filePath,
      contentOffset: ast.script.contentSpan.start,
    });
  }
  validateKuratchiTemplate(ast.template, {
    filePath: ast.filePath,
  });
}

export function validateKuratchiTemplate(
  template: KuratchiTemplateAst,
  opts: { filePath?: string } = {},
): void {
  for (const node of getKuratchiTemplateExpressions(template)) {
    validateTemplateExpressionNode(template, node, opts.filePath);
  }

  for (const tag of getKuratchiTemplateTags(template)) {
    if (tag.closing) continue;
    for (const attr of tag.attrs) {
      validateTemplateBindDirective(template, attr, opts.filePath);
      validateTemplateAttributeExpression(template, attr, opts.filePath);
    }
  }
}

function validateScriptSyntax(
  script: string,
  opts: { source: string; filePath?: string; contentOffset: number },
): void {
  const sourceFile = ts.createSourceFile(
    opts.filePath || 'kuratchi-script.ts',
    script,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostic = getParseDiagnostics(sourceFile)[0];
  if (!diagnostic) return;

  const start = opts.contentOffset + (diagnostic.start ?? 0);
  throw createCompilerError({
    code: 'KUR_SCRIPT_SYNTAX',
    filePath: opts.filePath,
    source: opts.source,
    span: {
      start,
      end: start + Math.max(1, diagnostic.length ?? 1),
    },
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    hint: 'Fix the top-level <script> syntax before Kuratchi analyzes imports, RPC calls, or template bindings.',
  });
}

function validateTemplateExpressionNode(
  template: KuratchiTemplateAst,
  node: KuratchiTemplateExpressionAst,
  filePath?: string,
): void {
  const normalized = normalizeTemplateExpression(node.expression, {
    expressionStart: node.span.start + 1,
    filePath,
    source: template.source,
  });
  if (!normalized.expression) return;
  if (containsTemplateMarkup(normalized.expression)) return;
  validateExpressionSyntax(normalized.expression, {
    code: 'KUR_TEMPLATE_EXPRESSION_SYNTAX',
    filePath,
    source: template.source,
    span: {
      start: normalized.start,
      end: Math.max(normalized.start + 1, normalized.start + normalized.expression.length),
    },
  });
}

function validateTemplateAttributeExpression(
  template: KuratchiTemplateAst,
  attr: KuratchiTemplateAttributeAst,
  filePath?: string,
): void {
  const value = attr.value?.trim();
  if (!value) return;

  const rawValueIndex = attr.raw.indexOf(attr.value ?? '');
  const expressionStart = attr.span.start + (rawValueIndex === -1 ? 0 : rawValueIndex) + 1;
  if (value.startsWith('{') && value.endsWith('}')) {
    const expression = value.slice(1, -1).trim();
    if (!expression) return;

    validateExpressionSyntax(expression, {
      code: 'KUR_TEMPLATE_ATTRIBUTE_SYNTAX',
      filePath,
      source: template.source,
      span: {
        start: expressionStart,
        end: expressionStart + expression.length,
      },
    });
    return;
  }

  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) return;

  validateQuotedAttributeInterpolations(value.slice(1, -1), {
    filePath,
    source: template.source,
    valueStart: expressionStart,
  });
}

function validateTemplateBindDirective(
  template: KuratchiTemplateAst,
  attr: KuratchiTemplateAttributeAst,
  filePath?: string,
): void {
  if (!attr.name.startsWith('bind:')) return;

  const target = attr.name.slice('bind:'.length);
  if (!/^(this|[A-Za-z_$][\w$-]*)$/.test(target)) {
    throw createCompilerError({
      code: 'KUR_TEMPLATE_ATTRIBUTE_SYNTAX',
      filePath,
      source: template.source,
      span: attr.span,
      message: `Unsupported bind target: "${target}".`,
      hint: 'Use bind:value, bind:checked, bind:open, bind:this={element}, or another native property binding.',
    });
  }

  const value = attr.value?.trim();
  if (target === 'this' && value == null) {
    throw createCompilerError({
      code: 'KUR_TEMPLATE_ATTRIBUTE_SYNTAX',
      filePath,
      source: template.source,
      span: attr.span,
      message: 'Invalid bind:this value.',
      hint: 'Use bind:this={element}.',
    });
  }
  if (value == null) return;
  if (value.startsWith('{') && value.endsWith('}')) return;

  throw createCompilerError({
    code: 'KUR_TEMPLATE_ATTRIBUTE_SYNTAX',
    filePath,
    source: template.source,
    span: attr.span,
    message: `Invalid bind:${target} value.`,
    hint: `Use bind:${target}={${target}} or shorthand bind:${target}.`,
  });
}

function normalizeTemplateExpression(
  expression: string,
  opts: { expressionStart: number; filePath?: string; source: string },
): { expression: string; start: number } {
  const trimmed = expression.trim();
  const leadingWhitespace = expression.length - expression.trimStart().length;
  const start = opts.expressionStart + leadingWhitespace;

  if (trimmed.startsWith('@html ')) {
    return {
      expression: trimmed.slice(6).trim(),
      start: start + trimmed.indexOf(trimmed.slice(6).trim()),
    };
  }
  if (trimmed.startsWith('@raw ')) {
    return {
      expression: trimmed.slice(5).trim(),
      start: start + trimmed.indexOf(trimmed.slice(5).trim()),
    };
  }
  if (trimmed.startsWith('=html ')) {
    throw createCompilerError({
      code: 'KUR_TEMPLATE_EXPRESSION_SYNTAX',
      filePath: opts.filePath,
      source: opts.source,
      span: {
        start,
        end: Math.max(start + 1, start + trimmed.length),
      },
      message: '`{=html ...}` has been removed. Use `{@raw ...}` instead.',
    });
  }
  return { expression: trimmed, start };
}

function validateQuotedAttributeInterpolations(
  value: string,
  opts: { filePath?: string; source: string; valueStart: number },
): void {
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf('{', cursor);
    if (open === -1) return;
    const close = findMatchingAttributeInterpolation(value, open);
    if (close === -1) {
      const start = opts.valueStart + open;
      throw createCompilerError({
        code: 'KUR_TEMPLATE_ATTRIBUTE_SYNTAX',
        filePath: opts.filePath,
        source: opts.source,
        span: {
          start,
          end: start + 1,
        },
        message: 'Unmatched `{` in quoted attribute interpolation.',
        hint: 'Close the interpolation with `}` or escape literal braces before this reaches the template compiler.',
      });
    }

    const expression = value.slice(open + 1, close).trim();
    if (expression) {
      const leadingWhitespace = value.slice(open + 1, close).length - value.slice(open + 1, close).trimStart().length;
      const start = opts.valueStart + open + 1 + leadingWhitespace;
      validateExpressionSyntax(expression, {
        code: 'KUR_TEMPLATE_ATTRIBUTE_SYNTAX',
        filePath: opts.filePath,
        source: opts.source,
        span: {
          start,
          end: Math.max(start + 1, start + expression.length),
        },
      });
    }
    cursor = close + 1;
  }
}

function findMatchingAttributeInterpolation(source: string, openPos: number): number {
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

function containsTemplateMarkup(expression: string): boolean {
  return /<\/?[A-Za-z][\w:-]*(?:\s|>|\/>)/.test(expression);
}

function validateExpressionSyntax(
  expression: string,
  opts: {
    code: 'KUR_TEMPLATE_EXPRESSION_SYNTAX' | 'KUR_TEMPLATE_ATTRIBUTE_SYNTAX';
    filePath?: string;
    source: string;
    span: KuratchiSourceSpan;
  },
): void {
  const prefix = 'async function __koze_expr__(){ return (';
  const suffix = '); }';
  const wrapped = `${prefix}${expression}${suffix}`;
  const sourceFile = ts.createSourceFile(
    opts.filePath || 'kuratchi-expression.ts',
    wrapped,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostic = getParseDiagnostics(sourceFile)[0];
  if (!diagnostic) return;

  const diagnosticStart = diagnostic.start ?? prefix.length;
  const expressionOffset = Math.max(0, diagnosticStart - prefix.length);
  const start = Math.min(opts.span.end, opts.span.start + expressionOffset);
  throw createCompilerError({
    code: opts.code,
    filePath: opts.filePath,
    source: opts.source,
    span: {
      start,
      end: Math.max(start + 1, start + (diagnostic.length ?? 1)),
    },
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    hint: 'Template braces must contain a valid JavaScript expression. Use native JS control lines outside braces for blocks.',
  });
}

function getParseDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  return (sourceFile as SourceFileWithParseDiagnostics).parseDiagnostics ?? [];
}
