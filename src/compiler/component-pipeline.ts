import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { componentFuncName } from './compiler-shared.js';
import { parseFile, stripTopLevelImports } from './parser.js';
import { parseImportStatement, parseNamedImportBindings } from './import-linking.js';
import { analyzeClientTemplateReactivity, buildClientTemplateRenderersExpression, compileTemplate } from './template.js';
import { buildClientScopeMount, buildDevAliasDeclarations, transformReactiveClientScript } from './script-transform.js';
import {
  getKuratchiTemplateAttributeExpression,
  getKuratchiTemplateRawBlocks,
  getKuratchiTemplateTags,
  parseKuratchiTemplate,
  stripKuratchiTemplateNodes,
} from './template-parser.js';

export interface ComponentCompiler {
  ensureCompiled(fileName: string, importerAbsPath?: string): string | null;
  collectComponentMap(
    componentImports: Record<string, string>,
    importerAbsPath?: string,
  ): Map<string, string>;
  getActionPropNames(fileName: string): Set<string>;
  collectStyles(componentNames: Map<string, string>): string[];
  resolveActionProps(
    template: string,
    componentNames: Map<string, string>,
    shouldInclude?: (fnName: string) => boolean,
  ): Set<string>;
  getCompiledComponents(opts?: {
    resolveCompiledImportPath?: (
      origPath: string,
      importerDir: string,
      outFileDir: string,
    ) => string;
    allocateModuleId?: () => string;
    pushImport?: (statement: string) => void;
    outFileDir?: string;
  }): string[];
  getServerImports(): string[];
  collectServerRpcBindings(componentNames: Map<string, string>): ComponentServerRpcBinding[];
  /**
   * Absolute path each component fileName resolved to. Consumers (e.g.
   * the Vite plugin) call this to register `addWatchFile` so HMR
   * triggers a route recompile when a component changes on disk.
   */
  getResolvedFiles(): Map<string, string>;
}

interface CreateComponentCompilerOptions {
  projectDir: string;
  srcDir: string;
  isDev: boolean;
}

interface ComponentImportMetadata {
  filePath: string;
  serverImports: string[];
  serverRpcBindings: ComponentServerRpcBinding[];
  subComponentFileNames: string[];
}

interface ComponentServerRpcBinding {
  importedName: string;
  localName: string;
  sourceKey: string;
  moduleSpecifier: string;
  importerDir: string;
}

const COMPONENT_EXT = '.koze';
const LEGACY_COMPONENT_EXT = '.kuratchi';
const COMPONENT_EXTENSIONS = [COMPONENT_EXT, LEGACY_COMPONENT_EXT] as const;
const RELATIVE_PREFIX = '__rel__:';

/**
 * Internal name for the props bag the wrapper function receives. Long
 * and prefixed so user code can shadow `props` freely without
 * collision; the bag itself is referenced from compiler-emitted code
 * (e.g. the `<slot>` rewrite) where stability matters.
 */
const PROPS_BAG_NAME = '__koze_propsbag';

/**
 * Regex testing whether a script declares
 *   import { props } from 'koze:component';
 * The import must use the literal name `props` — renaming via
 * `import { props as foo }` is rejected with a hard error so the
 * convention stays predictable across every component in a codebase.
 */
