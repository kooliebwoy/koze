#!/usr/bin/env node

import { create } from './create/index.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage:
  koze create [project-name] [--yes] [--do]
  koze [project-name] [--yes] [--do]
`);
  process.exit(0);
}

const command = args[0] === 'create' ? args.shift() : null;
void command;

const projectName = args.find((arg) => !arg.startsWith('-'));
const flags = args.filter((arg) => arg.startsWith('-'));

await create(projectName, flags);
