import * as path from 'node:path';

import { toSafeIdentifier } from './compiler-shared.js';
import type { GenerateRoutesModuleOptions, RoutesModuleFeatureBlocks } from './routes-module-types.js';

export function buildRoutesModuleFeatureBlocks(opts: GenerateRoutesModuleOptions): RoutesModuleFeatureBlocks {
  const workerImport = `import { env as __env } from 'cloudflare:workers';`;
  const contextImport = `import { __setRequestContext, __pushRequestContext, __esc, __rawHtml, __sanitizeHtml, __setLocal, __getLocals } from '${opts.runtimeContextImport}';`;
  const middlewareImport = opts.hasMiddleware && opts.middlewareImportPath
    ? `import __kozeMiddleware from '${opts.middlewareImportPath}';`
    : '';

  const { doImports, doClassCode, doResolverInit } = buildDurableObjectBlock(opts);
  const workflowStatusRpc = buildWorkflowStatusRpc(opts);
  const pipelineRegistry = buildPipelineRegistry(opts);

  return {
    workerImport,
    contextImport,
    middlewareImport,
    doImports,
    doClassCode,
    doResolverInit,
    workflowStatusRpc,
    pipelineRegistry,
  };
}

function buildDurableObjectBlock(opts: GenerateRoutesModuleOptions): Pick<RoutesModuleFeatureBlocks, 'doImports' | 'doClassCode' | 'doResolverInit'> {
  if (opts.doConfig.length === 0 || opts.doHandlers.length === 0) {
    return { doImports: '', doClassCode: '', doResolverInit: '' };
  }

  const doImportLines: string[] = [];
  const doClassLines: string[] = [];
  const doResolverLines: string[] = [];

  doImportLines.push(`import { DurableObject as __DO } from 'cloudflare:workers';`);
  doImportLines.push(`import { __registerDoResolver, __registerDoClassBinding, __setDoContext } from '${opts.runtimeDoImport}';`);
  doImportLines.push(`import { validateSchemaInput as __validateSchemaInput } from '${opts.runtimeSchemaImport}';`);
  doImportLines.push(`const __DO_FD_TAG = '__koze_form_data__';`);
  doImportLines.push(`const __DO_RPC_CTX_TAG = '__koze_rpc_context__';`);
  doImportLines.push(`const __DO_RPC_RESULT_TAG = '__koze_rpc_result__';`);
  doImportLines.push(`function __isDoPlainObject(__v) {`);
  doImportLines.push(`  if (!__v || typeof __v !== 'object') return false;`);
  doImportLines.push(`  const __proto = Object.getPrototypeOf(__v);`);
  doImportLines.push(`  return __proto === Object.prototype || __proto === null;`);
  doImportLines.push(`}`);
  doImportLines.push(`function __decodeDoArg(__v) {`);
  doImportLines.push(`  if (Array.isArray(__v)) return __v.map(__decodeDoArg);`);
  doImportLines.push(`  if (__isDoPlainObject(__v)) {`);
  doImportLines.push(`    if (__DO_FD_TAG in __v) {`);
  doImportLines.push(`      const __fd = new FormData();`);
  doImportLines.push(`      const __entries = Array.isArray(__v[__DO_FD_TAG]) ? __v[__DO_FD_TAG] : [];`);
  doImportLines.push(`      for (const __pair of __entries) { if (Array.isArray(__pair) && __pair.length >= 2) __fd.append(String(__pair[0]), __pair[1]); }`);
  doImportLines.push(`      return __fd;`);
  doImportLines.push(`    }`);
  doImportLines.push(`    const __out = {};`);
  doImportLines.push(`    for (const [__k, __val] of Object.entries(__v)) __out[__k] = __decodeDoArg(__val);`);
  doImportLines.push(`    return __out;`);
  doImportLines.push(`  }`);
  doImportLines.push(`  return __v;`);
  doImportLines.push(`}`);
  doImportLines.push(`function __extractDoRpcContext(__args) {`);
  doImportLines.push(`  if (!Array.isArray(__args) || __args.length === 0) return { args: __args, context: null };`);
  doImportLines.push(`  const __tail = __args[__args.length - 1];`);
  doImportLines.push(`  if (!__isDoPlainObject(__tail) || !(__DO_RPC_CTX_TAG in __tail)) return { args: __args, context: null };`);
  doImportLines.push(`  return { args: __args.slice(0, -1), context: __tail[__DO_RPC_CTX_TAG] || null };`);
  doImportLines.push(`}`);
  doImportLines.push(`function __wrapDoRpcResult(__value) {`);
  doImportLines.push(`  const __locals = __getLocals();`);
  doImportLines.push(`  return { [__DO_RPC_RESULT_TAG]: { value: __value, effects: { redirectTo: __locals.__redirectTo ?? null, redirectStatus: __locals.__redirectStatus ?? null, setCookieHeaders: Array.isArray(__locals.__setCookieHeaders) ? __locals.__setCookieHeaders : [] } } };`);
  doImportLines.push(`}`);
  doImportLines.push(`function __invokeDoRpc(__self, __methodName, __fn, __args) {`);
  doImportLines.push(`  __setDoContext(__self);`);
  doImportLines.push(`  const { args: __callArgs, context: __rpcContext } = __extractDoRpcContext(__args);`);
  doImportLines.push(`  const __decoded = (__callArgs ?? []).map(__decodeDoArg);`);
  doImportLines.push(`  const __schema = __self?.constructor?.schemas?.[__methodName];`);
  doImportLines.push(`  const __validated = __validateSchemaInput(__schema, __decoded);`);
  doImportLines.push(`  if (!__rpcContext) return __fn.apply(__self, __validated);`);
  doImportLines.push(`  const __restore = __pushRequestContext(__rpcContext, __self.ctx, __self.env);`);
  doImportLines.push(`  const __finish = (__value) => __wrapDoRpcResult(__value);`);
  doImportLines.push(`  const __fail = (__err) => { if (__err && __err.isRedirectError) return __wrapDoRpcResult(undefined); throw __err; };`);
  doImportLines.push(`  try {`);
  doImportLines.push(`    const __result = __fn.apply(__self, __validated);`);
  doImportLines.push(`    if (__result && typeof __result.then === 'function') {`);
  doImportLines.push(`      return __result.then(__finish, __fail).finally(__restore);`);
  doImportLines.push(`    }`);
  doImportLines.push(`    const __wrapped = __finish(__result);`);
  doImportLines.push(`    __restore();`);
  doImportLines.push(`    return __wrapped;`);
  doImportLines.push(`  } catch (__err) {`);
  doImportLines.push(`    try { return __fail(__err); } finally { __restore(); }`);
  doImportLines.push(`  }`);
  doImportLines.push(`}`);

  const handlersByBinding = new Map<string, typeof opts.doHandlers>();
  for (const handler of opts.doHandlers) {
    const list = handlersByBinding.get(handler.binding) ?? [];
    list.push(handler);
    handlersByBinding.set(handler.binding, list);
  }

  for (const doEntry of opts.doConfig) {
    const handlers = handlersByBinding.get(doEntry.binding) ?? [];
    const fnHandlers = handlers.filter((h) => h.mode === 'function');
    const initHandlers = fnHandlers.filter((h) => h.exportedFunctions.includes('onInit'));
    const alarmHandlers = fnHandlers.filter((h) => h.exportedFunctions.includes('onAlarm'));
    const messageHandlers = fnHandlers.filter((h) => h.exportedFunctions.includes('onMessage'));

    for (const handler of handlers) {
      let handlerImportPath = path
        .relative(path.join(opts.projectDir, '.koze'), handler.absPath)
        .replace(/\\/g, '/')
        .replace(/\.ts$/, '.js');
      if (!handlerImportPath.startsWith('.')) handlerImportPath = './' + handlerImportPath;
      const handlerVar = `__handler_${toSafeIdentifier(handler.fileName)}`;
      if (handler.mode === 'class') {
        if (handler.exportKind === 'named' && handler.className) {
          doImportLines.push(`import { ${handler.className} as ${handlerVar} } from '${handlerImportPath}';`);
        } else {
          doImportLines.push(`import ${handlerVar} from '${handlerImportPath}';`);
        }
        for (const [index, contributor] of (handler.classContributors ?? []).entries()) {
          let contributorImportPath = path
            .relative(path.join(opts.projectDir, '.koze'), contributor.absPath)
            .replace(/\\/g, '/')
            .replace(/\.ts$/, '.js');
          if (!contributorImportPath.startsWith('.')) contributorImportPath = './' + contributorImportPath;
          const contributorVar = `__handler_${toSafeIdentifier(`${handler.fileName}__${contributor.className}_${index}`)}`;
          if (contributor.exportKind === 'named') {
            doImportLines.push(`import { ${contributor.className} as ${contributorVar} } from '${contributorImportPath}';`);
          } else {
            doImportLines.push(`import ${contributorVar} from '${contributorImportPath}';`);
          }
        }
      } else {
        doImportLines.push(`import * as ${handlerVar} from '${handlerImportPath}';`);
      }
    }

    // Generate the DO class
    doClassLines.push(`export class ${doEntry.className} extends __DO {`);
    doClassLines.push(`  constructor(ctx, env) {`);
    doClassLines.push(`    super(ctx, env);`);
    for (const handler of handlers.filter((h) => h.mode === 'class')) {
      const handlerVar = `__handler_${toSafeIdentifier(handler.fileName)}`;
      const handlerInstanceVar = `__instance_${toSafeIdentifier(handler.fileName)}`;
      doClassLines.push(`    const ${handlerInstanceVar} = new ${handlerVar}(ctx, env);`);
      doClassLines.push(`    Object.assign(this, ${handlerInstanceVar});`);
    }
    for (const handler of initHandlers) {
      const handlerVar = `__handler_${toSafeIdentifier(handler.fileName)}`;
      doClassLines.push(`    __setDoContext(this);`);
      doClassLines.push(`    Promise.resolve(${handlerVar}.onInit.call(this)).catch((err) => console.error('[Koze] DO onInit failed:', err?.message || err));`);
    }
    doClassLines.push(`  }`);
    if (alarmHandlers.length > 0) {
      doClassLines.push(`  async alarm(...args) {`);
      doClassLines.push(`    __setDoContext(this);`);
      for (const handler of alarmHandlers) {
        const handlerVar = `__handler_${toSafeIdentifier(handler.fileName)}`;
        doClassLines.push(`    await ${handlerVar}.onAlarm.call(this, ...args);`);
      }
      doClassLines.push(`  }`);
    }
    if (messageHandlers.length > 0) {
      doClassLines.push(`  webSocketMessage(...args) {`);
      doClassLines.push(`    __setDoContext(this);`);
      for (const handler of messageHandlers) {
        const handlerVar = `__handler_${toSafeIdentifier(handler.fileName)}`;
        doClassLines.push(`    ${handlerVar}.onMessage.call(this, ...args);`);
      }
      doClassLines.push(`  }`);
    }
    doClassLines.push(`  static schemas = {};`);
    doClassLines.push(`}`);

    // Apply prototype methods from each class handler (and its contributors) onto the generated class.
    //
    // SECURITY BOUNDARY: Only methods the compiler classifies as RPC-callable are copied onto the
    // generated DO class prototype. Cloudflare Workers RPC exposes every method on the DO class to
    // any worker bound to the namespace, so TS `private` (erased at runtime) is not a safe gate.
    // We enforce the boundary at compile time by computing a per-class public allow-list and only
    // rewiring those names onto the generated prototype. Private methods remain on the original
    // handler class and are still reachable via `this._foo()` inside the class, but are invisible
    // to the RPC surface.
    const lifecycleNames = new Set(['constructor', 'fetch', 'alarm', 'webSocketMessage', 'webSocketClose', 'webSocketError', 'onInit', 'onAlarm', 'onMessage']);
    const isRpcCallable = (name: string, visibility: string): boolean => {
      if (!name) return false;
      if (name.startsWith('_')) return false;
      if (name.startsWith('__koze')) return false;
      if (lifecycleNames.has(name)) return false;
      if (visibility !== 'public') return false;
      return true;
    };
    for (const handler of handlers) {
      const handlerVar = `__handler_${toSafeIdentifier(handler.fileName)}`;
      if (handler.mode === 'class') {
        const classSourceVars = [
          handlerVar,
          ...(handler.classContributors ?? []).map((c, i) => `__handler_${toSafeIdentifier(`${handler.fileName}__${c.className}_${i}`)}`),
        ];
        const publicNames = (handler.classMethods ?? [])
          .filter((m) => isRpcCallable(m.name, m.visibility))
          .map((m) => m.name);
        const allowVar = `__doPublic_${toSafeIdentifier(handler.fileName)}`;
        doClassLines.push(`const ${allowVar} = new Set(${JSON.stringify(publicNames)});`);
        doClassLines.push(`{`);
        doClassLines.push(`  for (const __source of [${classSourceVars.join(', ')}]) {`);
        doClassLines.push(`    const __seen = new Set();`);
        doClassLines.push(`    for (let __p = __source.prototype; __p && __p !== __DO.prototype && __p !== Object.prototype; __p = Object.getPrototypeOf(__p)) {`);
        doClassLines.push(`      for (const __k of Object.getOwnPropertyNames(__p)) {`);
        doClassLines.push(`        if (__k === 'constructor' || __seen.has(__k)) continue;`);
        doClassLines.push(`        if (!${allowVar}.has(__k)) continue;`);
        doClassLines.push(`        const __desc = Object.getOwnPropertyDescriptor(__p, __k);`);
        doClassLines.push(`        const __fn = __desc?.value;`);
        doClassLines.push(`        if (typeof __fn !== 'function') continue;`);
        doClassLines.push(`        __seen.add(__k);`);
        doClassLines.push(`        ${doEntry.className}.prototype[__k] = function(...__a){ return __invokeDoRpc(this, __k, __fn, __a); };`);
        doClassLines.push(`      }`);
        doClassLines.push(`    }`);
        doClassLines.push(`  }`);
        doClassLines.push(`}`);
        doClassLines.push(`Object.assign(${doEntry.className}.schemas, ${handlerVar}.schemas || {});`);
        for (const [index] of (handler.classContributors ?? []).entries()) {
          const contributorVar = `__handler_${toSafeIdentifier(`${handler.fileName}__${handler.classContributors[index].className}_${index}`)}`;
          doClassLines.push(`Object.assign(${doEntry.className}.schemas, ${contributorVar}.schemas || {});`);
        }
        doResolverLines.push(`  __registerDoClassBinding(${handlerVar}, '${doEntry.binding}');`);
      } else {
        for (const fn of handler.exportedFunctions) {
          if (lifecycleNames.has(fn)) continue;
          if (fn.startsWith('_')) continue;
          doClassLines.push(`${doEntry.className}.prototype[${JSON.stringify(fn)}] = function(...__a){ return __invokeDoRpc(this, ${JSON.stringify(fn)}, ${handlerVar}.${fn}, __a); };`);
        }
        doClassLines.push(`Object.assign(${doEntry.className}.schemas, ${handlerVar}.schemas || {});`);
      }
    }

    // Default DO resolver — singleton instance via idFromName('global').
    // Apps that need per-user/per-org routing register a custom resolver
    // at runtime via `__registerDoResolver(binding, resolver)`. The
    // framework intentionally has no built-in user/org awareness here —
    // those concerns belong in the app's own auth/org middleware.
    doResolverLines.push(`  __registerDoResolver('${doEntry.binding}', async () => {`);
    doResolverLines.push(`    const __ns = __env['${doEntry.binding}'];`);
    doResolverLines.push(`    if (!__ns?.idFromName || !__ns?.get) return null;`);
    doResolverLines.push(`    return __ns.get(__ns.idFromName('global'));`);
    doResolverLines.push(`  });`);
  }

  return {
    doImports: doImportLines.join('\n'),
    doClassCode: `\n// Durable Object Classes (generated)\n\n${doClassLines.join('\n')}\n`,
    doResolverInit: `\nfunction __initDoResolvers() {\n${doResolverLines.join('\n')}\n}\n`,
  };
}

