import type { Pool } from 'pg';

import { ohneError } from 'ohnejs';
import { isNull } from 'ohnejs/utils';
import { codeSpan } from 'ohnejs/utils/ansi';

interface ServerSettings {
  version: number;
  versionName: string;
  encoding: string;
  standardStrings: string;
  icu: boolean;
  schema: string | null;
  searchPath: string;
}

const SETTINGS = `SELECT
  current_setting('server_version_num')::int AS "version",
  current_setting('server_version') AS "versionName",
  current_setting('server_encoding') AS "encoding",
  current_setting('standard_conforming_strings') AS "standardStrings",
  EXISTS (SELECT 1 FROM pg_collation WHERE collname = 'und-x-icu') AS "icu",
  current_schema() AS "schema",
  current_setting('search_path') AS "searchPath"`;

/**
 * Checks in one query that the server behind `pool` can hold an ohne database.
 * It needs Postgres 15 or newer, a `UTF8` database, `standard_conforming_strings` on, and the ICU collation.
 * The session also needs a current schema: one on its `search_path` that exists and grants the role `USAGE`.
 * Each unmet requirement throws its own error, naming the setting and the fix.
 *
 * @example
 * ```ts
 * await verifyServer(new Pool({ connectionString: 'postgres://localhost/app' }))
 * ```
 */
export async function verifyServer(pool: Pool): Promise<void> {
  const { rows } = await pool.query<ServerSettings>(SETTINGS);
  const { version, versionName, encoding, standardStrings, icu, schema, searchPath } = rows[0];
  if (version < 150000) {
    throw ohneError({
      title: 'Postgres 15 or newer is required',
      body: [
        `The server runs ${codeSpan(versionName)}.`,
        '',
        'Upgrade the server to Postgres 15 or newer.',
      ],
    });
  }
  if (encoding !== 'UTF8') {
    throw ohneError({
      title: 'The database encoding must be `UTF8`',
      body: [
        `The database uses ${codeSpan(encoding)}.`,
        '',
        "Create the database with `ENCODING 'UTF8'`.",
      ],
    });
  }
  if (standardStrings !== 'on') {
    throw ohneError({
      title: '`standard_conforming_strings` must be `on`',
      body: [
        `The session has it ${codeSpan(standardStrings)}.`,
        '',
        'Remove the setting from the server, the database, the role, or the URL `options`.',
      ],
    });
  }
  if (!icu) {
    throw ohneError({
      title: 'The `und-x-icu` collation is missing',
      body: [
        'The server was built without ICU, which ohne needs to fold text.',
        '',
        'Use a Postgres build with ICU support.',
      ],
    });
  }
  if (isNull(schema)) {
    throw ohneError({
      title: 'No schema on the `search_path` to keep the tables in',
      body: [
        `The session searches ${codeSpan(searchPath)}, and no schema on it exists and grants the role \`USAGE\`.`,
        '',
        'Create the schema and grant the role `USAGE` and `CREATE` on it, or fix `search_path` in `options`.',
      ],
    });
  }
}
