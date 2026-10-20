import type {
  DatabaseAdapter,
  DialectFragment,
  ListMembershipOperator,
  LogicalType,
  OrderDirection,
  SchemaTransactionOptions,
  SQLValue,
  TableDiff,
  TableSchema,
  Transaction,
  IndexViolationTarget,
} from 'ohnejs';
import type { PoolConfig } from 'pg';

import { Dialect, isOhneError, ohneError } from 'ohnejs';
import {
  errorMessage,
  isNull,
  isNullish,
  isObject,
  isString,
  isUndefined,
  redactURL,
  uniqueArray,
} from 'ohnejs/utils';
import { codeSpan } from 'ohnejs/utils/ansi';
import { Pool } from 'pg';

import { MAX_PARAMETERS, createAdapter } from './adapter.ts';
import { alterTable, createTable, dropTable, renameTable } from './alter.ts';
import { tableOID } from './catalog.ts';
import {
  DEADLOCK_DETECTED,
  FOREIGN_KEY_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  LOCK_NOT_AVAILABLE,
  PROGRAM_LIMIT_EXCEEDED,
  SERIALIZATION_FAILURE,
  UNIQUE_VIOLATION,
  constraintColumns,
  sqlstateOf,
} from './errors.ts';
import { describeTable, listTables } from './introspect.ts';
import { settlePendingKeys } from './pending-keys.ts';
import { verifyServer } from './server.ts';
import { foldExpression } from './text.ts';
import { typeParsers } from './types.ts';
import { isPostgresURL } from './url.ts';

const COLUMN_TYPES: Record<LogicalType, string> = {
  text: 'TEXT COLLATE "C"',
  json: 'TEXT COLLATE "C"',
  integer: 'BIGINT',
  boolean: 'BIGINT',
  real: 'DOUBLE PRECISION',
};

const BUSY = new Set([LOCK_NOT_AVAILABLE, DEADLOCK_DETECTED, SERIALIZATION_FAILURE]);

const LONE_SURROGATE = String.raw`\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f]`;

/**
 * The Postgres dialect, over `pg`.
 *
 * Text and JSON store as `TEXT COLLATE "C"`, booleans and integers as `BIGINT`, so values code as on SQLite.
 * Writers serialize per schema, and DDL is transactional, so a failed schema change leaves nothing behind.
 * The base lock and rate-limit methods carry over unchanged.
 *
 * @example
 * ```ts
 * useDialects().register('postgres', new PostgresDialect())
 * ```
 */
export class PostgresDialect extends Dialect {
  readonly name = 'postgres';

  readonly maxParameters = MAX_PARAMETERS;

  /**
   * Accepts a `postgres://` or `postgresql://` URL.
   */
  accepts(url: string): boolean {
    return isPostgresURL(url);
  }

  /**
   * Opens a pool on `url` and checks that the server can hold an ohne database before returning.
   * A server that cannot be reached fails with the URL, its secrets removed.
   */
  async connect(url: string): Promise<DatabaseAdapter> {
    const pool = new Pool(this.poolConfig(url));
    const db = createAdapter(pool);
    try {
      await verifyServer(pool);
    } catch (error) {
      await db.close();
      if (isOhneError(error)) throw error;
      throw ohneError({
        title: 'Cannot reach Postgres',
        body: [
          `Connecting to ${codeSpan(redactURL(url))} failed.`,
          errorMessage(error),
          '',
          'Check that the server runs and that the URL names its host, database, user and password.',
        ],
      });
    }
    return db;
  }

  /**
   * Builds the pool settings for `url`.
   * The URL configures each connection only, so the pool keeps the driver's default size.
   * A connection attempt, or a wait for a free one, gives up after 10 s, so a stalled link frees its slot.
   * TCP keepalives find a connection whose server went away while it sat idle.
   */
  protected poolConfig(url: string): PoolConfig {
    return {
      connectionString: url,
      types: typeParsers,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
    };
  }

  /**
   * Wraps an identifier in double quotes, doubling any embedded quote.
   */
  quote(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
  }

