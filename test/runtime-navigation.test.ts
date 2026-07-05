import { Window } from 'happy-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { navigateTo, redirect, refreshRoute } from '../src/runtime/navigation.ts';
import { RedirectError, __setRequestContext } from '../src/runtime/context.ts';

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalCustomEvent = globalThis.CustomEvent;

afterEach(() => {
  vi.restoreAllMocks();
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
});

describe('runtime navigation', () => {
  test('redirect throws RedirectError', () => {
    __setRequestContext({} as ExecutionContext, new Request('https://example.com/'), {});

    expect(() => redirect('/login')).toThrow(RedirectError);
  });

  test('redirect includes path in error', () => {
    __setRequestContext({} as ExecutionContext, new Request('https://example.com/'), {});

    try {
      redirect('/dashboard');
    } catch (err) {
      expect(err).toBeInstanceOf(RedirectError);
      expect((err as RedirectError).location).toBe('/dashboard');
    }
  });

  test('redirect defaults to 303 status', () => {
    __setRequestContext({} as ExecutionContext, new Request('https://example.com/'), {});

    try {
      redirect('/home');
    } catch (err) {
      expect((err as RedirectError).status).toBe(303);
    }
  });

  test('redirect accepts custom status', () => {
    __setRequestContext({} as ExecutionContext, new Request('https://example.com/'), {});

    try {
      redirect('/moved', 301);
    } catch (err) {
      expect((err as RedirectError).status).toBe(301);
    }
  });

  test('redirect supports 302 temporary redirect', () => {
    __setRequestContext({} as ExecutionContext, new Request('https://example.com/'), {});

    try {
      redirect('/temp', 302);
    } catch (err) {
      expect((err as RedirectError).status).toBe(302);
    }
  });

  test('navigateTo fetches same-origin HTML and updates browser history', async () => {
    const window = new Window({ url: 'https://example.com/start' });
    const navigated: string[] = [];
    window.addEventListener('koze:navigation', (event) => {
      navigated.push((event as CustomEvent<{ url: string }>).detail.url);
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      expect(url).toBe('https://example.com/next?tab=1');
      expect(headers.get('x-koze-navigation')).toBe('1');
      return new Response('<!doctype html><html><body><main id="next">Next</main></body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof fetch;

    Object.defineProperty(globalThis, 'window', {
      value: window,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'CustomEvent', {
      value: window.CustomEvent,
      configurable: true,
      writable: true,
    });

    await navigateTo('/next?tab=1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe('https://example.com/next?tab=1');
    expect(window.document.querySelector('#next')?.textContent).toBe('Next');
    expect(navigated).toEqual(['https://example.com/next?tab=1']);
    window.close();
  });

  test('refreshRoute refetches the current URL and replaces history state', async () => {
    const window = new Window({ url: 'https://example.com/dashboard?filter=open' });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toBe('https://example.com/dashboard?filter=open');
      return new Response('<!doctype html><html><body><main id="fresh">Fresh</main></body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof fetch;

    Object.defineProperty(globalThis, 'window', {
      value: window,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'CustomEvent', {
      value: window.CustomEvent,
      configurable: true,
      writable: true,
    });

    await refreshRoute();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe('https://example.com/dashboard?filter=open');
    expect(window.history.state).toMatchObject({ __koze: true });
    expect(window.document.querySelector('#fresh')?.textContent).toBe('Fresh');
    window.close();
  });
});
