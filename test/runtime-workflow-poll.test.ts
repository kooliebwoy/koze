import { describe, expect, test } from 'vitest';

import { __getLocals } from '../src/runtime/context.ts';
import { createGeneratedWorker } from '../src/runtime/generated-worker.ts';

/**
 * End-to-end verification of the whole-body polling contract emitted by the
 * generated worker. We simulate what `workflowStatus(..., { poll })` does at
 * SSR time (write `__kozePoll` onto request-scoped locals) and assert the
 * response carries the client-side directive (or the done-signal header).
 */

function makePollingRoute(opts: { interval: string | number; done: boolean }) {
  return {
    pattern: '/status',
    render: () => {
      __getLocals().__kozePoll = { interval: opts.interval, done: opts.done };
      return { html: '<main>live</main>', head: '<title>Live</title>' };
    },
  };
}

describe('workflow poll injection', () => {
  test('injects the poll directive <script> when a running workflow registered polling', async () => {
    const worker = createGeneratedWorker({
      routes: [makePollingRoute({ interval: '2s', done: false })],
      layout: (content, head = '') => `<html><head>${head}</head><body>${content}</body></html>`,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    const response = await worker.fetch(
      new Request('https://example.com/status'),
      {},
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-koze-poll-done')).toBeNull();

    const html = await response.text();
    expect(html).toContain('<script type="application/json" id="__koze_poll">');
    expect(html).toContain('"interval":"2s"');
  });

  test('omits the poll directive and emits x-koze-poll-done when terminal', async () => {
    const worker = createGeneratedWorker({
      routes: [makePollingRoute({ interval: '2s', done: true })],
      layout: (content) => `<body>${content}</body>`,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    const response = await worker.fetch(
      new Request('https://example.com/status'),
      {},
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-koze-poll-done')).toBe('1');

    const html = await response.text();
    expect(html).not.toContain('id="__koze_poll"');
  });

  test('renders static pages unchanged when no workflow registers polling', async () => {
    const worker = createGeneratedWorker({
      routes: [
        {
          pattern: '/',
          render: () => ({ html: '<p>home</p>' }),
        },
      ],
      layout: (content) => `<body>${content}</body>`,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    const response = await worker.fetch(
      new Request('https://example.com/'),
      {},
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-koze-poll-done')).toBeNull();
    const html = await response.text();
    expect(html).not.toContain('id="__koze_poll"');
  });

  test('escapes </script> sequences in the embedded JSON payload', async () => {
    const worker = createGeneratedWorker({
      routes: [
        {
          // Defensive: even though interval is framework-controlled, the escaping
          // path must hold if any future field accepts user input.
          pattern: '/status',
          render: () => {
            __getLocals().__kozePoll = { interval: '2s</script><b>xss</b>', done: false };
            return { html: '<p>live</p>' };
          },
        },
      ],
      layout: (content) => `<body>${content}</body>`,
      layoutActions: {},
      assetsPrefix: '/assets/',
      assets: {},
      errorPages: {},
    });

    const response = await worker.fetch(
      new Request('https://example.com/status'),
      {},
      {} as ExecutionContext,
    );

    const html = await response.text();
    // The naked `</script>` must not appear inside the JSON payload.
    expect(html).not.toContain('2s</script>');
    expect(html).toContain('\\u003c/script>');
  });
});
