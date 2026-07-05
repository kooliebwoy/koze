import { afterEach, describe, expect, test, vi } from 'vitest';
import { newWebSocketRpcSession } from 'capnweb';
import {
  createKuratchiRpcAsyncValue,
  invokeKuratchiChannel,
} from '../src/runtime/channel.js';
import {
  createKuratchiCapnWebHttpResponse,
  createKuratchiCapnWebRoot,
} from '../src/runtime/channel-capnweb-host.js';
import { invokeKuratchiChannelHost } from '../src/runtime/channel-host.js';
import { KURATCHI_CHANNEL_PROBE_OP } from '../src/runtime/channel-protocol.js';
import { schema } from '../src/runtime/schema.js';

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

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
  Object.defineProperty(globalThis, 'WebSocket', {
    value: originalWebSocket,
    configurable: true,
    writable: true,
  });
});

function installBrowser(fetchImpl: typeof fetch) {
  const dispatchEvent = vi.fn();
  Object.defineProperty(globalThis, 'window', {
    value: {
      location: {
        pathname: '/dashboard',
        origin: 'https://example.com',
      },
      dispatchEvent,
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: fetchImpl,
    configurable: true,
    writable: true,
  });
  return { dispatchEvent };
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static connect: ((socket: MockWebSocket, url: string) => void) | null = null;

  readyState = MockWebSocket.OPEN;
  peer: MockWebSocket | null = null;
  listeners = new Map<string, Array<(event: any) => void>>();

  constructor(url?: string) {
    if (url) MockWebSocket.connect?.(this, url);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(message: string): void {
    this.peer?.emit('message', { data: message });
  }

  close(code: number = 1000, reason: string = ''): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.emit('close', { code, reason });
    if (this.peer && this.peer.readyState !== MockWebSocket.CLOSED) {
      this.peer.readyState = MockWebSocket.CLOSED;
      this.peer.emit('close', { code, reason });
    }
  }

  accept(): void {}

  emit(type: string, event: any): void {
    queueMicrotask(() => {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    });
  }
}

function installMockWebSocket(dispatch: Parameters<typeof createKuratchiCapnWebRoot>[0]) {
  const urls: string[] = [];
  MockWebSocket.connect = (client, url) => {
    urls.push(url);
    const server = new MockWebSocket();
    client.peer = server;
    server.peer = client;
    newWebSocketRpcSession(server as unknown as WebSocket, createKuratchiCapnWebRoot(dispatch));
  };
  Object.defineProperty(globalThis, 'WebSocket', {
    value: MockWebSocket,
    configurable: true,
    writable: true,
  });
  return { urls };
}

describe('Kuratchi Channel runtime', () => {
  test('invokes RPC through the Capn Web HTTP batch channel by default', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : new URL(String(input), 'https://example.com').toString();
      const request = input instanceof Request
        ? input
        : new Request(url, init);
      return createKuratchiCapnWebHttpResponse(request, (frame) => {
        expect(frame).toMatchObject({
          target: 'route',
          route: '/dashboard',
          op: 'rpc_ping',
          args: ['a'],
        });
        return { ok: true, value: 'pong' };
      });
    }) as unknown as typeof fetch;
    installBrowser(fetchMock);

    await expect(invokeKuratchiChannel({ op: 'rpc_ping', args: ['a'] })).resolves.toBe('pong');

    const [input] = vi.mocked(fetchMock).mock.calls[0];
    const calledUrl = input instanceof Request ? input.url : String(input);
    expect(calledUrl).toContain('/__koze/channel');
  });

  test('installs a browser global facade for compiler-emitted channel stubs', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : new URL(String(input), 'https://example.com').toString();
      const request = input instanceof Request
        ? input
        : new Request(url, init);
      return createKuratchiCapnWebHttpResponse(request, () => ({ ok: true, value: 'pong' }));
    }) as unknown as typeof fetch;
    const { dispatchEvent } = installBrowser(fetchMock);

    await expect(invokeKuratchiChannel({ op: 'rpc_ping', args: [] })).resolves.toBe('pong');

    expect(window.__kozeChannel).toBeDefined();
    const value = window.__kozeChannel!.createRpcValue<string>({ op: 'rpc_again', args: [] });
    await expect(value).resolves.toBe('pong');
    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    expect(dispatchEvent.mock.calls.map(([event]) => (event as Event).type)).toEqual([
      'koze:invalidate-reads',
      'kuratchi:invalidate-reads',
    ]);
  });

  test('invokes server-target RPC through the Capn Web channel', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : new URL(String(input), 'https://example.com').toString();
      const request = input instanceof Request
        ? input
        : new Request(url, init);
      return createKuratchiCapnWebHttpResponse(request, (frame) => {
        expect(frame).toMatchObject({
          target: 'server',
          op: 'users/getUser',
          args: [{ id: '123' }],
        });
        return { ok: true, value: { userId: '123' } };
      });
    }) as unknown as typeof fetch;
    installBrowser(fetchMock);

    await expect(invokeKuratchiChannel({
      target: 'server',
      op: 'users/getUser',
      args: [{ id: '123' }],
    })).resolves.toEqual({ userId: '123' });

    const [input] = vi.mocked(fetchMock).mock.calls[0];
    const calledUrl = input instanceof Request ? input.url : String(input);
    expect(calledUrl).toContain('/__koze/channel');
  });

  test('invokes RPC through a Capn Web HTTP batch channel', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : new URL(String(input), 'https://example.com').toString();
      const request = input instanceof Request
        ? input
        : new Request(url, init);
      return createKuratchiCapnWebHttpResponse(request, (frame) => {
        return invokeKuratchiChannelHost(
          {
            operations: {
              getUser: async ({ id }: { id: string }) => ({ id, name: 'Ada' }),
            },
          },
          { op: 'getUser', args: frame.args, kind: frame.kind },
        );
      });
    }) as unknown as typeof fetch;
    installBrowser(fetchMock);

    await expect(invokeKuratchiChannel({
      carrier: 'capnweb-http',
      op: 'database/users/getUser',
      args: [{ id: 'u1' }],
    })).resolves.toEqual({ id: 'u1', name: 'Ada' });

    const [input] = vi.mocked(fetchMock).mock.calls[0];
    const calledUrl = input instanceof Request ? input.url : String(input);
    expect(calledUrl).toContain('/__koze/channel');
  });

  test('invokes RPC through a Capn Web WebSocket channel', async () => {
    installBrowser(originalFetch);
    const { urls } = installMockWebSocket((frame) => {
      if (frame.op === KURATCHI_CHANNEL_PROBE_OP) return { ok: true, value: true };

      return invokeKuratchiChannelHost(
        {
          operations: {
            getUser: async ({ id }: { id: string }) => ({ id, name: 'Ada' }),
          },
        },
        { op: 'getUser', args: frame.args, kind: frame.kind },
      );
    });

    await expect(invokeKuratchiChannel({
      carrier: 'capnweb-ws',
      op: 'database/users/getUser',
      args: [{ id: 'u1' }],
      idleMs: 1000,
    })).resolves.toEqual({ id: 'u1', name: 'Ada' });

    expect(urls).toEqual(['wss://example.com/__koze/channel']);
  });

  test('does not fall back to legacy fetch when an explicit WebSocket carrier fails', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('HTTP fallback must not run');
    }) as unknown as typeof fetch;
    installBrowser(fetchMock);

    const urls: string[] = [];
    MockWebSocket.connect = (client, url) => {
      urls.push(url);
      client.readyState = MockWebSocket.CLOSED;
    };
    Object.defineProperty(globalThis, 'WebSocket', {
      value: MockWebSocket,
      configurable: true,
      writable: true,
    });

    const input = {
      carrier: 'capnweb-ws' as const,
      endpoint: 'https://cooldown.example.com/__koze/channel',
      op: 'database/users/getUser',
      args: [{ id: 'u1' }],
    };

    await expect(invokeKuratchiChannel(input)).rejects.toThrow('Capn Web WebSocket RPC transport failed');
    await expect(invokeKuratchiChannel(input)).rejects.toThrow('Capn Web WebSocket RPC transport failed');

    expect(urls).toEqual(['wss://cooldown.example.com/__koze/channel']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('returns an AsyncValue and dispatches invalidation on success', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : new URL(String(input), 'https://example.com').toString();
      const request = input instanceof Request
        ? input
        : new Request(url, init);
      return createKuratchiCapnWebHttpResponse(request, () => ({ ok: true, value: ['todo'] }));
    }) as unknown as typeof fetch;
    const { dispatchEvent } = installBrowser(fetchMock);

    const todos = createKuratchiRpcAsyncValue<string[]>({ op: 'rpc_todos', args: [] });

    expect(todos.pending).toBe(true);
    await expect(todos).resolves.toEqual(['todo']);
    expect(todos.success).toBe(true);
    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    expect(dispatchEvent.mock.calls.map(([event]) => (event as Event).type)).toEqual([
      'koze:invalidate-reads',
      'kuratchi:invalidate-reads',
    ]);
  });

  test('host validates schemas and dispatches operations', async () => {
    const result = await invokeKuratchiChannelHost(
      {
        operations: {
          saveDraft: async ({ title }: { title: string }) => title,
        },
        schemas: {
          saveDraft: schema({ title: schema.string().min(1) }),
        },
      },
      { op: 'saveDraft', args: [{ title: 'hello' }] },
    );

    expect(result).toEqual({ ok: true, value: 'hello' });

    const invalid = await invokeKuratchiChannelHost(
      {
        operations: {
          saveDraft: async ({ title }: { title: string }) => title,
        },
        schemas: {
          saveDraft: schema({ title: schema.string().min(1) }),
        },
      },
      { op: 'saveDraft', args: [{ title: '' }] },
    );

    expect(invalid).toEqual({
      ok: false,
      status: 400,
      error: 'data.title must be at least 1 character(s)',
    });
  });
});