  /**
   * Maps a logical type to its column type.
   * Text compares byte-wise under `C`, whatever the cluster's locale.
   */
  columnType(type: LogicalType): string {
    return COLUMN_TYPES[type];
  }

  /**
   * Codes a JS value for storage.
   * Booleans become `1`/`0`, JSON is stringified, `null`/`undefined` are `NULL`.
   */
  serialize(type: LogicalType, value: unknown): SQLValue {
    if (isNullish(value)) return null;
    switch (type) {
      case 'boolean':
        return value ? 1 : 0;
      case 'json':
        return JSON.stringify(value);
      default:
        return value as SQLValue;
    }
  }

  /**
   * Inverts `serialize`: a stored `1`/`0` becomes a boolean, stored JSON is parsed, `NULL` stays `null`.
   */
  deserialize(type: LogicalType, value: SQLValue): unknown {
    if (isNull(value)) return null;
    switch (type) {
      case 'boolean':
        return value !== 0;
      case 'json':
        return JSON.parse(value as string);
      default:
        return value;
    }
  }

  /**
   * An ASCII row matches as it is, since `ILIKE` under `C` folds ASCII case alone.
   * Only a row holding non-ASCII text goes through the inline `foldCase` twin.
   */
  textMatch(quotedColumn: string): string {
    const column =
      `(CASE WHEN octet_length(${quotedColumn}) = length(${quotedColumn}) THEN ${quotedColumn} ` +
      `ELSE ${foldExpression(quotedColumn)} END)`;
    return this.like(column, true);
  }

  /**
   * `ILIKE` under `C`, which folds ASCII case alone.
   * Postgres escapes with a backslash by default, so an unescaped match names no escape at all.
   */
  like(quotedColumn: string, escaped: boolean): string {
    return `${quotedColumn} COLLATE "C" ILIKE ? ESCAPE '${escaped ? '\\' : ''}'`;
  }

  /**
   * List membership through `json_array_elements` over the stored JSON, compared by `elementKey`.
   * The distinct probe values bind as one JSON array, keyed the same way, so stored spelling never matters.
   * Not `jsonb`: it refuses a stored `\u0000`, which would fail every membership read over the column.
   */
  listMembership(
    quotedColumn: string,
    op: ListMembershipOperator,
    values: readonly unknown[],
  ): DialectFragment {
    const elements = uniqueArray(values.map((value) => JSON.stringify(value)));
    if (elements.length === 0) return { sql: op === 'includesAll' ? '1 = 1' : '1 = 0', params: [] };
    const key = elementKey('"e"."v"');
    const each = `json_array_elements(${quotedColumn}::json) AS "e"("v")`;
    const match = `${key} IN (SELECT ${elementKey('"p"."v"')} FROM json_array_elements(?::json) AS "p"("v"))`;
    const params = [`[${elements.join(',')}]`];
    if (op === 'includesAll') {
      return {
        sql: `(SELECT COUNT(DISTINCT ${key}) FROM ${each} WHERE ${match}) = ${elements.length}`,
        params,
      };
    }
    return { sql: `EXISTS (SELECT 1 FROM ${each} WHERE ${match})`, params };
  }

  /**
   * Postgres takes an `OFFSET` without a `LIMIT`, so each bound renders only when set.
   */
  paginate(limit: number | null, offset: number | null): DialectFragment {
    if (isNull(offset))
      return isNull(limit) ? { sql: '', params: [] } : { sql: 'LIMIT ?', params: [limit] };
    if (isNull(limit)) return { sql: 'OFFSET ?', params: [offset] };
    return { sql: 'LIMIT ? OFFSET ?', params: [limit, offset] };
  }

  /**
   * Names the NULL placement, since Postgres sorts NULLs highest by default.
   * A term that is never `NULL` stays bare, so the primary key's default order serves it.
   */
  sortTerm(expression: string, direction: OrderDirection, nullable: boolean): string {
    const term = `${expression} ${direction === 'desc' ? 'DESC' : 'ASC'}`;
    if (!nullable) return term;
    return direction === 'desc' ? `${term} NULLS LAST` : `${term} NULLS FIRST`;
  }

