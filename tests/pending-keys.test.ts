import type { DatabaseAdapter, ForeignKeySchema } from 'ohnejs';

import { deepStrictEqual, rejects } from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { PostgresDialect } from '../src/dialect.ts';
import { describeTable } from '../src/introspect.ts';
import {
  addForeignKey,
  captureInboundKeys,
  flushPendingKeys,
  forgetPendingKeys,
  pendingKeys,
  recordPendingKey,
  renamePendingKeys,
  settlePendingKeys,
} from '../src/pending-keys.ts';
import { connectFresh } from './_postgres.ts';

const dialect = new PostgresDialect();

/**
 * A key from `column` onto `targetTable`'s `UUID`, cascading deletes.
 */
function key(column: string, targetTable: string): ForeignKeySchema {
  return { column, targetTable, targetColumn: 'UUID', onDelete: 'cascade' };
}

describe('pending keys', () => {
  let db: DatabaseAdapter;

  before(async () => {
    db = await connectFresh(dialect);
  });

  after(async () => {
    await db.close();
  });

  test('keys are held per `db` and per table, one per column', () => {
    const own = { ...db };
    recordPendingKey(own, 'T', key('a', 'X'));
    recordPendingKey(own, 'T', key('a', 'Y'));
    recordPendingKey(own, 'T', key('b', 'X'));
    deepStrictEqual(pendingKeys(own, 'T'), [key('a', 'Y'), key('b', 'X')]);
    deepStrictEqual(pendingKeys(own, 'U'), []);
    deepStrictEqual(pendingKeys({ ...own }, 'T'), []);
  });

  test('forgetting drops one column or the whole table', () => {
    const own = { ...db };
    recordPendingKey(own, 'T', key('a', 'X'));
    recordPendingKey(own, 'T', key('b', 'X'));
    forgetPendingKeys(own, 'T', 'a');
    deepStrictEqual(pendingKeys(own, 'T'), [key('b', 'X')]);
    forgetPendingKeys(own, 'T');
    deepStrictEqual(pendingKeys(own, 'T'), []);
    forgetPendingKeys({ ...own }, 'T');
  });

  test('a rename moves the keys to the new table name', () => {
    const own = { ...db };
    recordPendingKey(own, 'T', key('a', 'X'));
    renamePendingKeys(own, 'T', 'U');
    deepStrictEqual(pendingKeys(own, 'T'), []);
    deepStrictEqual(pendingKeys(own, 'U'), [key('a', 'X')]);
    renamePendingKeys({ ...own }, 'T', 'U');
  });

  test('`addForeignKey` adds a key onto a live or the same table and defers one onto a missing table', async () => {
    await db.exec(
      'CREATE TABLE "X" ("UUID" TEXT PRIMARY KEY); CREATE TABLE "T" ("UUID" TEXT PRIMARY KEY, "a" TEXT, "b" TEXT, "c" TEXT)',
    );
    await addForeignKey(db, dialect, 'T', key('a', 'X'));
    await addForeignKey(db, dialect, 'T', key('b', 'T'));
    await addForeignKey(db, dialect, 'T', key('c', 'Missing'));
    deepStrictEqual(pendingKeys(db, 'T'), [key('c', 'Missing')]);
    deepStrictEqual(await foreignKeyNames('T'), ['FK__T__a', 'FK__T__b']);
    deepStrictEqual((await describeTable(db, 'T')).foreignKeys, [
      key('b', 'T'),
      key('a', 'X'),
      key('c', 'Missing'),
    ]);
    forgetPendingKeys(db, 'T');
    await db.exec('DROP TABLE "T", "X"');
  });

  test('an added key leaves old rows unchecked and guards new ones', async () => {
    await db.exec(
      'CREATE TABLE "X" ("UUID" TEXT PRIMARY KEY); CREATE TABLE "T" ("a" TEXT); INSERT INTO "T" VALUES (\'orphan\')',
    );
    await addForeignKey(db, dialect, 'T', key('a', 'X'));
    await rejects(db.exec('INSERT INTO "T" VALUES (\'another\')'), { code: '23503' });
    await db.exec('DROP TABLE "T", "X"');
  });

  test('flushing adds only the keys onto the target', async () => {
    await db.exec(
      'CREATE TABLE "T" ("a" TEXT, "b" TEXT); CREATE TABLE "X" ("UUID" TEXT PRIMARY KEY)',
    );
    recordPendingKey(db, 'T', key('a', 'X'));
    recordPendingKey(db, 'T', key('b', 'Y'));
    await flushPendingKeys(db, dialect, 'X');
    deepStrictEqual(pendingKeys(db, 'T'), [key('b', 'Y')]);
    deepStrictEqual(await foreignKeyNames('T'), ['FK__T__a']);
    deepStrictEqual((await describeTable(db, 'T')).foreignKeys, [key('a', 'X'), key('b', 'Y')]);
    forgetPendingKeys(db, 'T');
    await db.exec('DROP TABLE "T", "X"');
  });

  test('capturing holds every inbound key but a self-reference', async () => {
    await db.exec(
      'CREATE TABLE "X" ("UUID" TEXT PRIMARY KEY, "parent" TEXT REFERENCES "X"); ' +
        'CREATE TABLE "T" ("a" TEXT REFERENCES "X" ON DELETE CASCADE); ' +
        'CREATE TABLE "U" ("b" TEXT REFERENCES "X" ON DELETE CASCADE)',
    );
    await captureInboundKeys(db, 'X');
    deepStrictEqual(pendingKeys(db, 'T'), [key('a', 'X')]);
    deepStrictEqual(pendingKeys(db, 'U'), [key('b', 'X')]);
    deepStrictEqual(pendingKeys(db, 'X'), []);
    await captureInboundKeys(db, 'Missing');
    forgetPendingKeys(db, 'T');
    forgetPendingKeys(db, 'U');
    await db.exec('DROP TABLE "T", "U", "X"');
  });

  test('settling adds keys whose target exists and forgets one whose target never came back', async () => {
    await db.exec(
      'CREATE TABLE "X" ("UUID" TEXT PRIMARY KEY); CREATE TABLE "T" ("a" TEXT, "b" TEXT)',
    );
    recordPendingKey(db, 'T', key('a', 'X'));
    recordPendingKey(db, 'T', key('b', 'Gone'));
    await settlePendingKeys(db, dialect);
    deepStrictEqual(pendingKeys(db, 'T'), []);
    deepStrictEqual(await foreignKeyNames('T'), ['FK__T__a']);
    deepStrictEqual((await describeTable(db, 'T')).foreignKeys, [key('a', 'X')]);
    await db.exec('DROP TABLE "T", "X"');
  });

  /**
   * Lists the foreign-key constraint names of `table`, sorted.
   */
  async function foreignKeyNames(table: string): Promise<string[]> {
    const rows = await db.query<{ name: string }>(
      `SELECT conname AS "name" FROM pg_constraint ` +
        `WHERE conrelid = ?::regclass AND contype = 'f' ORDER BY 1`,
      [dialect.quote(table)],
    );
    return rows.map((row) => row.name);
  }
});
