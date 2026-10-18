import type { DatabaseAdapter } from 'ohnejs';

import { deepStrictEqual } from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { createTable } from '../src/alter.ts';
import { PostgresDialect } from '../src/dialect.ts';
import { describeTable, listTables } from '../src/introspect.ts';
import { forgetPendingKeys, recordPendingKey } from '../src/pending-keys.ts';
import { connectFresh } from './_postgres.ts';
import { table } from './_schema.ts';

const dialect = new PostgresDialect();

describe('introspection', () => {
  let db: DatabaseAdapter;
  let other: DatabaseAdapter;

  before(async () => {
    db = await connectFresh(dialect);
    other = await connectFresh(dialect);
  });

  after(async () => {
    await db.close();
    await other.close();
  });

  test('`listTables` lists the current schema byte-wise, never another schema', async () => {
    await db.exec(
      'CREATE TABLE "b" ("x" TEXT); CREATE TABLE "B" ("x" TEXT); CREATE TABLE "a_b" ("x" TEXT)',
    );
    await other.exec('CREATE TABLE "Elsewhere" ("x" TEXT)');
    deepStrictEqual(await listTables(db), ['B', 'a_b', 'b']);
    await db.exec('DROP TABLE "b", "B", "a_b"');
  });

  test('a created table describes exactly as desired', async () => {
    const users = table('Users', {
      columns: [{ name: 'UUID', type: 'text', notNull: true }],
      primaryKey: ['UUID'],
    });
    const posts = table('Posts', {
      columns: [
        { name: 'UUID', type: 'text', notNull: true },
        { name: 'title', type: 'text', notNull: false },
        { name: 'views', type: 'integer', notNull: true },
        { name: 'score', type: 'real', notNull: false },
        { name: 'author', type: 'text', notNull: false },
      ],
      primaryKey: ['UUID'],
      uniques: [{ name: 'UX__Posts__title', columns: ['title'] }],
      indexes: [{ name: 'IX__Posts__views_score', columns: ['views', 'score'] }],
      foreignKeys: [
        { column: 'author', targetTable: 'Users', targetColumn: 'UUID', onDelete: 'setNull' },
      ],
    });
    await createTable(db, dialect, users);
    await createTable(db, dialect, posts);
    const live = await describeTable(db, 'Posts');
    deepStrictEqual(live, posts);
    deepStrictEqual(Object.keys(live), Object.keys(posts));
    deepStrictEqual(await describeTable(db, 'Users'), users);
    await db.exec('DROP TABLE "Posts", "Users"');
  });

  test('a composite primary key keeps its key order, not its column order', async () => {
    await db.exec('CREATE TABLE "T" ("a" TEXT, "b" TEXT, PRIMARY KEY ("b", "a"))');
    deepStrictEqual((await describeTable(db, 'T')).primaryKey, ['b', 'a']);
    await db.exec('DROP TABLE "T"');
  });

  test('native types map to the storage primitive they hold', async () => {
    await db.exec(
      'CREATE TABLE "T" ("a" SMALLINT, "b" INTEGER, "c" BIGINT, "d" REAL, "e" DOUBLE PRECISION, ' +
        '"f" NUMERIC(10, 2), "g" VARCHAR(20), "h" BOOLEAN, "i" JSONB, "j" TEXT)',
    );
    const types = (await describeTable(db, 'T')).columns.map((column) => column.type);
    deepStrictEqual(types, [
      'integer',
      'integer',
      'integer',
      'real',
      'real',
      'real',
      'text',
      'text',
      'text',
      'text',
    ]);
    await db.exec('DROP TABLE "T"');
  });

  test('indexes list newest first, without the key index or expression indexes', async () => {
    await db.exec(
      'CREATE TABLE "T" ("UUID" TEXT PRIMARY KEY, "a" TEXT, "b" TEXT); ' +
        'CREATE INDEX "IX__T__a" ON "T" ("a"); CREATE UNIQUE INDEX "UX__T__a" ON "T" ("a"); ' +
        'CREATE INDEX "IX__T__b" ON "T" ("b"); CREATE UNIQUE INDEX "UX__T__b" ON "T" ("b"); ' +
        'CREATE INDEX "IX__T__lower" ON "T" (lower("a"))',
    );
    const live = await describeTable(db, 'T');
    deepStrictEqual(live.uniques, [
      { name: 'UX__T__b', columns: ['b'] },
      { name: 'UX__T__a', columns: ['a'] },
    ]);
    deepStrictEqual(live.indexes, [
      { name: 'IX__T__b', columns: ['b'] },
      { name: 'IX__T__a', columns: ['a'] },
    ]);
    await db.exec('DROP TABLE "T"');
  });

  test('every delete action reads back', async () => {
    await db.exec(
      'CREATE TABLE "U" ("UUID" TEXT PRIMARY KEY); CREATE TABLE "T" (' +
        '"a" TEXT REFERENCES "U" ON DELETE NO ACTION, "b" TEXT REFERENCES "U" ON DELETE RESTRICT, ' +
        '"c" TEXT REFERENCES "U" ON DELETE CASCADE, "d" TEXT REFERENCES "U" ON DELETE SET NULL, ' +
        '"e" TEXT REFERENCES "U" ON DELETE SET DEFAULT)',
    );
    const actions = (await describeTable(db, 'T')).foreignKeys.map((key) => [
      key.column,
      key.targetColumn,
      key.onDelete,
    ]);
    deepStrictEqual(actions, [
      ['e', 'UUID', 'setDefault'],
      ['d', 'UUID', 'setNull'],
      ['c', 'UUID', 'cascade'],
      ['b', 'UUID', 'restrict'],
      ['a', 'UUID', 'noAction'],
    ]);
    await db.exec('DROP TABLE "T", "U"');
  });

  test('pending keys follow the live ones, for this `db` only', async () => {
    await db.exec('CREATE TABLE "T" ("a" TEXT)');
    const key = {
      column: 'a',
      targetTable: 'Gone',
      targetColumn: 'UUID',
      onDelete: 'cascade',
    } as const;
    recordPendingKey(db, 'T', key);
    deepStrictEqual((await describeTable(db, 'T')).foreignKeys, [key]);
    deepStrictEqual((await describeTable({ ...db }, 'T')).foreignKeys, []);
    forgetPendingKeys(db, 'T');
    await db.exec('DROP TABLE "T"');
  });

  test('a missing table describes as empty', async () => {
    deepStrictEqual(await describeTable(db, 'Missing'), table('Missing'));
  });
});
