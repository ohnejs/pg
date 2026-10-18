import type { Pool as PoolType } from 'pg';

import { rejects } from 'node:assert';
import { describe, it } from 'node:test';
import { Pool } from 'pg';

import { verifyServer } from '../src/server.ts';
import { testURL } from './_postgres.ts';

const fit = {
  version: 160011,
  versionName: '16.11',
  encoding: 'UTF8',
  standardStrings: 'on',
  icu: true,
  schema: 'public' as string | null,
  searchPath: '"$user", public',
};

/**
 * A stand-in pool whose one query answers `settings`.
 */
function poolAnswering(settings: Partial<typeof fit>): PoolType {
  return { query: async () => ({ rows: [{ ...fit, ...settings }] }) } as unknown as PoolType;
}

describe('verifyServer', () => {
  it('accepts the test server', async () => {
    const pool = new Pool({ connectionString: testURL, max: 1 });
    try {
      await verifyServer(pool);
    } finally {
      await pool.end();
    }
  });

  it('accepts a server that meets every requirement', async () => {
    await verifyServer(poolAnswering({}));
  });

  it('refuses a server older than Postgres 15', async () => {
    await rejects(verifyServer(poolAnswering({ version: 140024, versionName: '14.24' })), {
      message: 'Postgres 15 or newer is required',
    });
  });

  it('refuses a database not encoded as `UTF8`', async () => {
    await rejects(verifyServer(poolAnswering({ encoding: 'LATIN1' })), {
      message: 'The database encoding must be `UTF8`',
    });
  });

  it('refuses a session without `standard_conforming_strings`', async () => {
    await rejects(verifyServer(poolAnswering({ standardStrings: 'off' })), {
      message: '`standard_conforming_strings` must be `on`',
    });
  });

  it('reads `standard_conforming_strings` from the session the URL opens', async () => {
    const url = new URL(testURL);
    url.searchParams.set('options', '-c standard_conforming_strings=off');
    const pool = new Pool({ connectionString: url.href, max: 1 });
    try {
      await rejects(verifyServer(pool), { message: '`standard_conforming_strings` must be `on`' });
    } finally {
      await pool.end();
    }
  });

  it('refuses a server without the ICU collation', async () => {
    await rejects(verifyServer(poolAnswering({ icu: false })), {
      message: 'The `und-x-icu` collation is missing',
    });
  });

  it('refuses a session whose `search_path` names no schema it may use', async () => {
    await rejects(verifyServer(poolAnswering({ schema: null, searchPath: 'nope' })), {
      message: 'No schema on the `search_path` to keep the tables in',
      body: [
        'The session searches `nope`, and no schema on it exists and grants the role `USAGE`.',
        '',
        'Create the schema and grant the role `USAGE` and `CREATE` on it, or fix `search_path` in `options`.',
      ],
    });
  });

  it('reads the current schema from the session the URL opens', async () => {
    const url = new URL(testURL);
    url.searchParams.set('options', '-c search_path=ohne_pg_missing');
    const pool = new Pool({ connectionString: url.href, max: 1 });
    try {
      await rejects(verifyServer(pool), {
        message: 'No schema on the `search_path` to keep the tables in',
      });
    } finally {
      await pool.end();
    }
  });
});