const COMPONENT_IMPORT_RE = /^\s*import\s*\{\s*([^}]+)\s*\}\s*from\s*['"](?:koze|kuratchi):component['"]\s*;?\s*$/m;

/**
 * Strip JS comments (line `//…\n` and block `/* … *\/`) and string
 * literals from a script body before scanning for `props` references.
 * Without this, a benign comment like `// no props here` would
 * trigger a false-positive missing-import error.
 *
 * The replacement preserves length-equivalent whitespace where
 * possible so any line-based diagnostics built on top of this still
 * point at correct line numbers, but for the purposes of the
 * `PROPS_REFERENCE_RE` test we only care about token presence.
 */
function stripCommentsAndStrings(source: string): string {
  return source
    // Block comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Line comments
    .replace(/\/\/[^\n]*/g, ' ')
    // Template literals (could contain `props` in interpolation but we
    // only care about top-level value references in the prelude;
    // interpolation references would be rewritten anyway).
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    // Double-quoted strings
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    // Single-quoted strings
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

/**
 * Bare `props` reference. Used to detect "ghost props" usage in
 * components that didn't import `props` from `koze:component`.
 * Pre-import era code looked like:
 *
 *   <script>
 *     const { x } = props;     // ambient
 *   </script>
 *
 * That ambient binding is gone. Every component now has to import
 * `props` explicitly when it references the identifier.
 */
const PROPS_REFERENCE_RE = /\bprops\b/;

function resolveComponentFile(basePathWithoutExt: string): string {
  for (const ext of COMPONENT_EXTENSIONS) {
    const candidate = basePathWithoutExt.endsWith(ext)
      ? basePathWithoutExt
      : basePathWithoutExt + ext;
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function resolvePackageComponent(projectDir: string, pkgName: string, componentFile: string): string {
  const nmPath = resolveComponentFile(path.join(projectDir, 'node_modules', pkgName, 'src', 'lib', componentFile));
  if (nmPath) return nmPath;

  const pkgDirName = pkgName.replace(/^@/, '').replace(/\//g, '-');
  const workspaceRoot = path.resolve(projectDir, '../..');
  const wsPath = resolveComponentFile(path.join(workspaceRoot, 'packages', pkgDirName, 'src', 'lib', componentFile));
  if (wsPath) return wsPath;

  const rootNmPath = resolveComponentFile(path.join(workspaceRoot, 'node_modules', pkgName, 'src', 'lib', componentFile));
  if (rootNmPath) return rootNmPath;

  return '';
}

/**
 * True when `filePath` lives inside `<srcDir>/routes/`. Used to enforce
 * the rule that route files cannot be imported as components — that's
 * the one footgun strong enough to be worth blocking. Components
 * elsewhere (`$lib/`, packages, co-located in app subtrees, even
 * `src/foo.koze`) are all fine.
 */
function isInRoutesTree(filePath: string, srcDir: string): boolean {
  const routesAbs = path.resolve(srcDir, 'routes');
  const rel = path.relative(routesAbs, filePath);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function escapeTemplateLiteral(source: string): string {
  return source.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function buildComponentServerRpcId(sourceKey: string, importedName: string): string {
  return `rpc_component_${crypto.createHash('sha1').update(`${sourceKey}:${importedName}`).digest('hex').slice(0, 12)}`;
}

const CSS_GROUP_AT_RULES = new Set([
  'container',
  'document',
  'layer',
  'media',
  'scope',
  'supports',
]);

function readCssBlock(source: string, start: number): { content: string; end: number } {
  let depth = 1;
  let i = start;
  let quote: string | null = null;
  let inComment = false;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (inComment) {
      if (char === '*' && next === '/') {
        inComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (quote) {
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i++;
      continue;
    }

    if (char === '/' && next === '*') {
      inComment = true;
      i += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      i++;
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        return { content: source.slice(start, i), end: i + 1 };
      }
    }
    i++;
  }

  return { content: source.slice(start), end: source.length };
}

function findCssRuleBoundary(source: string, start: number): { index: number; char: '{' | ';' | null } {
  let i = start;
  let quote: string | null = null;
  let inComment = false;
  let parenDepth = 0;
  let bracketDepth = 0;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (inComment) {
      if (char === '*' && next === '/') {
        inComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (quote) {
      if (char === '\\') {
        i += 2;
        continue;
      }
      if (char === quote) quote = null;
      i++;
      continue;
    }

    if (char === '/' && next === '*') {
      inComment = true;
      i += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      i++;
      continue;
    }
    if (char === '(') parenDepth++;
    else if (char === ')' && parenDepth > 0) parenDepth--;
    else if (char === '[') bracketDepth++;
    else if (char === ']' && bracketDepth > 0) bracketDepth--;
    else if ((char === '{' || char === ';') && parenDepth === 0 && bracketDepth === 0) {
      return { index: i, char: char as '{' | ';' };
    }
    i++;
  }

  return { index: source.length, char: null };
}

function splitCssSelectors(selectorList: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let inComment = false;
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < selectorList.length; i++) {
    const char = selectorList[i];
    const next = selectorList[i + 1];

    if (inComment) {
      if (char === '*' && next === '/') {
        inComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') {
        i++;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '*') {
      inComment = true;
      i++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') parenDepth++;
    else if (char === ')' && parenDepth > 0) parenDepth--;
    else if (char === '[') bracketDepth++;
    else if (char === ']' && bracketDepth > 0) bracketDepth--;
    else if (char === ',' && parenDepth === 0 && bracketDepth === 0) {
      selectors.push(selectorList.slice(start, i));
      start = i + 1;
    }
  }

  selectors.push(selectorList.slice(start));
  return selectors;
}

function scopeCssSelectors(selectorList: string, scopeHash: string): string {
  return splitCssSelectors(selectorList)
    .map((selector) => {
      const leading = selector.match(/^\s*/)?.[0] ?? '';
      const trailing = selector.match(/\s*$/)?.[0] ?? '';
      const trimmed = selector.trim();
      if (!trimmed) return selector;
      if (trimmed.startsWith(`.${scopeHash} `)) return selector;
      return `${leading}.${scopeHash} ${trimmed}${trailing}`;
    })
    .join(',');
}

function getAtRuleName(prelude: string): string | null {
  const match = prelude.trim().match(/^@(-?[\w-]+)/);
  return match ? match[1].toLowerCase() : null;
}

function scopeCssRules(source: string, scopeHash: string): string {
  let out = '';
  let cursor = 0;

  while (cursor < source.length) {
    const boundary = findCssRuleBoundary(source, cursor);
    if (!boundary.char) {
      out += source.slice(cursor);
      break;
    }

    const prelude = source.slice(cursor, boundary.index);
    if (boundary.char === ';') {
      out += source.slice(cursor, boundary.index + 1);
      cursor = boundary.index + 1;
      continue;
    }

    const block = readCssBlock(source, boundary.index + 1);
    const atRuleName = getAtRuleName(prelude);
    if (atRuleName) {
      const body = CSS_GROUP_AT_RULES.has(atRuleName)
        ? scopeCssRules(block.content, scopeHash)
        : block.content;
      out += `${prelude}{${body}}`;
    } else {
      out += `${scopeCssSelectors(prelude, scopeHash)}{${block.content}}`;
    }
    cursor = block.end;
  }

  return out;
}

function scopeComponentCss(source: string, scopeHash: string): string {
  return scopeCssRules(source, scopeHash);
}

/**
 * Validate the component's `koze:component` import declaration.
 *
 *   - Required exactly once when the script references `props` at all.
 *   - The named import must be literally `props`. Renaming
 *     (`import { props as foo }`) is rejected so the convention stays
 *     stable across the whole codebase.
 *
 * Returns true when an import was found, false otherwise.
 */
function validateComponentImport(rawScript: string, filePath: string): boolean {
  const match = rawScript.match(COMPONENT_IMPORT_RE);
  if (!match) return false;
  const namedSpec = match[1].trim();
  // Accept exactly `props`, `type props`, `props,` (with a trailing
  // comma if the author groups multiple imports), and `props as props`.
  // Reject any other rename.
  const idents = namedSpec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const ident of idents) {
    const renameMatch = ident.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (renameMatch) {
      const [, original, alias] = renameMatch;
      if (original === 'props' && alias !== 'props') {
        throw new Error(
          `[koze] In ${filePath}: \`import { props as ${alias} } from 'koze:component'\` ` +
            `is not allowed. The convention is to import \`props\` literally so every ` +
            `component in the codebase uses the same name.`,
        );
      }
    }
  }
  return true;
}

function buildComponentPropsShim(): string {
  return `
const __propsTarget = () => ${PROPS_BAG_NAME};
const props = new Proxy(__propsTarget, {
  apply() {
    return ${PROPS_BAG_NAME};
  },
  get(target, key, receiver) {
    if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(${PROPS_BAG_NAME}, key)) {
      return ${PROPS_BAG_NAME}[key];
    }
    return Reflect.get(target, key, receiver);
  },
  has(target, key) {
    if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(${PROPS_BAG_NAME}, key)) {
      return true;
    }
    return Reflect.has(target, key);
  },
  ownKeys(target) {
    const bagKeys = Reflect.ownKeys(${PROPS_BAG_NAME});
    const targetKeys = Reflect.ownKeys(target);
    return Array.from(new Set([...bagKeys, ...targetKeys]));
  },
  getOwnPropertyDescriptor(target, key) {
    if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(${PROPS_BAG_NAME}, key)) {
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: ${PROPS_BAG_NAME}[key],
      };
    }
    return Reflect.getOwnPropertyDescriptor(target, key);
  },
});`.trim();
}

function collectComponentServerRpcBindings(
  serverImports: string[],
  filePath: string,
  srcDir: string,
): ComponentServerRpcBinding[] {
  const bindings: ComponentServerRpcBinding[] = [];
  const importerDir = path.dirname(filePath);
  for (const statement of serverImports) {
    const parsed = parseImportStatement(statement);
    if (!parsed.moduleSpecifier) continue;
    let sourceKey = '';
    if (parsed.moduleSpecifier.startsWith('$server/')) {
      sourceKey = path.resolve(srcDir, 'server', parsed.moduleSpecifier.slice('$server/'.length));
    } else if (parsed.moduleSpecifier.startsWith('./') || parsed.moduleSpecifier.startsWith('../')) {
      const resolved = path.resolve(path.dirname(filePath), parsed.moduleSpecifier);
      const serverDir = path.resolve(srcDir, 'server');
      const rel = path.relative(serverDir, resolved);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        sourceKey = resolved;
      }
    }
    if (!sourceKey) continue;
    const resolvedSourceKey = fs.existsSync(sourceKey)
      ? sourceKey
      : fs.existsSync(sourceKey + '.ts')
        ? sourceKey + '.ts'
        : fs.existsSync(sourceKey + '.js')
          ? sourceKey + '.js'
          : sourceKey;
    for (const binding of parseNamedImportBindings(statement)) {
      bindings.push({
        importedName: binding.imported,
        localName: binding.local,
        sourceKey: resolvedSourceKey.replace(/\\/g, '/'),
        moduleSpecifier: parsed.moduleSpecifier,
        importerDir,
      });
    }
  }
  return bindings;
}

function buildComponentClientScript(opts: {
  rawScript: string;
  reactiveNames: Set<string>;
  blockRenderersExpr?: string;
  serverRpcBindings: ComponentServerRpcBinding[];
}): string {
  const bodyWithoutImportsRaw = stripTopLevelImports(opts.rawScript);
  const bodyWithoutImports = bodyWithoutImportsRaw
    ? ts.transpileModule(bodyWithoutImportsRaw, {
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          isolatedModules: false,
        },
        reportDiagnostics: false,
      }).outputText
    : '';
  const transformedReactive = transformReactiveClientScript(bodyWithoutImports, {
    forceRuntime: true,
    reactiveNames: opts.reactiveNames,
  });
  const rpcStubLines: string[] = [];
  if (opts.serverRpcBindings.length > 0) {
    rpcStubLines.push(`function __kozeComponentRpcValue(rpcId, args) {`);
    rpcStubLines.push(`  const input = { carrier: 'capnweb-http', target: 'route', op: rpcId, args: Array.isArray(args) ? args : [] };`);
    rpcStubLines.push(`  const channel = typeof window !== 'undefined' ? window.__kozeChannel : null;`);
    rpcStubLines.push(`  if (channel && typeof channel.createRpcValue === 'function') return channel.createRpcValue(input);`);
    rpcStubLines.push(`  if (!channel || typeof channel.invoke !== 'function') throw new Error('[koze] Capn Web channel runtime is not installed.');`);
    rpcStubLines.push(`  const promise = channel.invoke(input);`);
    rpcStubLines.push(`  return promise.then(function(value) {`);
    rpcStubLines.push(`    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('koze:invalidate-reads', { detail: { rpcId: rpcId } }));`);
    rpcStubLines.push(`    return value;`);
    rpcStubLines.push(`  });`);
    rpcStubLines.push(`}`);
    for (const binding of opts.serverRpcBindings) {
      rpcStubLines.push(`function ${binding.localName}(...args) { return __kozeComponentRpcValue(${JSON.stringify(buildComponentServerRpcId(binding.sourceKey, binding.importedName))}, args); }`);
    }
  }

  const mountCode = buildClientScopeMount(
    bodyWithoutImports,
    opts.reactiveNames,
    opts.blockRenderersExpr,
    undefined,
    '__kRoot',
  );
  const scopedMountCode = mountCode.replace(
    'const __kScope = __k$.scope(() => __kScopeValues);',
    `Object.defineProperty(__kScopeValues, ${JSON.stringify(PROPS_BAG_NAME)}, { enumerable: false, configurable: true, get(){ return ${PROPS_BAG_NAME}; } });\nconst __kScope = __k$.scope(() => __kScopeValues);`,
  );

  return [
    `(function(){`,
    `const __kRoot = document.currentScript?.previousElementSibling instanceof HTMLElement && document.currentScript.previousElementSibling.hasAttribute('data-k-island-root') ? document.currentScript.previousElementSibling : document.body;`,
    `const __kPropsEncoded = document.currentScript?.dataset?.kProps || '';`,
    `const ${PROPS_BAG_NAME} = __kPropsEncoded ? JSON.parse(decodeURIComponent(__kPropsEncoded)) : {};`,
    buildComponentPropsShim(),
    ...rpcStubLines,
    transformedReactive,
    scopedMountCode,
    `})();`,
  ].filter(Boolean).join('\n');
}

export function createComponentCompiler(options: CreateComponentCompilerOptions): ComponentCompiler {
  const { projectDir, srcDir, isDev } = options;
  const libDir = path.join(srcDir, 'lib');
  const compiledComponentCache = new Map<string, string>();
  const componentStyleCache = new Map<string, string>();
  const componentActionCache = new Map<string, Set<string>>();
  const resolvedFiles = new Map<string, string>();
  const componentImportCache = new Map<string, ComponentImportMetadata>();

  function resolveComponentPath(fileName: string, importerAbsPath?: string): { filePath: string; funcName: string } | null {
    // Relative import: "__rel__:<absolute-or-relative-path>"
    //
    // The parser pre-resolves relative specifiers against the
    // importer's directory and stores an absolute path here. That
    // makes the key canonical — two different importers writing
    // `./foo.koze` only share a cache entry when their resolved
    // paths actually match on disk. The fallback handles the rare
    // edge case where the parser had no `filePath` context and
    // stored the raw spec instead (we then need `importerAbsPath`).
    if (fileName.startsWith(RELATIVE_PREFIX)) {
      const stored = fileName.slice(RELATIVE_PREFIX.length);
      let filePath: string;
      if (path.isAbsolute(stored)) {
        // Stored as absolute path (parser resolved it). Add the
        // `.koze` extension if it isn't already there.
        filePath = resolveComponentFile(stored) || stored + COMPONENT_EXT;
      } else {
        // Fallback: parser couldn't resolve, we need the importer.
        if (!importerAbsPath) {
          throw new Error(
            `[koze] Relative component import "${stored}" used without an importer context. ` +
              `The compiler must pass importerAbsPath when compiling a parent route/layout/component.`,
          );
        }
        const importerDir = path.dirname(importerAbsPath);
        filePath = resolveComponentFile(path.resolve(importerDir, stored)) || path.resolve(importerDir, stored + COMPONENT_EXT);
      }
      if (!fs.existsSync(filePath)) return null;
      const funcName = componentFuncName(fileName);
      return { filePath, funcName };
    }

    // Package import: "@scope/pkg:foo/bar" or "pkg:foo/bar".
    const pkgMatch = fileName.match(/^((?:@[^/:]+\/)?[^/:]+):(.+)$/);
    if (pkgMatch) {
      const pkgName = pkgMatch[1];
      const componentFile = pkgMatch[2];
      const funcName = componentFuncName(fileName);
      const filePath = resolvePackageComponent(projectDir, pkgName, componentFile);
      if (!filePath) return null;
      return { filePath, funcName };
    }

    // $lib import: "stat-card" → src/lib/stat-card.koze
    const funcName = componentFuncName(fileName);
    const filePath = resolveComponentFile(path.join(libDir, fileName));
    if (!fs.existsSync(filePath)) return null;
    return { filePath, funcName };
  }

  function ensureCompiled(fileName: string, importerAbsPath?: string): string | null {
    if (compiledComponentCache.has(fileName)) return compiledComponentCache.get(fileName)!;

    const resolved = resolveComponentPath(fileName, importerAbsPath);
    if (!resolved) return null;
    const { filePath, funcName } = resolved;

    // Hard-error: route files (anything under `<srcDir>/routes/`) cannot
    // be components. This catches accidents like importing
    // `./layout.koze` as if it were a card. Components elsewhere are
    // fine — co-location, $lib, packages all permitted.
    if (isInRoutesTree(filePath, srcDir)) {
      const display = fileName.startsWith(RELATIVE_PREFIX) ? fileName.slice(RELATIVE_PREFIX.length) : fileName;
      throw new Error(
        `[koze] Cannot import "${display}" as a component — it lives under src/routes/. ` +
          `Route files are not components. Move the file out of routes/ (e.g. into $lib/) ` +
          `or convert it into a fragment that's invoked through layout composition.`,
      );
    }

    resolvedFiles.set(fileName, filePath);

    const scopeHash = 'dz-' + crypto.createHash('md5').update(fileName).digest('hex').slice(0, 6);
    const rawSource = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseFile(rawSource, { kind: 'component', filePath });
    const serverRpcBindings = collectComponentServerRpcBindings(parsed.serverImports ?? [], filePath, srcDir);
    componentImportCache.set(fileName, {
      filePath,
      serverImports: parsed.serverImports ?? [],
      serverRpcBindings,
      subComponentFileNames: [],
    });

    // Validate `import { props } from 'koze:component'`. If the
    // script body OR template references the identifier `props` at
    // all (outside of comments/strings), the import must be present
    // — that's the breaking change from the old "ambient props"
    // world. Routes and layouts are unaffected; this check only runs
    // on components.
    const rawScript = parsed.script ?? '';
    const scriptForCheck = stripCommentsAndStrings(rawScript);
    const templateForCheck = stripCommentsAndStrings(parsed.template);
    const referencesProps =
      PROPS_REFERENCE_RE.test(scriptForCheck) || PROPS_REFERENCE_RE.test(templateForCheck);
    const hasComponentImport = validateComponentImport(rawScript, filePath);
    if (referencesProps && !hasComponentImport) {
      throw new Error(
        `[koze] Component "${path.relative(projectDir, filePath)}" references \`props\` but ` +
          `does not import it. Add\n\n  import { props } from 'koze:component';\n\n` +
          `at the top of the component's <script> block. The "ambient props" pattern is gone — ` +
          `every component must declare its props binding explicitly.`,
      );
    }

    // Strip TypeScript syntax from the props code. Components are
    // typed by convention (`props<T>()`, typed destructure defaults,
    // type aliases inside the script), but the consumer of this
    // emitted code is whatever bundler the framework end-user runs:
    //
    //   - Legacy CLI → wrangler's esbuild handles TS downstream
    //   - Vite plugin → Rollup, which does NOT transpile TS
    //
    // Stripping types here once means both consumers receive plain
    // JavaScript and we don't have to teach Vite a per-virtual-module
    // TS transform pipeline. Imports are stripped first (they are
    // hoisted to the wrapper module and we don't want them duplicated
    // in the prelude); the remaining body is transpiled with
    // `target=ESNext` + `module=ESNext` so async/await, optional
    // chaining, etc. all pass through untouched.
    const propsCodeRaw = rawScript ? stripTopLevelImports(rawScript) : '';
    const propsCode = propsCodeRaw
      ? ts.transpileModule(propsCodeRaw, {
          compilerOptions: {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            // Don't emit module-aware artifacts — the props code is
            // injected inline into the component wrapper function,
            // not loaded as its own module.
            isolatedModules: false,
          },
          fileName: filePath,
          reportDiagnostics: false,
        }).outputText
      : '';
    const devDecls = buildDevAliasDeclarations(parsed.devAliases, isDev);
    // TypeScript is preserved — wrangler's esbuild handles transpilation
    const effectivePropsCode = [devDecls, propsCode].filter(Boolean).join('\n');

    const styleBlocks = getKuratchiTemplateRawBlocks(parsed.ir.template.ast, 'style');
    let source = styleBlocks.length > 0
      ? stripKuratchiTemplateNodes(parsed.ir.template.ast, (node) => node.kind === 'raw-block' && node.name === 'style').trim()
      : parsed.ir.template.source;

    const scopedStyle = styleBlocks
      .map((styleBlock) => `<style>${scopeComponentCss(styleBlock.content.trim(), scopeHash)}</style>`)
      .join('');
    componentStyleCache.set(fileName, scopedStyle ? escapeTemplateLiteral(scopedStyle) : '');

    // Slot rewrite — anchor to the props bag, NOT the user-visible
    // `props` binding, so a user who shadows `props` (rare but
    // possible) doesn't break <slot></slot>.
    source = source.replace(/<slot\s*><\/slot>/g, `{@raw ${PROPS_BAG_NAME}.children || ""}`);
    source = source.replace(/<slot\s*\/>/g, `{@raw ${PROPS_BAG_NAME}.children || ""}`);

    // Components recurse — sub-components inside this component are
    // resolved against THIS component's directory (not the original
    // importer's), because relative paths in a card.koze mean
    // "relative to card.koze".
    const subComponentNames = collectComponentMap(parsed.componentImports, filePath);
    const meta = componentImportCache.get(fileName);
    if (meta) {
      meta.subComponentFileNames = Array.from(subComponentNames.values());
    }
    for (const subFileName of subComponentNames.values()) {
      const subStyle = componentStyleCache.get(subFileName);
      if (subStyle) {
        const existing = componentStyleCache.get(fileName) || '';
        if (!existing.includes(subStyle)) {
          componentStyleCache.set(fileName, existing + subStyle);
        }
      }
    }

    const actionPropNames = new Set<string>();
    const componentTemplateAst = parseKuratchiTemplate(source);
    for (const tag of getKuratchiTemplateTags(componentTemplateAst)) {
      if (tag.closing) continue;
      const actionExpr = getKuratchiTemplateAttributeExpression(tag, 'action');
      if (actionExpr && /^[A-Za-z_$][\w$]*$/.test(actionExpr)) {
        actionPropNames.add(actionExpr);
      }
    }
    componentActionCache.set(fileName, actionPropNames);

    const clientTemplatePlan = analyzeClientTemplateReactivity(
      source,
      rawScript,
      subComponentNames,
      undefined,
      undefined,
      { clientScriptBody: rawScript },
    );
    const body = compileTemplate(source, subComponentNames, undefined, undefined, {
      clientScriptBody: rawScript,
      liveTemplateNames: clientTemplatePlan.reactiveNames,
    });
    const scopeOpen = `__parts.push('<div class="${scopeHash}" data-k-island-root>');`;
    const scopeClose = `__parts.push('</div>');`;
    const bodyLines = body.split('\n');
    const insertIndex = bodyLines.findIndex(l => l.startsWith('let __html'));
    const safeInsertIndex = insertIndex === -1 ? bodyLines.length : insertIndex;
    const componentClientScript = rawScript.trim()
      ? buildComponentClientScript({
          rawScript,
          reactiveNames: clientTemplatePlan.reactiveNames,
          blockRenderersExpr: buildClientTemplateRenderersExpression(clientTemplatePlan.blockRenderers),
          serverRpcBindings,
        })
      : '';
    const componentClientScriptLine = componentClientScript
      ? `__parts.push(\`<script data-k-props="\${__esc(encodeURIComponent(JSON.stringify(${PROPS_BAG_NAME} || {})))}">${escapeTemplateLiteral(componentClientScript)}</script>\`);`
      : '';
    const scopedBody = [
      bodyLines[0],
      scopeOpen,
      ...bodyLines.slice(1, safeInsertIndex),
      scopeClose,
      ...(componentClientScriptLine ? [componentClientScriptLine] : []),
      ...bodyLines.slice(safeInsertIndex)
    ].join('\n');

    // The compiler-injected `props` binding does double duty: it is
    // both callable (`props()` returns the bag — used by typed
    // destructure in component scripts) and indexable (`props.title`
    // — used by template references like `{props.title}`). The
    // `Object.assign(callable, bag)` used to attach every bag key
    // as an own property of the function so both forms resolved to
    // the same data, but that collides with built-in read-only
    // function properties like `.name` when a component accepts a
    // prop with the same key. A proxy over the callable keeps both
    // forms working without mutating function internals.
    //
    // Authors who do `const { x } = props<{...}>()` get destructure
    // semantics; authors who do `<div data-x={props.x}>` get
    // property-access semantics. Same source of truth.
    const propsShim = buildComponentPropsShim();
    // Local helpers — `compileTemplate` emits calls to `__rawHtml`,
    // `__sanitizeHtml`, and `__esc` for `{@raw …}`, `{@html …}`, and
    // `{expr}` interpolations respectively. These helpers are
    // normally synthesized inside the route's `render()` function,
    // but components are TOP-LEVEL functions that can't see that
    // closure. Defining them inline per-component keeps each
    // component self-contained and lets it be invoked from any
    // caller (route, layout, sibling component) without a leaky
    // dependency on the caller's lexical scope.
    //
    // The signatures match the route-side definitions verbatim. We
    // accept the second-parameter `__esc` from the caller as the
    // canonical escape function (so a route's `__esc` and a
    // component's `__esc` are the same function instance), but
    // shadow it locally with a fallback so a component invoked
    // without an `__esc` still escapes correctly.
    // The wrapper takes the parent's escape function as `__escIn`,
    // then defines a local `__esc` that falls back to a default
    // implementation when invoked without an escape function.
    // Renaming the parameter (rather than reassigning it) avoids
    // strict-mode complaints in any consuming bundler.
    const componentHelpers = `
  const __rawHtml = (v) => (v == null ? '' : String(v));
  const __sanitizeHtml = (v) => {
    let html = __rawHtml(v);
    html = html.replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, '');
    html = html.replace(/<iframe\\b[^>]*>[\\s\\S]*?<\\/iframe>/gi, '');
    html = html.replace(/<object\\b[^>]*>[\\s\\S]*?<\\/object>/gi, '');
    html = html.replace(/<embed\\b[^>]*>/gi, '');
    html = html.replace(/\\son[a-z]+\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)/gi, '');
    html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*(["'])\\s*javascript:[\\s\\S]*?\\2/gi, ' $1="#"');
    html = html.replace(/\\s(href|src|xlink:href)\\s*=\\s*javascript:[^\\s>]+/gi, ' $1="#"');
    html = html.replace(/\\ssrcdoc\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)/gi, '');
    return html;
  };
  const __esc = typeof __escIn === 'function'
    ? __escIn
    : (v) => v == null
      ? ''
      : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');`.trim();
    const fnBody = [componentHelpers, propsShim, effectivePropsCode, scopedBody]
      .filter(Boolean)
      .join('\n  ');
    const compiled = `function ${funcName}(${PROPS_BAG_NAME}, __escIn) {\n  ${fnBody}\n  return __html;\n}`;

    compiledComponentCache.set(fileName, compiled);
    return compiled;
  }

  function collectComponentMap(
    componentImports: Record<string, string>,
    importerAbsPath?: string,
  ): Map<string, string> {
    const componentNames = new Map<string, string>();
    for (const [pascalName, fileName] of Object.entries(componentImports)) {
      ensureCompiled(fileName, importerAbsPath);
      componentNames.set(pascalName, fileName);
    }
    return componentNames;
  }

  function getActionPropNames(fileName: string): Set<string> {
    return componentActionCache.get(fileName) ?? new Set<string>();
  }

  function collectStyles(componentNames: Map<string, string>): string[] {
    const styles: string[] = [];
    for (const fileName of componentNames.values()) {
      const css = componentStyleCache.get(fileName);
      if (css) styles.push(css);
    }
    return styles;
  }

  function resolveActionProps(
    template: string,
    componentNames: Map<string, string>,
    shouldInclude?: (fnName: string) => boolean,
  ): Set<string> {
    const names = new Set<string>();
    const templateAst = parseKuratchiTemplate(template);
    const tags = getKuratchiTemplateTags(templateAst);
    for (const [pascalName, compFileName] of componentNames.entries()) {
      const actionPropNames = getActionPropNames(compFileName);
      for (const tag of tags) {
        if (tag.name !== pascalName || tag.closing) continue;
        for (const propName of actionPropNames) {
          const fnName = getKuratchiTemplateAttributeExpression(tag, propName);
          if (!fnName || !/^[A-Za-z_$][\w$]*$/.test(fnName)) continue;
          if (!shouldInclude || shouldInclude(fnName)) {
            names.add(fnName);
          }
        }
      }
    }
    return names;
  }

  function getCompiledComponents(opts?: {
    resolveCompiledImportPath?: (
      origPath: string,
      importerDir: string,
      outFileDir: string,
    ) => string;
    allocateModuleId?: () => string;
    pushImport?: (statement: string) => void;
    outFileDir?: string;
  }): string[] {
    if (
      !opts?.resolveCompiledImportPath ||
      !opts.allocateModuleId ||
      !opts.pushImport ||
      !opts.outFileDir
    ) {
      return Array.from(compiledComponentCache.values());
    }

    const finalized: string[] = [];
    for (const [fileName, compiled] of compiledComponentCache.entries()) {
      const meta = componentImportCache.get(fileName);
      if (!meta || meta.serverImports.length === 0) {
        finalized.push(compiled);
        continue;
      }

      const importerDir = path.dirname(meta.filePath);
      const importDecls: string[] = [];
      for (const statement of meta.serverImports) {
        const parsed = parseImportStatement(statement);
        if (!parsed.moduleSpecifier) continue;

        const importPath = opts.resolveCompiledImportPath(
          parsed.moduleSpecifier,
          importerDir,
          opts.outFileDir,
        );
        const moduleId = opts.allocateModuleId();
        opts.pushImport(`import * as ${moduleId} from '${importPath}';`);

        for (const binding of parsed.bindings) {
          const accessExpr = binding.imported === 'default'
            ? `${moduleId}.default`
            : `${moduleId}.${binding.imported}`;
          importDecls.push(`const ${binding.local} = ${accessExpr};`);
        }

        if (parsed.namespaceImport) {
          importDecls.push(`const ${parsed.namespaceImport} = ${moduleId};`);
        }
      }

      if (importDecls.length === 0) {
        finalized.push(compiled);
        continue;
      }

      const injected = compiled.replace(
        /(\{\n)/,
        `$1  ${importDecls.join('\n  ')}\n  `,
      );
      finalized.push(injected);
    }

    return finalized;
  }

  function getResolvedFiles(): Map<string, string> {
    return resolvedFiles;
  }

  function getServerImports(): string[] {
    const imports = new Set<string>();
    for (const meta of componentImportCache.values()) {
      for (const statement of meta.serverImports) {
        imports.add(statement);
      }
    }
    return Array.from(imports);
  }

  function collectServerRpcBindings(componentNames: Map<string, string>): ComponentServerRpcBinding[] {
    const bindings = new Map<string, ComponentServerRpcBinding>();
    const visited = new Set<string>();

    function collectFrom(fileName: string) {
      if (visited.has(fileName)) return;
      visited.add(fileName);
      const meta = componentImportCache.get(fileName);
      if (!meta) return;
      for (const binding of meta.serverRpcBindings) {
        const key = `${binding.sourceKey}::${binding.importedName}::${binding.localName}`;
        if (!bindings.has(key)) bindings.set(key, binding);
      }
      for (const subFileName of meta.subComponentFileNames) {
        collectFrom(subFileName);
      }
    }

    for (const fileName of componentNames.values()) {
      collectFrom(fileName);
    }
    return Array.from(bindings.values());
  }

  return {
    ensureCompiled,
    collectComponentMap,
    getActionPropNames,
    collectStyles,
    resolveActionProps,
    getCompiledComponents,
    getServerImports,
    collectServerRpcBindings,
    getResolvedFiles,
  };
}
