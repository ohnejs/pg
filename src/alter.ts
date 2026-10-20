import type {
  ColumnSchema,
  Dialect,
  IndexSchema,
  SQLValue,
  TableAlter,
  TableSchema,
  Transaction,
} from 'ohnejs';

import { foreignKeyName, ohneError, primaryKeyName } from 'ohnejs';
import { isUndefined } from 'ohnejs/utils';

import { foreignKeyConstraints, tableOID } from './catalog.ts';
import { PROGRAM_LIMIT_EXCEEDED, sqlstateOf } from './errors.ts';
import {
  addForeignKey,
  canReference,
  captureInboundKeys,
  flushPendingKeys,
  foreignKeyClause,
  forgetPendingKeys,
  recordPendingKey,
  renamePendingKeys,
} from './pending-keys.ts';

/**
 * Creates `schema`'s table with its named primary key, foreign keys, uniques and indexes.
 * A foreign key whose target is missing waits pending; keys pending on this table are added last.
 */
export async function createTable(
  db: Transaction,
  dialect: Pick<Dialect, 'quote' | 'columnType'>,
  schema: TableSchema,
): Promise<void> {
  const parts = schema.columns.map((column) => columnDefinition(dialect, column));
  if (schema.primaryKey.length > 0) {
    parts.push(
      `CONSTRAINT ${dialect.quote(primaryKeyName(schema.name))} PRIMARY KEY (${quoteAll(dialect, schema.primaryKey)})`,
    );
  }
  for (const key of schema.foreignKeys) {
    if (await canReference(db, schema.name, key)) {
      parts.push(foreignKeyClause(dialect, schema.name, key));
    } else {
      recordPendingKey(db, schema.name, key);
    }
  }
  await db.exec(`CREATE TABLE ${dialect.quote(schema.name)} (${parts.join(', ')})`);
  await createIndexes(db, dialect, schema.name, schema.uniques, schema.indexes);
  await flushPendingKeys(db, dialect, schema.name);
}

/**
 * Drops `table` with every constraint that references it.
 * Keys from other tables onto it wait pending, so recreating `table` restores them.
 */
export async function dropTable(
  db: Transaction,
  dialect: Pick<Dialect, 'quote'>,
  table: string,
): Promise<void> {
  await captureInboundKeys(db, table);
  forgetPendingKeys(db, table);
  await db.exec(`DROP TABLE ${dialect.quote(table)} CASCADE`);
}

/**
 * Alters a live table in place into its desired shape, drops before adds.
 * A retyped column comes back empty, as the retype contract demands.
 */
