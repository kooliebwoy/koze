import ts from 'typescript';
import { createLinePreservingSourceMap } from './source-map.js';
import { resolveKozeVirtualModule } from './virtual-modules.js';

const requestModule = 'koze:request';
const runtimeModule = resolveKozeVirtualModule(requestModule);
const packageModules = new Set(['@kuratchi/koze', '@kuratchi/koze/runtime', runtimeModule]);
const contextualNames = new Set([
  'request', 'url', 'pathname', 'searchParams', 'headers', 'method', 'params', 'slug',
]);

export function transformServerRequestImports(source: string, id: string) {
  if (!source.includes(requestModule) && !source.includes('@kuratchi/koze')) return null;

  const fileName = /\.[jt]sx(?:\?|$)/.test(id) ? 'module.tsx' : 'module.ts';
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const candidates: { identifier: ts.Identifier; name: string }[] = [];
  let insertionPoint: number | undefined;
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    if (module !== requestModule && !packageModules.has(module)) continue;
    const clause = statement.importClause;
    const named = clause?.namedBindings;
    if (!named || clause?.isTypeOnly) continue;
    if (ts.isNamespaceImport(named)) {
      if (module === requestModule) {
        throw new Error('[koze] Use named imports from koze:request in server modules.');
      }
      continue;
    }
    for (const specifier of named.elements) {
      const name = (specifier.propertyName ?? specifier.name).text;
      if (specifier.isTypeOnly || !contextualNames.has(name)) continue;
      insertionPoint ??= statement.getStart(file);
      candidates.push({ identifier: specifier.name, name });
    }
  }
  if (insertionPoint === undefined) return null;

  // A single-file checker resolves lexical aliases and shadowing without
  // reading dependencies or the application's TypeScript configuration.
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === fileName ? file : undefined;
  const checker = ts.createProgram([fileName], options, host).getTypeChecker();
  const bindings = new Map<ts.Symbol, string>();
  for (const { identifier, name } of candidates) {
    const symbol = checker.getSymbolAtLocation(identifier);
    if (symbol) bindings.set(symbol, name);
  }
  if (!bindings.size) return null;

  let accessor = '__kozeRequestValues';
  while (source.includes(accessor)) accessor += '_';
  const edits: { start: number; end: number; text: string }[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isTypeQueryNode(node)) return;
    if (ts.isExportSpecifier(node)) {
      const symbol = checker.getExportSpecifierLocalTargetSymbol(node);
      if (!node.isTypeOnly && !node.parent.parent.isTypeOnly && symbol && bindings.has(symbol)) {
        throw new Error('[koze] Read request values inside a function instead of re-exporting them.');
      }
      return;
    }
    if (ts.isIdentifier(node) && !ts.isPartOfTypeNode(node)) {
      const shorthand = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node;
      const symbol = shorthand
        ? checker.getShorthandAssignmentValueSymbol(node.parent as ts.ShorthandPropertyAssignment)
        : checker.getSymbolAtLocation(node);
      const name = symbol && bindings.get(symbol);
      if (name) {
        const value = `${accessor}.${name}`;
        edits.push({
          start: node.getStart(file), end: node.end,
          text: shorthand ? `${node.text}: ${value}` : value,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!edits.length) return null;

  // Keep original imports for type queries. Vite drops unused value imports.
  // Insert beside an existing import to preserve source line numbers.
  let code = source;
  for (const edit of edits.reverse()) {
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  }
  const declaration = `import { __requestValues as ${accessor} } from ${JSON.stringify(requestModule)}; `;
  code = code.slice(0, insertionPoint) + declaration + code.slice(insertionPoint);
  return { code, map: createLinePreservingSourceMap(source, id) };
}
