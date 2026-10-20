# @ohnejs/pg

Runs the [ohne database](https://ohne.dev/docs/database/engine) on Postgres, through
node-postgres. It has one dependency: the `pg` driver.

## Install

You need Node 26 or newer, and Postgres 15 or newer. The database must be encoded as `UTF8`, and
the server must be built with ICU, which ohne uses to fold text for search. ohne checks both when it
connects, and refuses a server that lacks either.

```sh
pnpm add @ohnejs/pg
```

## Connecting ohne

List the layer and select the `postgres` dialect:

```ts
// ohne.config.ts
import { defineConfig } from 'ohnejs';

export default defineConfig({
  layers: ['ohnejs/base', '@ohnejs/pg'],
  database: { dialect: 'postgres' },
});
```

Then point `DATABASE` at your database, in the environment or in `.env`:

```sh
# .env
DATABASE=postgres://app:secret@db.internal:5432/app
```

The URL carries the password, so keep it out of `ohne.config.ts`. In production, set it beside
ohne's other [secrets](https://ohne.dev/docs/production/deployment#secrets).

ohne would also pick the dialect from a `postgres://` URL alone. Naming it makes a missing
`DATABASE` fail at boot, instead of falling back to ohne's SQLite file.

## The URL

```
postgres://[<user>[:<password>]@][<host>][:<port>]/<database>[?<parameter>=<value>&...]
```

`postgresql://` works too. The query parameters set up each connection:

| parameter          | meaning                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `sslmode`          | `verify-full` connects over TLS and checks the server's certificate. `disable` turns TLS off. |
| `sslrootcert`      | The path to the CA certificate, for a server signed by a private CA.                          |
| `host`             | The directory of the server's Unix socket, in place of a host name.                           |
| `options`          | Session settings, as `-c <name>=<value>`.                                                     |
| `application_name` | The name the server shows for each connection, in `pg_stat_activity`.                         |

`pg` treats `sslmode=require` as `verify-full` and warns about it, so name `verify-full`.

To connect over the local socket, leave the host out and name the socket's directory:

```sh
DATABASE=postgres:///app?host=/var/run/postgresql
```

ohne keeps its tables in the connection's current schema, the first one on the role's
`search_path`. That is usually `public`. To use another schema that exists, set it in `options`:

```sh
DATABASE=postgres://app:secret@db.internal/app?options=-c%20search_path%3Dapp
```

The URL is the only setting ohne reads. Pool settings such as `max` are not read from it: each
database gets a pool of up to 10 connections, `pg`'s default. Opening a connection, or waiting for
a free one, gives up after 10 seconds. Anything the URL leaves out, `pg` fills from the libpq
variables such as `PGHOST` and `PGPASSWORD`. Those are the driver's fallbacks, which ohne neither
declares nor checks.

## Helper databases

Each [helper database](https://ohne.dev/docs/database/engine#helper-databases) is a Postgres URL
too. It can be another database, or another schema of the main one:

```ts
// ohne.config.ts
import { defineConfig } from 'ohnejs';

export default defineConfig({
  layers: ['ohnejs/base', '@ohnejs/pg'],
  database: {
    dialect: 'postgres',
    helpers: { cache: 'postgres://app@db.internal/app?options=-c%20search_path%3Dcache' },
  },
});
```

A helper URL lives in config, so give it no password. `pg` then takes it from `PGPASSWORD`.

`:memory:` is a SQLite path, so ohne refuses it at boot under the `postgres` dialect.

## Permissions

The role ohne connects as creates and changes the tables of your collections. It needs `USAGE`
and `CREATE` on the schema, and it must own the tables it changes.

The [schema sync](https://ohne.dev/docs/database/sync) also turns off foreign-key checks and
cascades for its transaction, as it does on SQLite. Postgres allows that through
`session_replication_role`, which only a superuser may set unless granted. Grant both as a
superuser:

```sql
GRANT USAGE, CREATE ON SCHEMA public TO app;
GRANT SET ON PARAMETER session_replication_role TO app;
```

Without the grants, the sync fails at boot with an error that names the missing one.

## Differences from SQLite

- **A caught failure ends the transaction.** If code inside a `transaction`, a hook, or a migration
  catches a failed statement and carries on, Postgres has already aborted the transaction. Every
  statement after it fails with `25P02`. When none follows, the commit rejects with `25P02`, so a
  write that was rolled back never reports success. SQLite carries on. Let the error throw, or
  avoid it in SQL, for example with `ON CONFLICT DO NOTHING`.
- **Text cannot hold U+0000.** Writing a NUL character to a text field fails with `22021`.
- **An indexed value has a size limit.** A field with `index` or `unique`, or in a composite index,
  refuses a value too large for a Postgres index entry, about 2.7 kB, with
  `validation.tooLargeToIndex`. SQLite has no limit. Set `max` on the field, or drop the index.
- **List filters need a JSON array.** An `includes`, `includesAny`, or `includesAll` filter fails
  with `22023` on a stored value that is not an array, where SQLite treats it as a list of one.
  ohne's own writes always store an array, so only rows you wrote with raw SQL can hit this.
- **An integer field compares only with an integer.** A query builder filter such as
  `where('count', (w) => w.greaterThan(1.5))` fails with `22P02`, where SQLite compares the numbers.
  Round the value first.
- **Dropping a table drops what depends on it.** When the sync drops a collection's table, views
  you made over it go with it. A foreign key from a table of your own onto it is gone too, unless
  the same sync creates the table again. SQLite keeps both, dangling.
- **Search folds text with the server's Unicode tables.** `contains`, `startsWith`, and `endsWith`
  can miss a character newer than the server's Unicode version, where SQLite would match it.

## How it works

- Raw SQL keeps ohne's `?` placeholders. When you pass values, each `?` becomes `$1`, `$2`, ... in
  order, except inside strings, quoted identifiers, comments, and dollar-quoted bodies. A statement
  without values goes to the server as written, so jsonb's `?` operators work only there. Do not
  mix `?` and `$1` in one statement.
- Integers and booleans are `bigint` columns, reals are `double precision`, and text and JSON are
  `text` under the `"C"` collation. So raw SQL reads a boolean as `1` or `0` and JSON as text, as
  on SQLite, and text sorts byte by byte on any server locale. A `numeric`, such as a `sum` or an
  `avg` over an integer column, reads as a number too. A value beyond `Number.MAX_SAFE_INTEGER`
  reads as a string.
- Schema changes are transactional. The sync runs in one transaction, so a sync that fails leaves
  the database as it was.
- Each statement and each transaction takes its own connection from the pool, so transactions run
  side by side. Builder writes and every `'immediate'` transaction take an advisory lock on the
  schema at `BEGIN`, in the key space `1869114981`, so writers still go one at a time, as on SQLite.
  Inside a transaction, a lock wait gives up after five seconds and counts as busy. Transactions
  run at `READ COMMITTED` whatever the server's default, so a writer that waited for the lock reads
  the rows the one before it committed.
- ohne keeps its own state in the `ohne_` tables, as on SQLite. See
  [reserved tables](https://ohne.dev/docs/database/engine#reserved-tables).

## Contributing

From a clone, run `pnpm install` and `pnpm test`. The tests need a Postgres server at
`OHNE_PG_TEST_URL`, `postgres://localhost/ohne_pg_test` by default, and connect as a superuser,
since they create roles and grants. The database is created when it is missing, and each test runs
in a schema of its own that the run drops at the end.

With an ohne checkout at `../ohne`, `pnpm test:core` runs ohne's own test suite on Postgres.
