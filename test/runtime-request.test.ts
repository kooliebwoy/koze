import { describe, expect, test } from 'vitest';
import { __setRequestContext, __setLocal } from '../src/runtime/context.ts';
import { headers, method, params, pathname, request, searchParams, slug, url } from '../src/runtime/request.ts';

describe('runtime request helpers', () => {
  test('exposes parsed request state as live bindings', () => {
    const incomingRequest = new Request('https://example.com/blog/hello-world?draft=1', {
      method: 'POST',
      headers: { 'x-koze-test': 'yes' },
    });

    __setRequestContext({} as ExecutionContext, incomingRequest, {});
    __setLocal('params', { slug: 'hello-world' });

    expect(request).toBe(incomingRequest);
    expect(url.pathname).toBe('/blog/hello-world');
    expect(pathname).toBe('/blog/hello-world');
    expect(searchParams.get('draft')).toBe('1');
    expect(method).toBe('POST');
    expect(headers.get('x-koze-test')).toBe('yes');
    expect(params.slug).toBe('hello-world');
    expect(slug).toBe('hello-world');
  });

  test('resets route params between requests', () => {
    __setRequestContext({} as ExecutionContext, new Request('https://example.com/account'), {});

    expect(pathname).toBe('/account');
    expect(params).toEqual({});
    expect(slug).toBeUndefined();
  });
});
