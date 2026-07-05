/**
 * Compiler — scans a project's routes/ directory, parses `.koze`
 * files, and generates a single Worker entry point.
 */

import { parseFile } from './parser.js';
import {
  readApiShieldRouteMetadata,
  writeApiShieldOpenApi,
  type ApiShieldOptions,
} from './api-shield.js';
import { compileAssets } from './asset-pipeline.js';
import { compileApiRoute } from './api-route-pipeline.js';
import { createClientModuleCompiler } from './client-module-pipeline.js';
import { createComponentCompiler } from './component-pipeline.js';
import { isCssFile, processCss, type CssConfigEntry } from './css-pipeline.js';
import type { SecurityConfigEntry } from './compiler-shared.js';
import {
  discoverContainerFiles,
  discoverAgentFiles,
  discoverPipelineFiles,
  discoverSandboxFiles,
  discoverQueueConsumerFiles,
  discoverWorkflowFiles,
} from './convention-discovery.js';
import { discoverDurableObjects, generateHandlerProxy } from './durable-object-pipeline.js';
import { compileErrorPages } from './error-page-pipeline.js';
import { compileLayoutPlan, finalizeLayoutPlan, type LayoutBuildPlan } from './layout-pipeline.js';
import { compilePageRoute } from './page-route-pipeline.js';
import { writePipelineArtifacts } from './pipeline-artifacts.js';
import { discoverRoutes as discoverRoutesPipeline } from './route-discovery.js';
import { prepareRootLayoutSource } from './root-layout-pipeline.js';
import { generateRoutesModule as generateRoutesModulePipeline } from './routes-module-pipeline.js';
import { assembleRouteState } from './route-state-pipeline.js';
import { createServerModuleCompiler } from './server-module-pipeline.js';
import { compileTemplate } from './template.js';
import { appendInlineSourceMap, createGeneratedSourceMap } from './source-map.js';
import {
  buildCompatEntrypointSource,
  buildWorkerEntrypointSource,
  resolveMiddlewareImportPath as resolveMiddlewareImportPathPipeline,
} from './worker-output-pipeline.js';
import { syncWranglerConfig as syncWranglerConfigPipeline } from './wrangler-sync.js';
import { filePathToPattern } from '../runtime/router.js';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { RouteFile } from './route-discovery.js';

