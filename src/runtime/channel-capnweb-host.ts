import { newHttpBatchRpcResponse, newWorkersWebSocketRpcResponse, RpcTarget } from 'capnweb';
import type { KuratchiChannelCallFrame } from './channel-protocol.js';
import type { KuratchiHostInvokeResult } from './channel-host.js';

export type KuratchiCapnWebDispatcher = (
  input: KuratchiChannelCallFrame,
) => Promise<KuratchiHostInvokeResult> | KuratchiHostInvokeResult;

const RpcTargetBase = RpcTarget as unknown as new () => object;

export function createKuratchiCapnWebRoot(dispatch: KuratchiCapnWebDispatcher) {
  return new class KuratchiCapnWebRoot extends RpcTargetBase {
    async call(input: KuratchiChannelCallFrame): Promise<KuratchiHostInvokeResult> {
      return dispatch(normalizeFrame(input));
    }
  }();
}

export function createKuratchiCapnWebHttpResponse(
  request: Request,
  dispatch: KuratchiCapnWebDispatcher,
): Promise<Response> {
  return newHttpBatchRpcResponse(request, createKuratchiCapnWebRoot(dispatch));
}

export function createKuratchiCapnWebWebSocketResponse(
  request: Request,
  dispatch: KuratchiCapnWebDispatcher,
): Response {
  return newWorkersWebSocketRpcResponse(request, createKuratchiCapnWebRoot(dispatch));
}

export function isKuratchiCapnWebWebSocketRequest(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

function normalizeFrame(input: KuratchiChannelCallFrame): KuratchiChannelCallFrame {
  const frame = input && typeof input === 'object' ? input : { op: '' };
  return {
    op: typeof frame.op === 'string' ? frame.op : '',
    args: Array.isArray(frame.args) ? frame.args : [],
    target: frame.target === 'server' ? 'server' : 'route',
    route: typeof frame.route === 'string' ? frame.route : undefined,
    kind: frame.kind ?? 'query',
  };
}
