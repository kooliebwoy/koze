import ts from 'typescript';
import type { KuratchiTemplateAst, KuratchiTemplateTagAst } from './ast.js';
import { collectReferencedIdentifiers, parseImportStatement, parseNamedImportBindings } from './import-linking.js';
import { buildKuratchiModuleIr, type KuratchiModuleIr } from './ir.js';
import { parseKuratchiSfc } from './sfc-parser.js';
import { createCompilerError } from './diagnostics.js';
import {
  getKuratchiTemplateTags,
  parseKuratchiTemplate,
  stripKuratchiTemplateCompilerIgnoredNodes,
} from './template-parser.js';
import { validateKuratchiAst } from './validation.js';
import { validateKuratchiVirtualModuleImport } from './virtual-modules.js';

/**
 * HTML file parser.
 *
 * Extracts the single top-level client <script> block before the HTML document.
 * Additional <script> tags are rejected so JavaScript is never parsed as template.
 * Everything else is the template — full HTML with native JS flow control.
 * <style> inside the HTML is NOT extracted; it's part of the template.
 */

export interface ParsedFile {
  /** AST/IR boundary used by the compiler pipeline. */
  ir: KuratchiModuleIr;
  /** Script content (compile-time code, minus imports) */
  script: string | null;
  /** Explicit server-side load function exported from the route script */
  loadFunction: string | null;
  /** Template — the full HTML document with inline JS flow control */
  template: string;
  /** All imports from the script block */
  serverImports: string[];
  /** Whether the script has server-side code (beyond imports) */
  hasLoad: boolean;
  /** Action functions referenced via action={fn} in the template */
  actionFunctions: string[];
  /** Top-level variable names declared in the script (const/let/var) */
  dataVars: string[];
  /**
   * Component imports. Three forms are accepted:
   *
   *   import Name from '$lib/file.koze'         → { Name: 'file' }
   *   import Name from '@scope/pkg/file.koze'   → { Name: '@scope/pkg:file' }
   *   import Name from './widgets/card.koze'    → { Name: '__rel__:./widgets/card' }
   *   import Name from '../shared/badge.koze'   → { Name: '__rel__:../shared/badge' }
   *
   * The "__rel__:" prefix marks a path that the component compiler must
   * resolve against the importer's directory rather than the project's
   * `src/lib` or `node_modules`. The component compiler strips the prefix
   * and joins the remaining specifier with the importer's `path.dirname`.
   */
  componentImports: Record<string, string>;
  /**
   * Server function names referenced from the template (currently: await
   * template query targets such as `{await getStatus()}`). The compiler uses
   * this list to import those functions server-side during SSR.
   *
   * NOTE: legacy field name — kept for backward compatibility with the rest of
   * the compiler pipeline. There is no `data-poll` attribute.
   */
  pollFunctions: string[];
  /**
   * Await template queries (`{await fn(args)}`) that need a hoisted binding in
   * the rendered output. Legacy field name; `data-get`/`data-as` are no longer
   * supported authored attributes.
   */
  dataGetQueries: Array<{ fnName: string; argsExpr: string; asName: string; key?: string; rpcId?: string; awaitExpr?: string }>;
  /** Imports found in a top-level client script block */
  clientImports: string[];
  /** Top-level route/layout imports from $lib/* */
  routeClientImports: string[];
  /** Local binding names introduced by top-level $lib/* imports */
  routeClientImportBindings: string[];
  /** Top-level names returned from explicit load() */
  loadReturnVars: string[];
  /** Local aliases for Cloudflare Workers env imported from cloudflare:workers */
  workerEnvAliases: string[];
  /** Local aliases for dev imported from koze/environment */
  devAliases: string[];
  /** Imports from koze:request - serialized for client */
  requestImports: Array<{ exportName: string; alias: string }>;
  
  // === New fields for RFC 0002: Client-First Script Model ===
  /** Raw client script content (the entire <script> block body) */
  clientScriptRaw: string | null;
  /** Imports from $server/ - these become RPC calls */
  serverRpcImports: string[];
  /** Function names imported from $server/ */
  serverRpcFunctions: string[];
  /** Top-level action aliases declared with augment(serverAction, hooks?) */
  actionAliases: AugmentedActionAlias[];
  /** Top-level await calls to $server/ functions - executed at SSR time */
  ssrAwaitCalls: Array<{ varName: string; fnName: string; argsExpr: string }>;
  /** npm package imports in client script - bundled with esbuild */
  clientNpmImports: string[];
}

export interface AugmentedActionAlias {
  name: string;
  target: string;
  augmentLocal: string;
}

interface ParseFileOptions {
  kind?: 'route' | 'layout' | 'component';
  filePath?: string;
}

interface TopLevelImportStatement {
  text: string;
  start: number;
  end: number;
}

function getTopLevelImportStatements(source: string): TopLevelImportStatement[] {
  const sourceFile = ts.createSourceFile('kuratchi-script.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports: TopLevelImportStatement[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    imports.push({
      text: source.slice(statement.getStart(sourceFile), statement.getEnd()),
      start: statement.getStart(sourceFile),
      end: statement.getEnd(),
    });
  }

  return imports;
}

export function stripTopLevelImports(source: string): string {
  const imports = getTopLevelImportStatements(source);
  if (imports.length === 0) return source.trim();

  let cursor = 0;
  let output = '';
  for (const statement of imports) {
    output += source.slice(cursor, statement.start);
    cursor = statement.end;
  }
  output += source.slice(cursor);
  return output.trim();
}

function hasReactiveLabel(scriptBody: string): boolean {
  return /\$\s*:/.test(scriptBody);
}

function collectDeclaredBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    names.push(...collectDeclaredBindingNames(element.name));
  }
  return names;
}

function collectReactiveAssignmentTargetNames(node: ts.Node, out: Set<string>): void {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;

  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if ((kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment) && ts.isIdentifier(node.left)) {
      out.add(node.left.text);
    }
  } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)) {
    if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
      out.add(node.operand.text);
    }
  }

  node.forEachChild((child) => collectReactiveAssignmentTargetNames(child, out));
}

function collectTopLevelReactiveDerivedNames(scriptBody: string): string[] {
  if (!hasReactiveLabel(scriptBody)) return [];

  const sourceFile = ts.createSourceFile('kuratchi-reactive-derived.ts', scriptBody, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declared = new Set<string>();
  const reactiveAssigned = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) declared.add(clause.name.text);
      if (clause.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) declared.add(element.name.text);
        } else if (ts.isNamespaceImport(clause.namedBindings)) {
          declared.add(clause.namedBindings.name.text);
        }
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of collectDeclaredBindingNames(declaration.name)) declared.add(name);
      }
      continue;
    }

    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      declared.add(statement.name.text);
      continue;
    }

    if (ts.isLabeledStatement(statement) && statement.label.text === '$') {
      collectReactiveAssignmentTargetNames(statement.statement, reactiveAssigned);
    }
  }

  return Array.from(reactiveAssigned).filter((name) => !declared.has(name));
}

function injectImplicitReactiveDeclarations(scriptBody: string): string {
  const derivedNames = collectTopLevelReactiveDerivedNames(scriptBody);
  if (derivedNames.length === 0) return scriptBody;
  return `let ${derivedNames.join(', ')};\n${scriptBody}`;
}

