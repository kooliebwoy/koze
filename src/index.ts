/**
 * Koze - Public API
 *
 * A thin, Cloudflare Workers-native web framework with Svelte-inspired syntax.
 */

// Runtime
export { createApp } from './runtime/app.js';
export { defineMiddleware, defineRuntime } from './runtime/middleware.js';
export { cookies } from './runtime/cookies.js';
export type { CookieOptions } from './runtime/cookies.js';
export {  getCtx,
  getEnv,
  RedirectError,
  redirect,
} from './runtime/context.js';
export { kozeDO, kuratchiDO, doRpc, getDb } from './runtime/do.js';
export {
  SchemaValidationError,
  schema,
} from './runtime/schema.js';
export { ActionError, augment } from './runtime/action.js';
export type {
  AugmentedActionHookContext,
  AugmentedActionHooks,
  AugmentedActionState,
} from './runtime/action.js';
export { PageError } from './runtime/page-error.js';
export {
  extractSubdomainSlug,
  extractSlugFromPrefix,
  matchContainerViewPath,
  rewriteProxyLocationHeader,
  buildContainerRequest,
  createContainerEnvVars,
  startContainer,
  proxyToContainer,
  handleContainerRouting,
  forwardJsonPostToContainerDO,
  // Compatibility aliases
  matchSiteViewPath,
  buildSiteContainerRequest,
  createWpContainerEnvVars,
  startSiteContainer,
  proxyToSiteContainer,
} from './runtime/containers.js';
export type {
  AppConfig,
  DesktopConfig,
  DesktopRemoteBindingConfig,
  DesktopWindowConfig,
  SecurityConfig,
  MiddlewareContext,
  MiddlewareDefinition,
  MiddlewareStep,
  MiddlewareNext,
  MiddlewareErrorResult,
  ActionContext,
  RouteContext,
  RouteModule,
  RuntimeContext,
  RuntimeDefinition,
  RuntimeStep,
  RuntimeNext,
  RuntimeErrorResult,
} from './runtime/types.js';
export type { RpcOf } from './runtime/do.js';
export type { SchemaType, InferSchema } from './runtime/schema.js';
export { pipeline, pipelines, sendPipeline } from './runtime/pipeline.js';
export type { PipelineBinding, PipelineHandle } from './runtime/pipeline.js';

export {
  createPendingValue,
  createSuccessValue,
  createErrorValue,
  createThenableAsyncValue,
  wrapAsyncValue,
  isAsyncValue,
  parseInterval,
} from './runtime/async-value.js';
export type {
  AsyncValue,
  AsyncValueState,
  ThenableAsyncValue,
} from './runtime/async-value.js';

export {
  createKuratchiChannelClient,
  createKuratchiRpcAsyncValue,
  getKuratchiChannel,
  invokeKuratchiChannel,
} from './runtime/channel.js';
export type {
  KuratchiBrowserChannelGlobal,
  KuratchiChannelCarrier,
  KuratchiChannelClient,
  KuratchiChannelInvokeInput,
  KuratchiChannelInvokeOptions,
  KuratchiChannelTarget,
} from './runtime/channel.js';
export { KURATCHI_CHANNEL_ENDPOINT } from './runtime/channel-protocol.js';
export type {
  KuratchiChannelCallFrame,
  KuratchiChannelTarget as KuratchiChannelFrameTarget,
} from './runtime/channel-protocol.js';

export { request, url, pathname, searchParams, headers, method, params, slug, locals } from './runtime/request.js';
export { createContentRegistry } from './runtime/content.js';
export type {
  ContentFrontmatter,
  ContentGroup,
  ContentHeading,
  ContentListItem,
  ContentRegistry,
  ContentSourceEntry,
  RenderedContent,
} from './runtime/content.js';
