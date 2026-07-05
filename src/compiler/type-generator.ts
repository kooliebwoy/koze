import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

import { buildVirtualModuleTypeDeclarations } from './virtual-modules.js';
import {
  assertCanonicalConventionFileSuffixes,
  discoverFilesWithSuffix,
} from './convention-discovery.js';
import { discoverContentGroupNames } from './content-discovery.js';

/**
 * Generate TypeScript types from kuratchi schema and runtime definitions.
 * Outputs to src/app.d.ts or a specified path.
 */

interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  hasDefault: boolean;
}

interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
}

const SERVER_RPC_EXTENSIONS = ['.ts', '.js', '.mjs'] as const;
const SERVER_CONVENTION_FILE_RE = /\.(agent|workflow|queue|pipeline|container|sandbox|do)\.(ts|js|mjs)$/;

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function stripKnownExtension(value: string): string {
  for (const ext of SERVER_RPC_EXTENSIONS) {
    if (value.endsWith(ext)) return value.slice(0, -ext.length);
  }
  return value;
}

function isValidIdentifier(value: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(value);
}

function discoverServerRpcFiles(serverDir: string): string[] {
  if (!fs.existsSync(serverDir)) return [];
  const out: string[] = [];
  const extSet = new Set<string>(SERVER_RPC_EXTENSIONS);
  const walk = (absDir: string) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SERVER_CONVENTION_FILE_RE.test(entry.name)) continue;
      if (extSet.has(path.extname(entry.name) as typeof SERVER_RPC_EXTENSIONS[number])) out.push(abs);
    }
  };
  walk(serverDir);
  return out.sort();
}

function collectExportedValueNames(sourceFile: string): string[] {
  if (!fs.existsSync(sourceFile)) return [];
  const source = fs.readFileSync(sourceFile, 'utf-8');
  const sf = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();

  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly || !stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;
      for (const spec of stmt.exportClause.elements) {
        if (spec.isTypeOnly) continue;
        const name = spec.name.text;
        if (isValidIdentifier(name)) names.add(name);
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
      names.add('default');
      continue;
    }

    if (ts.isFunctionDeclaration(stmt) && stmt.name) names.add(stmt.name.text);
    else if (ts.isClassDeclaration(stmt) && stmt.name) names.add(stmt.name.text);
    else if (ts.isEnumDeclaration(stmt)) names.add(stmt.name.text);
    else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
      }
    }
  }

  return Array.from(names);
}

function getServerRpcModuleSubpaths(serverDir: string, sourceFile: string): string[] {
  const rel = toPosixPath(path.relative(serverDir, sourceFile));
  const withoutExt = stripKnownExtension(rel);
  const subpaths = [withoutExt];
  if (withoutExt.endsWith('/index')) {
    const directorySubpath = withoutExt.slice(0, -'/index'.length);
    if (directorySubpath) subpaths.unshift(directorySubpath);
  }
  return Array.from(new Set(subpaths)).filter(Boolean);
}

function getRelativeTypeImportSpecifier(outputDir: string, sourceFile: string): string {
  const withoutExt = stripKnownExtension(sourceFile);
  let spec = toPosixPath(path.relative(outputDir, withoutExt));
  if (!spec.startsWith('.')) spec = `./${spec}`;
  return spec;
}

function generateServerRpcTypeDeclarations(projectDir: string, serverDir: string, outputPath: string): string {
  const absServerDir = path.join(projectDir, serverDir);
  const outputDir = path.dirname(path.join(projectDir, outputPath));
  const declarations: string[] = [];

  for (const file of discoverServerRpcFiles(absServerDir)) {
    const names = collectExportedValueNames(file);
    if (names.length === 0) continue;

    const moduleImport = getRelativeTypeImportSpecifier(outputDir, file);
    const exportLines = names.map((name) => {
      if (name === 'default') {
        return [
          `  const __kozeDefault: __KozeRpcExport<__KozeServerModule['default']>;`,
          `  export default __kozeDefault;`,
        ].join('\n');
      }
      return `  export const ${name}: __KozeRpcExport<__KozeServerModule['${name}']>;`;
    });

    for (const subpath of getServerRpcModuleSubpaths(absServerDir, file)) {
      declarations.push(
        [
          `declare module '$server/${subpath}' {`,
          `  type __KozeRpcAsyncValue<T> = import('@kuratchi/koze/runtime/channel.js').ThenableAsyncValue<Awaited<T>>;`,
          `  type __KozeServerModule = typeof import('${moduleImport}');`,
          `  type __KozeRpcExport<T> = T extends (...args: infer Args) => infer Result`,
          `    ? (...args: Args) => __KozeRpcAsyncValue<Result>`,
          `    : () => __KozeRpcAsyncValue<T>;`,
          ...exportLines,
          `}`,
        ].join('\n'),
      );
    }
  }

  return declarations.join('\n\n');
}

function sqliteTypeToTs(sqlType: string): string {
  const lower = sqlType.toLowerCase();
  if (lower.includes('integer') || lower.includes('int') || lower.includes('real') || lower.includes('numeric')) {
    return 'number';
  }
  if (lower.includes('text') || lower.includes('varchar') || lower.includes('char')) {
    return 'string';
  }
  if (lower.includes('blob')) {
    return 'Uint8Array';
  }
  if (lower.includes('json')) {
    return 'Record<string, unknown>';
  }
  if (lower.includes('boolean') || lower.includes('bool')) {
    return 'boolean';
  }
  return 'unknown';
}