const TEMPLATE_JS_CONTROL_PATTERNS = [
  /^\s*for\s*\(/,
  /^\s*if\s*\(/,
  /^\s*while\s*\(/,
  /^\s*switch\s*\(/,
  /^\s*case\s+.+:\s*$/,
  /^\s*default\s*:\s*$/,
  /^\s*do\s*\{?\s*$/,
  /^\s*try\s*\{?\s*$/,
  /^\s*\}?\s*catch\s*\(/,
  /^\s*\}?\s*finally\s*\{?\s*$/,
  /^\s*\}\s*while\s*\(/,
  /^\s*break\s*;\s*$/,
  /^\s*continue\s*;\s*$/,
  /^\s*throw\b[\s\S]*;\s*$/,
  /^\s*\}\s*else\s*if\s*\(/,
  /^\s*\}\s*else\s*\{?\s*$/,
  /^\s*\}\s*$/,
  /^\s*\w[\w.]*\s*(\+\+|--)\s*;\s*$/,
  /^\s*(let|const|var)\s+/,
];

function isTemplateJsControlLine(line: string): boolean {
  return TEMPLATE_JS_CONTROL_PATTERNS.some((pattern) => pattern.test(line));
}

function splitTopLevel(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

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

    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
    else if (ch === delimiter && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(input.slice(start));
  return parts;
}

function findTopLevelChar(input: string, target: string): number {
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

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

    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
    else if (ch === target && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      return i;
    }
  }

  return -1;
}

function pushIdentifier(name: string, out: string[]) {
  if (!name) return;
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;
  if (!out.includes(name)) out.push(name);
}

function findMatchingToken(input: string, openPos: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let i = openPos; i < input.length; i++) {
    const ch = input[i];

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
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function extractCloudflareEnvAliases(importLine: string): string[] {
  if (!/from\s+['"]cloudflare:workers['"]/.test(importLine)) return [];
  const namedMatch = importLine.match(/import\s*\{([\s\S]*?)\}\s*from\s+['"]cloudflare:workers['"]/);
  if (!namedMatch) return [];

  const aliases: string[] = [];
  for (const rawPart of splitTopLevel(namedMatch[1], ',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const envMatch = part.match(/^env(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
    if (envMatch) aliases.push(envMatch[1] || 'env');
  }
  return aliases;
}

function isTypeOnlyImportLine(importLine: string): boolean {
  return /^\s*import\s+type\b/.test(importLine);
}

function isKozePackageSpecifier(moduleSpecifier: string): boolean {
  return moduleSpecifier === 'koze' || moduleSpecifier === '@kuratchi/koze' || moduleSpecifier === '@kuratchi/js';
}

function getAugmentImportAliases(scriptBody: string): Set<string> {
  const aliases = new Set<string>();
  const sourceFile = ts.createSourceFile('kuratchi-augment-imports.ts', scriptBody, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!isKozePackageSpecifier(statement.moduleSpecifier.text)) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      const imported = element.propertyName?.text || element.name.text;
      if (imported === 'augment') aliases.add(element.name.text);
    }
  }
  aliases.add('augment');
  return aliases;
}

export function collectAugmentedActionAliases(scriptBody: string): AugmentedActionAlias[] {
  if (!scriptBody || !/\baugment\b/.test(scriptBody)) return [];
  const augmentAliases = getAugmentImportAliases(scriptBody);
  const sourceFile = ts.createSourceFile('kuratchi-augment-actions.ts', scriptBody, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases: AugmentedActionAlias[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const initializer = declaration.initializer;
      if (!initializer || !ts.isCallExpression(initializer)) continue;
      if (!ts.isIdentifier(initializer.expression)) continue;
      if (!augmentAliases.has(initializer.expression.text)) continue;
      const firstArg = initializer.arguments[0];
      if (!firstArg || !ts.isIdentifier(firstArg)) continue;
      aliases.push({
        name: declaration.name.text,
        target: firstArg.text,
        augmentLocal: initializer.expression.text,
      });
    }
  }

  return aliases;
}

export function stripAugmentedActionDeclarations(scriptBody: string, aliases: AugmentedActionAlias[]): string {
  if (!scriptBody || aliases.length === 0) return scriptBody;
  const aliasNames = new Set(aliases.map((alias) => alias.name));
  const sourceFile = ts.createSourceFile('kuratchi-strip-augment-actions.ts', scriptBody, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let changed = false;
  const result = ts.transform(sourceFile, [context => {
    const factory = context.factory;
    const visit: ts.Visitor = (node) => {
      if (ts.isSourceFile(node)) {
        const statements: ts.Statement[] = [];
        for (const statement of node.statements) {
          if (ts.isVariableStatement(statement)) {
            const remaining = statement.declarationList.declarations.filter((declaration) =>
              !(ts.isIdentifier(declaration.name) && aliasNames.has(declaration.name.text)),
            );
            if (remaining.length === 0) {
              changed = true;
              continue;
            }
            if (remaining.length !== statement.declarationList.declarations.length) {
              changed = true;
              statements.push(factory.updateVariableStatement(
                statement,
                statement.modifiers,
                factory.updateVariableDeclarationList(statement.declarationList, remaining),
              ));
              continue;
            }
          }
          statements.push(statement);
        }
        return factory.updateSourceFile(node, statements);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return file => ts.visitNode(file, visit) as ts.SourceFile;
  }]);
  const transformed = result.transformed[0] as ts.SourceFile;
  const output = changed ? ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(transformed) : scriptBody;
  result.dispose();
  return output;
}

export function rewriteAugmentedActionInitializersForClient(scriptBody: string, aliases: AugmentedActionAlias[]): string {
  if (!scriptBody || aliases.length === 0) return scriptBody;
  const aliasByName = new Map(aliases.map((alias) => [alias.name, alias]));
  const sourceFile = ts.createSourceFile('koze-client-augment-actions.ts', scriptBody, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let changed = false;
  const result = ts.transform(sourceFile, [context => {
    const factory = context.factory;
    const visit: ts.Visitor = (node) => {
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && aliasByName.has(node.name.text)
        && node.initializer
        && ts.isCallExpression(node.initializer)
      ) {
        const alias = aliasByName.get(node.name.text)!;
        changed = true;
        const rewritten = factory.createCallExpression(
          factory.createPropertyAccessExpression(factory.createIdentifier('window'), factory.createIdentifier('__kozeAugment')),
          undefined,
          [
            factory.createStringLiteral(alias.name),
            factory.createStringLiteral(alias.target),
            ...node.initializer.arguments,
          ],
        );
        return factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type, rewritten);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return file => ts.visitNode(file, visit) as ts.SourceFile;
  }]);
  const transformed = result.transformed[0] as ts.SourceFile;
  const output = changed ? ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(transformed) : scriptBody;
  result.dispose();
  return output;
}

export function stripAugmentImportSpecifier(scriptBody: string): string {
  if (!scriptBody || !/\baugment\b/.test(scriptBody)) return scriptBody;
  const sourceFile = ts.createSourceFile('kuratchi-strip-augment-import.ts', scriptBody, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let changed = false;
  const result = ts.transform(sourceFile, [context => {
    const factory = context.factory;
    const visit: ts.Visitor = (node) => {
      if (ts.isSourceFile(node)) {
        const statements: ts.Statement[] = [];
        for (const statement of node.statements) {
          if (
            ts.isImportDeclaration(statement)
            && ts.isStringLiteral(statement.moduleSpecifier)
            && isKozePackageSpecifier(statement.moduleSpecifier.text)
            && statement.importClause?.namedBindings
            && ts.isNamedImports(statement.importClause.namedBindings)
          ) {
            const named = statement.importClause.namedBindings;
            const remaining = named.elements.filter((element) => (element.propertyName?.text || element.name.text) !== 'augment');
            if (remaining.length !== named.elements.length) {
              changed = true;
              if (remaining.length === 0 && !statement.importClause.name) {
                continue;
              }
              statements.push(factory.updateImportDeclaration(
                statement,
                statement.modifiers,
                factory.updateImportClause(
                  statement.importClause,
                  statement.importClause.isTypeOnly,
                  statement.importClause.name,
                  factory.updateNamedImports(named, remaining),
                ),
                statement.moduleSpecifier,
                statement.attributes,
              ));
              continue;
            }
          }
          statements.push(statement);
        }
        return factory.updateSourceFile(node, statements);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return file => ts.visitNode(file, visit) as ts.SourceFile;
  }]);
  const transformed = result.transformed[0] as ts.SourceFile;
  const output = changed ? ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(transformed) : scriptBody;
  result.dispose();
  return output;
}

function extractKuratchiEnvironmentDevAliases(importLine: string): string[] {
  const parsed = parseImportStatement(importLine);
  const moduleSpecifier = parsed.moduleSpecifier;
  if (
    moduleSpecifier !== 'koze:environment' &&
    moduleSpecifier !== 'koze/environment' &&
    moduleSpecifier !== 'kuratchi:environment' &&
    moduleSpecifier !== '@kuratchi/koze/environment' &&
    moduleSpecifier !== '@kuratchi/js/environment'
  ) {
    return [];
  }

  if (parsed.namespaceImport || parsed.bindings.length === 0) {
    throw new Error('[koze compiler] koze:environment only supports named imports.');
  }

  const aliases: string[] = [];
  for (const binding of parsed.bindings) {
    if (binding.imported !== 'dev') {
      throw new Error('[koze compiler] koze:environment currently only exports `dev`.');
    }
    aliases.push(binding.local);
  }
  return aliases;
}

interface KuratchiRequestImport {
  exportName: string;
  alias: string;
}

function extractKuratchiRequestImports(importLine: string): KuratchiRequestImport[] {
  const parsed = parseImportStatement(importLine);
  if (
    parsed.moduleSpecifier !== 'koze:request' &&
    parsed.moduleSpecifier !== 'koze/request' &&
    parsed.moduleSpecifier !== 'kuratchi:request' &&
    parsed.moduleSpecifier !== '@kuratchi/koze/request' &&
    parsed.moduleSpecifier !== '@kuratchi/js/request'
  ) {
    return [];
  }
  validateKuratchiVirtualModuleImport('koze:request', parsed.bindings, parsed.namespaceImport, 'route');

  const imports: KuratchiRequestImport[] = [];
  for (const binding of parsed.bindings) {
    imports.push({ exportName: binding.imported, alias: binding.local });
  }
  return imports;
}

function extractReturnObjectKeys(body: string): string[] {
  const keys: string[] = [];
  let i = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  while (i < body.length) {
    const ch = body[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        i++;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch as '"' | "'" | '`';
      i++;
      continue;
    }

    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);

    if (depthParen !== 0 || depthBracket !== 0 || depthBrace !== 0) {
      i++;
      continue;
    }

    const rest = body.slice(i);
    const returnMatch = /^return\b/.exec(rest);
    if (!returnMatch) {
      i++;
      continue;
    }

    i += returnMatch[0].length;
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] !== '{') continue;

    const closeIdx = findMatchingToken(body, i, '{', '}');
    if (closeIdx === -1) break;

    const objectBody = body.slice(i + 1, closeIdx);
    for (const rawProp of splitTopLevel(objectBody, ',')) {
      const prop = rawProp.trim();
      if (!prop || prop.startsWith('...')) continue;
      const keyMatch = prop.match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/);
      if (keyMatch) pushIdentifier(keyMatch[1], keys);
    }
    break;
  }

  return keys;
}

function extractBracedAttributeExpression(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  return trimmed.slice(1, -1).trim();
}

function getTemplateTagAttr(tag: KuratchiTemplateTagAst, name: string): string | undefined {
  const attr = tag.attrs.find((candidate) => candidate.name === name);
  if (!attr) return undefined;
  return attr.value ?? '';
}

function getTemplateTagAttrEntries(tag: KuratchiTemplateTagAst): Array<[string, string]> {
  return tag.attrs.map((attr) => [attr.name, attr.value ?? '']);
}

function extractCallExpression(value: string | undefined): { fnName: string; argsExpr: string } | null {
  const expr = extractBracedAttributeExpression(value);
  if (!expr) return null;
  const match = expr.match(/^([A-Za-z_$][\w$]*)\(([\s\S]*)\)$/);
  if (!match) return null;
  return { fnName: match[1], argsExpr: (match[2] || '').trim() };
}

function extractAwaitCallExpression(expr: string): { fnName: string; argsExpr: string } | null {
  const match = expr.trim().match(/^await\s+([A-Za-z_$][\w$]*)\(([\s\S]*)\)$/);
  if (!match) return null;
  return { fnName: match[1], argsExpr: (match[2] || '').trim() };
}

function collectAwaitTemplateQueries(template: string): Array<{ fnName: string; argsExpr: string; asName: string; awaitExpr: string }> {
  const source = template.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const queries: Array<{ fnName: string; argsExpr: string; asName: string; awaitExpr: string }> = [];
  const seen = new Map<string, string>();

  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '{') continue;
    const closeIdx = findMatchingToken(source, i, '{', '}');
    if (closeIdx === -1) continue;
    const inner = source.slice(i + 1, closeIdx).trim();
    const call = extractAwaitCallExpression(inner);
    if (call) {
      const awaitExpr = `${call.fnName}(${call.argsExpr})`;
      if (!seen.has(awaitExpr)) {
        const asName = `__await_query_${queries.length}`;
        seen.set(awaitExpr, asName);
        queries.push({ fnName: call.fnName, argsExpr: call.argsExpr, asName, awaitExpr });
      }
    }
    i = closeIdx;
  }

  return queries;
}

function extractTopLevelImportNames(source: string): string[] {
  const sourceFile = ts.createSourceFile('kuratchi-inline-client.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) pushIdentifier(clause.name.text, names);
    if (!clause.namedBindings) continue;
    if (ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        pushIdentifier(element.name.text, names);
      }
    } else if (ts.isNamespaceImport(clause.namedBindings)) {
      pushIdentifier(clause.namedBindings.name.text, names);
    }
  }

  return names;
}

function extractImportModuleSpecifier(source: string): string | null {
  const sourceFile = ts.createSourceFile('kuratchi-import-spec.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = sourceFile.statements.find(ts.isImportDeclaration);
  if (!statement || !ts.isStringLiteral(statement.moduleSpecifier)) return null;
  return statement.moduleSpecifier.text;
}

function isExecutableTemplateScript(attrs: string): boolean {
  if (/\bsrc\s*=/i.test(attrs)) return false;
  const typeMatch = attrs.match(/\btype\s*=\s*(['"])(.*?)\1/i);
  const type = typeMatch?.[2]?.trim().toLowerCase();
  if (!type) return true;
  return type === 'module' || type === 'text/javascript' || type === 'application/javascript';
}

function collectTemplateClientDeclaredNames(template: string): string[] {
  const declared = new Set<string>();
  const templateAst = parseKuratchiTemplate(template);

  for (const node of templateAst.nodes) {
    if (node.kind !== 'raw-block' || node.name !== 'script') continue;
    const attrs = node.attrs.map((attr) => attr.raw).join(' ');
    const body = node.content;
    if (!isExecutableTemplateScript(attrs)) continue;
    // TypeScript source works directly for reference collection
    for (const name of extractTopLevelImportNames(body)) declared.add(name);
    for (const name of extractTopLevelDataVars(body)) declared.add(name);
    for (const name of extractTopLevelFunctionNames(body)) declared.add(name);
  }

  return Array.from(declared);
}

function extractBraceExpressions(line: string): Array<{ expression: string; attrName: string | null }> {
  const expressions: Array<{ expression: string; attrName: string | null }> = [];
  let cursor = 0;

  while (cursor < line.length) {
    const openIdx = line.indexOf('{', cursor);
    if (openIdx === -1) break;
    const closeIdx = findMatchingToken(line, openIdx, '{', '}');
    if (closeIdx === -1) break;

    const expression = line.slice(openIdx + 1, closeIdx).trim();
    const beforeBrace = line.slice(0, openIdx);
    const charBefore = openIdx > 0 ? line[openIdx - 1] : '';
    let attrName: string | null = null;
    if (charBefore === '=') {
      const attrMatch = beforeBrace.match(/([\w-]+)=$/);
      attrName = attrMatch ? attrMatch[1] : null;
    }

    expressions.push({ expression, attrName });
    cursor = closeIdx + 1;
  }

  return expressions;
}

function normalizeTemplateBraceExpression(expression: string): string {
  const trimmed = expression.trim();
  if (trimmed.startsWith('@raw ')) return trimmed.slice(5).trim();
  if (trimmed.startsWith('@html ')) return trimmed.slice(6).trim();
  if (trimmed.startsWith('...')) return trimmed.slice(3).trim();
  return trimmed;
}

interface TemplateReferenceLocalScope {
  names: string[];
  depth: number;
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

function extractTemplateForLocalNames(line: string): string[] {
  const source = line.trim().endsWith('{') ? `${line}\n}` : line;
  const sourceFile = ts.createSourceFile(
    'kuratchi-template-for-local.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isForStatement(node) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations) {
        for (const name of collectDeclaredBindingNames(declaration.name)) {
          if (!names.includes(name)) names.push(name);
        }
      }
    } else if ((ts.isForOfStatement(node) || ts.isForInStatement(node)) && ts.isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations) {
        for (const name of collectDeclaredBindingNames(declaration.name)) {
          if (!names.includes(name)) names.push(name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return names;
}

function extractTemplateCatchLocalNames(line: string): string[] {
  if (!/^\s*\}?\s*catch\s*\(/.test(line)) return [];

  const normalized = line.trim().replace(/^\}\s*/, '');
  const source = `try {} ${normalized.endsWith('{') ? `${normalized}\n}` : normalized}`;
  const sourceFile = ts.createSourceFile(
    'kuratchi-template-catch-local.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      for (const name of collectDeclaredBindingNames(node.variableDeclaration.name)) {
        if (!names.includes(name)) names.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return names;
}

function extractTemplateDeclarationLocalNames(line: string): string[] {
  const sourceFile = ts.createSourceFile(
    'kuratchi-template-declaration.ts',
    line.trim().endsWith(';') ? line : `${line};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names: string[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      for (const name of collectDeclaredBindingNames(declaration.name)) {
        if (!names.includes(name)) names.push(name);
      }
    }
  }

  return names;
}

function collectServerTemplateReferencesFromTemplateAst(templateAst: KuratchiTemplateAst): Set<string> {
  const refs = new Set<string>();
  const stripped = stripKuratchiTemplateCompilerIgnoredNodes(templateAst);
  const lines = stripped.split('\n');
  const localScopeStack: TemplateReferenceLocalScope[] = [];
  let templateBlockDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const activeLocalNames = new Set(localScopeStack.flatMap((scope) => scope.names));
    const isControlLine = isTemplateJsControlLine(trimmed);

    if (isControlLine) {
      for (const ref of collectReferencedIdentifiers(trimmed)) {
        if (!activeLocalNames.has(ref)) refs.add(ref);
      }

      const nextDepth = templateBlockDepth + templateBraceDelta(trimmed);
      while (localScopeStack.length > 0 && localScopeStack[localScopeStack.length - 1].depth > nextDepth) {
        localScopeStack.pop();
      }

      const forLocals = extractTemplateForLocalNames(trimmed);
      if (forLocals.length > 0 && nextDepth > templateBlockDepth) {
        localScopeStack.push({ names: forLocals, depth: nextDepth });
      }

      const catchLocals = extractTemplateCatchLocalNames(trimmed);
      if (catchLocals.length > 0 && nextDepth > 0) {
        localScopeStack.push({ names: catchLocals, depth: nextDepth });
      }

      const declaredLocals = extractTemplateDeclarationLocalNames(trimmed);
      if (declaredLocals.length > 0 && forLocals.length === 0 && catchLocals.length === 0) {
        localScopeStack.push({ names: declaredLocals, depth: Math.max(nextDepth, templateBlockDepth) });
      }

      templateBlockDepth = nextDepth;
    }

    if (isControlLine) continue;

    for (const entry of extractBraceExpressions(line)) {
      const expression = normalizeTemplateBraceExpression(entry.expression);
      if (!expression) continue;
      if (entry.attrName && /^on[A-Za-z]+$/i.test(entry.attrName)) continue;
      for (const ref of collectReferencedIdentifiers(expression)) {
        if (!activeLocalNames.has(ref)) refs.add(ref);
      }
    }
  }

  return refs;
}

export function collectServerTemplateReferences(template: string): Set<string> {
  return collectServerTemplateReferencesFromTemplateAst(parseKuratchiTemplate(template));
}

function extractExplicitLoad(scriptBody: string): { loadFunction: string | null; remainingScript: string; returnVars: string[] } {
  let i = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  while (i < scriptBody.length) {
    const ch = scriptBody[i];

    if (quote) {
      if (escaped) {
        escaped = false;
        i++;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch as '"' | "'" | '`';
      i++;
      continue;
    }

    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);

    if (depthParen !== 0 || depthBracket !== 0 || depthBrace !== 0) {
      i++;
      continue;
    }

    const rest = scriptBody.slice(i);
    const fnMatch = /^export\s+(async\s+)?function\s+load\s*/.exec(rest);
    if (!fnMatch) {
      i++;
      continue;
    }

    const openParen = i + fnMatch[0].length;
    if (scriptBody[openParen] !== '(') {
      throw new Error('[koze compiler] Could not parse exported load() declaration.');
    }

    const closeParen = findMatchingToken(scriptBody, openParen, '(', ')');
    if (closeParen === -1) {
      throw new Error('[koze compiler] Could not parse exported load() parameters.');
    }

    let openBrace = closeParen + 1;
    while (openBrace < scriptBody.length && /\s/.test(scriptBody[openBrace])) openBrace++;
    if (scriptBody[openBrace] !== '{') {
      throw new Error('[koze compiler] export load() must use a function body.');
    }

    const closeBrace = findMatchingToken(scriptBody, openBrace, '{', '}');
    if (closeBrace === -1) {
      throw new Error('[koze compiler] Could not parse exported load() body.');
    }

    return {
      loadFunction: scriptBody.slice(i, closeBrace + 1).trim(),
      remainingScript: `${scriptBody.slice(0, i)}\n${scriptBody.slice(closeBrace + 1)}`.trim(),
      returnVars: extractReturnObjectKeys(scriptBody.slice(openBrace + 1, closeBrace)),
    };
  }

  return { loadFunction: null, remainingScript: scriptBody.trim(), returnVars: [] };
}

function hasFrameworkEnvEscapeHatch(source: string): boolean {
  return /\bglobalThis\.__cloudflare_env__\b/.test(source) || /\b__cloudflare_env__\b/.test(source);
}

function buildEnvAccessError(
  kind: 'route' | 'layout' | 'component',
  filePath: string | undefined,
  detail: string,
): Error {
  const guidance =
    kind === 'route'
      ? 'Route top-level <script> is client-first. Put Cloudflare env access inside export load() or move it to $server modules.'
      : kind === 'layout'
        ? 'Layout scripts cannot access Cloudflare env directly.'
        : 'Component scripts cannot access Cloudflare env directly.';
  return createCompilerError({
    code: 'KUR_ENV_ACCESS',
    filePath,
    message: detail,
    hint: `${guidance}\nRead env on the server and pass the value into the template explicitly.`,
  });
}

function collectPatternNames(pattern: string, out: string[]) {
  const p = pattern.trim();
  if (!p) return;

  if (p.startsWith('{') && p.endsWith('}')) {
    const body = p.slice(1, -1);
    for (const partRaw of splitTopLevel(body, ',')) {
      let part = partRaw.trim();
      if (!part) continue;
      if (part.startsWith('...')) part = part.slice(3).trim();
      const eqIdx = part.indexOf('=');
      if (eqIdx !== -1) part = part.slice(0, eqIdx).trim();
      const colonIdx = part.indexOf(':');
      if (colonIdx !== -1) {
        const rhs = part.slice(colonIdx + 1).trim();
        collectPatternNames(rhs, out);
      } else {
        pushIdentifier(part, out);
      }
    }
    return;
  }

  if (p.startsWith('[') && p.endsWith(']')) {
    const body = p.slice(1, -1);
    for (const partRaw of splitTopLevel(body, ',')) {
      let part = partRaw.trim();
      if (!part) continue;
      if (part.startsWith('...')) part = part.slice(3).trim();
      const eqIdx = part.indexOf('=');
      if (eqIdx !== -1) part = part.slice(0, eqIdx).trim();
      collectPatternNames(part, out);
    }
    return;
  }

  const eqIdx = p.indexOf('=');
  const ident = (eqIdx === -1 ? p : p.slice(0, eqIdx)).trim();
  pushIdentifier(ident, out);
}

function isBoundaryChar(ch: string | undefined): boolean {
  if (!ch) return true;
  return !/[A-Za-z0-9_$]/.test(ch);
}

function extractTopLevelDataVars(scriptBody: string): string[] {
  const vars: string[] = [];
  let i = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < scriptBody.length) {
    const ch = scriptBody[i];
    const next = scriptBody[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        i++;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch as '"' | "'" | '`';
      i++;
      continue;
    }

    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);

    const atTopLevel = depthParen === 0 && depthBracket === 0 && depthBrace === 0;
    if (!atTopLevel) {
      i++;
      continue;
    }

    const remaining = scriptBody.slice(i);
    const match = /^(const|let|var)\b/.exec(remaining);
    if (!match) {
      i++;
      continue;
    }

    const keyword = match[1];
    const before = scriptBody[i - 1];
    const after = scriptBody[i + keyword.length];
    if (!isBoundaryChar(before) || !isBoundaryChar(after)) {
      i++;
      continue;
    }

    i += keyword.length;

    let declStart = i;
    let localParen = 0;
    let localBracket = 0;
    let localBrace = 0;
    let localQuote: '"' | "'" | '`' | null = null;
    let localEscaped = false;

    while (i < scriptBody.length) {
      const c = scriptBody[i];

      if (localQuote) {
        if (localEscaped) {
          localEscaped = false;
          i++;
          continue;
        }
        if (c === '\\') {
          localEscaped = true;
          i++;
          continue;
        }
        if (c === localQuote) localQuote = null;
        i++;
        continue;
      }

      if (c === '"' || c === "'" || c === '`') {
        localQuote = c as '"' | "'" | '`';
        i++;
        continue;
      }

      if (c === '(') localParen++;
      else if (c === ')') localParen = Math.max(0, localParen - 1);
      else if (c === '[') localBracket++;
      else if (c === ']') localBracket = Math.max(0, localBracket - 1);
      else if (c === '{') localBrace++;
      else if (c === '}') localBrace = Math.max(0, localBrace - 1);

      if (c === ';' && localParen === 0 && localBracket === 0 && localBrace === 0) {
        const decl = scriptBody.slice(declStart, i).trim();
        for (const item of splitTopLevel(decl, ',')) {
          const trimmed = item.trim();
          if (!trimmed) continue;
          const eqIdx = findTopLevelChar(trimmed, '=');
          const pattern = eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx).trim();
          collectPatternNames(pattern, vars);
        }
        i++;
        break;
      }

      i++;
    }

    // Semicolon-less declaration at EOF
    if (i >= scriptBody.length) {
      const decl = scriptBody.slice(declStart).trim();
      for (const item of splitTopLevel(decl, ',')) {
        const trimmed = item.trim();
        if (!trimmed) continue;
        const eqIdx = findTopLevelChar(trimmed, '=');
        const pattern = eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx).trim();
        collectPatternNames(pattern, vars);
      }
    }
  }

  return vars;
}

function extractTopLevelFunctionNames(scriptBody: string): string[] {
  const names: string[] = [];
  let i = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < scriptBody.length) {
    const ch = scriptBody[i];
    const next = scriptBody[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        i++;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch as '"' | "'" | '`';
      i++;
      continue;
    }

    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);

    if (depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      const rest = scriptBody.slice(i);
      const fnMatch = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
      if (fnMatch) {
        pushIdentifier(fnMatch[1], names);
        i += fnMatch[0].length;
        continue;
      }
    }

    i++;
  }

  return names;
}

// === RFC 0002: Client-First Script Model Helpers ===

/**
 * Check if an import is from $server/
 */
function isServerRpcImport(moduleSpecifier: string | null): boolean {
  return moduleSpecifier?.startsWith('$server/') ?? false;
}

/**
 * Extract function names from a $server/ import statement
 */
function extractServerRpcFunctionNames(importLine: string): string[] {
  const names: string[] = [];
  const sourceFile = ts.createSourceFile('kuratchi-rpc-import.ts', importLine, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    
    // Default import
    if (clause.name) {
      names.push(clause.name.text);
    }
    
    // Named imports: import { fn1, fn2 } from '$server/...'
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        names.push(element.name.text);
      }
    }
    
    // Namespace import: import * as server from '$server/...'
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      names.push(clause.namedBindings.name.text);
    }
  }
  
  return names;
}

/**
 * Extract top-level await calls to specific function names.
 * Returns: { varName: 'messages', fnName: 'getMessages', argsExpr: 'params.id' }
 */
function extractTopLevelAwaitCalls(scriptBody: string, targetFunctions: Set<string>): Array<{ varName: string; fnName: string; argsExpr: string }> {
  const calls: Array<{ varName: string; fnName: string; argsExpr: string }> = [];
  const sourceFile = ts.createSourceFile('kuratchi-await-calls.ts', scriptBody, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  
  for (const statement of sourceFile.statements) {
    // Look for: const varName = await fnName(args);
    if (!ts.isVariableStatement(statement)) continue;
    
    for (const decl of statement.declarationList.declarations) {
      if (!decl.initializer) continue;
      if (!ts.isIdentifier(decl.name)) continue;
      
      const varName = decl.name.text;
      let awaitExpr = decl.initializer;
      
      // Unwrap await expression
      if (ts.isAwaitExpression(awaitExpr)) {
        awaitExpr = awaitExpr.expression;
      } else {
        continue; // Not an await call
      }
      
      // Check if it's a call expression
      if (!ts.isCallExpression(awaitExpr)) continue;
      
      // Get the function name
      let fnName: string | null = null;
      if (ts.isIdentifier(awaitExpr.expression)) {
        fnName = awaitExpr.expression.text;
      } else if (ts.isPropertyAccessExpression(awaitExpr.expression)) {
        // Handle namespace.fn() calls
        fnName = awaitExpr.expression.getText(sourceFile);
      }
      
      if (!fnName || !targetFunctions.has(fnName.split('.')[0])) continue;
      
      // Extract arguments as string
      const argsExpr = awaitExpr.arguments
        .map(arg => arg.getText(sourceFile))
        .join(', ');
      
      calls.push({ varName, fnName, argsExpr });
    }
  }
  
  return calls;
}

/**
 * Check if a module specifier is an npm package (not a relative/alias import)
 */
function isNpmPackageImport(moduleSpecifier: string | null): boolean {
  if (!moduleSpecifier) return false;
  // Not npm if starts with . / $ or is a koze: virtual module
  if (moduleSpecifier.startsWith('.')) return false;
  if (moduleSpecifier.startsWith('/')) return false;
  if (moduleSpecifier.startsWith('$')) return false;
  if (moduleSpecifier.startsWith('koze:')) return false;
  if (moduleSpecifier.startsWith('kuratchi:')) return false;
  if (moduleSpecifier.startsWith('cloudflare:')) return false;
  // Looks like an npm package
  return true;
}

function isFrameworkVirtualModuleSpecifier(moduleSpecifier: string | null): moduleSpecifier is string {
  return !!moduleSpecifier && (
    moduleSpecifier.startsWith('koze:') ||
    moduleSpecifier.startsWith('kuratchi:')
  );
}

/**
 * Parse a `.koze` route, layout, or component file.
 *
 * The top-level compile-time <script> block is extracted for the compiler.
 * If it includes reactive `$:` labels, it is preserved in template output.
 * Everything else (the HTML document) becomes the template.
 */
export function parseFile(source: string, options: ParseFileOptions = {}): ParsedFile {
  const kind = options.kind || 'route';
  let script: string | null = null;
  let clientScript: string | null = null;
  const sfc = parseKuratchiSfc(source, { kind, filePath: options.filePath });
  validateKuratchiAst(sfc);
  const template = sfc.template.source;

  // RFC 0002: The single top-level <script> block is client-side by design.
  // Server code is accessed via $server/ RPC imports.
  // The script body goes to clientScript for client bundling.
  // We also populate `script` for backward compatibility with server-side template data.
  //
  // The leading block tolerates `<!DOCTYPE ...>` and HTML comments *before*
  // the top <script>, so document-shell files (like `app.koze`) can
  // start with `<!DOCTYPE html>` and still declare a top script. Without
  // this, any file that opens with a DOCTYPE has no way to attach a
  // top-level script. Any later <script> block is rejected below so the
  // template compiler never parses JavaScript as template control flow.
  if (sfc.script) {
    const body = sfc.script.content.trim();
    const normalizedBody = injectImplicitReactiveDeclarations(body);
    // All scripts are client scripts in the new model
    clientScript = body;
    // Also set script for backward compat with server template data extraction
    script = normalizedBody;
  }

  // Extract all imports from script
  const serverImports: string[] = [];
  const clientImports: string[] = [];
  const routeClientImports: string[] = [];
  const routeClientImportBindings: string[] = [];
  const componentImports: Record<string, string> = {};
  const workerEnvAliases: string[] = [];
  const devAliases: string[] = [];
  const requestImports: Array<{ exportName: string; alias: string }> = [];
  if (script) {
    for (const statement of getTopLevelImportStatements(script)) {
      const line = statement.text.trim();
      const moduleSpecifier = extractImportModuleSpecifier(line);
      const parsedImport = parseImportStatement(line);
      if (isFrameworkVirtualModuleSpecifier(parsedImport.moduleSpecifier)) {
        validateKuratchiVirtualModuleImport(
          parsedImport.moduleSpecifier,
          parsedImport.bindings,
          parsedImport.namespaceImport,
          'route',
        );
      }
      // Component imports — three accepted forms (all use `.koze`):
      //
      //   import Name from '$lib/file.koze'        → '$lib' alias
      //   import Name from '@scope/pkg/file.koze'  → published package
      //   import Name from './widgets/card.koze'   → relative to importer
      //   import Name from '../shared/badge.koze'  → relative to importer
      //
      // The "ghost-import" `.html` form is gone — the only thing in the
      // codebase that still ends in `.html` is generated browser output.
      const libMatch = line.match(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]\$lib\/([^'"]+)\.(?:koze|kuratchi)['"]/s);
      const pkgMatch = !libMatch
        ? line.match(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]((?:@[^/'"]+\/[^/'"]+)|[^./@'"][^/'"]*)\/([^'"]+)\.(?:koze|kuratchi)['"]/s)
        : null;
      const relMatch = !libMatch && !pkgMatch
        ? line.match(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"](\.\.?\/[^'"]+)\.(?:koze|kuratchi)['"]/s)
        : null;
      if (libMatch) {
        const componentName = libMatch[1]; // e.g. "StatCard"
        const fileName = libMatch[2]; // e.g. "stat-card"
        componentImports[componentName] = fileName;
      } else if (pkgMatch) {
        const componentName = pkgMatch[1]; // e.g. "Badge"
        const pkg = pkgMatch[2]; // e.g. "@kuratchi/ui"
        const fileName = pkgMatch[3]; // e.g. "badge"
        componentImports[componentName] = `${pkg}:${fileName}`; // e.g. "@kuratchi/ui:badge"
      } else if (relMatch) {
        const componentName = relMatch[1]; // e.g. "Chart"
        const relPath = relMatch[2]; // e.g. "./widgets/chart"
        // Resolve the relative spec against the importing file's
        // directory NOW, while we still have it. Storing the absolute
        // path (rather than the spec) makes the key canonical: two
        // different importers writing `'./foo.koze'` will only
        // share a cache entry when they actually point at the same
        // file on disk. Without this, two routes in different
        // directories that both import `./foo.koze` would collide
        // in `compiledComponentCache`.
        if (options.filePath) {
          const importerDir = options.filePath.replace(/[\\/][^\\/]+$/, '');
          // Manual resolve — we don't import `node:path` here to keep
          // the parser dep-free for any future browser-side usage.
          // The shape is simple: split on `/`, drop `.` segments, pop
          // for `..`, prepend the dir's segments.
          const parts = importerDir.replace(/\\/g, '/').split('/').filter(Boolean);
          const relParts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
          for (const seg of relParts) {
            if (seg === '.') continue;
            if (seg === '..') parts.pop();
            else parts.push(seg);
          }
          // Restore leading `/` on POSIX; Windows abs paths start with
          // a drive letter which `parts` already preserves.
          const isAbs = importerDir.startsWith('/');
          const absPath = (isAbs ? '/' : '') + parts.join('/');
          componentImports[componentName] = `__rel__:${absPath}`;
        } else {
          // No importer path available — fall back to the spec. The
          // component pipeline will throw a clear error when it tries
          // to resolve it without an importer context.
          componentImports[componentName] = `__rel__:${relPath}`;
        }
      } else {
        // `koze:component` is a compile-time-only virtual module
        // — `props<T>()` calls inside component scripts are wired to
        // the component wrapper's props parameter by the component
        // compiler, NOT through a real import. Drop the import line
        // here so it never gets re-emitted into the bundle, and the
        // component compiler's `stripTopLevelImports` doesn't have to
        // double-handle it. Routes/layouts that mistakenly import
        // from `koze:component` fall through to the regular
        // virtual-module pipeline (it resolves to a runtime stub).
        if (moduleSpecifier === 'koze:component' || moduleSpecifier === 'kuratchi:component') {
          continue;
        }
        // Track koze:environment imports - dev flag will be serialized for client
        const devImportAliases = extractKuratchiEnvironmentDevAliases(line);
        if (devImportAliases.length > 0) {
          for (const alias of devImportAliases) {
            if (!devAliases.includes(alias)) devAliases.push(alias);
          }
          // Don't add to serverImports - this is handled specially
          continue;
        }
        // Track koze:request imports - safe subset will be serialized for client
        const reqImports = extractKuratchiRequestImports(line);
        if (reqImports.length > 0) {
          for (const imp of reqImports) {
            if (!requestImports.some(r => r.alias === imp.alias)) {
              requestImports.push(imp);
            }
          }
          // Don't add to serverImports - this is handled specially
          continue;
        }
        // $lib/ imports are isomorphic - they work in both server and client contexts
        // Add to serverImports so they're available in templates, and also track for client bundling
        if (moduleSpecifier?.startsWith('$lib/')) {
          routeClientImports.push(line);
          for (const binding of parsedImport.bindings) {
            pushIdentifier(binding.local, routeClientImportBindings);
          }
          if (parsedImport.namespaceImport) {
            pushIdentifier(parsedImport.namespaceImport, routeClientImportBindings);
          }
        }
        serverImports.push(line);
      }
      if (!isTypeOnlyImportLine(line)) {
        for (const alias of extractCloudflareEnvAliases(line)) {
          if (!workerEnvAliases.includes(alias)) workerEnvAliases.push(alias);
        }
      }
    }
  }
  if (clientScript) {
    for (const statement of getTopLevelImportStatements(clientScript)) {
      const line = statement.text.trim();
      clientImports.push(line);
      const parsedImport = parseImportStatement(line);
      const isTypeOnly = isTypeOnlyImportLine(line);
      if (isFrameworkVirtualModuleSpecifier(parsedImport.moduleSpecifier)) {
        validateKuratchiVirtualModuleImport(
          parsedImport.moduleSpecifier,
          parsedImport.bindings,
          parsedImport.namespaceImport,
          kind === 'route' ? 'route' : 'browser',
        );
      }
      // Track koze:environment imports - dev flag will be serialized for client
      const devImportAliases = extractKuratchiEnvironmentDevAliases(line);
      if (devImportAliases.length > 0) {
        for (const alias of devImportAliases) {
          if (!devAliases.includes(alias)) devAliases.push(alias);
        }
      }
      // Track koze:request imports - safe subset will be serialized for client
      const reqImports = extractKuratchiRequestImports(line);
      if (reqImports.length > 0) {
        for (const imp of reqImports) {
          if (!requestImports.some(r => r.alias === imp.alias)) {
            requestImports.push(imp);
          }
        }
      }
      if (parsedImport.moduleSpecifier === 'cloudflare:workers' && !isTypeOnly) {
        const envAliases = extractCloudflareEnvAliases(line);
        if (kind === 'route') {
          const onlyEnvImport =
            envAliases.length > 0 &&
            !parsedImport.namespaceImport &&
            parsedImport.bindings.length === envAliases.length &&
            parsedImport.bindings.every((binding) => binding.imported === 'env');
          if (!onlyEnvImport) {
            throw buildEnvAccessError(
              kind,
              options.filePath,
              'Route top-level <script> can only import env from cloudflare:workers for export load().',
            );
          }
        } else {
          throw buildEnvAccessError(
            kind,
            options.filePath,
            envAliases.length > 0
              ? 'Client <script> blocks cannot import env from cloudflare:workers.'
              : 'Client <script> blocks cannot import cloudflare:workers.',
          );
        }
      }
    }
    if (hasFrameworkEnvEscapeHatch(clientScript)) {
      throw buildEnvAccessError(
        kind,
        options.filePath,
        'Client <script> blocks cannot access framework env internals.',
      );
    }
  }

  // Extract top-level variable declarations from script body (after removing imports)
  const dataVars: string[] = [];
  const loadReturnVars: string[] = [];
  let scriptBody = '';
  let loadFunction: string | null = null;
  if (script) {
    const rawScriptBody = stripTopLevelImports(script);
    const explicitLoad = extractExplicitLoad(rawScriptBody);
    scriptBody = injectImplicitReactiveDeclarations(explicitLoad.remainingScript);
    loadFunction = explicitLoad.loadFunction;
    for (const name of explicitLoad.returnVars) {
      if (!loadReturnVars.includes(name)) loadReturnVars.push(name);
    }

    if (hasFrameworkEnvEscapeHatch(rawScriptBody)) {
      throw buildEnvAccessError(
        kind,
        options.filePath,
        'Route/component scripts cannot access framework env internals.',
      );
    }

    if (workerEnvAliases.length > 0 && kind === 'route') {
      const remainingRefs = collectReferencedIdentifiers(explicitLoad.remainingScript);
      const leakedAlias = workerEnvAliases.find((alias) => remainingRefs.has(alias));
      if (leakedAlias) {
        throw buildEnvAccessError(
          kind,
          options.filePath,
          `Cloudflare env alias "${leakedAlias}" can only be used inside export load() in a route script.`,
        );
      }
    }

    if (workerEnvAliases.length > 0 && kind !== 'route') {
      throw buildEnvAccessError(
        kind,
        options.filePath,
        `Imported env from cloudflare:workers in a ${kind} script.`,
      );
    }

    const topLevelVars = extractTopLevelDataVars(scriptBody);
    for (const v of topLevelVars) dataVars.push(v);
    const topLevelFns = extractTopLevelFunctionNames(scriptBody);
    for (const fn of topLevelFns) {
      if (!dataVars.includes(fn)) dataVars.push(fn);
    }
    for (const name of loadReturnVars) {
      if (!dataVars.includes(name)) dataVars.push(name);
    }

    // Server import named bindings are also data vars (available in templates)
    for (const line of serverImports) {
      for (const binding of parseNamedImportBindings(line)) {
        const localName = binding.local.trim();
        if (localName && !dataVars.includes(localName)) dataVars.push(localName);
      }
    }
  }

  const hasLoad = scriptBody.length > 0 || !!loadFunction;

  // Strip HTML comments from the template before scanning for action references.
  // This prevents commented-out code (<!-- ... -->) from being parsed as live
  // action expressions, which would cause false "Invalid action expression" errors.
  const templateForCompilerScan = stripKuratchiTemplateCompilerIgnoredNodes(sfc.template);
  const templateTags = getKuratchiTemplateTags(sfc.template);
  const actionFunctions: string[] = [];
  // `templateServerFunctions` collects server function names referenced by the
  // template (currently: await template queries). The compiler uses this list
  // to import those functions server-side when rendering the route.
  const templateServerFunctions: string[] = [];
  const awaitTemplateQueries: Array<{
    fnName: string;
    argsExpr: string;
    asName: string;
    key?: string;
    rpcId?: string;
    awaitExpr?: string;
  }> = [];

  for (const tag of templateTags) {
    if (tag.closing) continue;

    const actionExpr = extractBracedAttributeExpression(getTemplateTagAttr(tag, 'action'));
    if (actionExpr && /^[A-Za-z_$][\w$]*$/.test(actionExpr) && !actionFunctions.includes(actionExpr)) {
      actionFunctions.push(actionExpr);
    }

    for (const [attrName, attrValue] of getTemplateTagAttrEntries(tag)) {
      if (/^on[A-Za-z]+$/i.test(attrName)) {
        const actionCall = extractCallExpression(attrValue);
        if (actionCall && !actionFunctions.includes(actionCall.fnName)) actionFunctions.push(actionCall.fnName);
      }
    }
  }

  for (const awaitQuery of collectAwaitTemplateQueries(templateForCompilerScan)) {
    if (!templateServerFunctions.includes(awaitQuery.fnName)) templateServerFunctions.push(awaitQuery.fnName);
    if (!dataVars.includes(awaitQuery.asName)) dataVars.push(awaitQuery.asName);
    const exists = awaitTemplateQueries.some((query) => query.awaitExpr === awaitQuery.awaitExpr);
    if (!exists) {
      awaitTemplateQueries.push({
        fnName: awaitQuery.fnName,
        argsExpr: awaitQuery.argsExpr,
        asName: awaitQuery.asName,
        key: awaitQuery.asName,
        awaitExpr: awaitQuery.awaitExpr,
      });
    }
  }

  for (const clientBinding of routeClientImportBindings) {
    const idx = actionFunctions.indexOf(clientBinding);
    if (idx !== -1) actionFunctions.splice(idx, 1);
  }

  const templateTemplateScriptSource = template;
  const templateClientDeclaredNames = collectTemplateClientDeclaredNames(templateTemplateScriptSource);
  const serverTemplateRefs = collectServerTemplateReferencesFromTemplateAst(sfc.template);
  if (templateClientDeclaredNames.length > 0) {
    const leakedNames = templateClientDeclaredNames.filter((name) => serverTemplateRefs.has(name));
    if (leakedNames.length > 0) {
      throw new Error(
        `[koze compiler] ${options.filePath || kind}\n` +
        `Client template <script> bindings cannot be used in server-rendered template output: ${leakedNames.join(', ')}.\n` +
        `Move shared/pure helpers into the top route <script> or a $lib module.`,
      );
    }
  }

  // === RFC 0002: Parse client-first script model ===
  // RFC 0002 only applies to CLIENT scripts (those with reactive $: labels).
  // In the current model:
  // - Script without $: = server-side code, $server/ imports are regular imports
  // - Script with $: = client-side code, $server/ imports become RPC calls
  //
  // We only populate RFC 0002 fields for client scripts that have $server/ imports.
  
  let clientScriptRaw: string | null = null;
  const serverRpcImports: string[] = [];
  const serverRpcFunctions: string[] = [];
  let ssrAwaitCalls: Array<{ varName: string; fnName: string; argsExpr: string }> = [];
  const clientNpmImports: string[] = [];
  const actionAliases = script ? collectAugmentedActionAliases(script) : [];
  
  // Only process RFC 0002 for client scripts (those with reactive $: labels)
  // clientScript is set earlier in parseFile when the script has reactive labels
  if (clientScript) {
    clientScriptRaw = clientScript;
    
    // Parse imports from the client script
    for (const statement of getTopLevelImportStatements(clientScript)) {
      const line = statement.text.trim();
      const moduleSpecifier = extractImportModuleSpecifier(line);
      
      // Detect $server/ imports - these become RPC in client scripts
      if (isServerRpcImport(moduleSpecifier)) {
        serverRpcImports.push(line);
        const fnNames = extractServerRpcFunctionNames(line);
        for (const fn of fnNames) {
          if (!serverRpcFunctions.includes(fn)) {
            serverRpcFunctions.push(fn);
          }
        }
      }
      // Detect npm package imports - these get bundled
      else if (isNpmPackageImport(moduleSpecifier)) {
        clientNpmImports.push(line);
      }
    }
    
    // Find top-level await calls to $server/ functions
    // These execute at SSR time and their results are available to the template
    if (serverRpcFunctions.length > 0) {
      const rpcFunctionSet = new Set(serverRpcFunctions);
      const scriptBodyWithoutImports = stripTopLevelImports(clientScript);
      ssrAwaitCalls = extractTopLevelAwaitCalls(scriptBodyWithoutImports, rpcFunctionSet);
      
      // Add SSR await result variables to dataVars so they're available in template
      for (const call of ssrAwaitCalls) {
        if (!dataVars.includes(call.varName)) {
          dataVars.push(call.varName);
        }
      }
    }
  }

  const parsed = {
    ir: null as unknown as KuratchiModuleIr,
    script,
    loadFunction,
    template,
    serverImports,
    hasLoad,
    actionFunctions,
    dataVars,
    componentImports,
    pollFunctions: templateServerFunctions,
    dataGetQueries: awaitTemplateQueries,
    clientImports,
    routeClientImports,
    routeClientImportBindings,
    loadReturnVars,
    workerEnvAliases,
    devAliases,
    requestImports,
    // RFC 0002 fields
    clientScriptRaw,
    serverRpcImports,
    serverRpcFunctions,
    actionAliases,
    ssrAwaitCalls,
    clientNpmImports,
  };
  parsed.ir = buildKuratchiModuleIr(parsed, sfc);
  return parsed;
}

// TypeScript transpilation removed — wrangler's esbuild handles it
