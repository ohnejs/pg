const POSTGRES_URL = /^postgres(ql)?:\/\//i;

/**
 * Whether `url` names a Postgres database, through the `postgres://` or `postgresql://` scheme.
 * The scheme is case-insensitive.
 *
 * @example
 * ```ts
 * isPostgresURL('postgres://localhost/app')     // -> true
 * isPostgresURL('POSTGRESQL://db.internal/app') // -> true
 * isPostgresURL('.data/ohne.db')                 // -> false
 * ```
 */
export function isPostgresURL(url: string): boolean {
  return POSTGRES_URL.test(url);
}
