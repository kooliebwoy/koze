import { afterEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  discoverContentEntries,
  discoverContentGroupNames,
} from '../src/compiler/content-discovery.js';
import { createContentRegistry } from '../src/runtime/content.js';

function createTempProject(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kuratchi-content-${name}-`));
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('content', () => {
  const projectDirs: string[] = [];

  afterEach(() => {
    for (const dir of projectDirs.splice(0)) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('discovers Markdown entries under src/content groups', () => {
    const projectDir = createTempProject('discovery');
    projectDirs.push(projectDir);
    write(path.join(projectDir, 'src', 'content', 'docs', 'getting-started.md'), '# Start\n');
    write(path.join(projectDir, 'src', 'content', 'docs', 'settings', 'index.md'), '# Settings\n');
    write(path.join(projectDir, 'src', 'content', 'blog', 'hello.md'), '# Hello\n');

    const entries = discoverContentEntries(projectDir);

    expect(discoverContentGroupNames(projectDir)).toEqual(['blog', 'docs']);
    expect(entries.map((entry) => [entry.group, entry.id, entry.href, entry.file])).toEqual([
      ['blog', 'hello', '/blog/hello', 'src/content/blog/hello.md'],
      ['docs', 'getting-started', '/docs/getting-started', 'src/content/docs/getting-started.md'],
      ['docs', 'settings', '/docs/settings', 'src/content/docs/settings/index.md'],
    ]);
  });

  test('rejects loose Markdown files directly under src/content', () => {
    const projectDir = createTempProject('loose-file');
    projectDirs.push(projectDir);
    write(path.join(projectDir, 'src', 'content', 'about.md'), '# About\n');

    expect(() => discoverContentEntries(projectDir)).toThrow(
      /Markdown content lives in src\/content\/<name>/,
    );
  });

  test('lists and renders content with frontmatter, headings, and safe HTML', async () => {
    const registry = createContentRegistry([
      {
        group: 'docs',
        id: 'settings/api-keys',
        href: '/docs/settings/api-keys',
        file: 'src/content/docs/settings/api-keys.md',
        source: `---
title: API Keys
description: Create and rotate API keys.
section: Settings
order: 10
---

# API Keys

Use \`tokens\` carefully.

<script>alert('nope')</script>

## Rotate keys

- [x] Create a replacement
`,
      },
    ]);

    const list = await registry.docs.list();
    const doc = await registry.docs.render('settings/api-keys');

    expect(list).toEqual([
      expect.objectContaining({
        id: 'settings/api-keys',
        title: 'API Keys',
        description: 'Create and rotate API keys.',
        section: 'Settings',
        order: 10,
        headings: [
          { depth: 1, slug: 'api-keys', text: 'API Keys' },
          { depth: 2, slug: 'rotate-keys', text: 'Rotate keys' },
        ],
      }),
    ]);
    expect(doc?.html).toContain('<h1 id="api-keys">API Keys</h1>');
    expect(doc?.html).toContain('<code>tokens</code>');
    expect(doc?.html).toContain('type="checkbox"');
    expect(doc?.html).not.toContain('<script>');
  });
});
