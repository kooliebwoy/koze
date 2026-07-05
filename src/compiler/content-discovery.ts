import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_CONTENT_DIR = 'src/content';

export interface DiscoveredContentEntry {
  group: string;
  id: string;
  href: string;
  file: string;
  absPath: string;
}

export function discoverContentEntries(
  projectDir: string,
  contentDir = DEFAULT_CONTENT_DIR,
): DiscoveredContentEntry[] {
  const contentRoot = path.resolve(projectDir, contentDir);
  if (!fs.existsSync(contentRoot)) return [];

  assertNoLooseContentFiles(projectDir, contentRoot);

  const entries: DiscoveredContentEntry[] = [];
  for (const groupDirent of fs.readdirSync(contentRoot, { withFileTypes: true })) {
    if (!groupDirent.isDirectory()) continue;
    if (groupDirent.name.startsWith('.')) continue;

    const group = groupDirent.name;
    const groupRoot = path.join(contentRoot, group);
    for (const absPath of discoverMarkdownFiles(groupRoot)) {
      const relFromGroup = toPosixPath(path.relative(groupRoot, absPath));
      const id = contentIdFromRelativePath(relFromGroup);
      entries.push({
        group,
        id,
        href: contentHref(group, id),
        file: toPosixPath(path.relative(projectDir, absPath)),
        absPath,
      });
    }
  }

  return entries.sort((a, b) =>
    a.group.localeCompare(b.group) ||
    a.id.localeCompare(b.id) ||
    a.file.localeCompare(b.file),
  );
}

export function discoverContentGroupNames(
  projectDir: string,
  contentDir = DEFAULT_CONTENT_DIR,
): string[] {
  return Array.from(new Set(discoverContentEntries(projectDir, contentDir).map((entry) => entry.group))).sort();
}

function discoverMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  const walk = (absDir: string) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) walk(abs);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(abs);
      }
    }
  };
  walk(dir);
  return files.sort();
}

function assertNoLooseContentFiles(projectDir: string, contentRoot: string): void {
  const looseFiles = fs.readdirSync(contentRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => toPosixPath(path.relative(projectDir, path.join(contentRoot, entry.name))));

  if (looseFiles.length === 0) return;

  throw new Error(
    [
      '[koze] Markdown content lives in src/content/<name>.',
      'Move loose Markdown files into a named content folder, for example src/content/docs/getting-started.md.',
      ...looseFiles.map((file) => `- ${file}`),
    ].join('\n'),
  );
}

function contentIdFromRelativePath(relativePath: string): string {
  const withoutExt = relativePath.replace(/\.md$/i, '');
  if (withoutExt === 'index') return 'index';
  return withoutExt.endsWith('/index') ? withoutExt.slice(0, -'/index'.length) : withoutExt;
}

function contentHref(group: string, id: string): string {
  return id === 'index' ? `/${group}` : `/${group}/${id}`;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}
