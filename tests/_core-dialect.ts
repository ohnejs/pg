import type { DatabaseAdapter } from 'ohnejs';
import type { PoolConfig } from 'pg';

import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { PostgresDialect } from '../src/dialect.ts';
import { LOCK_NOT_AVAILABLE } from '../src/errors.ts';
import { connectFresh } from './_postgres.ts';

export { freshSchemaURL as sharedURL } from './_postgres.ts';

/**
 * The sentinel the test dialect answers with a fresh schema that vanishes on close.
 * It never reaches `pg`.
 */
export const memoryURL = 'postgres://ohne-test/memory';

/**
 * `PostgresDialect` with the core suite's in-memory sentinel and a pool that lets idle test processes exit.
 */
class TestPostgresDialect extends PostgresDialect {
  /**
   * Opens `memoryURL` on an empty schema of its own, dropped on close, and any other URL as production does.
   */
  async connect(url: string): Promise<DatabaseAdapter> {
    return url === memoryURL ? connectFresh(this) : super.connect(url);
  }

  /**
   * Keeps each pool small and lets its idle clients release the process.
   */
  protected poolConfig(url: string): PoolConfig {
    return { ...super.poolConfig(url), max: 4, idleTimeoutMillis: 1000, allowExitOnIdle: true };
  }
}

/**
 * The Postgres instance the core suite runs on.
 */
export const dialect = new TestPostgresDialect();

/**
 * Returns the error Postgres raises when a lock wait runs past `lock_timeout`.
 */
export function busyError(): unknown {
  return Object.assign(new Error('canceling statement due to lock timeout'), {
    code: LOCK_NOT_AVAILABLE,
  });
}

/**
 * Aborts every `DELETE` on `table` with `bound` through a trigger function, which the returned function drops.
 */
export async function failDeletes(
  db: DatabaseAdapter,
  table: string,
): Promise<() => Promise<void>> {
  const name = dialect.quote(`fail_deletes_${table}`);
  await db.exec(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'bound'; END$$`,
  );
  await db.exec(
    `CREATE TRIGGER ${name} BEFORE DELETE ON ${dialect.quote(table)} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  return () => db.exec(`DROP FUNCTION ${name}() CASCADE`);
}

/**
 * Links this package into `project` as `@ohnejs/pg`, whose boot file registers the dialect in the child.
 */
export function linkLayers(project: string): string[] {
  const scope = join(project, 'node_modules', '@ohnejs');
  mkdirSync(scope, { recursive: true });
  symlinkSync(join(import.meta.dirname, '..'), join(scope, 'pg'), 'dir');
  return ['@ohnejs/pg'];
}
