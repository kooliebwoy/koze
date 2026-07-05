import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

import {
  type DoClassContributorEntry,
  type DoClassMethodEntry,
  type DoHandlerEntry,
  type ExportedClassEntry,
  type RelativeImportClassEntry,
  toSafeIdentifier,
} from './compiler-shared.js';
import {
  assertCanonicalConventionFileSuffixes,
  discoverFilesWithExtensions,
  discoverFilesWithSuffix,
} from './convention-discovery.js';

export function discoverDurableObjects(
  srcDir: string,
): { config: { binding: string; className: string; files?: string[] }[]; handlers: DoHandlerEntry[] } {
  assertCanonicalConventionFileSuffixes(path.dirname(srcDir));
  const serverDir = path.join(srcDir, 'server');
  const legacyDir = path.join(srcDir, 'durable-objects');
  const serverDoFiles = discoverFilesWithSuffix(serverDir, '.do.ts');
  const legacyDoFiles = discoverFilesWithSuffix(legacyDir, '.ts');
  const discoveredFiles = Array.from(new Set([...serverDoFiles, ...legacyDoFiles]));

  if (discoveredFiles.length === 0) {
    return { config: [], handlers: [] };
  }

  const handlers: DoHandlerEntry[] = [];
  const handlerIdToAbsPath = new Map<string, string>();

  for (const absPath of discoveredFiles) {
    const file = path.basename(absPath);
    const source = fs.readFileSync(absPath, 'utf-8');

    const exportedFunctions = extractExportedFunctions(source);
    const defaultMatch = source.match(/export\s+default\s+class\s+(\w+)\s+extends\s+([A-Za-z_$][\w$]*)/);
    const namedMatch = source.match(/export\s+class\s+(\w+)\s+extends\s+([A-Za-z_$][\w$]*)/);
    let className: string | null = null;
    let exportKind: 'named' | 'default' | undefined;
    if (defaultMatch && isDurableObjectSubclass(absPath, source, defaultMatch[1])) {
      className = defaultMatch[1] ?? null;
      exportKind = 'default';
    } else if (namedMatch && isDurableObjectSubclass(absPath, source, namedMatch[1])) {
      className = namedMatch[1] ?? null;
      exportKind = 'named';
    }
    const hasClass = !!className;
    if (!hasClass && exportedFunctions.length === 0) continue;

    // Binding resolution:
    // 1) explicit static binding declared in the class
    // 2) derive from the handler file name
    let binding: string | null = null;
    const bindingMatch = source.match(/static\s+binding\s*=\s*['"](\w+)['"]/);
    if (bindingMatch) {
      binding = bindingMatch[1];
    } else {
      binding = deriveBindingFromFile(file);
    }
    if (!binding) continue;

    const classMethods = className ? extractClassMethods(absPath, source, className) : [];

    const fileName = path
      .relative(absPath.startsWith(serverDir) ? serverDir : legacyDir, absPath)
      .replace(/\\/g, '/')
      .replace(/\.ts$/, '');
    const existing = handlerIdToAbsPath.get(fileName);
    if (existing && existing !== absPath) {
      throw new Error(
        `[Koze] Duplicate DO handler id '${fileName}.ts' detected:\n- ${existing}\n- ${absPath}\nRename one file or move it to avoid proxy name collision.`,
      );
    }
    handlerIdToAbsPath.set(fileName, absPath);

    handlers.push({
      fileName,
      absPath,
      binding,
      mode: hasClass ? 'class' : 'function',
      className: className ?? undefined,
      exportKind,
      classMethods,
      classContributors: [],
      exportedFunctions,
    });
  }

  // Discover contributor classes and merge their methods into each base handler.
  for (const handler of handlers) {
    if (handler.mode !== 'class' || !handler.className) continue;
    const contributors = discoverDoClassContributors(handler);
    handler.classContributors = contributors;
    if (contributors.length > 0) {
      handler.classMethods = mergeDoClassMethods(handler.classMethods, contributors);
    }
  }

  // Build config entries from discovered handlers (de-duped by binding).
  // The handler source is authoritative; wrangler.jsonc is then synced from this.
  const discoveredConfigByBinding = new Map<string, { binding: string; className: string; files?: string[] }>();
  for (const handler of handlers) {
    const existing = discoveredConfigByBinding.get(handler.binding);
    if (!existing) {
      discoveredConfigByBinding.set(handler.binding, {
        binding: handler.binding,
        className: handler.className ?? deriveClassNameFromFile(path.basename(handler.absPath)),
        files: [path.basename(handler.absPath)],
      });
    } else {
      existing.files?.push(path.basename(handler.absPath));
    }
  }

  return { config: [...discoveredConfigByBinding.values()], handlers };
}

function deriveBindingFromFile(fileName: string): string {
  const normalized = fileName
    .replace(/\.(ts|tsx|js|mjs|cjs)$/i, '')
    .replace(/\.do$/i, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (!normalized) return 'DURABLE_OBJECT';
  return normalized.endsWith('_DO') ? normalized : `${normalized}_DO`;
}

function deriveClassNameFromFile(fileName: string): string {
  const normalized = fileName
    .replace(/\.(ts|tsx|js|mjs|cjs)$/i, '')
    .replace(/\.do$/i, '');
  const base = normalized
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');
  if (!base) return 'DurableObjectHandler';
  return base.endsWith('DO') ? base : `${base}DO`;
}

// ---------------------------------------------------------------------------
// TypeScript AST helpers
// ---------------------------------------------------------------------------

function extractExportedFunctions(source: string): string[] {
  const out: string[] = [];
  const fnRegex = /export\s+(?:async\s+)?function\s+(\w+)/g;
  let m;
  while ((m = fnRegex.exec(source)) !== null) out.push(m[1]);
  return out;
}

function extractExportedClasses(source: string): ExportedClassEntry[] {
  const sourceFile = ts.createSourceFile('classes.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: ExportedClassEntry[] = [];

  const hasModifier = (
    node: { modifiers?: ts.NodeArray<ts.ModifierLike> },
    kind: ts.SyntaxKind,
  ): boolean => (node.modifiers ?? ts.factory.createNodeArray()).some((m) => m.kind === kind);

  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name?.text && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      out.push({
        className: node.name.text,
        exportKind: hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? 'default' : 'named',
      });
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return out;
}

function extractOwnClassMethods(source: string, className: string): { methods: DoClassMethodEntry[]; extendsName: string | null } | null {
  const sourceFile = ts.createSourceFile(`${className}.ts`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let classDecl: ts.ClassDeclaration | null = null;

  const visit = (node: ts.Node) => {
    if (classDecl) return;
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      classDecl = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  if (!classDecl) return null;
  const targetClass = classDecl as ts.ClassDeclaration;

  let extendsName: string | null = null;
  for (const clause of targetClass.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    const heritage = clause.types[0];
    if (!heritage) continue;
    const expr = heritage.expression;
    if (ts.isIdentifier(expr)) {
      extendsName = expr.text;
    } else if (ts.isPropertyAccessExpression(expr)) {
      extendsName = expr.name.text;
    } else {
      extendsName = expr.getText(sourceFile).trim() || null;
    }
    break;
  }

  const methods: DoClassMethodEntry[] = [];
  for (const member of targetClass.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    if (!member.body) continue;
    if (!member.name || !ts.isIdentifier(member.name)) continue;

    const name = member.name.text;
    const modifiers = member.modifiers ?? ts.factory.createNodeArray();
    const visibility = modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)
      ? 'private'
      : modifiers.some((m) => m.kind === ts.SyntaxKind.ProtectedKeyword)
        ? 'protected'
        : 'public';
    const isStatic = modifiers.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
    const isAsync = modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    if (isStatic) continue;

    const bodySource = member.body.getText(sourceFile);
    const hasWorkerContextCalls = /\b(getCurrentUser|redirect|getLocals)\s*\(|\b(request|url|pathname|searchParams|headers|method|params|slug|locals)\b/.test(bodySource);
    const called = new Set<string>();
    const visitBody = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        called.add(node.expression.name.text);
      }
      ts.forEachChild(node, visitBody);
    };
    ts.forEachChild(member.body, visitBody);

    methods.push({
      name,
      visibility,
      isStatic,
      isAsync,
      hasWorkerContextCalls,
      callsThisMethods: [...called],
    });
  }

  return { methods, extendsName };
}

function resolveBaseClassReference(
  absPath: string,
  source: string,
  baseName: string,
): { absPath: string; className: string } | null {
  if (new RegExp(`class\\s+${baseName}\\b`).test(source)) {
    return { absPath, className: baseName };
  }

  const imports = extractRelativeClassImports(source);
  const ref = imports.get(baseName);
  if (!ref) return null;

  const targetAbsPath = resolveRelativeModulePath(absPath, ref.source);
  if (!targetAbsPath || !fs.existsSync(targetAbsPath)) return null;

  if (ref.importedName !== 'default') {
    return { absPath: targetAbsPath, className: ref.importedName };
  }

  const targetSource = fs.readFileSync(targetAbsPath, 'utf-8');
  const namedDefaultClass = targetSource.match(/export\s+default\s+class\s+([A-Za-z_$][\w$]*)\b/);
  if (namedDefaultClass) {
    return { absPath: targetAbsPath, className: namedDefaultClass[1] };
  }
  const defaultAlias = targetSource.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;?/);
  if (defaultAlias) {
    return { absPath: targetAbsPath, className: defaultAlias[1] };
  }
  return null;
}

function extractRelativeClassImports(source: string): Map<string, RelativeImportClassEntry> {
  const imports = new Map<string, RelativeImportClassEntry>();
  const importRegex = /import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(source)) !== null) {
    const clause = String(match[1] ?? '').trim();
    const specifier = String(match[2] ?? '').trim();
    if (!specifier.startsWith('.')) continue;
    if (!clause || clause.startsWith('*')) continue;

    let defaultPart = '';
    let namedPart = '';
    if (clause.startsWith('{')) {
      namedPart = clause;
    } else if (clause.includes('{')) {
      const splitIdx = clause.indexOf('{');
      defaultPart = clause.slice(0, splitIdx).replace(/,$/, '').trim();
      namedPart = clause.slice(splitIdx).trim();
    } else {
      defaultPart = clause.trim();
    }

    if (defaultPart) {
      imports.set(defaultPart, { source: specifier, importedName: 'default' });
    }

    if (namedPart) {
      const namedBody = namedPart.replace(/^\{/, '').replace(/\}$/, '');
      for (const entry of namedBody.split(',')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const namedMatch = trimmed.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!namedMatch) continue;
        const importedName = namedMatch[1];
        const localName = namedMatch[2] ?? importedName;
        imports.set(localName, { source: specifier, importedName });
      }
    }
  }
  return imports;
}

