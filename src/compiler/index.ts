/**
 * Public Koze compiler boundary.
 *
 * Build integrations consume `createKozeCompiler()`. Individual compiler
 * modules remain internal implementation details and are tested directly.
 */
export { createKozeCompiler } from './service.js';
export type { KozeCompiler } from './service.js';

export {
  KuratchiCompilerError,
  createCompilerError,
  isKuratchiCompilerError,
} from './diagnostics.js';
export type {
  KuratchiCompilerDiagnostic,
  KuratchiCompilerErrorCode,
} from './diagnostics.js';
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
export type { AugmentedActionAlias, ParsedFile } from './parser.js';
export type { ComponentCompiler } from './component-pipeline.js';
export type { ServerModuleCompiler } from './server-module-pipeline.js';
export type { ClientFragment } from './application-pipeline.js';
export type { DiscoveredRoute, ProjectAnalysis } from './project-analysis.js';
