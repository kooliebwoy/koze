import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

import {
  type ClassStaticTuning,
  type ConventionClassEntry,
  type ContainerConfigEntry,
  type PipelineSchemaConfig,
  type PipelineSinkConfig,
  type PipelineConfigEntry,
  type QueueConsumerEntry,
  type WorkerClassConfigEntry,
} from './compiler-shared.js';

const PLURAL_CONVENTION_SUFFIXES = [
  { plural: '.agents.ts', singular: '.agent.ts' },
  { plural: '.workflows.ts', singular: '.workflow.ts' },
  { plural: '.queues.ts', singular: '.queue.ts' },
  { plural: '.pipelines.ts', singular: '.pipeline.ts' },
  { plural: '.containers.ts', singular: '.container.ts' },
  { plural: '.sandboxes.ts', singular: '.sandbox.ts' },
  { plural: '.dos.ts', singular: '.do.ts' },
] as const;

export function assertCanonicalConventionFileSuffixes(projectDir: string): void {
  const serverDir = path.join(projectDir, 'src', 'server');
  if (!fs.existsSync(serverDir)) return;

  const violations: string[] = [];
  const walk = (absDir: string) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      for (const rule of PLURAL_CONVENTION_SUFFIXES) {
        if (!entry.name.endsWith(rule.plural)) continue;
        const rel = path.relative(projectDir, abs).replace(/\\/g, '/');
        const fixedName = entry.name.slice(0, -rule.plural.length) + rule.singular;
        violations.push(
          `- ${rel}: use "${fixedName}" instead of "${entry.name}"`,
        );
      }
    }
  };
  walk(serverDir);

  if (violations.length > 0) {
    throw new Error(
      [
        '[koze] Convention file suffixes are singular.',
        'Use <name>.<kind>.ts with one of: .agent.ts, .workflow.ts, .queue.ts, .pipeline.ts, .container.ts, .sandbox.ts, .do.ts.',
        ...violations,
      ].join('\n'),
    );
  }
}

export function resolveClassExportFromFile(
  absPath: string,
  errorLabel: string,
): { className: string; exportKind: 'named' | 'default' } {
  if (!fs.existsSync(absPath)) {
    throw new Error(`[koze] ${errorLabel} file not found: ${absPath}`);
  }
  const fileSource = fs.readFileSync(absPath, 'utf-8');
  const defaultClass = fileSource.match(/export\s+default\s+class\s+(\w+)/);
  if (defaultClass) {
    return { className: defaultClass[1], exportKind: 'default' };
  }
  const namedClass = fileSource.match(/export\s+class\s+(\w+)/);
  if (namedClass) {
    return { className: namedClass[1], exportKind: 'named' };
  }
  throw new Error(`[koze] ${errorLabel} must export a class via "export class X" or "export default class X". File: ${absPath}`);
}

export function discoverConventionClassFiles(
  projectDir: string,
  dir: string,
  suffix: string,
  errorLabel: string,
): ConventionClassEntry[] {
  assertCanonicalConventionFileSuffixes(projectDir);
  const absDir = path.join(projectDir, dir);
  const files = discoverFilesWithSuffix(absDir, suffix);
  if (files.length === 0) return [];

  return files.map((absPath) => {
    const resolved = resolveClassExportFromFile(absPath, errorLabel);
    return {
      className: resolved.className,
      file: path.relative(projectDir, absPath).replace(/\\/g, '/'),
      exportKind: resolved.exportKind,
    };
  });
}

export function discoverFilesWithSuffix(dir: string, suffix: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (absDir: string) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && abs.endsWith(suffix)) {
        out.push(abs);
      }
    }
  };
  walk(dir);
  return out;
}

