import type {
  ColumnSchema,
  DatabaseAdapter,
  ForeignKeySchema,
  TableAlter,
  TableSchema,
} from 'ohnejs';

import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { isOhneError } from 'ohnejs';
import { truncateWithHash } from 'ohnejs/utils/crypto';

import { alterTable, createTable, dropTable, renameTable } from '../src/alter.ts';
import { PostgresDialect } from '../src/dialect.ts';
import { describeTable, listTables } from '../src/introspect.ts';
import { pendingKeys } from '../src/pending-keys.ts';
import { connectFresh } from './_postgres.ts';
import { table } from './_schema.ts';

const dialect = new PostgresDialect();

const UUID: ColumnSchema = { name: 'UUID', type: 'text', notNull: true };

/**
 * A key from `column` onto `targetTable`'s `UUID`, cascading deletes.
 */
function key(column: string, targetTable: string): ForeignKeySchema {
  return { column, targetTable, targetColumn: 'UUID', onDelete: 'cascade' };
}

/**
 * A nullable text column.
 */
function text(name: string): ColumnSchema {
  return { name, type: 'text', notNull: false };
}

/**
 * A null-prototype row of `values`, as the adapter returns rows.
 */
function row(values: Record<string, unknown>): Record<string, unknown> {
  return Object.assign(Object.create(null), values);
}

/**
 * A root table keyed by `UUID`, with `columns` after it.
 */
function root(name: string, parts: Partial<Omit<TableSchema, 'name'>> = {}): TableSchema {
  return table(name, { primaryKey: ['UUID'], ...parts, columns: [UUID, ...(parts.columns ?? [])] });
}

/**
 * An alter of `live` into `desired` with nothing listed but `parts`.
 */
function alter(
  live: TableSchema,
  desired: TableSchema,
  parts: Partial<TableAlter> = {},
): TableAlter {
  return {
    kind: 'alter',
    live,
    desired,
    addColumns: [],
    dropColumns: [],
    changeColumns: [],
    changePrimaryKey: false,
    addUniques: [],
    dropUniques: [],
    addIndexes: [],
    dropIndexes: [],
    addForeignKeys: [],
    dropForeignKeys: [],
    ...parts,
  };
}

