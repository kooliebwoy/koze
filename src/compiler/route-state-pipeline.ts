import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildKuratchiModuleIr, type KuratchiModuleIr } from './ir.js';
import { parseFile, stripTopLevelImports, type ParsedFile } from './parser.js';
import type { RouteImportEntry } from './import-linking.js';
import { parseKuratchiTemplate, replaceKuratchiSlot } from './template-parser.js';

export interface RouteScriptSegment {
  script: string;
  dataVars: string[];
}

export interface MergedRouteParsed extends ParsedFile {
  scriptImportDecls: string[];
  scriptSegments: RouteScriptSegment[];
}

export interface RouteStatePlan {
  effectiveTemplate: string;
  routeImportDecls: string[];
  routeScriptReferenceSource: string;
  routeServerImportEntries: RouteImportEntry[];
  routeClientImportEntries: RouteImportEntry[];
  routeBrowserImportEntries: RouteImportEntry[];
  mergedParsed: MergedRouteParsed;
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

function isLibImport(line: string): boolean {
  return /\bfrom\s+['"]\$lib\//.test(line);
}

export function assembleRouteState(opts: {
  parsed: ParsedFile;
  fullPath: string;
  routesDir: string;
  layoutRelativePaths: string[];
  fileContents?: Map<string, string>;
}): RouteStatePlan {
  const { parsed, fullPath, routesDir, layoutRelativePaths, fileContents } = opts;

  let effectiveTemplate = parsed.ir.template.source;
  const routeScriptParts: string[] = [];
  const routeScriptSegments: RouteScriptSegment[] = [];
  const routeServerImportEntries: RouteImportEntry[] = parsed.ir.imports.server.map((imp) => ({
    line: imp.line,
    importerDir: path.dirname(fullPath),
  }));
  const routeClientImportEntries: RouteImportEntry[] = parsed.ir.imports.client.map((imp) => ({
    line: imp.line,
    importerDir: path.dirname(fullPath),
  }));
  const routeBrowserImportEntries: RouteImportEntry[] = [
    ...parsed.ir.imports.routeClient.map((imp) => ({
      line: imp.line,
      importerDir: path.dirname(fullPath),
    })),
    // Include $lib/ imports for browser bundling
    ...parsed.ir.imports.server.filter((imp) => isLibImport(imp.line)).map((imp) => ({
      line: imp.line,
      importerDir: path.dirname(fullPath),
    })),
    ...parsed.ir.imports.client.filter((imp) => isLibImport(imp.line)).map((imp) => ({
      line: imp.line,
      importerDir: path.dirname(fullPath),
    })),
  ];
  const mergedActionFunctions = [...parsed.ir.template.actionFunctions];
  const mergedDataVars = [...parsed.ir.script.dataVars];
  const mergedPollFunctions = [...parsed.ir.template.serverFunctions];
  const mergedDataGetQueries = parsed.ir.template.awaitQueries.map((query) => ({ ...query }));
  const mergedComponentImports: Record<string, string> = { ...parsed.ir.components.imports };
  const mergedWorkerEnvAliases = [...parsed.ir.script.workerEnvAliases];
  const mergedDevAliases = [...parsed.ir.script.devAliases];
  const mergedRequestImports = [...parsed.ir.imports.request];
  const mergedRouteClientImports = parsed.ir.imports.routeClient.map((imp) => imp.line);
  const mergedRouteClientImportBindings = [...parsed.ir.imports.routeClientBindings];
  
  // RFC 0002: Track client-first script model fields
  const mergedServerRpcImports = parsed.ir.rpc.serverImports.map((imp) => imp.line);
  const mergedServerRpcFunctions = [...parsed.ir.rpc.serverFunctions];
  const mergedActionAliases = parsed.ir.rpc.actionAliases.map((alias) => ({ ...alias }));
  const mergedSsrAwaitCalls = [...parsed.ir.rpc.ssrAwaitCalls];
  const mergedClientNpmImports = parsed.ir.rpc.clientNpmImports.map((imp) => imp.line);

  for (const layoutRelPath of layoutRelativePaths) {
    if (layoutRelPath === 'layout.koze' || layoutRelPath === 'layout.kuratchi') continue;

    const layoutPath = path.join(routesDir, layoutRelPath);
    const layoutSource = fileContents?.get(layoutPath) ?? (fs.existsSync(layoutPath) ? fs.readFileSync(layoutPath, 'utf-8') : null);
    if (!layoutSource) continue;
    const layoutParsed = parseFile(layoutSource, { kind: 'layout', filePath: layoutPath });
    if (layoutParsed.loadFunction) {
      throw new Error(`${layoutRelPath} cannot export load(); nested layouts currently share the child route load lifecycle.`);
    }

    if (!layoutParsed.ir.template.ast.nodes.some((node) => node.kind === 'tag' && node.name === 'slot' && !node.closing)) {
      throw new Error(`${layoutRelPath} must contain <slot></slot> or <slot />`);
    }

    if (layoutParsed.ir.script.normalized) {
      routeScriptParts.push(layoutParsed.ir.script.normalized);
      routeScriptSegments.push({ script: layoutParsed.ir.script.normalized, dataVars: [...layoutParsed.ir.script.dataVars] });
    }

    for (const imp of layoutParsed.ir.imports.server) {
      routeServerImportEntries.push({ line: imp.line, importerDir: path.dirname(layoutPath) });
    }
    for (const imp of layoutParsed.ir.imports.client) {
      routeClientImportEntries.push({ line: imp.line, importerDir: path.dirname(layoutPath) });
    }
    for (const imp of layoutParsed.ir.imports.routeClient) {
      routeBrowserImportEntries.push({ line: imp.line, importerDir: path.dirname(layoutPath) });
      pushUnique(mergedRouteClientImports, imp.line);
    }
    // Include $lib/ imports from layout for browser bundling
    for (const imp of layoutParsed.ir.imports.server.filter((candidate) => isLibImport(candidate.line))) {
      routeBrowserImportEntries.push({ line: imp.line, importerDir: path.dirname(layoutPath) });
    }
    for (const imp of layoutParsed.ir.imports.client.filter((candidate) => isLibImport(candidate.line))) {
      routeBrowserImportEntries.push({ line: imp.line, importerDir: path.dirname(layoutPath) });
    }
    for (const binding of layoutParsed.ir.imports.routeClientBindings) {
      pushUnique(mergedRouteClientImportBindings, binding);
    }
    for (const fnName of layoutParsed.ir.template.actionFunctions) {
      pushUnique(mergedActionFunctions, fnName);
    }
    for (const varName of layoutParsed.ir.script.dataVars) {
      pushUnique(mergedDataVars, varName);
    }
    for (const fnName of layoutParsed.ir.template.serverFunctions) {
      pushUnique(mergedPollFunctions, fnName);
    }
    for (const query of layoutParsed.ir.template.awaitQueries) {
      if (!mergedDataGetQueries.some((existing) => existing.asName === query.asName)) {
        mergedDataGetQueries.push({ ...query });
      }
    }
    for (const [pascalName, fileName] of Object.entries(layoutParsed.ir.components.imports)) {
      mergedComponentImports[pascalName] = fileName;
    }
    for (const alias of layoutParsed.ir.script.workerEnvAliases) {
      pushUnique(mergedWorkerEnvAliases, alias);
    }
    for (const alias of layoutParsed.ir.script.devAliases) {
      pushUnique(mergedDevAliases, alias);
    }
    for (const imp of layoutParsed.ir.imports.request) {
      if (!mergedRequestImports.some(r => r.alias === imp.alias)) {
        mergedRequestImports.push({ ...imp });
      }
    }
    
    // RFC 0002: Merge client-first script model fields from layouts
    for (const imp of layoutParsed.ir.rpc.serverImports) {
      pushUnique(mergedServerRpcImports, imp.line);
    }
    for (const fn of layoutParsed.ir.rpc.serverFunctions) {
      pushUnique(mergedServerRpcFunctions, fn);
    }
    for (const alias of layoutParsed.ir.rpc.actionAliases) {
      if (!mergedActionAliases.some((existing) => existing.name === alias.name)) {
        mergedActionAliases.push({ ...alias });
      }
    }
    for (const call of layoutParsed.ir.rpc.ssrAwaitCalls) {
      if (!mergedSsrAwaitCalls.some((c) => c.varName === call.varName)) {
        mergedSsrAwaitCalls.push({ ...call });
      }
    }
    for (const imp of layoutParsed.ir.rpc.clientNpmImports) {
      pushUnique(mergedClientNpmImports, imp.line);
    }

    effectiveTemplate = replaceKuratchiSlot(layoutParsed.ir.template.ast, effectiveTemplate);
  }

  if (parsed.ir.script.normalized) {
    routeScriptParts.push(parsed.ir.script.normalized);
    routeScriptSegments.push({ script: parsed.ir.script.normalized, dataVars: [...parsed.ir.script.dataVars] });
  }

  const routeImportDecls: string[] = [];
  const routeScriptReferenceSource = [
    ...routeScriptParts.map((script) => stripTopLevelImports(script)),
    parsed.ir.script.loadFunction || '',
  ].join('\n');

  const mergedParsed: MergedRouteParsed = {
    ...parsed,
    ir: null as unknown as KuratchiModuleIr,
    template: effectiveTemplate,
    script: routeScriptParts.length > 0 ? routeScriptParts.join('\n\n') : parsed.script,
    serverImports: routeServerImportEntries.map((entry) => entry.line),
    clientImports: routeClientImportEntries.map((entry) => entry.line),
    routeClientImports: mergedRouteClientImports,
    routeClientImportBindings: mergedRouteClientImportBindings,
    actionFunctions: mergedActionFunctions,
    dataVars: mergedDataVars,
    componentImports: mergedComponentImports,
    pollFunctions: mergedPollFunctions,
    dataGetQueries: mergedDataGetQueries,
    workerEnvAliases: mergedWorkerEnvAliases,
    devAliases: mergedDevAliases,
    requestImports: mergedRequestImports,
    scriptImportDecls: routeImportDecls,
    scriptSegments: routeScriptSegments,
    // RFC 0002: Client-first script model fields
    serverRpcImports: mergedServerRpcImports,
    serverRpcFunctions: mergedServerRpcFunctions,
    actionAliases: mergedActionAliases,
    ssrAwaitCalls: mergedSsrAwaitCalls,
    clientNpmImports: mergedClientNpmImports,
  };
  mergedParsed.ir = buildKuratchiModuleIr(mergedParsed, {
    ...parsed.ir.sfc,
    source: effectiveTemplate,
    template: parseKuratchiTemplate(effectiveTemplate),
  });

  return {
    effectiveTemplate,
    routeImportDecls,
    routeScriptReferenceSource,
    routeServerImportEntries,
    routeClientImportEntries,
    routeBrowserImportEntries,
    mergedParsed,
  };
}
