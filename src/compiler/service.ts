import {
  componentFuncName,
  toSafeIdentifier,
} from './compiler-shared.js';
import {
  CLIENT_BRIDGE_HASH,
  DEFAULT_APP_SHELL,
  NESTED_LAYOUT_VIRTUAL_PREFIX,
  extractClientFragments,
  generateContentModule,
  generateRpcMapModule,
  generateRpcStubModule,
  generateWorkerModule,
  layoutModuleHash,
  leadingScriptHash,
  routeModuleHash,
  resolveServerFile,
  transformAppFile,
  transformLayoutFile,
  transformRouteFile,
} from './application-pipeline.js';
import { createComponentCompiler } from './component-pipeline.js';
import { discoverContentEntries } from './content-discovery.js';
import {
  isKozeVirtualModule,
  resolveKozeVirtualModule,
} from './virtual-modules.js';
import {
  parseFile,
  rewriteAugmentedActionInitializersForClient,
  stripAugmentImportSpecifier,
  stripAugmentedActionDeclarations,
  stripTopLevelImports,
} from './parser.js';
import {
  buildBridgeScriptSource,
  buildReactiveRuntimeScriptTag,
} from './root-layout-pipeline.js';
import {
  buildClientScopeMount,
  buildSelectiveSsrPrelude,
  transformReactiveClientScript,
} from './script-transform.js';
import { createServerModuleCompiler } from './server-module-pipeline.js';
import { parseKuratchiSfc } from './sfc-parser.js';
import {
  appendInlineSourceMap,
  createGeneratedSourceMap,
  createKuratchiSourceMap,
} from './source-map.js';
import {
  analyzeClientTemplateReactivity,
  buildClientTemplateRenderersExpression,
  compileTemplate,
} from './template.js';
import { writeAppTypes } from './type-generator.js';
import {
  analyzeProject,
  isApiRouteFile,
  isPageRouteFile,
  isRouteFile,
  isRouteLayoutFile,
  layoutChainForRoute,
} from './project-analysis.js';

/**
 * The only compiler boundary consumed by build integrations.
 *
 * The compiler owns Koze language semantics and project analysis. Vite owns
 * module-graph orchestration. Cloudflare configuration and product lifecycle
 * are deliberately outside this boundary.
 */
export function createKozeCompiler() {
  return Object.freeze({
    application: Object.freeze({
      CLIENT_BRIDGE_HASH,
      DEFAULT_APP_SHELL,
      NESTED_LAYOUT_VIRTUAL_PREFIX,
      extractClientFragments,
      generateContentModule,
      generateRpcMapModule,
      generateRpcStubModule,
      generateWorkerModule,
      layoutModuleHash,
      leadingScriptHash,
      routeModuleHash,
      resolveServerFile,
      transformAppFile,
      transformLayoutFile,
      transformRouteFile,
    }),
    language: Object.freeze({
      parseFile,
      parseSfc: parseKuratchiSfc,
      compileTemplate,
      analyzeClientTemplateReactivity,
      buildClientTemplateRenderersExpression,
      rewriteAugmentedActionInitializersForClient,
      stripAugmentImportSpecifier,
      stripAugmentedActionDeclarations,
      stripTopLevelImports,
      buildSelectiveSsrPrelude,
      buildClientScopeMount,
      transformReactiveClientScript,
      buildBridgeScriptSource,
      buildReactiveRuntimeScriptTag,
      isKozeVirtualModule,
      resolveKozeVirtualModule,
      componentFuncName,
      toSafeIdentifier,
    }),
    project: Object.freeze({
      analyzeProject,
      createComponentCompiler,
      createServerModuleCompiler,
      discoverContentEntries,
      isApiRouteFile,
      isPageRouteFile,
      isRouteFile,
      isRouteLayoutFile,
      layoutChainForRoute,
      writeAppTypes,
    }),
    output: Object.freeze({
      appendInlineSourceMap,
      createGeneratedSourceMap,
      createSourceMap: createKuratchiSourceMap,
    }),
  });
}

export type KozeCompiler = ReturnType<typeof createKozeCompiler>;
