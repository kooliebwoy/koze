import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

import { collectExportedApiMethods, type ApiMethod } from './api-route-pipeline.js';

export interface ApiShieldOptions {
  enabled?: boolean;
  title?: string;
  version?: string;
  outputPath?: string;
  servers?: string[];
  include?: string[];
}

export interface ApiShieldRouteMetadata {
  pattern: string;
  file: string;
  methods: ApiMethod[];
  manifest: Record<string, unknown>;
  apiShieldFile: string | null;
}

export interface ResolvedApiShieldOptions {
  enabled: boolean;
  title: string;
  version: string;
  outputPath: string;
  servers: string[];
  include: string[];
}

const DEFAULT_API_SHIELD_OUTPUT = '_cloudflare/api-shield/openapi.json';
const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const API_METHOD_SET = new Set<string>(API_METHODS);

export function resolveApiShieldOptions(options?: boolean | ApiShieldOptions): ResolvedApiShieldOptions {
  if (options === false) {
    return {
      enabled: false,
      title: 'Koze API',
      version: '1.0.0',
      outputPath: DEFAULT_API_SHIELD_OUTPUT,
      servers: [],
      include: [],
    };
  }

  const config = options === true || options === undefined ? {} : options;
  return {
    enabled: config.enabled ?? true,
    title: config.title ?? 'Koze API',
    version: config.version ?? '1.0.0',
    outputPath: config.outputPath ?? DEFAULT_API_SHIELD_OUTPUT,
    servers: config.servers ?? [],
    include: config.include ?? [],
  };
}

export function readApiShieldRouteMetadata(opts: {
  projectDir: string;
  pattern: string;
  fullPath: string;
}): ApiShieldRouteMetadata {
  const source = fs.readFileSync(opts.fullPath, 'utf-8');
  const file = path.relative(opts.projectDir, opts.fullPath).replace(/\\/g, '/');
  const routeManifest = extractStaticManifest(source, opts.fullPath);
  const sidecar = readApiShieldSidecar(opts.projectDir, opts.fullPath);
  return {
    pattern: opts.pattern,
    file,
    methods: collectExportedApiMethods(source, opts.fullPath),
    manifest: mergeApiShieldMetadata(routeManifest, sidecar?.metadata ?? null),
    apiShieldFile: sidecar?.file ?? null,
  };
}

export function writeApiShieldOpenApi(opts: {
  projectDir: string;
  routes: ApiShieldRouteMetadata[];
  options?: boolean | ApiShieldOptions;
  writeFile: (filePath: string, content: string) => void;
}): string | null {
  const options = resolveApiShieldOptions(opts.options);
  if (!options.enabled) return null;

  const routes = opts.routes
    .filter((route) => route.methods.length > 0)
    .filter((route) => shouldIncludeRoute(route.pattern, options.include));
  if (routes.length === 0) return null;

  const document = generateApiShieldOpenApi(routes, options);
  const outputPath = path.join(opts.projectDir, options.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  opts.writeFile(outputPath, JSON.stringify(document, null, 2) + '\n');
  const outputDir = path.dirname(outputPath);
  opts.writeFile(path.join(outputDir, 'api-shield.tf'), generateApiShieldTerraform(routes));
  opts.writeFile(path.join(outputDir, 'README.md'), generateApiShieldReadme(path.relative(opts.projectDir, outputPath).replace(/\\/g, '/')));
  return outputPath;
}

export function generateApiShieldOpenApi(
  routes: ApiShieldRouteMetadata[],
  options: ResolvedApiShieldOptions,
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  let usesBearerAuth = false;

  for (const route of routes) {
    const openApiPath = patternToOpenApiPath(route.pattern, route.file);
    const pathItem = paths[openApiPath] ?? {};
    paths[openApiPath] = pathItem;

    for (const method of route.methods) {
      const operation = routeToOperation(route, method, openApiPath);
      if (Array.isArray(operation.security)) usesBearerAuth = true;
      pathItem[method.toLowerCase()] = operation;
    }
  }

  const document: Record<string, unknown> = {
    openapi: '3.0.3',
    info: {
      title: options.title,
      version: options.version,
    },
    paths,
  };

  if (options.servers.length > 0) {
    document.servers = options.servers.map((url) => ({ url }));
  }

  if (usesBearerAuth) {
    document.components = {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
    };
  }

  return document;
}

function shouldIncludeRoute(pattern: string, include: string[]): boolean {
  if (include.length === 0) return true;
  return include.some((prefix) => {
    const normalized = normalizePathPrefix(prefix);
    return pattern === normalized || pattern.startsWith(`${normalized}/`);
  });
}

function normalizePathPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) return '/';
  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/g, '') : prefixed;
}

