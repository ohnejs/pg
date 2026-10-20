import type { AddressInfo, Socket } from 'node:net';
import type { DatabaseAdapter, SQLParams } from 'ohnejs';
import type { PoolConfig } from 'pg';

import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  buildDesiredSchema,
  field,
  isOhneError,
  queryUntyped,
  registerDatabase,
  registerDialect,
  useCollections,
  useFields,
} from 'ohnejs';
import { foldCase, isUndefined } from 'ohnejs/utils';
import { escapeIdentifier } from 'pg';

import { PostgresDialect } from '../src/dialect.ts';
import { INSUFFICIENT_PRIVILEGE, sqlstateOf } from '../src/errors.ts';
import { connectFresh, freshSchemaURL, testURL, withClient } from './_postgres.ts';
import { table } from './_schema.ts';

const dialect = new PostgresDialect();

/**
 * Returns `url` with `role` as the role every session it opens acts as.
 */
function asRole(url: string, role: string): string {
  const scoped = new URL(url);
  scoped.searchParams.set('options', `${scoped.searchParams.get('options')} -c role=${role}`);
  return scoped.href;
}

/**
 * `PostgresDialect` with its pool settings readable, and its connect timeout shortened when given.
 */
class PoolProbe extends PostgresDialect {
  readonly connectTimeout: number | undefined;

  constructor(connectTimeout?: number) {
    super();
    this.connectTimeout = connectTimeout;
  }

  /**
   * The pool settings for `url`.
   */
  config(url: string): PoolConfig {
    return this.poolConfig(url);
  }

  /**
   * The production settings, with `connectTimeout` in place of the connect timeout when given.
   */
  protected poolConfig(url: string): PoolConfig {
    const config = super.poolConfig(url);
    return isUndefined(this.connectTimeout)
      ? config
      : { ...config, connectionTimeoutMillis: this.connectTimeout };
  }
}