// Public compiler primitives — consumed by `koze`'s own CLI and by
// external orchestrators (e.g. `@kuratchi/vite`) so there is a single
// source of truth for template parsing and codegen.
export {
  generateApiShieldOpenApi,
  readApiShieldRouteMetadata,
  resolveApiShieldOptions,
  writeApiShieldOpenApi,
} from './api-shield.js';
export type {
  ApiShieldOptions,
  ApiShieldRouteMetadata,
  ResolvedApiShieldOptions,
} from './api-shield.js';
export {
  parseFile,
  rewriteAugmentedActionInitializersForClient,
  stripAugmentImportSpecifier,
  stripAugmentedActionDeclarations,
  stripTopLevelImports,
} from './parser.js';
export type { AugmentedActionAlias, ParsedFile } from './parser.js';
export {
  KuratchiCompilerError,
  createCompilerError,
  isKuratchiCompilerError,
} from './diagnostics.js';
export type {
  KuratchiCompilerDiagnostic,
  KuratchiCompilerErrorCode,
} from './diagnostics.js';
export {
  validateKuratchiAst,
  validateKuratchiTemplate,
} from './validation.js';
export {
  appendInlineSourceMap,
  createGeneratedSourceMap,
  createKuratchiSourceMap,
} from './source-map.js';
export type { KuratchiSourceMap } from './source-map.js';
export { parseKuratchiSfc } from './sfc-parser.js';
export {
  findKuratchiSlotSpan,
  getKuratchiTemplateAttribute,
  getKuratchiTemplateAttributeExpression,
  getKuratchiTemplateExpressions,
  getKuratchiTemplateRawBlocks,
  getKuratchiTemplateTags,
  parseKuratchiTemplate,
  replaceKuratchiSlot,
  stripKuratchiTemplateCompilerIgnoredNodes,
  stripKuratchiTemplateComments,
  stripKuratchiTemplateNodes,
  stripKuratchiTemplateRawBlocks,
} from './template-parser.js';
export type {
  KuratchiFileAst,
  KuratchiFileKind,
  KuratchiScriptAst,
  KuratchiSourceSpan,
  KuratchiTemplateAst,
  KuratchiTemplateAttributeAst,
  KuratchiTemplateCommentAst,
  KuratchiTemplateExpressionAst,
  KuratchiTemplateNode,
  KuratchiTemplateRawBlockAst,
  KuratchiTemplateTagAst,
  KuratchiTemplateTextAst,
} from './ast.js';
export type {
  KuratchiAwaitQueryIr,
  KuratchiImportIr,
  KuratchiModuleIr,
  KuratchiRequestImportIr,
  KuratchiSsrAwaitIr,
} from './ir.js';
export {
  analyzeClientTemplateReactivity,
  buildClientTemplateRenderersExpression,
  compileTemplate,
  generateRenderFunction,
  splitTemplateRenderSections,
} from './template.js';
export type {
  TemplateRenderSections,
  CompileTemplateOptions,
} from './template.js';
export {
  VIRTUAL_MODULE_MAP,
  VIRTUAL_MODULE_NAMES,
  isKuratchiVirtualModule,
  resolveKuratchiVirtualModule,
  getKuratchiModuleName,
  buildVirtualModuleTypeDeclarations,
} from './virtual-modules.js';
export {
  rewriteImportedFunctionCalls,
  rewriteWorkerEnvAliases,
  buildDevAliasDeclarations,
  buildSegmentedScriptBody,
  buildSelectiveSsrPrelude,
  buildClientScopeMount,
  transformReactiveClientScript,
} from './script-transform.js';
export type { RouteScriptSegment } from './script-transform.js';
export {
  discoverContainerFiles,
  discoverSandboxFiles,
  discoverQueueConsumerFiles,
  discoverPipelineFiles,
  discoverWorkflowFiles,
  discoverAgentFiles,
} from './convention-discovery.js';
export {
  DEFAULT_CONTENT_DIR,
  discoverContentEntries,
  discoverContentGroupNames,
} from './content-discovery.js';
export type { DiscoveredContentEntry } from './content-discovery.js';
// `createComponentCompiler` is part of the compiler's public surface
// so external orchestrators (e.g. `@kuratchi/vite`) can compile
// `<Card />`, `<Badge />`, etc. the same way the legacy CLI does.
// One source of truth for `.koze` component compilation.
export { createComponentCompiler } from './component-pipeline.js';
export type { ComponentCompiler } from './component-pipeline.js';
export { buildBridgeScriptSource, buildReactiveRuntimeScriptTag } from './root-layout-pipeline.js';
export { discoverDurableObjects } from './durable-object-pipeline.js';
export { writePipelineArtifacts } from './pipeline-artifacts.js';
export { syncWranglerConfig } from './wrangler-sync.js';
export { writeAppTypes, generateAppTypes } from './type-generator.js';
export type { GenerateTypesOptions } from './type-generator.js';
export type {
  PipelineConfigEntry,
  PipelineR2DataCatalogSinkConfig,
  PipelineSchemaConfig,
  PipelineSchemaField,
  PipelineSinkConfig,
} from './compiler-shared.js';
export type {
  WranglerSyncEntry,
  ContainerSyncEntry,
  QueueSyncEntry,
  PipelineSyncEntry,
  WranglerSyncConfig,
} from './wrangler-sync.js';