function routeToOperation(
  route: ApiShieldRouteMetadata,
  method: ApiMethod,
  openApiPath: string,
): Record<string, unknown> {
  const manifest = metadataForMethod(route.manifest, method);
  const operation: Record<string, unknown> = {
    operationId: typeof manifest.operationId === 'string'
      ? manifest.operationId
      : defaultOperationId(method, openApiPath),
    responses: normalizeResponses(manifest.responses),
  };

  if (typeof manifest.summary === 'string') operation.summary = manifest.summary;
  if (typeof manifest.description === 'string') operation.description = manifest.description;
  if (Array.isArray(manifest.tags) && manifest.tags.every((tag) => typeof tag === 'string')) {
    operation.tags = manifest.tags;
  }
  if (manifest.auth === 'required' || manifest.auth === 'bearer') {
    operation.security = [{ bearerAuth: [] }];
  }

  const parameters = [
    ...pathParameters(openApiPath, manifest.params),
    ...queryParameters(manifest.query),
  ];
  if (parameters.length > 0) operation.parameters = parameters;

  if (manifest.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    operation.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: toOpenApiSchema(manifest.body),
        },
      },
    };
  }

  return operation;
}

function pathParameters(openApiPath: string, params: unknown): Record<string, unknown>[] {
  const schemas = isPlainObject(params) ? params : {};
  const names = Array.from(openApiPath.matchAll(/\{([^}]+)\}/g)).map((match) => match[1]);
  return names.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: toOpenApiSchema(schemas[name] ?? { type: 'string' }),
  }));
}

function queryParameters(query: unknown): Record<string, unknown>[] {
  if (!isPlainObject(query)) return [];
  return Object.entries(query).map(([name, schema]) => ({
    name,
    in: 'query',
    required: isPlainObject(schema) && schema.required === true,
    schema: toOpenApiSchema(schema),
  }));
}

function normalizeResponses(responses: unknown): Record<string, unknown> {
  if (!isPlainObject(responses)) {
    return {
      '200': {
        description: 'OK',
      },
    };
  }

  const out: Record<string, unknown> = {};
  for (const [status, response] of Object.entries(responses)) {
    out[String(status)] = isPlainObject(response)
      ? response
      : { description: String(response) };
  }
  return out;
}

function toOpenApiSchema(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return { type: value };
  if (isPlainObject(value)) {
    const { required: _required, ...schema } = value;
    return schema;
  }
  if (Array.isArray(value)) return { type: 'array', items: toOpenApiSchema(value[0] ?? 'string') };
  if (typeof value === 'number') return { type: 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  return { type: 'object' };
}

function patternToOpenApiPath(pattern: string, file: string): string {
  const catchAllNames = Array.from(file.matchAll(/\[\.\.\.([^\]]+)\]/g)).map((match) => match[1]);
  let catchAllIndex = 0;
  return pattern
    .replace(/:([A-Za-z_$][\w$-]*)/g, '{$1}')
    .replace(/\*/g, () => `{${catchAllNames[catchAllIndex++] ?? 'wildcard'}}`);
}