/**
 * Returns what `promise` rejected with.
 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('PostgresDialect', () => {
  describe('SQL text', () => {
    it('accepts only Postgres URLs', () => {
      ok(dialect.accepts('postgres://localhost/app'));
      ok(dialect.accepts('postgresql://localhost/app'));
      ok(!dialect.accepts(':memory:'));
      ok(!dialect.accepts('.data/ohne.db'));
    });

    it('renders each row-window shape', () => {
      deepStrictEqual(dialect.paginate(null, null), { sql: '', params: [] });
      deepStrictEqual(dialect.paginate(10, null), { sql: 'LIMIT ?', params: [10] });
      deepStrictEqual(dialect.paginate(null, 20), { sql: 'OFFSET ?', params: [20] });
      deepStrictEqual(dialect.paginate(10, 20), { sql: 'LIMIT ? OFFSET ?', params: [10, 20] });
    });

    it('pins NULLs first ascending and last descending', () => {
      strictEqual(dialect.sortTerm('"t"', 'asc', true), '"t" ASC NULLS FIRST');
      strictEqual(dialect.sortTerm('"t"', 'desc', true), '"t" DESC NULLS LAST');
    });

    it('leaves a term that is never NULL bare', () => {
      strictEqual(dialect.sortTerm('"UUID"', 'asc', false), '"UUID" ASC');
      strictEqual(dialect.sortTerm('"UUID"', 'desc', false), '"UUID" DESC');
    });

    it('escapes with a backslash only when asked', () => {
      strictEqual(dialect.like('"t"', false), `"t" COLLATE "C" ILIKE ? ESCAPE ''`);
      strictEqual(dialect.like('"t"', true), `"t" COLLATE "C" ILIKE ? ESCAPE '\\'`);
    });

    it('binds the distinct probe values as one JSON array', () => {
      deepStrictEqual(dialect.listMembership('"l"', 'includes', ['a', 'a', true, 1]).params, [
        '["a",true,1]',
      ]);
      deepStrictEqual(dialect.listMembership('"l"', 'includesAll', []), {
        sql: '1 = 1',
        params: [],
      });
      deepStrictEqual(dialect.listMembership('"l"', 'includesAny', []), {
        sql: '1 = 0',
        params: [],
      });
    });

    it('classifies busy and constraint errors by SQLSTATE', () => {
      for (const code of ['55P03', '40P01', '40001']) ok(dialect.isBusy({ code }), code);
      ok(!dialect.isBusy({ code: '23505' }));
      ok(!dialect.isBusy(new Error('locked')));
      ok(dialect.isUniqueViolation({ code: '23505' }));
      ok(dialect.isForeignKeyViolation({ code: '23503' }));
    });
  });

  describe('on a live database', () => {
    let db: DatabaseAdapter;

    before(async () => {
      db = await connectFresh(dialect);
      await db.exec(
        `CREATE TABLE "T" ("UUID" ${dialect.columnType('text')} PRIMARY KEY, ` +
          `"title" ${dialect.columnType('text')}, "flag" ${dialect.columnType('boolean')}, ` +
          `"rank" ${dialect.columnType('integer')}, "labels" ${dialect.columnType('json')})`,
      );
      await db.run(
        'INSERT INTO "T" VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), ' +
          '(?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)',
        [
          'a',
          'STRASSE',
          dialect.serialize('boolean', true),
          2,
          '["x", true]',
          'b',
          'Straße',
          dialect.serialize('boolean', false),
          null,
          '["x", 1]',
          'c',
          'Café Noir',
          null,
          1,
          '["y"]',
          'd',
          'İstanbul',
          null,
          3,
          '[]',
          'e',
          'a%b\\c',
          null,
          null,
          null,
          'f',
          'École',
          null,
          null,
          '["x", "y"]',
        ],
      );
    });

    after(() => db.close());

    /**
     * Reads the `UUID`s of `T` rows matching `where`, sorted.
     */
    async function ids(where: string, params: SQLParams): Promise<string[]> {
      const rows = await db.query<{ UUID: string }>(
        `SELECT "UUID" FROM "T" WHERE ${where} ORDER BY "UUID"`,
        params,
      );
      return rows.map((row) => row.UUID);
    }

    it('round-trips a boolean through its integer column', async () => {
      const rows = await db.query<{ flag: number | null }>(
        'SELECT "flag" FROM "T" WHERE "UUID" IN (?, ?) ORDER BY "UUID"',
        ['a', 'b'],
      );
      deepStrictEqual(
        rows.map((row) => dialect.deserialize('boolean', row.flag)),
        [true, false],
      );
    });

    it('matches text ignoring case and accents, as `foldCase` folds it', async () => {
      const match = dialect.textMatch('"title"');
      deepStrictEqual(await ids(match, [`%${foldCase('strasse')}%`]), ['a', 'b']);
      deepStrictEqual(await ids(match, [`${foldCase('cafe')}%`]), ['c']);
      deepStrictEqual(await ids(match, [`%${foldCase('ISTAN')}%`]), ['d']);
      deepStrictEqual(await ids(match, ['%a\\%b%']), ['e']);
      deepStrictEqual(await ids(match, ['ecole']), ['f']);
    });

    it('`like` folds ASCII case alone and escapes only when asked', async () => {
      deepStrictEqual(await ids(dialect.like('"title"', false), ['sTRASS%']), ['a']);
      deepStrictEqual(await ids(dialect.like('"title"', false), ['école']), []);
      deepStrictEqual(await ids(dialect.like('"title"', false), ['a%b\\c']), ['e']);
      deepStrictEqual(await ids(dialect.like('"title"', true), ['a\\%b%']), ['e']);
    });

    it('matches list membership, keeping `true` and `1` apart', async () => {
      const membership = (op: 'includes' | 'includesAll' | 'includesAny', values: unknown[]) => {
        const { sql, params } = dialect.listMembership('"labels"', op, values);
        return ids(`"labels" IS NOT NULL AND ${sql}`, params);
      };
      deepStrictEqual(await membership('includes', ['x']), ['a', 'b', 'f']);
      deepStrictEqual(await membership('includes', [true]), ['a']);
      deepStrictEqual(await membership('includes', [1]), ['b']);
      deepStrictEqual(await membership('includesAny', ['y', 1]), ['b', 'c', 'f']);
      deepStrictEqual(await membership('includesAll', ['x', 'y']), ['f']);
      deepStrictEqual(await membership('includesAll', []), ['a', 'b', 'c', 'd', 'f']);
    });

    it('matches list membership by value, whatever spelling the stored JSON uses', async () => {
      const matches = async (stored: string, op: 'includes' | 'includesAll', values: unknown[]) => {
        const { sql, params } = dialect.listMembership('"labels"', op, values);
        const rows = await db.query(
          `SELECT 1 FROM (VALUES (?::text)) AS "r"("labels") WHERE ${sql}`,
          [stored, ...params],
        );
        return rows.length === 1;
      };
      ok(await matches('["\\u00e9", "caf\\u00e9"]', 'includes', ['café']));
      ok(await matches('["a\\/b"]', 'includes', ['a/b']));
      ok(await matches('["\\u00e9", "a\\/b"]', 'includesAll', ['é', 'a/b']));
      ok(await matches('[1.0, 2e0, -0]', 'includesAll', [1, 2, 0]));
      ok(await matches('[1e21]', 'includes', [1e21]));
      ok(await matches('["\\u000a"]', 'includes', ['\n']));
      ok(await matches('["\\\\u0000caf\\u00e9"]', 'includes', ['\\u0000café']));
      ok(await matches('["\\\\ud800caf\\u00e9"]', 'includes', ['\\ud800café']));
      ok(!(await matches('[1.0]', 'includes', ['1'])));
      ok(!(await matches('["true"]', 'includes', [true])));
    });

    it('matches list membership over a stored `\\u0000`, which `jsonb` refuses', async () => {
      const { sql, params } = dialect.listMembership('"labels"', 'includes', ['a\u0000b']);
      const rows = await db.query(
        `SELECT 1 FROM (VALUES (?::text)) AS "r"("labels") WHERE ${sql}`,
        [JSON.stringify(['x', 'a\u0000b']), ...params],
      );
      strictEqual(rows.length, 1);
    });

    it('matches list membership over a stored lone surrogate, which Postgres cannot decode', async () => {
      const stored = JSON.stringify(['x', 'a\ud800b', '\\ud800\udc00']);
      for (const value of ['x', 'a\ud800b', '\\ud800\udc00']) {
        const { sql, params } = dialect.listMembership('"labels"', 'includes', [value]);
        const rows = await db.query(
          `SELECT 1 FROM (VALUES (?::text)) AS "r"("labels") WHERE ${sql}`,
          [stored, ...params],
        );
        strictEqual(rows.length, 1);
      }
    });

    it('fails list membership over a stored JSON value that is not an array', async () => {
      const { sql, params } = dialect.listMembership('"labels"', 'includes', ['x']);
      await rejects(
        db.query(`SELECT 1 FROM (VALUES (?::text)) AS "r"("labels") WHERE ${sql}`, [
          '"x"',
          ...params,
        ]),
        { code: '22023' },
      );
    });

    it('fails comparing an integer column with a number that is not an integer', async () => {
      await rejects(ids('"rank" > ?', [1.5]), { code: '22P02' });
      await rejects(ids('"rank" = ?', [1.5]), { code: '22P02' });
    });

    it('refuses U+0000 in text', async () => {
      await rejects(db.query('SELECT ?::text AS "t"', ['a\u0000b']), { code: '22021' });
    });

    it('fails every statement after a caught failure in a transaction, the commit included', async () => {
      await rejects(
        db.transaction(async (tx) => {
          await tx.query('SELECT 1 / 0').catch(() => undefined);
          await rejects(tx.query('SELECT 1'), { code: '25P02' });
        }),
        { code: '25P02' },
      );
    });

    it('sorts NULLs first ascending and last descending, and windows the rows', async () => {
      const page = async (
        direction: 'asc' | 'desc',
        limit: number | null,
        offset: number | null,
      ) => {
        const window = dialect.paginate(limit, offset);
        const rows = await db.query<{ UUID: string }>(
          `SELECT "UUID" FROM "T" ORDER BY ${dialect.sortTerm('"rank"', direction, true)}, "UUID" ${window.sql}`,
          window.params,
        );
        return rows.map((row) => row.UUID);
      };
      deepStrictEqual(await page('asc', null, null), ['b', 'e', 'f', 'c', 'a', 'd']);
      deepStrictEqual(await page('desc', null, null), ['d', 'a', 'c', 'b', 'e', 'f']);
      deepStrictEqual(await page('asc', 2, 3), ['c', 'a']);
      deepStrictEqual(await page('asc', null, 4), ['a', 'd']);
    });

    it('reads a unique violation target from the index name', async () => {
      await dialect.schemaTransaction(db, (tx) =>
        dialect.applyTableDiff(tx, {
          kind: 'create',
          table: table('Users', {
            columns: [
              { name: 'UUID', type: 'text', notNull: true },
              { name: 'email', type: 'text', notNull: false },
            ],
            primaryKey: ['UUID'],
            uniques: [{ name: 'UX__Users__email', columns: ['email'] }],
          }),
        }),
      );
      await db.run('INSERT INTO "Users" VALUES (?, ?)', ['u1', 'thrall@horde']);
      const duplicate = await rejection(
        db.run('INSERT INTO "Users" VALUES (?, ?)', ['u2', 'thrall@horde']),
      );
      ok(dialect.isUniqueViolation(duplicate));
      deepStrictEqual(dialect.indexViolationTarget(duplicate), {
        table: 'Users',
        columns: ['email'],
      });
      const key = await rejection(db.run('INSERT INTO "Users" VALUES (?, ?)', ['u1', 'x']));
      ok(dialect.isUniqueViolation(key));
      strictEqual(dialect.indexViolationTarget(key), null);
    });

    it('classifies a value too large for its index, naming the index while Postgres does', async () => {
      await dialect.schemaTransaction(db, (tx) =>
        dialect.applyTableDiff(tx, {
          kind: 'create',
          table: table('Notes', {
            columns: [
              { name: 'UUID', type: 'text', notNull: true },
              { name: 'body', type: 'text', notNull: false },
            ],
            primaryKey: ['UUID'],
            indexes: [{ name: 'IX__Notes__body', columns: ['body'] }],
          }),
        }),
      );
      const big = await rejection(
        db.run('INSERT INTO "Notes" VALUES (?, ?)', ['n1', randomBytes(3000).toString('base64')]),
      );
      ok(dialect.isIndexOverflow(big));
      ok(!dialect.isUniqueViolation(big));
      deepStrictEqual(dialect.indexViolationTarget(big), { table: 'Notes', columns: ['body'] });
      const huge = await rejection(
        db.run('INSERT INTO "Notes" VALUES (?, ?)', [
          'n2',
          randomBytes(100_000).toString('base64'),
        ]),
      );
      ok(dialect.isIndexOverflow(huge));
      strictEqual(dialect.indexViolationTarget(huge), null);
    });

    describe('schemaTransaction', () => {
      it('commits and returns the result', async () => {
        strictEqual(
          await dialect.schemaTransaction(db, async (tx) => {
            await tx.exec('CREATE TABLE "Committed" ("x" BIGINT)');
            return 'done';
          }),
          'done',
        );
        ok((await dialect.listTables(db)).includes('Committed'));
      });

      it('rolls back a rehearsal and still returns the result', async () => {
        strictEqual(
          await dialect.schemaTransaction(
            db,
            async (tx) => {
              await tx.exec('CREATE TABLE "Rehearsed" ("x" BIGINT)');
              return 'rehearsed';
            },
            { commit: false },
          ),
          'rehearsed',
        );
        ok(!(await dialect.listTables(db)).includes('Rehearsed'));
      });

      it('rolls back DDL on failure and rethrows', async () => {
        const failure = new Error('stop');
        const error = await rejection(
          dialect.schemaTransaction(db, async (tx) => {
            await tx.exec('CREATE TABLE "Failed" ("x" BIGINT)');
            throw failure;
          }),
        );
        strictEqual(error, failure);
        ok(!(await dialect.listTables(db)).includes('Failed'));
      });

      it('checks no foreign key inside, and settles a forward key before commit', async () => {
        await dialect.schemaTransaction(db, async (tx) => {
          await dialect.applyTableDiff(tx, {
            kind: 'create',
            table: table('Child', {
              columns: [{ name: 'parent', type: 'text', notNull: false }],
              foreignKeys: [
                {
                  column: 'parent',
                  targetTable: 'Parent',
                  targetColumn: 'UUID',
                  onDelete: 'restrict',
                },
              ],
            }),
          });
          await dialect.applyTableDiff(tx, {
            kind: 'create',
            table: table('Parent', {
              columns: [{ name: 'UUID', type: 'text', notNull: true }],
              primaryKey: ['UUID'],
            }),
          });
          await tx.run('INSERT INTO "Child" VALUES (?)', ['missing']);
        });
        deepStrictEqual((await dialect.describeTable(db, 'Child')).foreignKeys, [
          { column: 'parent', targetTable: 'Parent', targetColumn: 'UUID', onDelete: 'restrict' },
        ]);
        const error = await rejection(db.run('INSERT INTO "Child" VALUES (?)', ['other']));
        ok(dialect.isForeignKeyViolation(error));
      });
      it('settles the keys still pending at the end, adding a live target and forgetting a gone one', async () => {
        await dialect.schemaTransaction(db, async (tx) => {
          await dialect.applyTableDiff(tx, {
            kind: 'create',
            table: table('Orphan', {
              columns: [
                { name: 'owner', type: 'text', notNull: false },
                { name: 'gone', type: 'text', notNull: false },
              ],
              foreignKeys: [
                {
                  column: 'owner',
                  targetTable: 'Owner',
                  targetColumn: 'UUID',
                  onDelete: 'cascade',
                },
                { column: 'gone', targetTable: 'Gone', targetColumn: 'UUID', onDelete: 'cascade' },
              ],
            }),
          });
          await tx.exec('CREATE TABLE "Owner" ("UUID" TEXT PRIMARY KEY)');
        });
        deepStrictEqual((await dialect.describeTable(db, 'Orphan')).foreignKeys, [
          { column: 'owner', targetTable: 'Owner', targetColumn: 'UUID', onDelete: 'cascade' },
        ]);
        await rejects(db.run('INSERT INTO "Orphan" VALUES (?, ?)', ['missing', null]), {
          code: '23503',
        });
      });
    });

    describe('ensureTable', () => {
      it('creates through one `exec` and then runs no DDL', async () => {
        const execs: string[] = [];
        const counted = {
          ...db,
          async exec(sql: string) {
            execs.push(sql);
            await db.exec(sql);
          },
        };
        await dialect.ensureTable(counted, 'ohne_notes', '"key" TEXT PRIMARY KEY');
        await dialect.ensureTable(counted, 'ohne_notes', '"key" TEXT PRIMARY KEY');
        strictEqual(execs.length, 1);
        ok((await dialect.listTables(db)).includes('ohne_notes'));
      });

      it('rethrows a busy error', async () => {
        const busy = Object.assign(new Error('canceling statement due to lock timeout'), {
          code: '55P03',
        });
        const stalled = {
          ...db,
          exec: () => Promise.reject(busy),
          run: () => Promise.reject(busy),
        };
        strictEqual(await rejection(dialect.ensureTable(stalled, 'ohne_busy', '"k" TEXT')), busy);
      });

      describe('a create that loses the race', () => {
        let url: string;
        let raced: DatabaseAdapter;

        before(async () => {
          url = await freshSchemaURL();
          raced = await dialect.connect(url);
        });

        after(() => raced.close());

        const race = (table: string, ensure: () => Promise<void>) =>
          withClient(url, async (rival) => {
            await rival.query(`BEGIN; CREATE TABLE "${table}" ("k" TEXT)`);
            const ensured = ensure();
            await sleep(200);
            await rival.query('COMMIT');
            await ensured;
            ok((await dialect.listTables(raced)).includes(table));
          });

        it('counts once the table is there', () =>
          race('ohne_raced', () => dialect.ensureTable(raced, 'ohne_raced', '"k" TEXT')));

        it('leaves an enclosing transaction usable', () =>
          race('ohne_raced_tx', () =>
            raced.transaction(async (tx) => {
              await dialect.ensureTable(tx, 'ohne_raced_tx', '"k" TEXT');
              await tx.run('INSERT INTO "ohne_raced_tx" VALUES (?)', ['k']);
            }),
          ));
      });
    });

    it('runs the inherited cluster lock', async () => {
      const handle = await dialect.acquireLock(db, 'job');
      ok(handle);
      strictEqual(await dialect.acquireLock(db, 'job'), null);
      await dialect.releaseLock(db, handle);
      ok(await dialect.acquireLock(db, 'job'));
    });
  });

  describe('connect', () => {
    it('fails with the URL, its secrets removed, when the server cannot be reached', async () => {
      const error = await rejection(
        dialect.connect('postgres://thrall:secret@localhost:1/app?password=hidden'),
      );
      ok(isOhneError(error));
      strictEqual(error.title, 'Cannot reach Postgres');
      const body = String(error.body);
      ok(body.includes('postgres://localhost:1/app'), body);
      ok(!body.includes('secret') && !body.includes('hidden'), body);
    });

    it('bounds each connection attempt and keeps TCP keepalives on', () => {
      const config = new PoolProbe().config('postgres://localhost/app');
      strictEqual(config.connectionTimeoutMillis, 10_000);
      strictEqual(config.keepAlive, true);
    });

    it('gives up on a server that accepts the connection and never answers', async () => {
      const stalled = new Set<Socket>();
      const server = createServer((socket) => stalled.add(socket));
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const { port } = server.address() as AddressInfo;
      try {
        const error = await rejection(
          new PoolProbe(200).connect(`postgres://localhost:${port}/app`),
        );
        ok(isOhneError(error));
        strictEqual(error.title, 'Cannot reach Postgres');
      } finally {
        for (const socket of stalled) socket.destroy();
        server.close();
      }
    });
  });

  describe('session_replication_role', () => {
    const role = `ohne_r_${process.env.OHNE_PG_TEST_RUN}_${process.pid}`;
    let url: string;

    before(async () => {
      url = await freshSchemaURL();
      const schema = escapeIdentifier(
        new URL(url).searchParams.get('options')!.replace('-c search_path=', ''),
      );
      await withClient(url, (client) =>
        client.query(
          `CREATE ROLE ${escapeIdentifier(role)} NOLOGIN; ` +
            `GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${escapeIdentifier(role)}; ` +
            'CREATE TABLE "Owned" ("x" BIGINT)',
        ),
      );
    });

    after(() =>
      withClient(testURL, (client) =>
        client.query(
          `DROP OWNED BY ${escapeIdentifier(role)}; DROP ROLE ${escapeIdentifier(role)}`,
        ),
      ),
    );

    it('names the grant when the role may not set it', async () => {
      const db = await dialect.connect(asRole(url, role));
      try {
        const error = await rejection(dialect.schemaTransaction(db, async () => {}));
        ok(isOhneError(error));
        strictEqual(error.title, 'The role cannot set `session_replication_role`');
        ok(
          String(error.body).includes(
            `GRANT SET ON PARAMETER session_replication_role TO "${role}"`,
          ),
        );
      } finally {
        await db.close();
      }
    });

    it('keeps the error of any other statement the role may not run', async () => {
      await withClient(testURL, (client) =>
        client.query(
          `GRANT SET ON PARAMETER session_replication_role TO ${escapeIdentifier(role)}`,
        ),
      );
      const db = await dialect.connect(asRole(url, role));
      try {
        const error = await rejection(
          dialect.schemaTransaction(db, (tx) =>
            tx.exec('ALTER TABLE "Owned" ADD COLUMN "y" BIGINT'),
          ),
        );
        ok(!isOhneError(error));
        strictEqual(sqlstateOf(error), INSUFFICIENT_PRIVILEGE);
      } finally {
        await db.close();
      }
    });
  });

  describe('a role without `CREATE` on the schema', () => {
    const role = `ohne_c_${process.env.OHNE_PG_TEST_RUN}_${process.pid}`;
    const grant = (schema: string) => `GRANT USAGE, CREATE ON SCHEMA ${schema} TO "${role}"`;
    let url: string;
    let schema: string;

    before(async () => {
      url = await freshSchemaURL();
      schema = escapeIdentifier(
        new URL(url).searchParams.get('options')!.replace('-c search_path=', ''),
      );
      await withClient(url, (client) =>
        client.query(
          `CREATE ROLE ${escapeIdentifier(role)} NOLOGIN; ` +
            `GRANT USAGE ON SCHEMA ${schema} TO ${escapeIdentifier(role)}; ` +
            `GRANT SET ON PARAMETER session_replication_role TO ${escapeIdentifier(role)}`,
        ),
      );
    });

    after(() =>
      withClient(testURL, (client) =>
        client.query(
          `DROP OWNED BY ${escapeIdentifier(role)}; DROP ROLE ${escapeIdentifier(role)}`,
        ),
      ),
    );

    it('names the grant when `ensureTable` may not create the table', async () => {
      const db = await dialect.connect(asRole(url, role));
      try {
        const error = await rejection(dialect.ensureTable(db, 'ohne_t', '"k" TEXT'));
        ok(isOhneError(error));
        strictEqual(error.title, `The role cannot create tables in \`${schema.slice(1, -1)}\``);
        ok(String(error.body).includes(grant(schema)));
      } finally {
        await db.close();
      }
    });

    it('names the grant when `ensureTable` may not create the table in a transaction', async () => {
      const db = await dialect.connect(asRole(url, role));
      try {
        const error = await rejection(
          db.transaction((tx) => dialect.ensureTable(tx, 'ohne_t', '"k" TEXT')),
        );
        ok(isOhneError(error));
        ok(String(error.body).includes(grant(schema)));
      } finally {
        await db.close();
      }
    });

    it('names the grant when the schema sync may not create a table', async () => {
      const db = await dialect.connect(asRole(url, role));
      try {
        const error = await rejection(
          dialect.schemaTransaction(db, (tx) => tx.exec('CREATE TABLE "New" ("x" BIGINT)')),
        );
        ok(isOhneError(error));
        ok(String(error.body).includes(grant(schema)));
      } finally {
        await db.close();
      }
    });
  });

  describe('read plans', () => {
    let db: DatabaseAdapter;

    useCollections().register('XPosts', {
      name: 'XPosts',
      collection: {
        fields: { title: field('text'), slug: field('text', { nullable: true, unique: true }) },
      },
    });

    before(async () => {
      db = await connectFresh(dialect);
      await dialect.schemaTransaction(db, async (tx) => {
        for (const desired of buildDesiredSchema(useCollections(), useFields() as never)) {
          await dialect.applyTableDiff(tx, { kind: 'create', table: desired });
        }
      });
      await db.exec(
        `INSERT INTO "XPosts" ("UUID", "_updatedAt", "title", "slug") ` +
          `SELECT 'p' || n, 0, 'Post ' || n, CASE WHEN n % 10 = 0 THEN NULL ELSE 's' || n END ` +
          'FROM generate_series(1, 20000) AS n; ANALYZE',
      );
      registerDialect(dialect);
      registerDatabase(db);
    });

    after(() => db.close());

    /**
     * Returns Postgres's plan for the first page of post titles, sorted by `orderBy` when given.
     */
    async function plan(orderBy?: string): Promise<string> {
      const statements: { sql: string; params: SQLParams }[] = [];
      const query = db.query;
      registerDatabase({
        ...db,
        query(sql, params = []) {
          statements.push({ sql, params });
          return query(sql, params);
        },
      });
      const page = queryUntyped('XPosts').select('title').limit(20);
      await (orderBy ? page.orderBy(orderBy) : page).findMany();
      registerDatabase(db);
      const read = statements.find(
        ({ sql }) => sql.startsWith('SELECT') && sql.includes('FROM "XPosts"'),
      )!;
      const steps = await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${read.sql}`, read.params);
      return steps.map((step) => step['QUERY PLAN']).join('\n');
    }

    it('walks the primary key for a page in default order', async () => {
      const steps = await plan();
      ok(/Index Scan using "PK__XPosts" on "XPosts"/.test(steps), steps);
      ok(!/Seq Scan/.test(steps), steps);
    });

    it('walks a unique index for a page sorted by its nullable column', async () => {
      const steps = await plan('slug');
      ok(/Index Scan using "[^"]+" on "XPosts"/.test(steps), steps);
      ok(!/Seq Scan/.test(steps), steps);
    });
  });
});