/** Returns all files in a directory (non-recursive) whose extension is one of the given extensions. */
export function discoverFilesWithExtensions(dir: string, extensions: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  const extSet = new Set(extensions.map((e) => e.toLowerCase()));
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (extSet.has(ext)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

export function discoverWorkflowFiles(projectDir: string): WorkerClassConfigEntry[] {
  assertCanonicalConventionFileSuffixes(projectDir);
  const serverDir = path.join(projectDir, 'src', 'server');
  const files = discoverFilesWithSuffix(serverDir, '.workflow.ts');
  if (files.length === 0) return [];

  return files.map((absPath) => {
    const fileName = path.basename(absPath, '.workflow.ts');
    const binding = fileName.toUpperCase().replace(/-/g, '_') + '_WORKFLOW';
    const resolved = resolveClassExportFromFile(absPath, '.workflow');
    return {
      binding,
      className: resolved.className,
      file: path.relative(projectDir, absPath).replace(/\\/g, '/'),
      exportKind: resolved.exportKind,
    };
  });
}

export function discoverContainerFiles(projectDir: string): ContainerConfigEntry[] {
  assertCanonicalConventionFileSuffixes(projectDir);
  const serverDir = path.join(projectDir, 'src', 'server');
  const files = discoverFilesWithSuffix(serverDir, '.container.ts');
  if (files.length === 0) return [];

  return files.map((absPath) => {
    const fileName = path.basename(absPath, '.container.ts');
    const binding = fileName.toUpperCase().replace(/-/g, '_') + '_CONTAINER';
    const resolved = resolveClassExportFromFile(absPath, '.container');
    const tuning = parseClassStaticTuning(fs.readFileSync(absPath, 'utf-8'));
    const resolvedDockerfile = resolveSiblingDockerfile(absPath, fileName);
    const image = tuning.image ?? (resolvedDockerfile
      ? toRelativePosix(projectDir, resolvedDockerfile)
      : undefined);
    if (!image) {
      throw new Error(
        `[koze] .container file '${path.relative(projectDir, absPath)}' has no image declared. ` +
        `Add \`static image = '...';\` to the class (Dockerfile path or registry reference), ` +
        `or create a sibling Dockerfile at '${fileName}.Dockerfile'.`,
      );
    }
    return {
      kind: 'container' as const,
      binding,
      className: resolved.className,
      file: path.relative(projectDir, absPath).replace(/\\/g, '/'),
      exportKind: resolved.exportKind,
      image,
      instanceType: tuning.instanceType,
      maxInstances: tuning.maxInstances,
      sqlite: tuning.sqlite,
      resolvedDockerfile,
    };
  });
}

/**
 * Discover .sandbox.ts files — the Cloudflare Sandbox SDK variant of a container.
 *
 * Convention: `python.sandbox.ts` → binding `PYTHON_SANDBOX`, class exported via
 * `export default class PythonSandbox extends Sandbox<Env> {}`. SQLite storage is
 * always on (the Sandbox runtime requires it). If no image is declared and no
 * sibling Dockerfile exists, the default image is pinned to the installed
 * `@cloudflare/sandbox` package version so the image stays in lockstep with the SDK.
 */
export function discoverSandboxFiles(projectDir: string): ContainerConfigEntry[] {
  assertCanonicalConventionFileSuffixes(projectDir);
  const serverDir = path.join(projectDir, 'src', 'server');
  const files = discoverFilesWithSuffix(serverDir, '.sandbox.ts');
  if (files.length === 0) return [];

  const defaultImage = resolveSandboxDefaultImage(projectDir);

  return files.map((absPath) => {
    const fileName = path.basename(absPath, '.sandbox.ts');
    const binding = fileName.toUpperCase().replace(/-/g, '_') + '_SANDBOX';
    const resolved = resolveClassExportFromFile(absPath, '.sandbox');
    const tuning = parseClassStaticTuning(fs.readFileSync(absPath, 'utf-8'));
    const resolvedDockerfile = resolveSiblingDockerfile(absPath, fileName);
    const image = tuning.image
      ?? (resolvedDockerfile ? toRelativePosix(projectDir, resolvedDockerfile) : undefined)
      ?? defaultImage;
    return {
      kind: 'sandbox' as const,
      binding,
      className: resolved.className,
      file: path.relative(projectDir, absPath).replace(/\\/g, '/'),
      exportKind: resolved.exportKind,
      image,
      instanceType: tuning.instanceType,
      maxInstances: tuning.maxInstances,
      // Sandbox always uses SQLite storage; ignore any author-supplied `static sqlite`.
      sqlite: true,
      resolvedDockerfile,
    };
  });
}

/**
 * Extract `static <field> = <literal>` declarations from a class source file.
 * Parses only JSON-safe literals (strings, numbers, booleans). Non-literal values
 * (function calls, env lookups, template literals with interpolation) are ignored —
 * wrangler-sync needs compile-time-known values.
 */
export function parseClassStaticTuning(source: string): ClassStaticTuning {
  const tuning: ClassStaticTuning = {};
  const rules: Array<{ field: keyof ClassStaticTuning; match: RegExp; coerce: (raw: string) => any }> = [
    { field: 'image', match: /^\s*static\s+image\s*(?::\s*[^=]+)?=\s*(['"])([^'"]+)\1\s*;?\s*$/m, coerce: (m) => m },
    { field: 'instanceType', match: /^\s*static\s+instanceType\s*(?::\s*[^=]+)?=\s*(['"])(lite|standard)\1\s*;?\s*$/m, coerce: (m) => m },
    { field: 'maxInstances', match: /^\s*static\s+maxInstances\s*(?::\s*[^=]+)?=\s*(\d+)\s*;?\s*$/m, coerce: (m) => Number(m) },
    { field: 'sqlite', match: /^\s*static\s+sqlite\s*(?::\s*[^=]+)?=\s*(true|false)\s*;?\s*$/m, coerce: (m) => m === 'true' },
  ];

  for (const rule of rules) {
    const match = source.match(rule.match);
    if (!match) continue;
    // For patterns with a quoted capture, the second group holds the value;
    // otherwise the first group is the raw value.
    const raw = match[2] ?? match[1];
    (tuning as any)[rule.field] = rule.coerce(raw);
  }

  return tuning;
}

/** Look for `<basename>.Dockerfile` next to the source file. Returns abs path or null. */
function resolveSiblingDockerfile(sourceAbsPath: string, basename: string): string | null {
  const dir = path.dirname(sourceAbsPath);
  const candidates = [
    path.join(dir, `${basename}.Dockerfile`),
    path.join(dir, basename, 'Dockerfile'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function toRelativePosix(projectDir: string, absPath: string): string {
  const rel = path.relative(projectDir, absPath).replace(/\\/g, '/');
  return rel.startsWith('.') || rel.startsWith('/') ? rel : `./${rel}`;
}

/**
 * Read the installed `@cloudflare/sandbox` package version and produce
 * `docker.io/cloudflare/sandbox:<version>` as the default image. Falls back
 * to the generic `:latest` tag if the package isn't locally installed — the
 * subsequent `wrangler deploy` will surface a clearer error than we can here.
 */
function resolveSandboxDefaultImage(projectDir: string): string {
  try {
    const pkgPath = path.join(projectDir, 'node_modules', '@cloudflare', 'sandbox', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
      if (pkg.version) return `docker.io/cloudflare/sandbox:${pkg.version}`;
    }
  } catch {
    // fall through
  }
  return 'docker.io/cloudflare/sandbox:latest';
}

/**
 * Discover queue consumer files in src/server/*.queue.ts
 * 
 * Convention: notifications.queue.ts → expects NOTIFICATIONS queue binding
 * The file must export a default async function that handles MessageBatch.
 */
export function discoverQueueConsumerFiles(projectDir: string): QueueConsumerEntry[] {
  assertCanonicalConventionFileSuffixes(projectDir);
  const serverDir = path.join(projectDir, 'src', 'server');
  const files = discoverFilesWithSuffix(serverDir, '.queue.ts');
  if (files.length === 0) return [];

  return files.map((absPath) => {
    const fileName = path.basename(absPath, '.queue.ts');
    const binding = fileName.toUpperCase().replace(/-/g, '_');
    // Queue name is the filename as-is (lowercase with hyphens) - this is what Cloudflare sends in batch.queue
    const queueName = fileName;
    const exportKind = resolveQueueHandlerExport(absPath);
    return {
      binding,
      queueName,
      file: path.relative(projectDir, absPath).replace(/\\/g, '/'),
      exportKind,
    };
  });
}

/**
 * Discover Cloudflare Pipelines binding declarations in src/server/*.pipeline.ts.
 *
 * Convention: `analytics.pipeline.ts` becomes:
 *   - framework name: `analytics`
 *   - env binding: `ANALYTICS_PIPELINE`
 *   - wrangler entry: `{ "pipeline": "analytics", "binding": "ANALYTICS_PIPELINE" }`
 *
 * Override the Cloudflare resource with `export const pipeline = 'stream-id-or-name'`.
 * `export const stream = '...'` is accepted as an alias because the current
 * Cloudflare docs describe Pipelines bindings as writing to streams.
 */
export function discoverPipelineFiles(projectDir: string): PipelineConfigEntry[] {
  assertCanonicalConventionFileSuffixes(projectDir);
  const serverDir = path.join(projectDir, 'src', 'server');
  const files = discoverFilesWithSuffix(serverDir, '.pipeline.ts');
  if (files.length === 0) return [];

  return files.map((absPath) => {
    const fileName = path.basename(absPath, '.pipeline.ts');
    const source = fs.readFileSync(absPath, 'utf-8');
    const config = parsePipelineFileConfig(source);
    return {
      name: fileName,
      binding: config.binding ?? `${fileName.toUpperCase().replace(/-/g, '_')}_PIPELINE`,
      pipeline: config.pipeline ?? config.stream ?? fileName,
      pipelineName: config.pipelineName,
      schema: config.schema,
      sink: config.sink,
      sql: config.sql,
      file: path.relative(projectDir, absPath).replace(/\\/g, '/'),
    };
  });
}

interface PipelineFileConfig {
  binding?: string;
  pipeline?: string;
  pipelineName?: string;
  stream?: string;
  schema?: PipelineSchemaConfig;
  sink?: PipelineSinkConfig;
  sql?: string;
}

function parsePipelineFileConfig(source: string): PipelineFileConfig {
  const sourceFile = ts.createSourceFile('pipeline.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const config: PipelineFileConfig = {};

  for (const stmt of sourceFile.statements) {
    if (ts.isExportAssignment(stmt)) {
      const defaultValue = parseDefaultPipelineConfig(stmt);
      if (defaultValue && typeof defaultValue === 'object' && !Array.isArray(defaultValue)) {
        for (const [key, value] of Object.entries(defaultValue as Record<string, unknown>)) {
          assignPipelineConfigValue(config, key, value);
        }
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const isExported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!isExported) continue;

    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        assignPipelineConfigValue(config, decl.name.text, literalExpressionToValue(decl.initializer));
      }
      continue;
    }

  }

  return config;
}

function parseDefaultPipelineConfig(stmt: ts.Statement): unknown {
  if (!ts.isExportAssignment(stmt)) return undefined;
  const expr = unwrapLiteralExpression(stmt.expression);
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    if (
      (ts.isIdentifier(callee) && callee.text === 'definePipeline') ||
      (ts.isPropertyAccessExpression(callee) && callee.name.text === 'definePipeline')
    ) {
      return expr.arguments.length > 0 ? literalExpressionToValue(expr.arguments[0]) : undefined;
    }
  }
  return literalExpressionToValue(expr);
}

function assignPipelineConfigValue(config: PipelineFileConfig, key: string, value: unknown): void {
  if ((key === 'binding' || key === 'pipeline' || key === 'pipelineName' || key === 'stream' || key === 'sql') && typeof value === 'string') {
    config[key] = value;
    return;
  }
  if (key === 'schema' && isPipelineSchemaConfig(value)) {
    config.schema = value;
    return;
  }
  if (key === 'sink' && isPipelineSinkConfig(value)) {
    config.sink = value;
  }
}

function isPipelineSchemaConfig(value: unknown): value is PipelineSchemaConfig {
  if (Array.isArray(value)) {
    return value.every((field) => (
      field !== null &&
      typeof field === 'object' &&
      typeof (field as { name?: unknown }).name === 'string' &&
      typeof (field as { type?: unknown }).type === 'string' &&
      (
        (field as { required?: unknown }).required === undefined ||
        typeof (field as { required?: unknown }).required === 'boolean'
      )
    ));
  }
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every((field) => (
    typeof field === 'string' ||
    (
      field !== null &&
      typeof field === 'object' &&
      typeof (field as { type?: unknown }).type === 'string' &&
      (
        (field as { required?: unknown }).required === undefined ||
        typeof (field as { required?: unknown }).required === 'boolean'
      )
    )
  ));
}

function isPipelineSinkConfig(value: unknown): value is PipelineSinkConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const sink = value as Record<string, unknown>;
  return sink.type === 'r2-data-catalog' &&
    typeof sink.bucket === 'string' &&
    typeof sink.table === 'string' &&
    (sink.name === undefined || typeof sink.name === 'string') &&
    (sink.namespace === undefined || typeof sink.namespace === 'string') &&
    (sink.rollInterval === undefined || typeof sink.rollInterval === 'number') &&
    (sink.rollSize === undefined || typeof sink.rollSize === 'number') &&
    (sink.compression === undefined || typeof sink.compression === 'string') &&
    (sink.targetRowGroupSize === undefined || typeof sink.targetRowGroupSize === 'number');
}

function literalExpressionToValue(node: ts.Node): unknown {
  const expr = unwrapLiteralExpression(node);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(expr) && ts.isNumericLiteral(expr.operand)) {
    const value = Number(expr.operand.text);
    if (expr.operator === ts.SyntaxKind.MinusToken) return -value;
    if (expr.operator === ts.SyntaxKind.PlusToken) return value;
  }
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.map((element) => literalExpressionToValue(element));
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const out: Record<string, unknown> = {};
    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop)) return undefined;
      const key = propertyNameToString(prop.name);
      if (!key) return undefined;
      out[key] = literalExpressionToValue(prop.initializer);
    }
    return out;
  }
  return undefined;
}

function unwrapLiteralExpression(node: ts.Node): ts.Expression {
  let expr = node as ts.Expression;
  while (
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isParenthesizedExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    expr = expr.expression;
  }
  return expr;
}

function propertyNameToString(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/**
 * Discover Cloudflare AI Agent class files in `src/server/**\/*.agent.ts`.
 *
 * Convention: `kuratchi-ai-session.agent.ts` → exports
 * `KuratchiAiSession` (or `default`) class extending `AIChatAgent` /
 * `Agent` from the `agents` package. The class is bound as a Durable
 * Object and accessed via `getAgentByName(env.<BINDING>, name)`.
 *
 * Unlike `.workflow.ts` / `.do.ts` / `.container.ts` etc., the binding
 * NAME for an agent class isn't derived from the filename — Cloudflare
 * Workers manages those bindings explicitly in `wrangler.jsonc`'s
 * `durable_objects.bindings` block. So this discovery only handles the
 * RE-EXPORT side (the worker entry must surface the class as a named
 * export); the binding declarations themselves stay author-managed.
 *
 * Discovery is recursive within `src/server/` so apps can organize
 * agents under subdirectories (e.g. `src/server/ai/<name>.agent.ts`).
 */
export function discoverAgentFiles(projectDir: string): ConventionClassEntry[] {
  assertCanonicalConventionFileSuffixes(projectDir);
  const serverDir = path.join(projectDir, 'src', 'server');
  const files = discoverFilesWithSuffix(serverDir, '.agent.ts');
  if (files.length === 0) return [];

  return files.map((absPath) => {
    const resolved = resolveClassExportFromFile(absPath, '.agent');
    return {
      className: resolved.className,
      file: path.relative(projectDir, absPath).replace(/\\/g, '/'),
      exportKind: resolved.exportKind,
    };
  });
}

function resolveQueueHandlerExport(absPath: string): 'named' | 'default' {
  if (!fs.existsSync(absPath)) {
    throw new Error(`[koze] .queue file not found: ${absPath}`);
  }
  const fileSource = fs.readFileSync(absPath, 'utf-8');
  // Check for default export (function or async function)
  if (/export\s+default\s+(async\s+)?function/.test(fileSource)) {
    return 'default';
  }
  // Check for named export called 'queue' or 'handler'
  if (/export\s+(async\s+)?function\s+(queue|handler)\s*\(/.test(fileSource)) {
    return 'named';
  }
  throw new Error(
    `[koze] .queue file must export a default function or a named "queue"/"handler" function. File: ${absPath}`
  );
}