const FRAMEWORK_PACKAGE_NAME = getFrameworkPackageName();
const RUNTIME_CONTEXT_IMPORT = `${FRAMEWORK_PACKAGE_NAME}/runtime/context.js`;
const RUNTIME_DO_IMPORT = `${FRAMEWORK_PACKAGE_NAME}/runtime/do.js`;
const RUNTIME_SCHEMA_IMPORT = `${FRAMEWORK_PACKAGE_NAME}/runtime/schema.js`;
// Runtime template imported by the generated `.koze/routes.ts`
// module the legacy CLI emits. The template was previously housed in
// `@kuratchi/wrangler/runtime/generated-worker.ts`; it now lives
// alongside the rest of the framework runtime in
// `@kuratchi/koze/runtime/generated-worker.ts` so the Vite plugin
// path can also use it without resurrecting a separate package.
const RUNTIME_WORKER_IMPORT = `${FRAMEWORK_PACKAGE_NAME}/runtime/generated-worker.js`;
const SOURCE_EXTENSIONS = ['.koze', '.kuratchi'] as const;

function resolveSourceSibling(dir: string, basename: string): string | null {
  const candidates = SOURCE_EXTENSIONS
    .map((ext) => path.join(dir, basename + ext))
    .filter((candidate) => fs.existsSync(candidate));
  if (candidates.length > 1) {
    throw new Error(`[koze] Both ${basename}.koze and ${basename}.kuratchi exist in ${dir}. Keep one source file for this route.`);
  }
  return candidates[0] ?? null;
}

function getFrameworkPackageName(): string {
  try {
    const raw = fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8');
    const parsed = JSON.parse(raw) as { name?: string };
    return parsed.name || '@kuratchi/koze';
  } catch {
    return '@kuratchi/koze';
  }
}

/**
 * UI configuration values passed through to the layout pipeline.
 * Replaces the old `kuratchi.config.ts` `ui:` block — orchestrators
 * (the Vite plugin and legacy CLI consumers) supply
 * these directly so the framework no longer reads a config file.
 */
export interface CompileUiOptions {
  /** Initial color scheme; one of `'dark' | 'light' | 'system'` (default: 'dark'). */
  theme?: string;
  /** Corner-radius style (`'default' | 'none' | 'full'`, default: 'default'). */
  radius?: string;
  /** Optional theme CSS string to inline into `<head>` (e.g. `@kuratchi/ui` theme). */
  themeCss?: string | null;
}

export interface CompileOptions {
  /** Absolute path to the project root */
  projectDir: string;
  /** Relative path to the routes directory. Defaults to `src/routes`. */
  routesDir?: string;
  /** API route discovery configuration. */
  api?: {
    /** Relative path to the API routes directory. Defaults to `src/routes/api`. */
    root?: string;
    /** URL prefix for API routes. Defaults to `/api`. */
    urlPrefix?: string;
  };
  /** Override path for routes.ts (default: .koze/routes.ts). worker.ts is always co-located. */
  outFile?: string;
  /** Whether this is a dev build (sets __koze_DEV__ global) */
  isDev?: boolean;
  /** Static assets URL prefix (default: '/assets/'). Must start and end with `/`. */
  assetsPrefix?: string;
  /** UI options for the layout pipeline. */
  ui?: CompileUiOptions;
  /** CSS pipeline options (Tailwind, plugins, minify). */
  css?: CssConfigEntry;
  /** Response security headers (CSP / HSTS / Permissions-Policy). */
  security?: SecurityConfigEntry;
  /** Generate an OpenAPI document for Cloudflare API Shield Schema Validation. Defaults to enabled. */
  apiShield?: boolean | ApiShieldOptions;
}

const DEFAULT_ASSETS_PREFIX = '/assets/';

function normalizeAssetsPrefix(value: string | undefined): string {
  if (!value) return DEFAULT_ASSETS_PREFIX;
  let prefix = value;
  if (!prefix.startsWith('/')) prefix = '/' + prefix;
  if (!prefix.endsWith('/')) prefix += '/';
  return prefix;
}

function defaultSecurity(): SecurityConfigEntry {
  return {
    contentSecurityPolicy: null,
    strictTransportSecurity: null,
    permissionsPolicy: null,
  };
}

