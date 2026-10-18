import type { ForeignKeySchema, OnDelete, SQLValue, Transaction } from 'ohnejs';

/**
 * A foreign key as the catalog holds it, with the table that owns it.
 */
export interface ForeignKeyRow extends ForeignKeySchema {
  /**
   * The table that owns the key.
   */
  table: string;
}

const ON_DELETE: Partial<Record<string, OnDelete>> = {
  a: 'noAction',
  r: 'restrict',
  c: 'cascade',
  n: 'setNull',
  d: 'setDefault',
};

/**
 * Finds the OID of `table` in the current schema, or `undefined` when no such table exists.
 * The match is exact and case-sensitive, so a same-named table in another schema never counts.
 */
export async function tableOID(db: Transaction, table: string): Promise<number | undefined> {
  const row = await db.queryOne<{ oid: number }>(
    `SELECT c."oid" FROM pg_class c JOIN pg_namespace n ON n."oid" = c.relnamespace ` +
      `WHERE n.nspname = current_schema() AND c.relname = ? AND c.relkind IN ('r', 'p')`,
    [table],
  );
  return row?.oid;
}

/**
 * Lists the foreign keys of the table with OID `oid`, newest first.
 * `side` picks the keys the table owns (`conrelid`) or the keys pointing at it (`confrelid`).
 * A missing table, `oid` `null`, has none.
 */
export async function foreignKeyRows(
  db: Transaction,
  side: 'conrelid' | 'confrelid',
  oid: SQLValue,
): Promise<ForeignKeyRow[]> {
  const rows = await db.query<Omit<ForeignKeyRow, 'onDelete'> & { onDelete: string }>(
    `SELECT o.relname AS "table", a.attname AS "column", t.relname AS "targetTable", ` +
      `ta.attname AS "targetColumn", k.confdeltype AS "onDelete" FROM pg_constraint k ` +
      `JOIN pg_class o ON o."oid" = k.conrelid JOIN pg_class t ON t."oid" = k.confrelid ` +
      `JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1] ` +
      `JOIN pg_attribute ta ON ta.attrelid = k.confrelid AND ta.attnum = k.confkey[1] ` +
      `WHERE k.${side} = ?::oid AND k.contype = 'f' ORDER BY k."oid" DESC`,
    [oid],
  );
  return rows.map((row) => ({ ...row, onDelete: ON_DELETE[row.onDelete] ?? 'noAction' }));
}

/**
 * Lists the foreign-key constraints of the table with OID `oid` with the column each one covers.
 * A missing table, `oid` `null`, has none.
 */
export async function foreignKeyConstraints(
  db: Transaction,
  oid: SQLValue,
): Promise<{ name: string; column: string }[]> {
  return db.query<{ name: string; column: string }>(
    `SELECT k.conname AS "name", a.attname AS "column" FROM pg_constraint k ` +
      `JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1] ` +
      `WHERE k.conrelid = ?::oid AND k.contype = 'f'`,
    [oid],
  );
}
