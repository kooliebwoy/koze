export interface CompilerCorpusCase {
  name: string;
  category:
    | 'sfc'
    | 'expression'
    | 'control-flow'
    | 'raw-html'
    | 'attribute'
    | 'event'
    | 'component'
    | 'diagnostic';
  status: 'ported-pass' | 'ported-fail' | 'future-feature' | 'intentional-divergence' | 'not-applicable';
  notes: string;
  kuratchi?: string;
  svelte?: string;
  projectFiles?: Record<string, string>;
  expectedOutputIncludes?: string[];
  expectedOutputExcludes?: string[];
}

/**
 * Side-by-side compiler corpus modeled after Svelte compiler coverage areas:
 * SFC script/style extraction, expression rendering, control flow, raw HTML,
 * and complex attributes.
 *
 * These are equivalent fixtures rather than vendored Svelte fixtures because
 * Kuratchi intentionally uses native JS control flow where Svelte uses block
 * directives. The test harness compiles both sides so Svelte remains the
 * external stability bar without forcing syntax compatibility.
 */
export const COMPILER_CORPUS: CompilerCorpusCase[] = [
  {
    name: 'script-expression',
    category: 'sfc',
    status: 'ported-pass',
    notes: 'Svelte top-level instance script maps to Kuratchi leading client-first script.',
    koze: `<script>
const name = 'world';
</script>
<h1>Hello {name}</h1>`,
    svelte: `<script>
let name = 'world';
</script>
<h1>Hello {name}</h1>`,
  },
  {
    name: 'style-block',
    category: 'sfc',
    status: 'ported-pass',
    notes: 'Style blocks stay raw in both compilers.',
    koze: `<script>
const title = 'Styled';
</script>
<style>
  h1 { color: red; }
</style>
<h1>{title}</h1>`,
    svelte: `<script>
let title = 'Styled';
</script>
<style>
  h1 { color: red; }
</style>
<h1>{title}</h1>`,
  },
  {
    name: 'style-raw-script-text',
    category: 'sfc',
    status: 'ported-pass',
    notes: 'Raw CSS text that contains script-looking content must not be treated as an SFC script block.',
    koze: `<script>
const title = 'Styled';
</script>
<style>
  .icon::before { content: "<script></script>"; }
</style>
<h1>{title}</h1>`,
    svelte: `<script>
let title = 'Styled';
</script>
<style>
  .icon::before { content: "<script></script>"; }
</style>
<h1>{title}</h1>`,
  },
  {
    name: 'if-else-block',
    category: 'control-flow',
    status: 'ported-pass',
    notes: 'Svelte {#if} maps to Kuratchi native if/else control lines.',
    koze: `<script>
const visible = true;
</script>
if (visible) {
  <p>shown</p>
} else {
  <p>hidden</p>
}`,
    svelte: `<script>
let visible = true;
</script>
{#if visible}
  <p>shown</p>
{:else}
  <p>hidden</p>
{/if}`,
  },
  {
    name: 'each-block',
    category: 'control-flow',
    status: 'ported-pass',
    notes: 'Svelte {#each} maps to Kuratchi native for...of control lines.',
    koze: `<script>
const items = [{ id: 1, label: 'one' }, { id: 2, label: 'two' }];
</script>
<ul>
for (const item of items) {
  <li data-id={item.id}>{item.label}</li>
}
</ul>`,
    svelte: `<script>
let items = [{ id: 1, label: 'one' }, { id: 2, label: 'two' }];
</script>
<ul>
{#each items as item (item.id)}
  <li data-id={item.id}>{item.label}</li>
{/each}
</ul>`,
  },
  {
    name: 'nested-attribute-expression',
    category: 'attribute',
    status: 'ported-pass',
    notes: 'Nested JavaScript object literals in attributes must not break template parsing.',
    koze: `<script>
const item = { id: 7, label: 'seven' };
</script>
<button data-payload={JSON.stringify({ id: item.id, nested: { label: item.label } })}>
  {item.label}
</button>`,
    svelte: `<script>
let item = { id: 7, label: 'seven' };
</script>
<button data-payload={JSON.stringify({ id: item.id, nested: { label: item.label } })}>
  {item.label}
</button>`,
  },
  {
    name: 'raw-html',
    category: 'raw-html',
    status: 'ported-pass',
    notes: '{@html} is shared syntax and should parse/compile on both sides.',
    koze: `<script>
const content = '<strong>trusted</strong>';
</script>
<article>{@html content}</article>`,
    svelte: `<script>
let content = '<strong>trusted</strong>';
</script>
<article>{@html content}</article>`,
  },
  {
    name: 'boolean-attribute',
    category: 'attribute',
    status: 'ported-pass',
    notes: 'Boolean attributes are conditionally emitted by Kuratchi and supported by Svelte.',
    koze: `<script>
const disabled = true;
</script>
<button disabled={disabled}>Save</button>`,
    svelte: `<script>
let disabled = true;
</script>
<button disabled={disabled}>Save</button>`,
  },
  {
    name: 'quoted-attribute-interpolation',
    category: 'attribute',
    status: 'ported-pass',
    notes: 'Quoted attribute interpolation exercises expression parsing inside attribute text.',
    koze: `<script>
const id = 'a';
const size = 'lg';
</script>
<section id="panel-{id}" data-size="{size}">Panel</section>`,
    svelte: `<script>
let id = 'a';
let size = 'lg';
</script>
<section id="panel-{id}" data-size="{size}">Panel</section>`,
  },
  {
    name: 'escaped-html-expression',
    category: 'expression',
    status: 'ported-pass',
    notes: 'Normal {expr} output must remain escaped, unlike {@html}.',
    koze: `<script>
const content = '<em>unsafe</em>';
</script>
<p>{content}</p>`,
    svelte: `<script>
let content = '<em>unsafe</em>';
</script>
<p>{content}</p>`,
  },
  {
    name: 'template-comments',
    category: 'sfc',
    status: 'ported-pass',
    notes: 'Comments containing braces or script-looking text should not affect analysis.',
    koze: `<script>
const title = 'safe';
</script>
<!-- {ignored} <script>ignored()</script> -->
<h2>{title}</h2>`,
    svelte: `<script>
let title = 'safe';
</script>
<!-- {ignored} <script>ignored()</script> -->
<h2>{title}</h2>`,
  },
  {
    name: 'event-handler-directive',
    category: 'event',
    status: 'ported-pass',
    notes: 'Svelte event handler attributes map to Kuratchi onClick attributes at compile time; runtime event semantics remain framework-specific.',
    koze: `<script>
function increment() {}
</script>
<button onClick={increment()}>+</button>`,
    svelte: `<script>
function increment() {}
</script>
<button onclick={increment}>+</button>`,
  },
  {
    name: 'component-props',
    category: 'component',
    status: 'ported-pass',
    notes: 'Component props compile through the real multi-file component compiler path, including typed props, spread attributes, slots, and relative child imports.',
    koze: `<script>
import StatCard from '$lib/cards/stat-card.koze';

const attrs = { 'data-tier': 'gold', hidden: false };
</script>
<StatCard title="Revenue" count={3} tone="positive" attrs={attrs}>
  <p>Revenue grew</p>
</StatCard>`,
    svelte: `<script>
let title = 'Revenue';
let count = 3;
let tier = 'gold';
</script>
<article data-title={title} data-tier={tier}>
  <h2>{title}:{count}</h2>
  <span data-kind="positive">{title}</span>
  <p>Revenue grew</p>
</article>`,
    projectFiles: {
      'src/routes/page.koze': `<script>
import StatCard from '$lib/cards/stat-card.koze';

const attrs = { 'data-tier': 'gold', hidden: false };
</script>
<StatCard title="Revenue" count={3} tone="positive" attrs={attrs}>
  <p>Revenue grew</p>
</StatCard>`,
      'src/lib/cards/badge.koze': `<script>
import { props } from 'koze:component';
</script>
<span data-kind={props.kind}>{props.label}</span>`,
      'src/lib/cards/stat-card.koze': `<script>
import Badge from './badge.koze';
import { props } from 'koze:component';

const { title, count = 0 } = props<{ title: string; count?: number }>();
</script>
<article data-title={props.title} {...props.attrs}>
  <h2>{title}:{count}</h2>
  <Badge kind={props.tone} label={props.title} />
  <slot></slot>
</article>`,
    },
    expectedOutputIncludes: [
      'function __c_cards_stat_card',
      'function __c_rel_',
      'const { title, count = 0 } = props();',
      '__koze_propsbag.children',
    ],
    expectedOutputExcludes: [
      'props<{',
    ],
  },
  {
    name: 'svelte-actions',
    category: 'event',
    status: 'intentional-divergence',
    notes: 'Svelte use:action intentionally diverges from Kuratchi server action={fn}; keep separate from compatibility scoring.',
  },
];

export function getCompilerCorpusByStatus(status: CompilerCorpusCase['status']): CompilerCorpusCase[] {
  return COMPILER_CORPUS.filter((fixture) => fixture.status === status);
}
