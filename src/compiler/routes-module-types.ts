import type {
  DoConfigEntry,
  DoHandlerEntry,
  PipelineConfigEntry,
  SecurityConfigEntry,
  WorkerClassConfigEntry,
} from './compiler-shared.js';

export interface CompiledAssetEntry {
  name: string;
  content: string;
  mime: string;
  etag: string;
}

export interface GenerateRoutesModuleOptions {
  projectDir: string;
  serverImports: string[];
  compiledRoutes: string[];
  routePatterns: string[];
  compiledLayout: string | null;
  compiledComponents: string[];
  isDev: boolean;
  compiledAssets: CompiledAssetEntry[];
  compiledErrorPages: Map<number, string>;
  securityConfig: SecurityConfigEntry;
  doConfig: DoConfigEntry[];
  doHandlers: DoHandlerEntry[];
  workflowConfig: WorkerClassConfigEntry[];
  pipelineConfig: PipelineConfigEntry[];
  isLayoutAsync: boolean;
  compiledLayoutActions: string | null;
  hasMiddleware: boolean;
  middlewareImportPath?: string;
  assetsPrefix: string;
  runtimeContextImport: string;
  runtimeDoImport: string;
  runtimeSchemaImport: string;
  runtimeWorkerImport: string;
}

export interface RoutesModuleFeatureBlocks {
  workerImport: string;
  contextImport: string;
  middlewareImport: string;
  doImports: string;
  doClassCode: string;
  doResolverInit: string;
  workflowStatusRpc: string;
  pipelineRegistry: string;
}