function defaultOperationId(method: ApiMethod, openApiPath: string): string {
  const suffix = openApiPath
    .replace(/[{}]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return `${method.toLowerCase()}${suffix ? `_${suffix}` : ''}`;
}

function generateApiShieldTerraform(routes: ApiShieldRouteMetadata[]): string {
  const operations = apiShieldOperations(routes);
  const operationEntries = operations.map((operation) => [
    `    ${operation.key} = {`,
    `      method   = ${JSON.stringify(operation.method)}`,
    `      endpoint = ${JSON.stringify(operation.endpoint)}`,
    '    }',
  ].join('\n'));

  return [
    'terraform {',
    '  required_providers {',
    '    cloudflare = {',
    '      source = "cloudflare/cloudflare"',
    '    }',
    '  }',
    '}',
    '',
    'variable "zone_id" {',
    '  description = "Cloudflare zone id that serves this API hostname."',
    '  type        = string',
    '}',
    '',
    'variable "api_host" {',
    '  description = "Public hostname for the API, for example api.example.com."',
    '  type        = string',
    '}',
    '',
    'variable "schema_validation_mitigation_action" {',
    '  description = "Schema validation action. Start with log, then move to block after reviewing Security Events."',
    '  type        = string',
    '  default     = "log"',
    '',
    '  validation {',
    '    condition     = contains(["none", "log", "block"], var.schema_validation_mitigation_action)',
    '    error_message = "Use one of: none, log, block."',
    '  }',
    '}',
    '',
    'variable "auth_id_characteristics" {',
    '  description = "API Shield session identifier characteristics."',
    '  type = list(object({',
    '    name = string',
    '    type = string',
    '  }))',
    '  default = [',
    '    {',
    '      name = "authorization"',
    '      type = "header"',
    '    },',
    '    {',
    '      name = "x-api-key"',
    '      type = "header"',
    '    },',
    '  ]',
    '}',
    '',
    'locals {',
    '  api_operations = {',
    ...operationEntries,
    '  }',
    '}',
    '',
    'resource "cloudflare_api_shield" "kuratchi_session_identifiers" {',
    '  zone_id = var.zone_id',
    '',
    '  auth_id_characteristics = var.auth_id_characteristics',
    '}',
    '',
    'resource "cloudflare_api_shield_operation" "kuratchi" {',
    '  for_each = local.api_operations',
    '',
    '  zone_id  = var.zone_id',
    '  method   = each.value.method',
    '  host     = var.api_host',
    '  endpoint = each.value.endpoint',
    '}',
    '',
    'resource "cloudflare_schema_validation_schemas" "kuratchi" {',
    '  zone_id            = var.zone_id',
    '  kind               = "openapi_v3"',
    '  name               = "kuratchi-api.openapi.json"',
    '  source             = file("${path.module}/openapi.json")',
    '  validation_enabled = true',
    '',
    '  depends_on = [',
    '    cloudflare_api_shield_operation.koze,',
    '  ]',
    '}',
    '',
    'resource "cloudflare_schema_validation_settings" "kuratchi" {',
    '  zone_id                              = var.zone_id',
    '  validation_default_mitigation_action = var.schema_validation_mitigation_action',
    '}',
    '',
    'resource "cloudflare_schema_validation_operation_settings" "kuratchi" {',
    '  for_each = cloudflare_api_shield_operation.koze',
    '',
    '  zone_id           = var.zone_id',
    '  operation_id      = each.value.id',
    '  mitigation_action = var.schema_validation_mitigation_action',
    '}',
    '',
  ].join('\n');
}

function generateApiShieldReadme(openApiPath: string): string {
  return [
    '# API Shield',
    '',
    'Generated by Koze from route-adjacent `*.api-shield.ts` files and legacy API route `manifest` exports. Change the source file beside the API route, then rerun Vite or the compiler to regenerate these files.',
    '',
    '## Files',
    '',
    `- \`${openApiPath}\`: OpenAPI schema for Cloudflare API Shield Schema Validation.`,
    '- `api-shield.tf`: Terraform helper for Endpoint Management, Schema Validation, and session identifiers.',
    '',
    '## Rollout',
    '',
    '1. Run the Koze build so these files are current.',
    '2. Set `api_host` to the public API hostname and `zone_id` to the Cloudflare zone.',
    '3. Apply Terraform with `schema_validation_mitigation_action = "log"`.',
    '4. Review Cloudflare Security Events for schema validation results.',
    '5. Move the action to `block` once expected traffic is clean.',
    '',
  ].join('\n');
}

function apiShieldOperations(routes: ApiShieldRouteMetadata[]): Array<{ key: string; method: ApiMethod; endpoint: string }> {
  const used = new Set<string>();
  const operations: Array<{ key: string; method: ApiMethod; endpoint: string }> = [];

  for (const route of routes) {
    const endpoint = patternToOpenApiPath(route.pattern, route.file);
    for (const method of route.methods) {
      const manifest = metadataForMethod(route.manifest, method);
      const operationId = typeof manifest.operationId === 'string'
        ? manifest.operationId
        : defaultOperationId(method, endpoint);
      const baseKey = toTerraformKey(`${method.toLowerCase()}_${operationId}`);
      let key = baseKey;
      let index = 2;
      while (used.has(key)) {
        key = `${baseKey}_${index++}`;
      }
      used.add(key);
      operations.push({ key, method, endpoint });
    }
  }

  return operations;
}

function toTerraformKey(input: string): string {
  const normalized = input
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return /^[A-Za-z_]/.test(normalized) ? normalized : `op_${normalized || 'api'}`;
}

function readApiShieldSidecar(projectDir: string, routePath: string): { file: string; metadata: Record<string, unknown> } | null {
  const sidecarPath = resolveApiShieldSidecarPath(routePath);
  if (!fs.existsSync(sidecarPath)) return null;
  const source = fs.readFileSync(sidecarPath, 'utf-8');
  const metadata = extractStaticApiShield(source, sidecarPath);
  return {
    file: path.relative(projectDir, sidecarPath).replace(/\\/g, '/'),
    metadata,
  };
}

function resolveApiShieldSidecarPath(routePath: string): string {
  return routePath.replace(/\.(ts|js)$/i, '.api-shield.$1');
}

function mergeApiShieldMetadata(
  routeManifest: Record<string, unknown>,
  sidecarMetadata: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!sidecarMetadata) return routeManifest;
  const merged: Record<string, unknown> = { ...routeManifest };
  for (const [key, value] of Object.entries(sidecarMetadata)) {
    if (API_METHOD_SET.has(key) && isPlainObject(value) && isPlainObject(routeManifest[key])) {
      merged[key] = { ...(routeManifest[key] as Record<string, unknown>), ...value };
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function metadataForMethod(metadata: Record<string, unknown>, method: ApiMethod): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!API_METHOD_SET.has(key)) base[key] = value;
  }
  const methodMetadata = metadata[method];
  return isPlainObject(methodMetadata)
    ? { ...base, ...methodMetadata }
    : metadata;
}

