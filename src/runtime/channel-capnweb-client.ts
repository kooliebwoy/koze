import { newHttpBatchRpcSession, newWebSocketRpcSession } from 'capnweb';
import { KURATCHI_CHANNEL_ENDPOINT, KURATCHI_CHANNEL_PROBE_OP } from './channel-protocol.js';
import type { KuratchiChannelCallFrame } from './channel-protocol.js';
import type { KuratchiChannelInvokeInput } from './channel.js';
import type { KuratchiHostInvokeResult } from './channel-host.js';

interface KuratchiCapnWebRoot {
  call(input: KuratchiChannelCallFrame): Promise<KuratchiHostInvokeResult>;
}

interface PendingSession {
  root: KuratchiCapnWebRoot;
  timer: ReturnType<typeof setTimeout>;
}

const pendingSessions = new Map<string, PendingSession>();
const pendingWebSocketSessions = new Map<string, Promise<KuratchiCapnWebRoot>>();
const liveSessions = new Map<string, PendingSession>();
const unavailableWebSocketEndpoints = new Map<string, number>();
const DEFAULT_WEBSOCKET_IDLE_MS = 15_000;
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 1_500;
const DEFAULT_WEBSOCKET_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_WEBSOCKET_RETRY_MS = 30_000;

export class KuratchiCapnWebRpcError extends Error {
  readonly status: number;

  constructor(message: string, status: number = 500) {
    super(message);
    this.name = 'KuratchiCapnWebRpcError';
    this.status = status;
  }
}

export class KuratchiCapnWebTransportError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'KuratchiCapnWebTransportError';
    this.cause = cause;
  }
}

function getBatchRoot(endpoint: string): KuratchiCapnWebRoot {
  const existing = pendingSessions.get(endpoint);
  if (existing) return existing.root;

  const root = newHttpBatchRpcSession<any>(endpoint) as unknown as KuratchiCapnWebRoot;
  const timer = setTimeout(() => {
    pendingSessions.delete(endpoint);
  }, 0);
  queueMicrotask(() => {
    pendingSessions.delete(endpoint);
  });
  pendingSessions.set(endpoint, { root, timer });
  return root;
}

async function getWebSocketRoot(endpoint: string, idleMs: number = DEFAULT_WEBSOCKET_IDLE_MS): Promise<KuratchiCapnWebRoot> {
  const existing = liveSessions.get(endpoint);
  if (existing) {
    clearTimeout(existing.timer);
    existing.timer = scheduleWebSocketSessionClose(endpoint, existing.root, idleMs);
    return existing.root;
  }

  if (isWebSocketEndpointUnavailable(endpoint)) {
    throw new Error('WebSocket transport is cooling down after a failed probe.');
  }

  const pending = pendingWebSocketSessions.get(endpoint);
  if (pending) {
    const root = await pending;
    const live = liveSessions.get(endpoint);
    if (live) {
      clearTimeout(live.timer);
      live.timer = scheduleWebSocketSessionClose(endpoint, root, idleMs);
    }
    return root;
  }

  const connection = openWebSocketRoot(endpoint).then((root) => {
    unavailableWebSocketEndpoints.delete(endpoint);
    liveSessions.set(endpoint, {
      root,
      timer: scheduleWebSocketSessionClose(endpoint, root, idleMs),
    });
    return root;
  }).finally(() => {
    pendingWebSocketSessions.delete(endpoint);
  });

  pendingWebSocketSessions.set(endpoint, connection);
  return connection;
}

async function openWebSocketRoot(endpoint: string): Promise<KuratchiCapnWebRoot> {
  const socket = new WebSocket(toWebSocketEndpoint(endpoint));
  try {
    await waitForWebSocketOpen(socket, DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS);
  } catch (err) {
    closeSocket(socket);
    throw err;
  }
  const root = newWebSocketRpcSession<any>(socket) as unknown as KuratchiCapnWebRoot;

  try {
    await probeWebSocketRoot(root);
  } catch (err) {
    disposeRpcRoot(root);
    throw err;
  }

  return root;
}

function isWebSocketEndpointUnavailable(endpoint: string): boolean {
  const retryAt = unavailableWebSocketEndpoints.get(endpoint);
  if (!retryAt) return false;
  if (Date.now() < retryAt) return true;
  unavailableWebSocketEndpoints.delete(endpoint);
  return false;
}

function markWebSocketEndpointUnavailable(endpoint: string): void {
  unavailableWebSocketEndpoints.set(endpoint, Date.now() + DEFAULT_WEBSOCKET_RETRY_MS);
}

