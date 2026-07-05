import ts from 'typescript';

import { collectReferencedIdentifiers, filterImportsByNeededBindings } from './import-linking.js';
import { collectServerTemplateReferences, stripTopLevelImports } from './parser.js';
import { REACTIVE_RUNTIME_VERSION } from './root-layout-pipeline.js';

export interface RouteScriptSegment {
  script: string;
  dataVars: string[];
}

interface ScopeFrame {
  names: Set<string>;
}

interface ReactiveTransformOptions {
  forceRuntime?: boolean;
  reactiveNames?: Iterable<string>;
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

function collectTopLevelReactiveLetNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const declared = new Set<string>();
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
      const simpleDeclarations = statement.declarationList.declarations.every((declaration) => ts.isIdentifier(declaration.name));
      if (simpleDeclarations && (statement.declarationList.flags & ts.NodeFlags.Let) !== 0) {
        for (const declaration of statement.declarationList.declarations) {
          names.add((declaration.name as ts.Identifier).text);
        }
      }
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, declared);
      }
      continue;
    }

    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      declared.add(statement.name.text);
      continue;
    }

    if (ts.isLabeledStatement(statement) && statement.label.text === '$') {
      const assigned = new Set<string>();
      collectReactiveAssignmentTargetNames(statement.statement, assigned);
      for (const name of assigned) {
        if (!declared.has(name)) names.add(name);
      }
    }
  }
  return names;
}

function collectTopLevelDeclaredLetNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Let) === 0) continue;
    if (!statement.declarationList.declarations.every((declaration) => ts.isIdentifier(declaration.name))) continue;
    for (const declaration of statement.declarationList.declarations) {
      names.add((declaration.name as ts.Identifier).text);
    }
  }
  return names;
}

function collectTopLevelDeclaredNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) names.add(clause.name.text);
      if (clause.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) names.add(element.name.text);
        } else if (ts.isNamespaceImport(clause.namedBindings)) {
          names.add(clause.namedBindings.name.text);
        }
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
      continue;
    }

    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
    }
  }
  return names;
}

export function collectTopLevelClientScopeBindings(body: string): { exposed: string[]; mutable: Set<string>; reactive: Set<string> } {
  const sourceFile = ts.createSourceFile('koze-client-scope.ts', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exposed = new Set<string>();
  const mutable = new Set<string>();
  const reactive = collectTopLevelReactiveLetNames(sourceFile);

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) exposed.add(clause.name.text);
      if (clause.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) exposed.add(element.name.text);
        } else if (ts.isNamespaceImport(clause.namedBindings)) {
          exposed.add(clause.namedBindings.name.text);
        }
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, exposed);
        if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
          collectBindingNames(declaration.name, mutable);
        }
      }
      continue;
    }

    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      exposed.add(statement.name.text);
    }
  }

  for (const name of reactive) {
    exposed.add(name);
    mutable.add(name);
  }

  return {
    exposed: Array.from(exposed),
    mutable,
    reactive,
  };
}

