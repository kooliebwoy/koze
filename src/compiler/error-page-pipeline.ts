import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileTemplate } from './template.js';

export function compileErrorPages(routesDir: string): Map<number, string> {
  const compiledErrorPages = new Map<number, string>();

  for (const file of fs.readdirSync(routesDir)) {
    const match = file.match(/^(\d{3})\.(?:koze|kuratchi)$/);
    if (!match) continue;

    const status = parseInt(match[1], 10);
    const source = fs.readFileSync(path.join(routesDir, file), 'utf-8');
    const body = compileTemplate(source);
    compiledErrorPages.set(status, `function __error_${status}(error) {\n  ${body}\n  return __html;\n}`);
  }

  return compiledErrorPages;
}
