export type UpstreamSvelteFixtureSuite = 'server-side-rendering' | 'hydration';

export type UpstreamSvelteFixtureStatus =
  | 'converted-pass'
  | 'framework-equivalent'
  | 'intentional-divergence'
  | 'not-applicable'
  | 'gap';

export interface UpstreamSvelteFixtureInventoryItem {
  suite: UpstreamSvelteFixtureSuite;
  id: string;
  status: UpstreamSvelteFixtureStatus;
  upstreamPath: string;
}

const SERVER_SIDE_RENDERING_IDS = `
async-children
async-context-throws-after-await
async-directive-with-spreading
async-each-fallback-hoisting
async-each-hoisting
async-head-multiple-title-order-preserved
async-html-tag
async-if-alternate-hoisting
async-if-const
async-if-hoisting
async-multiple-attrs
async-nullish-pending-snippet
async-option-implicit-complex-value
async-option-implicit-simple-value
async-select-value-component
async-select-value-implicit-value
async-select-value-implicit-value-complex
async-snippet
async-svelte-boundary
attribute-boolean
attribute-dynamic
attribute-escape-quotes-spread-2
attribute-escaped-quotes
attribute-escaped-quotes-spread
attribute-spread-hidden
attribute-spread-with-null
attribute-static
attribute-strip-svg-mathml-ce
attribute-template-literal-sanitization
bindings
bindings-empty-string
bindings-group
bindings-readonly
bindings-zero
boundary-error-failed-prop
boundary-error-html-comment-close-bang-escape
boundary-error-html-comment-escape
boundary-error-html-comment-open-escape
boundary-error-html-comment-overlap-escape
boundary-error-no-failed-snippet
boundary-error-no-onerror
boundary-error-with-onerror
boundary-pending-prop-async
comment
comment-preserve
component
component-binding
component-binding-renamed
component-data-dynamic
component-data-empty
component-refs
component-refs-and-attributes
component-with-different-extension
component-yield
computed
constructor-prefer-passed-context
contenteditable-bindings-escaped
context
context-not-set-throws
csp-config-error
csp-hash
csp-nonce
css
css-empty
css-injected-options
css-injected-options-minify
css-injected-options-nested
default-data
default-data-override
destructure-state
destructure-state-iterable
directives
dynamic-element-string
dynamic-element-variable
dynamic-element-xss-prevention
dynamic-text
dynamic-text-escaped
each-block
each-body-async
empty-elements-closed
entities
falsy-dynamic-component
head-component-props-id
head-html-and-component
head-meta-hydrate-duplicate
head-multiple-title
head-no-duplicates-with-binding
head-raw-elements-content
head-svelte-components-raw-content
head-title
helpers
hydratable-clobbering
hydratable-clobbering-but-ok
hydratable-clobbering-complicated
hydratable-unserializable
if-block-false
if-block-true
import-non-component
invalid-nested-svelte-element
legacy-imports
option-body-escaped
option-scoped-class
raw-mustaches
reactivity-window
sanitize-name
select-option-store-implicit-value
select-option-store-text-content
select-value
select-value-bind-store
select-value-component
select-value-implicit-value
select-value-implicit-value-complex
select-value-scoped-class
spread-attributes
spread-attributes-boolean
spread-attributes-event-handler-xss
spread-attributes-white-space
static-div
static-text
store-init-props
text-area-bind
textarea-children
textarea-value
triple
`;

const HYDRATION_IDS = `
basic
binding-input
boundary-pending-attribute
claim-comment
claim-static
claim-text
cloudflare-mirage-borking
cloudflare-mirage-borking-2
component
component-in-element
css-props-hmr
custom-element-with-settable-only-property
dynamic-text
dynamic-text-changed
dynamic-text-nil
each-block
each-block-0-on-server-more-on-client
each-block-arg-clash
each-block-fallback-mismatch
each-block-less-nodes-on-client
each-block-more-nodes-on-client
each-else
each-preserve-whitespace
each-text-only
element-attribute-added
element-attribute-changed
element-attribute-removed
element-attribute-unchanged
element-attribute-unchanged-2
element-dir-attribute-sibling
element-nested
element-nested-sibling
element-ref
event-handler
expression-sibling
head-html-and-component
head-meta-hydrate-duplicate
head-missing
html-tag-hydration
if-block
if-block-anchor
if-block-empty
if-block-false
if-block-mismatch
if-block-mismatch-2
if-block-update
ignore-mismatched-href
img-src-mismatch
input-checked-attribute-sibling
input-value-changed
no-reset-debug
no-reset-snippet
noscript
optgroup-rich-content
option-rich-content-continues
option-rich-content-static
pre-first-node-newline
raw
raw-empty
raw-mismatch
raw-mismatch-static
raw-repair
raw-svg
raw-with-empty-line-at-top
removes-undefined-attributes
repair-mismatched-a-href
repairs-apparent-static-content
rich-select
safari-borking
safari-borking-2
script
snippet-raw-hydrate
standalone-component
standalone-snippet
surrounding-whitespace
text-empty
text-empty-2
text-fallback
top-level-text
whitespace-at-block-start
`;