export function buildClientScopeMount(
  body: string,
  reactiveNames?: Iterable<string>,
  blockRenderersExpr?: string,
  scopeNames?: Iterable<string>,
  rootExpr?: string,
  extraScopeNames?: Iterable<string>,
  ownerId?: string,
): string {
  const { exposed, mutable, reactive } = collectTopLevelClientScopeBindings(body);
  const reactiveSet = collectReactiveClientScriptNames(body, reactiveNames ?? reactive);
  for (const name of reactive) reactiveSet.add(name);
  const extraScopeNameSet = new Set(extraScopeNames ?? []);
  const scopeFilter = scopeNames ? new Set([...scopeNames, ...reactive, ...extraScopeNameSet]) : null;
  const accessorDefinitions = exposed.filter((name) => {
    if (!scopeFilter) return true;
    return scopeFilter.has(name);
  }).map((name) => {
    if ((reactive.has(name) || mutable.has(name)) && reactiveSet.has(name)) {
      return `Object.defineProperty(__kScopeValues, ${JSON.stringify(name)}, { enumerable: true, configurable: true, get(){ return __kState.${name}; }, set(__value){ __kState.${name} = __value; } });`;
    }
    if (mutable.has(name)) {
      return `Object.defineProperty(__kScopeValues, ${JSON.stringify(name)}, { enumerable: true, configurable: true, get(){ return ${name}; }, set(__value){ ${name} = __value; } });`;
    }
    return `Object.defineProperty(__kScopeValues, ${JSON.stringify(name)}, { enumerable: true, configurable: true, get(){ return ${name}; } });`;
  });
  const exposedSet = new Set(exposed);
  const extraAccessorDefinitions = Array.from(extraScopeNameSet)
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && !exposedSet.has(name))
    .map((name) =>
      `Object.defineProperty(__kScopeValues, ${JSON.stringify(name)}, { enumerable: false, configurable: true, get(){ return ${name}; } });`,
    );
  const mountArgs = ['__kScope'];
  if (blockRenderersExpr || rootExpr || ownerId) mountArgs.push(blockRenderersExpr ?? 'undefined');
  if (rootExpr || ownerId) mountArgs.push(rootExpr ?? 'undefined');
  if (ownerId) mountArgs.push(JSON.stringify(ownerId));
  return `const __kScopeValues = {};\n${[...accessorDefinitions, ...extraAccessorDefinitions].join('\n')}\nconst __kScope = __k$.scope(() => __kScopeValues);\n__k$.mount(${mountArgs.join(', ')});`;
}

export function collectReactiveClientScriptNames(source: string, extraNames?: Iterable<string>): Set<string> {
  const requested = new Set(extraNames ?? []);
  const lines = source.split('\n');
  let inReactiveBlock = false;
  let blockDepth = 0;

  for (const line of lines) {
    if (!inReactiveBlock) {
      const match = line.match(/^(\s*)\$:\s*(.*)$/);
      if (!match) continue;
      const expr = (match[2] ?? '').trim();
      if (!expr) continue;
      for (const ref of collectReferencedIdentifiers(expr)) requested.add(ref);
      if (expr.startsWith('{')) {
        inReactiveBlock = true;
        blockDepth = 1 + braceDelta(expr.slice(1));
        if (blockDepth <= 0) inReactiveBlock = false;
      }
      continue;
    }

    for (const ref of collectReferencedIdentifiers(line)) requested.add(ref);
    blockDepth += braceDelta(line);
    if (blockDepth <= 0) {
      inReactiveBlock = false;
      blockDepth = 0;
    }
  }

  return requested;
}

function collectScopeBindings(node: ts.Node): Set<string> {
  const names = new Set<string>();

  const collectVariableStatement = (statement: ts.VariableStatement) => {
    for (const declaration of statement.declarationList.declarations) {
      collectBindingNames(declaration.name, names);
    }
  };

  if (ts.isSourceFile(node)) {
    for (const statement of node.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (!clause) continue;
        if (clause.name) names.add(clause.name.text);
        if (clause.namedBindings) {
          if (ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              names.add(element.name.text);
            }
          } else if (ts.isNamespaceImport(clause.namedBindings)) {
            names.add(clause.namedBindings.name.text);
          }
        }
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        collectVariableStatement(statement);
        continue;
      }
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
        names.add(statement.name.text);
      }
    }
    return names;
  }

  if (ts.isBlock(node) || ts.isModuleBlock(node)) {
    for (const statement of node.statements) {
      if (ts.isVariableStatement(statement)) {
        collectVariableStatement(statement);
        continue;
      }
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
        names.add(statement.name.text);
      }
    }
    return names;
  }

  if (ts.isCatchClause(node)) {
    if (node.variableDeclaration) {
      collectBindingNames(node.variableDeclaration.name, names);
    }
    return names;
  }

  if (ts.isFunctionLike(node)) {
    if (node.name && ts.isIdentifier(node.name)) names.add(node.name.text);
    for (const parameter of node.parameters) {
      collectBindingNames(parameter.name, names);
    }
    return names;
  }

  return names;
}