function resolveRelativeModulePath(importerAbsPath: string, specifier: string): string | null {
  const basePath = path.resolve(path.dirname(importerAbsPath), specifier);
  const moduleExt = path.extname(basePath).toLowerCase();
  const hasSourceExtension = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']).has(moduleExt);
  const candidates = hasSourceExtension
    ? [basePath]
    : [
        `${basePath}.ts`,
        `${basePath}.tsx`,
        `${basePath}.js`,
        `${basePath}.mjs`,
        `${basePath}.cjs`,
        path.join(basePath, 'index.ts'),
        path.join(basePath, 'index.tsx'),
        path.join(basePath, 'index.js'),
        path.join(basePath, 'index.mjs'),
        path.join(basePath, 'index.cjs'),
      ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function getClassExtensionDistance(
  absPath: string,
  source: string,
  className: string,
  targetAbsPath: string,
  targetClassName: string,
  cache = new Map<string, number | null>(),
  stack = new Set<string>(),
): number | null {
  const cacheKey = `${absPath}::${className}=>${targetAbsPath}::${targetClassName}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;
  if (stack.has(cacheKey)) return null;
  stack.add(cacheKey);

  const own = extractOwnClassMethods(source, className);
  if (!own?.extendsName) {
    cache.set(cacheKey, null);
    stack.delete(cacheKey);
    return null;
  }

  const baseRef = resolveBaseClassReference(absPath, source, own.extendsName);
  if (!baseRef) {
    cache.set(cacheKey, null);
    stack.delete(cacheKey);
    return null;
  }

  if (baseRef.absPath === targetAbsPath && baseRef.className === targetClassName) {
    cache.set(cacheKey, 1);
    stack.delete(cacheKey);
    return 1;
  }

  const baseSource = fs.readFileSync(baseRef.absPath, 'utf-8');
  const parentDistance = getClassExtensionDistance(baseRef.absPath, baseSource, baseRef.className, targetAbsPath, targetClassName, cache, stack);
  const result = parentDistance == null ? null : parentDistance + 1;
  cache.set(cacheKey, result);
  stack.delete(cacheKey);
  return result;
}

function isDurableObjectSubclass(
  absPath: string,
  source: string,
  className: string,
  cache = new Map<string, boolean>(),
  stack = new Set<string>(),
): boolean {
  const cacheKey = `${absPath}::${className}`;
  const cached = cache.get(cacheKey);
  if (cached != null) return cached;
  if (stack.has(cacheKey)) return false;
  stack.add(cacheKey);

  const own = extractOwnClassMethods(source, className);
  if (!own?.extendsName) {
    cache.set(cacheKey, false);
    stack.delete(cacheKey);
    return false;
  }

  if (own.extendsName === 'DurableObject') {
    cache.set(cacheKey, true);
    stack.delete(cacheKey);
    return true;
  }

  const baseRef = resolveBaseClassReference(absPath, source, own.extendsName);
  if (!baseRef) {
    cache.set(cacheKey, false);
    stack.delete(cacheKey);
    return false;
  }

  const baseSource = fs.readFileSync(baseRef.absPath, 'utf-8');
  const result = isDurableObjectSubclass(baseRef.absPath, baseSource, baseRef.className, cache, stack);
  cache.set(cacheKey, result);
  stack.delete(cacheKey);
  return result;
}

function extractClassMethods(absPath: string, source: string, className: string): DoClassMethodEntry[] {
  const cache = new Map<string, DoClassMethodEntry[]>();
  return resolveClassMethods(absPath, source, className, cache, new Set<string>());
}

function resolveClassMethods(
  absPath: string,
  source: string,
  className: string,
  cache: Map<string, DoClassMethodEntry[]>,
  stack: Set<string>,
): DoClassMethodEntry[] {
  const cacheKey = `${absPath}::${className}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached.map((e) => ({ ...e, callsThisMethods: [...e.callsThisMethods] }));
  if (stack.has(cacheKey)) return [];
  stack.add(cacheKey);

  const own = extractOwnClassMethods(source, className);
  if (!own) {
    stack.delete(cacheKey);
    cache.set(cacheKey, []);
    return [];
  }

  let inherited: DoClassMethodEntry[] = [];
  const extendsName = own.extendsName;
  if (extendsName && extendsName !== 'DurableObject') {
    const baseRef = resolveBaseClassReference(absPath, source, extendsName);
    if (baseRef) {
      const baseSource = fs.readFileSync(baseRef.absPath, 'utf-8');
      inherited = resolveClassMethods(baseRef.absPath, baseSource, baseRef.className, cache, stack);
    }
  }

  const merged = new Map<string, DoClassMethodEntry>();
  for (const method of inherited) {
    merged.set(method.name, { ...method, callsThisMethods: [...method.callsThisMethods] });
  }
  for (const method of own.methods) {
    merged.set(method.name, { ...method, callsThisMethods: [...method.callsThisMethods] });
  }

  const result = [...merged.values()];
  cache.set(cacheKey, result.map((e) => ({ ...e, callsThisMethods: [...e.callsThisMethods] })));
  stack.delete(cacheKey);
  return result;
}

function discoverDoClassContributors(handler: DoHandlerEntry): DoClassContributorEntry[] {
  if (handler.mode !== 'class' || !handler.className) return [];

  const folder = path.dirname(handler.absPath);
  const files = discoverFilesWithExtensions(folder, ['.ts', '.tsx', '.js', '.mjs', '.cjs']);
  const contributors: DoClassContributorEntry[] = [];
  const seen = new Set<string>();

  for (const absPath of files) {
    const source = fs.readFileSync(absPath, 'utf-8');
    const exportedClasses = extractExportedClasses(source);
    for (const exportedClass of exportedClasses) {
      if (absPath === handler.absPath && exportedClass.className === handler.className) continue;

      const depth = getClassExtensionDistance(absPath, source, exportedClass.className, handler.absPath, handler.className);
      if (depth == null || depth < 1) continue;

      const own = extractOwnClassMethods(source, exportedClass.className);
      if (!own) continue;

      const key = `${absPath}::${exportedClass.className}`;
      if (seen.has(key)) continue;
      seen.add(key);

      contributors.push({
        absPath,
        className: exportedClass.className,
        exportKind: exportedClass.exportKind,
        classMethods: own.methods.map((m) => ({ ...m, callsThisMethods: [...m.callsThisMethods] })),
        depth,
      });
    }
  }

  contributors.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const fc = a.absPath.localeCompare(b.absPath);
    if (fc !== 0) return fc;
    return a.className.localeCompare(b.className);
  });

  return contributors;
}