const SERVER_SIDE_RENDERING_CONVERTED = [
  'attribute-boolean',
  'attribute-dynamic',
  'attribute-escape-quotes-spread-2',
  'attribute-escaped-quotes',
  'attribute-escaped-quotes-spread',
  'attribute-spread-hidden',
  'attribute-spread-with-null',
  'attribute-static',
  'attribute-strip-svg-mathml-ce',
  'attribute-template-literal-sanitization',
  'bindings',
  'bindings-empty-string',
  'bindings-zero',
  'comment',
  'comment-preserve',
  'component',
  'component-data-dynamic',
  'component-data-empty',
  'computed',
  'dynamic-text',
  'dynamic-text-escaped',
  'each-block',
  'empty-elements-closed',
  'entities',
  'if-block-false',
  'if-block-true',
  'import-non-component',
  'option-body-escaped',
  'raw-mustaches',
  'sanitize-name',
  'select-value',
  'select-value-implicit-value',
  'spread-attributes',
  'spread-attributes-boolean',
  'spread-attributes-event-handler-xss',
  'spread-attributes-white-space',
  'static-div',
  'static-text',
  'text-area-bind',
  'textarea-children',
  'textarea-value',
  'triple',
] as const;

const SERVER_SIDE_RENDERING_FRAMEWORK_EQUIVALENT = [] as const;

const SERVER_SIDE_RENDERING_DIVERGENCE = [
  'async-children',
  'async-context-throws-after-await',
  'async-directive-with-spreading',
  'async-each-fallback-hoisting',
  'async-each-hoisting',
  'async-head-multiple-title-order-preserved',
  'async-html-tag',
  'async-if-alternate-hoisting',
  'async-if-const',
  'async-if-hoisting',
  'async-multiple-attrs',
  'async-nullish-pending-snippet',
  'async-option-implicit-complex-value',
  'async-option-implicit-simple-value',
  'async-select-value-component',
  'async-select-value-implicit-value',
  'async-select-value-implicit-value-complex',
  'async-snippet',
  'async-svelte-boundary',
  'boundary-error-failed-prop',
  'boundary-error-html-comment-close-bang-escape',
  'boundary-error-html-comment-escape',
  'boundary-error-html-comment-open-escape',
  'boundary-error-html-comment-overlap-escape',
  'boundary-error-no-failed-snippet',
  'boundary-error-no-onerror',
  'boundary-error-with-onerror',
  'boundary-pending-prop-async',
  'bindings-group',
  'bindings-readonly',
  'component-binding',
  'component-binding-renamed',
  'component-refs',
  'component-refs-and-attributes',
  'component-with-different-extension',
  'component-yield',
  'constructor-prefer-passed-context',
  'contenteditable-bindings-escaped',
  'context',
  'context-not-set-throws',
  'csp-config-error',
  'csp-hash',
  'csp-nonce',
  'css',
  'css-empty',
  'default-data',
  'default-data-override',
  'destructure-state',
  'destructure-state-iterable',
  'directives',
  'dynamic-element-string',
  'dynamic-element-variable',
  'dynamic-element-xss-prevention',
  'each-body-async',
  'falsy-dynamic-component',
  'head-component-props-id',
  'head-html-and-component',
  'head-meta-hydrate-duplicate',
  'head-multiple-title',
  'head-no-duplicates-with-binding',
  'head-raw-elements-content',
  'head-svelte-components-raw-content',
  'head-title',
  'hydratable-clobbering',
  'hydratable-clobbering-but-ok',
  'hydratable-clobbering-complicated',
  'hydratable-unserializable',
  'invalid-nested-svelte-element',
  'legacy-imports',
  'select-option-store-implicit-value',
  'select-option-store-text-content',
  'select-value-bind-store',
  'select-value-component',
  'select-value-implicit-value-complex',
  'option-scoped-class',
  'select-value-scoped-class',
  'reactivity-window',
  'store-init-props',
] as const;

const SERVER_SIDE_RENDERING_NOT_APPLICABLE = [
  'css-injected-options',
  'css-injected-options-minify',
  'css-injected-options-nested',
  'helpers',
] as const;

