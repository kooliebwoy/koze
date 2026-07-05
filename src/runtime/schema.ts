export class SchemaValidationError extends Error {
  readonly isSchemaValidationError = true;
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

export interface SchemaType<T> {
  parse(input: unknown, path?: string): T;
}

export type InferSchema<T extends SchemaType<any>> = T extends SchemaType<infer U> ? U : never;

function formatPath(path: string): string {
  return path || 'value';
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof File !== 'undefined' && value instanceof File) return 'file';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function fail(path: string, message: string): never {
  throw new SchemaValidationError(`${formatPath(path)} ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(typeof File !== 'undefined' && value instanceof File);
}

class BaseSchema<T> implements SchemaType<T> {
  protected readonly parser: (input: unknown, path: string) => T;

  constructor(parser: (input: unknown, path: string) => T) {
    this.parser = parser;
  }

  parse(input: unknown, path: string = 'value'): T {
    return this.parser(input, path);
  }

  optional(defaultValue?: T): SchemaType<T | undefined> {
    return new BaseSchema<T | undefined>((input, path) => {
      if (typeof input === 'undefined') return defaultValue;
      return this.parse(input, path);
    });
  }

  list(): SchemaType<T[]> {
    return new BaseSchema<T[]>((input, path) => {
      if (!Array.isArray(input)) fail(path, `must be an array, got ${describe(input)}`);
      return input.map((item, index) => this.parse(item, `${path}[${index}]`));
    });
  }
}

class StringSchema extends BaseSchema<string> {
  constructor() {
    super((input, path) => {
      if (typeof input !== 'string') fail(path, `must be a string, got ${describe(input)}`);
      return input;
    });
  }

  min(length: number): SchemaType<string> {
    return new BaseSchema<string>((input, path) => {
      const value = this.parse(input, path);
      if (value.length < length) fail(path, `must be at least ${length} character(s)`);
      return value;
    });
  }
}

class NumberSchema extends BaseSchema<number> {
  constructor() {
    super((input, path) => {
      if (typeof input !== 'number' || Number.isNaN(input)) fail(path, `must be a number, got ${describe(input)}`);
      return input;
    });
  }

  min(value: number): SchemaType<number> {
    return new BaseSchema<number>((input, path) => {
      const parsed = this.parse(input, path);
      if (parsed < value) fail(path, `must be at least ${value}`);
      return parsed;
    });
  }
}

class BooleanSchema extends BaseSchema<boolean> {
  constructor() {
    super((input, path) => {
      if (typeof input !== 'boolean') fail(path, `must be a boolean, got ${describe(input)}`);
      return input;
    });
  }
}

class FileSchema extends BaseSchema<File> {
  constructor() {
    super((input, path) => {
      if (typeof File === 'undefined' || !(input instanceof File)) fail(path, `must be a file, got ${describe(input)}`);
      return input;
    });
  }
}

type ShapeRecord = Record<string, SchemaType<any>>;
type InferShape<TShape extends ShapeRecord> = { [K in keyof TShape]: InferSchema<TShape[K]> };

class ObjectSchema<TShape extends ShapeRecord> extends BaseSchema<InferShape<TShape>> {
  readonly shape: TShape;

  constructor(shape: TShape) {
    super((input, path) => {
      if (!isPlainObject(input)) fail(path, `must be an object, got ${describe(input)}`);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(shape)) {
        out[key] = shape[key].parse((input as Record<string, unknown>)[key], `${path}.${key}`);
      }
      return out as InferShape<TShape>;
    });
    this.shape = shape;
  }
}

type SchemaBuilder = {
  <TShape extends ShapeRecord>(shape: TShape): ObjectSchema<TShape>;
  string(): StringSchema;
  number(): NumberSchema;
  boolean(): BooleanSchema;
  file(): FileSchema;
};

function createSchema<TShape extends ShapeRecord>(shape: TShape): ObjectSchema<TShape> {
  return new ObjectSchema(shape);
}

export const schema: SchemaBuilder = Object.assign(createSchema, {
  string: () => new StringSchema(),
  number: () => new NumberSchema(),
  boolean: () => new BooleanSchema(),
  file: () => new FileSchema(),
});

export function validateSchemaInput<T>(schemaDef: SchemaType<T> | undefined, args: unknown[]): unknown[] {
  if (!schemaDef) return args;
  if (args.length !== 1) {
    throw new SchemaValidationError(`validated RPCs must receive exactly one argument object, got ${args.length}`);
  }
  return [schemaDef.parse(args[0], 'data')];
}

export function parseRpcArgsPayload(payload: string | null): any[] {
  if (!payload) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new SchemaValidationError('args must be valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new SchemaValidationError('args must be a JSON array');
  }
  return parsed;
}
