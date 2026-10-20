import { isObject, isString, isUndefined } from 'ohnejs/utils';

/**
 * A row duplicates a unique index or the primary key.
 */
export const UNIQUE_VIOLATION = '23505';

/**
 * A write breaks a foreign key, on insert or on a restricted delete.
 */
export const FOREIGN_KEY_VIOLATION = '23503';

/**
 * A value outgrew a fixed limit, such as the size of an index entry.
 */
export const PROGRAM_LIMIT_EXCEEDED = '54000';

/**
 * A statement ran after an earlier one failed, so the transaction can only roll back.
 */
export const IN_FAILED_SQL_TRANSACTION = '25P02';

/**
 * The role lacks a privilege, such as setting `session_replication_role`.
 */
export const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * A lock wait ran past `lock_timeout`.
 */
export const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Postgres broke a deadlock by failing this transaction.
 */
export const DEADLOCK_DETECTED = '40P01';

/**
 * A transaction lost to a concurrent one under serializable isolation.
 */
export const SERIALIZATION_FAILURE = '40001';

/**
 * The SQLSTATE `error` carries in its `code`, or `undefined` when it carries none.
 *
 * @example
 * ```ts
 * sqlstateOf(caught)          // -> '23505' after a duplicate key
 * sqlstateOf(new Error('no')) // -> undefined
 * ```
 */
export function sqlstateOf(error: unknown): string | undefined {
  if (!isObject(error)) return undefined;
  const code = error['code'];
  return isString(code) ? code : undefined;
}

/**
 * The columns of the index a failed write names, read back from `error.constraint`.
 * The name is `UX__<table>__<columns>` for a unique index, `IX__` for a plain one, the columns joined by `_`.
 * An empty piece therefore marks an internal column, which starts with `_`.
 * Field columns are camelCase, so the split is unambiguous.
 * The parse counts only when the columns rebuild the exact name.
 * A primary key, a name truncated with a `$` hash, or a missing `table` or `constraint` gives `null`.
 *
 * @example
 * ```ts
 * constraintColumns({ table: 'Users', constraint: 'UX__Users__email' })
 * // -> ['email']
 *
 * constraintColumns({ table: 'Posts_authors', constraint: 'UX__Posts_authors___parentUUID__targetUUID' })
 * // -> ['_parentUUID', '_targetUUID']
 *
 * constraintColumns({ table: 'Posts', constraint: 'PK__Posts' })
 * // -> null
 * ```
 */
export function constraintColumns(error: unknown): string[] | null {
  if (!isObject(error)) return null;
  const { table, constraint } = error;
  if (!isString(table) || !isString(constraint) || constraint.includes('$')) return null;
  const prefix = ['UX__', 'IX__']
    .map((kind) => `${kind}${table}__`)
    .find((candidate) => constraint.startsWith(candidate));
  if (isUndefined(prefix)) return null;
  const columns: string[] = [];
  let internal = '';
  for (const piece of constraint.slice(prefix.length).split('_')) {
    if (piece === '') {
      internal += '_';
    } else {
      columns.push(internal + piece);
      internal = '';
    }
  }
  if (columns.length === 0 || prefix + columns.join('_') !== constraint) return null;
  return columns;
}
