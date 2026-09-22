import { afterEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { auditNativeWorkerMigration } from '../src/migration-audit.js';

describe('native Worker migration audit', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('reports former conventions and synthetic Worker ownership without mutating files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koze-native-audit-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'src', 'server'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'routes'), { recursive: true });
    fs.mkdirSync(path.join(root, '_cloudflare'), { recursive: true });
    const doFile = path.join(root, 'src', 'server', 'account.do.ts');
    const routeFile = path.join(root, 'src', 'routes', 'index.koze');
    const workerFile = path.join(root, 'src', 'worker.ts');
    fs.writeFileSync(doFile, 'export class Account {}\n');
    fs.writeFileSync(routeFile, "<script>import { load } from '$server/account.do';</script>\n");
    fs.writeFileSync(workerFile, "export { default } from 'koze:worker';\nexport * from 'koze:worker';\n");

    const before = fs.readFileSync(workerFile, 'utf8');
    const findings = auditNativeWorkerMigration(root);

    expect(findings.map((finding) => finding.kind).sort()).toEqual([
      'convention-file',
      'direct-do-rpc-import',
      'generated-infrastructure',
      'worker-entry',
    ]);
    expect(fs.readFileSync(workerFile, 'utf8')).toBe(before);
  });

  test('accepts a native Worker project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koze-native-audit-clean-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'src', 'server'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'worker.ts'),
      "import { handleRequest } from 'koze:worker';\nexport default { fetch: handleRequest };\n",
    );
    fs.writeFileSync(path.join(root, 'src', 'server', 'account-object.ts'), 'export class Account {}\n');

    expect(auditNativeWorkerMigration(root)).toEqual([]);
  });
});
