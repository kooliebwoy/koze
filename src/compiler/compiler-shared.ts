export interface SecurityConfigEntry {
  /**
   * Content Security Policy directive string (default: null). Use the literal `{NONCE}`
   * placeholder to opt into per-request nonces on framework-injected inline scripts.
   */
  contentSecurityPolicy: string | null;
  /** Strict-Transport-Security header (default: null - no HSTS) */
  strictTransportSecurity: string | null;
  /** Permissions-Policy header (default: null) */
  permissionsPolicy: string | null;
}

export interface DoConfigEntry {
  binding: string;
  className: string;
  files?: string[];
}

export interface WorkerClassConfigEntry {
  binding: string;
  className: string;
  file: string;
  exportKind: 'named' | 'default';
}

/**
 * Tuning declared via `static` fields on a container/sandbox class.
 * All fields are optional; missing fields fall through to framework defaults
 * (or raise a compile-time error when no default is possible — e.g. a container
 * with no `image` declared).
 */
export interface ClassStaticTuning {
  /** Path to a Dockerfile (e.g. './docker/wordpress.Dockerfile') OR a registry image reference (e.g. 'docker.io/cloudflare/sandbox:0.8.11'). */
  image?: string;
  /** Cloudflare Containers instance size. */
  instanceType?: 'lite' | 'standard';
  /** Concurrent container cap. */
  maxInstances?: number;
  /** Opt container into SQLite-backed Durable Object storage (adds `new_sqlite_classes` migration). Sandbox classes are always SQLite-backed. */
  sqlite?: boolean;
}

export interface ContainerConfigEntry extends WorkerClassConfigEntry, ClassStaticTuning {
  /** Discriminator so wrangler-sync can apply primitive-specific defaults. */
  kind: 'container' | 'sandbox';
  /** Required once discovery has resolved author-declared field → sibling Dockerfile → per-kind default. */
  image: string;
  /** Resolved absolute path to a local Dockerfile if one was detected, else `null`. Used for change-tracking / validation. */
  resolvedDockerfile?: string | null;
}

export interface ConventionClassEntry {
  className: string;
  file: string;
  exportKind: 'named' | 'default';
}

export interface QueueConsumerEntry {
  /** Queue binding name derived from filename (e.g., NOTIFICATIONS from notifications.queue.ts) */
  binding: string;
  /** Queue name for Cloudflare (lowercase with hyphens, e.g., notifications from notifications.queue.ts) */
  queueName: string;
  /** Relative file path from project root */
  file: string;
  /** Whether the handler is exported as default or named */
  exportKind: 'named' | 'default';
}

export interface PipelineConfigEntry {
  /** Convention name used by `pipeline('<name>')`, derived from filename. */
  name: string;
  /** Worker env binding name (e.g., ANALYTICS_PIPELINE from analytics.pipeline.ts). */
  binding: string;
  /** Cloudflare Pipelines stream/pipeline identifier written to wrangler.jsonc. */
  pipeline: string;
  /** Optional Cloudflare Pipeline resource name used by generated setup commands. Defaults to the convention name. */
  pipelineName?: string;
  /** Optional stream schema used to generate `_cloudflare/pipelines/<name>/schema.json`. */
  schema?: PipelineSchemaConfig;
  /** Optional sink config used to generate `_cloudflare/pipelines/<name>/pipeline.sql` and setup notes. */
  sink?: PipelineSinkConfig;
  /** Optional SQL override. Defaults to `INSERT INTO <sink.name> SELECT * FROM <pipeline>`. */
  sql?: string;
  /** Relative file path from project root. */
  file: string;
}

export interface PipelineSchemaField {
  name: string;
  type: string;
  required?: boolean;
  [key: string]: unknown;
}

export type PipelineSchemaConfig =
  | PipelineSchemaField[]
  | Record<string, string | { type: string; required?: boolean }>;

