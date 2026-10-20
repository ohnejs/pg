import type { DatabaseAdapter } from 'ohnejs';
import type { PoolConfig } from 'pg';

import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { sleep } from 'ohnejs/utils';
import { Pool } from 'pg';

import { createAdapter } from '../src/adapter.ts';
import { typeParsers } from '../src/types.ts';
import { freshSchemaURL } from './_postgres.ts';

/**
 * Opens an adapter on a pool of its own over `url`.
 */
function open(url: string, config: PoolConfig = {}): DatabaseAdapter {
  return createAdapter(new Pool({ connectionString: url, types: typeParsers, ...config }));
}

/**
 * Opens an adapter on a pool of its own over a fresh schema.
 */
async function connect(config: PoolConfig = {}): Promise<DatabaseAdapter> {
  return open(await freshSchemaURL(), config);
}

/**
 * A promise with its resolver, for holding a flow open until a test releases it.
 */
function gate(): { opened: Promise<void>; open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { opened: promise, open: () => resolve() };
}

/**
 * Reads the server process id of the session a statement ran on.
 */
async function backend(db: Pick<DatabaseAdapter, 'queryOne'>): Promise<number> {
  return (await db.queryOne<{ pid: number }>('SELECT pg_backend_pid() AS "pid"'))!.pid;
}

/**
 * Reads the lock wait cap of the session a statement ran on.
 */
async function lockTimeout(db: Pick<DatabaseAdapter, 'queryOne'>): Promise<string> {
  return (await db.queryOne<{ lock_timeout: string }>('SHOW lock_timeout'))!.lock_timeout;
}

/**
 * Reads the keys stored in `t`, sorted.
 */
async function keys(db: DatabaseAdapter): Promise<string[]> {
  return (await db.query<{ k: string }>('SELECT "k" FROM "t" ORDER BY "k"')).map(({ k }) => k);
}