async function probeWebSocketRoot(root: KuratchiCapnWebRoot): Promise<void> {
  const result = await withTimeout(
    root.call({
      op: KURATCHI_CHANNEL_PROBE_OP,
      args: [],
      target: 'route',
      kind: 'query',
    }),
    DEFAULT_WEBSOCKET_PROBE_TIMEOUT_MS,
    'WebSocket RPC probe timed out.',
  );
  if (!result || result.ok !== true) {
    throw new Error('WebSocket RPC probe failed.');
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function waitForWebSocketOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  if (socket.readyState !== WebSocket.CONNECTING) {
    return Promise.reject(new Error('WebSocket connection is not open.'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      clearTimeout(timer);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onOpen = () => settle(resolve);
    const onError = () => settle(() => reject(new Error('WebSocket connection failed.')));
    const onClose = () => settle(() => reject(new Error('WebSocket connection closed before opening.')));
    const timer = setTimeout(() => {
      settle(() => {
        try {
          socket.close();
        } catch {
          // Ignore close failures on half-open sockets.
        }
        reject(new Error('WebSocket connection timed out.'));
      });
    }, Math.max(1, timeoutMs));

    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}

function scheduleWebSocketSessionClose(endpoint: string, root: KuratchiCapnWebRoot, idleMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    liveSessions.delete(endpoint);
    disposeRpcRoot(root);
  }, Math.max(0, idleMs));
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

function disposeRpcRoot(root: KuratchiCapnWebRoot): void {
  const disposeKey = (Symbol as unknown as { dispose?: symbol }).dispose;
  if (!disposeKey) return;
  const disposable = root as unknown as Record<symbol, (() => void) | undefined>;
  try {
    disposable[disposeKey]?.();
  } catch {
    // Closing an already-broken socket should not surface as an app error.
  }
}

function closeSocket(socket: WebSocket): void {
  try {
    socket.close();
  } catch {
    // Ignore close failures on rejected connection attempts.
  }
}

function dropWebSocketRoot(endpoint: string): void {
  const existing = liveSessions.get(endpoint);
  if (!existing) return;
  liveSessions.delete(endpoint);
  clearTimeout(existing.timer);
  disposeRpcRoot(existing.root);
}

function toWebSocketEndpoint(endpoint: string): string {
  if (typeof window === 'undefined') return endpoint;
  const base = new URL(endpoint, window.location.origin);
  if (base.protocol === 'https:') base.protocol = 'wss:';
  else if (base.protocol === 'http:') base.protocol = 'ws:';
  return base.toString();
}

function normalizeFrame(input: KuratchiChannelInvokeInput): KuratchiChannelCallFrame {
  const route = input.route ?? (typeof window !== 'undefined' ? window.location.pathname : undefined);
  return {
    op: input.op,
    args: Array.isArray(input.args) ? input.args : [],
    target: input.target ?? 'route',
    route,
    kind: input.kind ?? 'query',
  };
}

export async function invokeKuratchiCapnWebHttp<T = unknown>(
  input: KuratchiChannelInvokeInput,
): Promise<T> {
  const endpoint = input.endpoint || KURATCHI_CHANNEL_ENDPOINT;
  try {
    const result = await getBatchRoot(endpoint).call(normalizeFrame(input));
    if (!result || result.ok !== true) {
      throw new KuratchiCapnWebRpcError(
        result && result.ok === false ? result.error : 'Invalid Capn Web RPC response',
        result && result.ok === false ? result.status : 500,
      );
    }
    return result.value as T;
  } catch (err) {
    if (err instanceof KuratchiCapnWebRpcError) throw err;
    throw new KuratchiCapnWebTransportError('Capn Web RPC transport failed', err);
  }
}

export async function invokeKuratchiCapnWebWebSocket<T = unknown>(
  input: KuratchiChannelInvokeInput,
): Promise<T> {
  const endpoint = input.endpoint || KURATCHI_CHANNEL_ENDPOINT;
  try {
    const result = await (await getWebSocketRoot(endpoint, input.idleMs)).call(normalizeFrame(input));
    if (!result || result.ok !== true) {
      throw new KuratchiCapnWebRpcError(
        result && result.ok === false ? result.error : 'Invalid Capn Web RPC response',
        result && result.ok === false ? result.status : 500,
      );
    }
    return result.value as T;
  } catch (err) {
    dropWebSocketRoot(endpoint);
    if (err instanceof KuratchiCapnWebRpcError) throw err;
    markWebSocketEndpointUnavailable(endpoint);
    throw new KuratchiCapnWebTransportError('Capn Web WebSocket RPC transport failed', err);
  }
}
