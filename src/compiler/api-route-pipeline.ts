import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const ALL_API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type ApiMethod = typeof ALL_API_METHODS[number];
const API_METHOD_SET = new Set<string>(ALL_API_METHODS);

function hasExportModifier(node: ts.Node): boolean {
  const flags = ts.getCombinedModifierFlags(node as ts.Declaration);
  return (flags & ts.ModifierFlags.Export) !== 0 && (flags & ts.ModifierFlags.Default) === 0;
}

export function collectExportedApiMethods(source: string, fileName: string): ApiMethod[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods = new Set<ApiMethod>();
  const add = (name: string) => {
    if (API_METHOD_SET.has(name)) methods.add(name as ApiMethod);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      add(statement.name.text);
      continue;
    }

    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) add(declaration.name.text);
      }
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        add(element.name.text);
      }
    }
  }

  return ALL_API_METHODS.filter((method) => methods.has(method));
}

export function compileApiRoute(opts: {
  pattern: string;
  fullPath: string;
  projectDir: string;
  transformModule: (entryAbsPath: string) => string;
  allocateModuleId: () => string;
  pushImport: (statement: string) => void;
}): string {
  const outFileDir = path.join(opts.projectDir, '.koze');
  const absRoutePath = opts.transformModule(opts.fullPath);
  let importPath = path.relative(outFileDir, absRoutePath).replace(/\\/g, '/');
  if (!importPath.startsWith('.')) importPath = './' + importPath;

  const moduleId = opts.allocateModuleId();
  opts.pushImport(`import * as ${moduleId} from '${importPath}';`);

  const apiSource = fs.readFileSync(opts.fullPath, 'utf-8');
  const exportedMethods = collectExportedApiMethods(apiSource, opts.fullPath);

  const methodEntries = exportedMethods
    .map((method) => `${method}: ${moduleId}.${method}`)
    .join(', ');

  const routeFile = path.relative(opts.projectDir, opts.fullPath).replace(/\\/g, '/');
  const manifestExpression = `((manifest) => ({
    kind: 'api',
    pattern: ${JSON.stringify(opts.pattern)},
    file: ${JSON.stringify(routeFile)},
    methods: ${JSON.stringify([...exportedMethods])},
    ...((manifest && typeof manifest === 'object') ? manifest : {})
  }))(${moduleId}.manifest)`;

  return `{ pattern: ${JSON.stringify(opts.pattern)}, __api: true, manifest: ${manifestExpression}${methodEntries ? `, ${methodEntries}` : ''} }`;
}
