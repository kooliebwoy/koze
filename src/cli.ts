#!/usr/bin/env node

import { create } from './create/index.js';
import { auditNativeWorkerMigration } from './migration-audit.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage:
  koze create [project-name] [--yes] [--do]
  koze [project-name] [--yes] [--do]
  koze audit-native-worker [project-directory] [--json]
`);
  process.exit(0);
}

if (args[0] === 'audit-native-worker') {
  args.shift();
  const json = args.includes('--json');
  const projectDir = args.find((arg) => !arg.startsWith('-')) ?? process.cwd();
  const findings = auditNativeWorkerMigration(projectDir);
  if (json) {
    console.log(JSON.stringify(findings, null, 2));
  } else if (findings.length === 0) {
    console.log('Koze native Worker audit: no migration findings.');
  } else {
    console.log(`Koze native Worker audit: ${findings.length} finding(s).`);
    for (const finding of findings) {
      console.log(`\n[${finding.kind}] ${finding.file}`);
      console.log(`  ${finding.message}`);
      console.log(`  Action: ${finding.action}`);
    }
  }
  process.exitCode = findings.length > 0 ? 1 : 0;
} else {
  const command = args[0] === 'create' ? args.shift() : null;
  void command;

  const projectName = args.find((arg) => !arg.startsWith('-'));
  const flags = args.filter((arg) => arg.startsWith('-'));

  await create(projectName, flags);
}