  /**
   * Lists the tables of the current schema.
   */
  listTables(db: Transaction): Promise<string[]> {
    return listTables(db);
  }

  /**
   * Describes a table of the current schema from the system catalogs.
   */
  describeTable(db: Transaction, table: string): Promise<TableSchema> {
    return describeTable(db, table);
  }

  /**
   * Realizes a per-table diff in place, since Postgres alters every part of a table directly.
   * A foreign key whose target is missing waits until the target appears or the schema change ends.
   */
  async applyTableDiff(db: Transaction, diff: TableDiff): Promise<void> {
    switch (diff.kind) {
      case 'create':
        return createTable(db, this, diff.table);
      case 'drop':
        return dropTable(db, this, diff.table.name);
      case 'alter':
        return alterTable(db, this, diff);
    }
  }

  /**
   * Renames a table in place, its primary key following the new name.
   */
  renameTable(db: Transaction, from: string, to: string): Promise<void> {
    return renameTable(db, this, from, to);
  }

  /**
   * Runs `fn` in an `immediate` transaction with foreign-key checks and cascades off until it ends.
   * Pending foreign keys settle before the commit.
   * A role that may not create tables in the schema fails with the grant that fixes it.
   * With `options.commit` false the success path rolls back too, so a rehearsal writes nothing.
   */
  async schemaTransaction<T>(
    db: DatabaseAdapter,
    fn: (tx: Transaction) => Promise<T>,
    { commit = true }: SchemaTransactionOptions = {},
  ): Promise<T> {
    const rehearsal = { result: undefined as T };
    try {
      return await db.transaction(async (tx) => {
        await replicaRole(tx, this);
        const result = await fn(tx);
        await settlePendingKeys(tx, this);
        if (commit) return result;
        rehearsal.result = result;
        throw rehearsal;
      }, 'immediate');
    } catch (error) {
      if (error === rehearsal) return rehearsal.result;
      throw await createGrantError(db, this, error);
    }
  }

  /**
   * Classifies a duplicate key, on a unique index or the primary key.
   */
  isUniqueViolation(error: unknown): boolean {
    return sqlstateOf(error) === UNIQUE_VIOLATION;
  }

  /**
   * Reads the target back from the failed index's name, never from the localized message.
   * A primary key, a hash-truncated index name, or a row over a page names none, so it gives `null`.
   */
  indexViolationTarget(error: unknown): IndexViolationTarget | null {
    const columns = constraintColumns(error);
    if (isNull(columns) || !isObject(error) || !isString(error.table)) return null;
    return { table: error.table, columns };
  }

  /**
   * Classifies a value too large for a btree entry, about 2.7 kB, or an index row over 8191 bytes.
   */
  isIndexOverflow(error: unknown): boolean {
    return sqlstateOf(error) === PROGRAM_LIMIT_EXCEEDED;
  }

  /**
   * Classifies a foreign-key failure, on insert and on a restricted delete alike.
   */
  isForeignKeyViolation(error: unknown): boolean {
    return sqlstateOf(error) === FOREIGN_KEY_VIOLATION;
  }

  /**
   * Classifies a lock wait past `lock_timeout`, a broken deadlock, and a serialization failure.
   */
  isBusy(error: unknown): boolean {
    return hasSQLSTATE(BUSY, error);
  }

  /**
   * Checks for the table first, so the common case runs no DDL.
   * A role that may not create tables in the schema fails with the grant that fixes it.
   * A create that lost a race fails on Postgres, so a subtransaction swallows it and the caller's carries on.
   */
  async ensureTable(db: Transaction, table: string, columns: string): Promise<void> {
    if (!isUndefined(await tableOID(db, table))) return;
    const denied = await missingCreateGrant(db, this);
    if (!isNull(denied)) throw denied;
    await db.exec(
      `DO $ohne$ BEGIN CREATE TABLE IF NOT EXISTS ${this.quote(table)} (${columns}); ` +
        'EXCEPTION WHEN unique_violation OR duplicate_table OR duplicate_object THEN NULL; END $ohne$',
    );
  }
}

