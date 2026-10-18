import { randomBytes } from 'node:crypto';
import { DatabaseError, escapeIdentifier } from 'pg';

import { testURL, withClient } from './_postgres.ts';

/**
 * Creates the test database when it is missing and gives the run its id.
 * Every test process inherits the id through `OHNE_PG_TEST_RUN`.
 */
export async function globalSetup(): Promise<void> {
  await ensureTestDatabase();
  process.env.OHNE_PG_TEST_RUN = randomBytes(4).toString('hex');
}

/**
 * Drops every schema this run created, including those of crashed files and connections never closed.
 */
export async function globalTeardown(): Promise<void> {
  const run = process.env.OHNE_PG_TEST_RUN;
  if (!run) return;
  await withClient(testURL, async (client) => {
    const { rows } = await client.query<{ name: string }>(
      `SELECT nspname AS "name" FROM pg_namespace WHERE nspname LIKE ANY ($1)`,
      [[String.raw`ohne\_t\_${run}\_%`, String.raw`ohne\_s\_${run}\_%`]],
    );
    // One statement per schema: a single drop of them all overflows the shared lock table.
    for (const { name } of rows)
      await client.query(`DROP SCHEMA ${escapeIdentifier(name)} CASCADE`);
  });
}

/**
 * Creates the test database through the `postgres` maintenance database when it does not exist.
 * `C` collation pins byte order on any cluster locale.
 */
async function ensureTestDatabase(): Promise<void> {
  try {
    await withClient(testURL, async () => {});
  } catch (error) {
    if (!isDatabaseError(error, '3D000')) throw error;
    const url = new URL(testURL);
    const database = decodeURIComponent(url.pathname.slice(1));
    url.pathname = '/postgres';
    const create = `CREATE DATABASE ${escapeIdentifier(database)} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`;
    await withClient(url.href, (client) => client.query(create)).catch((raced: unknown) => {
      if (!isDatabaseError(raced, '42P04') && !isDatabaseError(raced, '23505')) throw raced;
    });
  }
}

/**
 * Whether `error` is a server error with SQLSTATE `code`.
 */
function isDatabaseError(error: unknown, code: string): boolean {
  return error instanceof DatabaseError && error.code === code;
}