function mergeDoClassMethods(
  baseMethods: DoClassMethodEntry[],
  contributors: DoClassContributorEntry[],
): DoClassMethodEntry[] {
  const merged = new Map<string, DoClassMethodEntry>();
  for (const method of baseMethods) {
    merged.set(method.name, { ...method, callsThisMethods: [...method.callsThisMethods] });
  }
  for (const contributor of contributors) {
    for (const method of contributor.classMethods) {
      merged.set(method.name, { ...method, callsThisMethods: [...method.callsThisMethods] });
    }
  }
  return [...merged.values()];
}

export function generateHandlerProxy(
  handler: DoHandlerEntry,
  opts: { projectDir: string; runtimeDoImport: string; runtimeSchemaImport: string },
): string {
  const doDir = path.join(opts.projectDir, '.koze', 'do');
  const proxyFile = path.join(doDir, handler.fileName + '.ts');
  const proxyFileDir = path.dirname(proxyFile);
  const origRelPath = path.relative(proxyFileDir, handler.absPath).replace(/\\/g, '/');
  const handlerLocal = `__handler_${toSafeIdentifier(handler.fileName)}`;
  const lifecycle = new Set(['constructor', 'fetch', 'alarm', 'webSocketMessage', 'webSocketClose', 'webSocketError']);

  const rpcFunctions = handler.classMethods
    .filter((method) => method.visibility === 'public' && !method.name.startsWith('_') && !lifecycle.has(method.name))
    .map((method) => method.name);

  const methods = handler.classMethods.map((method) => ({ ...method }));
  const methodMap = new Map(methods.map((method) => [method.name, method]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const method of methods) {
      if (method.hasWorkerContextCalls) continue;
      for (const called of method.callsThisMethods) {
        const target = methodMap.get(called);
        if (target?.hasWorkerContextCalls) {
          method.hasWorkerContextCalls = true;
          changed = true;
          break;
        }
      }
    }
  }

  const workerContextMethods = methods
    .filter((method) => method.visibility === 'public' && method.hasWorkerContextCalls)
    .map((method) => method.name);
  const asyncMethods = methods.filter((method) => method.isAsync).map((method) => method.name);

  const handlerImport = handler.exportKind === 'named' && handler.className
    ? `import { ${handler.className} as ${handlerLocal} } from '${origRelPath}';`
    : `import ${handlerLocal} from '${origRelPath}';`;

  const lines: string[] = [
    `// Auto-generated by Koze compiler ï¿½" do not edit.`,
    `import { __getDoStub } from '${opts.runtimeDoImport}';`,
    `import { validateSchemaInput as __validateSchemaInput } from '${opts.runtimeSchemaImport}';`,
    handlerImport,
    ``,
    `const __FD_TAG = '__koze_form_data__';`,
    `function __isPlainObject(__v) {`,
    `  if (!__v || typeof __v !== 'object') return false;`,
    `  const __proto = Object.getPrototypeOf(__v);`,
    `  return __proto === Object.prototype || __proto === null;`,
    `}`,
    `function __encodeArg(__v, __seen = new WeakSet()) {`,
    `  if (typeof FormData !== 'undefined' && __v instanceof FormData) {`,
    `    return { [__FD_TAG]: Array.from(__v.entries()) };`,
    `  }`,
    `  if (Array.isArray(__v)) return __v.map((__x) => __encodeArg(__x, __seen));`,
    `  if (__isPlainObject(__v)) {`,
    `    if (__seen.has(__v)) throw new Error('[Koze] Circular object passed to DO RPC');`,
    `    __seen.add(__v);`,
    `    const __out = {};`,
    `    for (const [__k, __val] of Object.entries(__v)) __out[__k] = __encodeArg(__val, __seen);`,
    `    __seen.delete(__v);`,
    `    return __out;`,
    `  }`,
    `  return __v;`,
    `}`,
    `function __decodeArg(__v) {`,
    `  if (Array.isArray(__v)) return __v.map(__decodeArg);`,
    `  if (__isPlainObject(__v)) {`,
    `    const __obj = __v;`,
    `    if (__FD_TAG in __obj) {`,
    `      const __fd = new FormData();`,
    `      const __entries = Array.isArray(__obj[__FD_TAG]) ? __obj[__FD_TAG] : [];`,
    `      for (const __pair of __entries) {`,
    `        if (Array.isArray(__pair) && __pair.length >= 2) __fd.append(String(__pair[0]), __pair[1]);`,
    `      }`,
    `      return __fd;`,
    `    }`,
    `    const __out = {};`,
    `    for (const [__k, __val] of Object.entries(__obj)) __out[__k] = __decodeArg(__val);`,
    `    return __out;`,
    `  }`,
    `  return __v;`,
    `}`,
    ``,
  ];

  if (workerContextMethods.length > 0) {
    lines.push(`const __workerMethods = new Set(${JSON.stringify(workerContextMethods)});`);
    lines.push(`const __asyncMethods = new Set(${JSON.stringify(asyncMethods)});`);
    lines.push(`function __callWorkerMethod(__name, __args) {`);
    lines.push(`  const __self = new Proxy({}, {`);
    lines.push(`    get(_, __k) {`);
    lines.push(`      if (typeof __k !== 'string') return undefined;`);
    lines.push(`      if (__k === 'db') {`);
    lines.push(`        throw new Error("[Koze] Worker-executed DO method cannot use this.db directly. Move DB access into a non-public method and call it via this.<method>().");`);
    lines.push(`      }`);
    lines.push(`      if (__workerMethods.has(__k)) {`);
    lines.push(`        return (...__a) => ${handlerLocal}.prototype[__k].apply(__self, __a);`);
    lines.push(`      }`);
    lines.push(`      const __local = ${handlerLocal}.prototype[__k];`);
    lines.push(`      if (typeof __local === 'function' && !__asyncMethods.has(__k)) {`);
    lines.push(`        return (...__a) => __local.apply(__self, __a);`);
    lines.push(`      }`);
    lines.push(`      return async (...__a) => { const __s = await __getDoStub('${handler.binding}'); if (!__s) throw new Error('Not authenticated'); return __s[__k](...__a.map((__x) => __encodeArg(__x))); };`);
    lines.push(`    },`);
    lines.push(`  });`);
    lines.push(`  return ${handlerLocal}.prototype[__name].apply(__self, __args.map(__decodeArg));`);
    lines.push(`}`);
    lines.push(``);
  }

  for (const method of rpcFunctions) {
    lines.push(`const __schema_${toSafeIdentifier(method)} = ${handlerLocal}.schemas?.[${JSON.stringify(method)}];`);
    if (workerContextMethods.includes(method)) {
      lines.push(`export async function ${method}(...a) { return __callWorkerMethod('${method}', __validateSchemaInput(__schema_${toSafeIdentifier(method)}, a)); }`);
    } else {
      lines.push(
        `export async function ${method}(...a) { const __validated = __validateSchemaInput(__schema_${toSafeIdentifier(method)}, a); const s = await __getDoStub('${handler.binding}'); if (!s) throw new Error('Not authenticated'); return s.${method}(...__validated.map((__x) => __encodeArg(__x))); }`,
      );
    }
  }

  return lines.join('\n') + '\n';
}
