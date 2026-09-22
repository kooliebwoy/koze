import * as fs from 'node:fs';
import * as path from 'node:path';

export type NativeWorkerAuditKind =
  | 'convention-file'
  | 'direct-do-rpc-import'
  | 'removed-api'
  | 'generated-infrastructure'
  | 'worker-entry';

export interface NativeWorkerAuditFinding {
  kind: NativeWorkerAuditKind;
  file: string;
  message: string;
  action: string;
}

const CONVENTION_FILE_RE = /\.(agent|workflow|queue|pipeline|container|sandbox|do)\.(ts|js|mjs)$/;
const SOURCE_EXT_RE = /\.(ts|js|mjs|koze)$/;
const IGNORED_DIRS = new Set(['.git', '.koze', '.wrangler', 'dist', 'node_modules']);

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(root);
  return files.sort();
}

function relative(projectDir: string, file: string): string {
  return path.relative(projectDir, file).replace(/\\/g, '/');
}

export function auditNativeWorkerMigration(projectDir: string): NativeWorkerAuditFinding[] {
  const root = path.resolve(projectDir);
  const findings: NativeWorkerAuditFinding[] = [];
  const sourceFiles = walkFiles(path.join(root, 'src'));

  for (const file of sourceFiles) {
    const rel = relative(root, file);
    if (CONVENTION_FILE_RE.test(file)) {
      findings.push({
        kind: 'convention-file',
        file: rel,
        message: 'This former Cloudflare convention is now an ordinary module name.',
        action: 'Rename it for clarity and explicitly configure/export the native Cloudflare primitive.',
      });
    }
    if (!SOURCE_EXT_RE.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (/from\s+['"]\$server\/[^'"]+\.do(?:\.[cm]?[jt]s)?['"]/.test(source)) {
      findings.push({
        kind: 'direct-do-rpc-import',
        file: rel,
        message: 'Direct browser RPC to a former .do module hides identity selection and authorization.',
        action: 'Import an ordinary $server boundary function that authorizes, selects the DO identity, and calls the native stub.',
      });
    }
    if (/(?:koze:(?:workflow|pipeline|access|assets)|@kuratchi\/koze\/(?:workflow|pipeline|access)|@kuratchi\/koze\/runtime\/(?:do|workflow|pipeline|access|assets|containers)\.js)/.test(source)) {
      findings.push({
        kind: 'removed-api',
        file: rel,
        message: 'This source imports a removed Cloudflare product wrapper.',
        action: 'Replace it with the native binding/API or the product-owning integration package.',
      });
    }
  }

  const workerPath = path.join(root, 'src', 'worker.ts');
  if (!fs.existsSync(workerPath)) {
    findings.push({
      kind: 'worker-entry',
      file: 'src/worker.ts',
      message: 'The application has no explicit Worker entrypoint.',
      action: "Create src/worker.ts, import { handleRequest } from 'koze:worker', and compose the native default export.",
    });
  } else {
    const worker = fs.readFileSync(workerPath, 'utf8');
    if (/export\s+\{\s*default\s*\}\s+from\s+['"]koze:worker['"]/.test(worker) || /export\s+\*\s+from\s+['"]koze:worker['"]/.test(worker)) {
      findings.push({
        kind: 'worker-entry',
        file: 'src/worker.ts',
        message: 'The Worker still re-exports Koze\'s removed synthetic default/platform exports.',
        action: "Import handleRequest and compose `export default { fetch: handleRequest }` with explicit native named exports and handlers.",
      });
    }
  }

  const generatedInfrastructure = path.join(root, '_cloudflare');
  if (fs.existsSync(generatedInfrastructure)) {
    findings.push({
      kind: 'generated-infrastructure',
      file: '_cloudflare/',
      message: 'This directory may contain Koze-generated Pipeline or API Shield artifacts.',
      action: 'Review each artifact, move intentionally owned infrastructure to its permanent location, then remove obsolete generated files.',
    });
  }

  return findings;
}