function extractStaticApiShield(source: string, fileName: string): Record<string, unknown> {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      const value = literalToJson(unwrapApiShieldCall(statement.expression));
      return isPlainObject(value) ? value : {};
    }

    if (!ts.isVariableStatement(statement)) continue;
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'apiShield' || !declaration.initializer) continue;
      const value = literalToJson(unwrapApiShieldCall(declaration.initializer));
      return isPlainObject(value) ? value : {};
    }
  }

  return {};
}

function unwrapApiShieldCall(expression: ts.Expression): ts.Expression {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isCallExpression(unwrapped)) return unwrapped;
  const callee = unwrapped.expression;
  const isHelperCall = (ts.isIdentifier(callee) && (callee.text === 'defineApiShield' || callee.text === 'apiShield')) ||
    (ts.isPropertyAccessExpression(callee) && (callee.name.text === 'defineApiShield' || callee.name.text === 'apiShield'));
  return isHelperCall && unwrapped.arguments.length > 0
    ? unwrapExpression(unwrapped.arguments[0] as ts.Expression)
    : unwrapped;
}

function extractStaticManifest(source: string, fileName: string): Record<string, unknown> {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'manifest' || !declaration.initializer) continue;
      const value = literalToJson(unwrapExpression(declaration.initializer));
      return isPlainObject(value) ? value : {};
    }
  }

  return {};
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function literalToJson(expression: ts.Expression): unknown {
  expression = unwrapExpression(expression);

  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return null;

  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.map((element) => literalToJson(element as ts.Expression));
  }

  if (ts.isObjectLiteralExpression(expression)) {
    const out: Record<string, unknown> = {};
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = propertyNameToString(property.name);
      if (!name) continue;
      const value = literalToJson(property.initializer);
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  return undefined;
}

function propertyNameToString(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
