import { describe, it, expect } from 'vitest';
import { compileTemplate } from '../src/compiler/template.js';

describe('template compiler multi-line expressions', () => {
  it('handles ternary expressions spanning multiple lines', () => {
    const template = `<span>{isRunning ?
  'Running' : 'Stopped'}</span>`;
    const result = compileTemplate(template);
    expect(result).toContain('isRunning ?');
    expect(result).toContain("'Running'");
    expect(result).toContain("'Stopped'");
    expect(result).not.toContain('isRunning ?)');
  });

  it('handles multi-line object expressions in interpolation', () => {
    const template = `<div data-config={JSON.stringify({
  name: 'test',
  value: 123
})}></div>`;
    const result = compileTemplate(template);
    expect(result).toContain('JSON.stringify');
    expect(result).toContain("name: 'test'");
    expect(result).toContain('value: 123');
  });

  it('handles multi-line function calls in interpolation', () => {
    const template = `<p>{formatDate(
  date,
  'YYYY-MM-DD'
)}</p>`;
    const result = compileTemplate(template);
    expect(result).toContain('formatDate');
    expect(result).toContain('date');
    expect(result).toContain("'YYYY-MM-DD'");
  });

  it('handles nested braces in multi-line expressions', () => {
    const template = `<span>{items.map(x => {
  return x.name;
}).join(', ')}</span>`;
    const result = compileTemplate(template);
    expect(result).toContain('items.map');
    expect(result).toContain('return x.name');
    expect(result).toContain(".join(', ')");
  });

  it('preserves single-line expressions unchanged', () => {
    const template = `<span>{isRunning ? 'yes' : 'no'}</span>`;
    const result = compileTemplate(template);
    expect(result).toContain("isRunning ? 'yes' : 'no'");
  });

  it('injects _action hidden input when <form action={fn}> wraps onto a new line', () => {
    // Regression: the `pendingActionHiddenInput` injection at the end
    // of compileHtmlSegment only spliced into chunks containing `>`.
    // When a `<form>` open tag wrapped its attributes onto a second
    // line, the first chunk had the action={…} but no `>`, so the
    // hidden `<input name="_action">` was silently dropped. The
    // dispatcher then saw a blank `_action` on POST and responded
    // with "Unknown action:".
    const template = `<form action={deleteItem} method="POST" style="display: inline;"
  onsubmit="return confirm('Really delete?')">
  <input type="hidden" name="id" value="1" />
  <button type="submit">Delete</button>
</form>`;
    const result = compileTemplate(template, undefined, new Set(['deleteItem']));
    expect(result).toContain('name="_action" value="deleteItem"');
    // And the raw `action=` attribute must be stripped from the output.
    expect(result).not.toContain('action=deleteItem');
    expect(result).not.toContain('action={deleteItem}');
  });

  it('keeps multi-line attribute VALUES as literal (no hidden-action injection)', () => {
    // Multi-line *attribute values* (a string that spans newlines)
    // must continue to pass through as literal text — that's a
    // different case from a multi-line open tag. Compilers should
    // never try to interpret the line break inside a quoted string
    // as an attribute boundary.
    const template = `<div title="line one
line two">Hello</div>`;
    const result = compileTemplate(template);
    expect(result).toContain('line one');
    expect(result).toContain('line two');
  });

  it('handles complex nested ternary with multi-line HTML content', () => {
    const template = `{isRunning ? (
						<svg class="spinner" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M21 12a9 9 0 11-6.219-8.56"/>
						</svg>
					) : isComplete ? (
						<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
							<polyline points="22 4 12 14.01 9 11.01"/>
						</svg>
					) : isFailed ? (
						<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="10"/>
							<line x1="15" y1="9" x2="9" y2="15"/>
							<line x1="9" y1="9" x2="15" y2="15"/>
						</svg>
					) : (
						<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="10"/>
							<polyline points="12 6 12 12 16 14"/>
						</svg>
					)}`;
    const result = compileTemplate(template);
    // Should contain all condition checks
    expect(result).toContain('isRunning ?');
    expect(result).toContain('isComplete ?');
    expect(result).toContain('isFailed ?');
    // Should contain SVG content
    expect(result).toContain('class="spinner"');
    expect(result).toContain('polyline points="22 4 12 14.01 9 11.01"');
    // Should NOT have truncated expressions
    expect(result).not.toContain('isRunning ?)');
    expect(result).not.toContain('isComplete ?)');
    expect(result).not.toContain('isFailed ?)');
  });
});
