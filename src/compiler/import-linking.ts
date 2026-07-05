import ts from 'typescript';

export interface ImportBinding {
  imported: string;
  local: string;
}

export interface ParsedImportStatement {
  bindings: ImportBinding[];
  moduleSpecifier: string | null;
  namespaceImport: string | null;
}

export interface RouteImportEntry {
  line: string;
  importerDir: string;
}

interface RouteQueryReference {
  fnName: string;
}

export function parseImportStatement(source: string): ParsedImportStatement {
  const sourceFile = ts.createSourceFile('kuratchi-import.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = sourceFile.statements.find(ts.isImportDeclaration);
  if (!statement || !ts.isStringLiteral(statement.moduleSpecifier)) {
    return { bindings: [], moduleSpecifier: null, namespaceImport: null };
  }

  const bindings: ImportBinding[] = [];
  let namespaceImport: string | null = null;
  const clause = statement.importClause;
  if (clause) {
    if (clause.name) {
      bindings.push({ imported: 'default', local: clause.name.text });
    }

    if (clause.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          bindings.push({
            imported: element.propertyName?.text || element.name.text,
            local: element.name.text,
          });
        }
      } else if (ts.isNamespaceImport(clause.namedBindings)) {
        namespaceImport = clause.namedBindings.name.text;
      }
    }
  }

  return {
    bindings,
    moduleSpecifier: statement.moduleSpecifier.text,
    namespaceImport,
  };
}

function isTypePosition(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
  }
  return false;
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;

  if (isTypePosition(node)) return false;
  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isNamedImports(parent)) return false;
  if (ts.isExportSpecifier(parent)) return false;
  if (ts.isBindingElement(parent)) {
    if (parent.propertyName === node) return false;
    return parent.name !== node;
  }
  if (ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) {
    return parent.name !== node;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) {
    return parent.name !== node;
  }
  if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) return false;

  return true;
}

function collectBindingNames(name: ts.BindingName, out: Set<string>) {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    collectBindingNames(element.name, out);
  }
}

interface ScopeFrame {
  names: Set<string>;
  functionLike: boolean;
}

function addBindingToScope(scopeStack: ScopeFrame[], name: ts.BindingName, isVarLike = false) {
  if (scopeStack.length === 0) return;

  const targetIndex = isVarLike
    ? [...scopeStack].reverse().findIndex((frame) => frame.functionLike)
    : -1;

  const target = isVarLike && targetIndex !== -1
    ? scopeStack[scopeStack.length - 1 - targetIndex]
    : scopeStack[scopeStack.length - 1];

  collectBindingNames(name, target.names);
}

function isScopeNode(node: ts.Node): boolean {
  return ts.isSourceFile(node)
    || ts.isBlock(node)
    || ts.isModuleBlock(node)
    || ts.isCaseBlock(node)
    || ts.isCatchClause(node)
    || ts.isForStatement(node)
    || ts.isForInStatement(node)
    || ts.isForOfStatement(node)
    || ts.isFunctionLike(node);
}

export function collectReferencedIdentifiers(source: string): Set<string> {
  const refs = new Set<string>();
  const sourceFile = ts.createSourceFile('kuratchi-ref.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const scopeStack: ScopeFrame[] = [];

  const hasBinding = (name: string) => {
    for (let index = scopeStack.length - 1; index >= 0; index -= 1) {
      if (scopeStack[index].names.has(name)) return true;
    }
    return false;
  };

  const visit = (node: ts.Node) => {
    let pushedScope = false;
    if (isScopeNode(node)) {
      const frame: ScopeFrame = {
        names: new Set<string>(),
        functionLike: ts.isSourceFile(node) || ts.isFunctionLike(node),
      };

      if (ts.isFunctionLike(node)) {
        if (node.name && ts.isIdentifier(node.name)) frame.names.add(node.name.text);
        for (const parameter of node.parameters) {
          collectBindingNames(parameter.name, frame.names);
        }
      } else if (ts.isCatchClause(node) && node.variableDeclaration) {
        collectBindingNames(node.variableDeclaration.name, frame.names);
      } else if (ts.isForStatement(node) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          addBindingToScope([...scopeStack, frame], declaration.name, (node.initializer.flags & ts.NodeFlags.BlockScoped) === 0);
        }
      } else if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          addBindingToScope([...scopeStack, frame], declaration.name, (node.initializer.flags & ts.NodeFlags.BlockScoped) === 0);
        }
      }

      scopeStack.push(frame);
      pushedScope = true;
    }

    if (ts.isVariableDeclaration(node)) {
      const declarationList = ts.isVariableDeclarationList(node.parent) ? node.parent : null;
      const isVarLike = declarationList ? (declarationList.flags & ts.NodeFlags.BlockScoped) === 0 : false;
      addBindingToScope(scopeStack, node.name, isVarLike);
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
      addBindingToScope(scopeStack, node.name);
    }

    if (ts.isIdentifier(node) && isReferenceIdentifier(node) && !hasBinding(node.text)) {
      refs.add(node.text);
    }

    ts.forEachChild(node, visit);
    if (pushedScope) scopeStack.pop();
  };

  visit(sourceFile);
  return refs;
}

