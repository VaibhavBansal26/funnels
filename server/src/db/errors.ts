/** Driver-independent database errors, so services never match on driver messages. */
export class DbError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UniqueViolation extends DbError {
  constructor(
    message: string,
    cause?: unknown,
    /** Constraint or index name when the driver reports it (PostgreSQL), otherwise the column list text (SQLite). */
    public readonly constraint?: string,
  ) {
    super(message, cause);
  }
}

export class ForeignKeyViolation extends DbError {}

export class SerializationFailure extends DbError {}

export const isUniqueViolation = (e: unknown): e is UniqueViolation => e instanceof UniqueViolation;
export const isForeignKeyViolation = (e: unknown): e is ForeignKeyViolation => e instanceof ForeignKeyViolation;

/** SQLite extended result codes (UNIQUE, PRIMARYKEY, FOREIGNKEY) and PostgreSQL SQLSTATEs (23505, 23503, 40001, 40P01). */
export function mapDriverError(e: unknown): unknown {
  const err = e as { code?: string | number; errcode?: number; message?: string; constraint?: string };
  if (!err || typeof err !== 'object') return e;
  const msg = err.message ?? String(e);
  if (err.errcode === 2067 || err.errcode === 1555 || err.code === '23505') return new UniqueViolation(msg, e, err.constraint ?? /failed: (.*)$/.exec(msg)?.[1]);
  if (err.errcode === 787 || err.code === '23503') return new ForeignKeyViolation(msg, e);
  if (err.code === '40001' || err.code === '40P01') return new SerializationFailure(msg, e);
  return e;
}
