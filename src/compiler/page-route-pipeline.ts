import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  analyzeClientTemplateReactivity,
  buildClientTemplateRenderersExpression,
  compileTemplate,
  splitTemplateRenderSections,
} from './template.js';
import { analyzeRouteBuild, emitRouteObject, type RouteRpcBinding } from './route-pipeline.js';
import { linkRouteServerImports } from './import-linking.js';
import type { ComponentCompiler } from './component-pipeline.js';
import type { ClientModuleCompiler } from './client-module-pipeline.js';
import type { RouteStatePlan } from './route-state-pipeline.js';

function createHashForComponentRpc(sourceKey: string, importedName: string): string {
  return crypto.createHash('sha1').update(`${sourceKey}:${importedName}`).digest('hex').slice(0, 12);
}

export function compilePageRoute(opts: {
  pattern: string;
  routeIndex: number;
  projectDir: string;
  isDev: boolean;
  routeState: RouteStatePlan;
  routeFilePath: string;
  componentCompiler: ComponentCompiler;
  clientModuleCompiler: ClientModuleCompiler;
  assetsPrefix: string;
  resolveCompiledImportPath: (origPath: string, importerDir: string, outFileDir: string) => string;
  allocateModuleId: () => string;
  pushImport: (statement: string) => void;
}): string {
  const outFileDir = path.join(opts.projectDir, '.koze');
  const actionAliasTargets = opts.routeState.mergedParsed.actionAliases.map((alias) => alias.target);
  const routeModuleLinkPlan = linkRouteServerImports({
    routeServerImportEntries: opts.routeState.routeServerImportEntries,
    routeClientImportEntries: opts.routeState.routeClientImportEntries,
    actionFunctions: [...opts.routeState.mergedParsed.actionFunctions, ...actionAliasTargets],
    pollFunctions: opts.routeState.mergedParsed.pollFunctions,
    dataGetQueries: opts.routeState.mergedParsed.dataGetQueries,
    routeScriptReferenceSource: opts.routeState.routeScriptReferenceSource,
    resolveCompiledImportPath: opts.resolveCompiledImportPath,
    outFileDir,
    allocateModuleId: opts.allocateModuleId,
  });
  for (const statement of routeModuleLinkPlan.importStatements) {
    opts.pushImport(statement);
  }
  opts.routeState.routeImportDecls.push(...routeModuleLinkPlan.routeImportDecls);

  const fnToModule = routeModuleLinkPlan.fnToModule;
  const routeComponentNames = opts.componentCompiler.collectComponentMap(
    opts.routeState.mergedParsed.componentImports,
    opts.routeFilePath,
  );

  for (const routeFnName of opts.componentCompiler.resolveActionProps(
    opts.routeState.effectiveTemplate,
    routeComponentNames,
    (fnName) => fnName in fnToModule,
  )) {
    if (!opts.routeState.mergedParsed.actionFunctions.includes(routeFnName)) {
      opts.routeState.mergedParsed.actionFunctions.push(routeFnName);
    }
  }

  const dataVarsSet = new Set(opts.routeState.mergedParsed.dataVars);
  const actionNames = new Set(
    opts.routeState.mergedParsed.actionFunctions.filter((fnName) => fnName in fnToModule || dataVarsSet.has(fnName)),
  );
  const augmentedActionNames = new Set(opts.routeState.mergedParsed.actionAliases.map((alias) => alias.name));
  for (const name of augmentedActionNames) actionNames.add(name);

  const rpcNameMap = new Map<string, string>();
  let rpcCounter = 0;
  for (const fnName of opts.routeState.mergedParsed.pollFunctions) {
    if (!rpcNameMap.has(fnName)) {
      rpcNameMap.set(fnName, `rpc_${opts.routeIndex}_${rpcCounter++}`);
    }
  }
  for (const query of opts.routeState.mergedParsed.dataGetQueries) {
    if (!rpcNameMap.has(query.fnName)) {
      rpcNameMap.set(query.fnName, `rpc_${opts.routeIndex}_${rpcCounter++}`);
    }
    query.rpcId = rpcNameMap.get(query.fnName)!;
  }

  const clientRouteRegistry = opts.clientModuleCompiler.createRouteRegistry(
    opts.routeIndex,
    opts.routeState.routeBrowserImportEntries,
  );
  const awaitQueryBindings = new Map(
    opts.routeState.mergedParsed.dataGetQueries
      .filter((query) => !!query.awaitExpr)
      .map((query) => [query.awaitExpr!, { asName: query.asName, rpcId: query.rpcId || rpcNameMap.get(query.fnName) || query.fnName }]),
  );
  const renderSections = splitTemplateRenderSections(opts.routeState.effectiveTemplate);
  const importerDir = path.dirname(opts.routeFilePath);
  const clientScriptBody = opts.routeState.mergedParsed.clientScriptRaw ?? '';
  const clientTemplatePlan = analyzeClientTemplateReactivity(
    opts.routeState.effectiveTemplate,
    clientScriptBody,
    routeComponentNames,
    actionNames,
    rpcNameMap,
    { clientRouteRegistry, awaitQueryBindings, importerDir, augmentedActionNames },
  );
  const renderBody = compileTemplate(
    renderSections.bodyTemplate,
    routeComponentNames,
    actionNames,
    rpcNameMap,
    {
      emitCall: '__emit',
      clientRouteRegistry,
      awaitQueryBindings,
      importerDir,
      clientScriptBody,
      liveTemplateNames: clientTemplatePlan.reactiveNames,
      augmentedActionNames,
    },
  );
  const renderHeadBody = compileTemplate(
    renderSections.headTemplate,
    routeComponentNames,
    actionNames,
    rpcNameMap,
    {
      clientRouteRegistry,
      awaitQueryBindings,
      importerDir,
      clientScriptBody,
      liveTemplateNames: clientTemplatePlan.reactiveNames,
      augmentedActionNames,
    },
  );
  const clientEntryAsset = clientRouteRegistry.buildEntryAsset();
  const clientServerProxyBindings = clientRouteRegistry.getServerProxyBindings();
  const clientServerProxyModules = new Map<string, string>();
  const extraRpcBindings: RouteRpcBinding[] = [];
  const seenClientServerRpcIds = new Set<string>();
  const componentServerRpcModules = new Map<string, string>();

  for (const binding of opts.componentCompiler.collectServerRpcBindings(routeComponentNames)) {
    const moduleKey = `${binding.sourceKey}::${binding.moduleSpecifier}`;
    let moduleId = componentServerRpcModules.get(moduleKey);
    if (!moduleId) {
      moduleId = opts.allocateModuleId();
      componentServerRpcModules.set(moduleKey, moduleId);
      const importPath = opts.resolveCompiledImportPath(binding.moduleSpecifier, binding.importerDir, outFileDir);
      opts.pushImport(`import * as ${moduleId} from '${importPath}';`);
    }
    const rpcId = `rpc_component_${createHashForComponentRpc(binding.sourceKey, binding.importedName)}`;
    if (!seenClientServerRpcIds.has(rpcId)) {
      seenClientServerRpcIds.add(rpcId);
      extraRpcBindings.push({
        name: `${binding.moduleSpecifier}:${binding.importedName}`,
        rpcId,
        expression: binding.importedName === 'default' ? `${moduleId}.default` : `${moduleId}.${binding.importedName}`,
        schemaExpression: binding.importedName === 'default'
          ? 'undefined'
          : `${moduleId}.schemas?.[${JSON.stringify(binding.importedName)}]`,
      });
    }
  }

  for (const binding of clientServerProxyBindings) {
    const moduleKey = `${binding.importerDir}::${binding.moduleSpecifier}`;
    let moduleId = clientServerProxyModules.get(moduleKey);
    if (!moduleId) {
      moduleId = opts.allocateModuleId();
      clientServerProxyModules.set(moduleKey, moduleId);
      const importPath = opts.resolveCompiledImportPath(binding.moduleSpecifier, binding.importerDir, outFileDir);
      opts.pushImport(`import * as ${moduleId} from '${importPath}';`);
    }

    if (!seenClientServerRpcIds.has(binding.rpcId)) {
      seenClientServerRpcIds.add(binding.rpcId);
      extraRpcBindings.push({
        name: `${binding.moduleSpecifier}:${binding.importedName}`,
        rpcId: binding.rpcId,
        expression: binding.importedName === 'default' ? `${moduleId}.default` : `${moduleId}.${binding.importedName}`,
        schemaExpression: binding.importedName === 'default'
          ? 'undefined'
          : `${moduleId}.schemas?.[${JSON.stringify(binding.importedName)}]`,
      });
    }
  }

  // RFC 0002: Bundle client script with RPC stubs for $server/ imports
  // Only trigger RFC 0002 bundling when there are actual $server/ imports
  // (serverRpcImports contains import lines from $server/, not regular server imports)
  const mergedParsed = opts.routeState.mergedParsed;
  let rfc0002ClientScriptAsset: { assetName: string } | null = null;
  
  const clientTemplateRenderersExpr = buildClientTemplateRenderersExpression(clientTemplatePlan.blockRenderers);
  const needsClientScriptAsset = !!mergedParsed.clientScriptRaw && (
    mergedParsed.serverRpcImports.length > 0 ||
    clientTemplatePlan.reactiveNames.size > 0 ||
    !!clientTemplateRenderersExpr
  );

  if (needsClientScriptAsset) {
    const ssrAwaitVars = mergedParsed.ssrAwaitCalls.map((call) => call.varName);
    rfc0002ClientScriptAsset = opts.clientModuleCompiler.bundleClientScript({
      routeIndex: opts.routeIndex,
      clientScriptRaw: clientScriptBody,
      serverRpcImports: mergedParsed.serverRpcImports,
      serverRpcFunctions: mergedParsed.serverRpcFunctions,
      ssrAwaitVars,
      routeFilePath: opts.routeFilePath,
      devAliases: mergedParsed.devAliases,
      requestImports: mergedParsed.requestImports,
      isDev: opts.isDev,
      reactiveNames: clientTemplatePlan.reactiveNames,
      blockRenderersExpr: clientTemplateRenderersExpr,
      actionAliases: mergedParsed.actionAliases,
    });
    
    // Register RPC bindings for $server/ functions so they can be called from client
    for (const fnName of mergedParsed.serverRpcFunctions) {
      const rpcId = `rpc_${opts.routeIndex}_server_${fnName}`;
      if (!seenClientServerRpcIds.has(rpcId)) {
        seenClientServerRpcIds.add(rpcId);
        // Find the module that exports this function
        const moduleId = fnToModule[fnName];
        if (moduleId) {
          extraRpcBindings.push({
            name: `$server/:${fnName}`,
            rpcId,
            expression: `${moduleId}.${fnName}`,
            schemaExpression: `${moduleId}.schemas?.[${JSON.stringify(fnName)}]`,
          });
        }
      }
    }
  }

  // Use RFC 0002 client script if available, otherwise fall back to existing client module
  const clientModuleHref = rfc0002ClientScriptAsset 
    ? `${opts.assetsPrefix}${rfc0002ClientScriptAsset.assetName}`
    : (clientEntryAsset ? `${opts.assetsPrefix}${clientEntryAsset.assetName}` : null);

  const routePlan = analyzeRouteBuild({
    pattern: opts.pattern,
    renderBody,
    renderHeadBody,
    isDev: opts.isDev,
    parsed: opts.routeState.mergedParsed,
    fnToModule,
    rpcNameMap,
    extraRpcBindings,
    componentStyles: opts.componentCompiler.collectStyles(routeComponentNames),
    clientModuleHref,
  });

  return emitRouteObject(routePlan);
}
