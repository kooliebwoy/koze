import * as path from 'node:path';
import { parseFile, stripTopLevelImports, type ParsedFile } from './parser.js';
import { compileTemplate } from './template.js';
import type { ComponentCompiler } from './component-pipeline.js';
import type { ClientModuleCompiler } from './client-module-pipeline.js';
import { parseImportStatement, parseNamedImportBindings, type RouteImportEntry } from './import-linking.js';
import { buildDevAliasDeclarations, rewriteImportedFunctionCalls } from './script-transform.js';
import { findKuratchiSlotSpan, parseKuratchiTemplate, replaceKuratchiSlot } from './template-parser.js';

export interface LayoutBuildPlan {
  compiledLayout: string | null;
  componentNames: Map<string, string>;
  importParsed: ParsedFile | null;
}

const HEAD_MARKER = '<!--__KURATCHI_HEAD__-->';

function injectLayoutHeadPlaceholder(source: string, marker: string): string {
  const lower = source.toLowerCase();
  const idx = lower.lastIndexOf('</head>');
  if (idx !== -1) {
    return source.slice(0, idx) + `${marker}\n` + source.slice(idx);
  }
  return `${marker}\n${source}`;
}

function buildLayoutBrowserImportEntries(importParsed: ParsedFile, layoutFile: string): RouteImportEntry[] {
  const importerDir = path.dirname(layoutFile);
  const entries = new Map<string, RouteImportEntry>();
  const addEntry = (line: string) => {
    if (!entries.has(line)) {
      entries.set(line, { line, importerDir });
    }
  };

  for (const line of importParsed.routeClientImports) {
    addEntry(line);
  }

  for (const line of importParsed.serverImports) {
    const parsed = parseImportStatement(line);
    if (parsed.moduleSpecifier?.startsWith('$lib/')) {
      addEntry(line);
    }
  }

  return Array.from(entries.values());
}

function stripPreparedTopScript(source: string, importParsed: ParsedFile): string {
  const script = importParsed.ir.sfc.script;
  if (!script) return source;
  const rawScript = importParsed.ir.sfc.source.slice(script.span.start, script.span.end);
  return source.replace(rawScript, '').trim();
}

export function compileLayoutPlan(opts: {
  renderSource: string;
  importSource: string;
  layoutFile: string;
  isDev: boolean;
  componentCompiler: ComponentCompiler;
  clientModuleCompiler?: ClientModuleCompiler;
  assetsPrefix?: string;
  clientScopeId?: string;
}): LayoutBuildPlan {
  const importParsed = parseFile(opts.importSource, { kind: 'layout', filePath: opts.layoutFile });
  let renderTemplateSource = stripPreparedTopScript(opts.renderSource, importParsed);
  const componentNames = opts.componentCompiler.collectComponentMap(
    importParsed.componentImports,
    opts.layoutFile,
  );
  const browserImportEntries = opts.clientModuleCompiler
    ? buildLayoutBrowserImportEntries(importParsed, opts.layoutFile)
    : [];
  const clientRouteRegistry = opts.clientModuleCompiler && opts.clientScopeId && browserImportEntries.length > 0
    ? opts.clientModuleCompiler.createRegistry(opts.clientScopeId, browserImportEntries)
    : null;
  const hasClientBindings = !!clientRouteRegistry?.hasBindings();
  const hasLayoutScript = !!(importParsed.script && (componentNames.size > 0 || importParsed.hasLoad));

  if (hasLayoutScript || hasClientBindings) {
    let layoutTemplate = injectLayoutHeadPlaceholder(renderTemplateSource, '{@raw __layoutHead}');
    layoutTemplate = replaceKuratchiSlot(parseKuratchiTemplate(layoutTemplate), '{@raw __content}');

    const layoutActionNames = new Set(importParsed.actionFunctions);
    for (const fnName of opts.componentCompiler.resolveActionProps(importParsed.template, componentNames)) {
      layoutActionNames.add(fnName);
    }

    const layoutRenderBody = compileTemplate(
      layoutTemplate,
      componentNames,
      layoutActionNames,
      undefined,
      { clientRouteRegistry: clientRouteRegistry ?? undefined },
    );
    const layoutComponentStyles = opts.componentCompiler.collectStyles(componentNames);
    let finalLayoutBody = layoutRenderBody;
    if (layoutComponentStyles.length > 0) {
      const lines = layoutRenderBody.split('\n');
      const styleLines = layoutComponentStyles.map((css) => `__parts.push(\`${css}\\n\`);`);
      finalLayoutBody = [lines[0], ...styleLines, ...lines.slice(1)].join('\n');
    }

    let layoutScriptBody = importParsed.script
      ? stripTopLevelImports(importParsed.script)
      : '';
    const layoutDevDecls = buildDevAliasDeclarations(importParsed.devAliases, opts.isDev);
    layoutScriptBody = [layoutDevDecls, layoutScriptBody].filter(Boolean).join('\n');
    const clientEntryAsset = clientRouteRegistry?.buildEntryAsset() ?? null;
    const clientModuleHref = clientEntryAsset && opts.assetsPrefix
      ? `${opts.assetsPrefix}${clientEntryAsset.assetName}`
      : null;
    const layoutHeadAssignment = clientModuleHref
      ? `const __layoutHead = __head + ${JSON.stringify(`<script type="module" src="${clientModuleHref}"></script>\n`)};`
      : `const __layoutHead = __head;`;

    return {
      compiledLayout: `function __layout(__content, __head = '') {
  const __esc = (v) => { if (v == null) return ''; return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); };
  ${layoutHeadAssignment}
  ${layoutScriptBody ? layoutScriptBody + '\n  ' : ''}${finalLayoutBody}
  return __html;
}`,
      componentNames,
      importParsed,
    };
  }

  const layoutSource = injectLayoutHeadPlaceholder(renderTemplateSource, HEAD_MARKER);
  const layoutSourceAst = parseKuratchiTemplate(layoutSource);
  const slotSpan = findKuratchiSlotSpan(layoutSourceAst);
  if (!slotSpan) {
    throw new Error('layout.koze must contain <slot></slot>');
  }

  const escLayout = (source: string) => source.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, () => '\\$');
  const before = escLayout(layoutSource.slice(0, slotSpan.start));
  const after = escLayout(layoutSource.slice(slotSpan.end));

  return {
    compiledLayout: `const __layoutBefore = \`${before}\`;\nconst __layoutAfter = \`${after}\`;\nfunction __layout(content, head = '') {\n  return (__layoutBefore + content + __layoutAfter).replace(${JSON.stringify(HEAD_MARKER)}, head);\n}`,
    componentNames,
    importParsed,
  };
}