export interface PipelineR2DataCatalogSinkConfig {
  type: 'r2-data-catalog';
  /** Sink resource name used by Cloudflare Pipelines SQL. Defaults to `<pipeline-name>_sink`. */
  name?: string;
  bucket: string;
  namespace?: string;
  table: string;
  rollInterval?: number;
  rollSize?: number;
  compression?: 'zstd' | 'snappy' | 'gzip' | 'lz4' | 'uncompressed';
  targetRowGroupSize?: number;
}

export type PipelineSinkConfig = PipelineR2DataCatalogSinkConfig;

export interface DoClassMethodEntry {
  name: string;
  visibility: 'public' | 'private' | 'protected';
  isStatic: boolean;
  isAsync: boolean;
  hasWorkerContextCalls: boolean;
  callsThisMethods: string[];
}

export interface DoClassContributorEntry {
  /** Absolute path to the contributor source file */
  absPath: string;
  /** Exported class name */
  className: string;
  /** Whether the class is exported as named or default */
  exportKind: 'named' | 'default';
  /** Own methods declared on this contributor */
  classMethods: DoClassMethodEntry[];
  /** Inheritance depth from the base DO class (1 = direct child) */
  depth: number;
}

export interface ExportedClassEntry {
  className: string;
  exportKind: 'named' | 'default';
}

export interface RelativeImportClassEntry {
  source: string;
  importedName: string | 'default';
}

export interface DoHandlerEntry {
  fileName: string;
  absPath: string;
  binding: string;
  mode: 'class' | 'function';
  className?: string;
  exportKind?: 'named' | 'default';
  classMethods: DoClassMethodEntry[];
  /** Additional exported classes in the same DO folder that extend this base DO class */
  classContributors: DoClassContributorEntry[];
  exportedFunctions: string[];
}

export function toSafeIdentifier(input: string): string {
  const normalized = input.replace(/[^A-Za-z0-9_$]/g, '_');
  return /^[A-Za-z_$]/.test(normalized) ? normalized : `_${normalized}`;
}

/**
 * Stable function-name derivation for compiled `.koze` components.
 *
 * The component pipeline emits a function `function __c_<name>(props,
 * __esc) { ... }` for every imported component, and the template
 * compiler emits a CALL to that function at every component-tag site
 * (`<Card title="..." />` becomes `__c_<name>({ title: "..." }, __esc)`).
 *
 * Both sides MUST agree on the derived name, so this helper is the
 * single source of truth.
 *
 * Three input shapes correspond to the three accepted import forms:
 *
 *   "stat-card"                  → "__c_stat_card"        ($lib import)
 *   "@kuratchi/ui:badge"         → "__c_badge"            (package import)
 *   "__rel__:./widgets/chart"    → "__c_rel_chart_<hash>" (relative import)
 *
 * Relative paths get a stable hash suffix derived from the relative
 * specifier so two `chart.koze` files in different directories
 * don't collide. The hash is content-free (path only), so a file
 * being edited doesn't change the function name and produce gratuitous
 * cache invalidation.
 */
export function componentFuncName(fileName: string, hashSpec?: string): string {
  // Relative import: `__rel__:./path/to/component`
  if (fileName.startsWith('__rel__:')) {
    const relPath = fileName.slice('__rel__:'.length); // "./widgets/chart"
    const stem = relPath.split(/[\\/]/).pop() ?? 'component';
    const safeStem = stem.replace(/[^A-Za-z0-9_]/g, '_');
    // 8-char hash of the relative spec (caller may pass a richer key
    // — typically the absolute resolved path — for stability across
    // duplicate-named files).
    const hashInput = hashSpec ?? relPath;
    let hash = 0;
    for (let i = 0; i < hashInput.length; i++) {
      hash = ((hash << 5) - hash + hashInput.charCodeAt(i)) | 0;
    }
    const hashHex = (hash >>> 0).toString(16).padStart(8, '0').slice(0, 8);
    return `__c_rel_${safeStem}_${hashHex}`;
  }
  // Package or $lib import: split off any `pkg:` prefix and sanitize
  // the remainder.
  const name = fileName.includes(':') ? fileName.split(':').pop()! : fileName;
  return '__c_' + name.replace(/[^A-Za-z0-9_]/g, '_');
}
