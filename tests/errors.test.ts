import { deepStrictEqual, fail, ok, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { truncateWithHash } from 'ohnejs/utils/crypto';
import { DatabaseError } from 'pg';

import {
  constraintColumns,
  FOREIGN_KEY_VIOLATION,
  sqlstateOf,
  UNIQUE_VIOLATION,
} from '../src/errors.ts';
import { freshSchemaURL, withClient } from './_postgres.ts';

/**
 * Runs `sql` in a fresh schema and returns what it threw.
 */
async function caught(sql: string): Promise<unknown> {
  return withClient(await freshSchemaURL(), async (client) => {
    try {
      await client.query(sql);
    } catch (error) {
      return error;
    }
    return fail('expected the statement to fail');
  });
}

describe('sqlstateOf', () => {
  it('reads the code a server error carries', async () => {
    const error = await caught(
      'CREATE TABLE "A" ("x" TEXT PRIMARY KEY); CREATE TABLE "B" ("a" TEXT REFERENCES "A"); ' +
        `INSERT INTO "B" VALUES ('missing')`,
    );
    ok(error instanceof DatabaseError);
    strictEqual(sqlstateOf(error), FOREIGN_KEY_VIOLATION);
  });

  it('reads a code assigned to a plain error', () => {
    strictEqual(sqlstateOf(Object.assign(new Error('locked'), { code: '55P03' })), '55P03');
  });

  it('gives undefined without a string code', () => {
    strictEqual(sqlstateOf(new Error('no code')), undefined);
    strictEqual(sqlstateOf({ code: 23505 }), undefined);
    strictEqual(sqlstateOf('23505'), undefined);
    strictEqual(sqlstateOf(null), undefined);
  });
});

describe('constraintColumns', () => {
  it('reads one field column', () => {
    deepStrictEqual(constraintColumns({ table: 'Users', constraint: 'UX__Users__email' }), [
      'email',
    ]);
  });

  it('reads several field columns in order', () => {
    deepStrictEqual(
      constraintColumns({ table: 'Posts', constraint: 'UX__Posts__slug_author_category' }),
      ['slug', 'author', 'category'],
    );
  });

  it('reads internal columns from the empty pieces', () => {
    deepStrictEqual(
      constraintColumns({
        table: 'Posts_authors',
        constraint: 'UX__Posts_authors___parentUUID__targetUUID',
      }),
      ['_parentUUID', '_targetUUID'],
    );
    deepStrictEqual(
      constraintColumns({ table: 'Posts_tr', constraint: 'UX__Posts_tr___localeCode_slug' }),
      ['_localeCode', 'slug'],
    );
    deepStrictEqual(
      constraintColumns({ table: 'Posts_content', constraint: 'UX__Posts_content___blockUUID' }),
      ['_blockUUID'],
    );
  });

  it('gives null for a primary key', () => {
    strictEqual(constraintColumns({ table: 'Posts', constraint: 'PK__Posts' }), null);
  });

  it('gives null for a truncated name', () => {
    const constraint = truncateWithHash(`UX__Posts__${'veryLongFieldName'.repeat(5)}`);
    ok(constraint.includes('$'));
    strictEqual(constraintColumns({ table: 'Posts', constraint }), null);
  });

  it('gives null for a name of another table', () => {
    strictEqual(constraintColumns({ table: 'Posts', constraint: 'UX__Users__email' }), null);
    strictEqual(constraintColumns({ table: 'Posts', constraint: 'UX__Posts_tr__slug' }), null);
  });

  it('gives null for a name that does not rebuild', () => {
    strictEqual(constraintColumns({ table: 'Posts', constraint: 'UX__Posts__' }), null);
    strictEqual(constraintColumns({ table: 'Posts', constraint: 'UX__Posts__slug_' }), null);
    strictEqual(constraintColumns({ table: 'Posts', constraint: 'IX__Posts__slug' }), null);
  });

  it('gives null without a table or a constraint', () => {
    strictEqual(constraintColumns({ constraint: 'UX__Users__email' }), null);
    strictEqual(constraintColumns({ table: 'Users' }), null);
    strictEqual(constraintColumns(new Error('duplicate')), null);
    strictEqual(constraintColumns(undefined), null);
  });

  it('reads the unique index a server violation names', async () => {
    const error = await caught(
      'CREATE TABLE "Posts_tr" ("_localeCode" TEXT, "slug" TEXT); ' +
        'CREATE UNIQUE INDEX "UX__Posts_tr___localeCode_slug" ON "Posts_tr" ("_localeCode", "slug"); ' +
        `INSERT INTO "Posts_tr" VALUES ('en', 'a'), ('en', 'a')`,
    );
    strictEqual(sqlstateOf(error), UNIQUE_VIOLATION);
    deepStrictEqual(constraintColumns(error), ['_localeCode', 'slug']);
  });

  it('gives null for a server primary-key violation', async () => {
    const error = await caught(
      'CREATE TABLE "Posts" ("UUID" TEXT, CONSTRAINT "PK__Posts" PRIMARY KEY ("UUID")); ' +
        `INSERT INTO "Posts" VALUES ('a'), ('a')`,
    );
    strictEqual(sqlstateOf(error), UNIQUE_VIOLATION);
    strictEqual(constraintColumns(error), null);
  });
});