export interface CompiledRoute {
  /** Route pattern (e.g., '/todos', '/blog/:slug') */
  pattern: string;
  /** Relative file path from routes/ (e.g., 'todos', 'blog/[slug]') */
  filePath: string;
  /** Whether it has a load function */
  hasLoad: boolean;
  /** Whether it has actions */
  hasActions: boolean;
  /** Whether it has RPC functions */
  hasRpc: boolean;
}

/**
 * Pre-read all route files and their layouts in parallel for better I/O performance.
 * Returns a Map from file path to content.
 */
async function preReadFiles(
  routesDir: string,
  routeFiles: RouteFile[],
): Promise<Map<string, string>> {
  const filesToRead = new Set<string>();

  // Collect all unique files to read
  for (const rf of routeFiles) {
    filesToRead.add(rf.absPath);
    for (const layout of rf.layouts) {
      filesToRead.add(path.join(routesDir, layout));
    }
  }

  // Also include root layout if it exists
  const rootLayout = resolveSourceSibling(routesDir, 'layout');
  if (rootLayout) {
    filesToRead.add(rootLayout);
  }

  // Read all files in parallel
  const entries = await Promise.all(
    Array.from(filesToRead).map(async (filePath) => {
      const content = await fsp.readFile(filePath, 'utf-8');
      return [filePath, content] as const;
    }),
  );

  return new Map(entries);
}

/**
 * Compile a project's src/routes/ into .koze/routes.ts
 *
 * The generated module exports { app } — an object with a fetch() method
 * that handles routing, load functions, form actions, and rendering.
 * Returns the path to .koze/worker.ts — the stable wrangler entry point that
 * re-exports everything from routes.ts (default fetch handler + named DO class exports).
 * No src/index.ts is needed in user projects.
 */