const HYDRATION_DIVERGENCE = [
  'boundary-pending-attribute',
  'claim-text',
  'cloudflare-mirage-borking',
  'cloudflare-mirage-borking-2',
  'custom-element-with-settable-only-property',
  'dynamic-text-changed',
  'each-block-0-on-server-more-on-client',
  'each-block-fallback-mismatch',
  'each-block-less-nodes-on-client',
  'each-block-more-nodes-on-client',
  'each-else',
  'each-preserve-whitespace',
  'element-attribute-added',
  'element-attribute-changed',
  'element-attribute-removed',
  'element-attribute-unchanged-2',
  'element-ref',
  'head-html-and-component',
  'head-meta-hydrate-duplicate',
  'head-missing',
  'if-block-empty',
  'if-block-mismatch',
  'if-block-mismatch-2',
  'if-block-update',
  'ignore-mismatched-href',
  'img-src-mismatch',
  'input-value-changed',
  'no-reset-debug',
  'no-reset-snippet',
  'noscript',
  'optgroup-rich-content',
  'option-rich-content-continues',
  'raw-mismatch',
  'raw-mismatch-static',
  'raw-repair',
  'removes-undefined-attributes',
  'repair-mismatched-a-href',
  'rich-select',
  'safari-borking',
  'safari-borking-2',
  'script',
  'snippet-raw-hydrate',
  'standalone-snippet',
  'text-empty',
  'text-fallback',
  'whitespace-at-block-start',
] as const;

const HYDRATION_CONVERTED = [
  'binding-input',
  'dynamic-text',
  'each-block',
  'event-handler',
  'html-tag-hydration',
  'if-block',
  'if-block-anchor',
  'if-block-false',
  'raw',
] as const;

const HYDRATION_FRAMEWORK_EQUIVALENT = [
  'basic',
  'claim-comment',
  'claim-static',
  'component',
  'component-in-element',
  'dynamic-text-nil',
  'each-block-arg-clash',
  'each-text-only',
  'element-attribute-unchanged',
  'element-dir-attribute-sibling',
  'element-nested',
  'element-nested-sibling',
  'expression-sibling',
  'input-checked-attribute-sibling',
  'option-rich-content-static',
  'pre-first-node-newline',
  'raw-empty',
  'raw-svg',
  'raw-with-empty-line-at-top',
  'repairs-apparent-static-content',
  'standalone-component',
  'surrounding-whitespace',
  'text-empty-2',
  'top-level-text',
] as const;

const HYDRATION_NOT_APPLICABLE = [
  'css-props-hmr',
] as const;

function parseIds(value: string): string[] {
  return value
    .trim()
    .split(/\r?\n/)
    .map((id) => id.trim())
    .filter(Boolean);
}

function buildStatusMap(
  groups: Partial<Record<UpstreamSvelteFixtureStatus, readonly string[]>>,
): Map<string, UpstreamSvelteFixtureStatus> {
  const statusById = new Map<string, UpstreamSvelteFixtureStatus>();
  for (const [status, ids] of Object.entries(groups) as Array<[UpstreamSvelteFixtureStatus, readonly string[]]>) {
    for (const id of ids) {
      if (statusById.has(id)) {
        throw new Error(`Duplicate upstream fixture status for ${id}`);
      }
      statusById.set(id, status);
    }
  }
  return statusById;
}

function buildFixtureInventory(
  suite: UpstreamSvelteFixtureSuite,
  ids: string[],
  statusById: Map<string, UpstreamSvelteFixtureStatus>,
): UpstreamSvelteFixtureInventoryItem[] {
  return ids.map((id) => ({
    suite,
    id,
    status: statusById.get(id) ?? 'gap',
    upstreamPath: `packages/svelte/tests/${suite}/samples/${id}`,
  }));
}

export const SVELTE_SERVER_SIDE_RENDERING_FIXTURES = buildFixtureInventory(
  'server-side-rendering',
  parseIds(SERVER_SIDE_RENDERING_IDS),
  buildStatusMap({
    'converted-pass': SERVER_SIDE_RENDERING_CONVERTED,
    'framework-equivalent': SERVER_SIDE_RENDERING_FRAMEWORK_EQUIVALENT,
    'intentional-divergence': SERVER_SIDE_RENDERING_DIVERGENCE,
    'not-applicable': SERVER_SIDE_RENDERING_NOT_APPLICABLE,
  }),
);

export const SVELTE_HYDRATION_FIXTURES = buildFixtureInventory(
  'hydration',
  parseIds(HYDRATION_IDS),
  buildStatusMap({
    'converted-pass': HYDRATION_CONVERTED,
    'framework-equivalent': HYDRATION_FRAMEWORK_EQUIVALENT,
    'intentional-divergence': HYDRATION_DIVERGENCE,
    'not-applicable': HYDRATION_NOT_APPLICABLE,
  }),
);

export const SVELTE_FIXTURE_INVENTORY = [
  ...SVELTE_SERVER_SIDE_RENDERING_FIXTURES,
  ...SVELTE_HYDRATION_FIXTURES,
] as const;

export function getSvelteUpstreamFixtureInventory(
  suite: UpstreamSvelteFixtureSuite,
): UpstreamSvelteFixtureInventoryItem[] {
  return SVELTE_FIXTURE_INVENTORY.filter((fixture) => fixture.suite === suite);
}
