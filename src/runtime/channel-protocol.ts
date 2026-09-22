export const KOZE_CHANNEL_ENDPOINT = '/__koze/channel';
export const KOZE_CHANNEL_PROBE_OP = '__koze.probe';

export type KuratchiChannelTarget = 'route' | 'server';

export interface KuratchiChannelCallFrame {
  op: string;
  args?: unknown[];
  target?: KuratchiChannelTarget;
  route?: string;
  kind?: 'query' | 'mutation' | 'action' | 'session';
}