export function finalizeLayoutPlan(opts: {
  plan: LayoutBuildPlan;
  layoutFile: string;
  projectDir: string;
  resolveCompiledImportPath: (origPath: string, importerDir: string, outFileDir: string) => string;
  allocateModuleId: () => string;
  pushImport: (statement: string) => void;
  componentCompiler: ComponentCompiler;
}): {
  compiledLayout: string | null;
  compiledLayoutActions: string | null;
  isLayoutAsync: boolean;
} {
  let compiledLayout = opts.plan.compiledLayout;
  let compiledLayoutActions: string | null = null;

  if (compiledLayout && opts.plan.importParsed && opts.plan.importParsed.serverImports.length > 0) {
    const layoutFileDir = path.dirname(opts.layoutFile);
    const outFileDir = path.join(opts.projectDir, '.koze');
    const layoutFnToModule: Record<string, string> = {};

    for (const imp of opts.plan.importParsed.serverImports) {
      const pathMatch = imp.match(/from\s+['"]([^'"]+)['"]/);
      if (!pathMatch) continue;
      const origPath = pathMatch[1];
      const importPath = opts.resolveCompiledImportPath(origPath, layoutFileDir, outFileDir);

      const moduleId = opts.allocateModuleId();
      opts.pushImport(`import * as ${moduleId} from '${importPath}';`);

      for (const binding of parseNamedImportBindings(imp)) {
        layoutFnToModule[binding.local] = moduleId;
      }
      const starMatch = imp.match(/import\s*\*\s*as\s+(\w+)/);
      if (starMatch) {
        layoutFnToModule[starMatch[1]] = moduleId;
      }
    }

    compiledLayout = rewriteImportedFunctionCalls(compiledLayout, layoutFnToModule);

    const layoutActionNames = new Set(opts.plan.importParsed.actionFunctions);
    for (const fnName of opts.componentCompiler.resolveActionProps(opts.plan.importParsed.template, opts.plan.componentNames)) {
      layoutActionNames.add(fnName);
    }

    if (layoutActionNames.size > 0) {
      const actionEntries = Array.from(layoutActionNames)
        .filter((fnName) => fnName in layoutFnToModule)
        .map((fnName) => `'${fnName}': ${layoutFnToModule[fnName]}.${fnName}`)
        .join(', ');
      if (actionEntries) {
        compiledLayoutActions = `{ ${actionEntries} }`;
      }
    }
  }

  const isLayoutAsync = !!(compiledLayout && /\bawait\b/.test(compiledLayout));
  if (compiledLayout && isLayoutAsync) {
    compiledLayout = compiledLayout.replace(/^function __layout\(/, 'async function __layout(');
  }

  return {
    compiledLayout,
    compiledLayoutActions,
    isLayoutAsync,
  };
}