function isScopeNode(node: ts.Node): boolean {
  return ts.isSourceFile(node)
    || ts.isBlock(node)
    || ts.isModuleBlock(node)
    || ts.isCatchClause(node)
    || ts.isFunctionLike(node);
}

function shouldRewriteEnvIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isNamedImports(parent)) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
  if (ts.isClassDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.name === node) return false;
  return true;
}

function shouldRewriteReactiveIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isNamedImports(parent)) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false;
  if (ts.isClassDeclaration(parent) && parent.name === node) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && parent.name === node) return false;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return false;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  return true;
}

function transformSource(
  source: string,
  visitorFactory: (ctx: {
    isShadowed: (name: string) => boolean;
    factory: ts.NodeFactory;
  }) => ts.Visitor,
): string {
  const sourceFile = ts.createSourceFile('kuratchi-script.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const scopeStack: ScopeFrame[] = [];

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const result = ts.transform(sourceFile, [context => {
    const baseFactory = visitorFactory({
      isShadowed(name: string) {
        for (let i = scopeStack.length - 1; i >= 0; i--) {
          if (scopeStack[i].names.has(name)) return true;
        }
        return false;
      },
      factory: context.factory,
    });

    const visitNode: ts.Visitor = (node) => {
      let pushed = false;
      if (isScopeNode(node)) {
        scopeStack.push({ names: collectScopeBindings(node) });
        pushed = true;
      }

      const transformed = baseFactory(node) as ts.Node;
      const visited = ts.visitEachChild(transformed, visitNode, context);

      if (pushed) scopeStack.pop();
      return visited;
    };

    return file => ts.visitNode(file, visitNode) as ts.SourceFile;
  }]);

  const transformedFile = result.transformed[0] as ts.SourceFile;
  const printed = printer.printFile(transformedFile);
  result.dispose();
  return printed;
}

function rewriteTopLevelReactiveLets(source: string, requestedReactiveNames?: Iterable<string>): { code: string; reactiveNames: Set<string> } {
  const sourceFile = ts.createSourceFile('kuratchi-reactive-state.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const discoveredReactiveNames = collectTopLevelReactiveLetNames(sourceFile);
  const declaredLetNames = collectTopLevelDeclaredLetNames(sourceFile);
  const declaredNames = collectTopLevelDeclaredNames(sourceFile);
  const implicitReactiveNames = Array.from(discoveredReactiveNames).filter((name) => !declaredLetNames.has(name));
  const reactiveNames = requestedReactiveNames
    ? new Set([
        ...Array.from(requestedReactiveNames).filter((name) =>
          /^[A-Za-z_$][\w$]*$/.test(name) && (declaredLetNames.has(name) || !declaredNames.has(name)),
        ),
        ...implicitReactiveNames,
      ])
    : discoveredReactiveNames;
  if (reactiveNames.size === 0) return { code: source, reactiveNames };

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const scopeStack: ScopeFrame[] = [];

  const result = ts.transform(sourceFile, [context => {
    const factory = context.factory;

    const makeStateAccess = (name: string) =>
      factory.createPropertyAccessExpression(factory.createIdentifier('__kState'), factory.createIdentifier(name));

    const isShadowedBeyondRoot = (name: string) => {
      for (let i = scopeStack.length - 1; i >= 1; i--) {
        if (scopeStack[i].names.has(name)) return true;
      }
      return false;
    };

    const visitNode: ts.Visitor = (node) => {
      let pushed = false;
      if (isScopeNode(node)) {
        scopeStack.push({ names: collectScopeBindings(node) });
        pushed = true;
      }

      if (ts.isSourceFile(node)) {
        const updatedStatements: ts.Statement[] = [];
        const declaredReactiveLets = new Set(Array.from(collectTopLevelDeclaredLetNames(node)).filter((name) => reactiveNames.has(name)));
        const derivedReactiveNames = Array.from(reactiveNames).filter((name) => !declaredReactiveLets.has(name));
        const bootstrapStatements: ts.Statement[] = [];
        const bootstrapStatementSet = new Set<ts.Statement>();
        const isRuntimeGuardStatement = (statement: ts.Statement) => {
          const text = statement.getText(sourceFile);
          return text.includes('__k$.__version')
            || text.includes('__kReloadKey')
            || text.includes('koze:reactive-runtime-reload')
            || text.includes('reactive runtime is stale or missing');
        };
        const runtimeBindingIndex = node.statements.findIndex((statement) =>
          ts.isVariableStatement(statement)
          && statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === '__k$')
        );
        if (runtimeBindingIndex !== -1) {
          let index = runtimeBindingIndex;
          while (index < node.statements.length) {
            const statement = node.statements[index];
            const isRuntimeBinding = index === runtimeBindingIndex;
            if (!isRuntimeBinding && !isRuntimeGuardStatement(statement)) break;
            bootstrapStatements.push(statement);
            bootstrapStatementSet.add(statement);
            index++;
          }
        }

        for (const statement of node.statements) {
          if (ts.isImportDeclaration(statement)) updatedStatements.push(statement);
        }
        updatedStatements.push(...bootstrapStatements);

        updatedStatements.push(
          factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(
              [
                factory.createVariableDeclaration(
                  factory.createIdentifier('__kState'),
                  undefined,
                  undefined,
                  factory.createCallExpression(
                    factory.createPropertyAccessExpression(factory.createIdentifier('__k$'), factory.createIdentifier('state')),
                    undefined,
                    [factory.createObjectLiteralExpression([], false)],
                  ),
                ),
              ],
              ts.NodeFlags.Const,
            ),
          ),
        );
        for (const name of derivedReactiveNames) {
          updatedStatements.push(
            factory.createExpressionStatement(
              factory.createBinaryExpression(
                makeStateAccess(name),
                factory.createToken(ts.SyntaxKind.EqualsToken),
                factory.createIdentifier('undefined'),
              ),
            ),
          );
        }

        for (const statement of node.statements) {
          if (ts.isImportDeclaration(statement)) continue;
          if (bootstrapStatementSet.has(statement)) continue;

          if (
            ts.isVariableStatement(statement)
            && (statement.declarationList.flags & ts.NodeFlags.Let) !== 0
            && statement.declarationList.declarations.every((declaration) => ts.isIdentifier(declaration.name))
          ) {
            for (const declaration of statement.declarationList.declarations) {
              const name = (declaration.name as ts.Identifier).text;
              if (!reactiveNames.has(name)) {
                updatedStatements.push(statement);
                continue;
              }
              updatedStatements.push(
                factory.createExpressionStatement(
                  factory.createBinaryExpression(
                    makeStateAccess(name),
                    factory.createToken(ts.SyntaxKind.EqualsToken),
                    declaration.initializer
                      ? ts.visitNode(declaration.initializer, visitNode) as ts.Expression
                      : factory.createIdentifier('undefined'),
                  ),
                ),
              );
            }
            continue;
          }

          updatedStatements.push(ts.visitNode(statement, visitNode) as ts.Statement);
        }

        if (pushed) scopeStack.pop();
        return factory.updateSourceFile(node, updatedStatements);
      }

      if (ts.isShorthandPropertyAssignment(node) && reactiveNames.has(node.name.text) && !isShadowedBeyondRoot(node.name.text)) {
        const rewritten = factory.createPropertyAssignment(node.name.text, makeStateAccess(node.name.text));
        if (pushed) scopeStack.pop();
        return rewritten;
      }

      if (
        ts.isBinaryExpression(node)
        && (node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
        && ts.isIdentifier(node.left)
        && reactiveNames.has(node.left.text)
        && !isShadowedBeyondRoot(node.left.text)
      ) {
        const rewritten = factory.updateBinaryExpression(
          node,
          makeStateAccess(node.left.text),
          node.operatorToken,
          ts.visitNode(node.right, visitNode) as ts.Expression,
        );
        if (pushed) scopeStack.pop();
        return rewritten;
      }

      if (
        ts.isIdentifier(node)
        && reactiveNames.has(node.text)
        && !isShadowedBeyondRoot(node.text)
        && shouldRewriteReactiveIdentifier(node)
      ) {
        const rewritten = makeStateAccess(node.text);
        if (pushed) scopeStack.pop();
        return rewritten;
      }

      const visited = ts.visitEachChild(node, visitNode, context);
      if (pushed) scopeStack.pop();
      return visited;
    };

    return file => ts.visitNode(file, visitNode) as ts.SourceFile;
  }]);

  const transformedFile = result.transformed[0] as ts.SourceFile;
  const code = printer.printFile(transformedFile);
  result.dispose();
  return { code, reactiveNames };
}

export function rewriteImportedFunctionCalls(source: string, fnToModule: Record<string, string>): string {
  const fnEntries = Object.entries(fnToModule).filter(([fnName]) => /^[A-Za-z_$][\w$]*$/.test(fnName));
  if (fnEntries.length === 0) return source;
  const fnSet = new Set(fnEntries.map(([fnName]) => fnName));

  return transformSource(source, ({ isShadowed, factory }) => (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && fnSet.has(node.expression.text)
      && !isShadowed(node.expression.text)
    ) {
      const moduleId = fnToModule[node.expression.text];
      return factory.updateCallExpression(
        node,
        factory.createPropertyAccessExpression(factory.createIdentifier(moduleId), factory.createIdentifier(node.expression.text)),
        node.typeArguments,
        node.arguments,
      );
    }
    return node;
  });
}

