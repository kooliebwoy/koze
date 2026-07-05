import GithubSlugger from 'github-slugger';
import { toString as mdastToString } from 'mdast-util-to-string';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { parse as parseYaml } from 'yaml';

export type ContentFrontmatter = Record<string, unknown>;

export interface ContentHeading {
  depth: number;
  slug: string;
  text: string;
}

export interface ContentSourceEntry {
  group: string;
  id: string;
  href: string;
  file: string;
  source: string;
}

export interface ContentListItem {
  id: string;
  href: string;
  file: string;
  title: string;
  description?: string;
  section?: string;
  order: number;
  headings: ContentHeading[];
  frontmatter: ContentFrontmatter;
}

export interface RenderedContent extends ContentListItem {
  html: string;
  body: string;
}

export interface ContentGroup {
  list(): Promise<ContentListItem[]>;
  render(id: string): Promise<RenderedContent | null>;
}

export type ContentRegistry = Record<string, ContentGroup>;

interface ParsedContentEntry {
  group: string;
  id: string;
  href: string;
  file: string;
  body: string;
  frontmatter: ContentFrontmatter;
}

type HastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: unknown;
};

const headingTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const markdownProcessor = unified().use(remarkParse).use(remarkGfm);

const sanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: '',
  attributes: {
    ...defaultSchema.attributes,
    h1: [...(defaultSchema.attributes?.h1 ?? []), 'id'],
    h2: [...(defaultSchema.attributes?.h2 ?? []), 'id'],
    h3: [...(defaultSchema.attributes?.h3 ?? []), 'id'],
    h4: [...(defaultSchema.attributes?.h4 ?? []), 'id'],
    h5: [...(defaultSchema.attributes?.h5 ?? []), 'id'],
    h6: [...(defaultSchema.attributes?.h6 ?? []), 'id'],
  },
};

export function createContentRegistry(entries: ContentSourceEntry[]): ContentRegistry {
  const groups = new Map<string, ParsedContentEntry[]>();

  for (const entry of entries) {
    const parsed = parseContentEntry(entry);
    const groupEntries = groups.get(parsed.group) ?? [];
    groupEntries.push(parsed);
    groups.set(parsed.group, groupEntries);
  }

  const registry: ContentRegistry = {};
  for (const [groupName, groupEntries] of groups) {
    registry[groupName] = createContentGroup(groupEntries);
  }

  return registry;
}

function createContentGroup(entries: ParsedContentEntry[]): ContentGroup {
  const byId = new Map<string, ParsedContentEntry>();
  const listCache = new Map<string, ContentListItem>();
  const renderCache = new Map<string, RenderedContent>();

  for (const entry of entries) {
    if (byId.has(entry.id)) {
      throw new Error(`[koze:content] Duplicate content id "${entry.id}" in ${entry.group}.`);
    }
    byId.set(entry.id, entry);
  }

  const toListItem = (entry: ParsedContentEntry): ContentListItem => {
    const cached = listCache.get(entry.id);
    if (cached) return cached;
    const headings = extractHeadings(entry.body);
    const item = {
      id: entry.id,
      href: entry.href,
      file: entry.file,
      title: readString(entry.frontmatter.title) ?? headings[0]?.text ?? titleize(entry.id),
      description: readString(entry.frontmatter.description),
      section: readString(entry.frontmatter.section),
      order: readNumber(entry.frontmatter.order) ?? 999,
      headings,
      frontmatter: entry.frontmatter,
    };
    listCache.set(entry.id, item);
    return item;
  };

  return {
    async list() {
      return entries
        .map(toListItem)
        .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    },
    async render(id: string) {
      const normalizedId = normalizeContentId(id);
      const entry = byId.get(normalizedId);
      if (!entry) return null;
      const cached = renderCache.get(normalizedId);
      if (cached) return cached;
      const item = toListItem(entry);
      const rendered = {
        ...item,
        body: entry.body,
        html: await renderMarkdown(entry.body),
      };
      renderCache.set(normalizedId, rendered);
      return rendered;
    },
  };
}

function parseContentEntry(entry: ContentSourceEntry): ParsedContentEntry {
  const { frontmatter, body } = splitFrontmatter(entry.source, entry.file);
  return {
    group: entry.group,
    id: normalizeContentId(entry.id),
    href: entry.href,
    file: entry.file,
    body,
    frontmatter,
  };
}

function splitFrontmatter(source: string, file: string): { frontmatter: ContentFrontmatter; body: string } {
  if (!source.startsWith('---')) {
    return { frontmatter: {}, body: source };
  }

  const firstLineEnd = source.indexOf('\n');
  if (firstLineEnd === -1) {
    return { frontmatter: {}, body: source };
  }

  const firstLine = source.slice(0, firstLineEnd).trim();
  if (firstLine !== '---') {
    return { frontmatter: {}, body: source };
  }

  const closingMatch = /\n---[ \t]*(?:\r?\n|$)/.exec(source.slice(firstLineEnd));
  if (!closingMatch || closingMatch.index < 0) {
    return { frontmatter: {}, body: source };
  }

  const closingStart = firstLineEnd + closingMatch.index;
  const closingEnd = firstLineEnd + closingMatch.index + closingMatch[0].length;
  const yamlSource = source.slice(firstLineEnd + 1, closingStart);
  const body = source.slice(closingEnd);

  let parsed: unknown;
  try {
    parsed = yamlSource.trim() ? parseYaml(yamlSource) : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[koze:content] Failed to parse frontmatter in ${file}: ${message}`);
  }

  return {
    frontmatter: isRecord(parsed) ? parsed : {},
    body,
  };
}

function extractHeadings(body: string): ContentHeading[] {
  const tree = markdownProcessor.parse(body);
  const slugger = new GithubSlugger();
  const headings: ContentHeading[] = [];

  visit(tree, 'heading', (node: any) => {
    const text = mdastToString(node).trim();
    if (!text) return;
    headings.push({
      depth: node.depth,
      slug: slugger.slug(text),
      text,
    });
  });

  return headings;
}

async function renderMarkdown(body: string): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeHeadingIds)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeStringify);

  const file = await processor.process(body);
  return String(file);
}

function rehypeHeadingIds() {
  return (tree: HastNode) => {
    const slugger = new GithubSlugger();
    visit(tree as any, 'element', (node: HastNode) => {
      if (!node.tagName || !headingTags.has(node.tagName)) return;
      const text = collectHastText(node).trim();
      if (!text) return;
      node.properties = {
        ...(node.properties ?? {}),
        id: slugger.slug(text),
      };
    });
  };
}

function collectHastText(node: HastNode): string {
  if (node.type === 'text') return typeof node.value === 'string' ? node.value : '';
  if (!node.children) return '';
  return node.children.map(collectHastText).join('');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is ContentFrontmatter {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeContentId(id: string): string {
  return id.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function titleize(id: string): string {
  const last = id.split('/').filter(Boolean).pop() ?? id;
  return last
    .replace(/\.[^.]+$/, '')
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || id;
}
