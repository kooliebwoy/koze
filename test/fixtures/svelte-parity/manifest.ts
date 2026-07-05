import type { KuratchiCompilerErrorCode } from '../../../src/compiler/diagnostics.js';

export type SvelteParityStatus =
  | 'ported-pass'
  | 'ported-fail'
  | 'future-feature'
  | 'intentional-divergence'
  | 'not-applicable';
export type SvelteParityAssertion = 'compile' | 'render' | 'diagnostic';

export interface SvelteParityComponentStub {
  fileName: string;
  body: string;
}

export interface SvelteParityFixture {
  id: string;
  category:
    | 'text'
    | 'expression'
    | 'attribute'
    | 'control-flow'
    | 'raw-html'
    | 'sfc'
    | 'event'
    | 'binding'
    | 'component'
    | 'diagnostic';
  status: SvelteParityStatus;
  assertion?: SvelteParityAssertion;
  notes: string;
  svelteSource?: string;
  kozeSource?: string;
  data?: Record<string, unknown>;
  components?: Record<string, SvelteParityComponentStub>;
  expectedKozeErrorCode?: KuratchiCompilerErrorCode;
  svelteShouldThrow?: boolean;
}

export const SVELTE_PARITY_FIXTURES: SvelteParityFixture[] = [
  {
    id: 'text/static-element',
    category: 'text',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Static text and element rendering.',
    svelteSource: `<p>Hello world</p>`,
    kozeSource: `<p>Hello world</p>`,
  },
  {
    id: 'text/expression',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Basic text interpolation.',
    svelteSource: `<script>let name = 'world';</script><h1>Hello {name}</h1>`,
    kozeSource: `<script>const name = 'world';</script><h1>Hello {name}</h1>`,
    data: { name: 'world' },
  },
  {
    id: 'text/escaped-html',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Default interpolation escapes HTML.',
    svelteSource: `<script>let content = '<em>unsafe</em>';</script><p>{content}</p>`,
    kozeSource: `<script>const content = '<em>unsafe</em>';</script><p>{content}</p>`,
    data: { content: '<em>unsafe</em>' },
  },
  {
    id: 'text/arithmetic',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'JavaScript arithmetic expressions in braces.',
    svelteSource: `<script>let count = 2;</script><p>{count + 1}</p>`,
    kozeSource: `<script>const count = 2;</script><p>{count + 1}</p>`,
    data: { count: 2 },
  },
  {
    id: 'text/ternary',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Inline ternary expression.',
    svelteSource: `<script>let active = true;</script><p>{active ? 'on' : 'off'}</p>`,
    kozeSource: `<script>const active = true;</script><p>{active ? 'on' : 'off'}</p>`,
    data: { active: true },
  },
  {
    id: 'text/nullish-coalescing',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Nullish coalescing expression.',
    svelteSource: `<script>let label = null;</script><p>{label ?? 'fallback'}</p>`,
    kozeSource: `<script>const label = null;</script><p>{label ?? 'fallback'}</p>`,
    data: { label: null },
  },
  {
    id: 'text/optional-chaining',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Optional chaining expression.',
    svelteSource: `<script>let user = { profile: { name: 'Ada' } };</script><p>{user?.profile?.name}</p>`,
    kozeSource: `<script>const user = { profile: { name: 'Ada' } };</script><p>{user?.profile?.name}</p>`,
    data: { user: { profile: { name: 'Ada' } } },
  },
  {
    id: 'text/array-join',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Method call expression.',
    svelteSource: `<script>let tags = ['a', 'b'];</script><p>{tags.join(',')}</p>`,
    kozeSource: `<script>const tags = ['a', 'b'];</script><p>{tags.join(',')}</p>`,
    data: { tags: ['a', 'b'] },
  },
  {
    id: 'text/logical-and',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Logical AND expressions render the truthy branch value.',
    svelteSource: `<script>let ready = true;</script><p>{ready && 'ready'}</p>`,
    kozeSource: `<script>const ready = true;</script><p>{ready && 'ready'}</p>`,
    data: { ready: true },
  },
  {
    id: 'text/computed-property',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Computed object property reads in template expressions.',
    svelteSource: `<script>let lookup = { a: 'alpha' }; let key = 'a';</script><p>{lookup[key]}</p>`,
    kozeSource: `<script>const lookup = { a: 'alpha' }; const key = 'a';</script><p>{lookup[key]}</p>`,
    data: { lookup: { a: 'alpha' }, key: 'a' },
  },
  {
    id: 'text/string-method',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Method calls on values in template expressions.',
    svelteSource: `<script>let name = 'ada';</script><p>{name.toUpperCase()}</p>`,
    kozeSource: `<script>const name = 'ada';</script><p>{name.toUpperCase()}</p>`,
    data: { name: 'ada' },
  },
  {
    id: 'text/object-literal-expression',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Nested braces inside JavaScript expressions should not confuse template parsing.',
    svelteSource: `<script>let name = 'Ada';</script><p>{({ label: name }).label}</p>`,
    kozeSource: `<script>const name = 'Ada';</script><p>{({ label: name }).label}</p>`,
    data: { name: 'Ada' },
  },
  {
    id: 'text/false-output',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Boolean false interpolates as text, matching Svelte SSR.',
    svelteSource: `<p>{false}</p>`,
    kozeSource: `<p>{false}</p>`,
  },
  {
    id: 'text/nullish-output',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Null and undefined interpolate as empty output.',
    svelteSource: `<script>let value = null;</script><p>{value}</p>`,
    kozeSource: `<script>const value = null;</script><p>{value}</p>`,
    data: { value: null },
  },
  {
    id: 'text/template-literal-expression',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Template literals inside template expressions preserve nested braces.',
    svelteSource: '<script>let name = "Ada";</script><p>{`Hello ${name}`}</p>',
    kozeSource: '<script>const name = "Ada";</script><p>{`Hello ${name}`}</p>',
    data: { name: 'Ada' },
  },
  {
    id: 'text/function-call',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Top-level function calls in template expressions.',
    svelteSource: `<script>function format(value) { return value.toUpperCase(); } let name = 'ada';</script><p>{format(name)}</p>`,
    kozeSource: `<script>function format(value) { return value.toUpperCase(); } const name = 'ada';</script><p>{format(name)}</p>`,
    data: { name: 'ada', format: (value: string) => value.toUpperCase() },
  },
  {
    id: 'text/regex-literal-expression',
    category: 'expression',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Regular expression construction inside template expressions.',
    svelteSource: `<script>let value = 'abc123';</script><p>{new RegExp('\\\\d+').test(value) ? 'number' : 'text'}</p>`,
    kozeSource: `<script>const value = 'abc123';</script><p>{new RegExp('\\\\d+').test(value) ? 'number' : 'text'}</p>`,
    data: { value: 'abc123' },
  },
  {
    id: 'raw-html/basic',
    category: 'raw-html',
    status: 'ported-pass',
    assertion: 'render',
    notes: '{@html} renders trusted HTML for parity-safe content.',
    svelteSource: `<script>let content = '<strong>trusted</strong>';</script><article>{@html content}</article>`,
    kozeSource: `<script>const content = '<strong>trusted</strong>';</script><article>{@html content}</article>`,
    data: { content: '<strong>trusted</strong>' },
  },
  {
    id: 'attribute/static',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Static attributes.',
    svelteSource: `<div class="card" data-kind="demo">Card</div>`,
    kozeSource: `<div class="card" data-kind="demo">Card</div>`,
  },
  {
    id: 'attribute/class-expression',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Attribute value expression.',
    svelteSource: `<script>let active = true;</script><div class={active ? 'on' : 'off'}>State</div>`,
    kozeSource: `<script>const active = true;</script><div class={active ? 'on' : 'off'}>State</div>`,
    data: { active: true },
  },
  {
    id: 'attribute/quoted-interpolation',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Quoted attribute interpolation.',
    svelteSource: `<script>let id = 'a'; let size = 'lg';</script><section id="panel-{id}" data-size="{size}">Panel</section>`,
    kozeSource: `<script>const id = 'a'; const size = 'lg';</script><section id="panel-{id}" data-size="{size}">Panel</section>`,
    data: { id: 'a', size: 'lg' },
  },
  {
    id: 'attribute/boolean-true',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Truthy boolean attribute.',
    svelteSource: `<script>let disabled = true;</script><button disabled={disabled}>Save</button>`,
    kozeSource: `<script>const disabled = true;</script><button disabled={disabled}>Save</button>`,
    data: { disabled: true },
  },
  {
    id: 'attribute/boolean-false',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Falsy boolean attribute omission.',
    svelteSource: `<script>let disabled = false;</script><button disabled={disabled}>Save</button>`,
    kozeSource: `<script>const disabled = false;</script><button disabled={disabled}>Save</button>`,
    data: { disabled: false },
  },
  {
    id: 'attribute/nested-object-expression',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Nested object literal expression in an attribute.',
    svelteSource: `<script>let item = { id: 7, label: 'seven' };</script><button data-payload={JSON.stringify({ id: item.id, nested: { label: item.label } })}>{item.label}</button>`,
    kozeSource: `<script>const item = { id: 7, label: 'seven' };</script><button data-payload={JSON.stringify({ id: item.id, nested: { label: item.label } })}>{item.label}</button>`,
    data: { item: { id: 7, label: 'seven' } },
  },
  {
    id: 'attribute/input-value',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Input value expression.',
    svelteSource: `<script>let value = 'abc';</script><input value={value}>`,
    kozeSource: `<script>const value = 'abc';</script><input value={value}>`,
    data: { value: 'abc' },
  },
  {
    id: 'attribute/checkbox-checked',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Checked boolean attribute.',
    svelteSource: `<script>let checked = true;</script><input type="checkbox" checked={checked}>`,
    kozeSource: `<script>const checked = true;</script><input type="checkbox" checked={checked}>`,
    data: { checked: true },
  },
  {
    id: 'attribute/selected-option',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Selected boolean attribute rendering.',
    svelteSource: `<script>let selected = true;</script><select><option selected={selected}>A</option></select>`,
    kozeSource: `<script>const selected = true;</script><select><option selected={selected}>A</option></select>`,
    data: { selected: true },
  },
  {
    id: 'attribute/readonly-required',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Multiple truthy boolean attributes on an input.',
    svelteSource: `<script>let readOnly = true; let required = true;</script><input readonly={readOnly} required={required}>`,
    kozeSource: `<script>const readOnly = true; const required = true;</script><input readonly={readOnly} required={required}>`,
    data: { readOnly: true, required: true },
  },
  {
    id: 'attribute/hidden-false',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Falsy boolean attributes are omitted.',
    svelteSource: `<script>let hidden = false;</script><section hidden={hidden}>Visible</section>`,
    kozeSource: `<script>const hidden = false;</script><section hidden={hidden}>Visible</section>`,
    data: { hidden: false },
  },
  {
    id: 'attribute/data-optional-chain',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Optional chaining and nullish coalescing inside attribute expressions.',
    svelteSource: `<script>let item = { label: 'demo' };</script><div data-label={item?.label ?? 'none'}>Item</div>`,
    kozeSource: `<script>const item = { label: 'demo' };</script><div data-label={item?.label ?? 'none'}>Item</div>`,
    data: { item: { label: 'demo' } },
  },
  {
    id: 'attribute/aria-false-string',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Non-boolean ARIA attributes preserve false as a string value.',
    svelteSource: `<script>let hidden = false;</script><button aria-hidden={hidden}>Open</button>`,
    kozeSource: `<script>const hidden = false;</script><button aria-hidden={hidden}>Open</button>`,
    data: { hidden: false },
  },
  {
    id: 'attribute/style-quoted-interpolation',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Quoted style interpolation renders CSS text consistently.',
    svelteSource: `<script>let color = 'red';</script><p style="color: {color}">Red</p>`,
    kozeSource: `<script>const color = 'red';</script><p style="color: {color}">Red</p>`,
    data: { color: 'red' },
  },
  {
    id: 'attribute/numeric-value',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Numeric values in normal attributes stringify consistently.',
    svelteSource: `<script>let count = 3;</script><meter value={count} max="10">{count}</meter>`,
    kozeSource: `<script>const count = 3;</script><meter value={count} max="10">{count}</meter>`,
    data: { count: 3 },
  },
  {
    id: 'attribute/spread-like-join-expression',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Array/filter/join class expression patterns work without a class directive.',
    svelteSource: `<script>let base = 'btn'; let active = true; let dense = false;</script><button class={[base, active && 'active', dense && 'dense'].filter(Boolean).join(' ')}>Save</button>`,
    kozeSource: `<script>const base = 'btn'; const active = true; const dense = false;</script><button class={[base, active && 'active', dense && 'dense'].filter(Boolean).join(' ')}>Save</button>`,
    data: { base: 'btn', active: true, dense: false },
  },
  {
    id: 'attribute/spread-attributes',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Attribute spread bags render safe HTML attributes without hand-built strings.',
    svelteSource: `<script>let attrs = { class: 'card', 'data-id': '7', hidden: false, 'aria-hidden': false };</script><div {...attrs}>Card</div>`,
    kozeSource: `<script>const attrs = { class: 'card', 'data-id': '7', hidden: false, 'aria-hidden': false };</script><div {...attrs}>Card</div>`,
    data: { attrs: { class: 'card', 'data-id': '7', hidden: false, 'aria-hidden': false } },
  },
  {
    id: 'attribute/spread-attributes-boolean',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Boolean attributes in spread bags follow Svelte SSR truthy/falsy behavior.',
    svelteSource: `<input {...{ readonly: 1 }}><input {...{ readonly: 0 }}>`,
    kozeSource: `<input {...{ readonly: 1 }}><input {...{ readonly: 0 }}>`,
  },
  {
    id: 'attribute/spread-hidden-until-found',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'The hidden until-found token is preserved when it comes from a spread bag.',
    svelteSource: `<div {...{ hidden: false }}>A</div><div {...{ hidden: true }}>B</div><div {...{ hidden: 'until-found' }}>C</div>`,
    kozeSource: `<div {...{ hidden: false }}>A</div><div {...{ hidden: true }}>B</div><div {...{ hidden: 'until-found' }}>C</div>`,
  },
  {
    id: 'attribute/nullish-attribute-omission',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Nullish regular attributes are omitted while false and empty string values are preserved.',
    svelteSource: `<script>let missing = null; let empty = '';</script><div id={missing} data-enabled={false} class={empty}></div>`,
    kozeSource: `<script>const missing = null; const empty = '';</script><div id={missing} data-enabled={false} class={empty}></div>`,
    data: { missing: null, empty: '' },
  },
  {
    id: 'attribute/spread-with-null-shorthand',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Attribute shorthand and spread nulls omit the attribute bag like Svelte SSR.',
    svelteSource: `<script>let id = null; let rest = null;</script><div {id} {...rest}></div>`,
    kozeSource: `<script>const id = null; const rest = null;</script><div {id} {...rest}></div>`,
    data: { id: null, rest: null },
  },
  {
    id: 'attribute/escape-quotes-spread-2',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Spread and shorthand attributes escape quote-breaking values and drop invalid attribute names.',
    svelteSource: `<script>let foo = '"></div><script>alert(42)</' + 'script>'; let bar = "'></div><script>alert(42)</" + 'script>'; let props = { ['"></div><script>alert(42)</' + 'script>']: 'baz', qux: '&&&' };</script><div {foo} bar={bar} {...props}></div>`,
    kozeSource: `<script>const foo = '"></div><script>alert(42)</' + 'script>'; const bar = "'></div><script>alert(42)</" + 'script>'; const props = { ['"></div><script>alert(42)</' + 'script>']: 'baz', qux: '&&&' };</script><div {foo} bar={bar} {...props}></div>`,
    data: {
      foo: '"></div><script>alert(42)</script>',
      bar: "'></div><script>alert(42)</script>",
      props: {
        ['"></div><script>alert(42)</script>']: 'baz',
        qux: '&&&',
      },
    },
  },
  {
    id: 'attribute/escaped-quotes-spread',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Spread attributes escape values with hostile toString output while preserving safe names.',
    svelteSource: `<script>const safe = { foo: 'foo' }; const unsafe = { toString: () => '"><script>alert(42)</' + 'script>' }; let props = { foo: '"></div><script>alert(42)</' + 'script>', bar: "'></div><script>alert(42)</" + 'script>', ['"></div><script>alert(42)</' + 'script>']: 'baz', qux: '&&&', quux: unsafe };</script><div {...props}></div><div {...safe} {unsafe}></div>`,
    kozeSource: `<script>const safe = { foo: 'foo' }; const unsafe = { toString: () => '"><script>alert(42)</' + 'script>' }; const props = { foo: '"></div><script>alert(42)</' + 'script>', bar: "'></div><script>alert(42)</" + 'script>', ['"></div><script>alert(42)</' + 'script>']: 'baz', qux: '&&&', quux: unsafe };</script><div {...props}></div><div {...safe} {unsafe}></div>`,
    data: {
      safe: { foo: 'foo' },
      unsafe: { toString: () => '"><script>alert(42)</script>' },
      props: {
        foo: '"></div><script>alert(42)</script>',
        bar: "'></div><script>alert(42)</script>",
        ['"></div><script>alert(42)</script>']: 'baz',
        qux: '&&&',
        quux: { toString: () => '"><script>alert(42)</script>' },
      },
    },
  },
  {
    id: 'attribute/spread-attributes-event-handler-xss',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Spread bags drop on* attributes so user data cannot inject event handlers.',
    svelteSource: `<script>let userdata = { id: 'profile-123', class: 'card', onclick: 'alert(1)', onerror: 'alert(1)' };</script><div {...userdata}>content</div>`,
    kozeSource: `<script>const userdata = { id: 'profile-123', class: 'card', onclick: 'alert(1)', onerror: 'alert(1)' };</script><div {...userdata}>content</div>`,
    data: { userdata: { id: 'profile-123', class: 'card', onclick: 'alert(1)', onerror: 'alert(1)' } },
  },
  {
    id: 'attribute/spread-attributes-whitespace',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Multiline static class whitespace normalizes before a following attribute spread is compiled.',
    svelteSource: `<input class="
  white
  space
" {...({})}>`,
    kozeSource: `<input class="
  white
  space
" {...({})}>`,
  },
  {
    id: 'attribute/strip-svg-mathml-custom-event-spread',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Spread event handler names are filtered on SVG, MathML, and custom elements.',
    svelteSource: `<script>let userdata = { ONCLICK: 'alert(document.cookie)', ONMOUSEOVER: 'alert("XSS")' };</script><svg {...userdata}><circle cx="12" cy="12" r="10" /></svg><math {...userdata}><mi>x</mi></math><custom-element {...userdata}></custom-element>`,
    kozeSource: `<script>const userdata = { ONCLICK: 'alert(document.cookie)', ONMOUSEOVER: 'alert("XSS")' };</script><svg {...userdata}><circle cx="12" cy="12" r="10" /></svg><math {...userdata}><mi>x</mi></math><custom-element {...userdata}></custom-element>`,
    data: { userdata: { ONCLICK: 'alert(document.cookie)', ONMOUSEOVER: 'alert("XSS")' } },
  },
  {
    id: 'attribute/template-literal-sanitization',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Static attribute numeric entities that decode to template literal syntax do not become JavaScript interpolation.',
    svelteSource: `<script>let value = 'world';</script><div title="&#36;&#123;inject&#125; {value}"></div><div title="&#96;backtick {value}"></div><div title="back\\slash {value}"></div>`,
    kozeSource: `<script>const value = 'world';</script><div title="&#36;&#123;inject&#125; {value}"></div><div title="&#96;backtick {value}"></div><div title="back\\slash {value}"></div>`,
    data: { value: 'world' },
  },
  {
    id: 'attribute/textarea-value',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Textarea value attributes SSR as escaped children, matching browser behavior.',
    svelteSource: `<script>let foo = 42;</script><textarea value='{foo}'/>`,
    kozeSource: `<script>const foo = 42;</script><textarea value='{foo}'/>`,
    data: { foo: 42 },
  },
  {
    id: 'attribute/select-value',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Select value attributes SSR by marking the matching option selected.',
    svelteSource: `<select value="dog"><option value="">--Please choose an option--</option><option value="dog">Dog</option><option value="cat">Cat</option></select>`,
    kozeSource: `<select value="dog"><option value="">--Please choose an option--</option><option value="dog">Dog</option><option value="cat">Cat</option></select>`,
  },
  {
    id: 'attribute/select-value-implicit-value',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Select value attributes match simple option text when options omit explicit value attributes.',
    svelteSource: `<select value="dog"><option>--Please choose an option--</option><option>dog</option><option>cat</option></select>`,
    kozeSource: `<select value="dog"><option>--Please choose an option--</option><option>dog</option><option>cat</option></select>`,
  },
  {
    id: 'attribute/svg-expression',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'SVG attributes and text expressions.',
    svelteSource: `<script>let color = 'red';</script><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill={color}/></svg>`,
    kozeSource: `<script>const color = 'red';</script><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill={color}/></svg>`,
    data: { color: 'red' },
  },
  {
    id: 'control-flow/if-true',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Svelte {#if} maps to Kuratchi native if block.',
    svelteSource: `<script>let visible = true;</script>{#if visible}<p>shown</p>{/if}`,
    kozeSource: `<script>const visible = true;</script>if (visible) {
  <p>shown</p>
}`,
    data: { visible: true },
  },
  {
    id: 'control-flow/if-false-else',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Svelte {:else} maps to native else block.',
    svelteSource: `<script>let visible = false;</script>{#if visible}<p>shown</p>{:else}<p>hidden</p>{/if}`,
    kozeSource: `<script>const visible = false;</script>if (visible) {
  <p>shown</p>
} else {
  <p>hidden</p>
}`,
    data: { visible: false },
  },
  {
    id: 'control-flow/if-else-if',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Svelte {:else if} maps to native else-if.',
    svelteSource: `<script>let state = 'done';</script>{#if state === 'loading'}<p>loading</p>{:else if state === 'done'}<p>done</p>{:else}<p>idle</p>{/if}`,
    kozeSource: `<script>const state = 'done';</script>if (state === 'loading') {
  <p>loading</p>
} else if (state === 'done') {
  <p>done</p>
} else {
  <p>idle</p>
}`,
    data: { state: 'done' },
  },
  {
    id: 'control-flow/each-list',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Svelte {#each} maps to native for...of.',
    svelteSource: `<script>let items = ['a', 'b'];</script><ul>{#each items as item}<li>{item}</li>{/each}</ul>`,
    kozeSource: `<script>const items = ['a', 'b'];</script><ul>
for (const item of items) {
  <li>{item}</li>
}
</ul>`,
    data: { items: ['a', 'b'] },
  },
  {
    id: 'control-flow/each-empty',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Empty each/for block renders no children.',
    svelteSource: `<script>let items = [];</script><ul>{#each items as item}<li>{item}</li>{/each}</ul>`,
    kozeSource: `<script>const items = [];</script><ul>
for (const item of items) {
  <li>{item}</li>
}
</ul>`,
    data: { items: [] },
  },
  {
    id: 'control-flow/each-object-property',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Object property access inside each/for.',
    svelteSource: `<script>let rows = [{ id: 1, label: 'one' }, { id: 2, label: 'two' }];</script><ol>{#each rows as row}<li data-id={row.id}>{row.label}</li>{/each}</ol>`,
    kozeSource: `<script>const rows = [{ id: 1, label: 'one' }, { id: 2, label: 'two' }];</script><ol>
for (const row of rows) {
  <li data-id={row.id}>{row.label}</li>
}
</ol>`,
    data: { rows: [{ id: 1, label: 'one' }, { id: 2, label: 'two' }] },
  },
  {
    id: 'control-flow/nested-each',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Nested iteration.',
    svelteSource: `<script>let groups = [{ name: 'g', items: ['x', 'y'] }];</script>{#each groups as group}<section><h2>{group.name}</h2>{#each group.items as item}<p>{item}</p>{/each}</section>{/each}`,
    kozeSource: `<script>const groups = [{ name: 'g', items: ['x', 'y'] }];</script>for (const group of groups) {
  <section>
    <h2>{group.name}</h2>
    for (const item of group.items) {
      <p>{item}</p>
    }
  </section>
}`,
    data: { groups: [{ name: 'g', items: ['x', 'y'] }] },
  },
  {
    id: 'control-flow/indexed-loop',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Svelte each index maps to explicit native index variable.',
    svelteSource: `<script>let items = ['a', 'b'];</script>{#each items as item, i}<p>{i}:{item}</p>{/each}`,
    kozeSource: `<script>const items = ['a', 'b'];</script>let i = 0;
for (const item of items) {
  <p>{i}:{item}</p>
  i++;
}`,
    data: { items: ['a', 'b'] },
  },
  {
    id: 'control-flow/classic-for-loop',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Native classic for loops can expose loop locals to following template expressions.',
    svelteSource: `<script>let items = ['a', 'b'];</script>{#each items as item, i}<p>{i}:{item}</p>{/each}`,
    kozeSource: `<script>const items = ['a', 'b'];</script>for (let i = 0; i < items.length; i++) {
  <p>{i}:{items[i]}</p>
}`,
    data: { items: ['a', 'b'] },
  },
  {
    id: 'control-flow/if-inside-each',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Nested conditions inside iteration.',
    svelteSource: `<script>let rows = [{ label: 'a', visible: true }, { label: 'b', visible: false }];</script><ul>{#each rows as row}{#if row.visible}<li>{row.label}</li>{/if}{/each}</ul>`,
    kozeSource: `<script>const rows = [{ label: 'a', visible: true }, { label: 'b', visible: false }];</script><ul>
for (const row of rows) {
  if (row.visible) {
    <li>{row.label}</li>
  }
}
</ul>`,
    data: { rows: [{ label: 'a', visible: true }, { label: 'b', visible: false }] },
  },
  {
    id: 'control-flow/continue-in-loop',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Native continue statements inside template loops.',
    svelteSource: `<script>let rows = [{ label: 'a', skip: false }, { label: 'b', skip: true }, { label: 'c', skip: false }];</script>{#each rows as row}{#if !row.skip}<p>{row.label}</p>{/if}{/each}`,
    kozeSource: `<script>const rows = [{ label: 'a', skip: false }, { label: 'b', skip: true }, { label: 'c', skip: false }];</script>for (const row of rows) {
  if (row.skip) {
    continue;
  }
  <p>{row.label}</p>
}`,
    data: { rows: [{ label: 'a', skip: false }, { label: 'b', skip: true }, { label: 'c', skip: false }] },
  },
  {
    id: 'control-flow/switch-statement',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Native switch control lines map to equivalent Svelte branches.',
    svelteSource: `<script>let state = 'paid';</script>{#if state === 'draft'}<p>draft</p>{:else if state === 'paid'}<p>paid</p>{:else}<p>unknown</p>{/if}`,
    kozeSource: `<script>const state = 'paid';</script>switch (state) {
case 'draft':
  <p>draft</p>
  break;
case 'paid':
  <p>paid</p>
  break;
default:
  <p>unknown</p>
}`,
    data: { state: 'paid' },
  },
  {
    id: 'control-flow/break-in-loop',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Native break statements support early loop exit; Svelte equivalent filters output through if blocks.',
    svelteSource: `<script>let rows = ['a', 'b', 'c'];</script>{#each rows as row}{#if row !== 'c'}<p>{row}</p>{/if}{/each}`,
    kozeSource: `<script>const rows = ['a', 'b', 'c'];</script>for (const row of rows) {
  if (row === 'c') {
    break;
  }
  <p>{row}</p>
}`,
    data: { rows: ['a', 'b', 'c'] },
  },
  {
    id: 'control-flow/template-local-declaration',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Native local declarations inside loops can feed following template expressions.',
    svelteSource: `<script>let rows = ['a', 'b'];</script>{#each rows as row}<p>{row.toUpperCase()}</p>{/each}`,
    kozeSource: `<script>const rows = ['a', 'b'];</script>for (const row of rows) {
  const upper = row.toUpperCase();
  <p>{upper}</p>
}`,
    data: { rows: ['a', 'b'] },
  },
  {
    id: 'control-flow/destructured-local-declaration',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Native destructuring declarations inside template control flow do not get parsed as template expressions.',
    svelteSource: `<script>let rows = [{ item: { label: 'Alpha' } }, { item: { label: 'Beta' } }];</script>{#each rows as row}<p>{row.item.label}</p>{/each}`,
    kozeSource: `<script>const rows = [{ item: { label: 'Alpha' } }, { item: { label: 'Beta' } }];</script>for (const row of rows) {
  const { item: activeItem } = row;
  <p>{activeItem.label}</p>
}`,
    data: { rows: [{ item: { label: 'Alpha' } }, { item: { label: 'Beta' } }] },
  },
  {
    id: 'control-flow/destructured-each-binding',
    category: 'control-flow',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Svelte destructured each bindings map to native destructured for-of bindings.',
    svelteSource: `<script>let rows = [{ item: { label: 'Alpha' } }, { item: { label: 'Beta' } }];</script>{#each rows as { item }}<p>{item.label}</p>{/each}`,
    kozeSource: `<script>const rows = [{ item: { label: 'Alpha' } }, { item: { label: 'Beta' } }];</script>for (const { item } of rows) {
  <p>{item.label}</p>
}`,
    data: { rows: [{ item: { label: 'Alpha' } }, { item: { label: 'Beta' } }] },
  },
  {
    id: 'sfc/comments',
    category: 'sfc',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Comments with braces or script-looking text should not affect render parity.',
    svelteSource: `<script>let title = 'safe';</script><!-- {ignored} <script>ignored()</script> --><h2>{title}</h2>`,
    kozeSource: `<script>const title = 'safe';</script><!-- {ignored} <script>ignored()</script> --><h2>{title}</h2>`,
    data: { title: 'safe' },
  },
  {
    id: 'sfc/style-block',
    category: 'sfc',
    status: 'ported-pass',
    assertion: 'compile',
    notes: 'Style block compiles on both sides; SSR placement differs by framework.',
    svelteSource: `<style>h1 { color: red; }</style><h1>Styled</h1>`,
    kozeSource: `<style>h1 { color: red; }</style><h1>Styled</h1>`,
  },
  {
    id: 'sfc/style-raw-script-text',
    category: 'sfc',
    status: 'ported-pass',
    assertion: 'compile',
    notes: 'Script-looking text inside CSS strings is raw style content, not an SFC script block.',
    svelteSource: `<script>let title = 'Styled';</script><style>.icon::before { content: "<script></script>"; }</style><h1>{title}</h1>`,
    kozeSource: `<script>const title = 'Styled';</script><style>.icon::before { content: "<script></script>"; }</style><h1>{title}</h1>`,
  },
  {
    id: 'sfc/leading-doctype',
    category: 'sfc',
    status: 'ported-pass',
    assertion: 'compile',
    notes: 'Leading doctype compiles on both sides; component SSR serialization differs.',
    svelteSource: `<!doctype html><main>Document</main>`,
    kozeSource: `<!doctype html><main>Document</main>`,
  },
  {
    id: 'event/basic-click',
    category: 'event',
    status: 'ported-pass',
    assertion: 'compile',
    notes: 'Event syntax compiles; runtime event behavior is framework-specific.',
    svelteSource: `<script>function increment() {}</script><button onclick={increment}>+</button>`,
    kozeSource: `<script>function increment() {}</script><button onClick={increment()}>+</button>`,
    data: { increment() {} },
  },
  {
    id: 'binding/value',
    category: 'binding',
    status: 'ported-pass',
    assertion: 'compile',
    notes: 'Binding syntax compiles; Kuratchi emits its own data-k binding metadata.',
    svelteSource: `<script>let value = 'abc';</script><input bind:value>`,
    kozeSource: `<script>let value = 'abc';</script><input bind:value={value}>`,
    data: { value: 'abc' },
  },
  {
    id: 'binding/checked',
    category: 'binding',
    status: 'ported-pass',
    assertion: 'compile',
    notes: 'Checked binding syntax compiles into Kuratchi binding metadata.',
    svelteSource: `<script>let checked = true;</script><input type="checkbox" bind:checked>`,
    kozeSource: `<script>let checked = true;</script><input type="checkbox" bind:checked={checked}>`,
    data: { checked: true },
  },
  {
    id: 'component/self-closing-props',
    category: 'component',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Imported component calls pass expression props to the component renderer.',
    svelteSource: `<script>let title = 'Hello';</script><article><h2>{title}</h2></article>`,
    kozeSource: `<script>const title = 'Hello';</script><Card title={title} />`,
    data: { title: 'Hello' },
    components: {
      Card: {
        fileName: 'card',
        body: `return \`<article><h2>\${__esc(props.title)}</h2></article>\`;`,
      },
    },
  },
  {
    id: 'component/dynamic-quoted-props',
    category: 'component',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Quoted component prop interpolations preserve expression values and mixed string interpolation.',
    svelteSource: `<div><p>foo: lol</p><p>baz: 42 (number)</p><p>qux: this is a piece of string</p><p>quux: core</p></div>`,
    kozeSource: `<script>const bar = 'lol'; const x = 2; const compound = 'piece of'; const go = { deeper: 'core' };</script>
<div>
  <Widget foo='{bar}' baz='{40 + x}' qux='this is a {compound} string' quux='{go.deeper}'/>
</div>`,
    data: { bar: 'lol', x: 2, compound: 'piece of', go: { deeper: 'core' } },
    components: {
      Widget: {
        fileName: 'widget',
        body: `return \`<p>foo: \${__esc(props.foo)}</p><p>baz: \${__esc(props.baz)} (\${typeof props.baz})</p><p>qux: \${__esc(props.qux)}</p><p>quux: \${__esc(props.quux)}</p>\`;`,
      },
    },
  },
  {
    id: 'component/inline-children',
    category: 'component',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Inline component children are rendered and passed as raw child HTML.',
    svelteSource: `<script>let label = 'Child';</script><article><p>{label}</p></article>`,
    kozeSource: `<script>const label = 'Child';</script><Panel><p>{label}</p></Panel>`,
    data: { label: 'Child' },
    components: {
      Panel: {
        fileName: 'panel',
        body: `return \`<article>\${props.children ?? ''}</article>\`;`,
      },
    },
  },
  {
    id: 'component/multiline-children',
    category: 'component',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Multiline component tags pass props and compiled children.',
    svelteSource: `<script>let title = 'Intro'; let body = 'Body';</script><section><h2>{title}</h2><p>{body}</p></section>`,
    kozeSource: `<script>const title = 'Intro'; const body = 'Body';</script><Layout title={title}>
  <p>{body}</p>
</Layout>`,
    data: { title: 'Intro', body: 'Body' },
    components: {
      Layout: {
        fileName: 'layout',
        body: `return \`<section><h2>\${__esc(props.title)}</h2>\${props.children ?? ''}</section>\`;`,
      },
    },
  },
  {
    id: 'component/boolean-prop',
    category: 'component',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Bare component attributes are passed as true boolean props.',
    svelteSource: `<p>enabled</p>`,
    kozeSource: `<Flag enabled />`,
    components: {
      Flag: {
        fileName: 'flag',
        body: `return props.enabled ? '<p>enabled</p>' : '<p>disabled</p>';`,
      },
    },
  },
  {
    id: 'component/greater-than-props',
    category: 'component',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Component prop parsing is quote/brace-aware and does not treat greater-than operators or text as tag endings.',
    svelteSource: `<script>let title = 'A > B'; let priority = 2; let label = 'Ready';</script><article data-title={title} data-tone={priority > 1 ? 'high' : 'low'}><p>{label}</p></article>`,
    kozeSource: `<script>const title = 'A > B'; const priority = 2; const label = 'Ready';</script><Panel title="{title}" tone={priority > 1 ? 'high' : 'low'}><p>{label}</p></Panel>`,
    data: { title: 'A > B', priority: 2, label: 'Ready' },
    components: {
      Panel: {
        fileName: 'panel',
        body: `return \`<article data-title="\${__esc(props.title)}" data-tone="\${__esc(props.tone)}">\${props.children ?? ''}</article>\`;`,
      },
    },
  },
  {
    id: 'diagnostic/script-syntax',
    category: 'diagnostic',
    status: 'ported-pass',
    assertion: 'diagnostic',
    notes: 'Invalid top-level script syntax reports a stable Kuratchi diagnostic.',
    svelteSource: `<script>let value = ;</script><p>{value}</p>`,
    kozeSource: `<script>const value = ;</script><p>{value}</p>`,
    expectedKozeErrorCode: 'KUR_SCRIPT_SYNTAX',
    svelteShouldThrow: true,
  },
  {
    id: 'diagnostic/template-expression',
    category: 'diagnostic',
    status: 'ported-pass',
    assertion: 'diagnostic',
    notes: 'Invalid template expression syntax reports a stable diagnostic.',
    svelteSource: `<p>{value(}</p>`,
    kozeSource: `<p>{value(}</p>`,
    expectedKozeErrorCode: 'KUR_TEMPLATE_EXPRESSION_SYNTAX',
    svelteShouldThrow: true,
  },
  {
    id: 'diagnostic/attribute-expression',
    category: 'diagnostic',
    status: 'ported-pass',
    assertion: 'diagnostic',
    notes: 'Invalid attribute expression syntax reports a stable diagnostic.',
    svelteSource: `<button data-value={value(}>Broken</button>`,
    kozeSource: `<button data-value={value(}>Broken</button>`,
    expectedKozeErrorCode: 'KUR_TEMPLATE_ATTRIBUTE_SYNTAX',
    svelteShouldThrow: true,
  },
  {
    id: 'diagnostic/late-script',
    category: 'diagnostic',
    status: 'ported-pass',
    assertion: 'diagnostic',
    notes: 'Kuratchi rejects scripts after markup by design.',
    kozeSource: `<main>Content</main><script>const late = true;</script>`,
    expectedKozeErrorCode: 'KUR_SCRIPT_PLACEMENT',
  },
  {
    id: 'diagnostic/duplicate-script',
    category: 'diagnostic',
    status: 'ported-pass',
    assertion: 'diagnostic',
    notes: 'Kuratchi rejects multiple route scripts by design.',
    kozeSource: `<script>const a = 1;</script><script>const b = 2;</script><p>{a}</p>`,
    expectedKozeErrorCode: 'KUR_SCRIPT_PLACEMENT',
  },
  {
    id: 'diagnostic/removed-html-shorthand',
    category: 'diagnostic',
    status: 'ported-pass',
    assertion: 'diagnostic',
    notes: 'Removed {=html ...} shorthand reports an actionable diagnostic.',
    kozeSource: `<script>const content = '<b>x</b>';</script>{=html content}`,
    expectedKozeErrorCode: 'KUR_TEMPLATE_EXPRESSION_SYNTAX',
  },
  {
    id: 'diagnostic/unmatched-template-brace',
    category: 'diagnostic',
    status: 'ported-pass',
    assertion: 'diagnostic',
    notes: 'Unclosed template expressions report a stable unmatched-brace diagnostic.',
    kozeSource: `<p>{value</p>`,
    expectedKozeErrorCode: 'KUR_TEMPLATE_UNMATCHED_BRACE',
  },
  {
    id: 'diagnostic/unclosed-script-block',
    category: 'diagnostic',
    status: 'ported-pass',
    assertion: 'diagnostic',
    notes: 'Unclosed script blocks report a stable diagnostic.',
    svelteSource: `<script>let value = 1;</script`,
    kozeSource: `<script>const value = 1;`,
    expectedKozeErrorCode: 'KUR_UNCLOSED_SCRIPT_BLOCK',
    svelteShouldThrow: true,
  },
  {
    id: 'sfc/module-script',
    category: 'sfc',
    status: 'intentional-divergence',
    notes: 'Svelte module context is replaced by Kuratchi $lib/$server modules and one client-first route script.',
  },
  {
    id: 'component/multi-file-props',
    category: 'component',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Component props match the Svelte render shape; a real filesystem multi-file component harness covers typed props, spreads, slots, and relative child imports.',
    svelteSource: `<script>let title = 'Revenue'; let count = 3; let tier = 'gold'; let childLabel = 'Revenue';</script><article data-title={title} data-tier={tier}><h2>{title}:{count}</h2><p>{childLabel} grew</p></article>`,
    kozeSource: `<script>const title = 'Revenue'; const attrs = { 'data-tier': 'gold', hidden: false }; const childLabel = 'Revenue';</script><Card title={title} count={3} attrs={attrs}><p>{childLabel} grew</p></Card>`,
    data: {
      title: 'Revenue',
      attrs: { 'data-tier': 'gold', hidden: false },
      childLabel: 'Revenue',
    },
    components: {
      Card: {
        fileName: 'card',
        body: `return '<article data-title="' + __esc(props.title) + '" data-tier="' + __esc(props.attrs['data-tier']) + '"><h2>' + __esc(props.title) + ':' + __esc(props.count ?? 0) + '</h2>' + (props.children ?? '') + '</article>';`,
      },
    },
  },
  {
    id: 'control-flow/await-block',
    category: 'control-flow',
    status: 'intentional-divergence',
    notes: 'Svelte {#await} syntax is replaced by Kuratchi AsyncValue branches (`if (x.pending)`, `else if (x.success)`, `else if (x.error)`) so RPC state stays plain template control flow.',
  },
  {
    id: 'control-flow/key-block',
    category: 'control-flow',
    status: 'intentional-divergence',
    notes: 'Svelte {#key} is Svelte-specific lifecycle syntax; Kuratchi should expose any remount behavior through its own APIs.',
  },
  {
    id: 'control-flow/const-tag',
    category: 'control-flow',
    status: 'intentional-divergence',
    notes: 'Svelte {@const} is unnecessary because Kuratchi templates already support native JS declarations in control flow.',
  },
  {
    id: 'component/snippet-render',
    category: 'component',
    status: 'intentional-divergence',
    notes: 'Svelte snippets/render tags are Svelte-specific component syntax; Kuratchi should keep its own component and slot model.',
  },
  {
    id: 'attribute/class-directive',
    category: 'attribute',
    status: 'intentional-divergence',
    notes: 'Svelte class: directives are intentionally replaced by plain class expressions in Kuratchi.',
  },
  {
    id: 'attribute/style-expression',
    category: 'attribute',
    status: 'ported-pass',
    assertion: 'render',
    notes: 'Whole-style attribute expressions render the same as Svelte after removing Kuratchi style-property shorthand.',
    svelteSource: `<script>let styleText = 'color: red; opacity: 0.5';</script><p style={styleText}>Styled</p>`,
    kozeSource: `<script>const styleText = 'color: red; opacity: 0.5';</script><p style={styleText}>Styled</p>`,
    data: { styleText: 'color: red; opacity: 0.5' },
  },
  {
    id: 'event/transition-directive',
    category: 'event',
    status: 'intentional-divergence',
    notes: 'Svelte transition directives are Svelte syntax; Kuratchi should use explicit CSS/client helpers for motion.',
  },
  {
    id: 'event/use-action',
    category: 'event',
    status: 'intentional-divergence',
    notes: 'Svelte use:action is intentionally separate from Kuratchi server action={fn} and should not share syntax.',
  },
  {
    id: 'diagnostic/runes',
    category: 'diagnostic',
    status: 'not-applicable',
    notes: 'Svelte rune diagnostics do not map to Kuratchi syntax.',
  },
];

export function getSvelteParityFixtures(status: SvelteParityStatus): SvelteParityFixture[] {
  return SVELTE_PARITY_FIXTURES.filter((fixture) => fixture.status === status);
}
