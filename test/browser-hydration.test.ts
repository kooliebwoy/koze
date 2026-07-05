import { Window } from 'happy-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  buildBridgeScriptTag,
  buildReactiveRuntimeScriptTag,
} from '../src/compiler/root-layout-pipeline.js';
import { compileTemplate } from '../src/compiler/template.js';
import { createKuratchiRpcAsyncValue } from '../src/runtime/channel.js';
import { createKuratchiCapnWebHttpResponse } from '../src/runtime/channel-capnweb-host.js';

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalCustomEvent = globalThis.CustomEvent;

function escapeHtml(value: unknown): string {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function rawHtml(value: unknown): string {
  return value == null ? '' : String(value);
}

function sanitizeHtml(value: unknown): string {
  return rawHtml(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

function renderSsr(template: string, data: Record<string, unknown>): string {
  const body = compileTemplate(template);
  const keys = Object.keys(data);
  const values = Object.values(data);
  const render = new Function(...keys, '__esc', '__rawHtml', '__sanitizeHtml', `${body}\nreturn __html;`);
  return render(...values, escapeHtml, rawHtml, sanitizeHtml);
}

function renderOwnedSsr(template: string, data: Record<string, unknown>, ownerId: string): string {
  const body = compileTemplate(template, undefined, undefined, undefined, { reactiveOwnerId: ownerId });
  const keys = Object.keys(data);
  const values = Object.values(data);
  const render = new Function(...keys, '__esc', '__rawHtml', '__sanitizeHtml', `${body}\nreturn __html;`);
  return render(...values, escapeHtml, rawHtml, sanitizeHtml);
}

function renderStateAugmentSsr(template: string, data: Record<string, unknown>): string {
  const body = compileTemplate(
    template,
    undefined,
    new Set(['createDb']),
    undefined,
    { augmentedActionNames: new Set(['createDb']) },
  );
  const keys = Object.keys(data);
  const values = Object.values(data);
  const render = new Function(...keys, '__esc', '__rawHtml', '__sanitizeHtml', `${body}\nreturn __html;`);
  return render(...values, escapeHtml, rawHtml, sanitizeHtml);
}

function renderStateAugmentSsrWithDialogComponent(
  template: string,
  data: Record<string, unknown>,
  ownerId: string,
): string {
  const body = compileTemplate(
    template,
    new Map([['Dialog', 'dialog']]),
    new Set(['createDb']),
    undefined,
    { augmentedActionNames: new Set(['createDb']), reactiveOwnerId: ownerId },
  );
  const keys = Object.keys(data);
  const values = Object.values(data);
  const render = new Function('__c_dialog', ...keys, '__esc', '__rawHtml', '__sanitizeHtml', `${body}\nreturn __html;`);
  const dialogComponent = (props: Record<string, unknown>, esc = escapeHtml) => {
    const id = typeof props.id === 'string' ? props.id : 'dialog';
    const bindOpen = typeof props.bind_open === 'string' ? props.bind_open : '';
    const owner = typeof props.__kozeOwner === 'string' ? props.__kozeOwner : '';
    return `<div data-k-island-root><dialog id="${esc(id)}"${props.open ? ' open' : ''}${bindOpen ? ' data-k-bind-prop="open"' : ''}${bindOpen ? ` data-k-bind-expr="${esc(bindOpen)}"` : ''}${owner ? ` data-k-owner="${esc(owner)}"` : ''}>${props.children || ''}</dialog></div>`;
  };
  return render(dialogComponent, ...values, escapeHtml, rawHtml, sanitizeHtml);
}

function scriptBody(scriptTag: string): string {
  const match = scriptTag.match(/^<script>([\s\S]*)<\/script>$/);
  if (!match) throw new Error('Expected a single inline script tag.');
  return match[1];
}

async function flushMicrotasks(count = 8): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

async function flushBrowser(window: Window): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await window.happyDOM.whenAsyncComplete();
}

async function mountTemplate(
  template: string,
  data: Record<string, unknown> = {},
): Promise<{ window: Window; document: Document }> {
  const window = new Window({ url: 'https://example.test/' });
  const document = window.document;

  window.eval(scriptBody(buildReactiveRuntimeScriptTag(true)));
  document.body.innerHTML = renderSsr(template, data);

  for (const script of Array.from(document.querySelectorAll('script'))) {
    window.eval(script.textContent || '');
  }

  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await flushBrowser(window);
  return { window, document };
}

function input(document: Document, selector: string): HTMLInputElement {
  const element = document.querySelector(selector);
  if (!(element instanceof document.defaultView!.HTMLInputElement)) {
    throw new Error(`Expected input for selector: ${selector}`);
  }
  return element;
}

function button(document: Document, selector: string): HTMLButtonElement {
  const element = document.querySelector(selector);
  if (!(element instanceof document.defaultView!.HTMLButtonElement)) {
    throw new Error(`Expected button for selector: ${selector}`);
  }
  return element;
}

describe('browser hydration runtime', () => {
  const windows: Window[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const window of windows.splice(0)) {
      window.close();
    }
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'CustomEvent', {
      value: originalCustomEvent,
      configurable: true,
      writable: true,
    });
    Reflect.deleteProperty(globalThis, '__externalCount');
  });

  async function mount(template: string, data: Record<string, unknown> = {}) {
    const mounted = await mountTemplate(template, data);
    windows.push(mounted.window);
    return mounted;
  }

  function installBrowserGlobals(window: Window, fetchImpl: typeof fetch): void {
    Object.defineProperty(window, 'fetch', {
      value: fetchImpl,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: window,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchImpl,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'CustomEvent', {
      value: window.CustomEvent,
      configurable: true,
      writable: true,
    });
  }

  function stateAugmentTemplate(hooksSource = ''): string {
    return `<script>
let createDbOpen = true;
const createDb = window.__kozeAugment('createDb', 'createDatabase', window.__createDatabase, {
  pending() {
    window.__events.push('pending');
  },
  error(payload) {
    window.__events.push(['error', payload.error]);
    createDbOpen = true;
  },
  success(payload) {
    window.__events.push(['success', payload.result ?? null]);
    createDbOpen = false;
    ${hooksSource}
  },
  settled(payload) {
    window.__events.push(['settled', payload.error ?? null]);
  },
});
</script>
if (createDb.success) {
  <p id="success" role="status">Database created.</p>
}
<dialog id="create-db-dialog" bind:open={createDbOpen}>
  <form action={createDb} method="POST">
    <input name="name" value="alpha-db">
    if (createDb.error) {
      <p id="action-error" role="alert">{createDb.error}</p>
    }
    <button id="submit" type="submit" disabled={createDb.pending}>
      if (createDb.pending) {
        <span id="pending">Creating...</span>
      } else {
        <span id="idle">Create Database</span>
      }
    </button>
  </form>
</dialog>
<p id="sentinel">same document</p>`;
  }

  function componentStateAugmentTemplate(hooksSource = ''): string {
    return `<script>
let createDbOpen = true;
const createDb = window.__kozeAugment('createDb', 'createDatabase', window.__createDatabase, {
  pending() {
    window.__events.push('pending');
  },
  error(payload) {
    window.__events.push(['error', payload.error]);
    createDbOpen = true;
  },
  success(payload) {
    window.__events.push(['success', payload.result ?? null]);
    createDbOpen = false;
    ${hooksSource}
  },
  settled(payload) {
    window.__events.push(['settled', payload.error ?? null]);
  },
});
</script>
if (createDb.success) {
  <p id="success" role="status">Database created.</p>
}
<Dialog id="create-db-dialog" bind:open={createDbOpen}>
  <form action={createDb} method="POST">
    <input name="name" value="alpha-db">
    if (createDb.error) {
      <p id="action-error" role="alert">{createDb.error}</p>
    }
    <button id="submit" type="submit" disabled={createDb.pending}>
      if (createDb.pending) {
        <span id="pending">Creating...</span>
      } else {
        <span id="idle">Create Database</span>
      }
    </button>
  </form>
</Dialog>
<p id="sentinel">same document</p>`;
  }

  async function mountStateAugmentTemplate(
    window: Window,
    template: string,
  ): Promise<Document> {
    const document = window.document;
    window.eval(scriptBody(buildReactiveRuntimeScriptTag(true)));
    window.eval(scriptBody(buildBridgeScriptTag(true)));
    document.body.innerHTML = renderStateAugmentSsr(template, {
      createDb: { error: undefined, pending: false, success: false },
      createDbOpen: true,
    });
    for (const script of Array.from(document.querySelectorAll('script'))) {
      window.eval(script.textContent || '');
    }
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushMicrotasks();
    return document;
  }

  async function mountComponentStateAugmentTemplate(
    window: Window,
    template: string,
  ): Promise<Document> {
    const document = window.document;
    window.eval(scriptBody(buildReactiveRuntimeScriptTag(true)));
    window.eval(scriptBody(buildBridgeScriptTag(true)));
    document.body.innerHTML = renderStateAugmentSsrWithDialogComponent(template, {
      createDb: { error: undefined, pending: false, success: false },
      createDbOpen: true,
    }, 'owner-route');
    for (const script of Array.from(document.querySelectorAll('script'))) {
      window.eval(script.textContent || '');
    }
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushMicrotasks();
    return document;
  }

  test('bind:value updates dependent text through the hydrated reactive scope', async () => {
    const { window, document } = await mount(`<script>
let name = 'world';
</script>
<input id="name" bind:value={name}>
<p>Hello <span id="label">{name}</span></p>`, { name: 'world' });

    const nameInput = input(document, '#name');
    expect(nameInput.value).toBe('world');
    expect(document.querySelector('#label')?.textContent).toBe('world');

    nameInput.value = 'Ada';
    nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await flushBrowser(window);

    expect(document.querySelector('#label')?.textContent).toBe('Ada');
  });

  test('delegated client handlers run after target bind listeners', async () => {
    const window = new Window({ url: 'https://example.test/' });
    windows.push(window);
    const document = window.document;

    window.eval(scriptBody(buildBridgeScriptTag(true)));
    const events: string[] = [];
    const client = window as unknown as {
      __kozeClient?: {
        register(routeId: string, handlers: Record<string, (args: unknown[], event: Event, element: Element) => void>): void;
      };
    };
    client.__kozeClient?.register('route-a', {
      h0: () => {
        events.push((document.querySelector('#visit-type') as HTMLSelectElement).dataset.boundValue ?? '');
      },
    });

    document.body.innerHTML = `
      <select id="visit-type" data-client-route="route-a" data-cce-change="h0">
        <option value="">Choose...</option>
        <option value="Drop Off">Drop Off</option>
      </select>
    `;

    const visitType = document.querySelector('#visit-type') as HTMLSelectElement;
    visitType.addEventListener('change', () => {
      visitType.dataset.boundValue = visitType.value;
    });

    visitType.value = 'Drop Off';
    visitType.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flushBrowser(window);

    expect(events).toEqual(['Drop Off']);
  });

  test('bind:checked updates dependent attributes and text through the hydrated scope', async () => {
    const { window, document } = await mount(`<script>
let enabled = false;
</script>
<input id="enabled" type="checkbox" bind:checked={enabled}>
<p id="status" data-enabled={enabled}>{enabled ? 'enabled' : 'disabled'}</p>`, { enabled: false });

    const checkbox = input(document, '#enabled');
    const status = document.querySelector('#status') as HTMLElement;
    expect(checkbox.checked).toBe(false);
    expect(status.getAttribute('data-enabled')).toBe('false');
    expect(status.textContent).toBe('disabled');

    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flushBrowser(window);

    expect(status.getAttribute('data-enabled')).toBe('true');
    expect(status.textContent).toBe('enabled');
  });

  test('client event expressions update reactive attributes and text', async () => {
    const { window, document } = await mount(`<script>
let clicked = false;
</script>
<button id="toggle" onClick={clicked = true}>Toggle</button>
<p id="status" hidden={!clicked}>{clicked ? 'open' : 'closed'}</p>`, { clicked: false });

    const status = document.querySelector('#status') as HTMLParagraphElement;
    expect(status.hidden).toBe(true);
    expect(status.textContent).toBe('closed');

    button(document, '#toggle').dispatchEvent(new window.Event('click', { bubbles: true }));
    await flushBrowser(window);

    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('open');
  });

  test('owner-scoped route hydration works inside a component island root', async () => {
    const window = new Window({ url: 'https://example.test/' });
    windows.push(window);
    const document = window.document;

    window.eval(scriptBody(buildReactiveRuntimeScriptTag(true)));
    document.body.innerHTML = `<div data-k-island-root>${renderOwnedSsr(`<script>
let count = 0;
</script>
<button id="inc" onClick={count = count + 1}>{count}</button>`, { count: 0 }, 'owner-route')}</div>`;
    for (const script of Array.from(document.querySelectorAll('script'))) {
      window.eval(script.textContent || '');
    }
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowser(window);

    button(document, '#inc').dispatchEvent(new window.Event('click', { bubbles: true }));
    await flushBrowser(window);

    expect(document.querySelector('#inc')?.textContent).toBe('1');
  });

  test('re-running browser init does not double-bind event handlers', async () => {
    const { window, document } = await mount(`<script>
let count = 0;
</script>
<button id="inc" onClick={count = count + 1}>{count}</button>`, { count: 0 });

    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    document.dispatchEvent(new window.Event('DOMContentLoaded'));

    button(document, '#inc').dispatchEvent(new window.Event('click', { bubbles: true }));
    await flushBrowser(window);

    expect(document.querySelector('#inc')?.textContent).toBe('1');
  });

  test('reactive block anchors insert and remove DOM when state changes', async () => {
    const { window, document } = await mount(`<script>
let visible = false;
</script>
<button id="show" onClick={visible = true}>Show</button>
if (visible) {
  <p id="panel">Visible</p>
}`, { visible: false });

    expect(document.querySelector('#panel')).toBeNull();

    button(document, '#show').dispatchEvent(new window.Event('click', { bubbles: true }));
    await flushBrowser(window);

    expect(document.querySelector('#panel')?.textContent).toBe('Visible');
  });

  test('raw HTML anchors rerender sanitized HTML after reactive updates', async () => {
    const { window, document } = await mount(`<script>
let content = '<strong>safe</strong>';
</script>
<button id="swap" onClick={content = '<scr' + 'ipt>bad</scr' + 'ipt><em>ok</em>'}>Swap</button>
<section id="html">{@html content}</section>`, { content: '<strong>safe</strong>' });

    const section = document.querySelector('#html') as HTMLElement;
    expect(section.querySelector('strong')?.textContent).toBe('safe');

    button(document, '#swap').dispatchEvent(new window.Event('click', { bubbles: true }));
    await flushBrowser(window);

    expect(section.querySelector('script')).toBeNull();
    expect(section.querySelector('em')?.textContent).toBe('ok');
  });

  test('serialized local scope keeps loop bindings reactive in hydrated attributes', async () => {
    const { window, document } = await mount(`<script>
const rows = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
let selected = 'a';
</script>
<button id="next" onClick={selected = 'b'}>Next</button>
for (const row of rows) {
  <span data-row={row.id} data-active={row.id === selected}>{row.label}</span>
}`, {
      rows: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      selected: 'a',
    });

    const rows = Array.from(document.querySelectorAll('[data-row]')) as HTMLElement[];
    expect(rows.map((row) => row.getAttribute('data-active'))).toEqual(['true', 'false']);

    button(document, '#next').dispatchEvent(new window.Event('click', { bubbles: true }));
    await flushBrowser(window);

    expect(rows.map((row) => row.getAttribute('data-active'))).toEqual(['false', 'true']);
  });

  test('channel invalidation reruns hydrated effects that read external state', async () => {
    Object.defineProperty(globalThis, '__externalCount', {
      value: 1,
      configurable: true,
      writable: true,
    });
    const { window, document } = await mount(`<script>
globalThis.__externalCount = 1;
let probe = 0;
</script>
<p id="external-count">{probe + globalThis.__externalCount}</p>`, { probe: 0 });

    expect(document.querySelector('#external-count')?.textContent).toBe('1');

    (window as unknown as { __externalCount: number }).__externalCount = 2;
    window.dispatchEvent(new window.CustomEvent('koze:invalidate-reads', {
      detail: { rpcId: 'rpc_count' },
    }));
    await flushBrowser(window);

    expect(document.querySelector('#external-count')?.textContent).toBe('2');
    Reflect.deleteProperty(globalThis, '__externalCount');
  });

  test('browser channel returns AsyncValue state and dispatches invalidation through Capn Web HTTP', async () => {
    const window = new Window({ url: 'https://example.test/projects/active' });
    windows.push(window);
    const invalidated: string[] = [];
    window.addEventListener('koze:invalidate-reads', (event) => {
      invalidated.push((event as CustomEvent<{ rpcId: string }>).detail.rpcId);
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : new URL(String(input), window.location.origin).toString();
      const request = input instanceof Request ? input : new Request(url, init);
      expect(request.url).toBe('https://example.test/__koze/browser-channel');

      return createKuratchiCapnWebHttpResponse(request, (frame) => {
        expect(frame).toMatchObject({
          target: 'route',
          route: '/projects/active',
          op: 'rpc_projects',
          args: [{ status: 'open' }],
        });
        return { ok: true, value: ['alpha', 'beta'] };
      });
    }) as unknown as typeof fetch;
    installBrowserGlobals(window, fetchMock);

    const projects = createKuratchiRpcAsyncValue<string[]>({
      endpoint: 'https://example.test/__koze/browser-channel',
      op: 'rpc_projects',
      args: [{ status: 'open' }],
    });

    expect(projects.pending).toBe(true);
    expect(projects.success).toBe(false);
    await expect(projects).resolves.toEqual(['alpha', 'beta']);

    expect(projects.pending).toBe(false);
    expect(projects.success).toBe(true);
    expect(projects.error).toBeNull();
    expect(projects[0]).toBe('alpha');
    expect(invalidated).toEqual(['rpc_projects']);
    expect(window.__kozeChannel).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('browser channel exposes RPC errors through AsyncValue error state', async () => {
    const window = new Window({ url: 'https://example.test/settings' });
    windows.push(window);
    const invalidated: string[] = [];
    window.addEventListener('koze:invalidate-reads', (event) => {
      invalidated.push((event as CustomEvent<{ rpcId: string }>).detail.rpcId);
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : new URL(String(input), window.location.origin).toString();
      const request = input instanceof Request ? input : new Request(url, init);
      return createKuratchiCapnWebHttpResponse(request, (frame) => {
        expect(frame).toMatchObject({
          target: 'server',
          route: '/settings',
          op: 'settings/save',
        });
        return { ok: false, status: 403, error: 'Forbidden' };
      });
    }) as unknown as typeof fetch;
    installBrowserGlobals(window, fetchMock);

    const result = createKuratchiRpcAsyncValue<{ saved: boolean }>({
      endpoint: 'https://example.test/__koze/browser-channel',
      target: 'server',
      op: 'settings/save',
      args: [{ theme: 'dark' }],
    });

    expect(result.pending).toBe(true);
    await expect(result).rejects.toThrow('Forbidden');

    expect(result.pending).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Forbidden');
    expect(invalidated).toEqual(['settings/save']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('state-augmented form actions submit through fetch and update action state without replacing the document', async () => {
    const window = new Window({ url: 'https://example.test/settings' });
    windows.push(window);
    const hooks = {
      pending: vi.fn(),
      error: vi.fn(),
      settled: vi.fn(),
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : new URL(String(input), window.location.origin).toString();
      const method = input instanceof Request ? input.method : String(init?.method || 'GET');
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      expect(url).toBe('https://example.test/settings');
      expect(method).toBe('POST');
      expect(headers.get('x-koze-action')).toBe('augment');
      expect(headers.get('accept')).toBe('application/json');

      const body = init?.body;
      expect(body).toBeInstanceOf(window.FormData);
      expect((body as FormData).get('_action')).toBe('saveSettings');
      expect((body as FormData).get('theme')).toBe('dark');

      return new Response(JSON.stringify({
        ok: false,
        action: 'saveSettings',
        error: 'Validation message',
        state: { error: 'Validation message', pending: false, success: false },
      }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    installBrowserGlobals(window, fetchMock);

    const document = window.document;
    window.eval(scriptBody(buildReactiveRuntimeScriptTag(true)));
    window.eval(scriptBody(buildBridgeScriptTag(true)));
    const action = (window as unknown as {
      __kozeAugment: (alias: string, target: string, fn: () => void, hooks: Record<string, unknown>) => {
        error: string | undefined;
        pending: boolean;
        success: boolean;
      };
    }).__kozeAugment('saveSettings', 'saveSettings', () => {}, hooks);

    document.body.innerHTML = `<form method="post" data-action-augment="saveSettings">
      <input type="hidden" name="_action" value="saveSettings">
      <input name="theme" value="dark">
      <button type="submit" id="bulk-delete" disabled>Delete selected</button>
      <button type="submit">Save</button>
    </form>`;

    const form = document.querySelector('form') as HTMLFormElement;
    const disabledButton = document.querySelector('#bulk-delete') as HTMLButtonElement;
    const submitButton = document.querySelector('button:not([disabled])') as HTMLButtonElement;
    const submitted = form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    expect(submitted).toBe(false);
    expect(form.getAttribute('data-action-pending')).toBe('saveSettings');
    expect(disabledButton.disabled).toBe(true);
    expect(submitButton.disabled).toBe(true);
    expect(action.pending).toBe(true);
    expect(hooks.pending).toHaveBeenCalledTimes(1);

    await flushBrowser(window);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector('form')).toBe(form);
    expect(action.pending).toBe(false);
    expect(action.success).toBe(false);
    expect(action.error).toBe('Validation message');
    expect(disabledButton.disabled).toBe(true);
    expect(submitButton.disabled).toBe(false);
    expect(hooks.error).toHaveBeenCalledTimes(1);
    expect(hooks.settled).toHaveBeenCalledTimes(1);
  });

  test('state-augmented forms read form-associated controls outside the form element', async () => {
    const window = new Window({ url: 'https://example.test/visitation/control' });
    windows.push(window);
    const hooks = {
      pending: vi.fn(),
      success: vi.fn(),
      settled: vi.fn(),
    };

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-koze-action')).toBe('augment');

      const body = init?.body as FormData;
      expect(body.get('_action')).toBe('reviewVisitItem');
      expect(body.get('visitId')).toBe('visit-1');
      expect(body.get('itemId')).toBe('item-1');
      expect(body.get('decision')).toBe('Approved');

      return new Response(JSON.stringify({
        ok: true,
        action: 'reviewVisitItem',
        result: { visitId: 'visit-1' },
        state: { error: undefined, pending: false, success: true },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    installBrowserGlobals(window, fetchMock);

    const document = window.document;
    window.eval(scriptBody(buildReactiveRuntimeScriptTag(true)));
    window.eval(scriptBody(buildBridgeScriptTag(true)));
    const action = (window as unknown as {
      __kozeAugment: (alias: string, target: string, fn: () => void, hooks: Record<string, unknown>) => {
        error: string | undefined;
        pending: boolean;
        success: boolean;
      };
    }).__kozeAugment('reviewVisitItem', 'reviewVisitationItem', () => {}, hooks);

    document.body.innerHTML = `<form id="review-form" method="post" data-action-augment="reviewVisitItem"></form>
      <input form="review-form" type="hidden" name="_action" value="reviewVisitItem">
      <input form="review-form" type="hidden" name="visitId" value="visit-1">
      <input form="review-form" type="hidden" name="itemId" value="item-1">
      <input form="review-form" type="hidden" name="decision" value="Approved">
      <button form="review-form" type="submit">Approve</button>`;

    const form = document.querySelector('form') as HTMLFormElement;
    const button = document.querySelector('button') as HTMLButtonElement;
    const submitted = form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    expect(submitted).toBe(false);
    expect(button.disabled).toBe(true);
    expect(action.pending).toBe(true);
    expect(hooks.pending).toHaveBeenCalledTimes(1);

    await flushBrowser(window);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(action.pending).toBe(false);
    expect(action.success).toBe(true);
    expect(button.disabled).toBe(false);
    expect(hooks.success).toHaveBeenCalledTimes(1);
    expect(hooks.settled).toHaveBeenCalledTimes(1);
  });

  test('state-augmented compiled templates render pending and error state in-place', async () => {
    const window = new Window({ url: 'https://example.test/databases' });
    windows.push(window);
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;
    installBrowserGlobals(window, fetchMock);
    Object.assign(window, {
      __createDatabase: vi.fn(),
      __events: [] as unknown[],
    });

    const document = await mountStateAugmentTemplate(window, stateAugmentTemplate());
    const form = document.querySelector('form') as HTMLFormElement;
    const submit = document.querySelector('#submit') as HTMLButtonElement;
    const dialog = document.querySelector('#create-db-dialog') as HTMLDialogElement;
    const sentinel = document.querySelector('#sentinel');

    expect(dialog.open).toBe(true);
    expect(document.querySelector('#idle')?.textContent).toBe('Create Database');
    expect(document.querySelector('#pending')).toBeNull();
    expect(document.querySelector('#action-error')).toBeNull();

    const submitted = form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    expect(submitted).toBe(false);
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(form.getAttribute('data-action-pending')).toBe('createDb');
    expect(submit.disabled).toBe(true);
    expect(document.querySelector('#pending')?.textContent).toBe('Creating...');
    expect(document.querySelector('#idle')).toBeNull();
    expect((window as unknown as { __events: unknown[] }).__events).toContain('pending');

    resolveFetch?.(new Response(JSON.stringify({
      ok: false,
      action: 'createDb',
      error: 'Failed to record database',
      state: { error: 'Failed to record database', pending: false, success: false },
    }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    }));
    await flushMicrotasks();

    expect(document.querySelector('#sentinel')).toBe(sentinel);
    expect(document.querySelector('form')).toBe(form);
    expect(dialog.open).toBe(true);
    expect(form.hasAttribute('data-action-pending')).toBe(false);
    expect(submit.disabled).toBe(false);
    expect(document.querySelector('#pending')).toBeNull();
    expect(document.querySelector('#idle')?.textContent).toBe('Create Database');
    expect(document.querySelector('#action-error')?.textContent).toBe('Failed to record database');
    expect(document.querySelector('#success')).toBeNull();
    expect((window as unknown as { __events: unknown[] }).__events).toEqual([
      'pending',
      ['error', 'Failed to record database'],
      ['settled', 'Failed to record database'],
    ]);
  });

  test('state-augmented component slot forms hydrate with the route owner scope', async () => {
    const window = new Window({ url: 'https://example.test/databases' });
    windows.push(window);
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;
    installBrowserGlobals(window, fetchMock);
    Object.assign(window, {
      __createDatabase: vi.fn(),
      __events: [] as unknown[],
    });

    const document = await mountComponentStateAugmentTemplate(window, componentStateAugmentTemplate());
    const form = document.querySelector('form') as HTMLFormElement;
    const submit = document.querySelector('#submit') as HTMLButtonElement;
    const dialog = document.querySelector('#create-db-dialog') as HTMLDialogElement;

    expect(dialog.getAttribute('data-k-owner')).toBe('owner-route');
    expect(submit.getAttribute('data-k-owner')).toBe('owner-route');
    expect(document.querySelector('#idle')?.textContent).toBe('Create Database');

    const submitted = form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    expect(submitted).toBe(false);
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(form.getAttribute('data-action-pending')).toBe('createDb');
    expect(submit.disabled).toBe(true);
    expect(document.querySelector('#pending')?.textContent).toBe('Creating...');

    resolveFetch?.(new Response(JSON.stringify({
      ok: true,
      action: 'createDb',
      result: { id: 'db_1' },
      state: { error: undefined, pending: false, success: true },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await flushMicrotasks();

    expect(dialog.open).toBe(false);
    expect(submit.disabled).toBe(false);
    expect(document.querySelector('#success')?.textContent).toBe('Database created.');
    expect((window as unknown as { __events: unknown[] }).__events).toEqual([
      'pending',
      ['success', { id: 'db_1' }],
      ['settled', null],
    ]);
  });

  test('state-augmented success renders before deferred navigation hooks run', async () => {
    const window = new Window({ url: 'https://example.test/databases' });
    windows.push(window);
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;
    installBrowserGlobals(window, fetchMock);
    Object.assign(window, {
      __createDatabase: vi.fn(),
      __events: [] as unknown[],
      __navigateCalls: [] as string[],
    });

    const document = await mountStateAugmentTemplate(
      window,
      stateAugmentTemplate("window.setTimeout(() => window.__navigateCalls.push('/databases'), 2000);"),
    );
    const form = document.querySelector('form') as HTMLFormElement;
    const dialog = document.querySelector('#create-db-dialog') as HTMLDialogElement;

    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(document.querySelector('#pending')?.textContent).toBe('Creating...');

    resolveFetch?.(new Response(JSON.stringify({
      ok: true,
      action: 'createDb',
      result: { id: 'db_1' },
      state: { error: undefined, pending: false, success: true },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await flushMicrotasks();

    expect(document.querySelector('#success')?.textContent).toBe('Database created.');
    expect(document.querySelector('#action-error')).toBeNull();
    expect(dialog.open).toBe(false);
    expect((window as unknown as { __navigateCalls: string[] }).__navigateCalls).toEqual([]);
    expect((window as unknown as { __events: unknown[] }).__events).toEqual([
      'pending',
      ['success', { id: 'db_1' }],
      ['settled', null],
    ]);
  });

  test('state-augmented redirect responses expose success before hook-controlled navigation', async () => {
    const window = new Window({ url: 'https://example.test/databases' });
    windows.push(window);
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;
    installBrowserGlobals(window, fetchMock);
    Object.assign(window, {
      __createDatabase: vi.fn(),
      __events: [] as unknown[],
      __navigateCalls: [] as string[],
    });

    const document = await mountStateAugmentTemplate(
      window,
      stateAugmentTemplate('window.setTimeout(() => window.__navigateCalls.push(payload.redirectTo), 2000);'),
    );
    const form = document.querySelector('form') as HTMLFormElement;
    const dialog = document.querySelector('#create-db-dialog') as HTMLDialogElement;

    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(document.querySelector('#pending')?.textContent).toBe('Creating...');

    resolveFetch?.(new Response(JSON.stringify({
      ok: true,
      action: 'createDb',
      redirectTo: '/databases/db_1',
      redirectStatus: 303,
      state: { error: undefined, pending: false, success: true },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await flushMicrotasks();

    expect(window.location.pathname).toBe('/databases');
    expect(document.querySelector('#success')?.textContent).toBe('Database created.');
    expect(dialog.open).toBe(false);
    expect((window as unknown as { __navigateCalls: string[] }).__navigateCalls).toEqual([]);
    expect((window as unknown as { __events: unknown[] }).__events).toEqual([
      'pending',
      ['success', null],
      ['settled', null],
    ]);
  });

  test('augmented form error responses reopen server-marked dialogs', async () => {
    const window = new Window({ url: 'https://example.test/databases' });
    windows.push(window);

    const fetchMock = vi.fn(async () => new Response(`<!doctype html><html><body>
      <dialog id="create-db-dialog" data-kui-open-modal="true">
        <form method="post" augment>
          <input type="hidden" name="_action" value="createDatabase">
          <p role="alert">Failed to record database</p>
        </form>
      </dialog>
    </body></html>`, {
      status: 422,
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch;
    installBrowserGlobals(window, fetchMock);

    const document = window.document;
    window.eval(scriptBody(buildBridgeScriptTag(true)));
    document.body.innerHTML = `<dialog id="create-db-dialog" open>
      <form method="post" augment>
        <input type="hidden" name="_action" value="createDatabase">
        <button type="submit">Create Database</button>
      </form>
    </dialog>`;

    const form = document.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowser(window);

    const dialog = document.querySelector('#create-db-dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Failed to record database');
  });

  test('form actions without augment submit natively', async () => {
    const window = new Window({ url: 'https://example.test/settings' });
    windows.push(window);

    const fetchMock = vi.fn() as unknown as typeof fetch;
    installBrowserGlobals(window, fetchMock);

    const document = window.document;
    window.eval(scriptBody(buildBridgeScriptTag(true)));
    document.body.innerHTML = `<form method="post">
      <input type="hidden" name="_action" value="saveSettings">
      <button type="submit">Save</button>
    </form>`;

    const form = document.querySelector('form') as HTMLFormElement;
    const submitted = form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    expect(submitted).toBe(true);
    expect(form.hasAttribute('data-action-pending')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
