import type { ParsedFile } from './parser.js';
import {
  stripAugmentImportSpecifier,
  stripAugmentedActionDeclarations,
  stripTopLevelImports,
} from './parser.js';
import {
  buildDevAliasDeclarations,
  buildSegmentedScriptBody,
  rewriteImportedFunctionCalls,
  rewriteWorkerEnvAliases,
  type RouteScriptSegment,
} from './script-transform.js';

export interface RouteDataGetQuery {
  fnName: string;
  argsExpr: string;
  asName: string;
  key?: string;
  rpcId?: string;
}

export interface RouteActionBinding {
  name: string;
  expression: string;
}

export interface RouteRpcBinding {
  name: string;
  rpcId: string;
  expression: string;
  schemaExpression: string;
}

export interface RouteLoadPlan {
  mode: 'none' | 'explicit' | 'generated';
  code: string;
  returnVars: string[];
  scriptUsesAwait: boolean;
}

export interface RouteRenderPlan {
  prelude: string;
  dataVars: string[];
  body: string;
  headBody: string;
  componentStyles: string[];
  clientModuleHref?: string | null;
}

export interface RouteBuildPlan {
  pattern: string;
  load: RouteLoadPlan;
  actions: RouteActionBinding[];
  rpc: RouteRpcBinding[];
  render: RouteRenderPlan;
}

export interface RoutePipelineParsedFile extends ParsedFile {
  scriptImportDecls?: string[];
  scriptSegments?: RouteScriptSegment[];
}

// RFC 0002: SSR await call info
export interface SsrAwaitCall {
  varName: string;
  fnName: string;
  argsExpr: string;
}

