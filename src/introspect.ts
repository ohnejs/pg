import type { ColumnSchema, IndexSchema, LogicalType, TableSchema, Transaction } from 'ohnejs';

import { foreignKeyRows, tableOID } from './catalog.ts';
import { pendingKeys } from './pending-keys.ts';

interface ColumnRow {
  name: string;
  type: string;
  notNull: boolean;
}

interface IndexRow extends IndexSchema {
  unique: boolean;
}

/**
 * Lists every table of the current schema, sorted byte-wise by name.
 */
export async function listTables(db: Transaction): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    `SELECT c.relname AS "name" FROM pg_class c JOIN pg_namespace n ON n."oid" = c.relnamespace ` +
      `WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') ORDER BY c.relname COLLATE "C"`,
  );
  return rows.map((row) => row.name);
}

/**
 * Describes a table of the current schema from the system catalogs, normalized to a `TableSchema`.
 * Integer types read as `integer`, floating and numeric types as `real`, everything else as `text`.
 * Indexes list newest first, as SQLite does; the primary key's index and expression indexes stay out.
 * The foreign keys end with those pending on `db`, so a schema change sees a key whose target is gone.
 * A missing table describes as empty.
 */
export async function describeTable(db: Transaction, table: string): Promise<TableSchema> {
  const oid = (await tableOID(db, table)) ?? null;
  const columnRows = await db.query<ColumnRow>(
    `SELECT attname AS "name", format_type(atttypid, atttypmod) AS "type", attnotnull AS "notNull" ` +
      `FROM pg_attribute WHERE attrelid = ?::oid AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
    [oid],
  );
  const key = await db.queryOne<{ columns: string[] | null }>(
    `SELECT array_agg(a.attname::text ORDER BY k.ord) AS "columns" FROM pg_constraint c ` +
      `CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ` +
      `JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ` +
      `WHERE c.conrelid = ?::oid AND c.contype = 'p'`,
    [oid],
  );
  const indexRows = await db.query<IndexRow>(
    `SELECT i.relname AS "name", x.indisunique AS "unique", ` +
      `array_agg(a.attname::text ORDER BY k.ord) AS "columns" FROM pg_index x ` +
      `JOIN pg_class i ON i."oid" = x.indexrelid ` +
      `CROSS JOIN LATERAL unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) ` +
      `JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum ` +
      `WHERE x.indrelid = ?::oid AND NOT x.indisprimary AND x.indexprs IS NULL ` +
      `GROUP BY x.indexrelid, i.relname, x.indisunique ORDER BY x.indexrelid DESC`,
    [oid],
  );
  const columns: ColumnSchema[] = columnRows.map((row) => ({
    name: row.name,
    type: logicalType(row.type),
    notNull: row.notNull,
  }));
  /**
   * Drops the `unique` flag from an index row.
   */
  const index = ({ name, columns }: IndexRow): IndexSchema => ({ name, columns });
  const foreignKeys = (await foreignKeyRows(db, 'conrelid', oid)).map(
    ({ column, targetTable, targetColumn, onDelete }) => ({
      column,
      targetTable,
      targetColumn,
      onDelete,
    }),
  );
  return {
    name: table,
    columns,
    primaryKey: key?.columns ?? [],
    uniques: indexRows.filter((row) => row.unique).map(index),
    indexes: indexRows.filter((row) => !row.unique).map(index),
    foreignKeys: [...foreignKeys, ...pendingKeys(db, table)],
  };
}

/**
 * Maps a `format_type` name to the storage primitive it holds.
 */
function logicalType(type: string): LogicalType {
  if (/^(bigint|integer|smallint)$/.test(type)) return 'integer';
  if (/^(double precision|real|numeric)/.test(type)) return 'real';
  return 'text';
}