export function rewriteWorkerEnvAliases(source: string, aliases: string[]): string {
  const aliasSet = new Set(aliases.filter((alias) => /^[A-Za-z_$][\w$]*$/.test(alias)));
  if (aliasSet.size === 0) return source;

  return transformSource(source, ({ isShadowed, factory }) => (node) => {
    if (
      ts.isIdentifier(node)
      && aliasSet.has(node.text)
      && !isShadowed(node.text)
      && shouldRewriteEnvIdentifier(node)
    ) {
      return factory.createIdentifier('__env');
    }
    return node;
  });
}

export function buildDevAliasDeclarations(aliases: string[], isDev: boolean): string {
  if (!aliases || aliases.length === 0) return '';
  return aliases.map((alias) => `const ${alias} = ${isDev ? 'true' : 'false'};`).join('\n');
}

function collectStatementDeclaredNames(statement: ts.Statement): Set<string> {
  const names = new Set<string>();
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      collectBindingNames(declaration.name, names);
    }
  }
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
    names.add(statement.name.text);
  }
  return names;
}

function collectAssignedIdentifiers(node: ts.Node, out: Set<string>): void {
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
  node.forEachChild((child) => collectAssignedIdentifiers(child, out));
}

export function buildSelectiveSsrPrelude(opts: {
  scriptBody: string;
  template: string;
  serverImports?: string[];
  additionalNeededBindings?: string[];
}): { prelude: string; imports: string[]; neededBindings: string[] } {
  const rawScriptBody = stripTopLevelImports(opts.scriptBody);
  const reactiveSourceFile = ts.createSourceFile(
    'kuratchi-selective-ssr-reactive.ts',
    rawScriptBody,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaredNames = collectTopLevelDeclaredNames(reactiveSourceFile);
  const derivedReactiveNames = Array.from(collectTopLevelReactiveLetNames(reactiveSourceFile)).filter((name) => !declaredNames.has(name));
  const scriptBody = derivedReactiveNames.length > 0
    ? `let ${derivedReactiveNames.join(', ')};\n${rawScriptBody}`
    : rawScriptBody;
  const neededBindings = new Set<string>(collectServerTemplateReferences(opts.template));
  for (const name of opts.additionalNeededBindings ?? []) {
    if (name) neededBindings.add(name);
  }
  if (neededBindings.size === 0) {
    return { prelude: '', imports: [], neededBindings: [] };
  }
  if (!scriptBody.trim()) {
    return {
      prelude: '',
      imports: filterImportsByNeededBindings(opts.serverImports ?? [], neededBindings),
      neededBindings: Array.from(neededBindings),
    };
  }

  const sourceFile = ts.createSourceFile(
    'kuratchi-selective-ssr.ts',
    scriptBody,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
  const topLevelBindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    for (const name of collectStatementDeclaredNames(statement)) topLevelBindings.add(name);
  }

  const records = sourceFile.statements.map((statement) => {
    const declared = collectStatementDeclaredNames(statement);
    const assigned = new Set<string>();
    if (!ts.isVariableStatement(statement)) collectAssignedIdentifiers(statement, assigned);
    const provided = new Set<string>(declared);
    for (const name of assigned) {
      if (topLevelBindings.has(name)) provided.add(name);
    }
    const source = printer.printNode(ts.EmitHint.Unspecified, statement, sourceFile).trim();
    return {
      provided,
      referenced: source ? collectReferencedIdentifiers(source) : new Set<string>(),
      source,
      included: false,
    };
  });

  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (record.included || record.provided.size === 0) continue;
      const shouldInclude = Array.from(record.provided).some((name) => neededBindings.has(name));
      if (!shouldInclude) continue;
      record.included = true;
      for (const ref of record.referenced) {
        if (!neededBindings.has(ref)) {
          neededBindings.add(ref);
          changed = true;
        }
      }
    }
  }

  const preludeWithTypes = records
    .filter((record) => record.included && record.source.length > 0)
    .map((record) => record.source)
    .join('\n');
  // Strip TypeScript type annotations from the prelude. Two
  // consumers downstream:
  //   - Legacy CLI: emits to .koze/routes.ts which wrangler's
  //     esbuild transpiles. Stripping here is redundant but safe
  //     (esbuild is idempotent over JS).
  //   - Vite plugin: emits the prelude inside a virtual module that
  //     Rollup ingests. Rollup does NOT transpile TS, so type
  //     annotations like `let x: string | null = null` cause a
  //     parse error. Transpiling here makes the output Rollup-clean.
  const prelude = preludeWithTypes
    ? ts.transpileModule(preludeWithTypes, {
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          isolatedModules: false,
        },
        fileName: 'kuratchi-selective-ssr.ts',
        reportDiagnostics: false,
      }).outputText
    : '';
  const imports = filterImportsByNeededBindings(opts.serverImports ?? [], neededBindings);
  return {
    prelude,
    imports,
    neededBindings: Array.from(neededBindings),
  };
}