interface AnalyzeRouteOptions {
  pattern: string;
  renderBody: string;
  renderHeadBody: string;
  isDev: boolean;
  parsed: RoutePipelineParsedFile;
  fnToModule: Record<string, string>;
  rpcNameMap?: Map<string, string>;
  extraRpcBindings?: RouteRpcBinding[];
  componentStyles: string[];
  clientModuleHref?: string | null;
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractDeclaredConstName(statement: string): string | null {
  const match = statement.trim().match(/^const\s+([A-Za-z_$][\w$]*)\s*=/);
  return match ? match[1] : null;
}

function stripExtractedSsrAwaitDeclarations(scriptBody: string, ssrAwaitCalls: SsrAwaitCall[]): string {
  if (!scriptBody || ssrAwaitCalls.length === 0) return scriptBody;

  let output = scriptBody;
  for (const call of ssrAwaitCalls) {
    const pattern = new RegExp(
      `(^|\\n)\\s*(?:const|let|var)\\s+${escapeRegExp(call.varName)}\\s*=\\s*await\\b[\\s\\S]*?;(?=\\n|$)`,
      'g',
    );
    output = output.replace(pattern, (_, prefix: string) => prefix || '');
  }

  return output;
}

/**
 * RFC 0002: Build code for SSR await calls to $server/ functions.
 * These are top-level await calls in the client script that execute at SSR time.
 */
function buildSsrAwaitCallsCode(opts: {
  ssrAwaitCalls: SsrAwaitCall[];
  fnToModule: Record<string, string>;
}): string {
  const lines: string[] = [];

  for (const call of opts.ssrAwaitCalls) {
    const moduleId = opts.fnToModule[call.fnName];
    const qualifiedFn = moduleId ? `${moduleId}.${call.fnName}` : call.fnName;
    const argsExpr = call.argsExpr ? call.argsExpr : '';

    lines.push(`const ${call.varName} = await ${qualifiedFn}(${argsExpr});`);
  }

  return lines.join('\n');
}

function buildLoadQueryStateCode(opts: {
  queries: RouteDataGetQuery[];
  fnToModule: Record<string, string>;
  rpcNameMap?: Map<string, string>;
}): string {
  const lines: string[] = [];

  for (const query of opts.queries) {
    const fnName = query.fnName;
    const rpcId = query.rpcId || opts.rpcNameMap?.get(fnName) || fnName;
    const argsExpr = (query.argsExpr || '').trim();
    const asName = query.asName;
    const defaultArgs = argsExpr ? `[${argsExpr}]` : '[]';
    const moduleId = opts.fnToModule[fnName];
    const qualifiedFn = moduleId ? `${moduleId}.${fnName}` : fnName;

    lines.push(`let ${asName} = { state: 'loading', loading: true, error: null, data: null, empty: false, success: false };`);
    lines.push(`const __qOverride_${asName} = __getLocals().__queryOverride;`);
    lines.push(`const __qArgs_${asName} = ${defaultArgs};`);
    lines.push(`const __qShouldRun_${asName} = !__qOverride_${asName} || (__qOverride_${asName}.fn === '${rpcId}' && Array.isArray(__qOverride_${asName}.args) && JSON.stringify(__qOverride_${asName}.args) === JSON.stringify(__qArgs_${asName}));`);
    lines.push(`if (__qShouldRun_${asName}) {`);
    lines.push(`  try {`);
    lines.push(`    const __qData_${asName} = await ${qualifiedFn}(...__qArgs_${asName});`);
    lines.push(`    const __qEmpty_${asName} = Array.isArray(__qData_${asName}) ? __qData_${asName}.length === 0 : (__qData_${asName} == null);`);
    lines.push(`    ${asName} = { state: __qEmpty_${asName} ? 'empty' : 'success', loading: false, error: null, data: __qData_${asName}, empty: __qEmpty_${asName}, success: !__qEmpty_${asName} };`);
    lines.push(`  } catch (err) {`);
    lines.push(`    const __qErr_${asName} = (err && err.message) ? String(err.message) : String(err);`);
    lines.push(`    ${asName} = { state: 'error', loading: false, error: __qErr_${asName}, data: null, empty: false, success: false };`);
    lines.push(`  }`);
    lines.push(`}`);
  }

  return lines.join('\n');
}

function buildGeneratedLoadPlan(opts: {
  pattern: string;
  scriptBody: string;
  scriptUsesAwait: boolean;
  scriptReturnVars: string[];
  queries: RouteDataGetQuery[];
  hasSegmentedScripts: boolean;
  fnToModule: Record<string, string>;
  rpcNameMap?: Map<string, string>;
  ssrAwaitCalls?: SsrAwaitCall[];
  requestImports?: Array<{ exportName: string; alias: string }>;
}): RouteLoadPlan {
  const ssrAwaitCalls = opts.ssrAwaitCalls ?? [];
  const requestImports = opts.requestImports ?? [];
  const loadSections: string[] = [];

  // Inject koze:request variable declarations at the start
  // These map the virtual module exports to __routeParams values
  if (requestImports.length > 0) {
    const requestDecls: string[] = [];
    for (const imp of requestImports) {
      switch (imp.exportName) {
        case 'params':
          // __routeParams IS the params object (passed from runtime as match.params)
          requestDecls.push(`const ${imp.alias} = __routeParams || {};`);
          break;
        case 'url':
          requestDecls.push(`const ${imp.alias} = __routeParams.url;`);
          break;
        case 'pathname':
          requestDecls.push(`const ${imp.alias} = __routeParams.pathname || '';`);
          break;
        case 'searchParams':
          requestDecls.push(`const ${imp.alias} = __routeParams.searchParams || new URLSearchParams();`);
          break;
        case 'slug':
          requestDecls.push(`const ${imp.alias} = __routeParams.slug || '';`);
          break;
        case 'method':
          requestDecls.push(`const ${imp.alias} = __routeParams.method || 'GET';`);
          break;
      }
    }
    if (requestDecls.length > 0) {
      loadSections.push(requestDecls.join('\n'));
    }
  }

  // Include script body if it uses await OR if we have requestImports
  // (because the script may reference params/url/etc from koze:request)
  const hasRequestImports = requestImports.length > 0;
  if (opts.scriptBody && (opts.scriptUsesAwait || hasRequestImports)) {
    loadSections.push(opts.scriptBody);
  }
  if (opts.queries.length > 0) {
    loadSections.push(buildLoadQueryStateCode({
      queries: opts.queries,
      fnToModule: opts.fnToModule,
      rpcNameMap: opts.rpcNameMap,
    }));
  }

  const queryVars = opts.queries.map((query) => query.asName);
  const ssrAwaitVars = ssrAwaitCalls.map((call) => call.varName);
  const returnVars = dedupe([...opts.scriptReturnVars, ...queryVars, ...ssrAwaitVars]);
  const loadLines: string[] = [];
  if (loadSections.length > 0) {
    loadLines.push(loadSections.join('\n'));
  }

  if (returnVars.length > 0) {
    if (opts.hasSegmentedScripts && opts.scriptUsesAwait) {
      const segmentReturnEntries = opts.scriptReturnVars.map((name) => `${name}: __segmentData.${name}`);
      const queryReturnEntries = queryVars
        .filter((name) => !opts.scriptReturnVars.includes(name))
        .map((name) => name);
      const ssrAwaitReturnEntries = ssrAwaitVars
        .filter((name) => !opts.scriptReturnVars.includes(name) && !queryVars.includes(name))
        .map((name) => name);
      loadLines.push(`return { ${[...segmentReturnEntries, ...queryReturnEntries, ...ssrAwaitReturnEntries].join(', ')} };`);
    } else {
      loadLines.push(`return { ${returnVars.join(', ')} };`);
    }
  }

  return {
    mode: 'generated',
    code: `async load(__routeParams = {}) {\n      ${loadLines.join('\n      ')}\n    }`,
    returnVars,
    scriptUsesAwait: opts.scriptUsesAwait || (ssrAwaitCalls.length > 0),
  };
}

function assertRoutePlanInvariants(opts: {
  pattern: string;
  loadReturnVars: string[];
  actionNames: string[];
  queryVars: string[];
}): void {
  const loadReturnSet = new Set(opts.loadReturnVars);
  const leakedActions = opts.actionNames.filter((name) => loadReturnSet.has(name));
  if (leakedActions.length > 0) {
    throw new Error(
      `[koze compiler] ${opts.pattern}\nGenerated load data cannot include action bindings: ${leakedActions.join(', ')}`,
    );
  }

  const reservedQueryNames = opts.queryVars.filter((name) => opts.actionNames.includes(name));
  if (reservedQueryNames.length > 0) {
    throw new Error(
      `[koze compiler] ${opts.pattern}\nQuery aliases cannot collide with action bindings: ${reservedQueryNames.join(', ')}`,
    );
  }
}

export function analyzeRouteBuild(opts: AnalyzeRouteOptions): RouteBuildPlan {
  const { pattern, renderBody, renderHeadBody, isDev, parsed, fnToModule, rpcNameMap, extraRpcBindings, componentStyles, clientModuleHref } = opts;
  const hasFns = Object.keys(fnToModule).length > 0;
  const actionAliasTargets = new Map((parsed.actionAliases ?? []).map((alias) => [alias.name, alias.target]));

  // SECURITY: enforce underscore-prefix-private convention. Any exported server function whose
  // name starts with '_' is treated as module-internal and MUST NOT be reachable from a route
  // (i.e. cannot be an action, await-template query, or implicit RPC). Private helpers can
  // still be imported and called from other server functions — they simply never appear on
  // the route.rpc / route.actions / route.allowedQueries surface.
  const privateReferences: string[] = [];
  for (const name of parsed.actionFunctions) {
    const targetName = actionAliasTargets.get(name) ?? name;
    if (targetName.startsWith('_')) privateReferences.push(`action "${name}"`);
  }
  for (const name of parsed.pollFunctions) {
    if (name.startsWith('_')) privateReferences.push(`await query "${name}"`);
  }
  for (const query of parsed.dataGetQueries) {
    if (query.fnName.startsWith('_')) privateReferences.push(`data-get "${query.fnName}"`);
  }
  if (privateReferences.length > 0) {
    throw new Error(
      `[koze compiler] ${pattern}\n` +
        `Route references private server function(s): ${privateReferences.join(', ')}.\n` +
        `Exports whose name starts with '_' are module-internal and cannot be called from a template.\n` +
        `Rename the export, or call it from another (public) $server function.`,
    );
  }
  const queryDefs = parsed.dataGetQueries ?? [];
  const queryVars = queryDefs.map((query) => query.asName);
  const scriptSegments = (parsed.scriptSegments ?? []).filter((segment) => !!segment.script);
  const hasSegmentedScripts = scriptSegments.length > 1;
  const routeDevDecls = buildDevAliasDeclarations(parsed.devAliases, isDev);
  const routeImportDeclLines = parsed.scriptImportDecls ?? [];
  const routeImportDecls = routeImportDeclLines.join('\n');
  const importedBindingNames = new Set(Object.keys(fnToModule));
  const renderScopeActionNames = new Set(parsed.actionFunctions);
  // Filter out params from render prelude since it comes from data destructuring
  const reservedRenderVars = new Set(['params']);
  const renderImportPrelude = routeImportDeclLines
    .filter((statement) => {
      const declaredName = extractDeclaredConstName(statement);
      if (!declaredName) return true;
      if (renderScopeActionNames.has(declaredName)) return false;
      if (reservedRenderVars.has(declaredName)) return false;
      return true;
    })
    .join('\n');

  let scriptBody = '';
  let renderPreludeSource = '';
  let scriptUsesAwait = false;
  if (hasSegmentedScripts) {
    const combinedScript = scriptSegments.map((segment) => stripTopLevelImports(segment.script)).join('\n');
    scriptUsesAwait = /\bawait\b/.test(combinedScript);
    scriptBody = buildSegmentedScriptBody({
      segments: scriptSegments,
      fnToModule,
      importDecls: routeImportDecls,
      workerEnvAliases: parsed.workerEnvAliases,
      devAliases: parsed.devAliases,
      isDev,
      asyncMode: scriptUsesAwait,
    });
    renderPreludeSource = buildSegmentedScriptBody({
      segments: scriptSegments,
      fnToModule,
      importDecls: renderImportPrelude,
      workerEnvAliases: parsed.workerEnvAliases,
      devAliases: parsed.devAliases,
      isDev,
      asyncMode: false,
    });
  } else {
    const strippedScriptBody = parsed.script
      ? stripAugmentedActionDeclarations(
        stripAugmentImportSpecifier(stripTopLevelImports(parsed.script)),
        parsed.actionAliases,
      )
      : '';
    scriptBody = [routeDevDecls, routeImportDecls, strippedScriptBody].filter(Boolean).join('\n');
    renderPreludeSource = [routeDevDecls, renderImportPrelude, strippedScriptBody].filter(Boolean).join('\n');
    scriptBody = rewriteImportedFunctionCalls(scriptBody, fnToModule);
    scriptBody = rewriteWorkerEnvAliases(scriptBody, parsed.workerEnvAliases);
    renderPreludeSource = rewriteImportedFunctionCalls(renderPreludeSource, fnToModule);
    renderPreludeSource = rewriteWorkerEnvAliases(renderPreludeSource, parsed.workerEnvAliases);
    scriptUsesAwait = /\bawait\b/.test(scriptBody);
  }

  let explicitLoadFunction = parsed.loadFunction
    ? parsed.loadFunction.replace(/^export\s+/, '').trim()
    : '';
  if (explicitLoadFunction) {
    explicitLoadFunction = [routeDevDecls, explicitLoadFunction].filter(Boolean).join('\n');
    explicitLoadFunction = rewriteImportedFunctionCalls(explicitLoadFunction, fnToModule);
    explicitLoadFunction = rewriteWorkerEnvAliases(explicitLoadFunction, parsed.workerEnvAliases);
    if (routeImportDecls) explicitLoadFunction = explicitLoadFunction.replace('{', `{\n${routeImportDecls}\n`);
  }

  if (explicitLoadFunction && scriptUsesAwait) {
    throw new Error(
      `[koze compiler] ${pattern}\nTop-level await cannot be mixed with export async function load(). Move async server work into load().`,
    );
  }

  // TypeScript is preserved — wrangler's esbuild handles transpilation

  const scriptReturnVars = parsed.script
    ? parsed.dataVars.filter((name) =>
      !queryVars.includes(name) &&
      !importedBindingNames.has(name) &&
      !parsed.actionFunctions.includes(name) &&
      !actionAliasTargets.has(name) &&
      !parsed.pollFunctions.includes(name),
    )
    : [];

  // RFC 0002: Get SSR await calls from parsed data
  const ssrAwaitCalls = parsed.ssrAwaitCalls ?? [];
  const hasSsrAwaitCalls = ssrAwaitCalls.length > 0;

  const loadPlan = explicitLoadFunction
    ? {
      mode: 'explicit' as const,
      code: `load: ${explicitLoadFunction}`,
      returnVars: [...parsed.loadReturnVars],
      scriptUsesAwait: false,
    }
    : ((scriptBody && scriptUsesAwait) || queryDefs.length > 0 || hasSsrAwaitCalls || (parsed.requestImports && parsed.requestImports.length > 0))
      ? buildGeneratedLoadPlan({
        pattern,
        scriptBody,
        scriptUsesAwait,
        scriptReturnVars,
        queries: queryDefs,
        hasSegmentedScripts,
        fnToModule,
        rpcNameMap,
        ssrAwaitCalls,
        requestImports: parsed.requestImports,
      })
      : {
        mode: 'none' as const,
        code: '',
        returnVars: [],
        scriptUsesAwait,
      };

  const actions = hasFns
    ? parsed.actionFunctions.map((name) => {
      const targetName = actionAliasTargets.get(name) ?? name;
      const moduleId = fnToModule[targetName];
      return { name, expression: moduleId ? `${moduleId}.${targetName}` : targetName };
    })
    : [];

  const rpc = hasFns
    ? parsed.pollFunctions.map((name) => {
      const moduleId = fnToModule[name];
      const rpcId = rpcNameMap?.get(name) || name;
      const schemaExpression = moduleId
        ? `${moduleId}.schemas?.[${JSON.stringify(name)}]`
        : `(typeof schemas !== 'undefined' ? schemas?.[${JSON.stringify(name)}] : undefined)`;
      return { name, rpcId, expression: moduleId ? `${moduleId}.${name}` : name, schemaExpression };
    })
    : [];
  if (extraRpcBindings?.length) {
    const seenRpcIds = new Set(rpc.map((binding) => binding.rpcId));
    for (const binding of extraRpcBindings) {
      if (seenRpcIds.has(binding.rpcId)) continue;
      seenRpcIds.add(binding.rpcId);
      rpc.push(binding);
    }
  }

  assertRoutePlanInvariants({
    pattern,
    loadReturnVars: loadPlan.returnVars,
    actionNames: actions.map((action) => action.name),
    queryVars,
  });

  const renderDataVars = dedupe([
    ...queryVars,
    ...(scriptUsesAwait ? scriptReturnVars : []),
    ...parsed.actionFunctions,
    'params',
  ]);
  const renderPrelude = !scriptUsesAwait
    ? renderPreludeSource
    : renderImportPrelude;

  return {
    pattern,
    load: loadPlan,
    actions,
    rpc,
    render: {
      prelude: renderPrelude,
      dataVars: renderDataVars,
      body: renderBody,
      headBody: renderHeadBody,
      componentStyles,
      clientModuleHref: clientModuleHref ?? null,
    },
  };
}

export function emitRouteObject(plan: RouteBuildPlan): string {
  const parts: string[] = [];
  parts.push(`    pattern: '${plan.pattern}'`);

  if (plan.load.mode === 'explicit' || plan.load.mode === 'generated') {
    parts.push(`    ${plan.load.code}`);
  }

  if (plan.actions.length > 0) {
    const actionEntries = plan.actions
      .map((action) => `'${action.name}': ${action.expression}`)
      .join(', ');
    parts.push(`    actions: { ${actionEntries} }`);
  }

  if (plan.rpc.length > 0) {
    const rpcEntries = plan.rpc
      .map((rpc) => `'${rpc.rpcId}': ${rpc.expression}`)
      .join(', ');
    parts.push(`    rpc: { ${rpcEntries} }`);
    const rpcSchemaEntries = plan.rpc
      .map((rpc) => `'${rpc.rpcId}': ${rpc.schemaExpression}`)
      .join(', ');
    parts.push(`    rpcSchemas: { ${rpcSchemaEntries} }`);
    // Also emit allowedQueries for query override validation
    const allowedQueryNames = plan.rpc.map((rpc) => `'${rpc.rpcId}'`).join(', ');
    parts.push(`    allowedQueries: [${allowedQueryNames}]`);
  }

  const destructure = `const { ${plan.render.dataVars.join(', ')} } = data;\n      `;
  let finalHeadRenderBody = plan.render.headBody;
  if (plan.render.componentStyles.length > 0) {
    const lines = plan.render.headBody.split('\n');
    const styleLines = plan.render.componentStyles.map((css) => `__parts.push(\`${css}\\n\`);`);
    finalHeadRenderBody = [lines[0], ...styleLines, ...lines.slice(1)].join('\n');
  }
  if (plan.render.clientModuleHref) {
    finalHeadRenderBody += `\n__parts.push(\`<script type="module" src="${plan.render.clientModuleHref}"></script>\\n\`);`;
  }

  parts.push(`    render(data) {
      ${destructure}${plan.render.prelude ? plan.render.prelude + '\n      ' : ''}const __head = (() => {
        ${finalHeadRenderBody}
        return __html;
      })();
      const __rendered = (() => {
        const __parts = [];
        const __emit = (chunk) => {
          __parts.push(chunk == null ? '' : String(chunk));
        };
        ${plan.render.body}
        return { html: __parts.join('') };
      })();
      return { html: __rendered.html, head: __head };
    }`);

  return `  {\n${parts.join(',\n')}\n  }`;
}
