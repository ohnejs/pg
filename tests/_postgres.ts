import type { DatabaseAdapter, Dialect } from 'ohnejs';

import { Client, escapeIdentifier } from 'pg';

/**
 * The database every test runs in, from `OHNE_PG_TEST_URL`.
 */
export const testURL = process.env.OHNE_PG_TEST_URL ?? 'postgres://localhost/ohne_pg_test';

let schemas = 0;

/**
 * Creates an empty schema in the test database and returns `testURL` scoped to it.
 * Every connection to the URL shares the schema, and closing one leaves it in place.
 * The global teardown drops it.
 */
export async function freshSchemaURL(): Promise<string> {
  return scopedURL(await createSchema('s'));
}

/**
 * Connects `dialect` to an empty schema of its own.
 * Closing the connection drops the schema.
 */
export async function connectFresh(dialect: Dialect): Promise<DatabaseAdapter> {
  const schema = await createSchema('t');
  const db = await dialect.connect(scopedURL(schema));
  const close = db.close;
  // In place, not a copy: a test that patches `db.run` must reach the `run` its transactions read.
  db.close = async () => {
    await close();
    await withClient(testURL, (client) =>
      client.query(`DROP SCHEMA ${escapeIdentifier(schema)} CASCADE`),
    );
  };
  return db;
}

/**
 * Runs `fn` on a client connected to `url`, then ends the client.
 */
export async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates the schema `ohne_<kind>_<run>_<pid>_<n>` in the test database and returns its name.
 * The run id comes from the global setup, so the teardown can sweep every schema a run made.
 */
async function createSchema(kind: 's' | 't'): Promise<string> {
  const run = process.env.OHNE_PG_TEST_RUN;
  if (!run) throw new Error('`OHNE_PG_TEST_RUN` is unset; run the tests through `pnpm test`');
  const schema = `ohne_${kind}_${run}_${process.pid}_${++schemas}`;
  await withClient(testURL, (client) => client.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`));
  return schema;
}

/**
 * Returns `testURL` with `schema` as the search path of every session it opens.
 */
function scopedURL(schema: string): string {
  const url = new URL(testURL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.href;
}