export async function compile(options: CompileOptions): Promise<string> {
  const { projectDir } = options;
  const srcDir = path.join(projectDir, 'src');
  const routesDir = path.join(projectDir, options.routesDir ?? path.join('src', 'routes'));
  const apiDir = path.join(projectDir, options.api?.root ?? path.join('src', 'routes', 'api'));

  if (!fs.existsSync(routesDir)) {
    throw new Error(`Routes directory not found: ${routesDir}`);
  }

  // Discover page routes from `routesDir` and API routes from the configured API root.
  const routeFiles = discoverRoutesPipeline(routesDir, {
    apiDir,
    apiUrlPrefix: options.api?.urlPrefix,
  });
  const apiShieldRoutes = routeFiles
    .filter((routeFile) => routeFile.type === 'api')
    .map((routeFile) => readApiShieldRouteMetadata({
      projectDir,
      pattern: filePathToPattern(routeFile.name),
      fullPath: routeFile.absPath,
    }));

  // Pre-read all files in parallel for better I/O performance
  const fileContents = await preReadFiles(routesDir, routeFiles);
  const componentCompiler = createComponentCompiler({
    projectDir,
    srcDir,
    isDev: !!options.isDev,
  });
  const clientModuleCompiler = createClientModuleCompiler({
    projectDir,
    srcDir,
  });
  const assetsPrefix = normalizeAssetsPrefix(options.assetsPrefix);

  // App layout: src/routes/layout.koze (convention — wraps all routes automatically)
  const layoutFile = resolveSourceSibling(routesDir, 'layout');
  let compiledLayout: string | null = null;
  let layoutPlan: LayoutBuildPlan | null = null;
  if (layoutFile && fileContents.has(layoutFile)) {
    const layoutImportSource = fileContents.get(layoutFile)!;
    const uiOptions = options.ui ?? {};
    const uiConfigValues = (uiOptions.theme || uiOptions.radius)
      ? { theme: uiOptions.theme ?? 'dark', radius: uiOptions.radius ?? 'default' }
      : null;
    const source = prepareRootLayoutSource({
      source: layoutImportSource,
      isDev: !!options.isDev,
      themeCss: uiOptions.themeCss ?? null,
      uiConfigValues,
    });
    layoutPlan = compileLayoutPlan({
      renderSource: source,
      importSource: layoutImportSource,
      layoutFile: layoutFile!,
      isDev: !!options.isDev,
      componentCompiler,
      clientModuleCompiler,
      assetsPrefix,
      clientScopeId: 'layout_root',
    });
    compiledLayout = layoutPlan.compiledLayout;
  }

  // Custom error pages: src/routes/NNN.koze (e.g. 404.koze, 500.koze, 401.koze, 403.koze)
  // Only compiled if the user explicitly creates them — otherwise the framework's built-in default is used
  const compiledErrorPages = compileErrorPages(routesDir);

  // Response security headers — supplied by the orchestrator (Vite plugin
  // or legacy CLI). Defaults to no headers; enable them via plugin options
  // when needed.
  const securityConfig = options.security ?? defaultSecurity();

  // Auto-discover Durable Objects from .do.ts files
  const { config: doConfig, handlers: doHandlers } = discoverDurableObjects(srcDir);
  // Auto-discover convention-based worker class files (no config needed)
  const containerConfig = discoverContainerFiles(projectDir);
  const sandboxConfig = discoverSandboxFiles(projectDir);
  const workflowConfig = discoverWorkflowFiles(projectDir);
  const queueConsumerConfig = discoverQueueConsumerFiles(projectDir);
  const pipelineConfig = discoverPipelineFiles(projectDir);
  writePipelineArtifacts({ projectDir, pipelines: pipelineConfig, writeFile: writeIfChanged });
  const agentConfig = discoverAgentFiles(projectDir);
  // Containers and sandboxes are Durable Objects under the hood — they need a
  // `durable_objects.bindings` entry and (for SQLite-backed classes) a
  // `migrations[].new_sqlite_classes` entry. Collapse them into one list that
  // feeds both the worker class re-exports and the wrangler-sync DO pipeline.
  const containerizedClassEntries = [...containerConfig, ...sandboxConfig];

  // Generate handler proxy modules in .koze/do/ for auto-discovered .do.ts files
  const doProxyDir = path.join(projectDir, '.koze', 'do');
  const doHandlerProxyPaths = new Map<string, string>();
  const registerDoProxyPath = (sourceAbsNoExt: string, proxyAbsNoExt: string) => {
    doHandlerProxyPaths.set(sourceAbsNoExt.replace(/\\/g, '/'), proxyAbsNoExt.replace(/\\/g, '/'));
  };
  if (doHandlers.length > 0) {
    if (!fs.existsSync(doProxyDir)) fs.mkdirSync(doProxyDir, { recursive: true });

    for (const handler of doHandlers) {
      const proxyCode = generateHandlerProxy(handler, {
        projectDir,
        runtimeDoImport: RUNTIME_DO_IMPORT,
        runtimeSchemaImport: RUNTIME_SCHEMA_IMPORT,
      });
      const proxyFile = path.join(doProxyDir, handler.fileName + '.ts');
      const proxyFileDir = path.dirname(proxyFile);
      if (!fs.existsSync(proxyFileDir)) fs.mkdirSync(proxyFileDir, { recursive: true });
      writeIfChanged(proxyFile, proxyCode);
      const handlerAbsNoExt = handler.absPath.replace(/\\/g, '/').replace(/\.ts$/, '');
      const proxyAbsNoExt = proxyFile.replace(/\\/g, '/').replace(/\.ts$/, '');
      registerDoProxyPath(handlerAbsNoExt, proxyAbsNoExt);
    }
  }
  const serverModuleCompiler = createServerModuleCompiler({
    projectDir,
    srcDir,
    doHandlerProxyPaths,
    isDev: options.isDev ?? false,
    writeFile: writeIfChanged,
  });

  // Parse and compile each route
  const compiledRoutes: string[] = [];
  const routePatterns: string[] = [];
  const allImports: string[] = [];

  let moduleCounter = 0;

  // Layout server import resolution ?" resolve non-component imports to module IDs
  let isLayoutAsync = false;
  let compiledLayoutActions: string | null = null;
  if (layoutPlan) {
    const finalizedLayout = finalizeLayoutPlan({
      plan: layoutPlan,
      layoutFile: layoutFile!,
      projectDir,
      resolveCompiledImportPath: serverModuleCompiler.resolveCompiledImportPath,
      allocateModuleId: () => `__m${moduleCounter++}`,
      pushImport: (statement) => allImports.push(statement),
      componentCompiler,
    });
    compiledLayout = finalizedLayout.compiledLayout;
    compiledLayoutActions = finalizedLayout.compiledLayoutActions;
    isLayoutAsync = finalizedLayout.isLayoutAsync;
  }

  for (let i = 0; i < routeFiles.length; i++) {
    const rf = routeFiles[i];
    const fullPath = rf.absPath;
    const pattern = filePathToPattern(rf.name);
    routePatterns.push(pattern);

    // -- API route (*.ts / *.js under api root) --
    if (rf.type === 'api') {
      compiledRoutes.push(compileApiRoute({
        pattern,
        fullPath,
        projectDir,
        transformModule: serverModuleCompiler.transformModule,
        allocateModuleId: () => `__m${moduleCounter++}`,
        pushImport: (statement) => allImports.push(statement),
      }));
      continue;
    }

    // -- Page route (index.koze) --
    const source = fileContents.get(fullPath) ?? fs.readFileSync(fullPath, 'utf-8');
    const parsed = parseFile(source, { kind: 'route', filePath: fullPath });
    const routeState = assembleRouteState({
      parsed,
      fullPath,
      routesDir,
      layoutRelativePaths: rf.layouts,
      fileContents,
    });

    compiledRoutes.push(compilePageRoute({
      pattern,
      routeIndex: i,
      projectDir,
      isDev: !!options.isDev,
      routeState,
      routeFilePath: fullPath,
      componentCompiler,
      clientModuleCompiler,
      assetsPrefix,
      resolveCompiledImportPath: serverModuleCompiler.resolveCompiledImportPath,
      allocateModuleId: () => `__m${moduleCounter++}`,
      pushImport: (statement) => allImports.push(statement),
    }));
  }

  // Scan src/assets/ for static files to embed (recursive)
  const compiledAssets = [
    ...compileAssets(path.join(srcDir, 'assets')),
    ...clientModuleCompiler.getCompiledAssets(),
  ];

  // Collect only the components that were actually imported by routes
  const compiledComponents = componentCompiler.getCompiledComponents({
    resolveCompiledImportPath: serverModuleCompiler.resolveCompiledImportPath,
    allocateModuleId: () => `__m${moduleCounter++}`,
    pushImport: (statement) => allImports.push(statement),
    outFileDir: path.join(projectDir, '.koze'),
  });

  // Generate the routes module
  const rawMiddlewareImportPath = resolveMiddlewareImportPathPipeline(projectDir);
  let middlewareImportPath: string | undefined;
  if (rawMiddlewareImportPath) {
    // Resolve the middleware file's absolute path and pass it through the server module compiler
    // so that $durable-objects/* and other project imports get rewritten to their proxies.
    const middlewareAbs = path.resolve(path.join(projectDir, '.koze'), rawMiddlewareImportPath);
    const transformedMiddlewarePath = serverModuleCompiler.transformModule(middlewareAbs);
    const outFile = options.outFile ?? path.join(projectDir, '.koze', 'routes.ts');
    middlewareImportPath = serverModuleCompiler.toModuleSpecifier(outFile, transformedMiddlewarePath);
  }
  const hasMiddleware = !!middlewareImportPath;
  const output = generateRoutesModulePipeline({
    projectDir,
    serverImports: allImports,
    compiledRoutes,
    routePatterns,
    compiledLayout,
    compiledComponents,
    compiledAssets,
    compiledErrorPages,
    securityConfig,
    doConfig,
    doHandlers,
    workflowConfig,
    pipelineConfig,
    isDev: options.isDev ?? false,
    isLayoutAsync,
    compiledLayoutActions,
    hasMiddleware,
    middlewareImportPath,
    assetsPrefix,
    runtimeContextImport: RUNTIME_CONTEXT_IMPORT,
    runtimeDoImport: RUNTIME_DO_IMPORT,
    runtimeSchemaImport: RUNTIME_SCHEMA_IMPORT,
    runtimeWorkerImport: RUNTIME_WORKER_IMPORT,
  });
  const sourceMapSources = Array.from(fileContents.entries()).map(([sourcePath, source]) => ({
    sourcePath,
    source,
  }));
  const sourceMapAnchors = routeFiles.map((routeFile) => ({
    generatedNeedle: JSON.stringify(filePathToPattern(routeFile.name)),
    sourcePath: routeFile.absPath,
  }));
  const mappedOutput = sourceMapSources.length > 0
    ? appendInlineSourceMap(
      output,
      createGeneratedSourceMap({
        generatedCode: output,
        file: 'routes.ts',
        sources: sourceMapSources,
        anchors: sourceMapAnchors,
      }),
    )
    : output;

  // Write to .koze/routes.ts
  const outFile = options.outFile ?? path.join(projectDir, '.koze', 'routes.ts');
  const outDir = path.dirname(outFile);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  writeIfChanged(outFile, mappedOutput);
  writeIfChanged(path.join(outDir, 'routes.js'), buildCompatEntrypointSource('./routes.ts'));

  // Generate .koze/worker.ts — the stable wrangler entry point.
  // routes.ts already exports the default fetch handler and all named DO classes;
  // worker.ts explicitly re-exports them so wrangler.jsonc can reference a
  // stable filename while routes.ts is freely regenerated.
  // If user has src/index.ts with a default export, merge it with the generated worker
  // to support scheduled, queue, and other Cloudflare Worker handlers.
  const userIndexFile = path.join(srcDir, 'index.ts');
  const hasUserIndex = fs.existsSync(userIndexFile) && 
    fs.readFileSync(userIndexFile, 'utf-8').includes('export default');
  const transformedUserIndexFile = hasUserIndex ? serverModuleCompiler.transformModule(userIndexFile) : undefined;
  // Re-export every convention-discovered class from the generated worker so wrangler can
  // reach each one by `class_name`. Sandboxes flow through the same path as containers —
  // no `hasSandbox` flag, no `export { Sandbox } from '@cloudflare/sandbox'` special case.
  const transformedWorkerClassEntries = [...agentConfig, ...containerizedClassEntries, ...workflowConfig].map((entry) => ({
    ...entry,
    file: serverModuleCompiler.transformModule(path.join(projectDir, entry.file)),
  }));
  const transformedQueueConsumers = queueConsumerConfig.map((entry) => ({
    ...entry,
    file: serverModuleCompiler.transformModule(path.join(projectDir, entry.file)),
  }));
  const workerFile = path.join(outDir, 'worker.ts');
  writeIfChanged(workerFile, buildWorkerEntrypointSource({
    projectDir,
    outDir,
    doClassNames: doConfig.map((entry) => entry.className),
    workerClassEntries: transformedWorkerClassEntries,
    queueConsumers: transformedQueueConsumers,
    userIndexFile: transformedUserIndexFile,
  }));
  writeIfChanged(path.join(outDir, 'worker.js'), buildCompatEntrypointSource('./worker.ts'));

  // CSS pipeline configuration — supplied by the orchestrator. When
  // omitted, the pipeline runs without Tailwind/plugins (passthrough copy
  // with optional minification).
  const cssConfig = options.css ?? null;

  // Auto-sync wrangler.jsonc with auto-discovered workflow/container/DO classes.
  // Also sync the static assets directory when src/assets/ exists, so Cloudflare Workers
  // serves them natively without any manual wrangler.jsonc edits from the user.
  const srcAssetsDir = path.join(srcDir, 'assets');
  let syncedAssetsDirectory: string | undefined;
  if (fs.existsSync(srcAssetsDir)) {
    // Mirror src/assets/ into .koze/public/<prefix>/ so Cloudflare serves them at the
    // correct URL (e.g. /assets/app.css) — the directory passed to wrangler is the parent.
    // CSS files are processed through the CSS pipeline (Tailwind, minification).
    const prefixSegment = assetsPrefix.replace(/^\/|\/$/g, ''); // '/assets/' -> 'assets'
    const publicDir = path.join(projectDir, '.koze', 'public');
    const publicAssetsDir = prefixSegment ? path.join(publicDir, prefixSegment) : publicDir;
    await copyDirIfChanged(srcAssetsDir, publicAssetsDir, {
      projectDir,
      cssConfig,
      isDev: options.isDev ?? false,
    });
    syncedAssetsDirectory = path.relative(projectDir, publicDir).replace(/\\/g, '/');
  }

  // Convert agent config to DO config format (agents are Durable Objects)
  const agentDoConfig = agentConfig.map((entry) => {
    const binding = entry.className.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
    return { binding, className: entry.className };
  });
  // Containers and sandboxes are also Durable Objects — feed them into the DO sync
  // so `durable_objects.bindings` and `migrations[].new_sqlite_classes` are kept current
  // without any manual wrangler.jsonc edits.
  const containerDoConfig = containerizedClassEntries.map((entry) => ({
    binding: entry.binding,
    className: entry.className,
  }));

  syncWranglerConfigPipeline({
    projectDir,
    config: {
      workflows: workflowConfig,
      containers: containerizedClassEntries.map((entry) => ({
        binding: entry.binding,
        className: entry.className,
        image: entry.image,
        instanceType: entry.instanceType,
        maxInstances: entry.maxInstances,
        sqlite: entry.sqlite,
      })),
      durableObjects: [...doConfig, ...agentDoConfig, ...containerDoConfig],
      queues: queueConsumerConfig.map((q) => ({ binding: q.binding, queueName: q.queueName })),
      pipelines: pipelineConfig.map((p) => ({ binding: p.binding, pipeline: p.pipeline })),
      assetsDirectory: syncedAssetsDirectory,
    },
    writeFile: writeIfChanged,
  });

  writeApiShieldOpenApi({
    projectDir,
    routes: apiShieldRoutes,
    options: options.apiShield,
    writeFile: writeIfChanged,
  });

  return workerFile;
}