function braceDelta(line: string): number {
  let delta = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === '`') {
        inTemplate = false;
        continue;
      }
      if (ch === '$' && line[i + 1] === '{') {
        delta++;
        i++;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      continue;
    }
    if (ch === '{') delta++;
    else if (ch === '}') delta--;
  }

  return delta;
}

export function transformReactiveClientScript(source: string, options: ReactiveTransformOptions = {}): string {
  const needsReactiveRuntime = /\$\s*:/.test(source) || !!options.forceRuntime;
  if (!needsReactiveRuntime) return source;

  const out: string[] = [];
  const lines = source.split('\n');
  const originalSourceFile = ts.createSourceFile('kuratchi-original-reactive-state.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const topLevelLetNames = collectTopLevelDeclaredLetNames(originalSourceFile);
  const reactiveStateNames = new Set([
    ...collectTopLevelReactiveLetNames(originalSourceFile),
    ...Array.from(options.reactiveNames ?? []).filter((name) => topLevelLetNames.has(name)),
  ]);
  let inReactiveBlock = false;
  let blockIndent = '';
  let blockDepth = 0;

  for (const line of lines) {
    const current = line;
    if (!inReactiveBlock) {
      const match = current.match(/^(\s*)\$:\s*(.*)$/);
      if (!match) {
        out.push(current);
        continue;
      }
      const indent = match[1] ?? '';
      const expr = (match[2] ?? '').trim();
      if (!expr) continue;
      if (expr.startsWith('{')) {
        const tail = expr.slice(1);
        out.push(`${indent}__k$.effect(() => {`);
        inReactiveBlock = true;
        blockIndent = indent;
        blockDepth = 1 + braceDelta(tail);
        if (tail.trim()) out.push(`${indent}${tail}`);
        if (blockDepth <= 0) {
          out.push(`${indent}});`);
          inReactiveBlock = false;
          blockIndent = '';
          blockDepth = 0;
        }
        continue;
      }

      const normalized = expr.endsWith(';') ? expr : `${expr};`;
      out.push(`${indent}__k$.effect(() => { ${normalized} });`);
      continue;
    }

    const nextDepth = blockDepth + braceDelta(current);
    if (nextDepth <= 0 && current.trim() === '}') {
      out.push(`${blockIndent}});`);
      inReactiveBlock = false;
      blockIndent = '';
      blockDepth = 0;
      continue;
    }
    out.push(current);
    blockDepth = nextDepth;
  }

  if (inReactiveBlock) out.push(`${blockIndent}});`);

  let insertAt = 0;
  while (insertAt < out.length) {
    const trimmed = out[insertAt].trim();
    if (!trimmed || trimmed.startsWith('//') || /^\/\*/.test(trimmed) || /^import\s/.test(trimmed)) {
      insertAt++;
      continue;
    }
    break;
  }
  out.splice(
    insertAt,
    0,
    `const __k$ = window.__kozeReactive;
if (!__k$ || __k$.__version < ${REACTIVE_RUNTIME_VERSION}) {
  const __kReloadKey = 'koze:reactive-runtime-reload';
  let __kReloaded = false;
  try { __kReloaded = sessionStorage.getItem(__kReloadKey) === '1'; } catch {}
  if (!__kReloaded && typeof location !== 'undefined' && typeof location.reload === 'function') {
    try { sessionStorage.setItem(__kReloadKey, '1'); } catch {}
    location.reload();
  }
  throw new Error('[koze] reactive runtime is stale or missing');
}
try { sessionStorage.removeItem('koze:reactive-runtime-reload'); } catch {}`,
  );
  const rewrittenScript = out.join('\n');
  return rewriteTopLevelReactiveLets(rewrittenScript, reactiveStateNames).code;
}

export function buildSegmentedScriptBody(opts: {
  segments: RouteScriptSegment[];
  fnToModule: Record<string, string>;
  importDecls?: string;
  workerEnvAliases: string[];
  devAliases: string[];
  isDev: boolean;
  asyncMode: boolean;
}): string {
  const { segments, fnToModule, importDecls, workerEnvAliases, devAliases, isDev, asyncMode } = opts;
  const lines: string[] = [];
  const routeDevDecls = buildDevAliasDeclarations(devAliases, isDev);
  if (routeDevDecls) lines.push(routeDevDecls);
  if (importDecls) lines.push(importDecls);
  lines.push('const __segmentData: Record<string, any> = {};');

  const availableVars: string[] = [];
  let segmentIndex = 0;
  for (const segment of segments) {
    if (!segment.script) continue;
    let segmentBody = stripTopLevelImports(segment.script);
    segmentBody = rewriteImportedFunctionCalls(segmentBody, fnToModule);
    segmentBody = rewriteWorkerEnvAliases(segmentBody, workerEnvAliases);
    if (!segmentBody.trim()) continue;

    const returnVars = segment.dataVars.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
    const segmentVar = '__segment_' + segmentIndex++;
    const invokePrefix = asyncMode ? 'await ' : '';
    const factoryPrefix = asyncMode ? 'async ' : '';

    lines.push('const ' + segmentVar + ' = ' + invokePrefix + '(' + factoryPrefix + '(__ctx: Record<string, any>) => {');
    lines.push(segmentBody);
    lines.push(returnVars.length > 0 ? 'return { ' + returnVars.join(', ') + ' };' : 'return {};');
    lines.push('})(__segmentData);');
    lines.push('Object.assign(__segmentData, ' + segmentVar + ');');

    for (const name of returnVars) {
      if (!availableVars.includes(name)) availableVars.push(name);
    }
  }

  if (!asyncMode && availableVars.length > 0) {
    lines.push('const { ' + availableVars.join(', ') + ' } = __segmentData;');
  }

  return lines.join('\n');
}
