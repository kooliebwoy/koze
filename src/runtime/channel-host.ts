import {
  SchemaValidationError,
  validateSchemaInput,
} from './schema.js';
import { KURATCHI_CHANNEL_PROBE_OP } from './channel-protocol.js';

export type KuratchiHostOperationKind = 'query' | 'mutation' | 'action' | 'session';

export interface KuratchiHostInvokeInput {
  op: string;
  args?: unknown[];
  kind?: KuratchiHostOperationKind;
}

export interface KuratchiHostInvokeOk {
  ok: true;
  value: unknown;
}

export interface KuratchiHostInvokeError {
  ok: false;
  status: number;
  error: string;
}

export type KuratchiHostInvokeResult = KuratchiHostInvokeOk | KuratchiHostInvokeError;

export interface KuratchiChannelHostOptions {
  operations?: Record<string, (...args: any[]) => Promise<unknown> | unknown> | null;
  schemas?: Record<string, any> | null;
}

function normalizeArgs(args: unknown[] | undefined): unknown[] {
  return Array.isArray(args) ? args : [];
}

function sanitizeHostError(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'RPC call failed';
}

export function createKuratchiChannelHost(opts: KuratchiChannelHostOptions) {
  const operations = opts.operations ?? {};
  const schemas = opts.schemas ?? {};

  return {
    async invoke(input: KuratchiHostInvokeInput): Promise<KuratchiHostInvokeResult> {
      if (input.op === KURATCHI_CHANNEL_PROBE_OP) {
        return {
          ok: true,
          value: true,
        };
      }

      const fn = operations[input.op];
      if (typeof fn !== 'function') {
        return {
          ok: false,
          status: 404,
          error: `Unknown channel operation: ${input.op}`,
        };
      }

      try {
        const validatedArgs = validateSchemaInput(schemas[input.op], normalizeArgs(input.args));
        return {
          ok: true,
          value: await fn(...validatedArgs),
        };
      } catch (err) {
        if (err instanceof SchemaValidationError || (err as { isSchemaValidationError?: boolean } | null)?.isSchemaValidationError) {
          return {
            ok: false,
            status: 400,
            error: sanitizeHostError(err),
          };
        }
        throw err;
      }
    },
  };
}

export async function invokeKuratchiChannelHost(
  opts: KuratchiChannelHostOptions,
  input: KuratchiHostInvokeInput,
): Promise<KuratchiHostInvokeResult> {
  return createKuratchiChannelHost(opts).invoke(input);
}