function parseSchemaColumn(name: string, definition: string): SchemaColumn {
  const lower = definition.toLowerCase();
  const nullable = !lower.includes('not null');
  const hasDefault = lower.includes('default');
  const type = sqliteTypeToTs(definition);
  
  return { name, type, nullable, hasDefault };
}

function parseSchemaFromSource(source: string): SchemaTable[] {
  const tables: SchemaTable[] = [];
  
  // Match tables: { tableName: { col: 'def', ... }, ... }
  const tablesMatch = source.match(/tables\s*:\s*\{([\s\S]*?)\n\t?\}/);
  if (!tablesMatch) return tables;
  
  const tablesBlock = tablesMatch[1];
  
  // Match each table definition
  const tableRegex = /(\w+)\s*:\s*\{([^}]+)\}/g;
  let match;
  
  while ((match = tableRegex.exec(tablesBlock)) !== null) {
    const tableName = match[1];
    const columnsBlock = match[2];
    const columns: SchemaColumn[] = [];
    
    // Match each column: name: 'definition'
    const colRegex = /(\w+)\s*:\s*['"]([^'"]+)['"]/g;
    let colMatch;
    
    while ((colMatch = colRegex.exec(columnsBlock)) !== null) {
      columns.push(parseSchemaColumn(colMatch[1], colMatch[2]));
    }
    
    tables.push({ name: tableName, columns });
  }
  
  return tables;
}

function generateTableTypes(tables: SchemaTable[]): string {
  const lines: string[] = [];
  
  for (const table of tables) {
    const pascalName = table.name
      .split('_')
      .map(s => s.charAt(0).toUpperCase() + s.slice(1))
      .join('');
    
    lines.push(`    /** Row type for ${table.name} table */`);
    lines.push(`    interface ${pascalName}Row {`);
    
    for (const col of table.columns) {
      const optional = col.nullable || col.hasDefault ? '?' : '';
      lines.push(`      ${col.name}${optional}: ${col.type};`);
    }
    
    lines.push(`    }`);
    lines.push('');
  }
  
  return lines.join('\n');
}

export interface GenerateTypesOptions {
  projectDir: string;
  schemaPath?: string;
  outputPath?: string;
  serverDir?: string;
  localsInterface?: string;
}

export function generateAppTypes(options: GenerateTypesOptions): string {
  const {
    projectDir,
    schemaPath = 'src/server/schema.ts',
    outputPath = 'src/app.d.ts',
    serverDir = 'src/server',
    localsInterface,
  } = options;
  
  const schemaFullPath = path.join(projectDir, schemaPath);
  let tables: SchemaTable[] = [];
  
  if (fs.existsSync(schemaFullPath)) {
    const schemaSource = fs.readFileSync(schemaFullPath, 'utf-8');
    tables = parseSchemaFromSource(schemaSource);
  }

  assertCanonicalConventionFileSuffixes(projectDir);

  // Discover workflow names for koze:workflow type union
  const workflowDir = path.join(projectDir, 'src', 'server');
  const workflowFiles = discoverFilesWithSuffix(workflowDir, '.workflow.ts');
  const workflowNames = workflowFiles
    .map((f) => path.basename(f, '.workflow.ts'))
    .filter((n) => /^[A-Za-z_$][\w$-]*$/.test(n));
  const pipelineFiles = discoverFilesWithSuffix(workflowDir, '.pipeline.ts');
  const pipelineNames = pipelineFiles
    .map((f) => path.basename(f, '.pipeline.ts'))
    .filter((n) => /^[A-Za-z_$][\w$-]*$/.test(n));
  const contentNames = discoverContentGroupNames(projectDir);
  
  const tableTypes = tables.length > 0 ? generateTableTypes(tables) : '';
  
  // Check if user has existing Locals definition to preserve
  const outputFullPath = path.join(projectDir, outputPath);
  let existingLocals: string | null = null;
  
  if (fs.existsSync(outputFullPath)) {
    const existing = fs.readFileSync(outputFullPath, 'utf-8');
    // Extract user-defined Locals interface (between USER LOCALS START/END markers)
    const localsMatch = existing.match(/\/\/ USER LOCALS START\n([\s\S]*?)\/\/ USER LOCALS END/);
    if (localsMatch) {
      existingLocals = localsMatch[1].trimEnd();
    }
  }
  
  const localsBlock = existingLocals || localsInterface || `    interface Locals {
      userId: number;
      userEmail: string;
    }`;
  const serverRpcTypes = generateServerRpcTypeDeclarations(projectDir, serverDir, outputPath);
  
  const output = `/**
 * Type declarations for Koze app.
 *
 * Auto-regenerated by \`koze/vite\` on every build.
 * Edit the \`Locals\` interface below — the locals you write to
 * \`ctx.locals\` from \`src/middleware.ts\` belong here.
 */

${buildVirtualModuleTypeDeclarations(workflowNames, pipelineNames, contentNames)}
${serverRpcTypes ? `\n\n${serverRpcTypes}` : ''}

declare namespace App {
  /** Request-scoped locals set by middleware */
// USER LOCALS START
${localsBlock}
// USER LOCALS END

${tableTypes ? `  // Database table row types (auto-generated from schema.ts)\n${tableTypes}` : ''}}
`;
  
  return output;
}

export function writeAppTypes(options: GenerateTypesOptions): void {
  const output = generateAppTypes(options);
  const outputPath = path.join(options.projectDir, options.outputPath || 'src/app.d.ts');
  
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(outputPath)) {
    const existing = fs.readFileSync(outputPath, 'utf-8');
    if (existing === output) return;
  }

  fs.writeFileSync(outputPath, output, 'utf-8');
  console.log(`[koze] Generated types -> ${path.relative(options.projectDir, outputPath)}`);
}
