import type { DatabaseAdapter, SQLParams, Transaction } from 'ohnejs';
import type { Mutex } from 'ohnejs/utils';
import type { Pool, PoolClient, QueryArrayResult } from 'pg';

import { AsyncLocalStorage } from 'node:async_hooks';
import { assertBoundParams, ohneError } from 'ohnejs';
import { createMutex, isArray, isUndefined, last } from 'ohnejs/utils';
import { DatabaseError } from 'pg';

import { IN_FAILED_SQL_TRANSACTION } from './errors.ts';
import { numberPlaceholders } from './placeholders.ts';

/**
 * An open transaction as its own flow sees it.
 */
interface Open {
  client: PoolClient | undefined;
  turn: Mutex;
}

/**
 * A query result read in array row mode.
 */
type Result = QueryArrayResult<unknown[]>;

/**
 * The most params one statement binds, since the Bind message counts them in a 16-bit integer.
 */
export const MAX_PARAMETERS = 65535;

// "ohne" in ASCII: the advisory-lock space, apart from any key an app picks.
const LOCK_SPACE = 0x6f686e65;
const BEGIN = "BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL lock_timeout = '5s'";
// A shorter `statement_timeout` would cancel the wait as `57014`, so `lock_timeout` alone bounds it.
const BEGIN_IMMEDIATE =
  `${BEGIN}; SET LOCAL statement_timeout = 0; ` +
  `SELECT pg_advisory_xact_lock(${LOCK_SPACE}, hashtext(current_schema())); ` +
  'SET LOCAL statement_timeout TO DEFAULT';

/**
 * Wraps `pool` in the `DatabaseAdapter` surface, closures only, so a spread copy keeps working.
 *
 * Outside a transaction each statement checks out its own client and releases it after.
 * Inside one, every statement of the transaction's flow runs on its client, one at a time in call order.
 * That covers the adapter's own methods too, so code reading through the adapter sees the uncommitted rows.
 * Work the flow leaves running after the transaction settles autocommits on a client of its own.
 *
 * Every transaction caps lock waits at 5 s, which core reads as busy.
 * `immediate` also takes an advisory lock per schema, so writers serialize as on a single-writer engine.
 * That wait answers busy whatever `statement_timeout` the session sets.
 * The timeout still bounds every statement after it.
 * Transactions pin `READ COMMITTED`, so each statement after that lock reads the rows committed before it.
 * A swallowed statement error aborts the transaction, and the commit then rejects with SQLSTATE `25P02`.
 * A statement the server refuses rejects with `pg`'s `DatabaseError`, carrying its SQLSTATE in `code`.
 *
 * `close` refuses new checkouts, waits for every one in flight, and ends the pool.
 * An open transaction still finishes its work on its own client.
 *
 * @example
 * ```ts
 * const db = createAdapter(new Pool({ connectionString: 'postgres://localhost/app' }))
 * await db.transaction(async (tx) => tx.run('INSERT INTO "Posts" ("UUID") VALUES (?)', ['p1']))
 * await db.close()
 * ```
 */