export async function alterTable(
  db: Transaction,
  dialect: Pick<Dialect, 'quote' | 'columnType'>,
  diff: TableAlter,
): Promise<void> {
  const name = diff.desired.name;
  const table = dialect.quote(name);
  const oid = (await tableOID(db, name)) ?? null;
  for (const index of [...diff.dropUniques, ...diff.dropIndexes]) {
    await db.exec(`DROP INDEX ${dialect.quote(index.name)}`);
  }
  const foreignKeys = await foreignKeyConstraints(db, oid);
  for (const key of diff.dropForeignKeys) {
    for (const constraint of foreignKeys.filter(({ column }) => column === key.column)) {
      await db.exec(`ALTER TABLE ${table} DROP CONSTRAINT ${dialect.quote(constraint.name)}`);
    }
    forgetPendingKeys(db, name, key.column);
  }
  if (diff.changePrimaryKey && diff.live.primaryKey.length > 0) {
    const key = await primaryKeyConstraint(db, oid);
    if (!isUndefined(key)) {
      await db.exec(`ALTER TABLE ${table} DROP CONSTRAINT ${dialect.quote(key)}`);
    }
  }
  for (const column of diff.dropColumns) {
    await db.exec(`ALTER TABLE ${table} DROP COLUMN ${dialect.quote(column.name)}`);
    forgetPendingKeys(db, name, column.name);
  }
  for (const { live, desired } of diff.changeColumns) {
    const column = `ALTER COLUMN ${dialect.quote(desired.name)}`;
    const type = dialect.columnType(desired.type);
    const actions: string[] = [];
    if (dialect.columnType(live.type) !== type) actions.push(`${column} TYPE ${type} USING NULL`);
    if (live.notNull !== desired.notNull) {
      actions.push(`${column} ${desired.notNull ? 'SET' : 'DROP'} NOT NULL`);
    }
    if (actions.length > 0) await db.exec(`ALTER TABLE ${table} ${actions.join(', ')}`);
  }
  for (const column of diff.addColumns) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition(dialect, column)}`);
  }
  if (diff.changePrimaryKey && diff.desired.primaryKey.length > 0) {
    await db.exec(
      `ALTER TABLE ${table} ADD CONSTRAINT ${dialect.quote(primaryKeyName(name))} ` +
        `PRIMARY KEY (${quoteAll(dialect, diff.desired.primaryKey)})`,
    );
  }
  for (const key of diff.addForeignKeys) await addForeignKey(db, dialect, name, key);
  await createIndexes(db, dialect, name, diff.addUniques, diff.addIndexes);
}

/**
 * Renames a table in place, its keys following as `PK__<to>` and `FK__<to>__<column>`.
 * The old names are free to reuse.
 * Index names stay as they are; the sync's diff recreates them under the new name.
 * Keys pending on `from` move to `to`, and keys waiting for a `to` are added.
 */
export async function renameTable(
  db: Transaction,
  dialect: Pick<Dialect, 'quote'>,
  from: string,
  to: string,
): Promise<void> {
  await db.exec(`ALTER TABLE ${dialect.quote(from)} RENAME TO ${dialect.quote(to)}`);
  const oid = (await tableOID(db, to)) ?? null;
  const names = (await foreignKeyConstraints(db, oid)).map(({ name, column }) => [
    name,
    foreignKeyName(to, column),
  ]);
  const key = await primaryKeyConstraint(db, oid);
  if (!isUndefined(key)) names.push([key, primaryKeyName(to)]);
  for (const [live, desired] of names) {
    if (live === desired) continue;
    await db.exec(
      `ALTER TABLE ${dialect.quote(to)} RENAME CONSTRAINT ${dialect.quote(live)} TO ${dialect.quote(desired)}`,
    );
  }
  renamePendingKeys(db, from, to);
  await flushPendingKeys(db, dialect, to);
}

/**
 * Reads the primary-key constraint name of the table with OID `oid`, or `undefined` when it has none.
 */
async function primaryKeyConstraint(db: Transaction, oid: SQLValue): Promise<string | undefined> {
  const row = await db.queryOne<{ name: string }>(
    `SELECT conname AS "name" FROM pg_constraint WHERE conrelid = ?::oid AND contype = 'p'`,
    [oid],
  );
  return row?.name;
}

/**
 * Creates each of `uniques` as a unique index and each of `indexes` as a plain one on `table`.
 * Every index column sorts NULLs first, matching the dialect's ascending sort order.
 */
async function createIndexes(
  db: Transaction,
  dialect: Pick<Dialect, 'quote'>,
  table: string,
  uniques: readonly IndexSchema[],
  indexes: readonly IndexSchema[],
): Promise<void> {
  /**
   * Creates `index` as a `kind` index on `table`.
   */
  const create = async (kind: string, index: IndexSchema) => {
    const columns = index.columns.map((column) => `${dialect.quote(column)} NULLS FIRST`);
    try {
      await db.exec(
        `CREATE ${kind} ${dialect.quote(index.name)} ON ${dialect.quote(table)} (${columns.join(', ')})`,
      );
    } catch (error) {
      if (sqlstateOf(error) !== PROGRAM_LIMIT_EXCEEDED) throw error;
      throw ohneError({
        title: `Index \`${index.name}\` cannot hold a stored value`,
        body: [
          `A row of \`${table}\` holds a value in \`${index.columns.join('`, `')}\` too large for a Postgres index entry.`,
          'Shorten the stored values, or drop `index` or `unique` from the field.',
        ],
      });
    }
  };
  for (const unique of uniques) await create('UNIQUE INDEX', unique);
  for (const index of indexes) await create('INDEX', index);
}

/**
 * Renders `column` as it appears in a column list: name, native type, and `NOT NULL` when it rejects `NULL`.
 */
function columnDefinition(
  dialect: Pick<Dialect, 'quote' | 'columnType'>,
  column: ColumnSchema,
): string {
  const type = `${dialect.quote(column.name)} ${dialect.columnType(column.type)}`;
  return column.notNull ? `${type} NOT NULL` : type;
}

/**
 * Quotes each of `names` and joins them into a column list.
 */
function quoteAll(dialect: Pick<Dialect, 'quote'>, names: readonly string[]): string {
  return names.map((name) => dialect.quote(name)).join(', ');
}
