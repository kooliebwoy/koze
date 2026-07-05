export const KOZE_CHANNEL_ENDPOINT = '/__koze/channel';
export const KOZE_LEGACY_CHANNEL_ENDPOINT = '/__kuratchi/channel';
export const KOZE_CHANNEL_PROBE_OP = '__koze.probe';

/** @deprecated Use `KOZE_CHANNEL_ENDPOINT` instead. */
export const KURATCHI_CHANNEL_ENDPOINT = KOZE_CHANNEL_ENDPOINT;
/** @deprecated Use `KOZE_CHANNEL_PROBE_OP` instead. */
export const KURATCHI_CHANNEL_PROBE_OP = KOZE_CHANNEL_PROBE_OP;

export type KuratchiChannelTarget = 'route' | 'server';

export interface KuratchiChannelCallFrame {
  op: string;
  args?: unknown[];
  target?: KuratchiChannelTarget;
  route?: string;
  kind?: 'query' | 'mutation' | 'action' | 'session';
}
