import type { TableSchema } from 'ohnejs';

/**
 * Builds a table schema from its name and parts, every list empty unless given.
 */
export function table(name: string, parts: Partial<Omit<TableSchema, 'name'>> = {}): TableSchema {
  return {
    name,
    columns: [],
    primaryKey: [],
    uniques: [],
    indexes: [],
    foreignKeys: [],
    ...parts,
  };
}