export function createAdapter(pool: Pool): DatabaseAdapter {
  const flow = new AsyncLocalStorage<Open>();
  const inFlight = new Set<Promise<unknown>>();
  let closed = false;

  pool.on('error', ignore);
  pool.on('connect', (client) => client.on('error', ignore));

  /**
   * Starts `work` unless the adapter is closed, and counts it in flight until it settles.
   */
  const track = async <T>(work: () => Promise<T>): Promise<T> => {
    if (closed) throw closedError();
    const promise = work();
    inFlight.add(promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(promise);
    }
  };

  /**
   * Runs `work` on a client of its own, then returns the client to the pool.
   */
  const checkout = <T>(work: (client: PoolClient) => Promise<T>): Promise<T> =>
    track(async () => {
      const client = await pool.connect();
      try {
        const result = await work(client);
        client.release();
        return result;
      } catch (error) {
        client.release(!(error instanceof DatabaseError));
        throw error;
      }
    });

  /**
   * Runs `work` in the open transaction of the calling flow, or on a client of its own outside one.
   * The client is read when the turn comes, since the transaction may have settled by then.
   */
  const route = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
    const open = flow.getStore();
    try {
      if (isUndefined(open)) return await checkout(work);
      return await open.turn(() => (isUndefined(open.client) ? checkout(work) : work(open.client)));
    } catch (error) {
      throw traceServerError(error);
    }
  };

  /**
   * Runs `sql` with `params`, numbering the placeholders only when there are params to bind.
   * More params than `MAX_PARAMETERS` never reach `pg`, whose 16-bit count would wrap.
   */
  const statement = (sql: string, params: SQLParams) => {
    assertBoundParams(params.length, MAX_PARAMETERS);
    return route(async (client) =>
      lastResult(
        await client.query<unknown[]>({
          text: params.length > 0 ? numberPlaceholders(sql) : sql,
          values: [...params],
          rowMode: 'array',
        }),
      ),
    );
  };

  const adapter: DatabaseAdapter = {
    async exec(sql) {
      await route((client) => client.query(sql));
    },
    async run(sql, params = []) {
      const { rowCount } = await statement(sql, params);
      return { changes: rowCount ?? 0 };
    },
    async query<T>(sql: string, params: SQLParams = []) {
      return toRows(await statement(sql, params)) as T[];
    },
    async queryOne<T>(sql: string, params: SQLParams = []) {
      return (await adapter.query<T>(sql, params))[0];
    },
    transaction(fn, mode = 'deferred') {
      return track(async () => {
        const client = await pool.connect();
        const open: Open = { client, turn: createMutex() };
        const { exec, run, query, queryOne } = adapter;
        const tx: Transaction = { exec, run, query, queryOne };
        /**
         * Ends the transaction with `command` once its queued statements ran, detaching its client.
         */
        const end = (command: 'COMMIT' | 'ROLLBACK') =>
          open.turn(() => {
            open.client = undefined;
            return settle(client, command);
          });
        let result;
        try {
          await client.query(mode === 'immediate' ? BEGIN_IMMEDIATE : BEGIN);
          result = await flow.run(open, fn, tx);
        } catch (error) {
          await end('ROLLBACK').catch(ignore);
          throw error;
        }
        if ((await end('COMMIT')) !== 'COMMIT') throw abortedError();
        return result;
      });
    },
    async close() {
      if (closed) throw closedError();
      closed = true;
      while (inFlight.size > 0) await Promise.allSettled(inFlight);
      await pool.end();
    },
  };
  return adapter;
}

/**
 * Ends the transaction on `client` with `command` and gives the client back.
 * The client returns to the pool only after a confirmed end; a failed one destroys it.
 * Resolves with the command tag the server answered.
 */
async function settle(client: PoolClient, command: 'COMMIT' | 'ROLLBACK'): Promise<string> {
  try {
    const { command: answered } = await client.query(command);
    client.release();
    return answered;
  } catch (error) {
    client.release(true);
    throw error;
  }
}

/**
 * The last result of a query, since a multi-statement text without params answers one per statement.
 */
function lastResult(result: Result | Result[]): Result {
  return isArray<Result[]>(result) ? last(result)! : result;
}

/**
 * Builds a null-prototype object per row, as core compares rows.
 */
function toRows({ rows, fields }: Result): Record<string, unknown>[] {
  return rows.map((values) => {
    const row: Record<string, unknown> = Object.create(null);
    fields.forEach((field, index) => (row[field.name] = values[index]));
    return row;
  });
}

/**
 * The failure for any use of a closed adapter.
 */
function closedError(): Error {
  return ohneError('The Postgres connection is closed');
}

/**
 * The failure for a commit Postgres answered with a rollback, carrying SQLSTATE `25P02`.
 */
function abortedError(): Error {
  return Object.assign(
    ohneError(
      'Postgres rolled the transaction back: a statement in it failed and the error was caught',
    ),
    { code: IN_FAILED_SQL_TRANSACTION },
  );
}

/**
 * Names a server error `DatabaseError` in place of the protocol's `error`.
 * Its stack is taken again here, so it leads back to the code that ran the statement.
 */
function traceServerError(error: unknown): unknown {
  if (!(error instanceof DatabaseError)) return error;
  Object.assign(error, { name: 'DatabaseError' });
  Error.captureStackTrace(error, traceServerError);
  return error;
}

/**
 * Swallows an error that has no one left to tell.
 */
function ignore(): void {}
