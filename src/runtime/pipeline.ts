import { getEnv } from './context.js';

export interface PipelineBinding<TRecord = Record<string, unknown>> {
  send(records: TRecord[]): Promise<unknown>;
}

export interface PipelineHandle<TRecord = Record<string, unknown>> {
  /** Convention name from `src/server/<name>.pipeline.ts`. */
  name: string;
  /** Worker env binding name. */
  binding: string;
  /** Cloudflare Pipelines stream/pipeline identifier from wrangler config. */
  pipeline: string;
  /** Send one record or an array of records to Cloudflare Pipelines. */
  send(records: TRecord | readonly TRecord[]): Promise<unknown>;
}

interface PipelineRegistryEntry {
  binding: string;
  pipeline: string;
}

let registry: Record<string, PipelineRegistryEntry> | null = null;

/** Internal: populated by compiler/Vite-generated worker modules. */
export function __setPipelineRegistry(nextRegistry: Record<string, PipelineRegistryEntry>): void {
  registry = nextRegistry;
}

function knownPipelineNames(): string[] {
  return registry ? Object.keys(registry) : [];
}

function normalizeRecords<TRecord>(records: TRecord | readonly TRecord[]): TRecord[] {
  return Array.isArray(records) ? [...(records as readonly TRecord[])] : [records as TRecord];
}

function resolvePipelineBinding<TRecord>(name: string): { entry: PipelineRegistryEntry; binding: PipelineBinding<TRecord> } {
  if (!registry || Object.keys(registry).length === 0) {
    throw new Error('No pipelines are registered for this project (did you add src/server/*.pipeline.ts?)');
  }

  const entry = registry[name];
  if (!entry) {
    const known = knownPipelineNames().join(', ') || '(none)';
    throw new Error(`Unknown pipeline '${name}'. Known pipelines: ${known}`);
  }

  const env = getEnv<Record<string, unknown>>();
  const binding = env?.[entry.binding] as PipelineBinding<TRecord> | undefined;
  if (!binding || typeof binding.send !== 'function') {
    throw new Error(`Pipeline binding '${entry.binding}' is not available in env`);
  }

  return { entry, binding };
}

export function pipeline<TRecord = Record<string, unknown>>(name: string): PipelineHandle<TRecord> {
  const { entry, binding } = resolvePipelineBinding<TRecord>(name);
  return {
    name,
    binding: entry.binding,
    pipeline: entry.pipeline,
    send(records) {
      return binding.send(normalizeRecords(records));
    },
  };
}

export function sendPipeline<TRecord = Record<string, unknown>>(
  name: string,
  records: TRecord | readonly TRecord[],
): Promise<unknown> {
  return pipeline<TRecord>(name).send(records);
}

export const pipelines = new Proxy({} as Record<string, PipelineHandle>, {
  get(_target, prop) {
    if (typeof prop !== 'string') return undefined;
    return pipeline(prop);
  },
  has(_target, prop) {
    return typeof prop === 'string' && knownPipelineNames().includes(prop);
  },
  ownKeys() {
    return knownPipelineNames();
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop !== 'string' || !knownPipelineNames().includes(prop)) return undefined;
    return {
      enumerable: true,
      configurable: true,
    };
  },
}) as Record<string, PipelineHandle>;