describe('schema changes', () => {
  let db: DatabaseAdapter;

  before(async () => {
    db = await connectFresh(dialect);
  });

  after(async () => {
    await db.close();
  });

  test('every alter step lands in one pass', async () => {
    await createTable(db, dialect, root('Users'));
    const live = root('Posts', {
      columns: [text('title'), text('slug'), text('legacy'), text('author'), text('views')],
      uniques: [{ name: 'UX__Posts__slug', columns: ['slug'] }],
      indexes: [{ name: 'IX__Posts__title', columns: ['title'] }],
      foreignKeys: [key('author', 'Users')],
    });
    await createTable(db, dialect, live);
    const desired = table('Posts', {
      columns: [
        UUID,
        { name: 'title', type: 'text', notNull: true },
        text('slug'),
        text('author'),
        { name: 'views', type: 'integer', notNull: false },
        text('editor'),
        text('reviewer'),
      ],
      primaryKey: ['UUID', 'slug'],
      uniques: [{ name: 'UX__Posts__title', columns: ['title'] }],
      indexes: [{ name: 'IX__Posts__views', columns: ['views'] }],
      foreignKeys: [key('editor', 'Users'), key('reviewer', 'Reviewers')],
    });
    await alterTable(
      db,
      dialect,
      alter(live, desired, {
        dropUniques: live.uniques,
        dropIndexes: live.indexes,
        dropForeignKeys: live.foreignKeys,
        changePrimaryKey: true,
        dropColumns: [text('legacy')],
        changeColumns: [
          { live: text('title'), desired: desired.columns[1] as ColumnSchema },
          { live: text('views'), desired: desired.columns[4] as ColumnSchema },
        ],
        addColumns: [text('editor'), text('reviewer')],
        addForeignKeys: desired.foreignKeys,
        addUniques: desired.uniques,
        addIndexes: desired.indexes,
      }),
    );
    deepStrictEqual(await describeTable(db, 'Posts'), {
      ...desired,
      columns: [
        UUID,
        { name: 'title', type: 'text', notNull: true },
        { name: 'slug', type: 'text', notNull: true },
        text('author'),
        { name: 'views', type: 'integer', notNull: false },
        text('editor'),
        text('reviewer'),
      ],
    });
    deepStrictEqual(pendingKeys(db, 'Posts'), [key('reviewer', 'Reviewers')]);
    await createTable(db, dialect, root('Reviewers'));
    deepStrictEqual(pendingKeys(db, 'Posts'), []);
    deepStrictEqual((await describeTable(db, 'Posts')).foreignKeys, [
      key('reviewer', 'Reviewers'),
      key('editor', 'Users'),
    ]);
    await db.exec('DROP TABLE "Posts", "Users", "Reviewers"');
  });

  test('a retype empties the column and keeps the others', async () => {
    const live = root('T', { columns: [text('a'), text('b')] });
    await createTable(db, dialect, live);
    await db.run('INSERT INTO "T" VALUES (?, ?, ?)', ['t1', '42', 'kept']);
    const integer: ColumnSchema = { name: 'a', type: 'integer', notNull: false };
    await alterTable(
      db,
      dialect,
      alter(live, root('T', { columns: [integer, text('b')] }), {
        changeColumns: [{ live: text('a'), desired: integer }],
      }),
    );
    deepStrictEqual(await db.query('SELECT "a", "b" FROM "T"'), [row({ a: null, b: 'kept' })]);
    deepStrictEqual((await describeTable(db, 'T')).columns[1], integer);
    await db.exec('DROP TABLE "T"');
  });

  test('a boolean column over an integer one changes nothing', async () => {
    const live = root('T', { columns: [{ name: 'a', type: 'integer', notNull: false }] });
    await createTable(db, dialect, live);
    await db.run('INSERT INTO "T" VALUES (?, ?)', ['t1', 1]);
    const flag: ColumnSchema = { name: 'a', type: 'boolean', notNull: false };
    await alterTable(
      db,
      dialect,
      alter(live, root('T', { columns: [flag] }), {
        changeColumns: [{ live: live.columns[1] as ColumnSchema, desired: flag }],
      }),
    );
    deepStrictEqual(await db.query('SELECT "a" FROM "T"'), [row({ a: 1 })]);
    await db.exec('DROP TABLE "T"');
  });

  test('plain indexes sort NULLs first', async () => {
    await createTable(
      db,
      dialect,
      root('T', {
        columns: [text('a'), text('b')],
        indexes: [{ name: 'IX__T__a_b', columns: ['a', 'b'] }],
      }),
    );
    deepStrictEqual(
      await db.query(
        `SELECT indexdef AS "definition" FROM pg_indexes WHERE indexname = 'IX__T__a_b' AND schemaname = current_schema()`,
      ),
      [
        row({
          definition: `CREATE INDEX "IX__T__a_b" ON ${await currentSchema()}."T" USING btree (a NULLS FIRST, b NULLS FIRST)`,
        }),
      ],
    );
    await db.exec('DROP TABLE "T"');
  });

  test('a forward key waits for its target and a cycle closes', async () => {
    await createTable(
      db,
      dialect,
      root('A', { columns: [text('b')], foreignKeys: [key('b', 'B')] }),
    );
    deepStrictEqual(pendingKeys(db, 'A'), [key('b', 'B')]);
    deepStrictEqual((await describeTable(db, 'A')).foreignKeys, [key('b', 'B')]);
    await createTable(
      db,
      dialect,
      root('B', {
        columns: [text('a'), text('parent')],
        foreignKeys: [key('a', 'A'), key('parent', 'B')],
      }),
    );
    deepStrictEqual(pendingKeys(db, 'A'), []);
    deepStrictEqual(await constraints(), [
      ['A', 'FK__A__b', 'B'],
      ['B', 'FK__B__a', 'A'],
      ['B', 'FK__B__parent', 'B'],
    ]);
    await db.exec('DROP TABLE "A", "B" CASCADE');
  });

  test('dropping a referenced table and creating it again keeps the reference', async () => {
    const target = root('Users');
    await createTable(db, dialect, target);
    await createTable(
      db,
      dialect,
      root('Posts', { columns: [text('author')], foreignKeys: [key('author', 'Users')] }),
    );
    await dropTable(db, dialect, 'Users');
    deepStrictEqual(await constraints(), []);
    deepStrictEqual((await describeTable(db, 'Posts')).foreignKeys, [key('author', 'Users')]);
    await createTable(db, dialect, target);
    deepStrictEqual(pendingKeys(db, 'Posts'), []);
    deepStrictEqual(await constraints(), [['Posts', 'FK__Posts__author', 'Users']]);
    await db.exec('DROP TABLE "Posts", "Users"');
  });

  test('dropping a table forgets the keys it waits on', async () => {
    await createTable(
      db,
      dialect,
      root('Posts', { columns: [text('author')], foreignKeys: [key('author', 'Users')] }),
    );
    await dropTable(db, dialect, 'Posts');
    deepStrictEqual(pendingKeys(db, 'Posts'), []);
    await createTable(db, dialect, root('Users'));
    deepStrictEqual(await listTables(db), ['Users']);
    await db.exec('DROP TABLE "Users"');
  });

  test('a rename carries the pending keys and the key name', async () => {
    await createTable(
      db,
      dialect,
      root('Drafts', { columns: [text('author')], foreignKeys: [key('author', 'Users')] }),
    );
    await renameTable(db, dialect, 'Drafts', 'Posts');
    deepStrictEqual(pendingKeys(db, 'Drafts'), []);
    deepStrictEqual(pendingKeys(db, 'Posts'), [key('author', 'Users')]);
    deepStrictEqual(await primaryKeys(), [['Posts', 'PK__Posts']]);
    await createTable(db, dialect, root('Users'));
    deepStrictEqual(await constraints(), [['Posts', 'FK__Posts__author', 'Users']]);
    await db.exec('DROP TABLE "Posts", "Users"');
  });

  test('a rename onto a waiting target adds the keys', async () => {
    await createTable(
      db,
      dialect,
      root('Posts', { columns: [text('author')], foreignKeys: [key('author', 'Users')] }),
    );
    await createTable(db, dialect, root('People'));
    await renameTable(db, dialect, 'People', 'Users');
    deepStrictEqual(pendingKeys(db, 'Posts'), []);
    deepStrictEqual(await constraints(), [['Posts', 'FK__Posts__author', 'Users']]);
    await db.exec('DROP TABLE "Posts", "Users"');
  });

  test('a rename frees the old name, case-only renames included', async () => {
    await createTable(db, dialect, root('posts'));
    await renameTable(db, dialect, 'posts', 'Posts');
    await createTable(db, dialect, root('posts'));
    await renameTable(db, dialect, 'Posts', 'Archive');
    await createTable(db, dialect, root('Posts'));
    deepStrictEqual(await primaryKeys(), [
      ['Archive', 'PK__Archive'],
      ['Posts', 'PK__Posts'],
      ['posts', 'PK__posts'],
    ]);
    await db.exec('DROP TABLE "Archive", "Posts", "posts"');
  });

  test('a table and its derived `_pkey` table live side by side', async () => {
    await createTable(db, dialect, root('Posts'));
    await createTable(
      db,
      dialect,
      table('Posts_pkey', {
        columns: [{ name: '_parentUUID', type: 'text', notNull: true }, text('value')],
        primaryKey: ['_parentUUID'],
        foreignKeys: [
          {
            column: '_parentUUID',
            targetTable: 'Posts',
            targetColumn: 'UUID',
            onDelete: 'cascade',
          },
        ],
      }),
    );
    deepStrictEqual(await primaryKeys(), [
      ['Posts', 'PK__Posts'],
      ['Posts_pkey', 'PK__Posts_pkey'],
    ]);
    await db.exec('DROP TABLE "Posts_pkey", "Posts"');
  });

  test('a rename carries the foreign-key names and frees the old ones', async () => {
    await createTable(db, dialect, root('Users'));
    await createTable(
      db,
      dialect,
      root('Drafts', {
        columns: [text('author'), text('parent')],
        foreignKeys: [key('author', 'Users'), key('parent', 'Drafts')],
      }),
    );
    await renameTable(db, dialect, 'Drafts', 'Posts');
    await renameTable(db, dialect, 'Users', 'People');
    deepStrictEqual(await constraints(), [
      ['Posts', 'FK__Posts__author', 'People'],
      ['Posts', 'FK__Posts__parent', 'Posts'],
    ]);
    await createTable(
      db,
      dialect,
      root('Drafts', { columns: [text('author')], foreignKeys: [key('author', 'People')] }),
    );
    deepStrictEqual(await constraints(), [
      ['Drafts', 'FK__Drafts__author', 'People'],
      ['Posts', 'FK__Posts__author', 'People'],
      ['Posts', 'FK__Posts__parent', 'Posts'],
    ]);
    await db.exec('DROP TABLE "Drafts", "Posts", "People"');
  });

  test('a foreign key added by an alter takes its name', async () => {
    await createTable(db, dialect, root('Users'));
    const live = root('Posts', { columns: [text('author')] });
    await createTable(db, dialect, live);
    const desired = root('Posts', {
      columns: [text('author')],
      foreignKeys: [key('author', 'Users')],
    });
    await alterTable(db, dialect, alter(live, desired, { addForeignKeys: desired.foreignKeys }));
    deepStrictEqual(await constraints(), [['Posts', 'FK__Posts__author', 'Users']]);
    await alterTable(db, dialect, alter(desired, live, { dropForeignKeys: desired.foreignKeys }));
    deepStrictEqual(await constraints(), []);
    await db.exec('DROP TABLE "Posts", "Users"');
  });

  test('a long table name keys its foreign keys under truncated names', async () => {
    const name = 'Long'.repeat(15);
    const renamed = truncateWithHash('Renamed'.repeat(10));
    await createTable(
      db,
      dialect,
      root(name, { columns: [text('parent')], foreignKeys: [key('parent', name)] }),
    );
    await renameTable(db, dialect, name, renamed);
    const [[, primary] = []] = await primaryKeys();
    const [[, foreign] = []] = await constraints();
    deepStrictEqual(
      [primary?.startsWith('PK__RenamedRenamed'), foreign?.startsWith('FK__RenamedRenamed')],
      [true, true],
    );
    deepStrictEqual([primary?.length, foreign?.length], [63, 63]);
    await dropTable(db, dialect, renamed);
  });

  test('a long table name keys under a truncated name', async () => {
    const name = 'Long'.repeat(15);
    await createTable(db, dialect, root(name));
    const [[, key] = []] = await primaryKeys();
    deepStrictEqual(
      [key?.length, key?.startsWith('PK__LongLong'), key?.includes('$')],
      [63, true, true],
    );
    await dropTable(db, dialect, name);
  });

  test('an index over a value too large for it fails the sync as one framework error', async () => {
    const live = root('Logs', { columns: [text('body')] });
    await createTable(db, dialect, live);
    await db.run('INSERT INTO "Logs" VALUES (?, ?)', ['l1', randomBytes(3000).toString('base64')]);
    const desired = root('Logs', {
      columns: [text('body')],
      indexes: [{ name: 'IX__Logs__body', columns: ['body'] }],
    });
    await rejects(
      alterTable(db, dialect, alter(live, desired, { addIndexes: desired.indexes })),
      (error) => {
        ok(isOhneError(error));
        strictEqual(error.title, 'Index `IX__Logs__body` cannot hold a stored value');
        return true;
      },
    );
    await dropTable(db, dialect, 'Logs');
  });

  test('a primary-key change drops the live key and adds the desired one by name', async () => {
    const live = root('T', { columns: [text('a')] });
    await createTable(db, dialect, live);
    const a: ColumnSchema = { name: 'a', type: 'text', notNull: true };
    const desired = table('T', { columns: [UUID, a], primaryKey: ['a'] });
    await alterTable(
      db,
      dialect,
      alter(live, desired, {
        changePrimaryKey: true,
        changeColumns: [{ live: text('a'), desired: a }],
      }),
    );
    deepStrictEqual((await describeTable(db, 'T')).primaryKey, ['a']);
    deepStrictEqual(await primaryKeys(), [['T', 'PK__T']]);
    await alterTable(
      db,
      dialect,
      alter(desired, table('T', { columns: [UUID, a] }), { changePrimaryKey: true }),
    );
    deepStrictEqual(await primaryKeys(), []);
    await db.exec('DROP TABLE "T"');
  });

  /**
   * Lists every foreign key of the schema as `[owner, name, target]`, sorted.
   */
  async function constraints(): Promise<string[][]> {
    const rows = await db.query<{ owner: string; name: string; target: string }>(
      `SELECT o.relname AS "owner", k.conname AS "name", t.relname AS "target" FROM pg_constraint k ` +
        `JOIN pg_class o ON o.oid = k.conrelid JOIN pg_class t ON t.oid = k.confrelid ` +
        `WHERE k.contype = 'f' AND o.relnamespace = current_schema()::regnamespace ORDER BY 1, 2`,
    );
    return rows.map((row) => [row.owner, row.name, row.target]);
  }

  /**
   * Lists every primary key of the schema as `[table, constraint]`, sorted.
   */
  async function primaryKeys(): Promise<string[][]> {
    const rows = await db.query<{ table: string; name: string }>(
      `SELECT o.relname AS "table", k.conname AS "name" FROM pg_constraint k ` +
        `JOIN pg_class o ON o.oid = k.conrelid ` +
        `WHERE k.contype = 'p' AND o.relnamespace = current_schema()::regnamespace ORDER BY 1, 2`,
    );
    return rows.map((row) => [row.table, row.name]);
  }

  /**
   * Reads the current schema's name.
   */
  async function currentSchema(): Promise<string> {
    const row = await db.queryOne<{ name: string }>('SELECT current_schema() AS "name"');
    return row?.name ?? '';
  }
});