/**
 * Turns off foreign-key checks and cascades for the rest of `tx`, as SQLite syncs with `foreign_keys` off.
 * A role that may not set `session_replication_role` fails with the grant that fixes it.
 */
async function replicaRole(tx: Transaction, dialect: Dialect): Promise<void> {
  const { role } = (await tx.queryOne<{ role: string }>('SELECT current_user AS "role"'))!;
  try {
    await tx.exec('SET LOCAL session_replication_role = replica');
  } catch (error) {
    if (sqlstateOf(error) !== INSUFFICIENT_PRIVILEGE) throw error;
    throw ohneError({
      title: 'The role cannot set `session_replication_role`',
      body: [
        `The schema sync turns off foreign-key checks for its transaction, which ${codeSpan(role)} may not do.`,
        '',
        'Grant it as a superuser:',
        codeSpan(`GRANT SET ON PARAMETER session_replication_role TO ${dialect.quote(role)}`),
      ],
    });
  }
}

/**
 * Names the grant when `error` is a refused statement and the role lacks `CREATE` on the current schema.
 * Any other error comes back unchanged.
 */
async function createGrantError(
  db: Pick<Transaction, 'queryOne'>,
  dialect: Dialect,
  error: unknown,
): Promise<unknown> {
  if (sqlstateOf(error) !== INSUFFICIENT_PRIVILEGE) return error;
  return (await missingCreateGrant(db, dialect)) ?? error;
}

/**
 * The error naming the grant when the role lacks `CREATE` on the current schema, otherwise `null`.
 */
async function missingCreateGrant(
  db: Pick<Transaction, 'queryOne'>,
  dialect: Dialect,
): Promise<Error | null> {
  const { role, schema, creates } = (await db.queryOne<{
    role: string;
    schema: string;
    creates: boolean;
  }>(
    'SELECT current_user AS "role", current_schema() AS "schema", ' +
      `has_schema_privilege(current_schema(), 'CREATE') AS "creates"`,
  ))!;
  if (creates) return null;
  return ohneError({
    title: `The role cannot create tables in ${codeSpan(schema)}`,
    body: [
      `ohne keeps its tables in ${codeSpan(schema)}, where ${codeSpan(role)} may not create any.`,
      '',
      'Grant it as the owner of the schema or a superuser:',
      codeSpan(`GRANT USAGE, CREATE ON SCHEMA ${dialect.quote(schema)} TO ${dialect.quote(role)}`),
    ],
  });
}

/**
 * The canonical JSON text of a `json` element, so two spellings of one value compare equal.
 * A number keys by its value and a string by its decoded text, `true` and `1` staying apart.
 * A string holding `\u0000` or a lone surrogate keys by its spelling, since Postgres cannot decode it.
 * Escaped backslashes are dropped before that check, so only a real `\u` escape counts.
 */
function elementKey(element: string): string {
  const text = `${element}::text`;
  const escapes = `replace(${text}, '\\\\', '')`;
  return (
    `CASE json_typeof(${element}) ` +
    `WHEN 'number' THEN trim_scale(${text}::numeric)::text ` +
    `WHEN 'string' THEN CASE WHEN strpos(${text}, '\\u') = 0 ` +
    `OR (strpos(${escapes}, '\\u0000') = 0 AND ${escapes} !~* '${LONE_SURROGATE}') ` +
    `THEN to_json(${element} #>> '{}')::text ELSE ${text} END ` +
    `ELSE ${text} END`
  );
}

/**
 * Whether `error` carries one of the SQLSTATEs in `codes`.
 */
function hasSQLSTATE(codes: ReadonlySet<string>, error: unknown): boolean {
  const code = sqlstateOf(error);
  return !isUndefined(code) && codes.has(code);
}
