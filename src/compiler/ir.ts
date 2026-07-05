import type { KuratchiFileAst, KuratchiFileKind, KuratchiTemplateAst } from './ast.js';
import { parseImportStatement, type ImportBinding } from './import-linking.js';

export interface KuratchiImportIr {
  line: string;
  moduleSpecifier: string | null;
  bindings: ImportBinding[];
  namespaceImport: string | null;
}

export interface KuratchiAwaitQueryIr {
  fnName: string;
  argsExpr: string;
  asName: string;
  key?: string;
  rpcId?: string;
  awaitExpr?: string;
}

export interface KuratchiSsrAwaitIr {
  varName: string;
  fnName: string;
  argsExpr: string;
}

export interface KuratchiActionAliasIr {
  name: string;
  target: string;
  augmentLocal: string;
}

export interface KuratchiRequestImportIr {
  exportName: string;
  alias: string;
}

export interface KuratchiModuleIr {
  kind: KuratchiFileKind;
  filePath?: string;
  sfc: KuratchiFileAst;
  script: {
    raw: string | null;
    normalized: string | null;
    loadFunction: string | null;
    loadReturnVars: string[];
    hasLoad: boolean;
    dataVars: string[];
    workerEnvAliases: string[];
    devAliases: string[];
  };
  template: {
    source: string;
    ast: KuratchiTemplateAst;
    actionFunctions: string[];
    awaitQueries: KuratchiAwaitQueryIr[];
    serverFunctions: string[];
  };
  imports: {
    server: KuratchiImportIr[];
    client: KuratchiImportIr[];
    routeClient: KuratchiImportIr[];
    routeClientBindings: string[];
    request: KuratchiRequestImportIr[];
  };
  components: {
    imports: Record<string, string>;
  };
  rpc: {
    serverImports: KuratchiImportIr[];
    serverFunctions: string[];
    actionAliases: KuratchiActionAliasIr[];
    ssrAwaitCalls: KuratchiSsrAwaitIr[];
    clientNpmImports: KuratchiImportIr[];
  };
}

interface ParsedFileLike {
  script: string | null;
  loadFunction: string | null;
  template: string;
  serverImports: string[];
  hasLoad: boolean;
  actionFunctions: string[];
  dataVars: string[];
  componentImports: Record<string, string>;
  pollFunctions: string[];
  dataGetQueries: KuratchiAwaitQueryIr[];
  clientImports: string[];
  routeClientImports: string[];
  routeClientImportBindings: string[];
  loadReturnVars: string[];
  workerEnvAliases: string[];
  devAliases: string[];
  requestImports: KuratchiRequestImportIr[];
  clientScriptRaw: string | null;
  serverRpcImports: string[];
  serverRpcFunctions: string[];
  actionAliases: KuratchiActionAliasIr[];
  ssrAwaitCalls: KuratchiSsrAwaitIr[];
  clientNpmImports: string[];
}

function toImportIr(line: string): KuratchiImportIr {
  const parsed = parseImportStatement(line);
  return {
    line,
    moduleSpecifier: parsed.moduleSpecifier,
    bindings: parsed.bindings,
    namespaceImport: parsed.namespaceImport,
  };
}

export function buildKuratchiModuleIr(
  parsed: ParsedFileLike,
  sfc: KuratchiFileAst,
): KuratchiModuleIr {
  return {
    kind: sfc.kind,
    filePath: sfc.filePath,
    sfc,
    script: {
      raw: parsed.clientScriptRaw,
      normalized: parsed.script,
      loadFunction: parsed.loadFunction,
      loadReturnVars: [...parsed.loadReturnVars],
      hasLoad: parsed.hasLoad,
      dataVars: [...parsed.dataVars],
      workerEnvAliases: [...parsed.workerEnvAliases],
      devAliases: [...parsed.devAliases],
    },
    template: {
      source: parsed.template,
      ast: sfc.template,
      actionFunctions: [...parsed.actionFunctions],
      awaitQueries: parsed.dataGetQueries.map((query) => ({ ...query })),
      serverFunctions: [...parsed.pollFunctions],
    },
    imports: {
      server: parsed.serverImports.map(toImportIr),
      client: parsed.clientImports.map(toImportIr),
      routeClient: parsed.routeClientImports.map(toImportIr),
      routeClientBindings: [...parsed.routeClientImportBindings],
      request: parsed.requestImports.map((requestImport) => ({ ...requestImport })),
    },
    components: {
      imports: { ...parsed.componentImports },
    },
    rpc: {
      serverImports: parsed.serverRpcImports.map(toImportIr),
      serverFunctions: [...parsed.serverRpcFunctions],
      actionAliases: parsed.actionAliases.map((alias) => ({ ...alias })),
      ssrAwaitCalls: parsed.ssrAwaitCalls.map((call) => ({ ...call })),
      clientNpmImports: parsed.clientNpmImports.map(toImportIr),
    },
  };
}