/**
 * Register all discovered workflows with the runtime workflow module.
 * The generated code imports __setWorkflowRegistry and calls it at module init,
 * mapping convention name (filename basename) → env binding.
 *
 * Example: `container.workflow.ts` → `{ 'container': { binding: 'CONTAINER_WORKFLOW' } }`
 */
function buildWorkflowStatusRpc(opts: GenerateRoutesModuleOptions): string {
  if (opts.workflowConfig.length === 0) return '';
  const lines: string[] = [];
  lines.push(`\n// Workflow registry (auto-generated from src/server/*.workflow.ts)`);
  lines.push(`import { __setWorkflowRegistry as __kozeSetWorkflowRegistry } from '@kuratchi/koze/runtime/workflow.js';`);
  lines.push(`__kozeSetWorkflowRegistry({`);
  for (const workflow of opts.workflowConfig) {
    const baseName = workflow.file.split('/').pop()?.replace(/\.workflow\.ts$/, '') || '';
    if (!baseName) continue;
    lines.push(`  ${JSON.stringify(baseName)}: { binding: ${JSON.stringify(workflow.binding)} },`);
  }
  lines.push(`});`);
  return lines.join('\n');
}

function buildPipelineRegistry(opts: GenerateRoutesModuleOptions): string {
  if (opts.pipelineConfig.length === 0) return '';
  const lines: string[] = [];
  lines.push(`\n// Pipeline registry (auto-generated from src/server/*.pipeline.ts)`);
  lines.push(`import { __setPipelineRegistry as __kozeSetPipelineRegistry } from '@kuratchi/koze/runtime/pipeline.js';`);
  lines.push(`__kozeSetPipelineRegistry({`);
  for (const pipeline of opts.pipelineConfig) {
    lines.push(
      `  ${JSON.stringify(pipeline.name)}: { binding: ${JSON.stringify(pipeline.binding)}, pipeline: ${JSON.stringify(pipeline.pipeline)} },`,
    );
  }
  lines.push(`});`);
  return lines.join('\n');
}
