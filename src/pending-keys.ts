import type { Dialect, ForeignKeySchema, OnDelete, Transaction } from 'ohnejs';

import { foreignKeyName } from 'ohnejs';
import { isUndefined } from 'ohnejs/utils';

import { foreignKeyRows, tableOID } from './catalog.ts';

const ON_DELETE_SQL: Record<OnDelete, string> = {
  cascade: 'CASCADE',
  noAction: 'NO ACTION',
  restrict: 'RESTRICT',
  setDefault: 'SET DEFAULT',
  setNull: 'SET NULL',
};

const pending = new WeakMap<Transaction, Map<string, Map<string, ForeignKeySchema>>>();

/**
 * Renders `key` of `table` as a table constraint named `FK__<table>__<column>`.
 * An unnamed key takes `<table>_<column>_fkey`, which a rename leaves behind on the old table name.
 */
export function foreignKeyClause(
  dialect: Pick<Dialect, 'quote'>,
  table: string,
  key: ForeignKeySchema,
): string {
  return (
    `CONSTRAINT ${dialect.quote(foreignKeyName(table, key.column))} ` +
    `FOREIGN KEY (${dialect.quote(key.column)}) ` +
    `REFERENCES ${dialect.quote(key.targetTable)} (${dialect.quote(key.targetColumn)}) ` +
    `ON DELETE ${ON_DELETE_SQL[key.onDelete]}`
  );
}

/**
 * Adds `key` to `table` when its target exists, or holds it pending on `db` until the target appears.
 * Postgres refuses a reference to a missing table, where SQLite keeps it dangling.
 */
export async function addForeignKey(
  db: Transaction,
  dialect: Pick<Dialect, 'quote'>,
  table: string,
  key: ForeignKeySchema,
): Promise<void> {
  if (await canReference(db, table, key)) {
    await constrain(db, dialect, table, key);
  } else {
    recordPendingKey(db, table, key);
  }
}

/**
 * Whether `key` of `table` can become a constraint now: it points at `table` itself or at a live table.
 */
export async function canReference(
  db: Transaction,
  table: string,
  key: ForeignKeySchema,
): Promise<boolean> {
  return key.targetTable === table || !isUndefined(await tableOID(db, key.targetTable));
}

/**
 * Lists the keys of `table` held pending on `db`.
 */
export function pendingKeys(db: Transaction, table: string): ForeignKeySchema[] {
  return [...(pending.get(db)?.get(table)?.values() ?? [])];
}

/**
 * Holds `key` of `table` pending on `db`, replacing any pending key on the same column.
 */
export function recordPendingKey(db: Transaction, table: string, key: ForeignKeySchema): void {
  pending
    .getOrInsertComputed(db, () => new Map())
    .getOrInsertComputed(table, () => new Map())
    .set(key.column, key);
}

/**
 * Forgets the pending keys of `table` on `db`, or only the one on `column` when given.
 */
export function forgetPendingKeys(db: Transaction, table: string, column?: string): void {
  const tables = pending.get(db);
  if (isUndefined(column)) tables?.delete(table);
  else tables?.get(table)?.delete(column);
}

/**
 * Moves the pending keys of `from` to `to` after a table rename.
 */
export function renamePendingKeys(db: Transaction, from: string, to: string): void {
  const tables = pending.get(db);
  const keys = tables?.get(from);
  if (isUndefined(tables) || isUndefined(keys)) return;
  tables.delete(from);
  tables.set(to, keys);
}

/**
 * Adds every pending key targeting `target` as a `NOT VALID` constraint and forgets it.
 * Runs once `target` exists, after a create or a rename.
 */
export async function flushPendingKeys(
  db: Transaction,
  dialect: Pick<Dialect, 'quote'>,
  target: string,
): Promise<void> {
  for (const [table, keys] of pending.get(db) ?? []) {
    for (const key of keys.values()) {
      if (key.targetTable !== target) continue;
      await constrain(db, dialect, table, key);
      keys.delete(key.column);
    }
  }
}

/**
 * Holds every key that other tables point at `target` pending on `db`, ahead of `DROP TABLE ... CASCADE`.
 * The cascade removes those constraints; a later create of `target` restores them.
 */
export async function captureInboundKeys(db: Transaction, target: string): Promise<void> {
  const oid = await tableOID(db, target);
  if (isUndefined(oid)) return;
  for (const { table, ...key } of await foreignKeyRows(db, 'confrelid', oid)) {
    if (table !== target) recordPendingKey(db, table, key);
  }
}

/**
 * Closes the pending set of `db` as the last step of a schema change.
 * A key whose target exists becomes a constraint; a key whose target never came back is forgotten.
 */
export async function settlePendingKeys(
  db: Transaction,
  dialect: Pick<Dialect, 'quote'>,
): Promise<void> {
  for (const [table, keys] of pending.get(db) ?? []) {
    for (const key of keys.values()) {
      if (await canReference(db, table, key)) await constrain(db, dialect, table, key);
    }
  }
  pending.delete(db);
}

/**
 * Adds `key` to `table` without validating existing rows, as SQLite never checks old rows either.
 */
async function constrain(
  db: Transaction,
  dialect: Pick<Dialect, 'quote'>,
  table: string,
  key: ForeignKeySchema,
): Promise<void> {
  await db.exec(
    `ALTER TABLE ${dialect.quote(table)} ADD ${foreignKeyClause(dialect, table, key)} NOT VALID`,
  );
}
