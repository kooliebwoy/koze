import { createThenableAsyncValue, type ThenableAsyncValue } from './async-value.js';
import {
  invokeKuratchiCapnWebHttp,
  invokeKuratchiCapnWebWebSocket,
} from './channel-capnweb-client.js';

export type { ThenableAsyncValue } from './async-value.js';

export type KuratchiChannelCarrier = 'capnweb-http' | 'capnweb-ws';
export type KuratchiChannelTarget = 'route' | 'server';

export interface KuratchiChannelInvokeInput {
  op: string;
  args?: unknown[];
  carrier?: KuratchiChannelCarrier;
  target?: KuratchiChannelTarget;
  endpoint?: string;
  route?: string;
  kind?: 'query' | 'mutation' | 'action' | 'session';
  idleMs?: number;
}

export interface KuratchiChannelInvokeOptions {
  onSuccess?: (input: KuratchiChannelInvokeInput, value: unknown) => void;
}

export interface KuratchiChannelClient {
  invoke<T = unknown>(input: KuratchiChannelInvokeInput): Promise<T>;
}

export interface KuratchiBrowserChannelGlobal {
  invoke<T = unknown>(input: KuratchiChannelInvokeInput): Promise<T>;
  createRpcValue<T = unknown>(
    input: KuratchiChannelInvokeInput,
    options?: KuratchiChannelInvokeOptions,
  ): ThenableAsyncValue<T>;
}

declare global {
  interface Window {
    __kozeChannel?: KuratchiBrowserChannelGlobal;
    /** @deprecated Use `__kozeChannel` instead. */
    __kuratchiChannel?: KuratchiBrowserChannelGlobal;
  }
}

function assertBrowserRuntime(): void {
  if (typeof window === 'undefined') {
    throw new Error('[koze] Channel RPC can only run in the browser.');
  }
}

export function createKuratchiChannelClient(): KuratchiChannelClient {
  return {
    invoke<T = unknown>(input: KuratchiChannelInvokeInput): Promise<T> {
      assertBrowserRuntime();
      const carrier = input.carrier ?? 'capnweb-http';
      if (carrier === 'capnweb-ws') return invokeKuratchiCapnWebWebSocket<T>(input);
      return invokeKuratchiCapnWebHttp<T>(input);
    },
  };
}

let defaultBrowserChannel: KuratchiChannelClient | null = null;

export function getKuratchiChannel(): KuratchiChannelClient {
  if (!defaultBrowserChannel) defaultBrowserChannel = createKuratchiChannelClient();
  installKuratchiChannelGlobal();
  return defaultBrowserChannel;
}

export function invokeKuratchiChannel<T = unknown>(input: KuratchiChannelInvokeInput): Promise<T> {
  return getKuratchiChannel().invoke<T>(input);
}

export function createKuratchiRpcAsyncValue<T = unknown>(
  input: KuratchiChannelInvokeInput,
  options: KuratchiChannelInvokeOptions = {},
): ThenableAsyncValue<T> {
  installKuratchiChannelGlobal();
  const promise = invokeKuratchiChannel<T>(input);
  const invalidateReads = () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('koze:invalidate-reads', { detail: { rpcId: input.op } }));
      window.dispatchEvent(new CustomEvent('kuratchi:invalidate-reads', { detail: { rpcId: input.op } }));
    }
  };
  return createThenableAsyncValue(promise, {
    onSuccess(value) {
      options.onSuccess?.(input, value);
      invalidateReads();
    },
    onError() {
      invalidateReads();
    },
  });
}

function installKuratchiChannelGlobal(): void {
  if (typeof window === 'undefined') return;
  if (window.__kozeChannel) {
    window.__kuratchiChannel ??= window.__kozeChannel;
    return;
  }
  window.__kozeChannel = {
    invoke: (input) => invokeKuratchiChannel(input),
    createRpcValue: (input, options) => createKuratchiRpcAsyncValue(input, options),
  };
  window.__kuratchiChannel = window.__kozeChannel;
}