describe('createAdapter', () => {
  let db: DatabaseAdapter;

  before(async () => {
    db = await connect({ max: 4 });
    await db.exec('CREATE TABLE "t" ("k" TEXT PRIMARY KEY, "n" BIGINT)');
  });

  after(() => db.close());

  describe('statements', () => {
    it('binds `?` placeholders and reports changed rows', async () => {
      strictEqual(
        (await db.run('INSERT INTO "t" VALUES (?, ?), (?, ?)', ['a', 1, 'b', 2])).changes,
        2,
      );
      strictEqual((await db.run('DELETE FROM "t" WHERE "k" IN (?, ?)', ['a', 'b'])).changes, 2);
    });

    it('reports no changes for a statement without a row count', async () => {
      strictEqual((await db.run('CREATE TABLE "ddl" ("k" TEXT)')).changes, 0);
      strictEqual((await db.run('DROP TABLE "ddl"')).changes, 0);
    });

    it('runs several statements in one `exec`, and the last result of a query', async () => {
      await db.exec(`INSERT INTO "t" VALUES ('x', 1); INSERT INTO "t" VALUES ('y', 2)`);
      deepStrictEqual(await db.query(`SELECT 1 AS "first"; SELECT count(*) AS "n" FROM "t"`), [
        Object.assign(Object.create(null), { n: 2 }),
      ]);
      strictEqual((await db.run(`DELETE FROM "t" WHERE "k" = 'none'; DELETE FROM "t"`)).changes, 2);
    });

    it('leaves `?` alone in a statement without params', async () => {
      deepStrictEqual(
        await db.queryOne(`SELECT '?' AS "q"`),
        Object.assign(Object.create(null), { q: '?' }),
      );
    });

    it('returns null-prototype rows', async () => {
      const rows = await db.query<Record<string, unknown>>('SELECT ?::text AS "a", 2 AS "b"', [
        'x',
      ]);
      strictEqual(Object.getPrototypeOf(rows[0]), null);
      deepStrictEqual(rows, [Object.assign(Object.create(null), { a: 'x', b: 2 })]);
    });

    it('reads `int8` as a number when safe and as text when not', async () => {
      deepStrictEqual(
        await db.queryOne('SELECT 7::int8 AS "safe", 9007199254740993::int8 AS "unsafe"'),
        Object.assign(Object.create(null), { safe: 7, unsafe: '9007199254740993' }),
      );
    });

    it('returns `undefined` from `queryOne` when no row matches', async () => {
      strictEqual(await db.queryOne('SELECT 1 FROM "t" WHERE "k" = ?', ['none']), undefined);
    });

    it('keeps working through a spread copy and detached methods', async () => {
      const copy = { ...db };
      const { queryOne } = db;
      strictEqual((await copy.queryOne<{ n: number }>('SELECT 1 AS "n"'))!.n, 1);
      strictEqual((await queryOne<{ n: number }>('SELECT 2 AS "n"'))!.n, 2);
      strictEqual(
        await copy.transaction(
          async (tx) => (await tx.queryOne<{ n: number }>('SELECT 3 AS "n"'))!.n,
        ),
        3,
      );
    });

    it('binds as many params as the Bind message counts, and refuses one more', async () => {
      const marks = (count: number) => Array.from({ length: count }, () => '?').join(', ');
      const values = (count: number) => Array.from({ length: count }, (_, index) => `v${index}`);
      const sql = (count: number) =>
        `SELECT count(*) AS "n" FROM "t" WHERE "k" IN (${marks(count)})`;
      strictEqual((await db.queryOne<{ n: number }>(sql(65535), values(65535)))!.n, 0);
      for (const count of [65536, 70000]) {
        await rejects(db.queryOne(sql(count), values(count)), {
          message: 'Query exceeds the driver parameter cap',
        });
      }
    });

    it("passes the server's error through with its SQLSTATE, named `DatabaseError`", async () => {
      const failure = { name: 'DatabaseError', code: '22012' };
      await rejects(db.query('SELECT 1 / ?', [0]), failure);
      await rejects(db.exec('SELECT 1 / 0'), failure);
      await rejects(
        db.transaction((tx) => tx.query('SELECT 1 / ?', [0])),
        failure,
      );
    });

    it('traces a server error back to the code that ran the statement', async () => {
      /**
       * Runs a statement the server refuses, inside a transaction or not.
       */
      async function divideByZero(inTransaction: boolean): Promise<void> {
        await (inTransaction
          ? db.transaction((tx) => tx.query('SELECT 1 / ?', [0]))
          : db.query('SELECT 1 / ?', [0]));
      }
      for (const inTransaction of [false, true]) {
        const stack = await divideByZero(inTransaction).then(
          () => '',
          (caught: Error) => String(caught.stack),
        );
        ok(stack.includes('divideByZero'), stack);
      }
    });
  });

  describe('transaction', () => {
    it('commits what `fn` writes and resolves with its result', async () => {
      strictEqual(
        await db.transaction(async (tx) => {
          await tx.run('INSERT INTO "t" VALUES (?, 1)', ['c1']);
          return 'done';
        }),
        'done',
      );
      deepStrictEqual(await keys(db), ['c1']);
      await db.run('DELETE FROM "t"');
    });

    it('routes the adapter inside its flow, so reads see uncommitted rows that others do not', async () => {
      const inside = gate();
      const outside = inside.opened.then(() =>
        db.queryOne('SELECT 1 FROM "t" WHERE "k" = ?', ['u1']),
      );
      const seen = await db.transaction(async (tx) => {
        await tx.run('INSERT INTO "t" VALUES (?, 1)', ['u1']);
        const mine = await db.queryOne('SELECT 1 FROM "t" WHERE "k" = ?', ['u1']);
        inside.open();
        strictEqual(await outside, undefined);
        return mine;
      });
      ok(seen);
      await db.run('DELETE FROM "t"');
    });

    it('rolls back writes made through the adapter inside the flow', async () => {
      await rejects(
        db.transaction(async () => {
          await db.run('INSERT INTO "t" VALUES (?, 1)', ['r1']);
          throw new Error('stop');
        }),
        { message: 'stop' },
      );
      deepStrictEqual(await keys(db), []);
    });

    it('runs `Promise.all` inside a transaction one statement at a time on its client', async () => {
      const pids = await db.transaction(async (tx) => {
        await Promise.all(
          ['p1', 'p2', 'p3', 'p4'].map((k) => tx.run('INSERT INTO "t" VALUES (?, 1)', [k])),
        );
        return Promise.all(Array.from({ length: 4 }, () => backend(tx)));
      });
      strictEqual(new Set(pids).size, 1);
      deepStrictEqual(await keys(db), ['p1', 'p2', 'p3', 'p4']);
      await db.run('DELETE FROM "t"');
    });

    it('rejects with `25P02` when `fn` swallows a failed statement, writing nothing', async () => {
      await rejects(
        db.transaction(async (tx) => {
          await tx.run('INSERT INTO "t" VALUES (?, 1)', ['s1']);
          await tx.query('SELECT 1 / 0').catch(() => undefined);
          return 'looks fine';
        }),
        { code: '25P02' },
      );
      deepStrictEqual(await keys(db), []);
    });

    it('serializes two `immediate` check-then-insert transactions', async () => {
      const url = await freshSchemaURL();
      const a = open(url);
      const b = open(url);
      try {
        await a.exec('CREATE TABLE "t" ("k" TEXT PRIMARY KEY, "n" BIGINT)');
        const insertOnce = (writer: DatabaseAdapter) =>
          writer.transaction(async (tx) => {
            const { n } = (await tx.queryOne<{ n: number }>(
              'SELECT count(*) AS "n" FROM "t" WHERE "n" = 9',
            ))!;
            await sleep(50);
            if (n === 0) await tx.run('INSERT INTO "t" VALUES (?, 9)', [crypto.randomUUID()]);
          }, 'immediate');
        await Promise.all([insertOnce(a), insertOnce(b)]);
        strictEqual((await a.queryOne<{ n: number }>('SELECT count(*) AS "n" FROM "t"'))!.n, 1);
      } finally {
        await a.close();
        await b.close();
      }
    });

    it('serializes `immediate` writers on a server that defaults to `repeatable read`', async () => {
      const url = await freshSchemaURL();
      const writers = Array.from({ length: 3 }, () => {
        const pool = new Pool({ connectionString: url, types: typeParsers });
        pool.on('connect', (client) => {
          client.query("SET default_transaction_isolation = 'repeatable read'").catch(() => {});
        });
        return createAdapter(pool);
      });
      try {
        await writers[0]!.exec('CREATE TABLE "seq" ("n" BIGINT)');
        const next = (rr: DatabaseAdapter) =>
          rr.transaction(async (tx) => {
            const { n } = (await tx.queryOne<{ n: number }>('SELECT count(*) AS "n" FROM "seq"'))!;
            await sleep(50);
            await tx.run('INSERT INTO "seq" VALUES (?)', [n + 1]);
          }, 'immediate');
        await Promise.all(writers.map(next));
        const rows = await writers[0]!.query<{ n: number }>('SELECT "n" FROM "seq" ORDER BY "n"');
        deepStrictEqual(
          rows.map(({ n }) => n),
          [1, 2, 3],
        );
      } finally {
        for (const rr of writers) await rr.close();
      }
    });

    it('queues `immediate` writers before they take a client, so a read still gets one', async () => {
      const pair = await connect({ max: 2 });
      const locked = gate();
      const held = gate();
      try {
        const first = pair.transaction(async () => {
          locked.open();
          await held.opened;
          return 1;
        }, 'immediate');
        await locked.opened;
        const queued = [2, 3].map((n) => pair.transaction(async () => n, 'immediate'));
        strictEqual((await pair.queryOne<{ n: number }>('SELECT 7 AS "n"'))!.n, 7);
        held.open();
        deepStrictEqual(await Promise.all([first, ...queued]), [1, 2, 3]);
      } finally {
        held.open();
        await pair.close();
      }
    });

    it('queues an `immediate` started by work its transaction left running', async () => {
      const pool = new Pool({ connectionString: await freshSchemaURL(), types: typeParsers });
      const own = createAdapter(pool);
      const started = gate();
      const locked = gate();
      const held = gate();
      try {
        let stray: Promise<number> | undefined;
        await own.transaction(async () => {
          stray = started.opened.then(() => own.transaction(async () => 5, 'immediate'));
        }, 'immediate');
        const next = own.transaction(async () => {
          locked.open();
          await held.opened;
        }, 'immediate');
        await locked.opened;
        started.open();
        await started.opened;
        strictEqual(pool.totalCount, 1);
        held.open();
        await next;
        strictEqual(await stray, 5);
      } finally {
        held.open();
        await own.close();
      }
    });

    it('lets a plain read wait for an open DDL transaction instead of failing', async () => {
      await db.run('INSERT INTO "t" VALUES (?, 1)', ['d1']);
      const altered = gate();
      const ddl = db.transaction(async (tx) => {
        await tx.exec('ALTER TABLE "t" ADD COLUMN "extra" TEXT');
        strictEqual(await lockTimeout(tx), '5s');
        altered.open();
        await sleep(300);
        await tx.exec('ALTER TABLE "t" DROP COLUMN "extra"');
      });
      await altered.opened;
      deepStrictEqual(await keys(db), ['d1']);
      await ddl;
      deepStrictEqual(await Promise.all(Array.from({ length: 4 }, () => lockTimeout(db))), [
        '0',
        '0',
        '0',
        '0',
      ]);
      await db.run('DELETE FROM "t"');
    });
  });

  describe('a SQL error', () => {
    it('keeps the client in the pool', async () => {
      const single = await connect({ max: 1 });
      try {
        const pid = await backend(single);
        await rejects(single.query('SELECT nope'), { code: '42703' });
        strictEqual(await backend(single), pid);
      } finally {
        await single.close();
      }
    });
  });

  describe('work left running after a transaction settles', () => {
    it('autocommits on a client of its own, never the released one', async () => {
      const pair = await connect({ max: 2 });
      try {
        await pair.exec('CREATE TABLE "t" ("k" TEXT PRIMARY KEY)');
        const strayRan = gate();
        let stray: Promise<unknown> | undefined;
        await pair.transaction(async () => {
          stray = sleep(50).then(async () => {
            await pair.run('INSERT INTO "t" VALUES (?)', ['stray']);
            strayRan.open();
          });
        });
        await rejects(
          pair.transaction(async () => {
            await strayRan.opened;
            throw new Error('roll back the second transaction');
          }),
        );
        await stray;
        deepStrictEqual(await pair.query('SELECT "k" FROM "t"'), [
          Object.assign(Object.create(null), { k: 'stray' }),
        ]);
      } finally {
        await pair.close();
      }
    });

    it('runs statements queued before the end inside the transaction', async () => {
      const own = await connect({ max: 2 });
      try {
        await own.exec('CREATE TABLE "t" ("k" TEXT PRIMARY KEY)');
        let queued: Promise<unknown> | undefined;
        await rejects(
          own.transaction(async (tx) => {
            queued = tx.run('INSERT INTO "t" VALUES (?)', ['queued']);
            throw new Error('roll back');
          }),
        );
        await queued;
        deepStrictEqual(await own.query('SELECT "k" FROM "t"'), []);
      } finally {
        await own.close();
      }
    });
  });

  describe('a failed lock wait', () => {
    it('rolls back as busy, and the clients come back clean', async () => {
      const pair = await connect({ max: 2 });
      try {
        await pair.transaction(async () => {
          await rejects(
            pair.transaction(async () => undefined, 'immediate'),
            { code: '55P03' },
          );
        }, 'immediate');
        const clean = await Promise.all([backend(pair), backend(pair)]);
        strictEqual(new Set(clean).size, 2);
        strictEqual(
          await pair.transaction(
            async (tx) => (await tx.queryOne<{ n: number }>('SELECT 1 AS "n"'))!.n,
            'immediate',
          ),
          1,
        );
      } finally {
        await pair.close();
      }
    });
  });

  describe('a `statement_timeout` shorter than the lock wait', () => {
    it('waits for the write lock, and still bounds every statement after it', async () => {
      const url = new URL(await freshSchemaURL());
      url.searchParams.set(
        'options',
        `${url.searchParams.get('options')} -c statement_timeout=300`,
      );
      const pair = open(url.href);
      const other = open(url.href);
      try {
        const locked = gate();
        const held = gate();
        const first = pair.transaction(async () => {
          locked.open();
          await held.opened;
        }, 'immediate');
        await locked.opened;
        const second = other.transaction(
          async (tx) =>
            (await tx.queryOne<{ statement_timeout: string }>('SHOW statement_timeout'))!,
          'immediate',
        );
        await sleep(600);
        held.open();
        await first;
        strictEqual((await second).statement_timeout, '300ms');
        await rejects(
          pair.transaction((tx) => tx.query('SELECT pg_sleep(1)'), 'immediate'),
          { code: '57014' },
        );
      } finally {
        await pair.close();
        await other.close();
      }
    });
  });

  describe('close', () => {
    it('waits for a held and a queued checkout, then refuses new work', async () => {
      const single = await connect({ max: 1 });
      const hold = gate();
      const held = single.transaction(async (tx) => {
        await hold.opened;
        return (await tx.queryOne<{ n: number }>('SELECT 1 AS "n"'))!.n;
      });
      const queued = single.queryOne<{ n: number }>('SELECT 2 AS "n"');
      await sleep(20);
      let closed = false;
      const closing = single.close().then(() => (closed = true));
      await sleep(20);
      strictEqual(closed, false);
      hold.open();
      strictEqual(await held, 1);
      strictEqual((await queued)!.n, 2);
      await closing;
      await rejects(single.query('SELECT 1'), { message: 'The Postgres connection is closed' });
      await rejects(
        single.transaction(async () => undefined),
        { message: 'The Postgres connection is closed' },
      );
      await rejects(single.close(), { message: 'The Postgres connection is closed' });
    });
  });

  describe('a terminated backend', () => {
    it('does not crash the process, and the next statement gets a fresh client', async () => {
      const single = await connect({ max: 1 });
      const killer = await connect({ max: 1 });
      try {
        const pid = await backend(single);
        await killer.query('SELECT pg_terminate_backend(?)', [pid]);
        await sleep(50);
        ok((await backend(single)) !== pid);
      } finally {
        await killer.close();
        await single.close();
      }
    });
  });
});