// ?"??"? Helpers ?"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"??"?

/**
 * Write a file only if its content has changed.
 * Prevents unnecessary filesystem events that would retrigger wrangler's file watcher.
 */
function writeIfChanged(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing === content) return;
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

interface CopyDirOptions {
  projectDir: string;
  cssConfig: CssConfigEntry | null;
  isDev: boolean;
}

/**
 * Recursively copy files from src to dest, processing CSS files through the CSS pipeline.
 * Used to mirror src/assets/ into .koze/public/ for Cloudflare Workers Static Assets.
 */
async function copyDirIfChanged(src: string, dest: string, options: CopyDirOptions): Promise<void> {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirIfChanged(srcPath, destPath, options);
      continue;
    }

    // Process CSS files through the CSS pipeline
    if (isCssFile(srcPath)) {
      const srcContent = fs.readFileSync(srcPath, 'utf-8');
      const result = await processCss({
        filePath: srcPath,
        content: srcContent,
        projectDir: options.projectDir,
        cssConfig: options.cssConfig,
        isDev: options.isDev,
      });

      const destContent = fs.existsSync(destPath) ? fs.readFileSync(destPath, 'utf-8') : null;
      if (destContent !== result.css) {
        fs.writeFileSync(destPath, result.css, 'utf-8');
      }
      continue;
    }

    // Copy non-CSS files as-is
    const srcBuf = fs.readFileSync(srcPath);
    const destBuf = fs.existsSync(destPath) ? fs.readFileSync(destPath) : null;
    if (!destBuf || !srcBuf.equals(destBuf)) {
      fs.writeFileSync(destPath, srcBuf);
    }
  }
}