export function parseNamedImportBindings(line: string): ImportBinding[] {
  return parseImportStatement(line).bindings.filter((binding) => binding.imported !== 'default');
}

export function filterImportsByNeededBindings(imports: string[], neededBindings: Set<string>): string[] {
  const selected: string[] = [];
  for (const line of imports) {
    const parsed = parseImportStatement(line);
    const hasNeededBinding = parsed.bindings.some((binding) => neededBindings.has(binding.local))
      || (parsed.namespaceImport ? neededBindings.has(parsed.namespaceImport) : false);
    if (hasNeededBinding) selected.push(line);
  }
  return selected;
}

const RESERVED_RENDER_VARS = new Set(['params']);

export function linkRouteServerImports(opts: {
  routeServerImportEntries: RouteImportEntry[];
  routeClientImportEntries: RouteImportEntry[];
  actionFunctions: string[];
  pollFunctions: string[];
  dataGetQueries: RouteQueryReference[];
  routeScriptReferenceSource: string;
  resolveCompiledImportPath: (origPath: string, importerDir: string, outFileDir: string) => string;
  outFileDir: string;
  allocateModuleId: () => string;
}): {
  fnToModule: Record<string, string>;
  routeImportDecls: string[];
  importStatements: string[];
} {
  const fnToModule: Record<string, string> = {};
  const routeImportDeclMap = new Map<string, string>();
  const importStatements: string[] = [];
  const neededServerFns = new Set<string>([
    ...opts.actionFunctions,
    ...opts.pollFunctions,
    ...opts.dataGetQueries.map((query) => query.fnName),
  ]);

  const routeServerImports = opts.routeServerImportEntries.length > 0
    ? opts.routeServerImportEntries
    : opts.routeClientImportEntries.filter((entry) => (
      filterImportsByNeededBindings([entry.line], neededServerFns).length > 0
    ));

  for (const entry of routeServerImports) {
    const parsed = parseImportStatement(entry.line);
    if (!parsed.moduleSpecifier) continue;
    const isWorkerEnvModule = parsed.moduleSpecifier === 'cloudflare:workers';
    const isKuratchiEnvModule = parsed.moduleSpecifier === 'koze:environment' || parsed.moduleSpecifier === 'koze/environment';

    const importPath = opts.resolveCompiledImportPath(parsed.moduleSpecifier, entry.importerDir, opts.outFileDir);
    const moduleId = opts.allocateModuleId();
    importStatements.push(`import * as ${moduleId} from '${importPath}';`);

    for (const binding of parsed.bindings) {
      if ((isWorkerEnvModule && binding.imported === 'env') || (isKuratchiEnvModule && binding.imported === 'dev')) {
        continue;
      }
      fnToModule[binding.local] = moduleId;
      if (!routeImportDeclMap.has(binding.local)) {
        const accessExpr = binding.imported === 'default' ? `${moduleId}.default` : `${moduleId}.${binding.imported}`;
        routeImportDeclMap.set(binding.local, `const ${binding.local} = ${accessExpr};`);
      }
    }

    if (parsed.namespaceImport) {
      fnToModule[parsed.namespaceImport] = moduleId;
      if (!routeImportDeclMap.has(parsed.namespaceImport)) {
        routeImportDeclMap.set(parsed.namespaceImport, `const ${parsed.namespaceImport} = ${moduleId};`);
      }
    }
  }

  return {
    fnToModule,
    routeImportDecls: Array.from(routeImportDeclMap.values()),
    importStatements,
  };
}
